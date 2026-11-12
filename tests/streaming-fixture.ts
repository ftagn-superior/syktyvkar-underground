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
const directory = resolve(option('directory', `output/large-map/acceptance/${scenario}`));
await mkdir(directory, { recursive: true });
const fixture = await buildStreamingFixture(directory, scenario);
console.log(
  JSON.stringify(
    {
      result: 'passed',
      scenario,
      worldDirectory: fixture.worldDirectory,
      mapVersion: fixture.manifest.mapVersion,
      simulationConfigHash: fixture.manifest.simulationConfigHash,
      spawnPoints: fixture.header.spawnPoints,
      routes: Object.keys(fixture.header.routes ?? {}),
      note: 'Use this hashed world with the built server on the target machine; run SDK generators and two hardware browsers separately. Clients do not choose coordinates.',
    },
    null,
    2,
  ),
);
