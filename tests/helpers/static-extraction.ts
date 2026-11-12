import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  loadWorldBundle,
  type BuildingInstance,
  type WorldDefinition,
  type WorldManifest,
} from '../../packages/contracts/src/index.js';
import { transformWorldPoint } from '../../packages/contracts/src/world-grid.js';

export const extractionFixture = 'tests/fixtures/static-extraction';
export const sha256 = (bytes: string | Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
export const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
export async function oldExtractionWorld(): Promise<WorldDefinition> {
  return JSON.parse(gunzipSync(await readFile(`${extractionFixture}/world.json.gz`)).toString());
}
export async function readRelease(directory: string) {
  const manifest: WorldManifest = await json(resolve(directory, 'manifest.json'));
  const read = async (path: string, expected: string) => {
    const bytes = await readFile(resolve(directory, path));
    if (sha256(bytes) !== expected) throw new Error(`Evidence SHA-256 mismatch: ${path}`);
    return bytes;
  };
  const world = await loadWorldBundle(manifest, read);
  return { manifest, world };
}

// A triangle retains winding, linear vertex colors and fade membership. Mesh names,
// indices, grouping and local pivots deliberately do not participate in comparison.
export type EvidenceTriangle = { fade: boolean; role: string; vertices: number[][] };
export function glbTriangles(bytes: Uint8Array, instance: BuildingInstance): EvidenceTriangle[] {
  const buffer = Buffer.from(bytes);
  const length = buffer.readUInt32LE(12);
  const doc = JSON.parse(
    buffer
      .subarray(20, 20 + length)
      .toString()
      .trim(),
  );
  const binary = 28 + length;
  const accessor = (index: number) => {
    const a = doc.accessors[index],
      v = doc.bufferViews[a.bufferView];
    const count = a.type === 'VEC3' ? 3 : 1;
    const width = a.componentType === 5123 ? 2 : 4;
    const start = binary + (v.byteOffset ?? 0) + (a.byteOffset ?? 0);
    return Array.from({ length: a.count }, (_, i) =>
      Array.from({ length: count }, (_, c) => {
        const offset = start + i * (v.byteStride ?? width * count) + c * width;
        return a.componentType === 5126
          ? buffer.readFloatLE(offset)
          : a.componentType === 5123
            ? buffer.readUInt16LE(offset)
            : buffer.readUInt32LE(offset);
      }),
    );
  };
  return doc.nodes.flatMap((node: any) => {
    if (node.mesh === undefined) return [];
    if (node.matrix || node.translation || node.rotation || node.scale)
      throw new Error('Evidence reader requires generated identity GLB nodes');
    return doc.meshes[node.mesh].primitives.flatMap((p: any) => {
      const positions = accessor(p.attributes.POSITION);
      const colors =
        p.attributes.COLOR_0 === undefined ? undefined : accessor(p.attributes.COLOR_0);
      const material = doc.materials[p.material].pbrMetallicRoughness.baseColorFactor;
      const indices = accessor(p.indices).flat();
      return Array.from({ length: indices.length / 3 }, (_, i) => ({
        fade: node.extras.su.occlusionGroup !== null,
        role: node.extras.su.role,
        vertices: indices.slice(i * 3, i * 3 + 3).map((id: number) => {
          const [x, y, z] = positions[id];
          const world = transformWorldPoint({ x, y, z }, instance.position, instance.rotation);
          // glTF multiplies linear vertex colors by the material base color.
          const color = material
            .slice(0, 3)
            .map((channel: number, c: number) => channel * (colors?.[id]?.[c] ?? 1));
          return [world.x, world.y, world.z, ...color];
        }),
      }));
    });
  });
}
export async function releaseTriangles(
  directory: string,
  manifest: WorldManifest,
  instances: BuildingInstance[],
) {
  const models = new Map<string, Uint8Array>();
  const result: EvidenceTriangle[] = [];
  for (const instance of instances) {
    let bytes = models.get(instance.assetId);
    if (!bytes) {
      bytes = await readFile(resolve(directory, manifest.assets[instance.assetId].modelFile));
      models.set(instance.assetId, bytes);
    }
    result.push(...glbTriangles(bytes, instance));
  }
  return result;
}

/** Multiplicity-preserving matching, independent of the extraction algorithm. */
export function compareTriangles(
  before: EvidenceTriangle[],
  after: EvidenceTriangle[],
  tolerance = 0.001,
  minimumAmbientFactor = 1,
) {
  if (before.length !== after.length)
    throw new Error(`Triangle count: ${before.length} != ${after.length}`);
  const buckets = new Map<string, EvidenceTriangle[]>();
  const location = (t: EvidenceTriangle) =>
    [0, 1, 2].map((a) => Math.floor(t.vertices.reduce((sum, p) => sum + p[a], 0) / 3 / 0.01));
  const key = (t: EvidenceTriangle, p: number[]) => `${t.fade}:${t.role}:${p.join(',')}`;
  for (const triangle of before) {
    const k = key(triangle, location(triangle));
    const list = buckets.get(k) ?? [];
    list.push(triangle);
    buckets.set(k, list);
  }
  let maxVertexDelta = 0,
    minColorFactor = 1,
    shadedVertices = 0;
  for (const triangle of after) {
    const p = location(triangle);
    let best:
      { list: EvidenceTriangle[]; index: number; delta: number; factors: number[] } | undefined;
    for (const x of [0, -1, 1])
      for (const y of [0, -1, 1])
        for (const z of [0, -1, 1]) {
          const list = buckets.get(key(triangle, [p[0] + x, p[1] + y, p[2] + z]));
          if (!list?.length) continue;
          for (let i = 0; i < list.length; i++)
            for (let shift = 0; shift < 3; shift++) {
              let delta = 0,
                colorDelta = 0;
              const factors: number[] = [];
              for (let v = 0; v < 3; v++) {
                const a = triangle.vertices[v],
                  b = list[i].vertices[(v + shift) % 3];
                delta = Math.max(delta, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
                // One neutral multiplier per vertex permits baked AO, while
                // still rejecting palette changes, brightening and deep shade.
                const squared = b[3] ** 2 + b[4] ** 2 + b[5] ** 2;
                const factor = squared
                  ? Math.max(
                      minimumAmbientFactor,
                      Math.min(1, (a[3] * b[3] + a[4] * b[4] + a[5] * b[5]) / squared),
                    )
                  : 1;
                factors.push(factor);
                for (let c = 3; c < 6; c++)
                  colorDelta = Math.max(colorDelta, Math.abs(a[c] - b[c] * factor));
              }
              if (delta <= tolerance && colorDelta <= 1e-6 && (!best || delta < best.delta))
                best = { list, index: i, delta, factors };
            }
        }
    if (!best) throw new Error(`Unmatched world triangle: ${JSON.stringify(triangle)}`);
    maxVertexDelta = Math.max(maxVertexDelta, best.delta);
    minColorFactor = Math.min(minColorFactor, ...best.factors);
    shadedVertices += best.factors.filter((factor) => factor < 0.9999).length;
    best.list.splice(best.index, 1);
  }
  return { triangles: before.length, maxVertexDelta, minColorFactor, shadedVertices };
}

function multiplyQuaternion(a: any, b: any) {
  const q = {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
  const sign = q.w < 0 ? -1 : 1;
  return Object.fromEntries(Object.entries(q).map(([k, v]) => [k, v * sign]));
}
export function worldColliders(world: WorldDefinition, instances = world.buildings) {
  return instances.flatMap((instance) =>
    world.buildingAssets[instance.assetId].colliders.map((c) => {
      const { id: _id, position, rotation, ...shape } = c;
      return {
        ...shape,
        position: transformWorldPoint(position, instance.position, instance.rotation),
        rotation: multiplyQuaternion(instance.rotation, rotation),
      };
    }),
  );
}

export function compareColliders(
  before: ReturnType<typeof worldColliders>,
  after: ReturnType<typeof worldColliders>,
) {
  if (before.length !== after.length) throw new Error('Collider count changed');
  const remaining = new Set(before);
  let maxDelta = 0;
  let maxRotationRadians = 0;
  function difference(a: any, b: any): number {
    if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b);
    if (typeof a !== 'object' || a === null || b === null || typeof b !== 'object')
      return a === b ? 0 : Infinity;
    if (JSON.stringify(Object.keys(a).sort()) !== JSON.stringify(Object.keys(b).sort()))
      return Infinity;
    return Math.max(0, ...Object.keys(a).map((k) => difference(a[k], b[k])));
  }
  for (const collider of after) {
    let best: (typeof before)[number] | undefined,
      delta = Infinity;
    for (const candidate of remaining) {
      if (
        candidate.kind !== collider.kind ||
        Math.hypot(
          ...(['x', 'y', 'z'] as const).map((k) => candidate.position[k] - collider.position[k]),
        ) > 1e-6
      )
        continue;
      const d = difference(candidate, collider);
      const rotationDistance = Math.min(
        Math.hypot(
          ...Object.keys(candidate.rotation).map(
            (k) => candidate.rotation[k] - collider.rotation[k],
          ),
        ),
        Math.hypot(
          ...Object.keys(candidate.rotation).map(
            (k) => candidate.rotation[k] + collider.rotation[k],
          ),
        ),
      );
      if (4 * Math.asin(Math.min(1, rotationDistance / 2)) > 1e-6) continue;
      if (d < delta) {
        best = candidate;
        delta = d;
      }
    }
    if (!best || delta > 1e-6)
      throw new Error(`World collider changed: ${JSON.stringify(collider)}`);
    remaining.delete(best);
    maxDelta = Math.max(maxDelta, delta);
    const rotationDistance = Math.hypot(
      ...Object.keys(best.rotation).map((k) => best.rotation[k] - collider.rotation[k]),
    );
    maxRotationRadians = Math.max(
      maxRotationRadians,
      4 * Math.asin(Math.min(1, rotationDistance / 2)),
    );
  }
  return { colliders: before.length, maxNumericDelta: maxDelta, maxRotationRadians };
}
