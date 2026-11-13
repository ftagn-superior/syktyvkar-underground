import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, sep } from 'node:path';
import { validateBytes } from 'gltf-validator';
import {
  WORLD_FORMAT_VERSION,
  type WorldManifest,
  validateWorld,
  validateWorldCell,
  validateBuildingPhysicsAsset,
  validateTerrainGrid,
  type BuildingPhysicsAsset,
  type WorldHeader,
  type WorldCell,
  createWorldGrid,
  worldCellBounds,
  cellsIntersectingBounds,
  mergeWorldCells,
  validateWorldHeader,
  WORLD_RESOURCE_LIMITS,
  type WorldDefinition,
  type WorldSource,
  type TreeRenderRecipe,
  type BuildingParts,
  type TerrainGrid,
} from '@su/contracts';
import {
  createWorldPublication,
  writeWorldPublication,
  writeAuthoringMetadata,
  pruneWorldPublication,
  jsonBytes,
} from '@su/world-release';
import { encodeStaticGlb, staticMeshBounds } from './glb.js';
import { compileStaticAsset } from '@su/terrain-build/assets';
import { prepareTerrainBuildContext, rectangle } from '@su/terrain-build';
import {
  TERRAIN_GENERATOR_VERSION,
  TERRAIN_GENERATOR_VERSION_V2,
  validateFoundationSupportRule,
  validateTerrainCoverage,
  validateTerrainPrivateData,
  type TerrainPrivateData,
  type FoundationSupportRuleV2,
} from '@su/terrain-build/private-data';
import { createGroundTerrain } from './ground-terrain.js';
import { buildTerrainTiles } from './terrain-tiles.js';
import { generateHouse, type HouseRecipe } from './house.js';
import { generateStreamingCells } from './streaming-lab.js';
import {
  generateFootprint,
  generateGround,
  type FootprintRecipe,
  type GroundRecipe,
} from './city.js';
import { generateKit, type KitRecipe } from './kit.js';
import { treeRenderRecipe } from './tree-instances.js';
import { buildTerrainAuthoring } from './terrain-authoring.js';

/** Миры, которые собирает `pnpm world:build`. Первый обслуживается сервером по умолчанию. */
export const WORLDS = ['ring-block', 'physics-lab', 'streaming-lab', 'terrain-lab'] as const;
const generators = {
  house: (id: string, recipe: unknown) => generateHouse(id, recipe as HouseRecipe),
  footprint: (id: string, recipe: unknown) => generateFootprint(id, recipe as FootprintRecipe),
  ground: (id: string, recipe: unknown) => generateGround(id, recipe as GroundRecipe),
  kit: (id: string, recipe: unknown) => generateKit(id, recipe as KitRecipe),
};

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

async function compileAsset(assetId: string, descriptorPath: string, groundRecipe?: GroundRecipe) {
  const descriptor = await readJson(descriptorPath);
  if (descriptor.formatVersion !== 1 || (!groundRecipe && descriptor.assetId !== assetId))
    throw new Error(`Invalid asset descriptor: ${assetId}`);
  if (descriptor.renderMode !== undefined && descriptor.renderMode !== 'thin-instance')
    throw new Error(`Unsupported asset render mode: ${assetId}`);
  const directory = dirname(descriptorPath);
  let model: Uint8Array | undefined, physics: BuildingPhysicsAsset;
  let treeParts: BuildingParts | undefined;
  let tree: TreeRenderRecipe | undefined;
  const kind = descriptor.source?.kind;
  const generator = Object.hasOwn(generators, kind)
    ? generators[kind as keyof typeof generators]
    : undefined;
  if (generator) {
    const recipe = groundRecipe ?? (await readJson(sourceFile(directory, descriptor.source.file)));
    const generated = generator(assetId, recipe);
    physics = generated.physics;
    if (kind === 'kit') tree = treeRenderRecipe(assetId, recipe);
    if (assetId.startsWith('tree-') && !tree)
      throw new Error(`Tree must use the current instancing profile: ${assetId}`);
    if (tree) {
      physics = { ...physics, bounds: staticMeshBounds(generated.parts) };
      treeParts = {
        formatVersion: 1,
        assetId,
        tree,
        parts: generated.parts.map(({ partId, role, occlusionGroup }, nodeIndex) => ({
          partId,
          role,
          occlusionGroup,
          nodeIndex,
        })),
      };
    } else model = encodeStaticGlb(generated.parts);
  } else if (descriptor.source?.kind === 'glb') {
    model = await readFile(sourceFile(directory, descriptor.source.file));
    physics = validateBuildingPhysicsAsset(
      await readJson(sourceFile(directory, descriptor.source.collisionFile)),
    );
    if (physics.assetId !== assetId) throw new Error('Imported collision asset ID mismatch');
  } else throw new Error(`Unsupported asset source: ${assetId}`);
  return compileBytes(assetId, model, physics, treeParts, descriptor.renderMode);
}

