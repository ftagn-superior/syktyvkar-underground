import { Client, type Room } from '@colyseus/sdk';
import { MoveInputSchema, WorldState } from '@su/protocol';
import { type WorldInfo } from '@su/contracts';
import { writeFile } from 'node:fs/promises';
const args = process.argv.slice(2);
function option(name: string, fallback: string) {
  const index = args.indexOf(`--${name}`);
  return index < 0 ? fallback : args[index + 1];
}
const url = option('url', 'http://127.0.0.1:2567');
const count = Number(option('clients', '6'));
const seconds = Number(option('seconds', '60'));
const scenario = option('scenario', 'crowd');
if (
  !Number.isInteger(count) ||
  count < 1 ||
  count > 8 ||
  !Number.isFinite(seconds) ||
  seconds < 1 ||
  !['crowd', 'spread'].includes(scenario)
)
  throw new Error('Use --clients 1..8 --seconds N --scenario crowd|spread');
const info = (await fetch(`${url}/api/world`).then((r) => r.json())) as WorldInfo;
const rooms: Room<unknown, WorldState>[] = [];
const timers: ReturnType<typeof setInterval>[] = [];
let stopping = false;
async function cleanup() {
  if (stopping) return;
  stopping = true;
  timers.forEach(clearInterval);
  await Promise.allSettled(rooms.map((room) => room.leave()));
}
process.on('SIGINT', () => {
  void cleanup();
});
process.on('SIGTERM', () => {
  void cleanup();
});
const start = performance.now();
try {
  for (let index = 0; index < count; index++) {
    const room = await new Client(url).joinById<WorldState>(info.roomId, info, WorldState);
    rooms.push(room);
    room.onError((code, message) => console.error(`client ${index}: ${code} ${message}`));
    room.onMessage('problem', (data) => console.error(`client ${index}:`, data));
    room.onMessage('actionResult', () => {});
    room.onMessage('resync', () => {});
    room.send('clientReady');
    const input = room.input<MoveInputSchema>({ type: MoveInputSchema, mode: 'reliable' });
    const tickMs = 1000 / 60;
    let nextInputAt = performance.now();
    timers.push(
      setInterval(() => {
        const now = performance.now();
        if (now < nextInputAt) return;
        nextInputAt += tickMs;
        // Timers use integer milliseconds. A monotonic deadline avoids turning
        // a nominal 60 Hz interval into 62.5 Hz and filling the server queue.
        if (now - nextInputAt > 100) nextInputAt = now + tickMs;
        // joinById can resolve before the first complete state arrives.
        const player = room.state?.players?.get(room.sessionId);
        if (!player || stopping) return;
        const t = (now - start) / 1000;
        const target =
          scenario === 'crowd'
            ? (room.state.items.values().next().value ?? { x: 0, z: 0 })
            : { x: Math.cos(t / 5 + index) * 13, z: Math.sin(t / 5 + index) * 13 };
        const dx = target.x - player.x,
          dz = target.z - player.z;
        const length = Math.max(1, Math.hypot(dx, dz));
        input.data.moveX = dx / length;
        input.data.moveZ = dz / length;
        input.send();
      }, 4),
    );
  }
  console.log(
    `${count} active clients, ${scenario}, ${seconds}s. Open two browser clients for the 8-player acceptance run.`,
  );
  await new Promise<void>((resolve) => {
    const end = setTimeout(resolve, seconds * 1000);
    const poll = setInterval(() => {
      if (stopping) {
        clearTimeout(end);
        clearInterval(poll);
        resolve();
      }
    }, 200);
    end.unref();
    setTimeout(() => clearInterval(poll), seconds * 1000).unref();
  });
  const diagnostics = await fetch(`${url}/api/diagnostics`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  const report = {
    capturedAt: new Date().toISOString(),
    durationSeconds: (performance.now() - start) / 1000,
    clients: count,
    scenario,
    worldEpoch: info.worldEpoch,
    mapVersion: info.mapVersion,
    diagnostics,
    playersSeen: rooms.map((r) => r.state?.players?.size ?? 0),
  };
  console.log(JSON.stringify(report, null, 2));
  const reportPath = option('report', '');
  if (reportPath) await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
} finally {
  await cleanup();
}
