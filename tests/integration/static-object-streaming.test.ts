import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadWorldCell,
  loadCellPhysics,
  WORLD_RESOURCE_LIMITS,
  type BuildingInstance,
  type StaticEntityDefinition,
  type WorldManifest,
} from '../../packages/contracts/src/index.js';
import { buildWorld } from '../../tools/world-build/src/index.js';
import { CellStreamer, STREAMING_LIMITS } from '../../apps/client/src/streaming/cells.js';
import { VerifiedResources } from '../../apps/client/src/streaming/resources.js';
import { selectedExtractionAreas, type AreaStep } from '../helpers/static-extraction-areas.js';

let directory: string;
let manifest: WorldManifest;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'su-extracted-streaming-'));
  manifest = await buildWorld('content/worlds/ring-block/world.json', directory, {
    terrainRelease: false,
  });
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function until(stream: CellStreamer, predicate: () => boolean) {
  const deadline = performance.now() + 15_000;
  while (performance.now() < deadline) {
    stream.pump(2);
    if (predicate()) return;
    if (stream.backgroundProblem) throw new Error(stream.backgroundProblem);
    await tick();
  }
  throw new Error(JSON.stringify(stream.diagnostics()));
}

describe('extracted ring-block content budgets', () => {
  it('preserves historical wanted sets at seven sites, wide camera and a returning diagonal route', async () => {
    const baseline = JSON.parse(
      await readFile('tests/fixtures/static-extraction/baseline.json', 'utf8'),
    );
    const areas = JSON.parse(await readFile('tests/fixtures/static-extraction/areas.json', 'utf8'));
    expect(areas.baselineMapVersion).toBe(baseline.mapVersion);
    expect(manifest.grid).toEqual(areas.grid);
    expect(manifest.bounds).toEqual(areas.bounds);
    for (const { name: _name, ...expected } of areas.controls) {
      expect(
        selectedExtractionAreas(manifest, [
          { position: expected.position, drawRadius: expected.drawRadius },
        ]),
      ).toEqual([expected]);
    }
    expect(
      selectedExtractionAreas(
        manifest,
        areas.route.map(({ position, drawRadius }: AreaStep) => ({ position, drawRadius })),
      ),
    ).toEqual(areas.route);
  });

  it('prepares real city dependencies within the existing HTTP, queue, cell and unique-object budgets', async () => {
    const cells = await Promise.all(
      manifest.cells.map((cell) =>
        loadWorldCell(manifest, cell.cellId, (path) => readFile(join(directory, path))),
      ),
    );
    const unique = new Set(
      cells.flatMap((cell) => [...cell.statics, ...cell.buildings].map((item) => item.entityId)),
    );
    expect(unique.size).toBeLessThanOrEqual(STREAMING_LIMITS.staticEntities);
    expect(unique.size).toBeGreaterThan(1500);
    for (const cell of manifest.cells)
      expect((await readFile(join(directory, cell.file))).byteLength).toBeLessThanOrEqual(
        WORLD_RESOURCE_LIMITS.cellBytes,
      );
    class MeasuredResources extends VerifiedResources {
      peakPending = 0;
      override read(...args: Parameters<VerifiedResources['read']>) {
        const promise = super.read(...args);
        this.peakPending = Math.max(this.peakPending, this.diagnostics().pending);
        return promise;
      }
    }
    const resources = new MeasuredResources(manifest, '/', {
      fetch: async (url) => {
        await tick();
        return new Response(await readFile(join(directory, String(url).slice(1))));
      },
    });
    // Deliberately prepare the four heaviest dependency lists together, including
    // simultaneous model/parts reads. Shared collision dependencies remain one job.
    const heaviest = [...manifest.cells]
      .sort((a, b) => b.assetIds.length - a.assetIds.length)
      .slice(0, 4);
    const stress = new MeasuredResources(manifest, '/', {
      fetch: async (url) => {
        await tick();
        return new Response(await readFile(join(directory, String(url).slice(1))));
      },
    });
    try {
      await Promise.all(
        heaviest.flatMap((cell) => [
          loadCellPhysics(manifest, cell.cellId, (path) => stress.read(path)),
          ...cell.assetIds
            .slice(0, 1)
            .flatMap((id) => [
              ...(manifest.assets[id].modelFile
                ? [stress.read(manifest.assets[id].modelFile!)]
                : []),
              stress.read(manifest.assets[id].partsFile),
            ]),
        ]),
      );
      expect(stress.peakPending).toBeLessThanOrEqual(512);
      expect(stress.diagnostics().httpPeak).toBeLessThanOrEqual(4);
    } finally {
      stress.dispose();
    }
    const physics = new Map<string, number>(),
      graphics = new Map<string, number>();
    const add = (map: Map<string, number>, item: BuildingInstance | StaticEntityDefinition) =>
      map.set(item.entityId, (map.get(item.entityId) ?? 0) + 1);
    const remove = (map: Map<string, number>, id: string) => {
      const count = map.get(id);
      if (!count) throw new Error(`Unowned object: ${id}`);
      if (count === 1) map.delete(id);
      else map.set(id, count - 1);
    };
    let pins = 0;
    const stream = new CellStreamer(
      manifest,
      resources,
      {
        retainStatic: (item) => {
          add(physics, item);
        },
        releaseStatic: (id) => remove(physics, id),
      },
      {
        // Match production BuildingViews.prepareAssets scheduling, using real immutable
        // bytes. Babylon/Havok allocation is exercised by static-object-lifecycle.test.ts.
        prepareCellAssets: async (world, ids, read, signal) => {
          for (const id of new Set(ids)) {
            if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
            const asset = world.assets[id];
            await Promise.all([
              ...(asset.modelFile ? [read(asset.modelFile, signal)] : []),
              read(asset.partsFile, signal),
            ]);
          }
          pins++;
          return () => {
            pins--;
          };
        },
        retainStatic: (item) => {
          add(graphics, item);
        },
        releaseStatic: (id) => remove(graphics, id),
      },
    );
    const center = {
      x: (manifest.bounds.min.x + manifest.bounds.max.x) / 2,
      y: 1,
      z: (manifest.bounds.min.z + manifest.bounds.max.z) / 2,
    };
    try {
      stream.setPreview(center, 30 * 125);
      await until(stream, () => stream.backgroundReady);
      expect(physics.size).toBe(0);
      expect(graphics.size).toBe(unique.size);
      expect(stream.diagnostics().entities).toBe(unique.size);
      stream.setArea(center);
      await until(stream, () => stream.backgroundReady);
      expect(stream.criticalReady).toBe(true);
      expect(physics.size).toBeGreaterThan(0);
      expect(resources.peakPending).toBeLessThanOrEqual(512);
      expect(resources.diagnostics()).toMatchObject({ pending: 0 });
      expect(resources.diagnostics().httpPeak).toBeLessThanOrEqual(4);
      expect(stream.backgroundProblem).toBeUndefined();
      if (process.env.SU_STATIC_STREAMING_PROFILE === '1')
        console.info(
          JSON.stringify({
            objects: unique.size,
            models: Object.keys(manifest.assets).length,
            maxCellBytes: Math.max(
              ...(await Promise.all(
                manifest.cells.map(
                  async (cell) => (await readFile(join(directory, cell.file))).byteLength,
                ),
              )),
            ),
            maxDependencies: heaviest[0].assetIds.length,
            stressQueuePeak: stress.peakPending,
            previewQueuePeak: resources.peakPending,
            httpPeak: resources.diagnostics().httpPeak,
            activeCells: stream.diagnostics().active.length,
            references: stream.diagnostics().references,
            lruBytes: resources.diagnostics().cacheBytes,
          }),
        );
    } finally {
      stream.dispose();
    }
    expect(physics.size).toBe(0);
    expect(graphics.size).toBe(0);
    expect(pins).toBe(0);
    expect(resources.diagnostics()).toMatchObject({ pending: 0, cacheBytes: 0 });
  });
});
