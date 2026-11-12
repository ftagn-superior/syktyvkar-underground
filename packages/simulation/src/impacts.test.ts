import { describe, expect, it } from 'vitest';
import { createPhysicsWorld } from './physics-world.js';
import { loadServerWasm } from './server.js';
import { physicsFixture } from './test-fixture.js';
import { ImpactCollector, type PhysicsImpact } from './impacts.js';

describe('authoritative impact sounds with real Havok', () => {
  it('combines the four contact points of a falling crate and stays silent once resting', async () => {
    const definition = physicsFixture();
    definition.initialItems[0].position.y = 3;
    const world = await createPhysicsWorld(definition, await loadServerWasm(), false);
    const sounds: PhysicsImpact[] = [];
    let contacts = 0;
    world.plugin.onCollisionObservable.add(() => contacts++);
    try {
      for (let tick = 0; tick < 240; tick++) {
        world.advance(1 / 60);
        const current = world.drainImpacts();
        expect(current.length).toBeLessThanOrEqual(1);
        sounds.push(...current);
      }
      expect(contacts).toBeGreaterThan(20);
      expect(sounds).toHaveLength(1);
      expect(sounds[0]).toMatchObject({
        entityId: 'crate-01',
        typeId: 'wooden-crate',
        strength: 1,
      });
      expect(sounds[0].position.y).toBeLessThan(0.1);
      expect(world.drainImpacts()).toEqual([]);
    } finally {
      world.dispose();
    }
  });

  it('sounds the initial character push without ticking continuously while pushing', async () => {
    const world = await createPhysicsWorld(physicsFixture(), await loadServerWasm(), false);
    const player = world.createCharacter('actor', { x: 0, y: 0.92, z: 0 });
    const sounds: PhysicsImpact[] = [];
    try {
      player.input = { moveX: 0, moveZ: 1, sprint: false };
      for (let tick = 0; tick < 240; tick++) {
        world.advance(1 / 60);
        sounds.push(...world.drainImpacts());
      }
      expect(sounds.filter((event) => event.actorId === 'actor')).toHaveLength(1);
      expect(sounds[0].strength).toBeGreaterThan(0.1);
      expect(sounds[0].strength).toBeLessThanOrEqual(1);
    } finally {
      world.dispose();
    }
  });

  it('suppresses fresh placement impacts and discards buffered events after restore/removal', async () => {
    const definition = physicsFixture();
    definition.initialItems[0].position.y = 0.7;
    const world = await createPhysicsWorld(definition, await loadServerWasm(), false);
    try {
      world.suppressImpacts('crate-01');
      for (let tick = 0; tick < 60; tick++) world.advance(1 / 60);
      expect(world.drainImpacts()).toEqual([]);
      const item = world.objects.get('crate-01')!;
      world.teleport(item.body, item.node, { x: 0, y: 3, z: 6 });
      for (let tick = 0; tick < 50; tick++) world.advance(1 / 60);
      world.removeItem('crate-01');
      expect(world.drainImpacts()).toEqual([]);
      world.replaceItems([]);
      expect(world.drainImpacts()).toEqual([]);
    } finally {
      world.dispose();
    }
  });

  it('never collects prediction-world contacts', async () => {
    const world = await createPhysicsWorld(physicsFixture(), await loadServerWasm(), true);
    try {
      const player = world.createCharacter('predicted', { x: 0, y: 0.92, z: 0 });
      player.input = { moveX: 1, moveZ: 0, sprint: true };
      for (let tick = 0; tick < 100; tick++) world.advance(1 / 60);
      expect(world.drainImpacts()).toEqual([]);
    } finally {
      world.dispose();
    }
  });
});

it('bounds queued impact bursts and copies transient collision positions', () => {
  const collector = new ImpactCollector();
  const position = { x: 1, y: 2, z: 3 };
  for (let step = 0; step < 5; step++) {
    collector.beginStep(1 / 60);
    for (let n = 0; n < 100; n++)
      collector.record(
        `${step}-${n}`,
        {
          position,
          entityId: `item-${n}`,
          typeId: 'wooden-crate',
        },
        24,
        3,
      );
    collector.endStep();
  }
  position.x = 999;
  const events = collector.drain();
  expect(events).toHaveLength(32);
  expect(events.every((event) => event.position.x === 1)).toBe(true);
});
