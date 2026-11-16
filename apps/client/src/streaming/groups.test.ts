import { describe, it, expect } from 'vitest';
import { cityLodFixture } from '../../../../tests/fixtures/city-lod.js';
import { CellStreamer, type CellGraphics } from './cells';
import { VerifiedResources } from './resources';
import { graphicsLevel, rayBoundsDistance } from './graphics-plan';
import type { Bounds } from '@su/contracts';
type CameraArea = { minX: number; maxX: number; minZ: number; maxZ: number };
const cameraArea = (x: number, z: number): CameraArea => ({
  minX: x - 2,
  maxX: x + 2,
  minZ: z - 2,
  maxZ: z + 2,
});
const inCameraArea = (
  area: CameraArea,
  bounds: { min: { x: number; z: number }; max: { x: number; z: number } },
  margin = 0,
) =>
  bounds.max.x + margin >= area.minX &&
  bounds.min.x - margin <= area.maxX &&
  bounds.max.z + margin >= area.minZ &&
  bounds.min.z - margin <= area.maxZ;
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
function fixture(radius = 1000, eastX?: number, backgroundBodies = 0, camera?: CameraArea) {
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
    physical = new Set<string>(),
    editorPins = new Set<string>();
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
    ...(camera
      ? { isGraphicsVisible: (bounds: Bounds, margin = 0) => inCameraArea(camera, bounds, margin) }
      : {}),
    projectGraphicsGroup: (bounds, id) => ({
      pixels,
      visible: camera ? inCameraArea(camera, bounds) : true,
      nearPlane: false,
      pinned: editorPins.has(id ?? ''),
    }),
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
    editorPins,
    holdFar: (wait?: () => Promise<void>) => (farWait = wait),
    corrupt: (value: boolean) => (corrupt = value),
    get lateDisposals() {
      return lateDisposals;
    },
    get pins() {
      return pins;
    },
    zoom: (n: number) => (pixels = n),
    advance: (ms = 6000) => (clock += ms),
    replan: () => stream.setVisualArea({ x: 0, y: 0, z: 0 }, radius),
    clockTax: (step: number) => (clockStep = step),
  };
}
describe('group streaming lifecycle', () => {
  it('queries each group projection once per visual plan, including editor pin discovery', () => {
    const f = fixture();
    const calls = new Map<string, number>();
    const project = f.graphics.projectGraphicsGroup!;
    f.graphics.projectGraphicsGroup = (bounds, id) => {
      calls.set(id!, (calls.get(id!) ?? 0) + 1);
      return project(bounds, id);
    };
    try {
      f.replan();
      expect(calls.size).toBe(f.publication.manifest.graphics!.groups.length);
      expect([...calls.values()].every((count) => count === 1)).toBe(true);
    } finally {
      f.stream.dispose();
    }
  });

  it('publishes an already prepared far fallback before preparing its near replacement', async () => {
    const f = fixture();
    try {
      // Let preparation complete without another pump activating the result.
      for (let i = 0; i < 100; i++) {
        if (f.stream.diagnostics().groups.some((group) => group.pending === 'far')) break;
        f.stream.pump(100);
        await tick();
      }
      expect(f.stream.diagnostics().groups.some((group) => group.pending === 'far')).toBe(true);
      f.zoom(400);
      f.replan();
      expect(f.stream.diagnostics().groups.some((group) => group.pending === 'far')).toBe(true);
      f.stream.pump(100);
      expect(f.far.size).toBeGreaterThan(0);
      await ready(f.stream);
      expect([...f.live].sort()).toEqual(['east', 'west']);
      expect(f.far.size).toBe(0);
    } finally {
      f.stream.dispose();
    }
  });

  it('preempts a retained far load when the unchanged near request gains a player pin', async () => {
    const f = fixture();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    f.holdFar(() => held);
    try {
      for (let i = 0; i < 30; i++) {
        f.stream.pump(100);
        await tick();
      }
      f.zoom(400);
      f.replan();
      expect(f.stream.diagnostics().groups.some((group) => group.wanted === 'near')).toBe(true);
      // wanted remains near, but the occupied area now requires near readiness.
      f.stream.setArea({ x: 0, y: 0, z: 0 });
      for (let i = 0; i < 300 && !f.stream.criticalReady; i++) {
        f.stream.pump(100);
        await tick();
      }
      expect(f.stream.criticalReady).toBe(true);
      expect(f.live.has('east')).toBe(true);
    } finally {
      f.stream.dispose();
      release();
      await tick();
    }
  });

  it('does not block a near upgrade when a retained speculative far preparation fails', async () => {
    const f = fixture();
    let rejectFar: ((reason: Error) => void) | undefined;
    f.holdFar(
      () =>
        new Promise<void>((_, reject) => {
          rejectFar = reject;
        }),
    );
    try {
      for (let i = 0; i < 30 && !rejectFar; i++) {
        f.stream.pump(100);
        await tick();
      }
      expect(rejectFar).toBeDefined();
      f.zoom(400);
      f.replan();
      expect(f.stream.diagnostics().groups.some((group) => group.wanted === 'near')).toBe(true);
      rejectFar!(new Error('far failed'));
      await tick();
      await ready(f.stream);
      expect([...f.live].sort()).toEqual(['east', 'west']);
      expect(f.stream.diagnostics().groups.every((group) => !group.error)).toBe(true);
    } finally {
      f.stream.dispose();
    }
  });

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
  it('loads the camera border group even beyond the former circular preload edge', async () => {
    const f = fixture(125, 260, 0, cameraArea(260, 10));
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

describe('camera visibility streaming', () => {
  it('does not turn a queued cold group into a retention request when the camera narrows before preparation', async () => {
    const camera: CameraArea = { minX: -140, maxX: 20, minZ: -40, maxZ: 20 },
      f = fixture(1000, undefined, 0, camera),
      west = f.publication.manifest.graphics!.groups.find((g) => g.memberIds.includes('west'))!,
      east = f.publication.manifest.graphics!.groups.find((g) => g.memberIds.includes('east'))!;
    try {
      // The first plan queued both groups, but no pump has begun their preparation.
      Object.assign(camera, cameraArea(10, 10));
      expect(inCameraArea(camera, west.bounds, 125)).toBe(false);
      expect(inCameraArea(camera, west.bounds, 250)).toBe(true);
      f.replan();
      await ready(f.stream);
      expect(f.far).toEqual(new Set([east.version]));
      expect(
        f.stream.diagnostics().groups.find((g) => g.id === west.groupId)?.wanted,
      ).toBeUndefined();
      for (const resource of west.far.resources) {
        expect(f.reads).not.toContain(resource.modelFile);
        expect(f.reads).not.toContain(resource.partsFile);
      }
    } finally {
      f.stream.dispose();
    }
  });

  it('includes the complete bounds at the exact 125 metre load and 250 metre retention edges', async () => {
    const camera = cameraArea(1000, 1000),
      f = fixture(1000, undefined, 0, camera),
      east = f.publication.manifest.graphics!.groups.find((g) => g.memberIds.includes('east'))!;
    try {
      Object.assign(camera, {
        minX: east.bounds.max.x + 125,
        maxX: east.bounds.max.x + 129,
        minZ: east.bounds.min.z,
        maxZ: east.bounds.max.z,
      });
      f.replan();
      await ready(f.stream);
      expect(f.far).toEqual(new Set([east.version]));
      camera.minX = east.bounds.max.x + 250;
      camera.maxX = camera.minX + 4;
      f.replan();
      f.advance(6000);
      await ready(f.stream);
      expect(f.far.has(east.version)).toBe(true);
      camera.minX += 0.001;
      camera.maxX += 0.001;
      f.replan();
      f.advance(5000);
      await ready(f.stream);
      expect(f.far.size).toBe(0);
    } finally {
      f.stream.dispose();
    }
  });

  it('loads only the 125 metre camera area without waiting for an unseen coverage neighbour', async () => {
    const camera = cameraArea(10, 10),
      f = fixture(1000, undefined, 0, camera),
      groups = f.publication.manifest.graphics!.groups,
      east = groups.find((g) => g.memberIds.includes('east'))!,
      west = groups.find((g) => g.memberIds.includes('west'))!;
    try {
      await ready(f.stream);
      expect(f.far).toEqual(new Set([east.version]));
      expect(inCameraArea(camera, west.bounds, 125)).toBe(false);
      expect(inCameraArea(camera, west.bounds, 250)).toBe(true);
      expect(
        west.coverageCellIds.some((id) => f.stream.diagnostics().graphicsRequired.includes(id)),
      ).toBe(true);
      for (const resource of west.far.resources) {
        expect(f.reads).not.toContain(resource.modelFile);
        expect(f.reads).not.toContain(resource.partsFile);
      }
      expect(f.stream.graphicsReadyRadius({ x: 0, y: 0, z: 0 }, 1000)).toBe(1000);
      expect(f.stream.backgroundReady).toBe(true);
    } finally {
      f.stream.dispose();
    }
  });

  it('retains loaded groups inside 250 metres and gives a full new five seconds after a cancelled release', async () => {
    const camera = cameraArea(-127, -30),
      f = fixture(1000, undefined, 0, camera),
      west = f.publication.manifest.graphics!.groups.find((g) => g.memberIds.includes('west'))!,
      east = f.publication.manifest.graphics!.groups.find((g) => g.memberIds.includes('east'))!;
    try {
      await ready(f.stream);
      expect(f.far).toEqual(new Set([west.version]));
      Object.assign(camera, cameraArea(10, 10));
      f.replan();
      await ready(f.stream);
      expect(f.far).toEqual(new Set([west.version, east.version]));
      f.advance(6000);
      await ready(f.stream);
      expect(f.far.has(west.version)).toBe(true);

      Object.assign(camera, cameraArea(200, 10));
      f.replan();
      f.advance(4000);
      await ready(f.stream);
      expect(f.far.has(west.version)).toBe(true);
      Object.assign(camera, cameraArea(10, 10));
      f.replan();
      f.advance(6000);
      await ready(f.stream);
      expect(f.far.has(west.version)).toBe(true);

      Object.assign(camera, cameraArea(200, 10));
      f.replan();
      f.advance(4999);
      await ready(f.stream);
      expect(f.far.has(west.version)).toBe(true);
      f.advance(1);
      await ready(f.stream);
      expect(f.far).toEqual(new Set([east.version]));

      const oldReads = f.reads.length;
      Object.assign(camera, cameraArea(10, 10));
      f.replan();
      await ready(f.stream);
      expect(f.far).toEqual(new Set([east.version]));
      expect(
        f.reads
          .slice(oldReads)
          .some((path) => west.far.resources.some((r) => r.modelFile === path)),
      ).toBe(false);
    } finally {
      f.stream.dispose();
    }
  });

  it('keeps player and editor near pins beyond the camera area while preserving critical physics', async () => {
    const camera = cameraArea(1000, 1000),
      f = fixture(1000, undefined, 0, camera),
      east = f.publication.manifest.graphics!.groups.find((g) => g.memberIds.includes('east'))!;
    try {
      f.stream.setArea({ x: -127, y: 0, z: -30 });
      await ready(f.stream);
      expect(f.stream.criticalReady).toBe(true);
      expect(f.live).toEqual(new Set(['west']));
      expect(f.physical).toEqual(new Set(['east', 'west']));

      f.editorPins.add(east.groupId);
      f.replan();
      await ready(f.stream);
      expect(f.live).toEqual(new Set(['east', 'west']));
      f.editorPins.delete(east.groupId);
      f.replan();
      f.advance(5000);
      await ready(f.stream);
      expect(f.live).toEqual(new Set(['west']));
      expect(f.pins).toBe(1);
      expect(f.stream.criticalReady).toBe(true);
    } finally {
      f.stream.dispose();
    }
  });

  it('uses the same camera plan when staging changed offscreen groups in a new publication', async () => {
    const camera = cameraArea(10, 10),
      f = fixture(1000, undefined, 0, camera);
    try {
      await ready(f.stream);
      f.world.buildings[0].position.x -= 1;
      const next = f.publish(),
        west = next.manifest.graphics!.groups.find((g) => g.memberIds.includes('west'))!,
        east = next.manifest.graphics!.groups.find((g) => g.memberIds.includes('east'))!,
        nextReads: string[] = [];
      const resources = new VerifiedResources(next.manifest, 'http://next/', {
        fetch: async (url) => {
          const path = new URL(String(url)).pathname.slice(1);
          nextReads.push(path);
          return new Response(next.payloads.get(path)!.slice().buffer);
        },
      });
      const changed = f.stream.transition(next.manifest, resources);
      await ready(f.stream);
      await changed;
      expect(f.far).toEqual(new Set([east.version]));
      for (const resource of west.far.resources) {
        expect(nextReads).not.toContain(resource.modelFile);
        expect(nextReads).not.toContain(resource.partsFile);
      }
      expect(f.stream.backgroundReady).toBe(true);
      expect(f.stream.graphicsReadyRadius({ x: 0, y: 0, z: 0 }, 1000)).toBe(1000);
    } finally {
      f.stream.dispose();
    }
  });

  it('keeps the remaining release delay across an unchanged group publication transfer', async () => {
    const camera = cameraArea(-127, -30),
      f = fixture(1000, undefined, 0, camera),
      west = f.publication.manifest.graphics!.groups.find((g) => g.memberIds.includes('west'))!;
    try {
      await ready(f.stream);
      Object.assign(camera, cameraArea(200, 10));
      f.replan();
      f.advance(4000);
      f.world.buildings[1].position.x += 1;
      const next = f.publish(),
        resources = new VerifiedResources(next.manifest, 'http://next/', {
          fetch: async (url) =>
            new Response(next.payloads.get(new URL(String(url)).pathname.slice(1))!.slice().buffer),
        });
      const changed = f.stream.transition(next.manifest, resources);
      await ready(f.stream);
      await changed;
      expect(f.far.has(west.version)).toBe(true);
      f.advance(999);
      await ready(f.stream);
      expect(f.far.has(west.version)).toBe(true);
      f.advance(1);
      await ready(f.stream);
      expect(f.far.has(west.version)).toBe(false);
    } finally {
      f.stream.dispose();
    }
  });

  it('drops a changed group at publication adoption without loading its offscreen replacement during release grace', async () => {
    const camera = cameraArea(-127, -30),
      f = fixture(1000, undefined, 0, camera),
      oldWest = f.publication.manifest.graphics!.groups.find((g) => g.memberIds.includes('west'))!;
    try {
      await ready(f.stream);
      expect(f.far).toEqual(new Set([oldWest.version]));
      Object.assign(camera, cameraArea(200, 10));
      f.replan();
      f.advance(1000);
      f.world.buildings[0].position.x -= 1;
      const next = f.publish(),
        west = next.manifest.graphics!.groups.find((g) => g.memberIds.includes('west'))!,
        blocked = new Set(west.far.resources.flatMap((r) => [r.modelFile, r.partsFile])),
        nextReads: string[] = [];
      expect(west.version).not.toBe(oldWest.version);
      const resources = new VerifiedResources(next.manifest, 'http://next/', {
        fetch: async (url) => {
          const path = new URL(String(url)).pathname.slice(1);
          nextReads.push(path);
          if (blocked.has(path)) throw new Error('Offscreen replacement must not load');
          return new Response(next.payloads.get(path)!.slice().buffer);
        },
      });
      const changed = f.stream.transition(next.manifest, resources);
      expect(f.stream.manifest).toBe(f.publication.manifest);
      expect(f.far).toEqual(new Set([oldWest.version]));
      await ready(f.stream);
      await changed;
      expect(f.stream.manifest).toBe(next.manifest);
      expect(f.far.size).toBe(0);
      expect(nextReads.some((path) => blocked.has(path))).toBe(false);
      expect(f.stream.diagnostics().groups.some((g) => g.id === west.groupId)).toBe(false);
      expect(f.stream.backgroundReady).toBe(true);
    } finally {
      f.stream.dispose();
    }
  });

  it('disposes a late far preparation after its group leaves the camera area', async () => {
    const camera = cameraArea(-127, -30),
      f = fixture(1000, undefined, 0, camera);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    f.holdFar(() => held);
    try {
      for (let i = 0; i < 30; i++) {
        f.stream.pump(100);
        await tick();
      }
      expect(f.reads.some((path) => path.startsWith('hlod/'))).toBe(true);
      Object.assign(camera, cameraArea(1000, 1000));
      f.replan();
      await ready(f.stream);
      release();
      for (let i = 0; i < 20; i++) await tick();
      f.advance(5000);
      await ready(f.stream);
      expect(f.far.size).toBe(0);
      expect(f.lateDisposals).toBeGreaterThan(0);
      expect(f.stream.backgroundProblem).toBeUndefined();
    } finally {
      release();
      f.stream.dispose();
    }
  });
});
