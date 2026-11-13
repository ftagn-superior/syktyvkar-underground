import { describe, expect, it } from 'vitest';
import {
  initialItemState,
  itemSupportDistance,
  type ItemState,
  type WorldDefinition,
} from '@su/contracts';
import { createAuthoritativeWorld } from '@su/simulation/server';
import {
  buildingFixture,
  physicsFixture,
} from '../../../../packages/simulation/src/test-fixture.js';
import { planTerrainItemPoses } from './terrain-item-poses.js';

const identity = { x: 0, y: 0, z: 0, w: 1 };
function fixture() {
  const sourceWorld = physicsFixture();
  sourceWorld.initialItems = [];
  sourceWorld.entities = sourceWorld.entities.filter((entity) => entity.entityId === 'floor');
  const targetWorld = structuredClone(sourceWorld);
  targetWorld.entities[0].entityId = 'new-ground';
  targetWorld.entities[0].position.y += 1;
  return { sourceWorld, targetWorld, sourceGroundIds: ['floor'], targetGroundIds: ['new-ground'] };
}
function crate(entityId = 'saved-crate', x = 0, y = 0.52, z = 6): ItemState {
  const item = initialItemState({
    seedId: entityId,
    typeId: 'wooden-crate',
    position: { x, y, z },
    rotation: identity,
  });
  item.revision = 19;
  item.placementVersion = 23;
  item.velocity = { x: 0.03, y: -0.04, z: 0.05 };
  item.angularVelocity = { x: -0.01, y: 0.02, z: 0.03 };
  return item;
}
function bench(world: WorldDefinition, id: string, x = 0, y = 1, width = 3) {
  world.entities.push({
    ...world.entities[0],
    entityId: id,
    position: { x, y, z: 6 },
    size: { x: width, y: 2, z: 2 },
  });
}
function nonY(item: ItemState) {
  const result = structuredClone(item);
  result.position.y = 0;
  result.safePose.position.y = 0;
  return result;
}

