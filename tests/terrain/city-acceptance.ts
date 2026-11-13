import {
  buildingBounds,
  primitiveBounds,
  sampleTerrain,
  type TerrainGrid,
  type Vec3,
  type WorldDefinition,
  type WorldManifest,
} from '../../packages/contracts/src/index.js';
import {
  createPhysicsWorld,
  type PhysicsWorld,
  type WasmBinary,
} from '../../packages/simulation/src/physics-world.js';

export type CityPoint = [number, number];
export interface CityAcceptanceControls {
  formatVersion: 1;
  routes: { id: string; points: CityPoint[] }[];
  /** Explicit open points in the full city; an obstructed control is a failure, not skipped. */
  openRayPoints: CityPoint[];
  restPoints: CityPoint[];
  expectedSpawns: number;
  /** Every matching primitive is exercised at its midpoint and both shared edges. */
  boundaryPrefix: string;
}
export interface CityAcceptanceIssue {
  scenario: string;
  message: string;
}
const limits = {
  rayErrorMetres: 0.01,
  waypointDistanceMetres: 0.15,
  minimumFootGapMetres: -0.05,
  maximumFootGapMetres: 0.2,
  restDriftMetres: 0.01,
  stoppingDriftMetres: 0.02,
  boundaryDriveSeconds: 2,
  restSettleSeconds: 2,
  restHoldSeconds: 10,
  outerRayInsetMetres: 0.001,
};
const distance = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const check = (value: unknown, message: string): void => {
  if (!value) throw new Error(message);
};
const uniquePoints = (points: CityPoint[]) => [
  ...new Map(points.map((p) => [p.join(','), p])).values(),
];
const distribution = (values: number[]) => {
  const sorted = values.slice().sort((a, b) => a - b);
  return {
    count: values.length,
    p50: sorted[Math.ceil(sorted.length * 0.5) - 1] ?? null,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null,
    max: sorted.at(-1) ?? null,
  };
};

