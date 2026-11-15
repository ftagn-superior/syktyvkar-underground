import { describe, it, expect } from 'vitest';
import { cityLodFixture } from '../../../../tests/fixtures/city-lod.js';
import { CellStreamer, type CellGraphics } from './cells';
import { VerifiedResources } from './resources';
import { graphicsLevel, rayBoundsDistance } from './graphics-plan';
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
it('orders editor candidates by forward ray entry, including parallel, inside and clipped rays', () => {
  const bounds = { min: { x: 10, y: -1, z: -1 }, max: { x: 20, y: 1, z: 1 } },
    origin = { x: 0, y: 0, z: 0 };
  expect(rayBoundsDistance(origin, { x: 1, y: 0, z: 0 }, bounds, 100)).toBe(10);
  expect(rayBoundsDistance({ x: 15, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, bounds, 100)).toBe(0);
  expect(rayBoundsDistance(origin, { x: -1, y: 0, z: 0 }, bounds, 100)).toBeUndefined();
  expect(rayBoundsDistance(origin, { x: 0, y: 1, z: 0 }, bounds, 100)).toBeUndefined();
  expect(rayBoundsDistance(origin, { x: 1, y: 0, z: 0 }, bounds, 9)).toBeUndefined();
});
async function ready(s: CellStreamer) {
  for (let i = 0; i < 1000; i++) {
    s.pump(100);
    await tick();
    if (s.backgroundReady && !s.transitioning) return;
  }
  throw new Error(JSON.stringify(s.diagnostics()));
}
function fixture(radius = 1000, eastX?: number, backgroundBodies = 0) {
  const f = cityLodFixture();
  if (backgroundBodies) {
    f.world.buildings[0].position.x = -200;
    for (let i = 0; i < backgroundBodies; i++)
      f.world.buildings.push({ ...f.world.buildings[0], entityId: 'background-' + i });
    f.world.entities = [
      {
        entityId: 'edge',
        kind: 'obstacle',
        position: { x: 260, y: 0, z: 260 },
        size: { x: 1, y: 1, z: 1 },
        mass: 0,
        friction: 0.6,
        restitution: 0,
        color: '#ffffff',
      },
    ];
  }
  if (eastX !== undefined) {
    f.world.buildings[1].position.x = eastX;
  }
  if (eastX !== undefined || backgroundBodies) f.publication = f.publish();
  const reads: string[] = [],
    live = new Set<string>(),
    far = new Set<string>(),
    physical = new Set<string>();
  let farWait: (() => Promise<void>) | undefined,
    corrupt = false,
    lateDisposals = 0;
  let pins = 0,
    pixels = 0,
    clock = 0,
    clockStep = 0;
  const resources = new VerifiedResources(f.publication.manifest, 'http://world/', {
    fetch: async (url) => {
      const path = new URL(String(url)).pathname.slice(1);
      reads.push(path);
      const bytes = Uint8Array.from(f.publication.payloads.get(path)!);
      if (corrupt && path.startsWith('hlod/') && path.endsWith('.glb')) bytes[0] ^= 1;
      return new Response(bytes.buffer);
    },
  });
  const graphics: CellGraphics = {
    prepareCellAssets: async (m, ids, read) => {
      for (const id of ids) {
        await read(m.assets[id].partsFile);
        await read(m.assets[id].modelFile!);
      }
      pins++;
      let released = false;
      return () => {
        if (released) throw new Error('double model release');
        released = true;
        pins--;
      };
    },
    retainStatic: (i) => {
      if (live.has(i.entityId)) throw new Error('duplicate instance');
      live.add(i.entityId);
    },
    releaseStatic: (id) => {
      if (!live.delete(id)) throw new Error('double instance release');
    },
    projectGraphicsGroup: () => ({ pixels, visible: true, nearPlane: false }),
    prepareFarGroup: async (g, read, signal) => {
      for (const r of g.far.resources) {
        await read(r.partsFile);
        await read(r.modelFile);
      }
      signal.throwIfAborted();
      if (farWait) await farWait();
      return {
        activate: () => {
          if (far.has(g.version)) throw new Error('duplicate far group');
          far.add(g.version);
        },
        dispose: () => {
          if (!far.delete(g.version)) lateDisposals++;
        },
      };
    },
  };
  const stream = new CellStreamer(
    f.publication.manifest,
    resources,
    {
      retainStatic: (item) => {
        physical.add(item.entityId);
      },
      releaseStatic: (id) => {
        physical.delete(id);
      },
    },
    graphics,
    () => (clock += clockStep),
  );
  stream.setPreview({ x: 0, y: 0, z: 0 }, radius);
  return {
    ...f,
    stream,
    reads,
    live,
    far,
    physical,
    graphics,
    holdFar: (wait?: () => Promise<void>) => (farWait = wait),
    corrupt: (value: boolean) => (corrupt = value),
    get lateDisposals() {
      return lateDisposals;
    },
    get pins() {
      return pins;
    },
    zoom: (n: number) => (pixels = n),
    advance: () => (clock += 6000),
    clockTax: (step: number) => (clockStep = step),
  };
}
describe('group streaming lifecycle', () => {
  it('connects far protected graphics without draining unrelated background physics first', async () => {
    const f = fixture(1000, undefined, 100);
    f.clockTax(0.2);
    f.stream.setArea({ x: 10, y: 0, z: 10 });
    for (let i = 0; i < 1000 && !f.live.has('edge'); i++) {
      f.stream.pump(2);
      await tick();
    }
    expect(f.live.has('edge')).toBe(true);
    expect(f.physical.size).toBeLessThan(f.world.buildings.length);
    f.stream.dispose();
  });
  it('activates prepared far groups despite expensive steady cell bookkeeping in a small frame budget', async () => {
    const f = fixture();
    f.clockTax(0.2);
    for (let n = 0; n < 1000 && !f.stream.backgroundReady; n++) {
      f.stream.pump(2);
      await tick();
    }
    expect(f.stream.backgroundReady).toBe(true);
    expect(f.far.size).toBe(2);
    f.stream.dispose();
  });
  it('selects far before HTTP and releases detailed instances and pins over ten cycles', async () => {
    const f = fixture();
    await ready(f.stream);
    expect(f.far.size).toBe(2);
    expect(f.live.size).toBe(0);
    expect(f.reads.some((p) => p.startsWith('assets/'))).toBe(false);
    expect(f.pins).toBe(0);
    expect(f.physical.size).toBe(0);
    for (let n = 0; n < 10; n++) {
      f.zoom(400);
      await ready(f.stream);
      expect([...f.live].sort()).toEqual(['east', 'west']);
      expect(f.pins).toBe(2);
      expect(f.far.size).toBe(0);
      f.zoom(100);
      await ready(f.stream);
      expect(f.live.size).toBe(0);
      expect(f.pins).toBe(0);
      expect(f.far.size).toBe(2);
    }
    f.stream.dispose();
    expect(f.far.size).toBe(0);
    expect(f.pins).toBe(0);
  });
  it('loads a coverage owner even when its own bounds lie beyond the circular preload edge', async () => {
    const f = fixture(125, 260);
    await ready(f.stream);
    expect(f.stream.diagnostics().groups.find((g) => g.id === 'group-4_2')?.current).toBe('far');
    f.stream.dispose();
  });
  it('does not let a stalled far neighbour block critical physics or player near readiness, and disposes late results', async () => {
    const f = fixture();
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    f.holdFar(() => hold);
    for (let i = 0; i < 30; i++) {
      f.stream.pump(100);
      await tick();
    }
    f.stream.setArea({ x: 0, y: 0, z: 0 });
    for (let i = 0; i < 300 && !f.stream.criticalReady; i++) {
      f.stream.pump(100);
      await tick();
    }
    expect(f.stream.criticalReady).toBe(true);
    expect(f.physical.size).toBe(2);
    expect(f.live.has('east')).toBe(true);
    expect(f.stream.backgroundReady).toBe(false);
    f.stream.dispose();
    release();
    for (let i = 0; i < 10; i++) await tick();
    expect(f.far.size).toBe(0);
    expect(f.lateDisposals).toBeGreaterThan(0);
    expect(f.pins).toBe(0);
  });
  it('retains the old far view on a failed near replacement, retries explicitly and avoids a request storm', async () => {
    const f = fixture();
    await ready(f.stream);
    const original = f.graphics.prepareCellAssets;
    let attempts = 0;
    f.graphics.prepareCellAssets = async () => {
      attempts++;
      throw new Error('Model failure');
    };
    f.zoom(400);
    for (let i = 0; i < 100; i++) {
      f.stream.pump(100);
      await tick();
    }
    expect(f.stream.backgroundProblem).toContain('Model failure');
    expect(attempts).toBe(2);
    expect(f.far.size).toBe(2);
    expect(f.live.size).toBe(0);
    f.graphics.prepareCellAssets = original;
    f.stream.retry();
    await ready(f.stream);
    expect(f.live.size).toBe(2);
    f.stream.dispose();
  });
  it('rejects corrupt cold far bytes and recovers with the same bounded resource cache', async () => {
    const f = fixture();
    f.corrupt(true);
    const deadline = performance.now() + 3000;
    while (!f.stream.backgroundProblem && performance.now() < deadline) {
      f.stream.pump(100);
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(f.stream.backgroundProblem).toContain('SHA-256');
    expect(f.far.size).toBe(0);
    expect(f.reads.some((p) => p.startsWith('assets/'))).toBe(false);
    f.corrupt(false);
    f.stream.retry();
    await ready(f.stream);
    expect(f.far.size).toBe(2);
    f.stream.dispose();
  });
  it('uses CSS-pixel hysteresis, offscreen far and independent player pins', () => {
    const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 125, y: 20, z: 125 } },
      projection = { pixels: 280, visible: true, nearPlane: false };
    expect(graphicsLevel(bounds, projection, [], 'near')).toBe('near');
    expect(graphicsLevel(bounds, projection, [], 'far')).toBe('far');
    expect(graphicsLevel(bounds, { ...projection, visible: false }, [], 'near')).toBe('far');
    expect(
      graphicsLevel(bounds, { ...projection, visible: false }, [{ x: -59, y: 0, z: 0 }], 'far'),
    ).toBe('near');
    expect(graphicsLevel(bounds, { ...projection, nearPlane: true }, [])).toBe('near');
  });
  it('prepares a newly occupied owner before adoption and transfers unchanged near instances', async () => {
    const f = fixture();
    const publicationEvents: string[] = [];
    f.graphics.setGraphicsManifest = (m) => publicationEvents.push('manifest:' + m.mapVersion);
    const retain = f.graphics.retainStatic;
    f.graphics.retainStatic = (instance, version) => {
      publicationEvents.push('retain:' + instance.entityId);
      retain(instance, version);
    };
    f.zoom(400);
    await ready(f.stream);
    f.world.buildings.push({
      ...f.world.buildings[1],
      entityId: 'new',
      position: { x: 140, y: 0, z: 140 },
    });
    const next = f.publish();
    const resources = new VerifiedResources(next.manifest, 'http://next/', {
      fetch: async (url) =>
        new Response(next.payloads.get(new URL(String(url)).pathname.slice(1))!.slice().buffer),
    });
    const transition = f.stream.transition(next.manifest, resources);
    await ready(f.stream);
    await transition;
    expect(publicationEvents.indexOf('manifest:' + next.manifest.mapVersion)).toBeLessThan(
      publicationEvents.indexOf('retain:new'),
    );
    expect([...f.live].sort()).toEqual(['east', 'new', 'west']);
    expect(f.pins).toBe(3);
    f.stream.dispose();
    expect(f.pins).toBe(0);
  });
  it('keeps the editor pin when a serialized publication replaces bounds objects', async () => {
    const f = fixture();
    const groups = f.publication.manifest.graphics!.groups;
    const ids = new WeakMap(groups.map((g) => [g.bounds, g.groupId]));
    const selected = groups.find((g) => g.memberIds.includes('east'))!.groupId;
    f.graphics.projectGraphicsGroup = (bounds, id) => ({
      pixels: 0,
      visible: true,
      nearPlane: false,
      pinned: (id ?? ids.get(bounds)) === selected,
    });
    await ready(f.stream);
    expect([...f.live]).toEqual(['east']);
    f.world.buildings = f.world.buildings.filter((i) => i.entityId !== 'west');
    const next = f.publish(),
      manifest = structuredClone(next.manifest);
    const resources = new VerifiedResources(manifest, 'http://next/', {
      fetch: async (url) =>
        new Response(next.payloads.get(new URL(String(url)).pathname.slice(1))!.slice().buffer),
    });
    const changed = f.stream.transition(manifest, resources);
    await ready(f.stream);
    await changed;
    expect([...f.live]).toEqual(['east']);
    expect(f.pins).toBe(1);
    f.stream.dispose();
  });
  it('keeps the coherent old publication until changed far geometry has prepared', async () => {
    const f = fixture();
    await ready(f.stream);
    f.world.buildings.shift();
    const next = f.publish();
    const resources = new VerifiedResources(next.manifest, 'http://next/', {
      fetch: async (url) =>
        new Response(next.payloads.get(new URL(String(url)).pathname.slice(1))!.slice().buffer),
    });
    const changed = f.stream.transition(next.manifest, resources);
    expect(f.stream.manifest).toBe(f.publication.manifest);
    await ready(f.stream);
    await changed;
    expect(f.stream.manifest).toBe(next.manifest);
    expect(f.far.size).toBe(1);
    expect(f.live.size).toBe(0);
    f.stream.dispose();
  });
});
