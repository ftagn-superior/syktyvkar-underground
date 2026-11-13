import { createHash } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { createAuthoritativeWorld } from '../../packages/simulation/src/server.js';
import { buildWorld } from '../../tools/world-build/src/index.js';
import { readRelease } from '../helpers/static-extraction.js';
import type { Vec3 } from '../../packages/contracts/src/index.js';

it('preserves capsule access at historical gates, fence corners, routes and spawns', async () => {
  const bytes = await readFile('tests/fixtures/static-library-v1/passages.json.gz');
  const evidence: { probes: { label: string; point: Vec3; clear: boolean }[] } = JSON.parse(
    gunzipSync(bytes).toString('utf8'),
  );
  expect(evidence.probes).toHaveLength(1898);
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(
    'ac133cebffb0d53bd6ba84bf31c455cfe52ca6355638df5ff90b1687f4c8fbd0',
  );
  const directory = await mkdtemp(join(tmpdir(), 'su-library-passages-'));
  try {
    await buildWorld('content/worlds/ring-block/world.json', directory, { terrainRelease: false });
    const { world } = await readRelease(directory);
    const physics = await createAuthoritativeWorld({ ...world, initialItems: [] });
    try {
      const differences = evidence.probes.flatMap(({ label, point, clear }) => {
        const current = !!physics.findSpawn(undefined, [point]);
        return current === clear ? [] : [{ label, point, before: clear, after: current }];
      });
      expect(differences).toEqual([]);
    } finally {
      physics.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
