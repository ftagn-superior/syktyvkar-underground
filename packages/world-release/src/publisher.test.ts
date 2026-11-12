import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { createWorldPublication, hash, jsonBytes, type CompiledWorldAsset } from './index.js';
import {
  createWorldGrid,
  loadCellPhysics,
  decodeGraphicsPack,
  GRAPHICS_PACK_LIMITS,
  type WorldDefinition,
} from '@su/contracts';

it('feeds a dense cell with 700 unique collision dependencies through a bounded producer', async () => {
  const authored = JSON.parse(await readFile('content/worlds/physics-lab/world.json', 'utf8'));
  const catalog = JSON.parse(await readFile('content/items/catalog.json', 'utf8'));
  const asset: CompiledWorldAsset = {
    version: 'a'.repeat(64),
    bounds: { min: { x: -0.5, y: 0, z: -0.5 }, max: { x: 0.5, y: 1, z: 0.5 } },
    model: new Uint8Array(),
    parts: jsonBytes({}),
    collision: new Uint8Array(),
    physics: {
      assetId: 'sample',
      bounds: { min: { x: -0.5, y: 0, z: -0.5 }, max: { x: 0.5, y: 1, z: 0.5 } },
      colliders: [],
    },
  };
  const assets: Record<string, CompiledWorldAsset> = {};
  const instances = Array.from({ length: 700 }, (_, i) => {
    const id = `decoration-${i}`;
    const physics = { ...asset.physics, assetId: id };
    assets[id] = { ...asset, version: hash(id), physics, collision: jsonBytes(physics) };
    return {
      entityId: id,
      assetId: id,
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
    };
  });
  const world: WorldDefinition = {
    ...authored,
    itemCatalog: catalog,
    buildings: instances,
    buildingAssets: Object.fromEntries(Object.entries(assets).map(([id, a]) => [id, a.physics])),
  };
  const { manifest, payloads } = createWorldPublication(
    world,
    createWorldGrid(world.bounds, 125),
    assets,
  );
  const packs = manifest.cells[0].graphicsPacks!;
  expect(packs).toHaveLength(2); // 1400 small files, bounded to 1024 entries per pack.
  const unpacked = new Map(
    packs.flatMap((path) => {
      const bytes = payloads.get(path)!;
      expect(hash(bytes)).toBe(manifest.files[path]);
      return [...decodeGraphicsPack(bytes)];
    }),
  );
  expect(unpacked.size).toBe(1400);
  expect([...unpacked.keys()].some((path) => path.endsWith('colliders.json'))).toBe(false);
  for (const [path, bytes] of unpacked) expect(bytes).toEqual(payloads.get(path));
  let active = 0,
    peak = 0,
    reads = 0;
  const set = await loadCellPhysics(manifest, '0_0', async (path) => {
    active++;
    peak = Math.max(peak, active);
    reads++;
    await new Promise<void>((resolve) => setImmediate(resolve));
    active--;
    return payloads.get(path)!;
  });
  expect(Object.keys(set.buildingAssets)).toHaveLength(700);
  expect(reads).toBe(701);
  expect(peak).toBeLessThanOrEqual(8);
  expect(active).toBe(0);
});

it('splits large graphics packs deterministically without changing individual files', async () => {
  const authored = JSON.parse(await readFile('content/worlds/physics-lab/world.json', 'utf8'));
  const itemCatalog = JSON.parse(await readFile('content/items/catalog.json', 'utf8'));
  const bounds = { min: { x: -0.5, y: 0, z: -0.5 }, max: { x: 0.5, y: 1, z: 0.5 } };
  const compiled: Record<string, CompiledWorldAsset> = {};
  const buildings = [4 * 1024 * 1024, 4 * 1024 * 1024, 1024 * 1024].map((size, i) => {
    const assetId = `model-${i}`;
    const physics = { assetId, bounds, colliders: [] };
    compiled[assetId] = {
      version: hash(assetId),
      bounds,
      physics,
      model: new Uint8Array(size),
      parts: jsonBytes({ assetId }),
      collision: jsonBytes(physics),
    };
    return {
      entityId: assetId,
      assetId,
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
    };
  });
  const world: WorldDefinition = {
    ...authored,
    itemCatalog,
    buildings,
    buildingAssets: Object.fromEntries(
      Object.entries(compiled).map(([id, asset]) => [id, asset.physics]),
    ),
  };
  const grid = createWorldGrid(world.bounds, 125);
  const first = createWorldPublication(world, grid, compiled);
  const second = createWorldPublication(world, grid, compiled);
  expect(first.manifest).toEqual(second.manifest);
  expect(first.manifest.formatVersion).toBe(4);
  const packedPaths = new Set<string>();
  for (const path of first.manifest.cells[0].graphicsPacks!) {
    const bytes = first.payloads.get(path)!;
    expect(bytes.length).toBeLessThanOrEqual(GRAPHICS_PACK_LIMITS.bytes);
    for (const entry of decodeGraphicsPack(bytes).keys()) packedPaths.add(entry);
  }
  expect(first.manifest.cells[0].graphicsPacks).toHaveLength(2);
  expect(packedPaths.has(first.manifest.assets['model-0'].modelFile)).toBe(true);
  expect(packedPaths.has(first.manifest.assets['model-1'].modelFile)).toBe(true);
  expect(packedPaths.has(first.manifest.assets['model-2'].modelFile)).toBe(true);
  expect(first.payloads.get(first.manifest.assets['model-2'].modelFile)!.length).toBe(1024 * 1024);
});

