/** Reproducible S-45 authoring. Writes a candidate and migration inputs; never opens a DB. */
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  sampleTerrain,
  type WorldDefinition,
  type WorldLayoutSnapshot,
} from '../packages/contracts/src/index.js';
import { hash, writeWorldPublication } from '../packages/world-release/src/index.js';
import {
  generateSupportAssets,
  planSupportPlacement,
  selectSupportRule,
} from '../packages/terrain-build/src/supports.js';
import {
  createLayoutPublication,
  readAuthoringRelease,
} from '../apps/server/src/layout/release.js';
import { planStaticTerrainPoses } from '../apps/server/src/layout/terrain-poses.js';
import { buildWorld, type BuildWorldOptions } from './world-build/src/index.js';
import { readTerrainReleaseSource } from './world-build/src/terrain-release-source.js';
import { terrainPoseRules } from './world-build/src/terrain-pose-rules.js';
import { readRingEmbeddedFootprintPolicies } from './world-build/src/ring-embedded-footprints.js';
import { ringTerrainBoundaries } from './world-build/src/ring-terrain-layout.js';
import {
  generateExpressiveRingTerrain,
  measureTerrainProfile,
  RING_TERRAIN_EXPRESSIVENESS_CONFIG,
  RING_TERRAIN_EXPRESSIVENESS_ROUTES,
  type RingTerrainExpressivenessConfig,
} from './world-build/src/ring-terrain-expressiveness.js';

const args = process.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  assert.ok(value && !value.startsWith('--'), `Missing ${name}`);
  args.splice(index, 2);
  return value;
};
const sourceDirectory = option('--source-world');
const output = resolve(option('--output') ?? 'output/terrain-expressiveness');
const configFile = option('--config');
const apply = args.includes('--apply');
if (apply) args.splice(args.indexOf('--apply'), 1);
assert.ok(
  sourceDirectory && !args.length,
  'Use --source-world verified-old-world [--output directory] [--config file] [--apply]',
);
const overlaps = (parent: string, child: string) => {
  const path = relative(resolve(parent), resolve(child));
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
};
async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(path) === path) throw error;
    return resolve(await canonicalPath(dirname(path)), basename(path));
  }
}
const sourceRoot = await realpath(sourceDirectory);
const outputRoot = await canonicalPath(output);
const contentRoot = await realpath('content/worlds/ring-block');
const candidateDirectory = join(output, 'candidate-world');
const destinations = await Promise.all(
  ['candidate-world', 'candidate-published'].map((name) => canonicalPath(join(outputRoot, name))),
);
assert.ok(
  !overlaps(sourceRoot, outputRoot) &&
    destinations.every((path) => !overlaps(sourceRoot, path) && !overlaps(path, sourceRoot)),
  'Output must not overwrite the source release',
);
assert.ok(
  !overlaps(contentRoot, outputRoot) &&
    !overlaps(outputRoot, contentRoot) &&
    destinations.every((path) => !overlaps(contentRoot, path) && !overlaps(path, contentRoot)),
  'Authoring output must be separate from canonical content; use --apply to update sources',
);
await mkdir(output, { recursive: true });
const directory = 'content/worlds/ring-block';
const worldFile = join(directory, 'world.json');
const descriptorFile = join(directory, 'terrain-release.json');
const descriptor = JSON.parse(await readFile(descriptorFile, 'utf8'));
const canonical = await readTerrainReleaseSource(worldFile, 'ring-block', 'terrain-release.json');
const baselineFile = join(directory, 'terrain-smoothed/grid.json');
const baselineBytes = await readFile(baselineFile);
const baselineHash = '8b7a4df4cf97595d1f400dceb5cf6f7e00c9dad145e49ac9358a1a3414dd857c';
assert.equal(hash(baselineBytes), baselineHash, 'The pre-S-45 design surface changed');
const config: RingTerrainExpressivenessConfig = configFile
  ? JSON.parse(await readFile(configFile, 'utf8'))
  : RING_TERRAIN_EXPRESSIVENESS_CONFIG;
const grid = generateExpressiveRingTerrain(JSON.parse(baselineBytes.toString()), config);
const source = await readAuthoringRelease(sourceDirectory);
assert.equal(
  source.metadata.assetReleaseVersion,
  canonical.expected.assetReleaseVersion,
  'Build the source release from the current canonical descriptor before authoring a successor',
);
assert.equal(source.metadata.seedVersion, canonical.expected.seedVersion, 'Source seed changed');
assert.equal(source.manifest.mapVersion, canonical.expected.mapVersion, 'Source map changed');
assert.ok(source.terrain?.formatVersion === 2);
const previous = source.terrain.grid;
const supports = structuredClone(canonical.options.groundTerrain!.supports!);

