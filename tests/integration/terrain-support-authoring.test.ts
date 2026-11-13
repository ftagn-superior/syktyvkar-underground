import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildWorld } from '../../tools/world-build/src/index.js';
import { readAuthoringRelease } from '../../apps/server/src/layout/release.js';
import type { FoundationSupportRuleV2 } from '../../packages/terrain-build/src/private-data.js';

const rule: FoundationSupportRuleV2 = {
  kind: 'foundation-v2',
  assetId: 'test-house',
  components: [
    {
      outline: [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ],
    },
  ],
  jointY: 0,
  clearance: 0.08,
  burial: 0.1,
  color: '#888888',
};

describe('explicit support rules in authored flat releases', () => {
  let directory: string, sourcePath: string;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'support-authoring-'));
    const source = JSON.parse(await readFile('content/worlds/physics-lab/world.json', 'utf8'));
    const bounds = { min: { x: -4, y: -5, z: -4 }, max: { x: 4, y: 10, z: 4 } };
    Object.assign(source, {
      worldId: 'support-test',
      bounds,
      entities: [],
      spawnPoints: [-3, 3].flatMap((z) => [-3, -1, 1, 3].map((x) => ({ x, y: 0, z }))),
      initialItems: [],
      cells: ['cell.json'],
      itemCatalog: 'items.json',
      assetCatalog: 'assets/catalog.json',
      cellSize: 8,
    });
    const save = async (path: string, value: unknown) => {
      const file = join(directory, path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(value));
    };
    await save('world.json', source);
    await save('items.json', JSON.parse(await readFile('content/items/catalog.json', 'utf8')));
    await save('cell.json', {
      formatVersion: 2,
      worldId: 'support-test',
      cellId: '0_0',
      bounds,
      statics: [],
      buildings: ['test-ground', 'test-house'].map((assetId) => ({
        entityId: assetId === 'test-ground' ? 'ground' : 'owner',
        assetId,
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
      })),
    });
    await save('assets/catalog.json', {
      formatVersion: 1,
      assets: { 'test-ground': 'ground/asset.json', 'test-house': 'house/asset.json' },
    });
    await save('assets/ground/asset.json', {
      formatVersion: 1,
      assetId: 'test-ground',
      source: { kind: 'ground', file: 'source.json' },
    });
    await save('assets/ground/source.json', {
      formatVersion: 1,
      min: [-4, -4],
      max: [4, 4],
      depth: 1,
      color: '#999999',
      merge: true,
      layers: [],
    });
    await save('assets/house/asset.json', {
      formatVersion: 1,
      assetId: 'test-house',
      source: { kind: 'footprint', file: 'source.json' },
    });
    await save('assets/house/source.json', {
      formatVersion: 1,
      outline: rule.components[0].outline,
      height: 3,
      floors: 1,
      windows: false,
      wallColor: '#999999',
      roofColor: '#555555',
      windowColor: '#333333',
    });
    sourcePath = join(directory, 'world.json');
  });
  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('publishes only private v2 inputs while keeping public models, seeds and default v1 bytes unchanged', async () => {
    const plainPath = join(directory, 'plain'),
      rulesPath = join(directory, 'with-rules');
    const plainManifest = await buildWorld(sourcePath, plainPath, {
      groundTerrain: { spacing: 4 },
    });
    const rulesManifest = await buildWorld(sourcePath, rulesPath, {
      groundTerrain: { spacing: 4, supports: [rule] },
    });
    expect(rulesManifest).toEqual(plainManifest);
    const plain = await readAuthoringRelease(plainPath),
      supported = await readAuthoringRelease(rulesPath);
    expect(plain.terrain).toMatchObject({
      formatVersion: 1,
      generatorVersion: 'terrain-build/1',
      supports: [],
    });
    expect(supported.terrain).toMatchObject({
      formatVersion: 2,
      generatorVersion: 'terrain-build/2',
      supports: [rule],
    });
    expect(supported.seed).toEqual(plain.seed);
    expect(supported.seed[0].position.y).toBe(0);
    expect(supported.metadata.seedVersion).toBe(plain.metadata.seedVersion);
    expect(supported.metadata.assetReleaseVersion).not.toBe(plain.metadata.assetReleaseVersion);
    expect(Object.keys(rulesManifest.assets).sort()).toEqual(['test-ground-0-0', 'test-house']);
    expect(Object.keys(rulesManifest.files).every((file) => !file.startsWith('private/'))).toBe(
      true,
    );
  });

  it('accepts explicit overrides for future placed owners absent from the authoring seed', async () => {
    const override = { ...rule, ownerId: 'placed_12c7b37d-9c21-4dbf-ad39-e937d80d819b' };
    const output = join(directory, 'future-owner');
    await buildWorld(sourcePath, output, { groundTerrain: { spacing: 4, supports: [override] } });
    const release = await readAuthoringRelease(output);
    expect(release.terrain?.supports).toEqual([override]);
    expect(release.seed.map((instance) => instance.entityId)).toEqual(['owner']);
    expect(release.seed[0].position.y).toBe(0);
  });

  it('authors explicit nonflat geometry, seed poses, spawns and boundaries without editing source files', async () => {
    const sourceBefore = await readFile(sourcePath);
    const cellBefore = await readFile(join(directory, 'cell.json'));
    const source = JSON.parse(sourceBefore.toString());
    const grid = {
      formatVersion: 1 as const,
      origin: { x: -4, z: -4 },
      spacing: 4,
      columns: 3,
      rows: 3,
      bottom: -3,
      heights: [1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8],
    };
    const header = {
      bounds: { ...source.bounds, max: { ...source.bounds.max, y: 14 } },
      spawnPoints: source.spawnPoints.map((p: { x: number; y: number; z: number }) => ({
        ...p,
        y: 2,
      })),
      initialItems: [],
    };
    const statics = [
      {
        entityId: 'boundary-test',
        kind: 'obstacle' as const,
        position: { x: 3.8, y: 1, z: 0 },
        size: { x: 0.2, y: 4, z: 8 },
        mass: 0,
        friction: 0.6,
        restitution: 0,
        color: '#888888',
      },
    ];
    const output = join(directory, 'explicit-relief');
    await buildWorld(sourcePath, output, {
      groundTerrain: { spacing: 4, grid, supports: [rule], header, statics, seedY: { owner: 2.1 } },
    });
    const release = await readAuthoringRelease(output);
    expect(release.terrain?.grid).toEqual(grid);
    expect(release.seed[0].position.y).toBe(2.1);
    expect(release.definition.bounds).toEqual(header.bounds);
    expect(release.definition.spawnPoints).toEqual(header.spawnPoints);
    expect(release.definition.entities).toEqual(statics);
    const ground =
      release.definition.buildingAssets[
        release.definition.buildings.find((b) => b.entityId !== 'owner')!.assetId
      ];
    expect(ground.bounds.max.y).toBeCloseTo(1.8);
    expect(await readFile(sourcePath)).toEqual(sourceBefore);
    expect(await readFile(join(directory, 'cell.json'))).toEqual(cellBefore);
    await expect(
      buildWorld(sourcePath, join(directory, 'bad-grid'), {
        groundTerrain: { spacing: 4, grid: { ...grid, origin: { x: -3, z: -4 } } },
      }),
    ).rejects.toThrow('must match the ground extent');
    await expect(
      buildWorld(sourcePath, join(directory, 'bad-seed'), {
        groundTerrain: { spacing: 4, seedY: { missing: 2 } },
      }),
    ).rejects.toThrow('Invalid explicit terrain seed height');
  });

  it('rejects unavailable models and invalid support data before publication', async () => {
    await expect(
      buildWorld(sourcePath, join(directory, 'missing'), {
        groundTerrain: { spacing: 4, supports: [{ ...rule, assetId: 'missing' }] },
      }),
    ).rejects.toThrow(/Unknown terrain support asset/);
    await expect(
      buildWorld(sourcePath, join(directory, 'invalid'), {
        groundTerrain: { spacing: 4, supports: [{ ...rule, burial: 0 }] },
      }),
    ).rejects.toThrow(/Invalid foundation support/);
  });
});
