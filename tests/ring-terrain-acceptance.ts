/** Explicit saved release only. Does not build, transform placements or access a database. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { validateTerrainGrid } from '../packages/contracts/src/index.js';
import { hash } from '../packages/world-release/src/index.js';
import { readWorldDirectory } from '../apps/server/src/world-bundle.js';
import { loadServerWasm } from '../packages/simulation/src/server.js';
import { cityTerrainAcceptance, type CityAcceptanceControls } from './terrain/city-acceptance.js';

const options = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i],
    value = process.argv[i + 1];
  if (
    !['--release', '--grid', '--rules', '--controls', '--report'].includes(key) ||
    options.has(key) ||
    !value ||
    value.startsWith('--')
  )
    throw new Error(`Invalid acceptance argument: ${key}`);
  options.set(key, resolve(value));
}
for (const key of ['--release', '--grid', '--rules', '--controls', '--report'])
  if (!options.has(key)) throw new Error(`Required acceptance argument: ${key}`);
const reportFile = options.get('--report')!,
  directory = options.get('--release')!;
const within = relative(directory, reportFile);
if (!within.startsWith('..' + sep) && within !== '..')
  throw new Error('Acceptance report must be outside the immutable release');
if (['--grid', '--rules', '--controls'].some((key) => options.get(key) === reportFile))
  throw new Error('Report must differ from acceptance inputs');
const [gridBytes, rulesBytes, controlsBytes, manifestBytes] = await Promise.all([
  readFile(options.get('--grid')!),
  readFile(options.get('--rules')!),
  readFile(options.get('--controls')!),
  readFile(resolve(directory, 'manifest.json')),
]);
const gridData = JSON.parse(gridBytes.toString());
const grid = validateTerrainGrid(gridData.grid ?? gridData);
const rules = JSON.parse(rulesBytes.toString());
if (
  !Array.isArray(rules.targetGroundIds) ||
  !rules.targetGroundIds.every((id: unknown) => typeof id === 'string')
)
  throw new Error('Rules require targetGroundIds');
const controls: CityAcceptanceControls = JSON.parse(controlsBytes.toString());
const { definition, manifest } = await readWorldDirectory(directory);
const report = await cityTerrainAcceptance(
  definition,
  manifest,
  grid,
  rules.targetGroundIds,
  controls,
  await loadServerWasm(),
);
const result = {
  ...report,
  date: new Date().toISOString(),
  inputs: {
    release: directory,
    manifestSha256: hash(manifestBytes),
    grid: { path: options.get('--grid'), sha256: hash(gridBytes) },
    rules: { path: options.get('--rules'), sha256: hash(rulesBytes) },
    controls: { path: options.get('--controls'), sha256: hash(controlsBytes) },
    runnerSha256: hash(await readFile(new URL(import.meta.url))),
    scenariosSha256: hash(await readFile(new URL('./terrain/city-acceptance.ts', import.meta.url))),
  },
};
await mkdir(dirname(reportFile), { recursive: true });
await writeFile(reportFile, JSON.stringify(result, null, 2) + '\n');
console.log(
  JSON.stringify({
    status: result.status,
    mapVersion: manifest.mapVersion,
    issues: result.issues,
    report: reportFile,
  }),
);
if (result.status !== 'passed') process.exitCode = 1;
