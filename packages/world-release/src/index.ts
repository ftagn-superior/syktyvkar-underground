export * from './model-catalog.js';
import { createHash } from 'node:crypto';
export * from './static-asset-remap.js';
import { mkdir, writeFile, rename, readFile, readdir, unlink, rmdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  WORLD_FORMAT_VERSION,
  WORLD_RESOURCE_LIMITS,
  GRAPHICS_PACK_LIMITS,
  encodeGraphicsPack,
  canonicalJson,
  validateWorld,
  validateWorldManifest,
  validateBuildingParts,
  worldManifestIdentity,
  simulationProjection,
  worldCellBounds,
  cellsIntersectingBounds,
  primitiveBounds,
  buildingBounds,
  type WorldDefinition,
  type WorldGrid,
  type WorldCell,
  type WorldCellManifest,
  type WorldManifest,
  type BuildingAssetManifest,
  type BuildingPhysicsAsset,
  type Bounds,
  type StaticEntityDefinition,
} from '@su/contracts';

export interface CompiledWorldAsset {
  version: string;
  bounds: Bounds;
  physics: BuildingPhysicsAsset;
  model?: Uint8Array;
  collision: Uint8Array;
  parts: Uint8Array;
}
/** Deterministic format/loader budget failure, distinct from storage and malformed content. */
export class WorldPublicationContentLimitError extends Error {
  constructor(readonly resource: string) {
    super(`World publication content limit: ${resource}`);
    this.name = 'WorldPublicationContentLimitError';
  }
}

export interface WorldPublication {
  manifest: WorldManifest;
  payloads: Map<string, Uint8Array>;
}
export interface WorldPublicationOptions {
  /** Explicit transport opt-in; old authored publications remain byte-identical by default. */
  physicsPacks?: boolean;
}
export const hash = (input: string | Uint8Array) =>
  createHash('sha256').update(input).digest('hex');
export const jsonBytes = (value: unknown) => new TextEncoder().encode(canonicalJson(value) + '\n');
const byId = (a: { entityId: string }, b: { entityId: string }) =>
  a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0;

