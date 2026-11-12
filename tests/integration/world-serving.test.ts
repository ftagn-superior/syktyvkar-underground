import { afterAll, beforeAll, expect, it } from 'vitest';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildWorld } from '../../tools/world-build/src/index.js';
import { createGameServer } from '../helpers/game-server.js';
import { readWorldDirectory } from '../../apps/server/src/world-bundle.js';

let temporary: string;
let bundle: string;
beforeAll(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'su-world-serving-'));
  bundle = join(temporary, 'release');
  await buildWorld('content/worlds/physics-lab/world.json', bundle);
});
afterAll(async () => {
  await rm(temporary, { recursive: true, force: true });
});

it.skipIf(!process.env.SU_TEST_DATABASE_URL)('serves verified world assets', async () => {
  const app = await createGameServer({ port: 0, worldDirectory: bundle });
  try {
    const info = await fetch(app.url + '/api/world').then((r) => r.json());
    const manifest = await fetch(app.url + info.manifestUrl).then((r) => r.json());
    const { definition } = await readWorldDirectory(bundle);
    expect(manifest.formatVersion).toBe(5);
    expect(manifest.mapVersion).toBe(info.mapVersion);
    expect(definition.buildings).toHaveLength(2);
    expect(app.room.diagnostics().bodies).toBe(
      definition.entities.length + definition.initialItems.length + definition.buildings.length,
    );
    for (const asset of Object.values(manifest.assets) as {
      modelFile: string;
      collisionFile: string;
    }[]) {
      const model = await fetch(new URL(asset.modelFile, app.url + info.manifestUrl).href);
      expect(model.status).toBe(200);
      expect(model.headers.get('cache-control')).toContain('immutable');
      const bytes = new Uint8Array(await model.arrayBuffer());
      expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe('glTF');
      expect(
        (await fetch(new URL(asset.collisionFile, app.url + info.manifestUrl).href)).status,
      ).toBe(200);
    }
    expect((await fetch(app.url + '/worlds/physics-lab/not-listed.glb')).status).toBe(404);
    expect((await fetch(app.url + '/health/ready')).status).toBe(200);
  } finally {
    await app.close();
  }
});

it('rejects a damaged release before starting a room, including visual resource corruption', async () => {
  const broken = join(temporary, 'broken');
  await cp(bundle, broken, { recursive: true });
  const { manifest } = await readWorldDirectory(broken);
  const asset = Object.values(manifest.assets)[0];
  const file = join(broken, asset.modelFile!);
  const bytes = await readFile(file);
  bytes[bytes.length - 1] ^= 1;
  await writeFile(file, bytes);
  await expect(createGameServer({ port: 0, worldDirectory: broken })).rejects.toThrow(
    'hash disagrees',
  );
});