// Keep existing entrances. Lengthen only an approach whose actual triangulated cap
// becomes too steep; no new automatic entrances or per-owner support meshes are authored.
function maximumSlope(asset: ReturnType<typeof generateSupportAssets>[number]['asset']) {
  let maximum = 0;
  for (const collider of asset.physics.colliders) {
    if (collider.kind !== 'mesh') continue;
    for (let i = 0; i < collider.indices.length; i += 3) {
      const [a, b, c] = collider.indices
        .slice(i, i + 3)
        .map((index) => collider.vertices.slice(index * 3, index * 3 + 3));
      const u = b.map((v, k) => v - a[k]),
        v = c.map((value, k) => value - a[k]);
      const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      if (n[1] > 1e-10)
        maximum = Math.max(maximum, (Math.atan2(Math.hypot(n[0], n[2]), n[1]) * 180) / Math.PI);
    }
  }
  return maximum;
}
const approachAudit: unknown[] = [];
for (const rule of supports) {
  if (!rule.approaches?.length) continue;
  const owners = source.seed.filter((owner) => selectSupportRule(supports, owner) === rule);
  const original = structuredClone(rule.approaches);
  let accepted = false;
  for (let iteration = 0; iteration < 60; iteration++) {
    const steep = new Set<string>();
    let maxSlope = 0;
    for (const owner of owners) {
      const sourceRule = selectSupportRule(source.terrain.supports, owner)!;
      const offset = owner.position.y - planSupportPlacement(previous, sourceRule, owner).minimumY;
      const moved = {
        ...owner,
        position: {
          ...owner.position,
          y: planSupportPlacement(grid, rule, owner).minimumY + offset,
        },
      };
      const generated = generateSupportAssets(grid, rule, moved, {
        foundation: 'audit-foundation',
        approaches: Object.fromEntries(rule.approaches.map((a) => [a.id, `audit-${a.id}`])),
      });
      for (const part of generated.filter((p) => p.role.startsWith('approach:'))) {
        const slope = maximumSlope(part.asset);
        maxSlope = Math.max(maxSlope, slope);
        if (slope > 12) steep.add(part.role.slice('approach:'.length));
      }
    }
    if (!steep.size) {
      approachAudit.push({
        assetId: rule.assetId,
        ownerId: rule.ownerId,
        owners: owners.length,
        before: original.map((a) => ({ id: a.id, length: a.length })),
        after: rule.approaches.map((a) => ({ id: a.id, length: a.length })),
        maximumSlopeDegrees: maxSlope,
      });
      accepted = true;
      break;
    }
    for (const approach of rule.approaches) if (steep.has(approach.id)) approach.length += 0.25;
  }
  assert.ok(accepted, `Cannot author a walkable approach for ${rule.assetId}`);
}
const targetReference = {
  ...source,
  terrain: { ...source.terrain, grid, supports },
};
const embeddedPolicies = await readRingEmbeddedFootprintPolicies(source, targetReference);
const rules = terrainPoseRules(source, targetReference, embeddedPolicies);
const snapshot: WorldLayoutSnapshot = {
  formatVersion: 1,
  worldId: source.definition.worldId,
  assetReleaseVersion: source.metadata.assetReleaseVersion,
  seedVersion: source.metadata.seedVersion,
  revision: 1,
  instances: source.seed,
};
const poses = planStaticTerrainPoses(
  {
    sourceRelease: source,
    targetRelease: targetReference,
    sourceSnapshot: snapshot,
    sourceWorld: source.definition,
    sourceItems: [],
    sourcePlayers: [],
  },
  rules,
);
await writeFile(
  join(output, 'seed-preflight.json'),
  JSON.stringify({ issues: poses.issues, audit: poses.audit }, null, 2) + '\n',
);
assert.deepEqual(poses.issues, [], 'Seed support preflight failed; inspect seed-preflight.json');
console.error(
  `Validated ${source.seed.length} seed placements; compiling the authored terrain release.`,
);
const seedY = Object.fromEntries(
  poses.targetSnapshot.instances.map((owner) => [owner.entityId, owner.position.y]),
);
const delta = (p: { x: number; z: number }) =>
  sampleTerrain(grid, p.x, p.z)!.height - sampleTerrain(previous, p.x, p.z)!.height;
const header = structuredClone(canonical.options.groundTerrain!.header!);
header.spawnPoints = header.spawnPoints.map((p) => ({ ...p, y: p.y + delta(p) }));
header.initialItems = header.initialItems.map((item) => ({
  ...item,
  position: { ...item.position, y: item.position.y + delta(item.position) },
}));
const labelOwners: Record<string, string> = {
  ring: 'monument-trudovaya-slava',
  'school-1': 'osm-way-111538131',
  'banya-4': 'osm-way-111493596',
  'opera-theatre': 'osm-way-146724915',
  syktsu: 'osm-way-1258973447',
};
header.landmarks = header.landmarks?.map((label) => {
  const owner = source.seed.find((owner) => owner.entityId === labelOwners[label.id]);
  return {
    ...label,
    position: {
      ...label.position,
      y:
        label.position.y +
        (owner ? seedY[owner.entityId] - owner.position.y : delta(label.position)),
    },
  };
});
header.bounds.min.y = Math.min(header.bounds.min.y, grid.bottom - 5);
for (const owner of source.seed)
  header.bounds.max.y = Math.max(
    header.bounds.max.y,
    Math.ceil(
      seedY[owner.entityId] + source.definition.buildingAssets[owner.assetId].bounds.max.y + 2,
    ),
  );
