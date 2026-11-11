import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, sep } from 'node:path';
import { validateBytes } from 'gltf-validator';
import {
  WORLD_FORMAT_VERSION,
  canonicalJson,
  validateWorld,
  validateWorldCell,
  validateWorldManifest,
  validateBuildingPhysicsAsset,
  simulationProjection,
  worldManifestIdentity,
  type BuildingAssetManifest,
  type BuildingPhysicsAsset,
  type WorldBase,
  type WorldDefinition,
  type WorldManifest,
  type WorldSource,
} from '@su/contracts';
import { encodeStaticGlb, inspectStaticGlb } from './glb.js';
import { generateHouse, type HouseRecipe } from './house.js';
import {
  generateFootprint,
  generateGround,
  generateTree,
  type FootprintRecipe,
  type GroundRecipe,
  type TreeRecipe,
} from './city.js';

/** Миры, которые собирает `pnpm world:build`. Первый обслуживается сервером по умолчанию. */
export const WORLDS = ['ring-block', 'physics-lab'] as const;
const generators = {
  house: (id: string, recipe: unknown) => generateHouse(id, recipe as HouseRecipe),
  footprint: (id: string, recipe: unknown) => generateFootprint(id, recipe as FootprintRecipe),
  ground: (id: string, recipe: unknown) => generateGround(id, recipe as GroundRecipe),
  tree: (id: string, recipe: unknown) => generateTree(id, recipe as TreeRecipe),
};

const hash = (input: string | Uint8Array) => createHash('sha256').update(input).digest('hex');
const jsonBytes = (value: unknown) => new TextEncoder().encode(canonicalJson(value) + '\n');
const readJson = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
function sourceFile(directory: string, path: unknown): string {
  if (
    typeof path !== 'string' ||
    path.length === 0 ||
    path.includes('\\') ||
    path.split('/').some((p) => p === '' || p === '.' || p === '..')
  )
    throw new Error('Asset file paths must be relative to their source directory');
  const absolute = resolve(directory, path);
  if (!absolute.startsWith(resolve(directory) + sep))
    throw new Error('Asset source path escapes its directory');
  return absolute;
}

async function compileAsset(assetId: string, descriptorPath: string) {
  const descriptor = await readJson(descriptorPath);
  if (descriptor.formatVersion !== 1 || descriptor.assetId !== assetId)
    throw new Error(`Invalid asset descriptor: ${assetId}`);
  const directory = dirname(descriptorPath);
  let model: Uint8Array, physics: BuildingPhysicsAsset;
  const kind = descriptor.source?.kind;
  const generator = Object.hasOwn(generators, kind)
    ? generators[kind as keyof typeof generators]
    : undefined;
  if (generator) {
    const recipe = await readJson(sourceFile(directory, descriptor.source.file));
    const generated = generator(assetId, recipe);
    model = encodeStaticGlb(generated.parts);
    physics = generated.physics;
  } else if (descriptor.source?.kind === 'glb') {
    model = await readFile(sourceFile(directory, descriptor.source.file));
    physics = validateBuildingPhysicsAsset(
      await readJson(sourceFile(directory, descriptor.source.collisionFile)),
    );
    if (physics.assetId !== assetId) throw new Error('Imported collision asset ID mismatch');
  } else throw new Error(`Unsupported asset source: ${assetId}`);
  const validation = await validateBytes(model, { uri: `${assetId}.glb`, writeTimestamp: false });
  if (validation.issues.numErrors)
    throw new Error(
      `Invalid glTF ${assetId}: ${validation.issues.messages
        .filter((m) => m.code)
        .slice(0, 5)
        .map((m) => m.message)
        .join('; ')}`,
    );
  const inspected = inspectStaticGlb(model, assetId);
  // Imported proxies may simplify the silhouette, but must share the visual asset coordinate space.
  for (const axis of ['x', 'y', 'z'] as const) {
    if (
      Math.abs(physics.bounds.min[axis] - inspected.bounds.min[axis]) > 0.05 ||
      Math.abs(physics.bounds.max[axis] - inspected.bounds.max[axis]) > 0.05
    )
      throw new Error(`Visual/collision asset bounds disagree: ${assetId}.${axis}`);
  }
  physics = { ...physics, bounds: inspected.bounds };
  validateBuildingPhysicsAsset(physics);
  const collision = jsonBytes(physics),
    parts = jsonBytes(inspected.parts);
  const version = hash(
    canonicalJson({ model: hash(model), collision: hash(collision), parts: hash(parts) }),
  );
  return { model, collision, parts, version, physics, bounds: inspected.bounds };
}

