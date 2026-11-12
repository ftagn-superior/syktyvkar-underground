import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/** A failed or stalled child is a failed gate; preserve its complete output. */
export async function runCheck(
  name: string,
  command: string,
  args: string[],
  log: string,
  env: Record<string, string> = {},
  timeoutMs = 10 * 60_000,
) {
  await mkdir(dirname(log), { recursive: true });
  const stream = createWriteStream(log);
  const started = performance.now();
  console.log(`Check ${name}: started`);
  const child = spawn(command, args, {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  child.stdout.pipe(stream, { end: false });
  child.stderr.pipe(stream, { end: false });
  let timedOut = false;
  let force: ReturnType<typeof setTimeout> | undefined;
  const terminate = (signal: NodeJS.Signals) => {
    if (!child.pid) return;
    try {
      if (process.platform === 'win32') child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch {
      /* Already exited. */
    }
  };
  const timeout = setTimeout(() => {
    timedOut = true;
    terminate('SIGTERM');
    force = setTimeout(() => terminate('SIGKILL'), 5000);
  }, timeoutMs);
  let code: number | null;
  try {
    code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
  } finally {
    clearTimeout(timeout);
    clearTimeout(force);
    await new Promise<void>((resolve) => stream.end(resolve));
  }
  const result = { name, code, timedOut, seconds: (performance.now() - started) / 1000, log };
  console.log(
    `Check ${name}: ${code === 0 && !timedOut ? 'passed' : 'FAILED'} (${result.seconds.toFixed(1)}s), ${log}`,
  );
  if (code !== 0 || timedOut) throw new Error(JSON.stringify(result));
  return result;
}