describe('terrain item pose planning', () => {
  it('moves full-shape ground contacts and preserves every other saved field and source input', async () => {
    const options = fixture();
    const item = crate();
    const before = structuredClone(item);
    const result = await planTerrainItemPoses({ ...options, sourceItems: [item] });
    expect(result.issues).toEqual([]);
    expect(result.targetItems[0].position.y).toBeCloseTo(1.52, 4);
    expect(result.targetItems[0].safePose.position.y).toBeCloseTo(1.52, 4);
    expect(nonY(result.targetItems[0])).toEqual(nonY(item));
    expect(item).toEqual(before);
    expect(result.audit).toHaveLength(2);
    expect(result.audit[0].support).toEqual({ kind: 'ground', entityIds: ['floor'] });
    expect(result.audit[0].targetSupportIds).toEqual(['new-ground']);
    expect(result.audit[0].clearance).toBeCloseTo(0.02, 5);
  });

  it('identifies physical bench and recovery ground independently', async () => {
    const options = fixture();
    bench(options.sourceWorld, 'bench');
    bench(options.targetWorld, 'bench', 0, 1.5);
    const item = crate('on-bench', 0, 2.52);
    item.safePose.position = { x: -6, y: 0.52, z: 6 };
    const result = await planTerrainItemPoses({ ...options, sourceItems: [item] });
    expect(result.issues).toEqual([]);
    expect(result.targetItems[0].position.y).toBeCloseTo(3.02, 4);
    expect(result.targetItems[0].safePose.position.y).toBeCloseTo(1.52, 4);
    expect(result.audit.map((entry) => entry.support.kind)).toEqual(['static', 'ground']);
  });

  it('preserves roof-relative height using the saved rotated building owner', async () => {
    const sourceWorld = buildingFixture('arch');
    sourceWorld.initialItems = [];
    const targetWorld = structuredClone(sourceWorld);
    targetWorld.buildings[1].position.y += 0.7;
    const item = crate('roof', 10, 4.02, 0);
    const result = await planTerrainItemPoses({
      sourceWorld,
      targetWorld,
      sourceItems: [item],
      sourceGroundIds: ['floor'],
      targetGroundIds: ['floor'],
    });
    expect(result.issues).toEqual([]);
    expect(result.targetItems[0].position.y).toBeCloseTo(4.72, 4);
    expect(result.audit[0].support).toEqual({ kind: 'static', entityIds: ['building-b'] });
  });

  it.each(['position', 'rotation', 'shape', 'removed'] as const)(
    'blocks %s changes of the supporting owner',
    async (change) => {
      const sourceWorld = buildingFixture('arch');
      sourceWorld.initialItems = [];
      const targetWorld = structuredClone(sourceWorld);
      if (change === 'position') targetWorld.buildings[0].position.x += 0.1;
      if (change === 'rotation')
        targetWorld.buildings[0].rotation = { x: 0, y: 0.1, z: 0, w: Math.sqrt(0.99) };
      if (change === 'shape') targetWorld.buildingAssets.arch.colliders[0].position.y += 0.1;
      if (change === 'removed') targetWorld.buildings.splice(0, 1);
      const result = await planTerrainItemPoses({
        sourceWorld,
        targetWorld,
        sourceItems: [crate('roof', 0, 4.02, 0)],
        sourceGroundIds: ['floor'],
        targetGroundIds: ['floor'],
      });
      expect(result.issues.map((issue) => issue.kind)).toEqual([
        'changed-item-support',
        'changed-item-support',
      ]);
    },
  );

  it('blocks airborne current pose even when its recovery pose rests on the ground', async () => {
    const options = fixture();
    const item = crate();
    item.position.y += 1;
    const result = await planTerrainItemPoses({ ...options, sourceItems: [item] });
    expect(result.issues).toEqual([
      expect.objectContaining({
        kind: 'airborne-item',
        message: expect.stringContaining('current:'),
      }),
    ]);
    expect(result.targetItems[0].position.y).toBe(item.position.y);
    expect(result.audit.map((entry) => entry.pose)).toEqual(['safePose']);
  });

  it('blocks two supports beneath opposite edges even when a central ray sees neither', async () => {
    const options = fixture();
    for (const world of [options.sourceWorld, options.targetWorld]) {
      bench(world, 'left', -0.35, 1, 0.15);
      bench(world, 'right', 0.35, 1, 0.15);
    }
    const result = await planTerrainItemPoses({
      ...options,
      sourceItems: [crate('bridge', 0, 2.52)],
    });
    expect(result.issues.map((issue) => issue.kind)).toEqual([
      'ambiguous-item-support',
      'ambiguous-item-support',
    ]);
    expect(result.issues[0].message).toContain('left, right');
  });

  it('rejects item-on-item support explicitly', async () => {
    const options = fixture();
    const result = await planTerrainItemPoses({
      ...options,
      sourceItems: [crate('lower'), crate('upper', 0, 1.54)],
    });
    expect(
      result.issues.some(
        (issue) =>
          issue.entityId === 'upper' &&
          issue.kind === 'changed-item-support' &&
          issue.message.includes('lower'),
      ),
    ).toBe(true);
  });

  it('treats adjacent ground tiles as one logical ground support', async () => {
    const options = fixture();
    options.sourceWorld.entities = [-1, 1].map((side) => ({
      ...options.sourceWorld.entities[0],
      entityId: `floor-${side}`,
      size: { x: 20, y: 1, z: 40 },
      position: { x: side * 10, y: -0.5, z: 0 },
    }));
    options.sourceGroundIds = ['floor--1', 'floor-1'];
    const result = await planTerrainItemPoses({ ...options, sourceItems: [crate()] });
    expect(result.issues).toEqual([]);
    expect(result.audit[0].support.entityIds).toEqual(['floor--1', 'floor-1']);
  });

  it('uses sphere contact geometry on a tilted ground surface', async () => {
    const options = fixture();
    const angle = 0.2;
    options.targetWorld.entities = [];
    options.targetWorld.buildingAssets['slope'] = {
      assetId: 'slope',
      bounds: { min: { x: -10, y: -1, z: -10 }, max: { x: 10, y: 0, z: 10 } },
      colliders: [
        {
          id: 'surface',
          kind: 'box',
          position: { x: 0, y: -0.5, z: 0 },
          rotation: identity,
          size: { x: 20, y: 1, z: 20 },
          friction: 0.6,
          restitution: 0,
        },
      ],
    };
    options.targetWorld.buildings = [
      {
        entityId: 'tilted-ground',
        assetId: 'slope',
        position: { x: 0, y: 1, z: 0 },
        rotation: { x: 0, y: 0, z: Math.sin(angle / 2), w: Math.cos(angle / 2) },
      },
    ];
    options.targetGroundIds = ['tilted-ground'];
    const item = initialItemState({
      seedId: 'ball',
      typeId: 'watermelon-ball',
      position: { x: 0, y: 0.615, z: 6 },
      rotation: identity,
    });
    const result = await planTerrainItemPoses({ ...options, sourceItems: [item] });
    expect(result.issues).toEqual([]);
    expect(result.targetItems[0].position.y).toBeCloseTo(1 + 0.6 / Math.cos(angle) + 0.015, 4);
  });

  it('finds target ground below an unrelated roof without placing the item on that roof', async () => {
    const options = fixture();
    bench(options.targetWorld, 'roof', 0, 4);
    const result = await planTerrainItemPoses({ ...options, sourceItems: [crate()] });
    expect(result.issues).toEqual([]);
    expect(result.targetItems[0].position.y).toBeCloseTo(1.52, 4);
    expect(result.audit[0].targetSupportIds).toEqual(['new-ground']);
  });

  it.each(['watermelon-ball', 'confidence-monument', 'giant-soap', 'giant-domino'])(
    'uses the real rotated %s shape',
    async (typeId) => {
      const options = fixture();
      const rotation = { x: 0, y: 0, z: Math.sin(0.3), w: Math.cos(0.3) };
      const y =
        itemSupportDistance(options.sourceWorld.itemCatalog.types[typeId], rotation, {
          x: 0,
          y: -1,
          z: 0,
        }) + 0.015;
      const item = initialItemState({
        seedId: `saved-${typeId}`,
        typeId,
        position: { x: 0, y, z: 6 },
        rotation,
      });
      const result = await planTerrainItemPoses({ ...options, sourceItems: [item] });
      expect(result.issues).toEqual([]);
      expect(result.targetItems[0].position.y - y).toBeCloseTo(1, 4);
      expect(nonY(result.targetItems[0])).toEqual(nonY(item));
    },
  );

  it('rejects new ambiguous target support and new target collisions', async () => {
    const options = fixture();
    bench(options.targetWorld, 'new-platform', 0, 0, 3);
    const ambiguous = await planTerrainItemPoses({ ...options, sourceItems: [crate()] });
    expect(ambiguous.issues.some((issue) => issue.kind === 'ambiguous-item-support')).toBe(true);
    options.targetWorld.entities.at(-1)!.position = { x: 0, y: 1.5, z: 6 };
    const blocked = await planTerrainItemPoses({ ...options, sourceItems: [crate()] });
    expect(blocked.issues.length).toBeGreaterThan(0);
  });

  it('does not change physics while collecting all owner contacts repeatedly', async () => {
    const world = physicsFixture();
    const simulation = await createAuthoritativeWorld(world);
    try {
      const before = simulation.getSnapshot();
      const pose = crate();
      for (let i = 0; i < 40; i++) {
        expect(
          simulation
            .queryItemSupports(pose.typeId, pose, {
              startY: 0.55,
              endY: 0.44,
              ignoreId: 'crate-01',
            })
            .some((hit) => hit.entityId === 'floor'),
        ).toBe(true);
      }
      expect(simulation.getSnapshot()).toEqual(before);
    } finally {
      simulation.dispose();
    }
  });

  it('expands an all-hit collector instead of losing owners at its initial capacity', async () => {
    const world = fixture().sourceWorld;
    for (let i = 0; i < 45; i++) bench(world, `support-${i}`, 0, 1, 0.2);
    const simulation = await createAuthoritativeWorld(world);
    try {
      const pose = crate('bridge', 0, 2.52);
      const hits = simulation.queryItemSupports(pose.typeId, pose, { startY: 2.55, endY: 2.44 });
      expect(new Set(hits.map((hit) => hit.entityId)).size).toBe(45);
    } finally {
      simulation.dispose();
    }
  });
});
