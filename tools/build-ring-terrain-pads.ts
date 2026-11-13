import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import {
  RING_TERRAIN_CANDIDATE_DIRECTORY as directory,
  ringTerrainGridStatistics,
} from './world-build/src/ring-terrain-candidate.js';
import { generateRingTerrainPads, readRingTerrainPadInputs } from './world-build/src/ring-pads.js';
const check = process.argv.includes('--check');
assert.ok(process.argv.slice(2).every((arg) => arg === '--check'));
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const { base, rules, config } = await readRingTerrainPadInputs();
const grid = generateRingTerrainPads(base, rules, config);
const bytes = JSON.stringify(grid) + '\n';
const files = [
  'tools/build-ring-terrain-pads.ts',
  'tools/world-build/src/ring-pads.ts',
  'tools/world-build/src/syktsu-pad.ts',
  `${directory}/ring-pads.json`,
  `${directory}/pilot-grid-4m.json`,
  `${directory}/model-supports.json`,
];
const provenance = {
  formatVersion: 1,
  status: 'selected-unapplied-explicit-pads',
  inputs: Object.fromEntries(
    await Promise.all(files.map(async (file) => [file, hash(await readFile(file))])),
  ),
  output: { file: 'pilot-grid-with-pads.json', sha256: hash(bytes) },
  diagnostics: ringTerrainGridStatistics(grid),
  scope:
    'Only the explicitly listed23 plateau owners and4 bounded-grade owners; no automatic flattening. Source/full grids remain unchanged. Door/access review and full city gameplay acceptance are separate.',
};
for (const [file, data] of [
  ['pilot-grid-with-pads.json', bytes],
  ['ring-pads-provenance.json', JSON.stringify(provenance, null, 2) + '\n'],
])
  if (check) assert.equal(await readFile(`${directory}/${file}`, 'utf8'), data, `${file} is stale`);
  else await writeFile(`${directory}/${file}`, data);
console.log(JSON.stringify({ check, ...provenance.output, diagnostics: provenance.diagnostics }));
