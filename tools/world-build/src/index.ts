import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, sep } from 'node:path';
import { validateBytes } from 'gltf-validator';
import {
  WORLD_FORMAT_VERSION,
  type WorldManifest,
  canonicalJson,
  validateWorld,
  validateWorldCell,
  validateBuildingPhysicsAsset,
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
  validateBuildingParts,
  validateWorldPlacementAssets,
  type WorldPlacementPolicy,
} from '@su/contracts';
import {
  createWorldPublication,
  writeWorldPublication,
  writeAuthoringMetadata,
  pruneWorldPublication,
  authoringMetadata,
} from '@su/world-release';
import { encodeStaticGlb, inspectStaticGlb, staticMeshBounds } from './glb.js';
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
import {
  readWorldModelSources,
  createWorldModelCatalog,
  writeWorldModelCatalog,
  readPlacementPolicySource,
} from './model-catalog.js';

/** Миры, которые собирает `pnpm world:build`. Первый обслуживается сервером по умолчанию. */
export const WORLDS = ['ring-block', 'physics-lab', 'streaming-lab'] as const;
const generators = {
  house: (id: string, recipe: unknown) => generateHouse(id, recipe as HouseRecipe),
  footprint: (id: string, recipe: unknown) => generateFootprint(id, recipe as FootprintRecipe),
  ground: (id: string, recipe: unknown) => generateGround(id, recipe as GroundRecipe),
  kit: (id: string, recipe: unknown) => generateKit(id, recipe as KitRecipe),
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
  let inspected: { parts: BuildingParts; bounds: BuildingPhysicsAsset['bounds'] };
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
    inspected = inspectStaticGlb(model, assetId, descriptor.renderMode);
  } else {
    if (!treeParts) throw new Error(`Missing tree representation: ${assetId}`);
    if (descriptor.renderMode !== undefined)
      throw new Error(`GLB render mode cannot contain a tree recipe: ${assetId}`);
    inspected = { parts: treeParts, bounds: physics.bounds };
  }
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
    parts = jsonBytes(validateBuildingParts(inspected.parts));
  if (
    collision.byteLength > WORLD_RESOURCE_LIMITS.collisionBytes ||
    parts.byteLength > WORLD_RESOURCE_LIMITS.partsBytes
  )
    throw new Error(`Model metadata byte limit: ${assetId}`);
  const version = hash(
    canonicalJson({
      ...(model === undefined ? {} : { model: hash(model) }),
      collision: hash(collision),
      parts: hash(parts),
    }),
  );
  return { model, collision, parts, version, physics, bounds: inspected.bounds };
}

