import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { buildWorld, WORLDS } from '../../tools/world-build/src/index.js';
import {
  compareColliders,
  compareTriangles,
  extractionFixture,
  json,
  oldExtractionWorld,
  readRelease,
  releaseTriangles,
  sha256,
  worldColliders,
} from '../helpers/static-extraction.js';

describe('independent static-object extraction evidence', () => {
  let temporary: string;
  let release: Awaited<ReturnType<typeof readRelease>>;
  let baseline: any;
  let registry: any;
  beforeAll(async () => {
    temporary = await mkdtemp(join(tmpdir(), 'su-extraction-proof-'));
    baseline = await json(`${extractionFixture}/baseline.json`);
    registry = await json('content/worlds/ring-block/extraction.json');
    await buildWorld('content/worlds/ring-block/world.json', join(temporary, 'release'));
    release = await readRelease(join(temporary, 'release'));
  });
  afterAll(async () => {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  });

  it('preserves every released triangle, winding, color and fade within 1 mm', async () => {
    for (const [path, hash] of Object.entries(baseline.fixtureHashes))
      expect(sha256(await readFile(`${extractionFixture}/${path}`))).toBe(hash);
    expect(registry.baseline.id).toBe(baseline.mapVersion);
    expect(registry.baseline.fixtureSha256).toBe(
      sha256(await readFile(`${extractionFixture}/baseline.json`)),
    );
    const before = JSON.parse(
      gunzipSync(await readFile(`${extractionFixture}/triangles.json.gz`)).toString(),
    );
    const ids = new Set(
      registry.objects.filter((o: any) => o.status === 'extracted').map((o: any) => o.entityId),
    );
    const after = await releaseTriangles(
      join(temporary, 'release'),
      release.manifest,
      release.world.buildings.filter((b) => ids.has(b.entityId)),
    );
    const result = compareTriangles(before, after);
    expect(result.triangles).toBe(99_484);
    expect(result.maxVertexDelta).toBeLessThan(0.001);
  });

  it('preserves all physical shapes, materials and world transforms independently of body IDs', async () => {
    const old = await oldExtractionWorld();
    const result = compareColliders(worldColliders(old), worldColliders(release.world));
    expect(result.colliders).toBe(1888);
    expect(result.maxNumericDelta).toBeLessThan(1e-6);
    expect(result.maxRotationRadians).toBeLessThan(1e-6);
    expect(release.world.entities).toEqual(old.entities);
    expect(release.manifest.simulationConfigHash).not.toBe(baseline.simulationConfigHash);
  });

  it('keeps ground tiles, houses, manual instances and the rest of the world byte-identical', async () => {
    const current = new Map(release.world.buildings.map((b) => [b.entityId, b]));
    for (const { instance, asset } of baseline.preserved) {
      expect(current.get(instance.entityId)).toEqual(instance);
      expect(release.manifest.assets[instance.assetId]).toEqual(asset);
    }
    const unchanged = Object.entries(baseline.sourceHashes).filter(
      ([path]) =>
        !path.includes('/details-') &&
        !path.endsWith('/import.json') &&
        !path.endsWith('/catalog.json') &&
        !path.endsWith('/cells/0_0.json'),
    );
    for (const [path, hash] of unchanged) expect(sha256(await readFile(path))).toBe(hash);
    const old = await oldExtractionWorld();
    const { buildings: _ob, buildingAssets: _oa, ...oldRest } = old;
    const { buildings: _nb, buildingAssets: _na, ...newRest } = release.world;
    expect(newRest).toEqual(oldRest);
    expect(release.manifest.grid).toEqual(baseline.grid);
    expect(release.manifest.cells.map(({ cellId, bounds }) => ({ cellId, bounds }))).toEqual(
      baseline.cells.map(({ cellId, bounds }: any) => ({ cellId, bounds })),
    );
    expect(
      baseline.preserved.filter((p: any) => p.instance.assetId.startsWith('ring-block-ground-')),
    ).toHaveLength(40);
  });

  it('assigns every old primitive and collider to exactly one whole object and shares identical models', async () => {
    const actualShapes: string[] = [],
      actualColliders: string[] = [];
    const extracted = registry.objects.filter((o: any) => o.status === 'extracted');
    for (const object of extracted) {
      for (const part of object.previous.parts)
        for (const index of part.shapeIndices)
          actualShapes.push(`${object.previous.entityId}:${part.partId}:${index}`);
      for (const id of object.previous.colliderIds)
        actualColliders.push(`${object.previous.entityId}:${id}`);
    }
    const expectedShapes: string[] = [],
      expectedColliders: string[] = [];
    for (const [id, recipe] of Object.entries(baseline.ownership) as [string, any][]) {
      for (const [part, count] of Object.entries(recipe.parts) as [string, number][])
        for (let i = 0; i < count; i++) expectedShapes.push(`${id}:${part}:${i}`);
      for (const c of recipe.colliderIds) expectedColliders.push(`${id}:${c}`);
    }
    expect(actualShapes.sort()).toEqual(expectedShapes.sort());
    expect(actualColliders.sort()).toEqual(expectedColliders.sort());
    expect(new Set(actualShapes).size).toBe(6326);
    expect(new Set(actualColliders).size).toBe(1608);
    expect(new Set(registry.objects.map((o: any) => o.entityId)).size).toBe(
      registry.objects.length,
    );
    expect(new Set(extracted.map((o: any) => o.originKey)).size).toBe(extracted.length);
    expect(
      release.world.buildings.some(
        (b) => b.entityId.startsWith('details-') || b.assetId.startsWith('details-'),
      ),
    ).toBe(false);
    const authored = await json('content/worlds/ring-block/cells/0_0.json');
    const authoredMap = new Map(authored.buildings.map((b: any) => [b.entityId, b.assetId]));
    for (const object of registry.objects)
      expect(authoredMap.get(object.entityId)).toBe(object.assetId);
    expect(
      new Set(
        extracted.filter((o: any) => o.category === 'traffic-light').map((o: any) => o.assetId),
      ).size,
    ).toBe(2);
    const catalog = await json('content/buildings/ring-block/catalog.json');
    expect(Object.keys(catalog.assets).some((id) => id.startsWith('details-'))).toBe(false);
    const recipes = new Map<string, string>();
    for (const id of new Set(extracted.map((o: any) => o.assetId)) as Set<string>) {
      const descriptor = await json(`content/buildings/ring-block/${catalog.assets[id]}`);
      expect(descriptor.source.kind).toBe('kit');
      const path = `content/buildings/ring-block/${catalog.assets[id].replace(/asset\.json$/, descriptor.source.file)}`;
      const hash = sha256(await readFile(path));
      expect(recipes.has(hash), `Duplicate recipe ${id}/${recipes.get(hash)}`).toBe(false);
      recipes.set(hash, id);
    }
  });

  it('builds all three worlds deterministically with no snapshot, import config or prototype', async () => {
    await cp('content', join(temporary, 'content'), { recursive: true });
    await rm(join(temporary, 'content/sources'), { recursive: true, force: true });
    await rm(join(temporary, 'content/worlds/ring-block/import.json'));
    // The evidence registry must also be absent: it is not a second placement source.
    await rm(join(temporary, 'content/worlds/ring-block/extraction.json'));
    for (const id of WORLDS) {
      const first =
        id === 'ring-block'
          ? release.manifest
          : await buildWorld(`content/worlds/${id}/world.json`, join(temporary, `normal-${id}`));
      const isolated = await buildWorld(
        join(temporary, `content/worlds/${id}/world.json`),
        join(temporary, `isolated-${id}`),
      );
      expect(isolated).toEqual(first);
      const repeated = await buildWorld(
        join(temporary, `content/worlds/${id}/world.json`),
        join(temporary, `isolated-${id}`),
      );
      expect(repeated).toEqual(first);
    }
  }, 60_000);
});
