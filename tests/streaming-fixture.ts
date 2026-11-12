import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildStreamingFixture } from './helpers/streaming-world.js';
const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const index = args.indexOf('--' + name);
  return index < 0 ? fallback : args[index + 1];
};
const scenario = option('scenario', 'spread');
if (scenario !== 'spread' && scenario !== 'crowd') throw new Error('Use --scenario spread|crowd');
const content = option('content', 'streaming-lab');
const items = option('items', 'existing');
if (content !== 'streaming-lab' && content !== 'ring-block')
  throw new Error('Use --content streaming-lab|ring-block');
if (items !== 'existing' && items !== 'all-types')
  throw new Error('Use --items existing|all-types');
const directory = resolve(option('directory', `output/large-map/acceptance/${scenario}`));
await mkdir(directory, { recursive: true });
const fixture = await buildStreamingFixture(directory, scenario, { content, items });
console.log(
  JSON.stringify(
    {
      result: 'passed',
      scenario,
      profile: fixture.profile,
      worldDirectory: fixture.worldDirectory,
      mapVersion: fixture.manifest.mapVersion,
      simulationConfigHash: fixture.manifest.simulationConfigHash,
      spawnPoints: fixture.header.spawnPoints,
      routes: Object.keys(fixture.header.routes ?? {}),
      note: 'Use this hashed world with the built server on the target machine; run SDK generators and two hardware browsers separately. Clients do not choose coordinates. Bundle seed poses are at rest; streaming-load initializes the optional moving snapshots only in its isolated PostgreSQL test schema.',
    },
    null,
    2,
  ),
);
