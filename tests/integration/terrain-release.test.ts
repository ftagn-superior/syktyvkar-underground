import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { buildWorld } from '../../tools/world-build/src/index.js';
import {
  readAuthoringRelease,
  createLayoutPublication,
} from '../../apps/server/src/layout/release.js';
import {
  authoringMetadata,
  hash,
  jsonBytes,
  writeAuthoringMetadata,
} from '../../packages/world-release/src/index.js';
import { validateTerrainPrivateData } from '../../packages/terrain-build/src/private-data.js';

let temporary: string, directory: string;
let release: Awaited<ReturnType<typeof readAuthoringRelease>>;
beforeAll(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'su-terrain-release-'));
  directory = join(temporary, 'release');
  await buildWorld('content/worlds/terrain-lab/world.json', directory);
  release = await readAuthoringRelease(directory);
});
afterAll(async () => {
  if (temporary) await rm(temporary, { recursive: true, force: true });
});

async function copy(name: string) {
  const target = join(temporary, name);
  await cp(directory, target, { recursive: true });
  return target;
}
async function publishPrivate(target: string, data: unknown) {
  await writeAuthoringMetadata(
    release.definition,
    release.manifest,
    release.metadata.fixedInstanceIds,
    target,
    jsonBytes(data),
  );
}

