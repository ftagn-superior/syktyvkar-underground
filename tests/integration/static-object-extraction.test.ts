import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { buildWorld, WORLDS } from '../../tools/world-build/src/index.js';
import { encodeStaticGlb } from '../../tools/world-build/src/glb.js';
import { generateKit } from '../../tools/world-build/src/kit.js';
import { mergeParts } from '../../tools/world-build/src/merge.js';
import { canonicalJson } from '../../packages/contracts/src/index.js';
import {
  readAuthoringRelease,
  createLayoutPublication,
} from '../../apps/server/src/layout/release.js';
import {
  compareColliders,
  compareTriangles,
  extractionFixture,
  glbTriangles,
  json,
  oldExtractionWorld,
  readRelease,
  releaseTriangles,
  sha256,
  worldColliders,
} from '../helpers/static-extraction.js';

const plantingCategories = new Set(['tree', 'bush']);
const artFixture = 'tests/fixtures/art-refresh/authoring-invariants.json';
const minimumAmbientFactor = 0.7;

// Compare the original authoring structure, not newly generated visual hashes. The
// allowances below are exactly the sunny-city refresh: palette, parapet caps,
// sub-5 cm ground separation and planting topology inside the old envelopes.
function visualInvariant(recipe: any, path: string): unknown {
  const copy = structuredClone(recipe);
  if (path.endsWith('/ring-block-ground/source.json'))
    for (const layer of copy.layers) delete layer.elevation;
  if (path.endsWith('/manual/trudovaya-slava/source.json'))
    copy.parts = copy.parts.filter(
      (part: any) => !['shrubs', 'flowers-ivory', 'flowers-rose'].includes(part.id),
    );
  if (path.includes('/objects/bush-'))
    for (const part of copy.parts)
      part.shapes = part.shapes.map((shape: any) => {
        const plant = shape.foliage ?? shape.cone;
        return {
          plantEnvelope: {
            center: plant.center,
            radius: plant.radius ?? plant.radiusBottom,
            height: plant.height,
          },
        };
      });
  const scrub = (value: any): any =>
    Array.isArray(value)
      ? value.map(scrub)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value)
              .filter(
                ([key, item]) =>
                  key !== 'copingColor' &&
                  !(key === 'foliage' && typeof item === 'string') &&
                  !(typeof item === 'string' && /^#[a-f0-9]{6}$/i.test(item)),
              )
              .map(([key, item]) => [key, scrub(item)]),
          )
        : value;
  return scrub(copy);
}

