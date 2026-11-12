import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createDelayRelay } from '../helpers/tcp-delay.js';
it('uses a direct connection for kernel impairment without a second TCP leg or ownership of the target', async () => {
  const server = createServer((_request, response) => response.end('direct'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const target = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  try {
    const relay = await createDelayRelay(target, { name: 'kernel-direct', rttMs: 0, jitterMs: 0 });
    expect(relay.url).toBe(target.origin);
    expect(await (await fetch(relay.url)).text()).toBe('direct');
    expect(relay.metrics()).toEqual({ maxQueuedBytes: 0, forwardedBytes: 0 });
    await relay.close();
    expect(await (await fetch(target)).text()).toBe('direct');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
