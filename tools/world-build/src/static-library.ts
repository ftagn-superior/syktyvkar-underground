/** One-time, reproducible library preparation from an explicitly preserved legacy directory.
 * The legacy directory contains buildings/, cells/, and map-layout.json. No OSM import is used.
 */
import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  canonicalJson,
  type BuildingAssetManifest,
  type WorldCell,
  type WorldLayoutSnapshot,
} from '@su/contracts';
import {
  hash,
  staticAssetSourceHash,
  staticAssetLibraryHash,
  transformStaticAssets,
  validateStaticAssetRemapRules,
  type StaticAssetRemapRules,
} from '@su/world-release';
import { generateKit, type KitRecipe, type KitShape } from './kit.js';

const selected = (id: string) => /^(tree|bush|bench|lamp|traffic-light|bollard|fence)-/.test(id);
const readJson = async <T>(file: string): Promise<T> => JSON.parse(await readFile(file, 'utf8'));
const writeJson = async (file: string, value: unknown) => {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2) + '\n');
};
const round = (value: number) => Math.round(value * 1e9) / 1e9;
const geometricCenters = (values: number[], count: number) => {
  const min = Math.min(...values),
    max = Math.max(...values);
  return Array.from({ length: count }, (_, i) => round(min * (max / min) ** ((i + 0.5) / count)));
};
function treeHeight(recipe: KitRecipe): number {
  const shape = recipe.parts[0].shapes[1];
  if (!('cone' in shape)) throw new Error('Legacy tree must have two cones');
  return shape.cone.center[1] + shape.cone.height;
}
function canonicalSolid(recipe: KitRecipe): KitRecipe {
  const result = structuredClone(recipe);
  for (const part of result.parts) {
    part.fade = false;
    for (const shape of part.shapes) {
      const spec = Object.values(shape)[0] as { center: number[]; yaw?: number };
      spec.center = spec.center.map((v) => Math.round(v * 100) / 100);
      if ('yaw' in spec) spec.yaw = 0;
    }
  }
  for (const collider of result.colliders)
    if ('center' in collider) {
      collider.center = collider.center.map((v) => Math.round(v * 100) / 100) as [
        number,
        number,
        number,
      ];
      collider.yaw = 0;
    }
  return result;
}
function fenceRecipe(length: number): KitRecipe {
  // Half-width boundary posts meet into one full post without coincident visible faces.
  const spans: [number, number][] =
    length === 4
      ? [
          [-length / 2 + 0.06, -0.06],
          [0.06, length / 2 - 0.06],
        ]
      : [[-length / 2 + 0.06, length / 2 - 0.06]];
  const shapes: KitShape[] = spans.flatMap(([a, b]) =>
    [0.72, 1.56].map((y) => ({
      box: {
        center: [(a + b) / 2, y, 0] as [number, number, number],
        size: [b - a, 0.08, 0.12] as [number, number, number],
      },
    })),
  );
  for (const side of [-1, 1])
    shapes.push({ box: { center: [side * (length / 2 - 0.03), 0.8, 0], size: [0.06, 1.6, 0.12] } });
  if (length === 4) shapes.push({ box: { center: [0, 0.8, 0], size: [0.12, 1.6, 0.12] } });
  return {
    formatVersion: 1,
    parts: [{ id: 'fence', role: 'detail', fade: false, color: '#3d4248', shapes }],
    colliders: [{ id: 'c0', center: [0, 0.8, 0], size: [length, 1.6, 0.12], yaw: 0 }],
    merge: false,
  };
}
export async function prepareStaticLibrary(legacyRoot: string, outputRoot: string) {
  const buildings = resolve(legacyRoot, 'buildings');
  const catalog = await readJson<{ formatVersion: 1; assets: Record<string, string> }>(
    resolve(buildings, 'catalog.json'),
  );
  const snapshot = await readJson<WorldLayoutSnapshot>(resolve(legacyRoot, 'map-layout.json'));
  const recipes = new Map<string, KitRecipe>();
  for (const [assetId, file] of Object.entries(catalog.assets))
    if (selected(assetId)) {
      const descriptor = await readJson<{ source: { kind: string; file: string } }>(
        resolve(buildings, file),
      );
      if (descriptor.source.kind !== 'kit') throw new Error(`Expected kit ${assetId}`);
      recipes.set(
        assetId,
        await readJson<KitRecipe>(resolve(buildings, dirname(file), descriptor.source.file)),
      );
    }
  const targets = new Map<string, KitRecipe>();
  const assetMap: Record<string, string> = {};
  const fences: StaticAssetRemapRules['fences'] = {};
  const vegetation: StaticAssetRemapRules['vegetation'] = {};
  const treeGroups = new Map<string, [string, KitRecipe][]>();
  for (const [id, recipe] of recipes)
    if (id.startsWith('tree-')) {
      const species = recipe.parts[0].id.replace('crown-', '');
      const group = treeGroups.get(species) ?? [];
      group.push([id, recipe]);
      treeGroups.set(species, group);
    }
  for (const [species, group] of treeGroups) {
    const heights = geometricCenters(
      group.map(([, recipe]) => treeHeight(recipe)),
      3,
    );
    for (const [index, height] of heights.entries()) {
      const template = group.reduce((a, b) =>
        Math.abs(Math.log(treeHeight(a[1]) / height)) <
        Math.abs(Math.log(treeHeight(b[1]) / height))
          ? a
          : b,
      )[1];
      const recipe = structuredClone(template),
        scale = height / treeHeight(template);
      for (const part of recipe.parts)
        for (const shape of part.shapes) {
          if ('cone' in shape) {
            shape.cone.center[1] = round(shape.cone.center[1] * scale);
            shape.cone.height = round(shape.cone.height * scale);
            shape.cone.radiusBottom = round(shape.cone.radiusBottom * scale);
            shape.cone.radiusTop = round(shape.cone.radiusTop * scale);
          } else if ('box' in shape) {
            shape.box.center[1] = round(shape.box.center[1] * scale);
            shape.box.size[1] = round(shape.box.size[1] * scale);
            shape.box.yaw = 0;
          }
        }
      for (const collider of recipe.colliders)
        if ('center' in collider) {
          collider.center[1] = round(collider.center[1] * scale);
          collider.size[1] = round(collider.size[1] * scale);
        }
      targets.set(`tree-${species}-${['small', 'medium', 'large'][index]}`, recipe);
    }
    for (const [id, recipe] of group) {
      const index = heights.reduce(
        (best, height, i) =>
          Math.abs(Math.log(treeHeight(recipe) / height)) <
          Math.abs(Math.log(treeHeight(recipe) / heights[best]))
            ? i
            : best,
        0,
      );
      assetMap[id] = `tree-${species}-${['small', 'medium', 'large'][index]}`;
    }
  }
  const bushes = [...recipes].filter(([id]) => id.startsWith('bush-'));
  const planting = (recipe: KitRecipe) => {
    const shape = recipe.parts[0].shapes[0];
    if (!('foliage' in shape)) throw new Error('Expected foliage');
    return shape.foliage;
  };
  const radii = geometricCenters(
    bushes.map(([, r]) => planting(r).radius),
    3,
  );
  const heights = geometricCenters(
    bushes.map(([, r]) => planting(r).height),
    2,
  );
  for (const [ri, radius] of radii.entries())
    for (const [hi, height] of heights.entries()) {
      const recipe = structuredClone(bushes[0][1]);
      Object.assign(planting(recipe), { radius, height });
      for (const collider of recipe.colliders)
        if ('center' in collider) collider.size = [round(radius * 1.2), 1, round(radius * 1.2)];
      targets.set(`bush-${['small', 'medium', 'large'][ri]}-${['low', 'high'][hi]}`, recipe);
    }
  for (const [id, recipe] of bushes) {
    const p = planting(recipe);
    const nearest = (values: number[], value: number) =>
      values.reduce(
        (best, c, i) =>
          Math.abs(Math.log(value / c)) < Math.abs(Math.log(value / values[best])) ? i : best,
        0,
      );
    assetMap[id] =
      `bush-${['small', 'medium', 'large'][nearest(radii, p.radius)]}-${['low', 'high'][nearest(heights, p.height)]}`;
  }
  for (const [id, recipe] of recipes) {
    if (id.startsWith('tree-') || id.startsWith('bush-')) continue;
    if (id.startsWith('fence-')) {
      const collider = recipe.colliders[0];
      if (
        recipe.colliders.length !== 1 ||
        !('center' in collider) ||
        collider.yaw ||
        collider.size[1] !== 1.6 ||
        collider.size[2] !== 0.12
      )
        throw new Error(`Unsupported legacy fence ${id}`);
      fences[id] = {
        length: collider.size[0],
        center: { x: collider.center[0], y: collider.center[1], z: collider.center[2] },
      };
      continue;
    }
    const target = id.startsWith('bench-')
      ? 'bench-0152a250d22ef0a9'
      : id.startsWith('lamp-')
        ? id === 'lamp-five-globe'
          ? id
          : 'lamp-street'
        : id.startsWith('traffic-light-')
          ? 'traffic-light-standard'
          : id;
    assetMap[id] = target;
    if (!targets.has(target)) targets.set(target, canonicalSolid(recipe));
  }
  targets.set('fence-short', fenceRecipe(0.5));
  targets.set('fence-long', fenceRecipe(4));
  for (const [id, target] of Object.entries(assetMap))
    if (id.startsWith('tree-') || id.startsWith('bush-'))
      vegetation[id] = {
        bounds: generateKit(id, recipes.get(id)!).physics.bounds,
        targetBounds: generateKit(target, targets.get(target)!).physics.bounds,
      };
  const rules: StaticAssetRemapRules = {
    formatVersion: 1,
    algorithmVersion: 'static-library-v1',
    worldId: snapshot.worldId,
    sourceAssetReleaseVersion: snapshot.assetReleaseVersion,
    targetAssetReleaseVersion: '0'.repeat(64),
    sourceDescriptionHash: '',
    targetLibraryHash: '0'.repeat(64),
    assetMap,
    fences,
    vegetation,
    fenceCenterOffsets: {
      'fence-2bf39412d4cec870f4d8': -0.025,
    },
    unchangedAssetIds: Object.keys(catalog.assets)
      .filter((id) => !selected(id))
      .sort(),
    sections: {
      short: { assetId: 'fence-short', length: 0.5 },
      long: { assetId: 'fence-long', length: 4 },
    },
    tolerances: { vegetationRelative: 0.1, fenceEndpoint: 0.125 },
  };
  rules.sourceDescriptionHash = staticAssetSourceHash(rules);
  // Enforce the budget against generated vertex bounds, independently of the sizing parameters.
  const transformed = transformStaticAssets(snapshot, rules);
  const newCatalog = structuredClone(catalog);
  for (const id of Object.keys(newCatalog.assets)) if (selected(id)) delete newCatalog.assets[id];
  for (const [assetId, recipe] of targets) {
    const directory = resolve(outputRoot, 'content/buildings/ring-block/objects', assetId);
    await writeJson(resolve(directory, 'asset.json'), {
      formatVersion: 1,
      assetId,
      ...(!assetId.startsWith('tree-') ? { renderMode: 'thin-instance' } : {}),
      source: { kind: 'kit', file: 'source.json' },
    });
    await writeJson(resolve(directory, 'source.json'), recipe);
    newCatalog.assets[assetId] = `objects/${assetId}/asset.json`;
  }
  newCatalog.assets = Object.fromEntries(
    Object.entries(newCatalog.assets).sort(([a], [b]) => a.localeCompare(b, 'en')),
  );
  await writeJson(resolve(outputRoot, 'content/buildings/ring-block/catalog.json'), newCatalog);
  for (const [id, file] of Object.entries(catalog.assets))
    if (selected(id) && !targets.has(id))
      await rm(resolve(outputRoot, 'content/buildings/ring-block', dirname(file)), {
        recursive: true,
        force: true,
      });
  // lamp-five-globe has retained its ID but moved into the canonical objects directory.
  if (catalog.assets['lamp-five-globe']?.startsWith('manual/'))
    await rm(resolve(outputRoot, 'content/buildings/ring-block/manual/lamp-five-globe'), {
      recursive: true,
      force: true,
    });
  for (const file of await readdir(resolve(legacyRoot, 'cells'))) {
    const cell = await readJson<WorldCell>(resolve(legacyRoot, 'cells', file));
    const source: WorldLayoutSnapshot = {
      ...snapshot,
      instances: cell.buildings.map((b) => ({ ...b, instanceRevision: 1, enabled: true })),
    };
    const seed = transformStaticAssets(source, rules);
    cell.buildings = seed.snapshot.instances.map(
      ({ instanceRevision: _revision, enabled: _enabled, ...placement }) => placement,
    );
    await writeJson(resolve(outputRoot, 'content/worlds/ring-block/cells', file), cell);
    await writeJson(resolve(outputRoot, 'output/static-library-v1', `seed-${file}`), seed.report);
  }
  await writeJson(
    resolve(outputRoot, 'content/migrations/ring-block/static-library-v1.json'),
    rules,
  );
  await writeJson(resolve(outputRoot, 'output/static-library-v1/baseline-remap.json'), transformed);
  const fenceInstances = snapshot.instances.filter((i) => Object.hasOwn(fences, i.assetId));
  const pairs = [
    [0.25, 4],
    [0.5, 2],
    [0.5, 4],
    [0.5, 8],
    [0.5, 12],
    [1, 4],
  ].map(([short, long]) => {
    let sections = 0,
      maxEndpointShift = 0;
    for (const instance of fenceInstances) {
      const length = fences[instance.assetId].length;
      const units = Math.max(1, Math.round(length / short));
      sections += Math.floor(units / (long / short)) + (units % (long / short));
      maxEndpointShift = Math.max(maxEndpointShift, Math.abs(units * short - length) / 2);
    }
    return { short, long, sections, maxEndpointShift };
  });
  const vegetationRows = Object.entries(vegetation).map(([assetId, v]) => ({
    assetId,
    target: assetMap[assetId],
    relative: Object.fromEntries(
      (['x', 'y', 'z'] as const).map((axis) => [
        axis,
        (v.targetBounds.max[axis] - v.targetBounds.min[axis]) /
          (v.bounds.max[axis] - v.bounds.min[axis]) -
          1,
      ]),
    ),
  }));
  const summary = {
    algorithmVersion: rules.algorithmVersion,
    sourceSnapshotHash: hash(canonicalJson(snapshot)),
    sourceRevision: snapshot.revision,
    sourceAssetReleaseVersion: snapshot.assetReleaseVersion,
    sourceDescriptionHash: rules.sourceDescriptionHash,
    sourceInstances: snapshot.instances.length,
    targetInstances: transformed.snapshot.instances.length,
    sourceSelectedAssets: recipes.size,
    targetSelectedAssets: targets.size,
    sourceCatalogAssets: Object.keys(catalog.assets).length,
    targetCatalogAssets: Object.keys(newCatalog.assets).length,
    fenceSections: transformed.report.fences.reduce((n, f) => n + f.sections.length, 0),
    fenceCenterOffsets: rules.fenceCenterOffsets,
    maxActualEndpointShift: Math.max(
      ...transformed.report.fences.flatMap((f) => f.endpointShifts.map(Math.abs)),
    ),
    fencePairs: pairs,
    maxVegetationDeviation: Math.max(
      ...vegetationRows.flatMap((r) => Object.values(r.relative).map(Math.abs)),
    ),
    vegetationRows,
    targets: Object.fromEntries(
      [...targets].map(([id, recipe]) => [
        id,
        { bounds: generateKit(id, recipe).physics.bounds, colliders: recipe.colliders },
      ]),
    ),
  };
  await writeJson(resolve(outputRoot, 'reports/static-library-v1.json'), summary);
  return summary;
}

