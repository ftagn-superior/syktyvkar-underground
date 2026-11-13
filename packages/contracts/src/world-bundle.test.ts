import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  loadWorldBundle,
  createWorldGrid,
  validateBuildingParts,
  validateBuildingPhysicsAsset,
  validateWorldCell,
  validateWorldManifest,
  worldPublicationBaseIdentity,
  changedWorldPublicationCells,
  type BuildingPhysicsAsset,
  type WorldManifest,
} from './index.js';

const instance = {
  entityId: 'building-a',
  assetId: 'house-a',
  position: { x: -8, y: 0, z: -14 },
  rotation: { x: 0, y: 0, z: 0, w: 1 },
};
const cell = {
  formatVersion: 2,
  cellId: '0_0',
  buildings: [instance],
  statics: JSON.parse(await readFile('content/worlds/physics-lab/world.json', 'utf8')).entities,
};
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
const base = {
  ...JSON.parse(await readFile('content/worlds/physics-lab/world.json', 'utf8')),
  itemCatalog: JSON.parse(await readFile('content/items/catalog.json', 'utf8')),
};
delete base.entities;
const hash = 'a'.repeat(64);
const manifest: WorldManifest = {
  formatVersion: 5,
  worldId: base.worldId,
  mapVersion: hash,
  simulationConfigHash: hash,
  bounds: base.bounds,
  grid: createWorldGrid(base.bounds, 125),
  worldFile: 'world.json',
  files: Object.fromEntries(
    ['world.json', 'cell.json', 'colliders.json', 'model.glb', 'parts.json'].map((path) => [
      path,
      hash,
    ]),
  ),
  cells: [{ cellId: '0_0', file: 'cell.json', bounds: base.bounds, assetIds: ['house-a'] }],
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
  it('tracks registered support geometry even when its cell and stable instance ID are unchanged', () => {
    const before = structuredClone(manifest);
    const id = `support-${'f'.repeat(64)}`;
    before.assets[id] = {
      ...before.assets['house-a'],
      assetId: id,
      modelFile: 'support.glb',
      collisionFile: 'support.json',
      partsFile: 'support-parts.json',
    };
    for (const file of ['support.glb', 'support.json', 'support-parts.json'])
      before.files[file] = hash;
    before.cells[0].assetIds = ['house-a', id];
    before.generatedSupports = { [id]: { ownerId: 'building-a', role: 'foundation' } };
    validateWorldManifest(before);
    const next = structuredClone(before);
    next.files['support.json'] = 'b'.repeat(64);
    expect(worldPublicationBaseIdentity(next)).toEqual(worldPublicationBaseIdentity(before));
    expect(changedWorldPublicationCells(before, next)).toEqual(['0_0']);
    const authored = structuredClone(next);
    delete authored.generatedSupports;
    expect(worldPublicationBaseIdentity(authored)).not.toEqual(worldPublicationBaseIdentity(next));
    expect(() =>
      validateWorldManifest({
        ...before,
        generatedSupports: { 'house-a': { ownerId: 'building-a', role: 'foundation' } },
      }),
    ).toThrow('generated support identity');
    expect(() =>
      validateWorldManifest({
        ...before,
        generatedSupports: { [id]: { ownerId: 'building-a', role: 'other' } },
      }),
    ).toThrow('generated support identity');
  });
  it('separates layout changes from changes to static dependency bytes', () => {
    const changed = structuredClone(manifest);
    changed.mapVersion = 'b'.repeat(64);
    changed.simulationConfigHash = 'c'.repeat(64);
    changed.files['cell.json'] = 'd'.repeat(64);
    expect(worldPublicationBaseIdentity(changed)).toEqual(worldPublicationBaseIdentity(manifest));
    const repacked = structuredClone(manifest);
    repacked.files['transport.pack'] = hash;
    repacked.cells[0].graphicsPacks = ['transport.pack'];
    repacked.cells[0].physicsPacks = ['transport.pack'];
    expect(changedWorldPublicationCells(manifest, repacked)).toEqual([]);
    for (const file of ['world.json', 'model.glb', 'colliders.json', 'parts.json']) {
      const incompatible = structuredClone(changed);
      incompatible.files[file] = 'e'.repeat(64);
      expect(worldPublicationBaseIdentity(incompatible)).not.toEqual(
        worldPublicationBaseIdentity(manifest),
      );
    }
  });
  it('validates the optional GLB instancing contract without changing ordinary parts', () => {
    expect(validateBuildingParts(parts)).toBe(parts);
    const instanced = {
      ...parts,
      renderMode: 'thin-instance',
      parts: parts.parts.map((part) => ({ ...part, occlusionGroup: null })),
    };
    expect(validateBuildingParts(instanced)).toBe(instanced);
    expect(() => validateBuildingParts({ ...instanced, renderMode: 'auto' })).toThrow(
      'render mode',
    );
    expect(() => validateBuildingParts({ ...instanced, parts: parts.parts })).toThrow(
      'individual occlusion',
    );
    expect(() => validateBuildingParts({ ...instanced, tree: {} })).toThrow(
      'cannot contain a tree recipe',
    );
  });
  it('rejects releases from before the instancing-only format', () => {
    expect(() => validateWorldManifest({ ...manifest, formatVersion: 4 })).toThrow(
      'manifest version',
    );
  });
  it.each(['graphicsPacks', 'physicsPacks'] as const)(
    'accepts optional %s only when all unique paths are listed',
    (kind) => {
      expect(validateWorldManifest(manifest)).toBe(manifest);
      const packed = structuredClone(manifest);
      packed.files['graphics/a.pack'] = hash;
      packed.cells[0][kind] = ['graphics/a.pack'];
      expect(validateWorldManifest(packed)).toBe(packed);
      packed.cells[0][kind]!.push('graphics/a.pack');
      expect(() => validateWorldManifest(packed)).toThrow('packs');
      packed.cells[0][kind] = ['graphics/missing.pack'];
      expect(() => validateWorldManifest(packed)).toThrow('unlisted file');
      packed.cells[0][kind] = ['../escape.pack'];
      expect(() => validateWorldManifest(packed)).toThrow();
    },
  );
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
