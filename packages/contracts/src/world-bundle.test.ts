import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  loadWorldBundle,
  validateBuildingParts,
  validateBuildingPhysicsAsset,
  validateWorldCell,
  validateWorldManifest,
  type BuildingPhysicsAsset,
  type WorldManifest,
} from './index.js';

const instance = {
  entityId: 'building-a',
  assetId: 'house-a',
  position: { x: -8, y: 0, z: -14 },
  rotation: { x: 0, y: 0, z: 0, w: 1 },
};
const cell = { formatVersion: 1, cellId: '0_0', buildings: [instance] };
const parts = {
  formatVersion: 1,
  assetId: 'house-a',
  parts: [{ partId: 'shell', role: 'wall', occlusionGroup: 'shell', nodeIndex: 0 }],
};
const asset: BuildingPhysicsAsset = {
  assetId: 'house-a',
  bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
  colliders: [
    {
      id: 'body',
      kind: 'mesh',
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      friction: 0.6,
      restitution: 0,
      vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
      indices: [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3],
    },
  ],
};
const base = JSON.parse(await readFile('content/worlds/physics-lab/world.json', 'utf8'));
const hash = 'a'.repeat(64);
const manifest: WorldManifest = {
  formatVersion: 2,
  worldId: base.worldId,
  mapVersion: hash,
  simulationConfigHash: hash,
  bounds: base.bounds,
  worldFile: 'world.json',
  files: Object.fromEntries(
    ['world.json', 'cell.json', 'colliders.json', 'model.glb', 'parts.json'].map((path) => [
      path,
      hash,
    ]),
  ),
  cells: [{ cellId: '0_0', file: 'cell.json', bounds: base.bounds }],
  assets: {
    'house-a': {
      assetId: 'house-a',
      version: hash,
      bounds: asset.bounds,
      modelFile: 'model.glb',
      collisionFile: 'colliders.json',
      partsFile: 'parts.json',
    },
  },
};

describe('world bundle validation', () => {
  it('requires strings for identifiers instead of coercing missing or numeric values', () => {
    for (const value of [undefined, null, 1, true]) {
      const checks: [string, () => unknown][] = [
        ['cell ID', () => validateWorldCell({ ...cell, cellId: value })],
        [
          'instance ID',
          () => validateWorldCell({ ...cell, buildings: [{ ...instance, entityId: value }] }),
        ],
        [
          'instance asset ID',
          () => validateWorldCell({ ...cell, buildings: [{ ...instance, assetId: value }] }),
        ],
        ['parts asset ID', () => validateBuildingParts({ ...parts, assetId: value })],
        [
          'part ID',
          () => validateBuildingParts({ ...parts, parts: [{ ...parts.parts[0], partId: value }] }),
        ],
        ['physics asset ID', () => validateBuildingPhysicsAsset({ ...asset, assetId: value })],
        [
          'collider ID',
          () =>
            validateBuildingPhysicsAsset({
              ...asset,
              colliders: [{ ...asset.colliders[0], id: value }],
            }),
        ],
        ['world ID', () => validateWorldManifest({ ...manifest, worldId: value })],
        [
          'manifest cell ID',
          () =>
            validateWorldManifest({
              ...manifest,
              cells: [{ ...manifest.cells[0], cellId: value }],
            }),
        ],
      ];
      for (const [label, validate] of checks)
        expect(validate, `${label}: ${String(value)}`).toThrow();
    }
    expect(() =>
      validateWorldCell({
        ...cell,
        buildings: [
          { ...instance, entityId: 1 },
          { ...instance, entityId: '1' },
        ],
      }),
    ).toThrow('building entityId');
    expect(
      validateWorldCell({ ...cell, buildings: [{ ...instance, entityId: '1' }] }).buildings[0]
        .entityId,
    ).toBe('1');
  });

  it('validates parsed physics assets before consuming their bounds or constructing a world', async () => {
    const load = (physics: unknown) => {
      const files: Record<string, unknown> = {
        'world.json': base,
        'cell.json': cell,
        'colliders.json': physics,
      };
      return loadWorldBundle(manifest, async (path) =>
        new TextEncoder().encode(JSON.stringify(files[path])),
      );
    };
    expect((await load(asset)).buildingAssets['house-a']).toEqual(asset);
    await expect(load(null)).rejects.toThrow('physics assetId');
    await expect(load({ ...asset, assetId: 'another-house' })).rejects.toThrow(
      'asset key disagrees',
    );
    const open = structuredClone(asset);
    if (open.colliders[0].kind !== 'mesh') throw new Error('mesh fixture required');
    open.colliders[0].indices.splice(0, 3);
    await expect(load(open)).rejects.toThrow('closed outward-oriented solid shells');
    const degenerate = structuredClone(asset);
    if (degenerate.colliders[0].kind !== 'mesh') throw new Error('mesh fixture required');
    degenerate.colliders[0].vertices[3] = 0;
    await expect(load(degenerate)).rejects.toThrow('closed outward-oriented solid shells');
  });
});