export async function buildWorld(
  source = 'content/worlds/ring-block/world.json',
  output?: string,
  modelCatalogOutput?: string,
): Promise<WorldManifest> {
  const authored = (await readJson(source)) as WorldSource;
  if (
    authored.formatVersion !== WORLD_FORMAT_VERSION ||
    !Array.isArray(authored.cells) ||
    authored.cells.length > 10_000 ||
    typeof authored.assetCatalog !== 'string' ||
    typeof authored.itemCatalog !== 'string'
  )
    throw new Error('World source must use formatVersion 4, cells, itemCatalog and assetCatalog');
  const base: WorldHeader = {
    formatVersion: WORLD_FORMAT_VERSION,
    worldId: authored.worldId,
    bounds: authored.bounds,
    simulation: authored.simulation,
    spawnPoints: authored.spawnPoints,
    itemCatalog: await readJson(resolve(dirname(resolve(source)), authored.itemCatalog)),
    initialItems: authored.initialItems,
    // Необязательное поле не записывается вовсе, чтобы не менять хеши миров без подписей.
    ...(authored.landmarks ? { landmarks: authored.landmarks } : {}),
    ...(authored.routes ? { routes: authored.routes } : {}),
  };
  validateWorldHeader(base);
  const grid = createWorldGrid(base.bounds, authored.cellSize ?? 125);
  const outputDirectory = output ?? `dist/worlds/${base.worldId}`;
  const sourceDirectory = dirname(resolve(source));
  const catalogPath = resolve(sourceDirectory, authored.assetCatalog);
  const modelSources = await readWorldModelSources(catalogPath);
  const policySource = await readPlacementPolicySource(source, authored, modelSources);
  const runtimeAssetIds: Record<string, string[]> = Object.fromEntries(
    Object.keys(modelSources.models).map((id) => [id, []]),
  );
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
  if (authored.entities?.length)
    authoredCells.push({
      formatVersion: 2,
      cellId: 'source-statics',
      statics: authored.entities,
      buildings: [],
    });
  const merged = mergeWorldCells(authoredCells);
  const buildings: WorldDefinition['buildings'] = [];
  const fixedInstanceIds: string[] = [];
  const compiled = new Map<string, Awaited<ReturnType<typeof compileAsset>>>();
  for (const instance of merged.buildings) {
    if (!Object.hasOwn(modelSources.models, instance.assetId))
      throw new Error(`Unknown building asset ${instance.assetId}`);
    const { path: descriptorPath, descriptor } = modelSources.models[instance.assetId];
    if (descriptor.source?.kind !== 'ground') {
      buildings.push(instance);
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
      if (!runtimeAssetIds[instance.assetId].includes(assetId))
        runtimeAssetIds[instance.assetId].push(assetId);
    }
  }
  // A catalog model is available even when this seed has no instance of it yet.
  for (const [assetId, { path, descriptor }] of Object.entries(modelSources.models)) {
    if (descriptor.source.kind !== 'ground') {
      runtimeAssetIds[assetId] = [assetId];
      if (!compiled.has(assetId)) compiled.set(assetId, await compileAsset(assetId, path));
    }
  }
  const world: WorldDefinition = validateWorld({
    ...base,
    entities: merged.statics,
    buildings,
    buildingAssets: Object.fromEntries([...compiled].map(([id, asset]) => [id, asset.physics])),
  });
  const publication = createWorldPublication(world, grid, Object.fromEntries(compiled));
  const modelCatalog = createWorldModelCatalog(
    modelSources,
    publication.manifest,
    authoringMetadata(world, publication.manifest, fixedInstanceIds).assetReleaseVersion,
    runtimeAssetIds,
  );
  const placementPolicy: WorldPlacementPolicy | undefined = policySource
    ? {
        formatVersion: 1,
        worldId: base.worldId,
        assetReleaseVersion: modelCatalog.assetReleaseVersion,
        assetIds: [...policySource.assetIds].sort(),
      }
    : undefined;
  if (placementPolicy)
    validateWorldPlacementAssets(
      placementPolicy,
      modelCatalog,
      publication.manifest,
      world,
      Object.fromEntries(
        [...compiled].map(([assetId, asset]) => [
          assetId,
          JSON.parse(new TextDecoder().decode(asset.parts)),
        ]),
      ),
      fixedInstanceIds,
    );
  await writeWorldPublication(publication, outputDirectory);
  await writeAuthoringMetadata(world, publication.manifest, fixedInstanceIds, outputDirectory);
  await writeWorldModelCatalog(
    modelCatalog,
    modelCatalogOutput ??
      (output ? resolve(outputDirectory, 'model-catalog') : `dist/model-catalogs/${base.worldId}`),
    placementPolicy,
  );
  const manifest = publication.manifest;
  return manifest;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const worldId of WORLDS) {
    const manifest = await buildWorld(
      `content/worlds/${worldId}/world.json`,
      `dist/worlds/${worldId}`,
      `dist/model-catalogs/${worldId}`,
    );
    const removed = await pruneWorldPublication(`dist/worlds/${worldId}`);
    console.log(
      `World ${manifest.worldId}: ${manifest.mapVersion.slice(0, 12)} (${Object.keys(manifest.assets).length} assets, ${removed} obsolete files removed)`,
    );
  }
}
