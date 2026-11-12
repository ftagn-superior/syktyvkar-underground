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
  type WorldHeader,
  type WorldCell,
  type StaticEntityDefinition,
  createWorldGrid,
  worldCellBounds,
  buildingBounds,
  primitiveBounds,
  cellsIntersectingBounds,
  mergeWorldCells,
  validateWorldHeader,
  WORLD_RESOURCE_LIMITS,
  type WorldDefinition,
  type WorldManifest,
  type WorldSource,
} from '@su/contracts';
import { encodeStaticGlb, inspectStaticGlb } from './glb.js';
import { generateHouse, type HouseRecipe } from './house.js';
import { generateStreamingCells } from './streaming-lab.js';

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
  if (descriptor.source?.kind === 'house') {
    const recipe = (await readJson(sourceFile(directory, descriptor.source.file))) as HouseRecipe;
    const generated = generateHouse(assetId, recipe);
    model = encodeStaticGlb(generated.parts);
    physics = generated.physics;
  } else if (descriptor.source?.kind === 'glb') {
    model = await readFile(sourceFile(directory, descriptor.source.file));
    physics = validateBuildingPhysicsAsset(
      await readJson(sourceFile(directory, descriptor.source.collisionFile)),
    );
    if (physics.assetId !== assetId) throw new Error('Imported collision asset ID mismatch');
  } else throw new Error(`Unsupported asset source: ${assetId}`);
  if (model.byteLength > WORLD_RESOURCE_LIMITS.modelBytes)
    throw new Error(`Model byte limit: ${assetId}`);
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
  if (
    collision.byteLength > WORLD_RESOURCE_LIMITS.collisionBytes ||
    parts.byteLength > WORLD_RESOURCE_LIMITS.partsBytes
  )
    throw new Error(`Model metadata byte limit: ${assetId}`);
  const version = hash(
    canonicalJson({ model: hash(model), collision: hash(collision), parts: hash(parts) }),
  );
  return { model, collision, parts, version, physics, bounds: inspected.bounds };
}