describe('private terrain release', () => {
  it('keeps versioned support inputs off the public manifest and layout publication', async () => {
    const ref = release.metadata.terrain!;
    expect(ref.file).toBe(`private/terrain.${ref.sha256}.json`);
    expect(hash(await readFile(join(directory, ref.file)))).toBe(ref.sha256);
    expect(release.terrain!.grid.heights).toHaveLength(41 * 41);
    expect(release.terrain!.supports.map((s) => s.ownerId)).toEqual([
      'lower-house',
      'summit-house',
      'slope-house',
    ]);
    const labTerrain = release.terrain!;
    if (labTerrain.formatVersion !== 1) throw new Error('Lab terrain must remain v1');
    expect(labTerrain.supports[2].approach).toEqual({ length: 6, width: 1.5 });
    const { publication } = await createLayoutPublication(release, {
      formatVersion: 1,
      worldId: release.definition.worldId,
      assetReleaseVersion: release.metadata.assetReleaseVersion,
      seedVersion: release.metadata.seedVersion,
      revision: 1,
      instances: release.seed,
    });
    expect(publication.manifest).toEqual(release.manifest);
    expect(Object.keys(publication.manifest.files).some((p) => p.startsWith('private/'))).toBe(
      false,
    );
    expect(publication.payloads.has(ref.file)).toBe(false);
  });

  it('invalidates release compatibility when only a support rule changes', async () => {
    const target = await copy('changed-rule');
    const data = structuredClone(release.terrain!);
    data.supports[0].clearance += 0.1;
    await publishPrivate(target, data);
    const changed = await readAuthoringRelease(target);
    expect(changed.metadata.assetReleaseVersion).not.toBe(release.metadata.assetReleaseVersion);
    expect(changed.metadata.seedVersion).toBe(release.metadata.seedVersion);
    expect(changed.manifest).toEqual(release.manifest);
  });

  it('rejects missing, corrupt and traversing private references', async () => {
    const missing = await copy('missing');
    await rm(join(missing, release.metadata.terrain!.file));
    await expect(readAuthoringRelease(missing)).rejects.toThrow();
    const corrupt = await copy('corrupt');
    await writeFile(join(corrupt, release.metadata.terrain!.file), '{}');
    await expect(readAuthoringRelease(corrupt)).rejects.toThrow('hash mismatch');
    const traversal = await copy('traversal');
    const metadata = structuredClone(release.metadata);
    metadata.terrain!.file = '../terrain.json';
    await writeFile(join(traversal, 'authoring.json'), jsonBytes(metadata));
    await expect(readAuthoringRelease(traversal)).rejects.toThrow(
      'Invalid private terrain reference',
    );
  });

  it('rejects correctly hashed but unsupported versions, wrong worlds, grids and owners', async () => {
    const modifications = [
      (d: any) => {
        d.formatVersion = 2;
      },
      (d: any) => {
        d.generatorVersion = 'terrain-build/unknown';
      },
      (d: any) => {
        d.worldId = 'another-world';
      },
      (d: any) => {
        d.grid.heights[0] = null;
      },
      (d: any) => {
        d.grid.origin.x += 1;
      },
      (d: any) => {
        d.supports[0].ownerId = 'missing-owner';
      },
      (d: any) => {
        d.supports[0].assetId = 'wrong-model';
      },
      (d: any) => {
        d.supports[0].clearance = -1;
      },
    ];
    for (const [i, modify] of modifications.entries()) {
      const target = await copy(`invalid-${i}`),
        data = structuredClone(release.terrain!);
      modify(data);
      await publishPrivate(target, data);
      await expect(readAuthoringRelease(target)).rejects.toThrow();
    }
    const data = structuredClone(release.terrain!);
    data.supports[0].ownerId = 'placed_12345678-1234-1234-1234-123456789abc';
    expect(validateTerrainPrivateData(data)).toEqual(data);
  });

  it('loads and uses the shared compiler in a standalone server bundle with only release files', async () => {
    const entry = join(temporary, 'read-release.mjs');
    const result = await build({
      stdin: {
        contents: `
        import { readAuthoringRelease } from ${JSON.stringify(resolve('apps/server/src/layout/release.ts'))};
        import { terrainPatch, terrainSolid, rectangle } from ${JSON.stringify(resolve('packages/terrain-build/src/index.ts'))};
        import { compileGeneratedAsset } from ${JSON.stringify(resolve('packages/terrain-build/src/assets.ts'))};
        const release = await readAuthoringRelease(process.argv[2]);
        const patch = terrainPatch(release.terrain.grid, rectangle(0, 0, 2, 2));
        const solid = terrainSolid('standalone-support', patch, p => p.y + 1, p => p.y - .02, '#888888');
        const compiled = compileGeneratedAsset('standalone-support', solid);
        console.log(JSON.stringify({ worldId: release.terrain.worldId, version: compiled.version }));
      `,
        resolveDir: process.cwd(),
      },
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node24',
      outfile: entry,
      metafile: true,
    });
    expect(
      Object.keys(result.metafile!.inputs).some((p) => /(?:^|\/)(tools|content)\//.test(p)),
    ).toBe(false);
    const { stdout } = await promisify(execFile)(process.execPath, [entry, directory], {
      cwd: temporary,
    });
    expect(JSON.parse(stdout)).toEqual({
      worldId: 'terrain-lab',
      version: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it('preserves the exact legacy metadata formula for non-terrain worlds', async () => {
    const target = join(temporary, 'physics');
    await buildWorld('content/worlds/physics-lab/world.json', target);
    const plain = await readAuthoringRelease(target);
    expect(plain.terrain).toBeUndefined();
    expect(plain.metadata).not.toHaveProperty('terrain');
    const { definition: world, manifest, metadata } = plain;
    const sort = (a: { entityId: string }, b: { entityId: string }) =>
      a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0;
    const fixed = new Set(metadata.fixedInstanceIds);
    const legacy = {
      formatVersion: 1,
      assetReleaseVersion: hash(
        jsonBytes({
          worldId: world.worldId,
          header: manifest.worldFile,
          grid: manifest.grid,
          assets: manifest.assets,
          statics: [...world.entities].sort(sort),
          fixed: world.buildings.filter((b) => fixed.has(b.entityId)).sort(sort),
        }).slice(0, -1),
      ),
      seedVersion: hash(
        jsonBytes(world.buildings.filter((b) => !fixed.has(b.entityId)).sort(sort)).slice(0, -1),
      ),
      fixedInstanceIds: [...metadata.fixedInstanceIds].sort(),
    };
    expect(authoringMetadata(world, manifest, metadata.fixedInstanceIds)).toEqual(legacy);
    expect(metadata).toEqual(legacy);
  });
});