export async function buildWorld(
  source = 'content/worlds/physics-lab/world.json',
  output = 'dist/worlds/physics-lab',
): Promise<WorldManifest> {
  const authored = (await readJson(source)) as WorldSource;
  if (
    authored.formatVersion !== WORLD_FORMAT_VERSION ||
    !Array.isArray(authored.cells) ||
    authored.cells.length === 0 ||
    typeof authored.assetCatalog !== 'string'
  )
    throw new Error('World source must use formatVersion 2, cells and assetCatalog');
  const base: WorldBase = {
    formatVersion: WORLD_FORMAT_VERSION,
    worldId: authored.worldId,
    bounds: authored.bounds,
    simulation: authored.simulation,
    spawnPoints: authored.spawnPoints,
    entities: authored.entities,
    // Необязательное поле не записывается вовсе, чтобы не менять хеши миров без подписей.
    ...(authored.landmarks ? { landmarks: authored.landmarks } : {}),
  };
  validateWorld({ ...base, buildings: [], buildingAssets: {} });
  const sourceDirectory = dirname(resolve(source));
  const catalogPath = resolve(sourceDirectory, authored.assetCatalog);
  const catalog = await readJson(catalogPath);
  if (catalog.formatVersion !== 1 || !catalog.assets || typeof catalog.assets !== 'object')
    throw new Error('Invalid building asset catalog');
  const cells = await Promise.all(
    authored.cells.map(async (path) =>
      validateWorldCell(await readJson(sourceFile(sourceDirectory, path))),
    ),
  );
  if (new Set(cells.map((cell) => cell.cellId)).size !== cells.length)
    throw new Error('Duplicate world cell ID');
  const buildings = cells.flatMap((cell) => cell.buildings);
  const assetIds = [...new Set(buildings.map((instance) => instance.assetId))].sort();
  const compiled = new Map<string, Awaited<ReturnType<typeof compileAsset>>>();
  for (const assetId of assetIds) {
    if (!Object.hasOwn(catalog.assets, assetId))
      throw new Error(`Unknown building asset ${assetId}`);
    compiled.set(
      assetId,
      await compileAsset(assetId, sourceFile(dirname(catalogPath), catalog.assets[assetId])),
    );
  }
  const world: WorldDefinition = validateWorld({
    ...base,
    buildings,
    buildingAssets: Object.fromEntries([...compiled].map(([id, asset]) => [id, asset.physics])),
  });
  const files: Record<string, string> = {};
  const payloads = new Map<string, Uint8Array>();
  const put = (path: string, bytes: Uint8Array) => {
    files[path] = hash(bytes);
    payloads.set(path, bytes);
    return path;
  };
  const baseBytes = jsonBytes(base);
  const worldFile = put(`world.${hash(baseBytes)}.json`, baseBytes);
  const assets: Record<string, BuildingAssetManifest> = {};
  for (const [assetId, asset] of compiled) {
    const prefix = `assets/${asset.version}`;
    assets[assetId] = {
      assetId,
      version: asset.version,
      bounds: asset.bounds,
      modelFile: put(`${prefix}/model.glb`, asset.model),
      collisionFile: put(`${prefix}/colliders.json`, asset.collision),
      partsFile: put(`${prefix}/parts.json`, asset.parts),
    };
  }
  const cellEntries = cells.map((cell) => {
    const bytes = jsonBytes(cell);
    return {
      cellId: cell.cellId,
      file: put(`cells/${cell.cellId}.${hash(bytes)}.json`, bytes),
      bounds: base.bounds,
    };
  });
  const manifest: WorldManifest = {
    formatVersion: WORLD_FORMAT_VERSION,
    worldId: world.worldId,
    worldFile,
    mapVersion: '0'.repeat(64),
    simulationConfigHash: hash(canonicalJson(simulationProjection(world))),
    bounds: world.bounds,
    cells: cellEntries,
    assets,
    files,
  };
  manifest.mapVersion = hash(canonicalJson(worldManifestIdentity(manifest)));
  validateWorldManifest(manifest);
  await mkdir(output, { recursive: true });
  for (const [path, bytes] of payloads) {
    const destination = resolve(output, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
  }
  // Content files are immutable; publishing the small manifest is the final step.
  const temporary = resolve(output, '.manifest.tmp');
  await writeFile(temporary, JSON.stringify(manifest, null, 2) + '\n');
  await rename(temporary, resolve(output, 'manifest.json'));
  return manifest;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const worldId of WORLDS) {
    const manifest = await buildWorld(
      `content/worlds/${worldId}/world.json`,
      `dist/worlds/${worldId}`,
    );
    console.log(
      `World ${manifest.worldId}: ${manifest.mapVersion.slice(0, 12)} (${Object.keys(manifest.assets).length} building assets)`,
    );
  }
}
