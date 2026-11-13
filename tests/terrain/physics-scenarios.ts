import {
  createPhysicsWorld,
  type WasmBinary,
} from '../../packages/simulation/src/physics-world.js';
import {
  sampleTerrain,
  initialItemState,
  type TerrainGrid,
  type WorldDefinition,
} from '../../packages/contracts/src/index.js';

const check = (value: unknown, label: string) => {
  if (!value) throw new Error(label);
};
export async function terrainPhysicsScenarios(
  world: WorldDefinition,
  grid: TerrainGrid,
  wasm: WasmBinary,
) {
  const p = await createPhysicsWorld({ ...world, initialItems: [] }, wasm, false);
  const result = {
    rays: 0,
    maxRayError: 0,
    maxFootGap: 0,
    maxRestDrift: 0,
    routes: [] as { sprint: boolean; steps: number; end: { x: number; y: number; z: number } }[],
    ballCrossedX: false,
    ballCrossedZ: false,
    supportedSpawns: 0,
    placementSummit: false,
    placementSlope: false,
  };
  try {
    for (const spawn of world.spawnPoints) {
      check(p.findSpawn(undefined, spawn), `Unsupported or blocked spawn ${JSON.stringify(spawn)}`);
      result.supportedSpawns++;
    }
    for (const [x, z] of [
      [0, 0],
      [0, 5],
      [5, 0],
      [-0.37, 2.13],
      [8, -4],
      [15, -18],
      [-4, -12],
      [18, 12],
    ]) {
      const hit = p.surfaceRay({ x, y: 15, z }, { x, y: -8, z });
      check(hit, 'Missing terrain ray');
      const error = Math.abs(hit!.point.y - sampleTerrain(grid, x, z)!.height);
      result.maxRayError = Math.max(result.maxRayError, error);
      result.rays++;
      check(error <= 0.01, 'Ray differs from final terrain');
    }
    for (const sprint of [false, true]) {
      const spawn = { x: -4, y: sampleTerrain(grid, -4, 17)!.height, z: 17 };
      p.createCharacter('route', p.findSpawn(undefined, spawn)!);
      let steps = 0;
      const targets = [
        [-4, 5],
        [-2, 2],
        [6, -2],
        [8, -6],
        [8, -17],
        [8, -19],
        [19, -19],
        [19, -10],
        [18, -10],
        [19, -10],
        [19, -19],
        [8, -19],
        [8, -17],
        [1, -17],
        [1, -15],
        [1, -8.5],
        [1, -15],
        [1, -17],
        [8, -17],
        [8, -6],
        [6, -2],
        [-2, 2],
        [-4, 5],
        [-4, 17],
      ];
      for (const [x, z] of targets) {
        let reached = false;
        for (let i = 0; i < 1500; i++) {
          const s = p.state('route'),
            dx = x - s.position.x,
            dz = z - s.position.z,
            d = Math.hypot(dx, dz);
          if (d < 0.14) {
            reached = true;
            break;
          }
          // Slow down near a waypoint so sprint acceptance does not oscillate across it.
          p.characters.get('route')!.input = {
            moveX: dx / d,
            moveZ: dz / d,
            sprint: sprint && d > 1,
          };
          p.advance(1 / 60);
          steps++;
          const now = p.state('route'),
            h = sampleTerrain(grid, now.position.x, now.position.z)?.height;
          check(h !== undefined && now.position.y > h + 0.8, 'Character fell through terrain');
          const approach =
            now.position.x > 0.2 &&
            now.position.x < 1.8 &&
            now.position.z >= -15 &&
            now.position.z <= -5;
          if (!approach) {
            const gap = now.position.y - world.simulation.character.height / 2 - h!;
            result.maxFootGap = Math.max(result.maxFootGap, gap);
            check(
              gap < 0.18,
              `Character lost slope contact: ${JSON.stringify({ gap, sprint, target: [x, z], position: now.position, grounded: now.grounded })}`,
            );
          }
        }
        check(reached, `Route stuck at ${x},${z}: ${JSON.stringify(p.state('route').position)}`);
      }
      result.routes.push({ sprint, steps, end: p.state('route').position });
      p.removeCharacter('route');
    }
    const rest = { x: -4, y: sampleTerrain(grid, -4, -4)!.height, z: -4 };
    p.createCharacter('rest', p.findSpawn(undefined, rest)!);
    for (let i = 0; i < 120; i++) p.advance(1 / 60);
    const start = p.state('rest').position;
    for (let i = 0; i < 600; i++) p.advance(1 / 60);
    const end = p.state('rest').position;
    result.maxRestDrift = Math.hypot(end.x - start.x, end.y - start.y, end.z - start.z);
    check(result.maxRestDrift < 0.01, 'Stopped character slides on the slope');
    p.removeCharacter('rest');
    const normal = sampleTerrain(grid, 2, -1)!.normal;
    p.addItem(
      initialItemState({
        seedId: 'seam-ball',
        typeId: 'watermelon-ball',
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        position: { x: 2, y: sampleTerrain(grid, 2, -1)!.height + 0.6 / normal.y + 0.02, z: -1 },
      }),
    );
    for (let i = 0; i < 600; i++) {
      p.advance(1 / 60);
      const ball = p.snapshot().items[0];
      if (ball.position.x < 0) result.ballCrossedX = true;
      if (ball.position.z > 0) result.ballCrossedZ = true;
      const terrain = sampleTerrain(grid, ball.position.x, ball.position.z);
      if (terrain) check(ball.position.y > terrain.height + 0.4, 'Ball penetrates terrain');
    }
    // A sphere on flat terrain needs a small push to exercise the same seams.
    if (!grid.heights.every((h) => h === 0))
      check(result.ballCrossedX && result.ballCrossedZ, 'Ball did not cross both seams');
    const summitPose = {
      position: { x: 18, y: 6.515, z: -10 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
    };
    if (grid.heights.every((h) => h === 0)) summitPose.position.y = 0.515;
    result.placementSummit = p.checkPlacement('wooden-crate', summitPose) === undefined;
    check(result.placementSummit, 'Crate cannot be placed on summit');
    const s = sampleTerrain(grid, 8, -4)!;
    result.placementSlope =
      p.checkPlacement('watermelon-ball', {
        position: { x: 8, y: s.height + 0.615 / s.normal.y, z: -4 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
      }) === undefined;
    check(result.placementSlope, 'Sphere cannot be placed on slope');
    return result;
  } finally {
    p.dispose();
  }
}
