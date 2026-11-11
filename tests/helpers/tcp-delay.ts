import net, { type Socket } from 'node:net';

export interface NetworkProfile {
  name: string;
  rttMs: number;
  jitterMs: number;
}

/** Application-blind TCP relay: ordered byte delivery, bounded queues and backpressure.
 * Adds half of RTT per direction. Jitter is split between directions and seeded.
 * This models latency, not packet loss or TCP retransmission.
 */
export async function createDelayRelay(target: URL, profile: NetworkProfile) {
  if (target.protocol !== 'http:')
    throw new Error('The local TCP acceptance relay requires an http:// target');
  const sockets = new Set<Socket>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let seed = 0x52a1;
  let maxQueuedBytes = 0;
  let forwardedBytes = 0;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const server = net.createServer({ allowHalfOpen: true }, (downstream) => {
    const upstream = net.connect({
      host: target.hostname,
      port: Number(target.port || 80),
      allowHalfOpen: true,
    });
    sockets.add(downstream);
    sockets.add(upstream);
    downstream.setNoDelay(true);
    upstream.setNoDelay(true);
    const close = () => {
      downstream.destroy();
      upstream.destroy();
    };
    for (const socket of [downstream, upstream]) {
      socket.on('error', close);
      socket.on('close', () => {
        sockets.delete(socket);
      });
    }
    const pipe = (source: Socket, destination: Socket) => {
      const queue: { bytes: Buffer; due: number }[] = [];
      let timer: ReturnType<typeof setTimeout> | undefined;
      let buffered = 0;
      let blocked = false;
      let ended = false;
      let lastDue = 0;
      const schedule = () => {
        if (timer || blocked || destination.destroyed) return;
        if (!queue.length) {
          if (ended) destination.end();
          return;
        }
        timer = setTimeout(
          () => {
            timers.delete(timer!);
            timer = undefined;
            while (queue.length && queue[0].due <= performance.now() + 0.5) {
              const { bytes } = queue.shift()!;
              buffered -= bytes.length;
              forwardedBytes += bytes.length;
              if (!destination.write(bytes)) {
                blocked = true;
                break;
              }
            }
            if (buffered < 128 * 1024) source.resume();
            schedule();
          },
          Math.max(0, queue[0].due - performance.now()),
        );
        timers.add(timer);
      };
      source.on('data', (bytes: Buffer) => {
        const latency = Math.max(
          0,
          profile.rttMs / 2 + ((random() * 2 - 1) * profile.jitterMs) / 2,
        );
        lastDue = Math.max(lastDue, performance.now() + latency);
        queue.push({ bytes, due: lastDue });
        buffered += bytes.length;
        maxQueuedBytes = Math.max(maxQueuedBytes, buffered);
        if (buffered >= 256 * 1024) source.pause();
        schedule();
      });
      source.on('end', () => {
        ended = true;
        schedule();
      });
      destination.on('drain', () => {
        blocked = false;
        schedule();
      });
      destination.on('close', () => {
        if (timer) {
          clearTimeout(timer);
          timers.delete(timer);
        }
        source.destroy();
      });
    };
    pipe(downstream, upstream);
    pipe(upstream, downstream);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as net.AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    metrics: () => ({ maxQueuedBytes, forwardedBytes }),
    close: async () => {
      for (const timer of timers) clearTimeout(timer);
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
