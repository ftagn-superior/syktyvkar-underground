import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { createWorldPublication, hash, jsonBytes, type CompiledWorldAsset } from './index.js';
import { createWorldGrid, loadCellPhysics, type WorldDefinition } from '@su/contracts';

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