/** The only spatial publisher, shared by authored builds and database layouts. */
export function createWorldPublication(
  world: WorldDefinition,
  grid: WorldGrid,
  compiled: Record<string, CompiledWorldAsset>,
  options: WorldPublicationOptions = {},
): WorldPublication {
  // Keep the existing format and client budgets; validate before any files or DB are written.
  if (world.buildings.length > 10_000)
    throw new WorldPublicationContentLimitError('world building references');
  if (world.entities.length > 1000)
    throw new WorldPublicationContentLimitError('world static primitives');
  if (new Set([...world.entities, ...world.buildings].map((i) => i.entityId)).size > 16_384)
    throw new WorldPublicationContentLimitError('unique static instances');
  validateWorld(world);
  const cells = new Map<string, WorldCell>();
  for (let z = 0; z < grid.rows; z++)
    for (let x = 0; x < grid.columns; x++) {
      const cellId = `${x}_${z}`;
      cells.set(cellId, { formatVersion: 2, cellId, statics: [], buildings: [] });
    }
  for (const item of world.entities) {
    const ids = cellsIntersectingBounds(world.bounds, grid, primitiveBounds(item));
    if (ids.length === 0) throw new Error(`Static outside world: ${item.entityId}`);
    for (const id of ids) cells.get(id)!.statics.push(item as StaticEntityDefinition);
  }
  for (const item of world.buildings) {
    const ids = cellsIntersectingBounds(
      world.bounds,
      grid,
      buildingBounds(item, world.buildingAssets[item.assetId].bounds),
    );
    for (const id of ids) cells.get(id)!.buildings.push(item);
  }
  const files: Record<string, string> = {};
  const payloads = new Map<string, Uint8Array>();
  const put = (path: string, bytes: Uint8Array, maxBytes: number) => {
    if (bytes.byteLength > maxBytes) throw new WorldPublicationContentLimitError(path);
    files[path] = hash(bytes);
    payloads.set(path, bytes);
    return path;
  };
  const { entities: _entities, buildings: _buildings, buildingAssets: _assets, ...header } = world;
  const baseBytes = jsonBytes(header);
  const worldFile = put(
    `header.${hash(baseBytes)}.json`,
    baseBytes,
    WORLD_RESOURCE_LIMITS.headerBytes,
  );
  const assets: Record<string, BuildingAssetManifest> = {};
  for (const [assetId, asset] of Object.entries(compiled).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    const prefix = `assets/${asset.version}`;
    const parts = JSON.parse(new TextDecoder().decode(asset.parts));
    if (parts.tree || parts.renderMode !== undefined) {
      validateBuildingParts(parts);
      if (parts.assetId !== assetId) throw new Error(`Parts asset ID mismatch: ${assetId}`);
    }
    if (!!parts.tree !== (asset.model === undefined))
      throw new Error(`Asset must contain either an instanced tree or a GLB: ${assetId}`);
    assets[assetId] = {
      assetId,
      version: asset.version,
      bounds: asset.bounds,
      ...(asset.model === undefined
        ? {}
        : {
            modelFile: put(`${prefix}/model.glb`, asset.model, WORLD_RESOURCE_LIMITS.modelBytes),
          }),
      collisionFile: put(
        `${prefix}/colliders.json`,
        asset.collision,
        WORLD_RESOURCE_LIMITS.collisionBytes,
      ),
      partsFile: put(`${prefix}/parts.json`, asset.parts, WORLD_RESOURCE_LIMITS.partsBytes),
    };
  }
  const cellEntries: WorldCellManifest[] = [...cells.values()].map((cell) => {
    cell.statics.sort(byId);
    cell.buildings.sort(byId);
    if (cell.buildings.length > 10_000)
      throw new WorldPublicationContentLimitError(`cell ${cell.cellId} building references`);
    const bytes = jsonBytes(cell);
    return {
      cellId: cell.cellId,
      file: put(`cells/${cell.cellId}.${hash(bytes)}.json`, bytes, WORLD_RESOURCE_LIMITS.cellBytes),
      bounds: worldCellBounds(world.bounds, grid, cell.cellId),
      assetIds: [...new Set(cell.buildings.map((building) => building.assetId))].sort(),
    };
  });
  // Border-crossing buildings belong to several cells. Pack equal membership sets together:
  // every requested entry is relevant, and shared models have only one transport copy.
  const memberships = new Map<string, WorldCellManifest[]>();
  for (const cell of cellEntries)
    for (const id of cell.assetIds) {
      const owners = memberships.get(id) ?? [];
      owners.push(cell);
      memberships.set(id, owners);
    }
  const groups = new Map<string, { owners: WorldCellManifest[]; assetIds: string[] }>();
  for (const [id, owners] of memberships) {
    const key = owners.map((cell) => cell.cellId).join(',');
    let group = groups.get(key);
    if (!group) groups.set(key, (group = { owners, assetIds: [] }));
    group.assetIds.push(id);
  }
  const pack = (owners: WorldCellManifest[], paths: string[], kind: 'graphics' | 'physics') => {
    const field = kind === 'graphics' ? 'graphicsPacks' : 'physicsPacks';
    let pending: [string, Uint8Array][] = [];
    let pendingBytes = 10; // magic, header length, JSON brackets
    const flush = () => {
      if (!pending.length) return;
      const packed = encodeGraphicsPack(pending);
      const path = put(`${kind}/${hash(packed)}.pack`, packed, GRAPHICS_PACK_LIMITS.bytes);
      for (const cell of owners) {
        cell[field] ??= [];
        if (!cell[field].includes(path)) cell[field].push(path);
      }
      pending = [];
      pendingBytes = 10;
    };
    for (const path of paths) {
      const resource = payloads.get(path)!;
      const entryBytes = resource.length + JSON.stringify([path, resource.length]).length + 1;
      if (entryBytes + 10 > GRAPHICS_PACK_LIMITS.bytes) continue;
      if (
        pendingBytes + entryBytes > GRAPHICS_PACK_LIMITS.bytes ||
        pending.length >= GRAPHICS_PACK_LIMITS.entries
      )
        flush();
      pending.push([path, resource]);
      pendingBytes += entryBytes;
    }
    flush();
  };
  for (const { owners, assetIds } of groups.values()) {
    const paths = [
      // Instanced trees have only parameters; other assets include their GLB.
      ...new Set(
        assetIds
          .sort()
          .flatMap((id) =>
            assets[id].modelFile
              ? [assets[id].modelFile!, assets[id].partsFile]
              : [assets[id].partsFile],
          ),
      ),
    ];
    pack(owners, paths, 'graphics');
    if (options.physicsPacks)
      pack(owners, [...new Set(assetIds.map((id) => assets[id].collisionFile))], 'physics');
  }
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
  return { manifest, payloads };
}

