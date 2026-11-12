import { describe, expect, it } from 'vitest';
import { initialItemState, type StaticEntityDefinition, type WorldHeader } from '@su/contracts';
import { buildingFixture } from './test-fixture.js';
import { createPhysicsWorld } from './physics-world.js';
import { loadServerWasm } from './server.js';
import { createLocalPredictionWorld } from './prediction.js';

function fixture() {
  const full = buildingFixture('arch');
  const { entities, buildings, buildingAssets, ...common } = full;
  const header: WorldHeader = {
    ...common,
  };
  return { header, entities, buildings, buildingAssets };
}
describe('local static physics', () => {
  it('deduplicates cell references, rejects changed versions, keeps the controller and frees the final shapes', async () => {
    const { header, entities, buildings, buildingAssets } = fixture();
    const world = await createPhysicsWorld(header, await loadServerWasm(), true);
    try {
      const character = world.createCharacter('self', { x: -10, y: 0.92, z: 0 });
      const floor = entities[0] as StaticEntityDefinition;
      for (let cycle = 0; cycle < 3; cycle++) {
        for (let reference = 0; reference < 4; reference++) {
          world.retainStatic(floor, 'map');
          world.retainStatic(buildings[0], 'arch-v1', buildingAssets.arch);
        }
        expect(world.staticDiagnostics()).toMatchObject({
          entities: 2,
          references: 8,
          buildings: { instances: 1, assets: 1 },
          bodies: 3,
        });
        expect(() => world.retainStatic(buildings[0], 'arch-v2', buildingAssets.arch)).toThrow(
          'version',
        );
        for (let step = 0; step < 30; step++) world.advance(1 / 60);
        expect(world.state('self').position.y).toBeCloseTo(0.9, 1);
        for (let reference = 0; reference < 4; reference++) {
          world.releaseStatic(floor.entityId);
          world.releaseStatic(buildings[0].entityId);
        }
        expect(world.characters.get('self')!.controller).toBe(character.controller);
        expect(world.staticDiagnostics()).toMatchObject({
          entities: 0,
          references: 0,
          buildings: { instances: 0, assets: 0, shapes: 0 },
          bodies: 1,
        });
      }
    } finally {
      world.dispose();
    }
    expect(world.staticDiagnostics().bodies).toBe(0);
  });
  it('removes and recreates remote proxies with empty local items while prediction continues', async () => {
    const { header } = fixture();
    const world = await createPhysicsWorld(header, await loadServerWasm(), true);
    const character = world.createCharacter('self', { x: -10, y: 0.92, z: 0 });
    const self = world.state('self');
    const remote = { ...self, entityId: 'remote' };
    const item = initialItemState(header.initialItems[0]);
    try {
      for (let cycle = 0; cycle < 3; cycle++) {
        world.setRemoteSnapshot({ scope: 'local', players: [self, remote], items: [item] }, 'self');
        expect(world.staticDiagnostics()).toMatchObject({
          items: 1,
          remotePlayers: 1,
          bodies: 3,
        });
        world.setRemoteSnapshot({ scope: 'local', players: [self], items: [] }, 'self');
        world.advance(1 / 60);
        expect(world.staticDiagnostics()).toMatchObject({
          items: 0,
          remotePlayers: 0,
          bodies: 1,
        });
        expect(world.characters.get('self')!.controller).toBe(character.controller);
      }
      expect(() => world.snapshot()).toThrow('full server world');
    } finally {
      world.dispose();
    }
    const prediction = await createLocalPredictionWorld(header, await loadServerWasm());
    try {
      prediction.reconcile(self, { scope: 'local', players: [self], items: [] });
      const advanced = prediction.step({ moveX: 1, moveZ: 0 });
      expect(advanced.position.x).toBeGreaterThan(self.position.x);
      prediction.syncRemote(
        {
          scope: 'local',
          items: [],
          players: [self, { ...self, entityId: 'other', position: { ...self.position, x: 5 } }],
        },
        self.entityId,
      );
      expect(prediction.getState()).toEqual(advanced);
      expect(prediction.staticDiagnostics().remotePlayers).toBe(1);
      prediction.syncRemote({ scope: 'local', players: [self], items: [] }, self.entityId);
      expect(prediction.getState()).toEqual(advanced);
      expect(prediction.staticDiagnostics().remotePlayers).toBe(0);
    } finally {
      prediction.dispose();
    }
    await expect(createPhysicsWorld(header, await loadServerWasm(), false)).rejects.toThrow(
      'complete world',
    );
  });
});
