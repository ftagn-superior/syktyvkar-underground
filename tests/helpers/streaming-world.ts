import { cp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildWorld } from '../../tools/world-build/src/index.js';
import { readWorldDirectory } from '../../apps/server/src/world-bundle.js';
import { ItemStore } from '../../apps/server/src/items/store.js';
import { createAuthoritativeWorld } from '../../packages/simulation/src/server.js';
import {
  initialItemState,
  itemSupportDistance,
  type WorldSource,
  type WorldHeader,
} from '../../packages/contracts/src/index.js';

export type StreamingContent = 'streaming-lab' | 'ring-block';
export type StreamingItems = 'existing' | 'all-types';
export interface StreamingFixtureOptions {
  content?: StreamingContent;
  items?: StreamingItems;
}

/** Server-owned spawn configuration in a separate hashed bundle, never client coordinates. */
export async function buildStreamingFixture(
  directory: string,
  scenario: 'spread' | 'crowd',
  options: StreamingFixtureOptions = {},
) {
  const content = options.content ?? 'streaming-lab';
  const itemProfile = options.items ?? 'existing';
  if (
    !['streaming-lab', 'ring-block'].includes(content) ||
    !['existing', 'all-types'].includes(itemProfile)
  )
    throw new Error('Unknown streaming content/item profile');
  await cp('content', join(directory, 'content'), { recursive: true });
  const source = join(directory, `content/worlds/${content}/world.json`);
  const worldSource: WorldSource = JSON.parse(await readFile(source, 'utf8'));
  const vertices = [-750, -250, 250, 750].flatMap((x) => [-750, 250].map((z) => ({ x, z })));
  if (content === 'streaming-lab') {
    worldSource.spawnPoints =
      scenario === 'spread'
        ? vertices.map(({ x, z }) => ({ x: x + 4, y: 0, z: z + 4 }))
        : [4, 16].flatMap((z) => [-6, -3, 0, 3].map((x) => ({ x, y: 0, z })));
    worldSource.routes = Object.fromEntries(
      vertices.map(({ x, z }, i) => [
        `spread-${i}`,
        [
          { x: x + 4, z: z + 4 },
          { x: x - 8, z: z + 4 },
          { x: x - 8, z: z - 8 },
          { x: x + 4, z: z - 8 },
          { x: x + 4, z: z + 130 },
          { x: x - 8, z: z + 130 },
        ],
      ]),
    );
  }
  await writeFile(source, JSON.stringify(worldSource));
  const worldDirectory = join(directory, 'world');
  let manifest = await buildWorld(source, worldDirectory, { terrainRelease: false });
  let { definition } = await readWorldDirectory(worldDirectory);
  const control = definition.initialItems.find((item) => item.typeId === 'wooden-crate');
  if (!control) throw new Error('Crowd fixture requires a recorded wooden-crate seed');
  const physics = await createAuthoritativeWorld({ ...definition, initialItems: [] });
  let cityRouteSamples = 0;
  try {
    if (content === 'ring-block' && scenario === 'crowd') {
      // Validate a fixture-only crowd disk and entry segments in the actual city physics.
      // Keep the geography intact; record any control-item pose override in seedItems.
      const candidates = [control.position];
      const mean = definition.spawnPoints.reduce(
        (p, spawn) => ({ x: p.x + spawn.x / 8, z: p.z + spawn.z / 8 }),
        { x: 0, z: 0 },
      );
      for (let radius = 0; radius <= 24; radius += 4)
        for (const [x, z] of [
          [radius, 0],
          [-radius, 0],
          [0, radius],
          [0, -radius],
        ])
          candidates.push({ x: mean.x + x, y: control.position.y, z: mean.z + z });
      let found = false;
      for (const center of candidates) {
        const points: { x: number; z: number }[] = [];
        for (let x = -5; x <= 5; x += 0.5)
          for (let z = -5; z <= 5; z += 0.5)
            if (Math.hypot(x, z) <= 5) points.push({ x: center.x + x, z: center.z + z });
        for (const spawn of definition.spawnPoints) {
          const steps = Math.max(
            1,
            Math.ceil(Math.hypot(spawn.x - center.x, spawn.z - center.z) / 0.5),
          );
          for (let step = 0; step <= steps; step++)
            points.push({
              x: spawn.x + ((center.x - spawn.x) * step) / steps,
              z: spawn.z + ((center.z - spawn.z) * step) / steps,
            });
        }
        if (points.some((point) => !physics.findSpawn(undefined, [{ ...point, y: 0 }]))) continue;
        if (physics.checkPlacement(control.typeId, { ...control, position: center })) continue;
        control.position = { ...center };
        cityRouteSamples = points.length;
        found = true;
        break;
      }
      if (!found)
        throw new Error(
          'City crowd needs validated routes: no supported 5m disk with clear entry paths near the existing spawns.',
        );
      worldSource.initialItems = definition.initialItems;
    }
    if (content === 'ring-block' && scenario === 'spread') {
      type Point = { x: number; z: number };
      const candidates: { center: Point; route: Point[]; samples: number }[] = [];
      const centers: Point[] = [];
      for (let x = manifest.grid.origin.x + 125; x < definition.bounds.max.x - 9; x += 125)
        for (let z = definition.bounds.min.z + 16; z < definition.bounds.max.z - 16; z += 16)
          centers.push({ x, z });
      for (let z = manifest.grid.origin.z + 125; z < definition.bounds.max.z - 9; z += 125)
        for (let x = definition.bounds.min.x + 16; x < definition.bounds.max.x - 16; x += 16)
          centers.push({ x, z });
      for (const center of centers) {
        const route = [
          [-8, -8],
          [8, -8],
          [8, 8],
          [-8, 8],
        ].map(([x, z]) => ({ x: center.x + x, z: center.z + z }));
        let samples = 0,
          safe = true;
        for (let edge = 0; edge < route.length && safe; edge++) {
          const from = route[edge],
            to = route[(edge + 1) % route.length];
          for (let step = 0; step <= 32; step++) {
            const point = {
              x: from.x + ((to.x - from.x) * step) / 32,
              y: 0,
              z: from.z + ((to.z - from.z) * step) / 32,
            };
            if (!physics.findSpawn(undefined, [point])) {
              safe = false;
              break;
            }
            samples++;
          }
        }
        if (safe) candidates.push({ center, route, samples });
      }
      const selected: typeof candidates = [];
      while (selected.length < 8 && candidates.length) {
        candidates.sort((a, b) => {
          const score = (value: typeof a) =>
            selected.length
              ? Math.min(
                  ...selected.map((previous) =>
                    Math.hypot(
                      previous.center.x - value.center.x,
                      previous.center.z - value.center.z,
                    ),
                  ),
                )
              : -value.center.z;
          return score(b) - score(a) || a.center.x - b.center.x || a.center.z - b.center.z;
        });
        const candidate = candidates.shift()!;
        if (
          selected.some(
            (previous) =>
              Math.hypot(
                previous.center.x - candidate.center.x,
                previous.center.z - candidate.center.z,
              ) < 64,
          )
        )
          continue;
        // Exercise the actual capsule controller around the whole loop, not just point samples.
        const playerId = `city-route-${selected.length}`;
        if (!physics.addPlayer(playerId, { ...candidate.route[0], y: 0 })) continue;
        let traversed = true;
        try {
          for (const target of [...candidate.route.slice(1), candidate.route[0]]) {
            let reached = false;
            for (let step = 0; step < 360; step++) {
              const player = physics
                .getSnapshot()
                .players.find((player) => player.entityId === playerId)!;
              const dx = target.x - player.position.x,
                dz = target.z - player.position.z;
              const distance = Math.hypot(dx, dz);
              if (distance < 0.15) {
                reached = true;
                break;
              }
              if (player.position.y < 0.75) break;
              physics.setInput(playerId, {
                moveX: dx / Math.max(1, distance),
                moveZ: dz / Math.max(1, distance),
              });
              physics.step();
            }
            if (!reached) {
              traversed = false;
              break;
            }
          }
        } finally {
          physics.removePlayer(playerId);
        }
        if (traversed) selected.push(candidate);
      }
      if (selected.length !== 8)
        throw new Error(
          `City spread has only ${selected.length} validated dispersed seam routes; eight are required.`,
        );
      worldSource.spawnPoints = selected.map(({ route }) => ({ ...route[0], y: 0 }));
      worldSource.routes = Object.fromEntries(
        selected.map(({ route }, index) => [`spread-${index}`, route]),
      );
      definition.spawnPoints = worldSource.spawnPoints;
      cityRouteSamples = selected.reduce((sum, route) => sum + route.samples, 0);
    }
    if (itemProfile === 'all-types') {
      const seeds = [...definition.initialItems];
      physics.replaceItems(seeds.map((seed) => initialItemState(seed, seed.seedId)));
      for (const type of Object.values(definition.itemCatalog.types)) {
        if (seeds.some((seed) => seed.typeId === type.typeId)) continue;
        const rotation = { x: 0, y: 0, z: 0, w: 1 };
        const y = itemSupportDistance(type, rotation, { x: 0, y: -1, z: 0 }) + 0.02;
        let placed = false;
        for (let distance = 4; distance <= 24 && !placed; distance += 4)
          for (const [dx, dz] of [
            [-distance, 0],
            [distance, 0],
            [0, -distance],
            [0, distance],
          ]) {
            const position = { x: control.position.x + dx, y, z: control.position.z + dz };
            if (
              definition.spawnPoints.some(
                (spawn) => Math.hypot(spawn.x - position.x, spawn.z - position.z) < 2,
              )
            )
              continue;
            if (physics.checkPlacement(type.typeId, { position, rotation })) continue;
            seeds.push({ seedId: `load-${type.typeId}`, typeId: type.typeId, position, rotation });
            physics.replaceItems(seeds.map((seed) => initialItemState(seed, seed.seedId)));
            placed = true;
            break;
          }
        if (!placed) throw new Error(`No supported fixture placement for ${type.typeId}`);
      }
      worldSource.initialItems = seeds;
    }
  } finally {
    physics.dispose();
  }
  if (itemProfile === 'all-types' || content === 'ring-block') {
    await writeFile(source, JSON.stringify(worldSource));
    manifest = await buildWorld(source, worldDirectory, { terrainRelease: false });
    ({ definition } = await readWorldDirectory(worldDirectory));
  }
  const header: WorldHeader = JSON.parse(
    await readFile(join(worldDirectory, manifest.worldFile), 'utf8'),
  );
  return {
    worldDirectory,
    manifest,
    header,
    definition,
    profile: {
      content,
      items: itemProfile,
      scenario,
      controlSeedId: control.seedId,
      seedItems: definition.initialItems,
      cityRouteSamples,
      routes: header.routes ?? {},
      routeValidation:
        content !== 'ring-block'
          ? 'synthetic spread/crowd fixture'
          : scenario === 'crowd'
            ? 'static capsule/floor samples every 0.5m across 5m crowd disk and entry segments'
            : 'eight dispersed seam loops: 0.5m static samples plus complete authoritative capsule traversal',
      scene: {
        buildings: definition.buildings.length,
        statics: definition.entities.length,
        assets: Object.keys(manifest.assets).length,
        cells: manifest.cells.length,
        grid: manifest.grid,
      },
    },
  };
}

