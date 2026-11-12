import { BuildingColliders } from '../../packages/simulation/src/building-colliders.js';
import { createPhysicsWorld } from '../../packages/simulation/src/physics-world.js';
import { buildingFixture } from '../../packages/simulation/src/test-fixture.js';

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

/** The same native-resource and replay experiment runs in Node and real Chromium. */
export async function runStaticLifecycleProbe(
  wasm: Uint8Array | ArrayBuffer,
  kind: 'courtyard' | 'arch' = 'courtyard',
) {
  const definition = buildingFixture(kind);
  const [near, far] = definition.buildings;
  const asset = definition.buildingAssets[near.assetId];
  const world = await createPhysicsWorld({ ...definition, buildings: [] }, wasm, true);
  const buildings = new BuildingColliders(world.scene);
  try {
    world.createCharacter('own', { x: -6, y: 0.92, z: 0 });
    const controller = world.characters.get('own')!.controller;
    const baselineBodies = world.physics.getBodies().length;
    const baselineNodes = world.scene.transformNodes.length;
    buildings.add(near, asset);
    buildings.add(near, asset);
    buildings.add(far, asset);
    const nearBody = world.physics
      .getBodies()
      .find((body) => body.transformNode.name === near.entityId)!;
    const farBody = world.physics
      .getBodies()
      .find((body) => body.transformNode.name === far.entityId)!;
    const sharedShape = nearBody.shape!;
    check(sharedShape === farBody.shape, 'instances do not share the native shape');
    let sharedShapeReleases = 0;
    const disposeSharedShape = sharedShape.dispose.bind(sharedShape);
    sharedShape.dispose = () => {
      sharedShapeReleases++;
      disposeSharedShape();
    };
    check(world.physics.getBodies().length === baselineBodies + 2, 'duplicate cell created a body');
    check(buildings.diagnostics().assets === 1, 'shared shapes were duplicated');
    const sharedShapes = buildings.diagnostics().shapes;
    buildings.remove(near.entityId);
    check(!nearBody.isDisposed, 'first cell disposed the retained native body');
    check(buildings.diagnostics().references === 2, 'first cell released the retained instance');
    buildings.remove(far.entityId);
    check(farBody.isDisposed, 'last instance reference did not dispose native body');
    check(sharedShapeReleases === 0, 'shared native shape released early');
    check(
      buildings.diagnostics().shapes === sharedShapes,
      'shape freed while another body uses it',
    );

    let conflictRejected = false;
    try {
      buildings.add({ ...near, position: { x: 1, y: 0, z: 0 } }, asset);
    } catch {
      conflictRejected = true;
    }
    check(conflictRejected, 'conflicting ID accepted');
    conflictRejected = false;
    try {
      buildings.add(far, { ...asset, colliders: [] });
    } catch {
      conflictRejected = true;
    }
    check(conflictRejected, 'conflicting shared asset accepted');

    const samples = [];
    const timingsMs = [];
    for (let cycle = 0; cycle < 100; cycle++) {
      const start = performance.now();
      buildings.add(far, asset);
      const tile = world.createBox({
        ...definition.entities[0],
        entityId: `tile-${cycle}`,
        position: { x: 10, y: -0.5, z: 0 },
        size: { x: 10, y: 1, z: 10 },
      });
      world.characters.get('own')!.input = { moveX: 1, moveZ: 0 };
      world.advance(1 / 60);
      buildings.remove(far.entityId);
      tile.body.dispose();
      tile.shape.dispose();
      tile.node.dispose();
      timingsMs.push(performance.now() - start);
      check(
        world.characters.get('own')!.controller === controller,
        'cell change replaced controller',
      );
      check(
        world.physics.getBodies().length === baselineBodies + 1,
        'bodies accumulate after release',
      );
      check(
        world.scene.transformNodes.length === baselineNodes + 1,
        'nodes accumulate after release',
      );
      if (cycle % 20 === 19) samples.push(world.state('own').position);
    }
    check(
      world.state('own').position.x < (kind === 'courtyard' ? -3.7 : -2.7),
      'loaded building did not block movement',
    );

    // Simulate independent cell/history references over the existing 500ms replay window.
    buildings.add(near, asset); // history retains the collider before the cell lets go
    buildings.remove(near.entityId);
    const saved = world.state('own');
    for (let tick = 0; tick < 30; tick++) world.advance(1 / 60);
    const expected = world.state('own');
    world.restoreCharacter(saved);
    world.characters.get('own')!.input = { moveX: 1, moveZ: 0 };
    for (let tick = 0; tick < 30; tick++) world.advance(1 / 60);
    const actual = world.state('own');
    const replayDrift = Math.hypot(
      expected.position.x - actual.position.x,
      expected.position.y - actual.position.y,
      expected.position.z - actual.position.z,
    );
    check(replayDrift < 0.05, `retained-static replay drift: ${replayDrift}`);
    buildings.remove(near.entityId);
    check(buildings.diagnostics().shapes === 0, 'last reference did not release shapes');
    check(
      nearBody.isDisposed && Number(sharedShapeReleases) === 1,
      'last reference did not dispose native body/shape exactly once',
    );
    check(world.physics.getBodies().length === baselineBodies, 'final body count');
    check(world.scene.transformNodes.length === baselineNodes, 'final node count');
    return {
      result: 'passed',
      kind,
      cycles: timingsMs.length,
      baselineBodies,
      baselineNodes,
      sharedShapes,
      sharedShapeReleases,
      final: buildings.diagnostics(),
      replayDrift,
      samples,
      timingsMs,
      checks: [
        'shared shape',
        'duplicate ID',
        'conflicting definitions',
        'controller preserved',
        'near/far add/remove',
        'tile release',
        '500ms history retention',
        'last-reference release',
      ],
    };
  } finally {
    buildings.dispose();
    world.dispose();
  }
}