async function compileBytes(
  assetId: string,
  model: Uint8Array | undefined,
  physics: BuildingPhysicsAsset,
  treeParts?: BuildingParts,
  renderMode?: BuildingParts['renderMode'],
) {
  if (model !== undefined) {
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
  }
  return compileStaticAsset(assetId, model, physics, treeParts, renderMode);
}

export interface BuildWorldOptions {
  terrainVariant?: 'hill' | 'flat';
  /** Explicit output-only candidate. Rules are private inputs, never prebuilt foundations. */
  groundTerrain?: {
    spacing: 2 | 4;
    grid?: TerrainGrid;
    supports?: FoundationSupportRuleV2[];
    /** Reviewed offline changes for a new authored release, never startup adjustments. */
    header?: Pick<WorldHeader, 'bounds' | 'spawnPoints' | 'initialItems'>;
    statics?: WorldDefinition['entities'];
    seedY?: Record<string, number>;
  };
}

export async function buildWorld(
  source = 'content/worlds/ring-block/world.json',
  output?: string,
  options: BuildWorldOptions = {},
): Promise<WorldManifest> {
  const authored = (await readJson(source)) as WorldSource;
  if (
    authored.formatVersion !== WORLD_FORMAT_VERSION ||
    !Array.isArray(authored.cells) ||
    authored.cells.length > 10_000 ||
    typeof authored.assetCatalog !== 'string' ||
    typeof authored.itemCatalog !== 'string'
  )
    throw new Error(
      `World source must use formatVersion ${WORLD_FORMAT_VERSION}, cells, itemCatalog and assetCatalog`,
    );
  const sourceDirectory = dirname(resolve(source));
  if (options.groundTerrain && (authored.terrain || authored.generator || output === undefined))
    throw new Error('Ground terrain requires an explicit output and a non-generated flat source');
  const supportRules = options.groundTerrain?.supports;
  if (supportRules !== undefined) {
    if (!Array.isArray(supportRules)) throw new Error('Ground terrain supports must be an array');
    supportRules.forEach(validateFoundationSupportRule);
  }
  if (authored.terrain && authored.generator)
    throw new Error('Terrain and world generators cannot compete');
  const itemCatalog = await readJson(resolve(sourceDirectory, authored.itemCatalog));
  const bounds = options.groundTerrain?.header?.bounds ?? authored.bounds;
  const grid = createWorldGrid(bounds, authored.cellSize ?? 125);
  const terrain = authored.terrain
    ? buildTerrainAuthoring(
        authored,
        grid,
        itemCatalog,
        await readJson(sourceFile(sourceDirectory, authored.terrain.heightfield)),
        await readJson(sourceFile(sourceDirectory, authored.terrain.surfaces)),
        await readJson(sourceFile(sourceDirectory, authored.terrain.anchors)),
        options.terrainVariant ?? 'hill',
      )
    : undefined;
  const base: WorldHeader = {
    formatVersion: WORLD_FORMAT_VERSION,
    worldId: authored.worldId,
    bounds,
    simulation: authored.simulation,
    spawnPoints:
      options.groundTerrain?.header?.spawnPoints ?? terrain?.spawnPoints ?? authored.spawnPoints,
    itemCatalog,
    initialItems:
      options.groundTerrain?.header?.initialItems ?? terrain?.initialItems ?? authored.initialItems,
    // Необязательное поле не записывается вовсе, чтобы не менять хеши миров без подписей.
    ...(authored.landmarks ? { landmarks: authored.landmarks } : {}),
    ...(authored.routes ? { routes: authored.routes } : {}),
  };
  validateWorldHeader(base);
  const outputDirectory = output ?? `dist/worlds/${base.worldId}`;
  const catalogPath = resolve(sourceDirectory, authored.assetCatalog);
  const catalog = await readJson(catalogPath);
  if (catalog.formatVersion !== 1 || !catalog.assets || typeof catalog.assets !== 'object')
    throw new Error('Invalid building asset catalog');
  for (const id of terrain?.assets.keys() ?? [])
    if (Object.hasOwn(catalog.assets, id))
      throw new Error(`Terrain asset conflicts with catalog: ${id}`);
  let authoredCells: WorldCell[];
  if (authored.generator) {
    if (authored.generator.kind !== 'streaming-lab' || authored.cells.length !== 0)
      throw new Error('A generated world must use only the streaming-lab generator');
    authoredCells = generateStreamingCells(authored);
  } else {
    if (authored.cells.length === 0 && !terrain) throw new Error('World source requires cells');
    authoredCells = await Promise.all(
      authored.cells.map(async (path) =>
        validateWorldCell(await readJson(sourceFile(sourceDirectory, path))),
      ),
    );
  }
  if (new Set(authoredCells.map((cell) => cell.cellId)).size !== authoredCells.length)
    throw new Error('Duplicate world cell ID');
  if (authored.entities?.length)
    authoredCells.push({
      formatVersion: 2,
      cellId: 'source-statics',
      statics: authored.entities,
      buildings: [],
    });
  const merged = mergeWorldCells(authoredCells);
  const seedY = options.groundTerrain?.seedY;
  if (seedY) {
    const ids = new Set(merged.buildings.map((instance) => instance.entityId));
    for (const [id, y] of Object.entries(seedY))
      if (!ids.has(id) || !Number.isFinite(y))
        throw new Error(`Invalid explicit terrain seed height: ${id}`);
  }
  for (const rule of supportRules ?? []) {
    if (!Object.hasOwn(catalog.assets, rule.assetId))
      throw new Error(`Unknown terrain support asset: ${rule.assetId}`);
  }
  const buildings: WorldDefinition['buildings'] = [];
  const fixedInstanceIds: string[] = [...(terrain?.fixed ?? [])];
  const compiled = new Map<string, Awaited<ReturnType<typeof compileAsset>>>();
  let privateTerrain: TerrainPrivateData | undefined = terrain?.privateData;
  for (const [id, asset] of terrain?.assets ?? [])
    compiled.set(id, await compileBytes(id, encodeStaticGlb(asset.parts), asset.physics));
  for (const instance of [...merged.buildings, ...(terrain?.buildings ?? [])]) {
    if (terrain?.assets.has(instance.assetId)) {
      buildings.push(instance);
      continue;
    }
    if (!Object.hasOwn(catalog.assets, instance.assetId))
      throw new Error(`Unknown building asset ${instance.assetId}`);
    const descriptorPath = sourceFile(dirname(catalogPath), catalog.assets[instance.assetId]);
    const descriptor = await readJson(descriptorPath);
    if (descriptor.source?.kind !== 'ground') {
      buildings.push(
        seedY && Object.hasOwn(seedY, instance.entityId)
          ? { ...instance, position: { ...instance.position, y: seedY[instance.entityId] } }
          : instance,
      );
      if (!compiled.has(instance.assetId))
        compiled.set(instance.assetId, await compileAsset(instance.assetId, descriptorPath));
      continue;
    }
    // Ground alone is partitioned; all city building identities and source refs stay intact.
    const q = instance.rotation;
    if (Math.abs(q.x) + Math.abs(q.y) + Math.abs(q.z) > 1e-8 || Math.abs(q.w - 1) > 1e-8)
      throw new Error('Ground tiling requires axis-aligned source placement');
    const recipe = (await readJson(
      sourceFile(dirname(descriptorPath), descriptor.source.file),
    )) as GroundRecipe;
    const extent = {
      min: {
        x: recipe.min[0] + instance.position.x,
        y: -recipe.depth + instance.position.y,
        z: recipe.min[1] + instance.position.z,
      },
      max: {
        x: recipe.max[0] + instance.position.x,
        y: 0.05 + instance.position.y,
        z: recipe.max[1] + instance.position.z,
      },
    };
    if (options.groundTerrain) {
      if (privateTerrain) throw new Error('Ground terrain requires exactly one source ground');
      const converted = createGroundTerrain(recipe, instance, options.groundTerrain.spacing);
      if (options.groundTerrain.grid) {
        const explicit = validateTerrainGrid(options.groundTerrain.grid);
        if (
          explicit.spacing !== converted.grid.spacing ||
          explicit.columns !== converted.grid.columns ||
          explicit.rows !== converted.grid.rows ||
          explicit.origin.x !== converted.grid.origin.x ||
          explicit.origin.z !== converted.grid.origin.z
        )
          throw new Error('Explicit terrain grid must match the ground extent and selected spacing');
        converted.grid = structuredClone(explicit);
      }
      validateTerrainGrid(converted.grid);
      validateTerrainCoverage(converted.grid, base.bounds);
      privateTerrain = validateTerrainPrivateData({
        formatVersion: supportRules === undefined ? 1 : 2,
        generatorVersion:
          supportRules === undefined ? TERRAIN_GENERATOR_VERSION : TERRAIN_GENERATOR_VERSION_V2,
        worldId: base.worldId,
        grid: converted.grid,
        supports: supportRules ?? [],
      });
      const context = prepareTerrainBuildContext(converted.grid, converted.surfaces);
      for (const cellId of cellsIntersectingBounds(base.bounds, grid, extent)) {
        const cell = worldCellBounds(base.bounds, grid, cellId);
        const assetId = `${instance.assetId}-${cellId.replace('_', '-')}`;
        const boundary = rectangle(
          (cell.min.x + cell.max.x) / 2,
          (cell.min.z + cell.max.z) / 2,
          cell.max.x - cell.min.x,
          cell.max.z - cell.min.z,
        );
        const tiles = buildTerrainTiles({
          assetId,
          grid: converted.grid,
          surfaces: converted.surfaces,
          context,
          boundary,
          color: converted.color,
          merge: recipe.merge === true,
        });
        for (const { suffix, asset } of tiles) {
          const id = assetId + suffix;
          const entityId = `${instance.entityId}-${cellId}${suffix}`;
          if (compiled.has(id) || Object.hasOwn(catalog.assets, id))
            throw new Error(`Terrain asset conflicts with catalog: ${id}`);
          // Terrain vertices are in world coordinates, including any source ground translation.
          buildings.push({
            entityId,
            assetId: id,
            position: { x: 0, y: 0, z: 0 },
            rotation: { x: 0, y: 0, z: 0, w: 1 },
          });
          fixedInstanceIds.push(entityId);
          compiled.set(id, asset);
        }
      }
      continue;
    }
    for (const cellId of cellsIntersectingBounds(base.bounds, grid, extent)) {
      const cell = worldCellBounds(base.bounds, grid, cellId);
      const assetId = `${instance.assetId}-${cellId.replace('_', '-')}`;
      const tile: GroundRecipe = {
        ...recipe,
        min: [
          Math.max(extent.min.x, cell.min.x) - instance.position.x,
          Math.max(extent.min.z, cell.min.z) - instance.position.z,
        ],
        max: [
          Math.min(extent.max.x, cell.max.x) - instance.position.x,
          Math.min(extent.max.z, cell.max.z) - instance.position.z,
        ],
      };
      fixedInstanceIds.push(`${instance.entityId}-${cellId}`);
      buildings.push({ ...instance, entityId: `${instance.entityId}-${cellId}`, assetId });
      compiled.set(assetId, await compileAsset(assetId, descriptorPath, tile));
    }
  }
  if (options.groundTerrain && !privateTerrain) throw new Error('Ground terrain source is missing');
  // A catalog model is available even when this seed has no instance of it yet.
  for (const [assetId, path] of Object.entries(catalog.assets)) {
    if (compiled.has(assetId)) continue;
    const descriptorPath = sourceFile(dirname(catalogPath), path);
    const descriptor = await readJson(descriptorPath);
    if (descriptor.source?.kind !== 'ground')
      compiled.set(assetId, await compileAsset(assetId, descriptorPath));
  }
  for (const rule of supportRules ?? [])
    if (!compiled.has(rule.assetId))
      throw new Error(`Terrain support requires a published model asset: ${rule.assetId}`);
  const world: WorldDefinition = validateWorld({
    ...base,
    entities: options.groundTerrain?.statics ?? merged.statics,
    buildings,
    buildingAssets: Object.fromEntries([...compiled].map(([id, asset]) => [id, asset.physics])),
  });
  const publication = createWorldPublication(world, grid, Object.fromEntries(compiled));
  await writeWorldPublication(publication, outputDirectory);
  await writeAuthoringMetadata(
    world,
    publication.manifest,
    fixedInstanceIds,
    outputDirectory,
    privateTerrain ? jsonBytes(privateTerrain) : undefined,
  );
  const manifest = publication.manifest;
  return manifest;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const worldId of WORLDS) {
    const manifest = await buildWorld(
      `content/worlds/${worldId}/world.json`,
      `dist/worlds/${worldId}`,
    );
    const removed = await pruneWorldPublication(`dist/worlds/${worldId}`);
    console.log(
      `World ${manifest.worldId}: ${manifest.mapVersion.slice(0, 12)} (${Object.keys(manifest.assets).length} assets, ${removed} obsolete files removed)`,
    );
  }
}
