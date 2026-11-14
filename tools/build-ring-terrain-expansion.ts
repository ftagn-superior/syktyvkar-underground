/** Rebuild an expanded canvas from committed heights; never modifies placements or a database. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateTerrainGrid, type WorldDefinition } from '../packages/contracts/src/index.js';
import { hash } from '../packages/world-release/src/index.js';
import { buildWorld } from './world-build/src/index.js';
import { readTerrainReleaseSource } from './world-build/src/terrain-release-source.js';
import { ringTerrainBoundaries } from './world-build/src/ring-terrain-layout.js';

const args = process.argv.slice(2);
assert.ok(
  args.every((arg) => arg === '--apply'),
  'Usage: node --import tsx tools/build-ring-terrain-expansion.ts [--apply]',
);
const directory = 'content/worlds/ring-block';
const output = 'output/ring-terrain-expansion/candidate-world';
const worldFile = join(directory, 'world.json');
const world = JSON.parse(await readFile(worldFile, 'utf8'));
const source = await readTerrainReleaseSource(worldFile, world.worldId, world.terrainRelease);
const descriptor = JSON.parse(await readFile(source.file, 'utf8'));
const configBytes = await readFile(join(directory, 'terrain-expansion/source.json'));
const config = JSON.parse(configBytes.toString());
const provenance = JSON.parse(
  await readFile(join(directory, 'terrain-expansion/provenance.json'), 'utf8'),
);
assert.equal(provenance.sourceConfigSha256, hash(configBytes), 'Stale expansion config');
const gridBytes = await readFile(join(directory, 'terrain-expansion/grid.json'));
assert.equal(hash(gridBytes), provenance.output.sha256, 'Expanded terrain heights changed');
const grid = validateTerrainGrid(JSON.parse(gridBytes.toString()));
const oldBytes = await readFile(join(directory, config.preservedGrid));
assert.equal(hash(oldBytes), config.preservedGridSha256, 'Preserved city heights changed');
const old = validateTerrainGrid(JSON.parse(oldBytes.toString()));
assert.equal(grid.spacing, old.spacing);
const col = (old.origin.x - grid.origin.x) / grid.spacing;
const row = (old.origin.z - grid.origin.z) / grid.spacing;
assert.ok(Number.isInteger(col) && Number.isInteger(row));
for (let z = 0; z < old.rows; z++)
  for (let x = 0; x < old.columns; x++)
    assert.equal(
      grid.heights[(row + z) * grid.columns + col + x],
      old.heights[z * old.columns + x],
      'Existing city node was changed',
    );
const { west, east, north, south } = config.worldBoundsXZ;
const ground = source.options.groundTerrain!;
const header = structuredClone(ground.header!);
header.bounds = {
  min: { x: west, y: grid.bottom - 5, z: north },
  max: { x: east, y: header.bounds.max.y, z: south },
};
for (const y of grid.heights) header.bounds.max.y = Math.max(header.bounds.max.y, Math.ceil(y) + 5);
// Use the four original boundary templates, then subdivide to follow the new heights.
const templates = structuredClone(world.entities) as WorldDefinition['entities'];
for (const wall of templates) {
  const direction = wall.entityId.replace('boundary-', '');
  const horizontal = direction === 'north' || direction === 'south';
  wall.position.x = horizontal
    ? (west + east) / 2
    : direction === 'west'
      ? west + 0.25
      : east - 0.25;
  wall.position.z = horizontal
    ? direction === 'north'
      ? north + 0.25
      : south - 0.25
    : (north + south) / 2;
  wall.size.x = horizontal ? east - west : 0.5;
  wall.size.z = horizontal ? 0.5 : south - north;
}
const statics = ringTerrainBoundaries(
  { bounds: header.bounds, entities: templates } as WorldDefinition,
  grid,
  { insetMetres: 0.02 },
);
const manifest = await buildWorld(worldFile, output, {
  terrainRelease: false,
  physicsPacks: descriptor.physicsPacks,
  groundTerrain: { ...ground, grid, extendToWorldBounds: true, header, statics },
});
const metadata = JSON.parse(await readFile(join(output, 'authoring.json'), 'utf8'));
assert.equal(
  metadata.seedVersion,
  source.expected.seedVersion,
  'Expansion must preserve every editable seed pose',
);
descriptor.groundTerrain = {
  ...descriptor.groundTerrain,
  extendToWorldBounds: true,
  grid: { file: 'terrain-expansion/grid.json', sha256: hash(gridBytes) },
  header,
  statics,
};
descriptor.expected = {
  assetReleaseVersion: metadata.assetReleaseVersion,
  seedVersion: metadata.seedVersion,
  mapVersion: manifest.mapVersion,
};
const bytes = JSON.stringify(descriptor, null, 2) + '\n';
await mkdir('output/ring-terrain-expansion', { recursive: true });
await writeFile('output/ring-terrain-expansion/terrain-release.json', bytes);
if (args.includes('--apply')) await writeFile(source.file, bytes);
console.log(
  JSON.stringify(
    {
      applied: args.includes('--apply'),
      ...descriptor.expected,
      bounds: header.bounds,
      cells: manifest.cells.length,
      groundTiles: metadata.fixedInstanceIds.length,
      boundarySegments: statics.length,
    },
    null,
    2,
  ),
);