describe('independent static-object extraction evidence', () => {
  let temporary: string;
  let release: Awaited<ReturnType<typeof readRelease>>;
  let baseline: any;
  let registry: any;
  let art: any;
  beforeAll(async () => {
    temporary = await mkdtemp(join(tmpdir(), 'su-extraction-proof-'));
    baseline = await json(`${extractionFixture}/baseline.json`);
    registry = await json('content/worlds/ring-block/extraction.json');
    art = await json(artFixture);
    await buildWorld('content/worlds/ring-block/world.json', join(temporary, 'release'));
    release = await readRelease(join(temporary, 'release'));
  });
  afterAll(async () => {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  });

  it('publishes and republishes all 829 trees without GLBs or changes to placement and physics', async () => {
    const authored = await readAuthoringRelease(join(temporary, 'release'));
    const { publication } = await createLayoutPublication(authored, {
      formatVersion: 1,
      worldId: authored.definition.worldId,
      assetReleaseVersion: authored.metadata.assetReleaseVersion,
      seedVersion: authored.metadata.seedVersion,
      revision: 1,
      instances: authored.seed,
    });
    expect(publication.manifest).toEqual(release.manifest);
    const trees = Object.values(publication.manifest.assets).filter((asset) =>
      asset.assetId.startsWith('tree-'),
    );
    expect(trees).toHaveLength(829);
    for (const tree of trees) {
      expect(tree.modelFile).toBeUndefined();
      expect(
        JSON.parse(new TextDecoder().decode(publication.payloads.get(tree.partsFile))).tree
          .formatVersion,
      ).toBe(2);
    }
    expect(
      Object.keys(publication.manifest.files).filter((path) => path.endsWith('.glb')),
    ).toHaveLength(886);
  });

  it('preserves every non-planting triangle, winding and fade, allowing only bounded neutral AO', async () => {
    for (const [path, hash] of Object.entries(baseline.fixtureHashes))
      expect(sha256(await readFile(`${extractionFixture}/${path}`))).toBe(hash);
    expect(registry.baseline.id).toBe(baseline.mapVersion);
    expect(registry.baseline.fixtureSha256).toBe(
      sha256(await readFile(`${extractionFixture}/baseline.json`)),
    );
    const before = JSON.parse(
      gunzipSync(await readFile(`${extractionFixture}/triangles.json.gz`)).toString(),
    );
    // The immutable pre-extraction triangle stream has no object IDs. Its six
    // planting colors are disjoint from every retained category; exact counts
    // below prevent accidentally discarding any additional historical geometry.
    const plantingColors = art.originalVegetationColors.map((hex: string) =>
      [1, 3, 5].map((offset) => {
        const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      }),
    );
    const isOldPlanting = (triangle: any) =>
      plantingColors.some((color: number[]) =>
        triangle.vertices.every((vertex: number[]) =>
          color.every((channel, i) => Math.abs(channel - vertex[i + 3]) < 1e-6),
        ),
      );
    expect(before).toHaveLength(99_484);
    expect(before.filter(isOldPlanting)).toHaveLength(art.originalVegetationTriangles);
    const ids = new Set(
      registry.objects
        .filter((o: any) => o.status === 'extracted' && !plantingCategories.has(o.category))
        .map((o: any) => o.entityId),
    );
    const after = await releaseTriangles(
      join(temporary, 'release'),
      release.manifest,
      release.world.buildings.filter((b) => ids.has(b.entityId)),
    );
    const result = compareTriangles(
      before.filter((triangle: any) => !isOldPlanting(triangle)),
      after,
      0.001,
      minimumAmbientFactor,
    );
    expect(result.triangles).toBe(art.unchangedTriangles);
    expect(result.maxVertexDelta).toBeLessThan(0.001);
    expect(result.minColorFactor).toBeGreaterThanOrEqual(minimumAmbientFactor);
    expect(result.shadedVertices).toBeGreaterThan(0);
  });

  it('confines refreshed planting to original envelopes, fade groups and collider recipes', async () => {
    const planting = registry.objects.filter(
      (object: any) => object.status === 'extracted' && plantingCategories.has(object.category),
    );
    expect(planting.filter((object: any) => object.category === 'tree')).toHaveLength(829);
    expect(planting.filter((object: any) => object.category === 'bush')).toHaveLength(277);
    const recipes: [string, unknown][] = [];
    for (const id of [
      ...new Set(planting.map((object: any) => object.assetId)),
    ].sort() as string[]) {
      const path = `content/buildings/ring-block/objects/${id}/source.json`;
      const recipe = await json(path);
      recipes.push([path, visualInvariant(recipe, path)]);
      const descriptor = release.manifest.assets[id];
      const triangles = glbTriangles(
        descriptor.modelFile
          ? await readFile(join(temporary, 'release', descriptor.modelFile))
          : encodeStaticGlb(generateKit(id, recipe).parts),
        {
          assetId: id,
          entityId: id,
          position: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
        },
      );
      const tree = id.startsWith('tree-');
      expect(new Set(triangles.map((triangle) => triangle.fade))).toEqual(new Set([tree]));
      const crowns = tree
        ? recipe.parts
            .find((part: any) => part.id.startsWith('crown-'))
            .shapes.map((shape: any) => shape.cone)
        : recipe.parts[0].shapes.map((shape: any) => shape.foliage);
      const radius = Math.max(
        ...crowns.map((c: any) => c.radius ?? Math.max(c.radiusBottom, c.radiusTop)),
      );
      const top = Math.max(...crowns.map((c: any) => c.center[1] + c.height));
      const bottom = Math.min(
        ...crowns.map((c: any) => c.center[1]),
        ...recipe.parts.flatMap((part: any) =>
          part.shapes.flatMap((shape: any) =>
            shape.box ? [shape.box.center[1] - shape.box.size[1] / 2] : [],
          ),
        ),
      );
      for (const triangle of triangles)
        for (const [x, y, z] of triangle.vertices) {
          expect(Math.max(Math.abs(x), Math.abs(z)), id).toBeLessThanOrEqual(radius + 1e-5);
          expect(y, id).toBeGreaterThanOrEqual(bottom - 1e-5);
          expect(y, id).toBeLessThanOrEqual(top + 1e-5);
        }
    }
    // This original structure hash also includes every collider, source pivot,
    // trunk, crown envelope and fade flag; only the permitted art fields differ.
    expect(recipes).toHaveLength(art.vegetationAssets);
    expect(sha256(canonicalJson(recipes))).toBe(art.vegetationGeometryHash);
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

  it('preserves world layout and all sources outside the explicit art-refresh allowlist', async () => {
    const current = new Map(release.world.buildings.map((b) => [b.entityId, b]));
    const catalog = await json('content/buildings/ring-block/catalog.json');
    const checkedAmbientAssets = new Set<string>();
    const refreshedAssets = new Set<string>(
      Object.keys(art.sourceGeometryHashes).map((path) => path.split('/').at(-2)!),
    );
    for (const { instance, asset } of baseline.preserved) {
      expect(current.get(instance.entityId)).toEqual(instance);
      const ground = instance.assetId.startsWith('ring-block-ground-');
      const updated = release.manifest.assets[instance.assetId];
      if (!ground && !refreshedAssets.has(instance.assetId)) {
        expect(updated.assetId).toBe(asset.assetId);
        expect(updated.bounds).toEqual(asset.bounds);
        if (!checkedAmbientAssets.has(instance.assetId)) {
          // These sources did not receive the palette/geometry refresh. Prove
          // their unbaked GLB still matches the immutable historical hash, then
          // permit only neutral vertex darkening in the released model.
          const descriptorPath = join(
            'content/buildings/ring-block',
            catalog.assets[instance.assetId],
          );
          const descriptor = await json(descriptorPath);
          expect(descriptor.source.kind).toBe('kit');
          const recipe = await json(join(dirname(descriptorPath), descriptor.source.file));
          const unmerged = generateKit(instance.assetId, { ...recipe, merge: false }).parts;
          // These five unchanged recipes use uniform authored part colors.
          // Removing only baked COLOR_0 must recover the exact old GLB bytes.
          const unshaded = unmerged.map(({ colors: _ao, ...part }) => part);
          const original = encodeStaticGlb(recipe.merge ? mergeParts(unshaded) : unshaded);
          const historicalHash = (path: string) =>
            baseline.resources.find((resource: any) => resource.path === path).hash;
          expect(sha256(original)).toBe(historicalHash(asset.modelFile));
          for (const field of ['collisionFile', 'partsFile'] as const)
            expect(sha256(await readFile(join(temporary, 'release', updated[field])))).toBe(
              historicalHash(asset[field]),
            );
          const currentModel = await readFile(join(temporary, 'release', updated.modelFile!));
          compareTriangles(
            glbTriangles(original, instance),
            glbTriangles(currentModel, instance),
            0.001,
            minimumAmbientFactor,
          );
          checkedAmbientAssets.add(instance.assetId);
        }
      } else {
        expect(updated.assetId).toBe(asset.assetId);
        if (!ground) expect(updated.bounds).toEqual(asset.bounds);
        else {
          expect(updated.bounds.min).toEqual(asset.bounds.min);
          expect(updated.bounds.max.x).toBe(asset.bounds.max.x);
          expect(updated.bounds.max.z).toBe(asset.bounds.max.z);
          expect(updated.bounds.max.y).toBeLessThan(0.05);
        }
      }
    }
    expect(checkedAmbientAssets.size).toBe(5);
    const unchanged = Object.entries(baseline.sourceHashes).filter(
      ([path]) =>
        !path.includes('/details-') &&
        !path.endsWith('/import.json') &&
        !path.endsWith('/catalog.json') &&
        !path.endsWith('/cells/0_0.json'),
    );
    expect(Object.keys(art.sourceGeometryHashes)).toHaveLength(138);
    for (const [path, hash] of unchanged) {
      if (Object.hasOwn(art.sourceGeometryHashes, path))
        expect(sha256(canonicalJson(visualInvariant(await json(path), path))), path).toBe(
          art.sourceGeometryHashes[path],
        );
      else if (path === 'content/worlds/ring-block/world.json') {
        const source = await readFile(path, 'utf8');
        expect(JSON.parse(source).formatVersion).toBe(5);
        expect(sha256(source.replace('"formatVersion": 5', '"formatVersion": 4'))).toBe(hash);
      } else expect(sha256(await readFile(path)), path).toBe(hash);
    }
    const ground = await json('content/buildings/ring-block/ring-block-ground/source.json');
    const heights = ground.layers.map((layer: any) => layer.elevation);
    expect(heights).toHaveLength(10);
    for (let index = 0; index < heights.length; index++) {
      expect(heights[index]).toBeGreaterThan(index ? heights[index - 1] : 0);
      expect(heights[index]).toBeLessThan(0.05);
    }
    const old = await oldExtractionWorld();
    const { buildings: _ob, buildingAssets: _oa, ...oldRest } = old;
    const { buildings: _nb, buildingAssets: _na, ...newRest } = release.world;
    expect(newRest).toEqual({ ...oldRest, formatVersion: 5 });
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

describe('static triangle color evidence', () => {
  it('reads the product of material and vertex colors from glTF', () => {
    const bytes = encodeStaticGlb([
      {
        partId: 'colored-triangle',
        role: 'detail',
        occlusionGroup: null,
        color: '#808040',
        positions: [0, 0, 0, 1, 0, 0, 0, 0, 1],
        normals: [0, 1, 0, 0, 1, 0, 0, 1, 0],
        indices: [0, 2, 1],
        colors: [0.8, 0.7, 0.6, 0.8, 0.7, 0.6, 0.8, 0.7, 0.6],
      },
    ]);
    const [triangle] = glbTriangles(bytes, {
      assetId: 'test',
      entityId: 'test',
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
    });
    const material = [128, 128, 64].map((channel) => ((channel / 255 + 0.055) / 1.055) ** 2.4);
    for (const vertex of triangle.vertices)
      for (let channel = 0; channel < 3; channel++)
        expect(vertex[channel + 3]).toBeCloseTo(material[channel] * [0.8, 0.7, 0.6][channel], 7);
  });

  it('allows neutral AO while rejecting palette, brightness, geometry and fade changes', () => {
    const original = {
      role: 'detail',
      fade: false,
      vertices: [
        [0, 0, 0, 0.4, 0.2, 0.1],
        [1, 0, 0, 0.4, 0.2, 0.1],
        [0, 0, 1, 0.4, 0.2, 0.1],
      ],
    };
    const tint = (factors: number[]) => ({
      ...original,
      vertices: original.vertices.map((v) => [
        ...v.slice(0, 3),
        ...v.slice(3).map((channel, c) => channel * factors[c]),
      ]),
    });
    const shaded = tint([0.8, 0.8, 0.8]);
    const compare = (triangle: typeof original) =>
      compareTriangles([original], [triangle], 0.001, minimumAmbientFactor);
    expect(compare(shaded).minColorFactor).toBeCloseTo(0.8);
    expect(compare(shaded).shadedVertices).toBe(3);
    for (const changed of [
      tint([0.8, 0.7, 0.8]),
      tint([0.6, 0.6, 0.6]),
      tint([1.1, 1.1, 1.1]),
      { ...shaded, fade: true },
      { ...shaded, role: 'roof' },
      { ...shaded, vertices: [...shaded.vertices].reverse() },
      {
        ...shaded,
        vertices: shaded.vertices.map((vertex) => [vertex[0] + 0.01, ...vertex.slice(1)]),
      },
    ])
      expect(() => compare(changed)).toThrow();
    // Callers that do not opt into AO still require exact original colors.
    expect(() => compareTriangles([original], [shaded])).toThrow();
  });
});
