import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PROTOCOL_VERSION,
  canonicalJson,
  loadWorldBundle,
  loadWorldCell,
  loadWorldHeader,
  loadCellPhysics,
  worldManifestIdentity,
  validateWorldManifest,
  WORLD_RESOURCE_LIMITS,
  type WorldCell,
  type WorldManifest,
} from '../../packages/contracts/src/index.js';
import { buildWorld } from '../../tools/world-build/src/index.js';
import { readWorldDirectory } from '../../apps/server/src/world-bundle.js';
import { createGameServer } from '../helpers/game-server.js';
import { createAuthoritativeWorld } from '../../packages/simulation/src/server.js';

let directory: string, release: string;
let manifest: WorldManifest;
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'su-large-map-l1-'));
  release = join(directory, 'release');
  manifest = await buildWorld('content/worlds/streaming-lab/world.json', release);
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

function fixture() {
  const current = structuredClone(manifest);
  const overrides = new Map<string, Uint8Array>();
  const requests: string[] = [];
  const read = async (file: string, expected: string) => {
    requests.push(file);
    const bytes = overrides.get(file) ?? (await readFile(join(release, file)));
    expect(hash(bytes)).toBe(expected);
    return bytes;
  };
  const rewrite = async (file: string, edit: (value: any) => void) => {
    const value = JSON.parse(new TextDecoder().decode(await read(file, current.files[file])));
    edit(value);
    const bytes = new TextEncoder().encode(canonicalJson(value));
    overrides.set(file, bytes);
    current.files[file] = hash(bytes);
    current.mapVersion = hash(canonicalJson(worldManifestIdentity(current)));
    requests.length = 0;
  };
  return { manifest: current, read, requests, rewrite };
}