export async function writeWorldPublication(
  publication: WorldPublication,
  outputDirectory: string,
) {
  const { manifest, payloads } = publication;
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

/** Offline build cleanup. Runtime layout publication deliberately does not call this. */
export async function pruneWorldPublication(outputDirectory: string) {
  const manifest = validateWorldManifest(
    JSON.parse(await readFile(resolve(outputDirectory, 'manifest.json'), 'utf8')),
  );
  const obsolete: string[] = [];
  const directories: string[] = [];
  const scan = async (relative: string) => {
    for (const entry of await readdir(resolve(outputDirectory, relative), {
      withFileTypes: true,
    })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (
        !relative &&
        !['assets', 'cells', 'graphics', 'physics', 'layouts'].includes(entry.name) &&
        !/^header\.[a-f0-9]{64}\.json$/.test(entry.name)
      )
        continue;
      if (entry.isSymbolicLink()) throw new Error(`Cannot prune symbolic link: ${path}`);
      if (entry.isDirectory()) {
        await scan(path);
        directories.push(path);
      } else if (entry.isFile() && !Object.hasOwn(manifest.files, path)) obsolete.push(path);
    }
  };
  await scan('');
  // Validate the complete retained release before deleting anything.
  for (const [path, expected] of Object.entries(manifest.files)) {
    if (hash(await readFile(resolve(outputDirectory, path))) !== expected)
      throw new Error(`Cannot prune an incomplete or corrupt release: ${path}`);
  }
  for (const path of obsolete) await unlink(resolve(outputDirectory, path));
  for (const path of directories) {
    const absolute = resolve(outputDirectory, path);
    if ((await readdir(absolute)).length === 0) await rmdir(absolute);
  }
  return obsolete.length;
}

export interface AuthoringMetadata {
  formatVersion: 1;
  assetReleaseVersion: string;
  seedVersion: string;
  fixedInstanceIds: string[];
  terrain?: PrivateTerrainReference;
}

export interface PrivateTerrainReference {
  file: string;
  sha256: string;
}
export const PRIVATE_TERRAIN_MAX_BYTES = 64 * 1024 * 1024;
export function validatePrivateTerrainReference(value: unknown): PrivateTerrainReference {
  const ref = value as PrivateTerrainReference;
  if (
    !ref ||
    typeof ref !== 'object' ||
    Object.keys(ref).length !== 2 ||
    typeof ref.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(ref.sha256) ||
    ref.file !== `private/terrain.${ref.sha256}.json`
  )
    throw new Error('Invalid private terrain reference');
  return ref;
}

export function authoringMetadata(
  world: WorldDefinition,
  manifest: WorldManifest,
  fixedInstanceIds: string[],
  terrain?: PrivateTerrainReference,
): AuthoringMetadata {
  if (terrain) validatePrivateTerrainReference(terrain);
  const ids = new Set(fixedInstanceIds);
  if (
    ids.size !== fixedInstanceIds.length ||
    fixedInstanceIds.some((id) => !world.buildings.some((b) => b.entityId === id))
  )
    throw new Error('Invalid fixed placement IDs');
  const fixed = world.buildings.filter((b) => ids.has(b.entityId)).sort(byId);
  const seed = world.buildings.filter((b) => !ids.has(b.entityId)).sort(byId);
  return {
    formatVersion: 1,
    assetReleaseVersion: hash(
      canonicalJson({
        worldId: world.worldId,
        header: manifest.worldFile,
        grid: manifest.grid,
        assets: manifest.assets,
        statics: [...world.entities].sort(byId),
        fixed,
        ...(terrain ? { terrain } : {}),
      }),
    ),
    seedVersion: hash(canonicalJson(seed)),
    fixedInstanceIds: [...fixedInstanceIds].sort(),
    ...(terrain ? { terrain } : {}),
  };
}
export async function writeAuthoringMetadata(
  world: WorldDefinition,
  manifest: WorldManifest,
  fixedIds: string[],
  directory: string,
  terrainBytes?: Uint8Array,
) {
  let terrain: PrivateTerrainReference | undefined;
  if (terrainBytes !== undefined) {
    if (terrainBytes.byteLength > PRIVATE_TERRAIN_MAX_BYTES)
      throw new Error('Private terrain byte limit');
    const sha256 = hash(terrainBytes);
    terrain = { file: `private/terrain.${sha256}.json`, sha256 };
  }
  const metadata = authoringMetadata(world, manifest, fixedIds, terrain);
  if (terrain && terrainBytes) {
    await mkdir(resolve(directory, 'private'), { recursive: true });
    // Write and close the immutable payload before publishing its metadata reference.
    const pending = resolve(directory, 'private/.terrain.tmp');
    await writeFile(pending, terrainBytes);
    await rename(pending, resolve(directory, terrain.file));
  }
  const temporary = resolve(directory, '.authoring.tmp');
  await writeFile(temporary, JSON.stringify(metadata, null, 2) + '\n');
  await rename(temporary, resolve(directory, 'authoring.json'));
}