it('shares border assets without duplicating bytes or bundling unrelated neighboring objects', async () => {
  const authored = JSON.parse(await readFile('content/worlds/physics-lab/world.json', 'utf8'));
  authored.bounds.max.x = 230;
  const itemCatalog = JSON.parse(await readFile('content/items/catalog.json', 'utf8'));
  const bounds = { min: { x: -0.5, y: 0, z: -0.5 }, max: { x: 0.5, y: 1, z: 0.5 } };
  const compiled: Record<string, CompiledWorldAsset> = {};
  const buildings = [0, 105, 150].map((x, i) => {
    const assetId = `part-${i}`;
    const physics = { assetId, bounds, colliders: [] };
    compiled[assetId] = {
      version: hash(assetId),
      bounds,
      physics,
      model: new Uint8Array([i]),
      parts: jsonBytes({ assetId }),
      collision: jsonBytes(physics),
    };
    return {
      entityId: assetId,
      assetId,
      position: { x, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
    };
  });
  const world: WorldDefinition = {
    ...authored,
    itemCatalog,
    buildings,
    buildingAssets: Object.fromEntries(
      Object.entries(compiled).map(([id, asset]) => [id, asset.physics]),
    ),
  };
  const { manifest, payloads } = createWorldPublication(
    world,
    createWorldGrid(world.bounds, 125),
    compiled,
  );
  expect(manifest.cells).toHaveLength(2);
  const packs = [...payloads].filter(([path]) => path.endsWith('.pack'));
  expect(packs).toHaveLength(3);
  const allEntries = packs.flatMap(([, bytes]) => [...decodeGraphicsPack(bytes).keys()]);
  expect(allEntries).toHaveLength(6);
  expect(new Set(allEntries).size).toBe(6);
  for (const cell of manifest.cells) {
    expect(cell.graphicsPacks).toHaveLength(2);
    const actual = cell
      .graphicsPacks!.flatMap((path) => [...decodeGraphicsPack(payloads.get(path)!).keys()])
      .sort();
    const expected = cell.assetIds
      .flatMap((id) => [manifest.assets[id].modelFile, manifest.assets[id].partsFile])
      .sort();
    expect(actual).toEqual(expected);
  }
  expect(
    manifest.cells[0].graphicsPacks!.filter((path) =>
      manifest.cells[1].graphicsPacks!.includes(path),
    ),
  ).toHaveLength(1);
});

it('packs procedural tree metadata while preserving the original GLB for older clients and republication', async () => {
  const authored = JSON.parse(await readFile('content/worlds/physics-lab/world.json', 'utf8'));
  const itemCatalog = JSON.parse(await readFile('content/items/catalog.json', 'utf8'));
  const assetId = 'tree-pilot';
  const bounds = { min: { x: -2, y: 0, z: -2 }, max: { x: 2, y: 10, z: 2 } };
  const physics = { assetId, bounds, colliders: [] };
  const parts = jsonBytes({
    formatVersion: 1,
    assetId,
    parts: [{ partId: 'fading', role: 'wall', occlusionGroup: 'shell', nodeIndex: 0 }],
    tree: {
      formatVersion: 1,
      crowns: [
        [1, 2, 3, 3],
        [2, 0.5, 6, 4],
      ],
      trunk: [0.3, 4, 0.3, 0],
      trunkBase: 0,
      crownColor: '#55813f',
      trunkColor: '#704a31',
    },
  });
  const compiled = {
    [assetId]: {
      version: hash(parts),
      bounds,
      physics,
      parts,
      collision: jsonBytes(physics),
      model: new Uint8Array([1, 2, 3, 4]),
    },
  };
  const world: WorldDefinition = {
    ...authored,
    itemCatalog,
    buildingAssets: { [assetId]: physics },
    buildings: [
      {
        entityId: 'tree-1',
        assetId,
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
      },
    ],
  };
  const grid = createWorldGrid(world.bounds, 125);
  const first = createWorldPublication(world, grid, compiled);
  const asset = first.manifest.assets[assetId];
  const entries = new Map(
    first.manifest.cells.flatMap((cell) =>
      (cell.graphicsPacks ?? []).flatMap((path) => [
        ...decodeGraphicsPack(first.payloads.get(path)!),
      ]),
    ),
  );
  expect(entries.has(asset.partsFile)).toBe(true);
  expect(entries.has(asset.modelFile)).toBe(false);
  expect(first.payloads.get(asset.modelFile)).toEqual(compiled[assetId].model);
  expect(first.manifest.files[asset.modelFile]).toBe(hash(compiled[assetId].model));
  expect(createWorldPublication(world, grid, compiled).manifest).toEqual(first.manifest);
});
