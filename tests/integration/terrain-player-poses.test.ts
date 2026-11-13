import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  initialItemState,
  sampleTerrain,
  type WorldDefinition,
} from '../../packages/contracts/src/index.js';
import { buildWorld } from '../../tools/world-build/src/index.js';
import { readAuthoringRelease } from '../../apps/server/src/layout/release.js';
import {
  planTerrainPlayerPoses,
  type TerrainPlayerPoseOptions,
} from '../../apps/server/src/layout/terrain-player-poses.js';

let temporary: string, flat: WorldDefinition, slope: WorldDefinition;
beforeAll(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'su-terrain-player-poses-'));
  await buildWorld('content/worlds/physics-lab/world.json', join(temporary, 'flat'));
  await buildWorld('content/worlds/terrain-lab/world.json', join(temporary, 'slope'));
  flat = (await readAuthoringRelease(join(temporary, 'flat'))).definition;
  flat.buildings = [];
  flat.entities = flat.entities.filter((e) => e.entityId === 'ground-01');
  slope = (await readAuthoringRelease(join(temporary, 'slope'))).definition;
  slope.buildings = slope.buildings.filter((b) => b.assetId.startsWith('terrain-tile-'));
});
afterAll(async () => {
  if (temporary) await rm(temporary, { recursive: true, force: true });
});

function fixture(): TerrainPlayerPoseOptions {
  const sourceWorld = structuredClone(flat),
    targetWorld = structuredClone(flat);
  targetWorld.entities[0].position.y += 2;
  return {
    sourceWorld,
    targetWorld,
    sourcePlayers: [
      { accountId: 'account-a', worldId: flat.worldId, position: { x: 0, y: 0.92, z: 0 } },
    ],
    sourceItems: [],
    targetItems: [],
    sourceGroundIds: ['ground-01'],
    targetGroundIds: ['ground-01'],
  };
}

describe('saved capsule terrain transfer', () => {
  it('moves the exact saved center once and permits overlapping offline account positions', async () => {
    const options = fixture();
    options.sourcePlayers.push({
      ...structuredClone(options.sourcePlayers[0]),
      accountId: 'account-b',
    });
    const before = structuredClone(options);
    const result = await planTerrainPlayerPoses(options);
    expect(result.issues).toEqual([]);
    expect(result.audit).toHaveLength(2);
    for (const player of result.targetPlayers)
      expect(player.position).toEqual({ x: 0, y: expect.closeTo(2.92, 4), z: 0 });
    expect(options).toEqual(before);
  });

  it('uses the full capsule contact on a terrain slope rather than a center ray', async () => {
    const options = fixture();
    options.targetWorld = structuredClone(slope);
    options.targetGroundIds = slope.buildings.map((b) => b.entityId);
    options.sourcePlayers[0].position = { x: -4, y: 0.92, z: -4 };
    const grid = JSON.parse(await readFile('content/worlds/terrain-lab/terrain.json', 'utf8'));
    const surface = sampleTerrain(grid, -4, -4)!;
    const result = await planTerrainPlayerPoses(options);
    expect(result.issues).toEqual([]);
    const center = result.targetPlayers[0].position;
    expect(center.x).toBe(-4);
    expect(center.z).toBe(-4);
    // The capsule also touches neighbouring facets; the center triangle's plane
    // is an analytical approximation within 3 mm on this curved terrain.
    expect(
      Math.abs(center.y - (surface.height + 0.92 + 0.35 * (1 / surface.normal.y - 1))),
    ).toBeLessThan(0.003);
    expect(center.y).toBeGreaterThan(surface.height + 0.922);
    expect(result.audit[0].clearance).toBeCloseTo(0.02, 4);
  });

  it('retains an unchanged platform and translates its center by the platform delta', async () => {
    const options = fixture();
    const platform = {
      ...structuredClone(flat.entities[0]),
      entityId: 'platform',
      position: { x: 0, y: 1.5, z: 0 },
      size: { x: 3, y: 1, z: 3 },
    };
    options.sourceWorld.entities.push(platform);
    options.targetWorld.entities.push({
      ...structuredClone(platform),
      position: { x: 0, y: 4.5, z: 0 },
    });
    options.sourcePlayers[0].position.y = 2.92;
    const result = await planTerrainPlayerPoses(options);
    expect(result.issues).toEqual([]);
    expect(result.targetPlayers[0].position.y).toBeCloseTo(5.92, 5);
    expect(result.audit[0].sourceSupportIds).toEqual(['platform']);
    options.targetWorld.entities.at(-1)!.size.x += 1;
    expect((await planTerrainPlayerPoses(options)).issues[0].kind).toBe('changed-player-support');
  });

  it.each([
    'airborne',
    'blocked',
    'ambiguous',
    'shape',
    'dynamic-source',
    'dynamic-target',
  ] as const)('rejects %s positions without a fallback or reset', async (kind) => {
    const options = fixture();
    if (kind === 'airborne') options.sourcePlayers[0].position.y += 1;
    if (kind === 'blocked')
      options.targetWorld.entities.push({
        ...structuredClone(flat.entities[0]),
        entityId: 'ceiling',
        position: { x: 0, y: 3, z: 0 },
        size: { x: 2, y: 1, z: 2 },
      });
    if (kind === 'ambiguous')
      options.sourceWorld.entities.push({
        ...structuredClone(flat.entities[0]),
        entityId: 'overlapping-support',
      });
    if (kind === 'shape') options.targetWorld.simulation.character.radius += 0.1;
    if (kind.startsWith('dynamic')) {
      const item = initialItemState({
        seedId: 'obstacle',
        typeId: 'wooden-crate',
        position: { x: 0, y: kind === 'dynamic-source' ? 0.5 : 2.5, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
      });
      if (kind === 'dynamic-source') {
        options.sourceItems = [item];
        options.sourcePlayers[0].position.y = 1.92;
      } else options.targetItems = [item];
    }
    const result = await planTerrainPlayerPoses(options);
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.targetPlayers).toEqual(options.sourcePlayers);
    expect(result.audit).toEqual([]);
  });
});
