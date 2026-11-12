import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { WorldManifest } from '@su/contracts';
import { VerifiedResources } from './resources';
const bytes = new TextEncoder().encode('verified');
const manifest = {
  files: Object.fromEntries(
    Array.from({ length: 12 }, (_, i) => [
      `${i}`,
      createHash('sha256').update(bytes).digest('hex'),
    ]),
  ),
} as WorldManifest;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('verified resources', () => {
  it('coalesces reads, permits one consumer to cancel, limits HTTP to four and evicts LRU bytes', async () => {
    const gates: (() => void)[] = [];
    const signals: AbortSignal[] = [];
    let calls = 0;
    const resources = new VerifiedResources(manifest, '/', {
      cacheBytes: bytes.length * 2,
      fetch: async (_url, options) => {
        calls++;
        signals.push(options!.signal as AbortSignal);
        await new Promise<void>((resolve) => gates.push(resolve));
        return new Response(bytes);
      },
    });
    const controller = new AbortController();
    const cancelled = resources.read('0', controller.signal).catch((error: Error) => error.name);
    const duplicate = resources.read('0');
    const requests = Array.from({ length: 8 }, (_, i) => resources.read(`${i + 1}`));
    expect(calls).toBe(4);
    controller.abort();
    expect(await cancelled).toBe('AbortError');
    expect(signals[0].aborted).toBe(false);
    while (resources.diagnostics().pending) {
      for (const resolve of gates.splice(0)) resolve();
      await tick();
    }
    await Promise.all([duplicate, ...requests]);
    expect(calls).toBe(9);
    expect(resources.diagnostics()).toMatchObject({ httpPeak: 4, cacheEntries: 2, cacheBytes: 16 });
    resources.dispose();
    expect(resources.diagnostics().cacheBytes).toBe(0);
  });
  it('retries corrupt HTTP cache once with reload and keeps private copies of verified bytes', async () => {
    const modes: RequestCache[] = [];
    const resources = new VerifiedResources(manifest, '/', {
      fetch: async (_url, options) => {
        modes.push(options!.cache!);
        return new Response(modes.length === 1 ? new Uint8Array([0]) : bytes);
      },
    });
    const result = await resources.read('0');
    result.fill(0);
    expect(await resources.read('0')).toEqual(bytes);
    expect(modes).toEqual(['default', 'reload']);
    expect(resources.diagnostics().integrityRetries).toBe(1);
    resources.dispose();
  });
  it('rejects repeated corruption, supports explicit retry after HTTP failure and aborts the last reader', async () => {
    let corrupt = true;
    const resources = new VerifiedResources(manifest, '/', {
      fetch: async () => new Response(corrupt ? new Uint8Array([0]) : bytes),
    });
    await expect(resources.read('0')).rejects.toThrow('SHA-256');
    await tick();
    corrupt = false;
    expect(await resources.read('0')).toEqual(bytes);
    resources.dispose();
    let signal: AbortSignal | undefined;
    let finish!: () => void;
    const slow = new VerifiedResources(manifest, '/', {
      fetch: async (_url, options) => {
        signal = options!.signal as AbortSignal;
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return new Response(bytes);
      },
    });
    const pending = slow.read('0').catch((error: Error) => error.name);
    slow.dispose();
    expect(await pending).toBe('AbortError');
    expect(signal!.aborted).toBe(true);
    finish();
    await tick();
    expect(slow.diagnostics().cacheBytes).toBe(0);
  });
});
