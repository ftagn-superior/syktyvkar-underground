import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import {
  RING_TERRAIN_CANDIDATE_DIRECTORY as directory,
  ringTerrainGridStatistics,
} from './world-build/src/ring-terrain-candidate.js';
import {
  readSyktsuTerrainPadInputs,
  generateSyktsuTerrainPad,
} from './world-build/src/syktsu-pad.js';
const check = process.argv.includes('--check');
assert.ok(
  process.argv.slice(2).every((arg) => arg === '--check'),
  'Only --check is supported',
);
const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const { base, rule, pad } = await readSyktsuTerrainPadInputs();
const grid = generateSyktsuTerrainPad(base, rule, pad);
const bytes = JSON.stringify(grid) + '\n';
const files = [
  'tools/build-syktsu-terrain-pad.ts',
  'tools/world-build/src/syktsu-pad.ts',
  `${directory}/syktsu-pad.json`,
  `${directory}/pilot-grid-4m.json`,
  pad.supportRule.path,
];
const provenance = {
  formatVersion: 1,
  status: 'selected-unapplied-gameplay-candidate',
  generator: Object.fromEntries(
    await Promise.all(files.map(async (file) => [file, hash(await readFile(file))])),
  ),
  output: { file: 'pilot-grid-with-pad.json', sha256: hash(bytes) },
  diagnostics: ringTerrainGridStatistics(grid),
  limitations: [
    'Explicit Syktsu campus pad only; source and full grids are unchanged.',
    'Neighbouring support-height exceedances and unresolved entrances remain blocking; see syktsu-pad.json.',
    'Isolated Node walking does not replace full city, browser, networking or state-migration acceptance.',
  ],
};
for (const [file, text] of [
  ['pilot-grid-with-pad.json', bytes],
  ['syktsu-pad-provenance.json', JSON.stringify(provenance, null, 2) + '\n'],
]) {
  if (check) assert.equal(await readFile(`${directory}/${file}`, 'utf8'), text, `${file} is stale`);
  else await writeFile(`${directory}/${file}`, text);
}
console.log(JSON.stringify({ check, ...provenance.output, diagnostics: provenance.diagnostics }));