/** Bind generated rules to the immutable compiled library before any DB dry-run. */
export async function finalizeStaticLibraryRules(rulesFile: string, releaseDirectory: string) {
  const rules = await readJson<StaticAssetRemapRules>(rulesFile);
  const metadata = await readJson<{ assetReleaseVersion: string }>(
    resolve(releaseDirectory, 'authoring.json'),
  );
  const manifest = await readJson<{ assets: Record<string, BuildingAssetManifest> }>(
    resolve(releaseDirectory, 'manifest.json'),
  );
  rules.targetAssetReleaseVersion = metadata.assetReleaseVersion;
  rules.targetLibraryHash = staticAssetLibraryHash(rules, manifest.assets);
  validateStaticAssetRemapRules(rules);
  await writeJson(rulesFile, rules);
  return rules;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2),
    sourceIndex = args.indexOf('--legacy-root'),
    outputIndex = args.indexOf('--output-root');
  const finalizeIndex = args.indexOf('--finalize');
  if (finalizeIndex >= 0) {
    const rulesIndex = args.indexOf('--rules');
    const rules = await finalizeStaticLibraryRules(
      resolve(
        rulesIndex >= 0
          ? args[rulesIndex + 1]
          : 'content/migrations/ring-block/static-library-v1.json',
      ),
      resolve(args[finalizeIndex + 1]),
    );
    console.log(
      JSON.stringify(
        {
          targetAssetReleaseVersion: rules.targetAssetReleaseVersion,
          targetLibraryHash: rules.targetLibraryHash,
        },
        null,
        2,
      ),
    );
  } else {
    if (sourceIndex < 0 || outputIndex < 0)
      throw new Error(
        'Usage: static-library.ts --legacy-root <preserved-input> --output-root <repository>',
      );
    const summary = await prepareStaticLibrary(
      resolve(args[sourceIndex + 1]),
      resolve(args[outputIndex + 1]),
    );
    console.log(
      JSON.stringify(
        {
          sourceInstances: summary.sourceInstances,
          targetInstances: summary.targetInstances,
          targetAssets: summary.targetSelectedAssets,
          maxVegetationDeviation: summary.maxVegetationDeviation,
          fencePairs: summary.fencePairs,
        },
        null,
        2,
      ),
    );
  }
}