/** Functional server-physics acceptance of the exact published city, with no DB or simulation reseeding. */
export async function cityTerrainAcceptance(
  world: WorldDefinition,
  manifest: WorldManifest,
  grid: TerrainGrid,
  groundIds: readonly string[],
  controls: CityAcceptanceControls,
  wasm: WasmBinary,
) {
  check(
    controls.formatVersion === 1 &&
      controls.routes.length > 0 &&
      controls.openRayPoints.length > 0 &&
      controls.restPoints.length > 0,
    'Incomplete city acceptance controls',
  );
  check(
    Number.isSafeInteger(controls.expectedSpawns) && controls.expectedSpawns > 0,
    'Invalid spawn count',
  );
  check(controls.boundaryPrefix.length > 0, 'Boundary prefix is required');
  for (const route of controls.routes) {
    check(route.id && route.points.length >= 2, 'A route needs an ID and at least two points');
    for (const point of route.points)
      check(point.length === 2 && point.every(Number.isFinite), 'Invalid route point');
    check(
      route.points
        .slice(1)
        .reduce(
          (sum, point, index) =>
            sum + Math.hypot(point[0] - route.points[index][0], point[1] - route.points[index][1]),
          0,
        ) > 1,
      'A route must cover more than one metre',
    );
  }
  const ground = new Set(groundIds),
    issues: CityAcceptanceIssue[] = [];
  const groundBuildings = world.buildings.filter((owner) => ground.has(owner.entityId));
  const groundEntities = world.entities.filter((owner) => ground.has(owner.entityId));
  check(
    ground.size > 0 && ground.size === groundBuildings.length + groundEntities.length,
    'Ground IDs must identify existing unique static owners',
  );
  const dt = 1 / world.simulation.tickRate;
  const stepTimes: number[] = [];
  const step = (physics: PhysicsWorld) => {
    const start = performance.now();
    physics.advance(dt);
    stepTimes.push(performance.now() - start);
  };
  const scenario = async (id: string, run: () => void | Promise<void>) => {
    try {
      await run();
    } catch (error) {
      issues.push({
        scenario: id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const surface = (point: CityPoint) => {
    const value = sampleTerrain(grid, point[0], point[1]);
    check(value, `Outside terrain: ${point}`);
    return { x: point[0], y: value!.height, z: point[1] };
  };
  const rayFrom = (point: CityPoint) => ({ x: point[0], y: world.bounds.max.y + 1, z: point[1] });
  const rayTo = (point: CityPoint) => ({ x: point[0], y: grid.bottom - 1, z: point[1] });
  const rays: {
    point: CityPoint;
    kind: 'terrain-resource' | 'open-city';
    heightError: number | null;
    entityId?: string;
  }[] = [];
  const ray = (physics: PhysicsWorld, point: CityPoint, kind: 'terrain-resource' | 'open-city') => {
    const hit = physics.surfaceRay(rayFrom(point), rayTo(point));
    const expected = surface(point);
    const error = hit ? Math.abs(hit.point.y - expected.y) : null;
    rays.push({
      point,
      kind,
      heightError: error,
      ...(hit?.entityId ? { entityId: hit.entityId } : {}),
    });
    check(
      hit && ground.has(hit.entityId!),
      `Missing/open terrain ray at ${point}; hit ${hit?.entityId ?? 'none'}`,
    );
    check(error! <= limits.rayErrorMetres, `Terrain ray error ${error} at ${point}`);
  };
  // Isolate only the geometry comparison. Movement, spawn and stop tests below always keep the full city.
  const resourcePoints: CityPoint[] = [];
  for (const bounds of [
    ...groundBuildings.map((owner) =>
      buildingBounds(owner, world.buildingAssets[owner.assetId].bounds),
    ),
    ...groundEntities.map(primitiveBounds),
  ])
    for (const x of [bounds.min.x, (bounds.min.x + bounds.max.x) / 2, bounds.max.x])
      for (const z of [bounds.min.z, (bounds.min.z + bounds.max.z) / 2, bounds.max.z])
        resourcePoints.push([
          Math.max(
            world.bounds.min.x + limits.outerRayInsetMetres,
            Math.min(world.bounds.max.x - limits.outerRayInsetMetres, x),
          ),
          Math.max(
            world.bounds.min.z + limits.outerRayInsetMetres,
            Math.min(world.bounds.max.z - limits.outerRayInsetMetres, z),
          ),
        ]);
  let started = performance.now();
  const groundWorld = await createPhysicsWorld(
    {
      ...world,
      initialItems: [],
      buildings: groundBuildings,
      entities: groundEntities,
      buildingAssets: Object.fromEntries(
        groundBuildings.map((owner) => [owner.assetId, world.buildingAssets[owner.assetId]]),
      ),
    },
    wasm,
    false,
  );
  const terrainCreationMs = performance.now() - started;
  try {
    for (const point of uniquePoints(resourcePoints))
      await scenario(`terrain-ray:${point}`, () => ray(groundWorld, point, 'terrain-resource'));
  } finally {
    groundWorld.dispose();
  }
  started = performance.now();
  const city = await createPhysicsWorld({ ...world, initialItems: [] }, wasm, false);
  const cityCreationMs = performance.now() - started;
  const spawns: { point: Vec3; position?: Vec3 }[] = [];
  const routes: {
    id: string;
    sprint: boolean;
    direction: 'forward' | 'reverse';
    status: 'passed' | 'failed';
    points: CityPoint[];
    reached: number;
    steps: number;
    distanceMetres: number;
    minFootGap: number;
    maxFootGap: number;
    maximumUngroundedSeconds: number;
    seamCrossings: { x: number; z: number };
    heightRange: [number, number];
    start?: Vec3;
    end?: Vec3;
    stoppingDrift?: number;
  }[] = [];
  const rests: { point: CityPoint; start?: Vec3; end?: Vec3; maximumDrift?: number }[] = [];
  const boundaries: {
    entityId: string;
    side: string;
    tangent: number;
    scope: 'full-city' | 'ground-and-boundaries';
    startAttempts?: { inset: number; point: Vec3; free: boolean }[];
    occludedStart?: boolean;
    blockingEntityId?: string;
    start?: Vec3;
    end?: Vec3;
    steps: number;
  }[] = [];
  const initialBodies = city.staticDiagnostics();
  let boundaryWorld: PhysicsWorld | undefined;
  const reachedEndpoints = new Map<string, Vec3>();
  const actorId = '__city-acceptance';
  const create = (point: CityPoint) => {
    const position = city.findSpawn(undefined, surface(point));
    check(position, `No free supported capsule at ${point}`);
    return city.createCharacter(actorId, position!);
  };
  const inspect = () => {
    const state = city.state(actorId),
      h = sampleTerrain(grid, state.position.x, state.position.z);
    check(h, `Character left the terrain: ${JSON.stringify(state.position)}`);
    check(
      state.position.y - world.simulation.character.height / 2 >= h!.height - 0.05,
      `Character penetrated the terrain: ${JSON.stringify(state.position)}`,
    );
    const hit = city.surfaceRay(
      state.position,
      { ...state.position, y: state.position.y - world.simulation.character.height - 2 },
      actorId,
    );
    check(
      hit && hit.normal.y >= 0.5,
      `Missing walking support at ${JSON.stringify(state.position)}`,
    );
    const slope = world.simulation.character.radius * (1 / hit!.normal.y - 1);
    return {
      state,
      gap: state.position.y - world.simulation.character.height / 2 - hit!.point.y - slope,
    };
  };
  try {
    await scenario('spawn-count', () =>
      check(
        world.spawnPoints.length === controls.expectedSpawns,
        `Expected ${controls.expectedSpawns} spawns, got ${world.spawnPoints.length}`,
      ),
    );
    for (const point of world.spawnPoints)
      await scenario(`spawn:${point.x},${point.z}`, () => {
        const position = city.findSpawn(undefined, point);
        spawns.push({ point, ...(position ? { position } : {}) });
        check(position, `Unsupported or obstructed spawn at ${JSON.stringify(point)}`);
      });
    for (const point of uniquePoints(controls.openRayPoints))
      await scenario(`city-ray:${point}`, () => ray(city, point, 'open-city'));
    for (const route of controls.routes)
      for (const sprint of [false, true])
        for (const direction of ['forward', 'reverse'] as const) {
          const points = direction === 'forward' ? route.points : route.points.slice().reverse();
          const record: (typeof routes)[number] = {
            id: route.id,
            sprint,
            direction,
            status: 'failed',
            points,
            reached: 0,
            steps: 0,
            distanceMetres: 0,
            minFootGap: Infinity,
            maxFootGap: -Infinity,
            maximumUngroundedSeconds: 0,
            seamCrossings: { x: 0, z: 0 },
            heightRange: [Infinity, -Infinity],
          };
          routes.push(record);
          await scenario(`route:${route.id}:${sprint ? 'sprint' : 'walk'}:${direction}`, () => {
            const endpointKey = `${route.id}:${sprint}`;
            const endpoint = reachedEndpoints.get(endpointKey);
            if (direction === 'reverse')
              check(endpoint, 'Return route requires a reached forward endpoint');
            // The return starts at the reached physical pose, which may stand on
            // an approach above the grid. Never invent a spawn at terrain Y there.
            const actor =
              direction === 'forward'
                ? create(points[0])
                : city.createCharacter(actorId, endpoint!);
            record.start = { ...city.state(actorId).position };
            let previous = city.state(actorId).position,
              ungrounded = 0;
            const cell = (position: Vec3, axis: 'x' | 'z') =>
              Math.floor((position[axis] - manifest.grid.origin[axis]) / manifest.grid.cellSize);
            try {
              for (const point of points.slice(1)) {
                const initialDistance = Math.hypot(point[0] - previous.x, point[1] - previous.z);
                const budget = Math.ceil(
                  ((initialDistance /
                    (sprint
                      ? world.simulation.character.sprintSpeed
                      : world.simulation.character.speed)) *
                    3 +
                    10) /
                    dt,
                );
                let reached = false;
                for (let tick = 0; tick < budget; tick++) {
                  const state = city.state(actorId),
                    dx = point[0] - state.position.x,
                    dz = point[1] - state.position.z,
                    d = Math.hypot(dx, dz);
                  if (d <= limits.waypointDistanceMetres) {
                    reached = true;
                    record.reached++;
                    break;
                  }
                  actor.input = { moveX: dx / d, moveZ: dz / d, sprint: sprint && d > 1 };
                  step(city);
                  record.steps++;
                  const now = inspect();
                  record.distanceMetres += distance(now.state.position, previous);
                  for (const axis of ['x', 'z'] as const)
                    record.seamCrossings[axis] += Math.abs(
                      cell(previous, axis) - cell(now.state.position, axis),
                    );
                  previous = { ...now.state.position };
                  record.minFootGap = Math.min(record.minFootGap, now.gap);
                  record.maxFootGap = Math.max(record.maxFootGap, now.gap);
                  record.heightRange = [
                    Math.min(record.heightRange[0], previous.y),
                    Math.max(record.heightRange[1], previous.y),
                  ];
                  ungrounded = now.state.grounded ? 0 : ungrounded + dt;
                  record.maximumUngroundedSeconds = Math.max(
                    record.maximumUngroundedSeconds,
                    ungrounded,
                  );
                  check(
                    now.gap >= limits.minimumFootGapMetres &&
                      now.gap <= limits.maximumFootGapMetres,
                    `Walking support gap ${now.gap} at ${JSON.stringify(previous)}`,
                  );
                }
                check(reached, `Route stuck before ${point}; actual ${JSON.stringify(previous)}`);
              }
              actor.input = { moveX: 0, moveZ: 0, sprint: false };
              const stop = { ...city.state(actorId).position };
              for (let i = 0; i < Math.ceil(2 / dt); i++) step(city);
              record.stoppingDrift = distance(city.state(actorId).position, stop);
              check(
                record.stoppingDrift <= limits.stoppingDriftMetres,
                `Stopping drift ${record.stoppingDrift}`,
              );
              record.status = 'passed';
            } finally {
              record.end = { ...city.state(actorId).position };
              if (direction === 'forward' && record.status === 'passed')
                reachedEndpoints.set(endpointKey, record.end);
              city.removeCharacter(actorId);
            }
          });
        }
    await scenario('route-seams', () => {
      for (const axis of ['x', 'z'] as const) {
        const cells = axis === 'x' ? manifest.grid.columns : manifest.grid.rows;
        if (cells > 1)
          check(
            routes.some((route) => route.status === 'passed' && route.seamCrossings[axis] > 0),
            `No successful city route crossed a ${axis} cell seam`,
          );
      }
    });
    for (const point of controls.restPoints) {
      const record: (typeof rests)[number] = { point };
      rests.push(record);
      await scenario(`rest:${point}`, () => {
        create(point);
        try {
          for (let tick = 0; tick < Math.ceil(limits.restSettleSeconds / dt); tick++) step(city);
          record.start = { ...city.state(actorId).position };
          record.maximumDrift = 0;
          for (let tick = 0; tick < Math.ceil(limits.restHoldSeconds / dt); tick++) {
            step(city);
            inspect();
            record.maximumDrift = Math.max(
              record.maximumDrift,
              distance(city.state(actorId).position, record.start),
            );
          }
          record.end = { ...city.state(actorId).position };
          check(
            record.maximumDrift <= limits.restDriftMetres,
            `Cumulative rest drift ${record.maximumDrift}`,
          );
        } finally {
          city.removeCharacter(actorId);
        }
      });
    }
    const walls = world.entities.filter((entity) =>
      entity.entityId.startsWith(controls.boundaryPrefix),
    );
    await scenario('boundary-count', () =>
      check(walls.length >= 4, 'Fewer than four declared boundary segments'),
    );
    for (const wall of walls) {
      const axis = wall.size.x > wall.size.z ? 'z' : 'x';
      const sign =
        Math.abs(wall.position[axis] - world.bounds.min[axis]) <
        Math.abs(wall.position[axis] - world.bounds.max[axis])
          ? -1
          : 1;
      const side = `${axis}:${sign}`;
      const tangent = axis === 'x' ? 'z' : 'x';
      const positions = [
        ...new Set(
          [-0.5, 0, 0.5].map((fraction) =>
            Math.max(
              world.bounds.min[tangent] + 1.25,
              Math.min(
                world.bounds.max[tangent] - 1.25,
                wall.position[tangent] + fraction * wall.size[tangent],
              ),
            ),
          ),
        ),
      ];
      for (const coordinate of positions) {
        const record: (typeof boundaries)[number] = {
          entityId: wall.entityId,
          side,
          tangent: coordinate,
          scope: 'full-city',
          steps: 0,
        };
        boundaries.push(record);
        await scenario(`boundary:${wall.entityId}:${coordinate}`, async () => {
          const pointAt = (inset: number) => {
            const point = {
              ...wall.position,
              [axis]: wall.position[axis] - sign * (wall.size[axis] / 2 + inset),
              [tangent]: coordinate,
            };
            return surface([point.x, point.z]);
          };
          const drive = (
            physics: PhysicsWorld,
            entry: typeof record,
            position: Vec3,
            requireBoundary: boolean,
          ) => {
            const actor = physics.createCharacter(actorId, position);
            entry.start = { ...position };
            actor.input = {
              moveX: axis === 'x' ? sign : 0,
              moveZ: axis === 'z' ? sign : 0,
              sprint: true,
            };
            try {
              for (let tick = 0; tick < Math.ceil(limits.boundaryDriveSeconds / dt); tick++) {
                step(physics);
                entry.steps++;
                const p = physics.state(actorId).position;
                check(
                  p.x > world.bounds.min.x &&
                    p.x < world.bounds.max.x &&
                    p.z > world.bounds.min.z &&
                    p.z < world.bounds.max.z,
                  `Boundary escaped at ${JSON.stringify(p)}`,
                );
                check(
                  p.y > surface([p.x, p.z]).y + world.simulation.character.height / 2 - 0.05,
                  'Fell below boundary ground',
                );
              }
              entry.end = { ...physics.state(actorId).position };
              const innerFace = wall.position[axis] - (sign * wall.size[axis]) / 2;
              const separation = sign * (innerFace - entry.end[axis]);
              if (requireBoundary)
                check(
                  separation > 0 && separation < world.simulation.character.radius + 0.15,
                  `Did not contact intended boundary; separation ${separation}`,
                );
              else {
                // A closed full-city start is not a passed boundary probe: record
                // the actual intervening solid and separately exercise this exact
                // boundary seam with only the unrelated city geometry removed.
                const blocker = physics.surfaceRay(
                  entry.end,
                  {
                    ...entry.end,
                    [axis]: (sign < 0 ? world.bounds.min[axis] : world.bounds.max[axis]) + sign,
                  },
                  actorId,
                );
                check(
                  blocker?.entityId && !ground.has(blocker.entityId),
                  'No city barrier protects the obstructed boundary probe',
                );
                check(
                  sign * (entry.end[axis] - entry.start[axis]) > 0.05,
                  'City barrier probe did not advance from its free start',
                );
                entry.blockingEntityId = blocker!.entityId;
              }
            } finally {
              physics.removeCharacter(actorId);
            }
          };
          record.startAttempts = [];
          let position: Vec3 | undefined;
          for (const inset of [
            1,
            world.simulation.character.radius + 0.25,
            world.simulation.character.radius + 0.05,
          ]) {
            const point = pointAt(inset);
            position = city.findSpawn(undefined, point);
            record.startAttempts.push({ inset, point, free: !!position });
            if (position) break;
          }
          record.occludedStart = !position;
          if (!position) {
            for (const inset of [5, 6]) {
              const point = pointAt(inset);
              position = city.findSpawn(undefined, point);
              record.startAttempts.push({ inset, point, free: !!position });
              if (position) break;
            }
          }
          check(position, `No free supported boundary start at tangent ${coordinate}`);
          drive(city, record, position!, !record.occludedStart);
          if (record.occludedStart) {
            boundaryWorld ??= await createPhysicsWorld(
              {
                ...world,
                initialItems: [],
                buildings: groundBuildings,
                entities: [...groundEntities, ...walls],
                buildingAssets: Object.fromEntries(
                  groundBuildings.map((owner) => [
                    owner.assetId,
                    world.buildingAssets[owner.assetId],
                  ]),
                ),
              },
              wasm,
              false,
            );
            const isolated: typeof record = {
              entityId: wall.entityId,
              side,
              tangent: coordinate,
              scope: 'ground-and-boundaries',
              steps: 0,
            };
            boundaries.push(isolated);
            const isolatedPosition = boundaryWorld.findSpawn(undefined, pointAt(1));
            check(isolatedPosition, 'Boundary-only confirmation has no supported start');
            drive(boundaryWorld, isolated, isolatedPosition!, true);
          }
        });
      }
    }
    await scenario('boundary-sides', () =>
      check(
        new Set(boundaries.map((wall) => wall.side)).size === 4,
        'Boundary probes must cover all four sides',
      ),
    );
  } finally {
    boundaryWorld?.dispose();
    city.dispose();
  }
  return {
    formatVersion: 1,
    status: issues.length ? 'failed' : 'passed',
    scope:
      'Published full-city movement, spawns, stops and boundaries; terrain-only ray comparison and explicit ground+boundary confirmation for city-obstructed probes. No room, network, saved-state migration or GPU measurement.',
    fullGameplayAcceptance: false,
    performanceAcceptance: false,
    worldId: world.worldId,
    mapVersion: manifest.mapVersion,
    groundIds: [...ground],
    controls,
    limits,
    terrainCreationMs,
    cityCreationMs,
    staticBodies: initialBodies,
    incidentalStepMs: distribution(stepTimes),
    rays,
    spawns,
    routes,
    rests,
    boundaries,
    issues,
  };
}
