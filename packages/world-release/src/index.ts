import { createHash } from 'node:crypto';
import { mkdir, writeFile, rename } from 'node:fs/promises';
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
  model: Uint8Array;
  collision: Uint8Array;
  parts: Uint8Array;
}
export interface WorldPublication {
  manifest: WorldManifest;
  payloads: Map<string, Uint8Array>;
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
): WorldPublication {
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
    if (bytes.byteLength > maxBytes) throw new Error(`World resource byte limit: ${path}`);
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
  const proceduralTrees = new Set<string>();
  for (const [assetId, asset] of Object.entries(compiled).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
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
    const parts = JSON.parse(new TextDecoder().decode(asset.parts));
    if (parts.tree && validateBuildingParts(parts).tree) proceduralTrees.add(assetId);
  }
  const cellEntries: WorldCellManifest[] = [...cells.values()].map((cell) => {
    cell.statics.sort(byId);
    cell.buildings.sort(byId);
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
  for (const { owners, assetIds } of groups.values()) {
    const paths = [
      // Modern clients reconstruct these trees from parts. Legacy clients can still fetch
      // the original, hash-verified GLB separately, including after layout republication.
      ...new Set(
        assetIds
          .sort()
          .flatMap((id) =>
            proceduralTrees.has(id)
              ? [assets[id].partsFile]
              : [assets[id].modelFile, assets[id].partsFile],
          ),
      ),
    ];
    let pending: [string, Uint8Array][] = [];
    let pendingBytes = 10; // magic, header length, JSON brackets
    const flush = () => {
      if (!pending.length) return;
      const packed = encodeGraphicsPack(pending);
      const path = put(`graphics/${hash(packed)}.pack`, packed, GRAPHICS_PACK_LIMITS.bytes);
      for (const cell of owners) {
        cell.graphicsPacks ??= [];
        if (!cell.graphicsPacks.includes(path)) cell.graphicsPacks.push(path);
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

export interface AuthoringMetadata {
  formatVersion: 1;
  assetReleaseVersion: string;
  seedVersion: string;
  fixedInstanceIds: string[];
}

export function authoringMetadata(
  world: WorldDefinition,
  manifest: WorldManifest,
  fixedInstanceIds: string[],
): AuthoringMetadata {
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
      }),
    ),
    seedVersion: hash(canonicalJson(seed)),
    fixedInstanceIds: [...fixedInstanceIds].sort(),
  };
}
export async function writeAuthoringMetadata(
  world: WorldDefinition,
  manifest: WorldManifest,
  fixedIds: string[],
  directory: string,
) {
  const metadata = authoringMetadata(world, manifest, fixedIds);
  const temporary = resolve(directory, '.authoring.tmp');
  await writeFile(temporary, JSON.stringify(metadata, null, 2) + '\n');
  await rename(temporary, resolve(directory, 'authoring.json'));
}