const authored = JSON.parse(await readFile(worldFile, 'utf8'));
const statics = ringTerrainBoundaries(
  { bounds: header.bounds, entities: authored.entities } as WorldDefinition,
  grid,
  { insetMetres: 0.02 },
);
const ground: NonNullable<BuildWorldOptions['groundTerrain']> = {
  ...canonical.options.groundTerrain,
  grid,
  spacing: 20,
  supports,
  seedY,
  header,
  statics,
};
const manifest = await buildWorld(worldFile, candidateDirectory, {
  terrainRelease: false,
  physicsPacks: canonical.options.physicsPacks,
  groundTerrain: ground,
});
const candidate = await readAuthoringRelease(candidateDirectory);
const finalRules = terrainPoseRules(source, candidate, embeddedPolicies);
console.error('Compiling the complete seed publication with foundations and near/far groups.');
const published = await createLayoutPublication(candidate, {
  formatVersion: 1,
  worldId: candidate.definition.worldId,
  assetReleaseVersion: candidate.metadata.assetReleaseVersion,
  seedVersion: candidate.metadata.seedVersion,
  revision: 1,
  instances: candidate.seed,
});
await writeWorldPublication(published.publication, join(output, 'candidate-published'));
await writeFile(
  join(output, 'terrain-pose-rules.json'),
  JSON.stringify(finalRules, null, 2) + '\n',
);
const gridBytes = JSON.stringify(grid) + '\n';
const gridFile = `terrain-expressive/grid.${hash(gridBytes).slice(0, 16)}.json`;
descriptor.groundTerrain = {
  ...descriptor.groundTerrain,
  grid: { file: gridFile, sha256: hash(gridBytes) },
  supports,
  seedY,
  header,
  statics,
};
descriptor.expected = {
  assetReleaseVersion: candidate.metadata.assetReleaseVersion,
  seedVersion: candidate.metadata.seedVersion,
  mapVersion: manifest.mapVersion,
};
const provenance = {
  formatVersion: 1,
  algorithm: 'ring-terrain-expressiveness/1',
  baseline: { file: 'terrain-smoothed/grid.json', sha256: baselineHash },
  config,
  gridSha256: hash(gridBytes),
  sourceAssetReleaseVersion: source.metadata.assetReleaseVersion,
  target: descriptor.expected,
  seedPublicationMapVersion: published.publication.manifest.mapVersion,
};
const report = {
  status: 'candidate-built',
  appliedToSources: apply,
  databaseChanged: false,
  source: {
    assetReleaseVersion: source.metadata.assetReleaseVersion,
    mapVersion: source.manifest.mapVersion,
  },
  target: descriptor.expected,
  seedInstances: source.seed.length,
  changedSeedHeights: source.seed.filter((owner) => owner.position.y !== seedY[owner.entityId])
    .length,
  rules: finalRules.models.length,
  approaches: approachAudit,
  profiles: RING_TERRAIN_EXPRESSIVENESS_ROUTES.map((route) => ({
    ...route,
    before: measureTerrainProfile(previous, route.points),
    after: measureTerrainProfile(grid, route.points),
  })),
};
await writeFile(join(output, 'terrain-release.json'), JSON.stringify(descriptor, null, 2) + '\n');
await writeFile(join(output, 'grid.json'), gridBytes);
await writeFile(join(output, 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
await writeFile(join(output, 'build-report.json'), JSON.stringify(report, null, 2) + '\n');
if (apply) {
  await mkdir(join(directory, 'terrain-expressive'), { recursive: true });
  await writeFile(join(directory, gridFile), gridBytes);
  await writeFile(
    join(directory, 'terrain-expressive/provenance.json'),
    JSON.stringify(provenance, null, 2) + '\n',
  );
  await writeFile(descriptorFile, JSON.stringify(descriptor, null, 2) + '\n');
}
console.log(
  JSON.stringify({
    ...report,
    approaches: approachAudit.length,
    profiles: report.profiles.map((p) => ({
      id: p.id,
      before: { distance: p.before.distance, rise: p.before.rise, relief: p.before.relief },
      after: { distance: p.after.distance, rise: p.after.rise, relief: p.after.relief },
    })),
  }),
);