export async function buildWorld(
  source = 'content/worlds/physics-lab/world.json',
  output?: string,
): Promise<WorldManifest> {
  const authored = (await readJson(source)) as WorldSource;
  if (
    authored.formatVersion !== WORLD_FORMAT_VERSION ||
    !Array.isArray(authored.cells) ||
    authored.cells.length > 10_000 ||
    typeof authored.assetCatalog !== 'string'
  )
    throw new Error('World source must use formatVersion 3, cells and assetCatalog');
  validateWorldHeader(authored);
  const base: WorldHeader = {
    formatVersion: WORLD_FORMAT_VERSION,
    worldId: authored.worldId,
    bounds: authored.bounds,
    simulation: authored.simulation,
    spawnPoints: authored.spawnPoints,
    crate: authored.crate,
    ...(authored.routes ? { routes: authored.routes } : {}),
  };
  const grid = createWorldGrid(base.bounds, authored.cellSize);
  const outputDirectory = output ?? `dist/worlds/${base.worldId}`;
  const sourceDirectory = dirname(resolve(source));
  const catalogPath = resolve(sourceDirectory, authored.assetCatalog);
  const catalog = await readJson(catalogPath);
  if (catalog.formatVersion !== 1 || !catalog.assets || typeof catalog.assets !== 'object')
    throw new Error('Invalid building asset catalog');
  let authoredCells: WorldCell[];
  if (authored.generator) {
    if (authored.generator.kind !== 'streaming-lab' || authored.cells.length !== 0)
      throw new Error('A generated world must use only the streaming-lab generator');
    authoredCells = generateStreamingCells(authored);
  } else {
    if (authored.cells.length === 0) throw new Error('World source requires cells');
    authoredCells = await Promise.all(
      authored.cells.map(async (path) =>
        validateWorldCell(await readJson(sourceFile(sourceDirectory, path))),
      ),
    );
  }
  if (new Set(authoredCells.map((cell) => cell.cellId)).size !== authoredCells.length)
    throw new Error('Duplicate world cell ID');
  const merged = mergeWorldCells(authoredCells);
  const buildings = merged.buildings;
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
  const { crate, ...parameters } = base;
  const world: WorldDefinition = validateWorld({
    ...parameters,
    entities: [...merged.statics, crate],
    buildings,
    buildingAssets: Object.fromEntries([...compiled].map(([id, asset]) => [id, asset.physics])),
  });
  const cells = new Map<string, WorldCell>();
  for (let z = 0; z < grid.rows; z++)
    for (let x = 0; x < grid.columns; x++) {
      const cellId = `${x}_${z}`;
      cells.set(cellId, { formatVersion: 2, cellId, statics: [], buildings: [] });
    }
  for (const item of merged.statics) {
    const ids = cellsIntersectingBounds(base.bounds, grid, primitiveBounds(item));
    if (ids.length === 0) throw new Error(`Static outside world: ${item.entityId}`);
    for (const id of ids) cells.get(id)!.statics.push(item as StaticEntityDefinition);
  }
  for (const item of buildings) {
    const ids = cellsIntersectingBounds(
      base.bounds,
      grid,
      buildingBounds(item, compiled.get(item.assetId)!.bounds),
    );
    for (const id of ids) cells.get(id)!.buildings.push(item);
  }
  const files: Record<string, string> = {};
  const payloads = new Map<string, Uint8Array>();
  const put = (path: string, bytes: Uint8Array, maxBytes: number) => {
    if (bytes.byteLength > maxBytes) throw new Error(`World resource byte limit: ${path}`);
    files[path] = hash(bytes);
    payloads.set(path, bytes);
    return path;
  };
  const baseBytes = jsonBytes(base);
  const worldFile = put(
    `header.${hash(baseBytes)}.json`,
    baseBytes,
    WORLD_RESOURCE_LIMITS.headerBytes,
  );
  const assets: Record<string, BuildingAssetManifest> = {};
  for (const [assetId, asset] of compiled) {
    const prefix = `assets/${asset.version}`;
    assets[assetId] = {
      assetId,
      version: asset.version,
      bounds: asset.bounds,
      modelFile: put(`${prefix}/model.glb`, asset.model, WORLD_RESOURCE_LIMITS.modelBytes),
      collisionFile: put(
        `${prefix}/colliders.json`,
        asset.collision,
        WORLD_RESOURCE_LIMITS.collisionBytes,
      ),
      partsFile: put(`${prefix}/parts.json`, asset.parts, WORLD_RESOURCE_LIMITS.partsBytes),
    };
  }
  const cellEntries = [...cells.values()].map((cell) => {
    const bytes = jsonBytes(cell);
    return {
      cellId: cell.cellId,
      file: put(`cells/${cell.cellId}.${hash(bytes)}.json`, bytes, WORLD_RESOURCE_LIMITS.cellBytes),
      bounds: worldCellBounds(base.bounds, grid, cell.cellId),
      assetIds: [...new Set(cell.buildings.map((building) => building.assetId))].sort(),
    };
  });
  const manifest: WorldManifest = {
    formatVersion: WORLD_FORMAT_VERSION,
    worldId: world.worldId,
    worldFile,
    mapVersion: '0'.repeat(64),
    simulationConfigHash: hash(canonicalJson(simulationProjection(world))),
    bounds: world.bounds,
    grid,
    cells: cellEntries,
    assets,
    files,
  };
  manifest.mapVersion = hash(canonicalJson(worldManifestIdentity(manifest)));
  validateWorldManifest(manifest);
  await mkdir(outputDirectory, { recursive: true });
  for (const [path, bytes] of payloads) {
    const destination = resolve(outputDirectory, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
  }
  // Content files are immutable; publishing the small manifest is the final step.
  const temporary = resolve(outputDirectory, '.manifest.tmp');
  await writeFile(temporary, JSON.stringify(manifest, null, 2) + '\n');
  await rename(temporary, resolve(outputDirectory, 'manifest.json'));
  return manifest;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = await buildWorld(process.env.SU_WORLD_SOURCE);
  console.log(
    `World ${manifest.worldId}: ${manifest.mapVersion.slice(0, 12)} (${Object.keys(manifest.assets).length} building assets)`,
  );
}
