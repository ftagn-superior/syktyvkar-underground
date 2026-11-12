import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  type WorldManifest,
  type BuildingInstance,
  type StaticEntityDefinition,
} from '@su/contracts';
import { buildWorld } from '../../../../tools/world-build/src/index.js';
import { CellStreamer, cellNeighborhood, circularCells, type CellGraphics } from './cells';
import { VerifiedResources } from './resources';
let directory: string;
let manifest: WorldManifest;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'su-dm-cells-'));
  manifest = await buildWorld(resolve('content/worlds/streaming-lab/world.json'), directory);
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function until(stream: CellStreamer, predicate = () => stream.criticalReady) {
  const deadline = performance.now() + 10000;
  while (performance.now() < deadline) {
    stream.pump(1000);
    if (predicate()) return;
    await tick();
  }
  throw new Error(JSON.stringify(stream.diagnostics()));
}
function fixture(clockStep = 0) {
  let now = 0;
  const reads: string[] = [];
  const resources = new VerifiedResources(manifest, '/', {
    fetch: async (url) => {
      const path = String(url).slice(1);
      reads.push(path);
      return new Response(await readFile(join(directory, path)));
    },
  });
  const physics = new Map<string, number>(),
    graphical = new Map<string, number>();
  const add = (map: Map<string, number>, item: BuildingInstance | StaticEntityDefinition) =>
    map.set(item.entityId, (map.get(item.entityId) ?? 0) + 1);
  const remove = (map: Map<string, number>, id: string) => {
    const count = map.get(id);
    if (!count) throw new Error('Double release: ' + id);
    if (count === 1) map.delete(id);
    else map.set(id, count - 1);
  };
  let pins = 0;
  const graphics: CellGraphics = {
    prepareCellAssets: async () => {
      pins++;
      return () => {
        pins--;
      };
    },
    retainStatic: (item) => {
      add(graphical, item);
    },
    releaseStatic: (id) => remove(graphical, id),
  };
  const stream = new CellStreamer(
    manifest,
    resources,
    {
      retainStatic: (item) => {
        add(physics, item);
      },
      releaseStatic: (id) => remove(physics, id),
    },
    graphics,
    () => {
      now += clockStep;
      return now;
    },
  );
  return {
    stream,
    reads,
    physics,
    graphical,
    graphics,
    pins: () => pins,
    advance: (budgetMs = 1000) => {
      now += 5001;
      stream.pump(budgetMs);
    },
  };
}
describe('segmented world ownership', () => {
  it('limits a close preview to the camera area while gameplay keeps the full physics circle', async () => {
    const v = fixture();
    const center = { x: 0, y: 0, z: 0 };
    try {
      v.stream.setPreview(center, 125);
      await until(v.stream, () => v.stream.backgroundReady);
      const preview = v.stream.diagnostics();
      expect(preview.graphicsRequired).toEqual(circularCells(manifest, center, 250));
      expect(preview.physicsRequired).toHaveLength(0);
      expect(preview.graphicsRequired.length).toBeLessThan(
        circularCells(manifest, center, 625).length,
      );
      v.stream.setArea(center);
      await until(v.stream, () => v.stream.backgroundReady);
      const playing = v.stream.diagnostics();
      expect(playing.physicsRequired.sort()).toEqual(circularCells(manifest, center, 500).sort());
      expect(playing.graphicsRequired.length).toBeLessThan(playing.physicsRequired.length);
      expect(playing.criticalReady).toBe(true);
      // Far preview models are released after zooming back in; collider ownership survives.
      v.stream.setVisualArea(center, 3000);
      await until(v.stream, () => v.stream.backgroundReady);
      v.stream.setVisualArea(center, 125);
      v.advance();
      await until(v.stream, () => v.stream.backgroundReady);
      expect(v.stream.diagnostics().graphicsRequired.length).toBeLessThan(256);
      expect(v.stream.diagnostics().physicsRequired.sort()).toEqual(playing.physicsRequired);
    } finally {
      v.stream.dispose();
    }
  });
  it('makes more preparation progress on slow preview frames with a bounded pump budget', async () => {
    const usual = fixture(0.1);
    const preparing = fixture(0.1);
    try {
      for (const v of [usual, preparing]) v.stream.setPreview({ x: 0, y: 0, z: 0 }, 3000);
      const deadline = performance.now() + 10000;
      while (
        (usual.stream.diagnostics().requested.length ||
          preparing.stream.diagnostics().requested.length) &&
        performance.now() < deadline
      )
        await tick();
      expect(preparing.stream.diagnostics().requested).toHaveLength(0);
      usual.stream.pump(2);
      preparing.stream.pumpFrame(1 / 20);
      expect(preparing.graphical.size).toBeGreaterThan(usual.graphical.size);
      // The simulated clock also charges for the identical whole-grid maintenance pass.
      expect(
        preparing.stream.diagnostics().peakPumpMs - usual.stream.diagnostics().peakPumpMs,
      ).toBeLessThan(5);
      expect(preparing.physics.size).toBe(0);
    } finally {
      usual.stream.dispose();
      preparing.stream.dispose();
    }
  });
  it('selects a clipped circle, permits all 256 graphical cells without attaching distant physics', async () => {
    expect(cellNeighborhood(manifest, { x: 1000, y: 0, z: 1000 })).toHaveLength(4);
    const selected = circularCells(manifest, { x: 0, y: 0, z: 0 }, 500);
    expect(selected.length).toBeGreaterThan(64);
    expect(selected).not.toContain('0_0');
    const v = fixture();
    try {
      v.stream.setArea({ x: 0, y: 0, z: 0 });
      v.stream.setVisualArea({ x: 0, y: 0, z: 0 }, 3000);
      await until(v.stream, () => v.stream.backgroundReady);
      expect(v.stream.diagnostics().graphicsRequired).toHaveLength(256);
      expect(v.stream.diagnostics().physicsRequired.length).toBeLessThan(256);
      expect(v.graphical.size).toBeGreaterThan(v.physics.size);
      expect(v.stream.graphicsReadyRadius({ x: 0, y: 0, z: 0 }, 3000)).toBe(3000);
      expect(v.stream.diagnostics().resources.httpPeak).toBeLessThanOrEqual(4);
    } finally {
      v.stream.dispose();
    }
    expect(v.physics.size).toBe(0);
    expect(v.graphical.size).toBe(0);
    expect(v.pins()).toBe(0);
  });
  it('connects distant prepared cells under a real finite frame budget without re-scanning completed neighbors', async () => {
    const v = fixture(0.1);
    try {
      v.stream.setPreview({ x: 0, y: 0, z: 0 }, 3000);
      const deadline = performance.now() + 10000;
      while (!v.stream.backgroundReady && performance.now() < deadline) {
        v.stream.pump(2);
        await tick();
      }
      expect(v.stream.backgroundReady).toBe(true);
      expect(v.stream.graphicsReadyRadius({ x: 0, y: 0, z: 0 }, 3000)).toBe(3000);
    } finally {
      v.stream.dispose();
    }
  });
  it('preempts a graphical-only preview when joining needs physics in the same loading cell', async () => {
    const v = fixture();
    const prepare = v.graphics.prepareCellAssets;
    let stalled = false;
    v.graphics.prepareCellAssets = async (m, ids, read, signal) => {
      if (!stalled) {
        stalled = true;
        await new Promise<void>((_resolve, reject) => {
          signal!.addEventListener(
            'abort',
            () => reject(new DOMException('Preempted', 'AbortError')),
            { once: true },
          );
        });
      }
      return prepare(m, ids, read, signal);
    };
    try {
      v.stream.setPreview({ x: 0, y: 0, z: 0 });
      const deadline = performance.now() + 5000;
      while (!stalled && performance.now() < deadline) {
        v.stream.pump(2);
        await tick();
      }
      expect(stalled).toBe(true);
      expect(v.physics.size).toBe(0);
      v.stream.setArea({ x: 0, y: 0, z: 0 });
      await until(v.stream);
      expect(v.physics.size).toBeGreaterThan(0);
      expect(v.stream.problem).toBeUndefined();
    } finally {
      v.stream.dispose();
    }
    expect(v.pins()).toBe(0);
  });
  it('defers distant scene allocations while a critical cell is still preparing', async () => {
    const v = fixture();
    const prepare = v.graphics.prepareCellAssets;
    let first = true,
      release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    v.graphics.prepareCellAssets = async (m, ids, read, signal) => {
      if (first) {
        first = false;
        await gate;
      }
      return prepare(m, ids, read, signal);
    };
    try {
      v.stream.setArea({ x: 0, y: 0, z: 0 });
      v.stream.setVisualArea({ x: 0, y: 0, z: 0 }, 3000);
      for (let n = 0; n < 300; n++) {
        v.stream.pump(2);
        await tick();
      }
      expect(v.stream.criticalReady).toBe(false);
      const d = v.stream.diagnostics();
      expect(
        d.cells
          .filter((cell) => !d.required.includes(cell.id))
          .every((cell) => cell.references === 0),
      ).toBe(true);
      release();
      await until(v.stream, () => v.stream.backgroundReady);
    } finally {
      release();
      v.stream.dispose();
    }
  });
  it('critical preparation succeeds despite a stalled distant model and ready circle hides its holes', async () => {
    const v = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prepare = v.graphics.prepareCellAssets;
    v.graphics.prepareCellAssets = async (m, ids, read, signal) => {
      if (ids.includes('house-remote-a')) await gate;
      return prepare(m, ids, read, signal);
    };
    try {
      v.stream.setArea({ x: 0, y: 0, z: 0 });
      v.stream.setVisualArea({ x: 0, y: 0, z: 0 }, 3000);
      await until(v.stream);
      expect(v.stream.criticalReady).toBe(true);
      expect(v.stream.backgroundReady).toBe(false);
      expect(v.stream.graphicsReadyRadius({ x: 0, y: 0, z: 0 }, 3000)).toBeLessThan(3000);
      release();
      await until(v.stream, () => v.stream.backgroundReady);
    } finally {
      release();
      v.stream.dispose();
    }
  });
  it('holds shared seam instances once per cell and releases history after leaving both circles', async () => {
    const v = fixture();
    const start = { x: -125, y: 0, z: -312.5 },
      far = { x: 950, y: 0, z: 950 };
    try {
      v.stream.setArea(start);
      await until(v.stream, () => v.stream.backgroundReady);
      expect(v.physics.get('house-6-5-0')).toBe(2);
      v.stream.setArea(far, far, ['6_5']);
      await until(v.stream, () => v.stream.backgroundReady);
      v.advance();
      expect(v.physics.get('house-6-5-0')).toBe(1);
      v.stream.setArea(far);
      v.advance();
      expect(v.physics.has('house-6-5-0')).toBe(false);
      expect(v.graphical.has('house-6-5-0')).toBe(false);
    } finally {
      v.stream.dispose();
    }
  });
  it('keeps static preview without colliders or game readiness and reuses it on join/leave', async () => {
    const v = fixture();
    const p = { x: 0, y: 0, z: 0 };
    try {
      v.stream.setPreview(p);
      await until(v.stream, () => v.stream.backgroundReady);
      expect(v.physics.size).toBe(0);
      expect(v.graphical.size).toBeGreaterThan(0);
      expect(v.stream.criticalReady).toBe(false);
      expect(v.reads.some((path) => path.endsWith('/colliders.json'))).toBe(false);
      expect(v.stream.diagnostics().parsedCollisionBytes).toBe(0);
      const models = v.graphical.size;
      const reads = v.reads.length;
      v.stream.setArea(p);
      await until(v.stream, () => v.stream.backgroundReady);
      expect(v.physics.size).toBeGreaterThan(0);
      expect(v.graphical.size).toBe(models);
      expect(v.reads.slice(reads).length).toBeGreaterThan(0);
      expect(v.reads.slice(reads).every((path) => path.endsWith('/colliders.json'))).toBe(true);
      v.stream.setPreview(p);
      v.advance();
      await until(v.stream, () => v.stream.diagnostics().parsedCollisionBytes === 0);
      expect(v.physics.size).toBe(0);
      expect(v.graphical.size).toBe(models);
    } finally {
      v.stream.dispose();
    }
  });
  it('releases abandoned gameplay physics ahead of a large preview graphics queue', async () => {
    const v = fixture(0.1);
    const far = { x: 950, y: 0, z: 950 };
    try {
      v.stream.setArea(far);
      await until(v.stream, () => v.stream.backgroundReady);
      expect(v.physics.size).toBeGreaterThan(0);
      v.stream.setPreview({ x: -950, y: 0, z: -950 }, 3000);
      // Prepare the whole graphics queue without pumping connections. In production this is
      // a late GLB completing after leave while the preview keeps the same cell alive.
      const deadline = performance.now() + 10000;
      while (v.stream.diagnostics().requested.length && performance.now() < deadline) await tick();
      expect(v.stream.diagnostics().requested).toHaveLength(0);
      expect(v.stream.backgroundReady).toBe(false);
      v.advance(2);
      for (let frame = 0; frame < 50 && v.physics.size; frame++) v.stream.pump(2);
      expect(v.physics.size).toBe(0);
      expect(v.stream.diagnostics().physicsActive).toHaveLength(0);
      expect(v.stream.backgroundReady).toBe(false);
      expect(v.stream.diagnostics().graphicsRequired).toHaveLength(256);
      await until(v.stream, () => v.stream.backgroundReady);
      expect(v.graphical.size).toBeGreaterThan(0);
      expect(v.physics.size).toBe(0);
    } finally {
      v.stream.dispose();
    }
  });
  it('aborts late preparations without activating old models and exposes retryable critical errors', async () => {
    const v = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prepare = v.graphics.prepareCellAssets;
    v.graphics.prepareCellAssets = async (...args) => {
      await gate;
      return prepare(...args);
    };
    v.stream.setArea({ x: -950, y: 0, z: -950 });
    await tick();
    v.stream.dispose();
    release();
    await tick();
    expect(v.physics.size).toBe(0);
    expect(v.graphical.size).toBe(0);
    const failed = fixture();
    failed.graphics.retainStatic = () => {
      throw new Error('GPU allocation failed');
    };
    try {
      failed.stream.setArea({ x: -950, y: 0, z: -950 });
      await until(failed.stream, () => !!failed.stream.problem);
      expect(failed.stream.criticalReady).toBe(false);
      failed.graphics.retainStatic = () => {};
      failed.graphics.releaseStatic = () => {};
      failed.stream.retry();
      await until(failed.stream);
    } finally {
      failed.stream.dispose();
    }
    expect(failed.physics.size).toBe(0);
  });
});
