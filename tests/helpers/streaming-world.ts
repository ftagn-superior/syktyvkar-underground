import { cp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildWorld } from '../../tools/world-build/src/index.js';
import type { WorldHeader } from '../../packages/contracts/src/index.js';

/** Server-owned spawn configuration in a separate hashed bundle, never client coordinates. */
export async function buildStreamingFixture(directory: string, scenario: 'spread' | 'crowd') {
  await cp('content', join(directory, 'content'), { recursive: true });
  const source = join(directory, 'content/worlds/streaming-lab/world.json');
  const header: WorldHeader = JSON.parse(await readFile(source, 'utf8'));
  const vertices = [-750, -250, 250, 750].flatMap((x) => [-750, 250].map((z) => ({ x, z })));
  header.spawnPoints =
    scenario === 'spread'
      ? vertices.map(({ x, z }) => ({ x: x + 4, y: 0, z: z + 4 }))
      : [4, 16].flatMap((z) => [-6, -3, 0, 3].map((x) => ({ x, y: 0, z })));
  header.routes = Object.fromEntries(
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
  await writeFile(source, JSON.stringify(header));
  const worldDirectory = join(directory, 'world');
  const manifest = await buildWorld(source, worldDirectory);
  return { worldDirectory, manifest, header };
}
