/** Generate migration rules from verified immutable releases; never opens a database. */
import { randomUUID } from 'node:crypto';
import { mkdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { readAuthoringRelease } from '../apps/server/src/layout/release.js';
import { terrainPoseRules } from './world-build/src/terrain-pose-rules.js';
import { readRingEmbeddedFootprintPolicies } from './world-build/src/ring-embedded-footprints.js';

const options = new Map<string, string>();
const args = process.argv.slice(2);
const embeddedFlag = args.indexOf('--ring-embedded');
const ringEmbedded = embeddedFlag !== -1;
if (ringEmbedded) args.splice(embeddedFlag, 1);
for (let i = 0; i < args.length; i += 2) {
  const key = args[i],
    value = args[i + 1];
  if (
    !['--source', '--target', '--output'].includes(key) ||
    options.has(key) ||
    !value ||
    value.startsWith('--')
  )
    throw new Error('Use --source old-world --target new-world --output terrain-pose-rules.json');
  options.set(key, resolve(value));
}
if (options.size !== 3)
  throw new Error('Use --source old-world --target new-world --output terrain-pose-rules.json');
const sourceDirectory = await realpath(options.get('--source')!);
const targetDirectory = await realpath(options.get('--target')!);
const output = options.get('--output')!;
async function canonicalDirectory(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(path) === path) throw error;
    return resolve(await canonicalDirectory(dirname(path)), basename(path));
  }
}
const outputDirectory = await canonicalDirectory(dirname(output));
const destination = resolve(outputDirectory, basename(output));
for (const directory of [sourceDirectory, targetDirectory]) {
  const path = relative(directory, destination);
  if (path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`)))
    throw new Error('Terrain rules output must be outside both immutable releases');
}
const [source, target] = await Promise.all([
  readAuthoringRelease(sourceDirectory),
  readAuthoringRelease(targetDirectory),
]);
if (ringEmbedded && target.definition.worldId !== 'ring-block')
  throw new Error('--ring-embedded requires the ring-block world');
const rules = terrainPoseRules(
  source,
  target,
  ringEmbedded ? await readRingEmbeddedFootprintPolicies(source, target) : [],
);
await mkdir(outputDirectory, { recursive: true });
const temporary = resolve(outputDirectory, `.${basename(output)}.${randomUUID()}.tmp`);
try {
  await writeFile(temporary, JSON.stringify(rules, null, 2) + '\n', { flag: 'wx' });
  await rename(temporary, destination);
} finally {
  await rm(temporary, { force: true });
}
console.log(
  JSON.stringify({
    status: 'rules-prepared',
    worldId: target.definition.worldId,
    sourceAssetReleaseVersion: source.metadata.assetReleaseVersion,
    targetAssetReleaseVersion: target.metadata.assetReleaseVersion,
    models: rules.models.length,
    rules: destination,
    databaseChanged: false,
  }),
);
