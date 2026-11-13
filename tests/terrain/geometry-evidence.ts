import {
  sampleTerrain,
  terrainCellTriangles,
  type TerrainGrid,
  type WorldDefinition,
  type WorldManifest,
} from '../../packages/contracts/src/index.js';
import {
  terrainContours,
  patchRange,
  rectangle,
  terrainPatch,
  type TerrainSurface,
} from '../../tools/world-build/src/terrain.js';

/** Inspect the saved GLB accessors as well as the saved collision meshes. */
export async function terrainGeometryEvidence(
  g: TerrainGrid,
  world: WorldDefinition,
  manifest: WorldManifest,
  surfaces: TerrainSurface[],
  read: (file: string) => Promise<Uint8Array>,
) {
  const range = patchRange(terrainPatch(g, rectangle(1, -7, 6, 4)));
  const contour = terrainContours(g, 3).flat();
  const deviation = Math.max(
    0,
    ...contour
      .filter(([x, z]) => x >= -4 && x <= 16 && z >= -16 && z <= 4)
      .map(([x, z]) => Math.abs(z - x + 12) / Math.SQRT2),
  );
  const normals = [sampleTerrain(g, -4, -16)!.normal, sampleTerrain(g, 16, 4)!.normal];
  const normalAngle =
    contour.length === 0
      ? 0
      : (Math.acos(
          (normals[0].x * normals[1].x + normals[0].z * normals[1].z) /
            Math.hypot(normals[0].x, normals[0].z) /
            Math.hypot(normals[1].x, normals[1].z),
        ) *
          180) /
        Math.PI;
  let maxSlope = 0,
    groundTopTriangles = 0,
    groundSolidTriangles = 0,
    coverTriangles = 0,
    coverSamples = 0,
    maxCoverError = 0;
  for (let z = 0; z < g.rows - 1; z++)
    for (let x = 0; x < g.columns - 1; x++)
      for (const t of terrainCellTriangles(g, x, z)) {
        const n = sampleTerrain(
          g,
          (t[0].x + t[1].x + t[2].x) / 3,
          (t[0].z + t[1].z + t[2].z) / 3,
        )!.normal;
        maxSlope = Math.max(maxSlope, (Math.acos(n.y) * 180) / Math.PI);
      }
  for (const asset of Object.values(manifest.assets).filter((a) =>
    a.assetId.startsWith('terrain-tile-'),
  )) {
    if (!asset.modelFile) throw new Error(`Terrain tile must publish a GLB: ${asset.assetId}`);
    const raw = await read(asset.modelFile),
      bytes = Buffer.from(raw);
    const jsonLength = bytes.readUInt32LE(12),
      doc = JSON.parse(
        bytes
          .subarray(20, 20 + jsonLength)
          .toString('utf8')
          .trim(),
      );
    const binary = bytes.subarray(28 + jsonLength);
    const accessor = (id: number) => {
      const a = doc.accessors[id],
        v = doc.bufferViews[a.bufferView],
        count = a.count * (a.type === 'VEC3' ? 3 : 1);
      const start = (v.byteOffset ?? 0) + (a.byteOffset ?? 0);
      return Array.from({ length: count }, (_, i) =>
        a.componentType === 5126
          ? binary.readFloatLE(start + i * 4)
          : binary.readUInt32LE(start + i * 4),
      );
    };
    for (const mesh of doc.meshes)
      for (const primitive of mesh.primitives) {
        const positions = accessor(primitive.attributes.POSITION),
          indices = accessor(primitive.indices);
        const layer = surfaces.find((s) => s.id === mesh.name);
        if (mesh.name === 'solid') groundSolidTriangles += indices.length / 3;
        else if (!layer) throw new Error(`Unknown published terrain layer ${mesh.name}`);
        for (let i = 0; i < indices.length; i += 3) {
          const pts = indices.slice(i, i + 3).map((j) => ({
            x: positions[j * 3],
            y: positions[j * 3 + 1],
            z: positions[j * 3 + 2],
          }));
          if (!layer) {
            if (pts.every((p) => Math.abs(p.y - sampleTerrain(g, p.x, p.z)!.height) < 1e-6))
              groundTopTriangles++;
            continue;
          }
          coverTriangles++;
          const centroid = pts.reduce(
            (s, p) => ({ x: s.x + p.x / 3, y: s.y + p.y / 3, z: s.z + p.z / 3 }),
            { x: 0, y: 0, z: 0 },
          );
          for (const p of [...pts, centroid]) {
            coverSamples++;
            maxCoverError = Math.max(
              maxCoverError,
              Math.abs(p.y - layer.offset - sampleTerrain(g, p.x, p.z)!.height),
            );
          }
        }
      }
  }
  let foundationSamples = 0,
    maxFoundationError = 0;
  const house = world.buildings.find((b) => b.entityId === 'slope-house')!;
  const collider = world.buildingAssets['slope-house-foundation'].colliders[0];
  if (collider.kind !== 'mesh') throw new Error('Missing saved foundation mesh');
  for (let i = 0; i < collider.indices.length; i += 3) {
    const pts = collider.indices.slice(i, i + 3).map((j) => ({
      x: collider.vertices[j * 3],
      y: collider.vertices[j * 3 + 1],
      z: collider.vertices[j * 3 + 2],
    }));
    if (pts.some((p) => Math.abs(p.y - house.position.y) < 1e-6)) continue;
    const centroid = pts.reduce(
      (s, p) => ({ x: s.x + p.x / 3, y: s.y + p.y / 3, z: s.z + p.z / 3 }),
      { x: 0, y: 0, z: 0 },
    );
    for (const p of [...pts, centroid]) {
      foundationSamples++;
      maxFoundationError = Math.max(
        maxFoundationError,
        Math.abs(p.y + 0.02 - sampleTerrain(g, p.x, p.z)!.height),
      );
    }
  }
  return {
    cornerHeights: [
      [-20, -20],
      [-20, 20],
      [20, 20],
      [20, -20],
    ].map(([x, z]) => sampleTerrain(g, x, z)!.height),
    contours: [1.5, 3, 4.5].map((height) => ({
      height,
      segments: terrainContours(g, height).length,
    })),
    contour3ChordDeviationMetres: deviation,
    normalDirectionAngleDegrees: normalAngle,
    maxSlopeDegrees: maxSlope,
    foundation: {
      terrainMin: range.min,
      terrainMax: range.max,
      range: range.max - range.min,
      floorY: house.position.y,
      samples: foundationSamples,
      maxError: maxFoundationError,
    },
    groundTopTriangles,
    groundSolidTriangles,
    coverTriangles,
    coverSamples,
    maxCoverError,
  };
}
