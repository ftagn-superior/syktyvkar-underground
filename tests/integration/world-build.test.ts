import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  canonicalJson,
  loadWorldBundle,
  simulationProjection,
  worldManifestIdentity,
  type BuildingPhysicsAsset,
  type WorldManifest,
} from '../../packages/contracts/src/index.js';
import { buildWorld } from '../../tools/world-build/src/index.js';
import { encodeStaticGlb, inspectStaticGlb } from '../../tools/world-build/src/glb.js';
import { addBox, meshPart } from '../../tools/world-build/src/house.js';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
async function withContent(run: (root: string, source: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'su-world-v2-'));
  try {
    await cp('content', join(root, 'content'), { recursive: true });
    await run(root, join(root, 'content/worlds/physics-lab/world.json'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
const readJson = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
const writeJson = (path: string, value: unknown) =>
  writeFile(path, JSON.stringify(value, null, 2) + '\n');
function rewriteGlbDocument(bytes: Uint8Array, mutate: (document: any) => void): Uint8Array {
  const original = Buffer.from(bytes),
    jsonLength = original.readUInt32LE(12);
  const document = JSON.parse(
    original
      .subarray(20, 20 + jsonLength)
      .toString('utf8')
      .trim(),
  );
  mutate(document);
  const text = Buffer.from(JSON.stringify(document)),
    padded = Math.ceil(text.length / 4) * 4;
  const binaryChunk = original.subarray(20 + jsonLength),
    result = Buffer.alloc(20 + padded + binaryChunk.length);
  original.copy(result, 0, 0, 20);
  result.writeUInt32LE(result.length, 8);
  result.writeUInt32LE(padded, 12);
  result.fill(0x20, 20, 20 + padded);
  text.copy(result, 20);
  binaryChunk.copy(result, 20 + padded);
  return result;
}
async function load(manifest: WorldManifest, output: string) {
  return loadWorldBundle(manifest, async (path, expected) => {
    const bytes = await readFile(resolve(output, path));
    expect(hash(bytes)).toBe(expected);
    return bytes;
  });
}
describe('world v3 release', () => {
  it('builds reproducible models and a verified graph of dependencies', async () =>
    withContent(async (root, source) => {
      const first = await buildWorld(source, join(root, 'first'));
      const second = await buildWorld(source, join(root, 'second'));
      expect(second).toEqual(first);
      expect(first.mapVersion).toBe(hash(canonicalJson(worldManifestIdentity(first))));
      for (const file of Object.keys(first.files))
        expect(await readFile(join(root, 'first', file))).toEqual(
          await readFile(join(root, 'second', file)),
        );
      const world = await load(first, join(root, 'first'));
      expect(world.buildings).toHaveLength(2);
      expect(Object.keys(world.buildingAssets)).toHaveLength(2);
      expect(first.simulationConfigHash).toBe(hash(canonicalJson(simulationProjection(world))));
      expect(world.buildingAssets['house-a'].colliders.map((c) => c.kind)).toEqual(['box', 'mesh']);
    }));
  it('isolates visual revisions from physics while tracking geometry and mass changes', async () =>
    withContent(async (root, source) => {
      const first = await buildWorld(source, join(root, 'initial'));
      const resolved = await load(first, join(root, 'initial'));
      Object.assign(resolved.buildingAssets['house-a'].colliders[0], { authoringColor: '#ffffff' });
      Object.assign(resolved.simulation.character, { displayName: 'Player' });
      Object.assign(resolved.buildings[0].position, { label: 'North' });
      expect(hash(canonicalJson(simulationProjection(resolved)))).toBe(first.simulationConfigHash);
      const recipePath = join(root, 'content/buildings/house-a/source.json');
      const recipe = await readJson(recipePath);
      recipe.wallColor = '#b5cad4';
      await writeJson(recipePath, recipe);
      const recolored = await buildWorld(source, join(root, 'recolored'));
      expect(recolored.mapVersion).not.toBe(first.mapVersion);
      expect(recolored.assets['house-a'].version).not.toBe(first.assets['house-a'].version);
      expect(recolored.simulationConfigHash).toBe(first.simulationConfigHash);
      recipe.roofHeight = 1.8;
      await writeJson(recipePath, recipe);
      const geometry = await buildWorld(source, join(root, 'geometry'));
      expect(geometry.simulationConfigHash).not.toBe(first.simulationConfigHash);
      const base = await readJson(source);
      base.entities[0].friction = 0.7;
      await writeJson(source, base);
      const mass = await buildWorld(source, join(root, 'mass'));
      expect(mass.simulationConfigHash).not.toBe(geometry.simulationConfigHash);
      base.simulation.character.sprintSpeed = 16;
      await writeJson(source, base);
      const sprint = await buildWorld(source, join(root, 'sprint'));
      expect(sprint.simulationConfigHash).not.toBe(mass.simulationConfigHash);
    }));
  it('stores one asset package for one hundred references with independent IDs and transforms', async () =>
    withContent(async (root, source) => {
      const path = join(root, 'content/worlds/physics-lab/cells/0_0.json');
      const cell = await readJson(path),
        original = cell.buildings[0];
      cell.buildings = Array.from({ length: 100 }, (_, index) => ({
        ...original,
        entityId: `copy-${index}`,
        rotation: {
          x: 0,
          y: Math.sin((index * Math.PI) / 100),
          z: 0,
          w: Math.cos((index * Math.PI) / 100),
        },
      }));
      await writeJson(path, cell);
      const output = join(root, 'release'),
        manifest = await buildWorld(source, output);
      expect(Object.keys(manifest.assets)).toEqual(['house-a']);
      expect(Object.keys(manifest.files).filter((path) => path.endsWith('.glb'))).toHaveLength(1);
      const world = await load(manifest, output);
      expect(world.buildings).toHaveLength(100);
      expect(world.buildings[25].rotation.y).toBeCloseTo(Math.SQRT1_2);
    }));
  it('imports a closed arch mesh without filling its passage and extracts semantic parts', async () =>
    withContent(async (root, source) => {
      const directory = join(root, 'content/buildings/arch');
      await mkdir(directory);
      const mesh = meshPart('arch-shell', 'wall', '#728994');
      addBox(mesh, { x: -1.75, y: 1.25, z: 0 }, { x: 0.5, y: 2.5, z: 1 });
      addBox(mesh, { x: 1.75, y: 1.25, z: 0 }, { x: 0.5, y: 2.5, z: 1 });
      addBox(mesh, { x: 0, y: 2.75, z: 0 }, { x: 4, y: 0.5, z: 1 });
      const model = encodeStaticGlb([mesh]);
      await writeFile(join(directory, 'source.glb'), model);
      const physics: BuildingPhysicsAsset = {
        assetId: 'arch',
        bounds: { min: { x: -2, y: 0, z: -0.5 }, max: { x: 2, y: 3, z: 0.5 } },
        colliders: [
          {
            id: 'shell',
            kind: 'mesh',
            position: { x: 0, y: 0, z: 0 },
            rotation: { x: 0, y: 0, z: 0, w: 1 },
            friction: 0.6,
            restitution: 0,
            vertices: mesh.positions,
            indices: mesh.indices,
          },
        ],
      };
      await writeJson(join(directory, 'colliders.json'), physics);
      await writeJson(join(directory, 'asset.json'), {
        formatVersion: 1,
        assetId: 'arch',
        source: { kind: 'glb', file: 'source.glb', collisionFile: 'colliders.json' },
      });
      const catalogPath = join(root, 'content/buildings/catalog.json'),
        catalog = await readJson(catalogPath);
      catalog.assets.arch = 'arch/asset.json';
      await writeJson(catalogPath, catalog);
      const cellPath = join(root, 'content/worlds/physics-lab/cells/0_0.json'),
        cell = await readJson(cellPath);
      cell.buildings[0].assetId = 'arch';
      await writeJson(cellPath, cell);
      const output = join(root, 'release'),
        manifest = await buildWorld(source, output);
      expect(await readFile(join(output, manifest.assets.arch.modelFile))).toEqual(
        Buffer.from(model),
      );
      const parts = await readJson(join(output, manifest.assets.arch.partsFile));
      expect(parts.parts).toEqual([
        { partId: 'arch-shell', role: 'wall', occlusionGroup: 'shell', nodeIndex: 0 },
      ]);
      const world = await load(manifest, output);
      expect(world.buildingAssets.arch.colliders[0].kind).toBe('mesh');
      physics.colliders[0].kind === 'mesh' && (physics.colliders[0].indices[0] = 99999);
      await writeJson(join(directory, 'colliders.json'), physics);
      await expect(buildWorld(source, join(root, 'bad'))).rejects.toThrow('mesh index range');
    }));
  it('rejects duplicate IDs, missing assets and escaping resource references', async () =>
    withContent(async (root, source) => {
      const path = join(root, 'content/worlds/physics-lab/cells/0_0.json'),
        cell = await readJson(path);
      cell.buildings[1].entityId = cell.buildings[0].entityId;
      await writeJson(path, cell);
      await expect(buildWorld(source, join(root, 'duplicate'))).rejects.toThrow('duplicate ID');
      cell.buildings[1].entityId = 'building-b';
      cell.buildings[1].assetId = 'missing';
      await writeJson(path, cell);
      await expect(buildWorld(source, join(root, 'missing'))).rejects.toThrow(
        'Unknown building asset',
      );
      cell.buildings[1].assetId = 'house-b';
      await writeJson(path, cell);
      const manifest = await buildWorld(source, join(root, 'good'));
      manifest.assets['house-a'].modelFile = '../outside.glb';
      await expect(load(manifest, join(root, 'good'))).rejects.toThrow('relative resource path');
    }));
  it('rejects inconsistent release bounds even if individual JSON files are otherwise valid', async () =>
    withContent(async (root, source) => {
      const output = join(root, 'release'),
        manifest = await buildWorld(source, output);
      manifest.bounds.max.x += 1;
      await expect(load(manifest, output)).rejects.toThrow('world bounds mismatch');
      manifest.bounds.max.x -= 1;
      manifest.assets['house-a'].bounds.max.y += 1;
      await expect(load(manifest, output)).rejects.toThrow('asset bounds mismatch');
      manifest.assets['house-a'].bounds.max.y -= 1;
      manifest.cells[0].bounds = structuredClone(manifest.bounds);
      manifest.cells[0].bounds.min.z = -10;
      await expect(load(manifest, output)).rejects.toThrow('outside containing bounds');
    }));
  it('converts authoring sRGB colors to linear glTF material factors', () => {
    const part = meshPart('wall', 'wall', '#808080');
    addBox(part, { x: 0, y: 0.5, z: 0 }, { x: 1, y: 1, z: 1 });
    const inspected = inspectStaticGlb(encodeStaticGlb([part]), 'test-house');
    const color = inspected.document.materials[0].pbrMetallicRoughness.baseColorFactor;
    expect(color[0]).toBeCloseTo(0.21586050011389926, 12);
    expect(color[1]).toBe(color[0]);
    expect(color[2]).toBe(color[0]);
    expect(color[3]).toBe(1);
  });
  it('rejects morph geometry and semantic tags that cannot map to visible static parts', () => {
    const part = meshPart('wall', 'wall', '#728994');
    addBox(part, { x: 0, y: 0.5, z: 0 }, { x: 1, y: 1, z: 1 });
    const model = encodeStaticGlb([part]);
    const inspect = (mutate: (document: any) => void) => () =>
      inspectStaticGlb(rewriteGlbDocument(model, mutate), 'test-house');
    expect(
      inspect((document) => {
        document.meshes[0].primitives[0].targets = [{ POSITION: 0 }];
      }),
    ).toThrow('morph targets');
    expect(
      inspect((document) => {
        document.nodes[0].weights = [1];
      }),
    ).toThrow('morph weights');
    expect(
      inspect((document) => {
        document.nodes.push({
          extras: { su: { partId: 'unused', role: 'detail', occlusionGroup: null } },
        });
      }),
    ).toThrow('semantic parts must own visible geometry');
    expect(
      inspect((document) => {
        document.nodes[0].extras.su.role = 'unknown';
      }),
    ).toThrow('part role');
    expect(
      inspect((document) => {
        delete document.nodes[0].extras;
      }),
    ).toThrow('parts');
  });
});
