/** Actual transformed kit colliders from the immutable pilot, for preliminary access screening. */
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  loadWorldBundle,
  validateWorldManifest,
  type Quat,
  type Vec3,
  type WorldLayoutSnapshot,
} from '../packages/contracts/src/index.js';
import { readRingModelSupportCatalog } from './world-build/src/ring-support-authoring.js';

const directory = process.argv[2] ?? 'output/ring-terrain-stage4/export-world';
const outputPath =
  process.argv[3] ?? 'output/ring-terrain-stage4/entrance-approaches/actual-kit-colliders.json';
const snapshotPath = process.argv[4];
const manifest = validateWorldManifest(
  JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')),
);
const world = await loadWorldBundle(manifest, async (path, expectedHash) => {
  const bytes = await readFile(join(directory, path));
  if (createHash('sha256').update(bytes).digest('hex') !== expectedHash)
    throw new Error(`Invalid resource hash: ${path}`);
  return bytes;
});
const catalog = await readRingModelSupportCatalog();
const kits = new Set(catalog.models.filter((m) => m.source.kind === 'kit').map((m) => m.assetId));
const snapshotBytes = snapshotPath ? await readFile(snapshotPath) : undefined;
const loaded = snapshotBytes ? JSON.parse(snapshotBytes.toString()) : undefined;
const snapshot: WorldLayoutSnapshot | undefined = loaded?.targetSnapshot ?? loaded;
const instances = snapshot
  ? snapshot.instances.filter((o) => o.enabled && kits.has(o.assetId))
  : world.buildings.filter((o) => kits.has(o.assetId));
for (const owner of instances)
  assert.ok(
    world.buildingAssets[owner.assetId],
    `Missing immutable physics asset ${owner.assetId}`,
  );
function transform(point: Vec3, rotation: Quat, position: Vec3): Vec3 {
  const tx = 2 * (rotation.y * point.z - rotation.z * point.y);
  const ty = 2 * (rotation.z * point.x - rotation.x * point.z);
  const tz = 2 * (rotation.x * point.y - rotation.y * point.x);
  return {
    x: point.x + rotation.w * tx + rotation.y * tz - rotation.z * ty + position.x,
    y: point.y + rotation.w * ty + rotation.z * tx - rotation.x * tz + position.y,
    z: point.z + rotation.w * tz + rotation.x * ty - rotation.y * tx + position.z,
  };
}
const colliders = [];
for (const owner of instances) {
  for (const collider of world.buildingAssets[owner.assetId].colliders) {
    const local: Vec3[] = [];
    if (collider.kind === 'box') {
      for (const x of [-1, 1])
        for (const y of [-1, 1])
          for (const z of [-1, 1]) {
            local.push({
              x: (x * collider.size.x) / 2,
              y: (y * collider.size.y) / 2,
              z: (z * collider.size.z) / 2,
            });
          }
    } else {
      for (let i = 0; i < collider.vertices.length; i += 3) {
        local.push({
          x: collider.vertices[i],
          y: collider.vertices[i + 1],
          z: collider.vertices[i + 2],
        });
      }
    }
    const vertices = local.map((p) =>
      transform(transform(p, collider.rotation, collider.position), owner.rotation, owner.position),
    );
    colliders.push({
      entityId: owner.entityId,
      assetId: owner.assetId,
      colliderId: collider.id,
      kind: collider.kind,
      vertices: vertices.map((p) => [p.x, p.y, p.z]),
      ...(collider.kind === 'mesh' ? { indices: collider.indices } : {}),
    });
  }
}
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(
  outputPath,
  JSON.stringify({
    formatVersion: 1,
    status: snapshot
      ? 'diagnostic-immutable-kit-assets-at-proposed-placements'
      : 'diagnostic-final-pilot-kit-colliders',
    mapVersion: manifest.mapVersion,
    source: directory,
    placementSource: snapshotPath ?? 'immutable-world',
    ...(snapshotBytes
      ? { placementSourceSha256: createHash('sha256').update(snapshotBytes).digest('hex') }
      : {}),
    limitations: ['Generated support caps and non-kit buildings are screened separately.'],
    colliders,
  }) + '\n',
);
console.log(
  JSON.stringify({
    mapVersion: manifest.mapVersion,
    kitInstances: instances.length,
    colliders: colliders.length,
  }),
);