describe('L1 spatial world release', () => {
  it('keeps ground contact through a side and a four-tile corner using actual movement', async () => {
    const { definition } = await readWorldDirectory(release);
    const world = await createAuthoritativeWorld(definition);
    try {
      for (const route of [
        { start: { x: -4, y: 0, z: 4 }, input: { moveX: 1, moveZ: 0 }, steps: 120 },
        { start: { x: -3, y: 0, z: -3 }, input: { moveX: 1, moveZ: 1 }, steps: 128 },
      ]) {
        expect(world.addPlayer('seam-check', route.start)).toBeDefined();
        world.setInput('seam-check', route.input);
        for (let step = 0; step < route.steps; step++) {
          world.step();
          const player = world.getSnapshot().players[0];
          expect(player.position.y).toBeGreaterThan(0.85);
          expect(player.position.y).toBeLessThan(1);
        }
        const player = world.getSnapshot().players[0];
        expect(player.position.x).toBeGreaterThan(2.9);
        expect(player.position.z).toBeGreaterThan(2.9);
        expect(world.diagnostics().bodies).toBe(1858);
        world.removePlayer('seam-check');
      }
    } finally {
      world.dispose();
    }
  });
  it('builds all 256 real cells deterministically and assembles unique full-world geometry', async () => {
    const repeated = await buildWorld(
      'content/worlds/streaming-lab/world.json',
      join(directory, 'repeat'),
    );
    expect(repeated).toEqual(manifest);
    for (const file of Object.keys(manifest.files))
      expect(await readFile(join(directory, 'repeat', file))).toEqual(
        await readFile(join(release, file)),
      );
    const { definition } = await readWorldDirectory(release);
    expect(manifest.grid).toEqual({
      origin: { x: -1000, z: -1000 },
      cellSize: 125,
      columns: 16,
      rows: 16,
    });
    expect(manifest.cells).toHaveLength(256);
    expect(definition.buildings).toHaveLength(1600);
    expect(definition.entities.filter((item) => item.entityId.startsWith('ground-'))).toHaveLength(
      256,
    );
    expect(
      new Set([...definition.entities, ...definition.buildings].map((item) => item.entityId)).size,
    ).toBe(1856);
    const referenceCounts = new Map<string, number>();
    const f = fixture();
    for (const entry of manifest.cells) {
      const cell = await loadWorldCell(manifest, entry.cellId, f.read);
      for (const item of cell.buildings)
        referenceCounts.set(item.entityId, (referenceCounts.get(item.entityId) ?? 0) + 1);
      expect(entry.bounds.max.x - entry.bounds.min.x).toBe(125);
      expect(entry.bounds.max.z - entry.bounds.min.z).toBe(125);
    }
    expect(referenceCounts.get('house-6-5-0')).toBe(2);
    expect(referenceCounts.get('house-5-5-0')).toBe(4);
  });

  it('loads the header and one local cell without reading remote models, other cells or visual assets', async () => {
    const f = fixture();
    const header = await loadWorldHeader(f.manifest, f.read);
    expect(f.requests).toEqual([manifest.worldFile]);
    expect(header.initialItems[0].typeId).toBe('wooden-crate');
    expect(header).not.toHaveProperty('entities');
    expect(header).not.toHaveProperty('buildings');
    f.requests.length = 0;
    const local = await loadCellPhysics(f.manifest, '8_8', f.read);
    expect(local.cell.buildings).toHaveLength(64);
    expect(local.cell.statics).toHaveLength(1);
    expect(Object.keys(local.buildingAssets).sort()).toEqual(['house-a', 'house-b']);
    expect(f.requests.sort()).toEqual(
      [
        manifest.cells.find((entry) => entry.cellId === '8_8')!.file,
        manifest.assets['house-a'].collisionFile,
        manifest.assets['house-b'].collisionFile,
      ].sort(),
    );
    expect(local).not.toHaveProperty('entities');
  });

  it('rejects conflicting IDs and incomplete duplicates even when every file hash is valid', async () => {
    const conflict = fixture();
    const file = manifest.cells.find((entry) => entry.cellId === '6_5')!.file;
    await conflict.rewrite(file, (cell: WorldCell) => {
      cell.buildings.find((item) => item.entityId === 'house-6-5-0')!.position.x += 0.2;
    });
    await expect(loadWorldBundle(conflict.manifest, conflict.read)).rejects.toThrow(
      'Conflicting entity ID',
    );
    const missing = fixture();
    await missing.rewrite(file, (cell: WorldCell) => {
      cell.buildings = cell.buildings.filter((item) => item.entityId !== 'house-6-5-0');
    });
    await expect(loadWorldBundle(missing.manifest, missing.read)).rejects.toThrow(
      'incomplete cell coverage',
    );
  });

  it('rejects false dependencies, stale cells, wrong grid bounds and invalid header contents', async () => {
    const f = fixture();
    const entry = f.manifest.cells.find((item) => item.cellId === '8_8')!;
    entry.assetIds.push('house-remote-a');
    await expect(loadWorldCell(f.manifest, '8_8', f.read)).rejects.toThrow('dependency mismatch');
    const stale = fixture();
    await stale.rewrite(entry.file, (cell) => {
      cell.formatVersion = 1;
    });
    await expect(loadWorldCell(stale.manifest, '8_8', stale.read)).rejects.toThrow('cell');
    const wrongBounds = structuredClone(manifest);
    wrongBounds.cells[0].bounds.max.x++;
    expect(() => validateWorldManifest(wrongBounds)).toThrow('cell bounds disagree');
    const header = fixture();
    await header.rewrite(manifest.worldFile, (value) => {
      value.entities = [];
    });
    await expect(loadWorldHeader(header.manifest, header.read)).rejects.toThrow(
      'header must not contain static data',
    );
    const oldManifest = { ...manifest, formatVersion: 2 };
    expect(() => validateWorldManifest(oldManifest)).toThrow('manifest version');
    await expect(loadWorldCell(manifest, '16_0', f.read)).rejects.toThrow('unknown cell');
  });

  it('rejects oversized cell resources before decoding or constructing physics', async () => {
    const f = fixture();
    const file = manifest.cells.find((entry) => entry.cellId === '8_8')!.file;
    await f.rewrite(file, (cell) => {
      cell.padding = 'x'.repeat(WORLD_RESOURCE_LIMITS.cellBytes);
    });
    await expect(loadWorldCell(f.manifest, '8_8', f.read)).rejects.toThrow('resource byte limit');
    expect(f.requests).toEqual([file]);
  });

  it.skipIf(!process.env.SU_TEST_DATABASE_URL)(
    'uses the manifest world ID for HTTP routes, serves only listed files and starts one complete simulation',
    async () => {
      await writeFile(join(release, 'private.txt'), 'not a published resource');
      const app = await createGameServer({ port: 0, worldDirectory: release });
      try {
        const info = await fetch(`${app.url}/api/world`).then((response) => response.json());
        expect(info.protocolVersion).toBe(PROTOCOL_VERSION);
        expect(info.manifestUrl).toMatch(
          /^\/worlds\/streaming-lab\/layouts\/[a-f0-9]{64}\/[a-f0-9]{64}\/manifest\.json$/,
        );
        const received = await fetch(app.url + info.manifestUrl).then((response) =>
          response.json(),
        );
        expect(received).toEqual(manifest);
        expect(
          (await fetch(new URL(manifest.worldFile, app.url + info.manifestUrl).href)).status,
        ).toBe(200);
        expect((await fetch(`${app.url}/worlds/streaming-lab/private.txt`)).status).toBe(404);
        expect((await fetch(`${app.url}/worlds/physics-lab/manifest.json`)).status).toBe(404);
        expect((await fetch(`${app.url}/worlds/streaming-lab/../private.txt`)).status).toBe(404);
        expect((await fetch(`${app.url}/health/ready`)).status).toBe(200);
        expect(app.room.diagnostics().bodies).toBe(1857);
        expect(app.room.diagnostics().players).toBe(0);
      } finally {
        await app.close();
      }
    },
  );

  it('partitions primitive overlaps and merges identical source definitions while rejecting conflicts', async () => {
    const content = join(directory, 'primitive-source');
    await cp('content', content, { recursive: true });
    const path = join(content, 'worlds/physics-lab/world.json');
    const source = JSON.parse(await readFile(path, 'utf8'));
    source.bounds.max.x = 230;
    source.cells.push('cells/second.json');
    const originalPath = join(content, 'worlds/physics-lab/cells/0_0.json');
    const original = JSON.parse(await readFile(originalPath, 'utf8'));
    original.statics.push({
      ...source.entities[0],
      entityId: 'seam-box',
      position: { x: 105, y: 1, z: 0 },
      size: { x: 2, y: 2, z: 2 },
    });
    const second = {
      formatVersion: 2,
      cellId: 'second',
      statics: [],
      buildings: [original.buildings[0]],
    };
    const secondPath = join(content, 'worlds/physics-lab/cells/second.json');
    await writeFile(path, JSON.stringify(source));
    await writeFile(originalPath, JSON.stringify(original));
    await writeFile(secondPath, JSON.stringify(second));
    const output = join(directory, 'primitive-release');
    const result = await buildWorld(path, output);
    expect(result.cells).toHaveLength(2);
    const { definition } = await readWorldDirectory(output);
    expect(definition.buildings).toHaveLength(2);
    expect(definition.entities.filter((item) => item.entityId === 'seam-box')).toHaveLength(1);
    for (const entry of result.cells) {
      const cell = JSON.parse(await readFile(join(output, entry.file), 'utf8')) as WorldCell;
      expect(cell.statics.some((item) => item.entityId === 'seam-box')).toBe(true);
    }
    second.buildings[0].position.x++;
    await writeFile(secondPath, JSON.stringify(second));
    await expect(buildWorld(path, join(directory, 'conflict'))).rejects.toThrow(
      'Conflicting entity ID',
    );
  });

  it('changes the layout hash without changing physical identity or adding walls', async () => {
    const content = join(directory, 'grid-source');
    await cp('content', content, { recursive: true });
    const sourcePath = join(content, 'worlds/physics-lab/world.json');
    const source = JSON.parse(await readFile(sourcePath, 'utf8'));
    const original = await buildWorld(sourcePath, join(directory, 'grid-one'));
    source.cellSize = 20;
    await writeFile(sourcePath, JSON.stringify(source));
    const split = await buildWorld(sourcePath, join(directory, 'grid-four'));
    expect(split.cells).toHaveLength(4);
    expect(split.mapVersion).not.toBe(original.mapVersion);
    expect(split.simulationConfigHash).toBe(original.simulationConfigHash);
    const { definition } = await readWorldDirectory(join(directory, 'grid-four'));
    const world = await createAuthoritativeWorld(definition);
    try {
      expect(world.diagnostics().bodies).toBe(14);
    } finally {
      world.dispose();
    }
  });
});