/** Offline test schema preparation. No debug endpoint or running-world mutation is introduced. */
export async function seedStreamingItemProfile(
  pool: ConstructorParameters<typeof ItemStore>[0],
  fixture: Awaited<ReturnType<typeof buildStreamingFixture>>,
) {
  const store = new ItemStore(pool, fixture.definition, randomUUID());
  try {
    const items = await store.initialize();
    const moving =
      fixture.profile.items === 'all-types'
        ? items.filter((item) => item.typeId !== 'wooden-crate')
        : [];
    // These are initial moving snapshots, not a claim of continuous forced motion during a soak.
    // The saved safePose remains the validated supported pose; all bodies start moving together.
    for (const [index, item] of moving.entries()) {
      item.position = { ...item.position, y: item.position.y + 0.4 };
      item.velocity = { x: index % 2 ? -0.4 : 0.4, y: 1, z: 0.2 };
      item.angularVelocity = { x: 0, y: 0.15, z: 0 };
    }
    const physics = await createAuthoritativeWorld({ ...fixture.definition, initialItems: [] });
    try {
      for (const item of items) {
        const error = physics.checkSavedItem(item);
        if (error) throw new Error(`Invalid load snapshot ${item.typeId}: ${error}`);
      }
    } finally {
      physics.dispose();
    }
    if (moving.length) await store.save(items, 1);
    return {
      initialSnapshots: items,
      initialMovingItems: moving.map((item) => item.entityId),
      itemCount: items.length,
      motion: moving.length
        ? 'initial saved snapshots; subsequent motion is authoritative physics and player contact'
        : 'existing seed state',
    };
  } finally {
    await store.close();
  }
}
