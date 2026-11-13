import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { encodeGraphicsPack, type WorldManifest } from '@su/contracts';
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
const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
function packedFixture(entries?: [string, Uint8Array][]) {
  const model = new Uint8Array([1, 2, 3, 4]);
  const parts = new Uint8Array([5, 6, 7]);
  const packed = encodeGraphicsPack(
    entries ?? [
      ['model.glb', model],
      ['parts.json', parts],
    ],
  );
  const payloads = new Map([
    ['graphics/a.pack', packed],
    ['model.glb', model],
    ['parts.json', parts],
  ]);
  const manifest = {
    cells: [{ cellId: '0_0', assetIds: ['a'], graphicsPacks: ['graphics/a.pack'] }],
    assets: {
      a: { modelFile: 'model.glb', partsFile: 'parts.json', collisionFile: 'collision.json' },
    },
    files: Object.fromEntries([...payloads].map(([path, value]) => [path, digest(value)])),
  } as unknown as WorldManifest;
  return { manifest, payloads, model, parts, packed };
}

describe('verified resources', () => {
  it('loads verified physics packs into original collision entries and retains individual-file fallback', async () => {
    const collision = new Uint8Array([7, 8, 9]);
    const fixture = packedFixture();
    const packed = encodeGraphicsPack([['collision.json', collision]]);
    fixture.payloads.set('collision.json', collision);
    fixture.payloads.set('physics/a.pack', packed);
    fixture.manifest.cells[0].physicsPacks = ['physics/a.pack'];
    fixture.manifest.files['collision.json'] = digest(collision);
    fixture.manifest.files['physics/a.pack'] = digest(packed);
    const calls: string[] = [];
    const resources = new VerifiedResources(fixture.manifest, '/', {
      fetch: async (url) => {
        calls.push(String(url));
        return new Response(Uint8Array.from(fixture.payloads.get(String(url).slice(1))!).buffer);
      },
    });
    await resources.prefetchPhysics('0_0');
    expect(await resources.read('collision.json')).toEqual(collision);
    expect(calls).toEqual(['/physics/a.pack']);
    expect(resources.diagnostics()).toMatchObject({ cacheBytes: 3, cacheEntries: 1 });
    resources.invalidate('collision.json');
    expect(await resources.read('collision.json')).toEqual(collision);
    expect(calls).toEqual(['/physics/a.pack', '/collision.json']);
    delete fixture.manifest.cells[0].physicsPacks;
    await resources.prefetchPhysics('0_0');
    expect(calls).toHaveLength(2);
    resources.dispose();
  });

  it('rejects corrupt or non-collision physics pack entries without publishing partial cache state', async () => {
    for (const entries of [
      [['collision.json', new Uint8Array([99])]],
      [['model.glb', new Uint8Array([1, 2, 3, 4])]],
    ] as [string, Uint8Array][][]) {
      const fixture = packedFixture();
      const packed = encodeGraphicsPack(entries);
      fixture.manifest.cells[0].physicsPacks = ['physics/a.pack'];
      fixture.manifest.files['physics/a.pack'] = digest(packed);
      fixture.manifest.files['collision.json'] = digest(new Uint8Array([7]));
      const resources = new VerifiedResources(fixture.manifest, '/', {
        fetch: async () => new Response(Uint8Array.from(packed).buffer),
      });
      await expect(resources.prefetchPhysics('0_0')).rejects.toThrow(
        /SHA-256|Unexpected physics pack entry/,
      );
      expect(resources.diagnostics().cacheBytes).toBe(0);
      resources.dispose();
    }
  });

  it('keeps a shared physics pack alive for a surviving cell and discards the last cancelled consumer', async () => {
    const fixture = packedFixture();
    const collision = new Uint8Array([7]);
    const packed = encodeGraphicsPack([['collision.json', collision]]);
    fixture.manifest.cells[0].physicsPacks = ['physics/a.pack'];
    fixture.manifest.cells.push({ ...fixture.manifest.cells[0], cellId: '1_0' });
    fixture.manifest.files['physics/a.pack'] = digest(packed);
    fixture.manifest.files['collision.json'] = digest(collision);
    let finish!: () => void;
    let signal: AbortSignal | undefined;
    const resources = new VerifiedResources(fixture.manifest, '/', {
      fetch: async (_url, options) => {
        signal = options!.signal as AbortSignal;
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return new Response(Uint8Array.from(packed).buffer);
      },
    });
    const first = new AbortController();
    const cancelled = resources.prefetchPhysics('0_0', first.signal).catch((e: Error) => e.name);
    const retained = resources.prefetchPhysics('1_0');
    first.abort();
    expect(await cancelled).toBe('AbortError');
    expect(signal!.aborted).toBe(false);
    finish();
    await retained;
    expect(await resources.read('collision.json')).toEqual(collision);
    resources.invalidate('collision.json');
    const last = new AbortController();
    const abandoned = resources.prefetchPhysics('0_0', last.signal).catch((e: Error) => e.name);
    last.abort();
    expect(await abandoned).toBe('AbortError');
    finish();
    await tick();
    await tick();
    expect(resources.diagnostics().cacheBytes).toBe(0);
    resources.dispose();
  });

  it('unpacks one verified request into independent cached assets without retaining the envelope', async () => {
    const fixture = packedFixture();
    const calls: string[] = [];
    const resources = new VerifiedResources(fixture.manifest, '/', {
      fetch: async (url) => {
        calls.push(String(url));
        return new Response(Uint8Array.from(fixture.payloads.get(String(url).slice(1))!).buffer);
      },
    });
    await resources.prefetchGraphics('0_0');
    const model = await resources.read('model.glb');
    model.fill(99);
    expect(await resources.read('model.glb')).toEqual(fixture.model);
    expect(await resources.read('parts.json')).toEqual(fixture.parts);
    await resources.prefetchGraphics('0_0');
    expect(calls).toEqual(['/graphics/a.pack']);
    expect(resources.diagnostics()).toMatchObject({ cacheBytes: 7, cacheEntries: 2, downloads: 1 });
    resources.dispose();
  });

  it('coalesces concurrent packs while allowing one consumer to cancel', async () => {
    const fixture = packedFixture();
    let finish!: () => void;
    let calls = 0;
    let requestSignal: AbortSignal | undefined;
    const resources = new VerifiedResources(fixture.manifest, '/', {
      fetch: async (_url, options) => {
        calls++;
        requestSignal = options!.signal as AbortSignal;
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return new Response(Uint8Array.from(fixture.packed).buffer);
      },
    });
    const controller = new AbortController();
    const cancelled = resources
      .prefetchGraphics('0_0', controller.signal)
      .catch((e: Error) => e.name);
    const remaining = resources.prefetchGraphics('0_0');
    controller.abort();
    expect(await cancelled).toBe('AbortError');
    expect(requestSignal!.aborted).toBe(false);
    finish();
    await remaining;
    expect(calls).toBe(1);
    expect(await resources.read('model.glb')).toEqual(fixture.model);
    resources.dispose();
  });

  it('reuses a shared pack for a partially uncached neighboring cell and reloads it after eviction', async () => {
    const fixture = packedFixture();
    const extra = new Uint8Array([8, 9]);
    const ownPack = encodeGraphicsPack([
      ['b.glb', extra],
      ['b.json', extra],
    ]);
    fixture.payloads.set('b.glb', extra);
    fixture.payloads.set('b.json', extra);
    fixture.payloads.set('graphics/b.pack', ownPack);
    fixture.manifest.assets.b = {
      ...fixture.manifest.assets.a,
      modelFile: 'b.glb',
      partsFile: 'b.json',
    };
    fixture.manifest.cells.push({
      ...fixture.manifest.cells[0],
      cellId: '1_0',
      assetIds: ['a', 'b'],
      graphicsPacks: ['graphics/a.pack', 'graphics/b.pack'],
    });
    for (const [path, bytes] of fixture.payloads) fixture.manifest.files[path] = digest(bytes);
    const calls: string[] = [];
    const resources = new VerifiedResources(fixture.manifest, '/', {
      fetch: async (url) => {
        calls.push(String(url));
        return new Response(Uint8Array.from(fixture.payloads.get(String(url).slice(1))!).buffer);
      },
    });
    await resources.prefetchGraphics('0_0');
    await resources.prefetchGraphics('1_0');
    expect(calls).toEqual(['/graphics/a.pack', '/graphics/b.pack']);
    resources.invalidate('model.glb');
    await resources.prefetchGraphics('1_0');
    expect(calls).toEqual(['/graphics/a.pack', '/graphics/b.pack', '/graphics/a.pack']);
    expect(await resources.read('model.glb')).toEqual(fixture.model);
    resources.dispose();
  });

  it('rejects corrupt or unrelated entries even if the envelope hash is valid', async () => {
    for (const entries of [
      [
        ['model.glb', new Uint8Array([99])],
        ['parts.json', new Uint8Array([5, 6, 7])],
      ],
      [['collision.json', new Uint8Array([1])]],
    ] as [string, Uint8Array][][]) {
      const fixture = packedFixture(entries);
      const resources = new VerifiedResources(fixture.manifest, '/', {
        fetch: async () => new Response(Uint8Array.from(fixture.packed).buffer),
      });
      await expect(resources.prefetchGraphics('0_0')).rejects.toThrow(
        /SHA-256|Unexpected graphics pack entry/,
      );
      expect(resources.diagnostics().cacheBytes).toBe(0);
      resources.dispose();
    }
  });

  it('falls back to standalone files after eviction and on old manifests', async () => {
    const fixture = packedFixture();
    const calls: string[] = [];
    const resources = new VerifiedResources(fixture.manifest, '/', {
      cacheBytes: 4,
      fetch: async (url) => {
        calls.push(String(url));
        return new Response(Uint8Array.from(fixture.payloads.get(String(url).slice(1))!).buffer);
      },
    });
    await resources.prefetchGraphics('0_0');
    expect(resources.diagnostics().cacheBytes).toBeLessThanOrEqual(4);
    expect(await resources.read('model.glb')).toEqual(fixture.model);
    expect(calls).toEqual(['/graphics/a.pack', '/model.glb']);
    resources.dispose();
    delete fixture.manifest.cells[0].graphicsPacks;
    const old = new VerifiedResources(fixture.manifest, '/', {
      fetch: async () => {
        throw new Error('must not fetch');
      },
    });
    await old.prefetchGraphics('0_0');
    expect(old.diagnostics().downloads).toBe(0);
    old.dispose();
  });

  it('does not publish late pack bytes after its last consumer is cancelled', async () => {
    const fixture = packedFixture();
    let finish!: () => void;
    const resources = new VerifiedResources(fixture.manifest, '/', {
      fetch: async () => {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return new Response(Uint8Array.from(fixture.packed).buffer);
      },
    });
    const controller = new AbortController();
    const cancelled = resources
      .prefetchGraphics('0_0', controller.signal)
      .catch((e: Error) => e.name);
    controller.abort();
    expect(await cancelled).toBe('AbortError');
    finish();
    await tick();
    await tick();
    expect(resources.diagnostics()).toMatchObject({ cacheBytes: 0, cacheEntries: 0 });
    resources.dispose();
  });
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
