import { Scene } from '@babylonjs/core/scene';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import type { EntityDefinition, WorldDefinition } from '@su/contracts';

const floorY = 0.016;
const palette = { spawn: '#6d9e9a', crate: '#c9a366', corner: '#8095b0', passage: '#8bafa5' };
type FloorLabel = { text: string; x: number; z: number; color: string };

/** Semantic accents for this test arena, with positions always coming from world data. */
export function obstacleAccent(entity: EntityDefinition): string | undefined {
  if (entity.entityId.startsWith('corner-')) return palette.corner;
  if (entity.entityId.startsWith('passage-')) return palette.passage;
  return undefined;
}

/** Visual marks are owned by the scene and never create collision bodies. */
export function decorateWorld(scene: Scene, world: WorldDefinition): void {
  const point = (x: number, z: number) => new Vector3(x, floorY, z);
  const lineSystem = (name: string, lines: Vector3[][], color: string, alpha: number) => {
    if (lines.length === 0) return;
    const mesh = MeshBuilder.CreateLineSystem(name, { lines }, scene);
    mesh.color = Color3.FromHexString(color);
    mesh.alpha = alpha;
    mesh.isPickable = false;
    mesh.freezeWorldMatrix();
  };
  const circle = (x: number, z: number, radius: number, segments: number) =>
    Array.from({ length: segments + 1 }, (_, i) => {
      const angle = (i / segments) * Math.PI * 2;
      return point(x + Math.cos(angle) * radius, z + Math.sin(angle) * radius);
    });

  const grid: Vector3[][] = [];
  const { min, max } = world.bounds;
  for (let x = Math.ceil(min.x / 2) * 2; x <= max.x; x += 2)
    grid.push([point(x, min.z), point(x, max.z)]);
  for (let z = Math.ceil(min.z / 2) * 2; z <= max.z; z += 2)
    grid.push([point(min.x, z), point(max.x, z)]);
  lineSystem('floor-grid', grid, '#4c6573', 0.22);

  const labels: FloorLabel[] = [];
  const spawnMinX = Math.min(...world.spawnPoints.map((p) => p.x));
  const spawnMaxX = Math.max(...world.spawnPoints.map((p) => p.x));
  const spawnMaxZ = Math.max(...world.spawnPoints.map((p) => p.z));
  const spawnMidX = (spawnMinX + spawnMaxX) / 2;
  const spawnLines = world.spawnPoints.map((p) => circle(p.x, p.z, 0.575, 32));
  spawnLines.push([
    point(spawnMinX - 0.8, spawnMaxZ + 0.4),
    point(spawnMinX - 0.8, spawnMaxZ + 1.1),
    point(spawnMaxX + 0.8, spawnMaxZ + 1.1),
    point(spawnMaxX + 0.8, spawnMaxZ + 0.4),
  ]);
  lineSystem('spawn-marks', spawnLines, palette.spawn, 0.5);
  labels.push({ text: '01  СТАРТ', x: spawnMidX, z: spawnMaxZ + 2.6, color: palette.spawn });

  const crate = world.entities.find((entity) => entity.kind === 'crate');
  if (crate) {
    const { x, z } = crate.position;
    const lines = [circle(x, z, 2.5, 64)];
    // A short metre scale makes small pushes easy to compare between clients.
    const rulerPoint = (distance: number, tick: number) =>
      point(
        x + 2.1 + (distance + tick) * Math.SQRT1_2,
        z + 2.1 + (-distance + tick) * Math.SQRT1_2,
      );
    lines.push([rulerPoint(-2, 0), rulerPoint(2, 0)]);
    for (let mark = -2; mark <= 2; mark++)
      lines.push([rulerPoint(mark, -0.15), rulerPoint(mark, 0.15)]);
    lineSystem('crate-marks', lines, palette.crate, 0.48);
    labels.push({ text: '02  ЯЩИК · 1 М', x: x + 3.1, z: z + 3.1, color: palette.crate });
  }

  const passage = world.entities
    .filter((entity) => entity.entityId.startsWith('passage-'))
    .sort((a, b) => a.position.x - b.position.x);
  if (passage.length === 2) {
    const [left, right] = passage;
    const x1 = left.position.x + left.size.x / 2;
    const x2 = right.position.x - right.size.x / 2;
    const z = (left.position.z + right.position.z) / 2;
    const halfDepth = Math.max(left.size.z, right.size.z) / 2 + 1.2;
    const lines = [
      [point(x1, z - halfDepth), point(x1, z + halfDepth)],
      [point(x2, z - halfDepth), point(x2, z + halfDepth)],
    ];
    for (const entity of passage) {
      const halfX = entity.size.x / 2;
      const halfZ = entity.size.z / 2;
      const y = entity.position.y + entity.size.y / 2 + 0.008;
      lines.push([
        new Vector3(entity.position.x - halfX, y, entity.position.z + halfZ),
        new Vector3(entity.position.x + halfX, y, entity.position.z + halfZ),
      ]);
    }
    lineSystem('passage-marks', lines, palette.passage, 0.72);
    labels.push({
      text: '03  ПРОХОД',
      x: (x1 + x2) / 2,
      z: z + halfDepth + 0.6,
      color: palette.passage,
    });
  }

  const corner = world.entities.filter((entity) => entity.entityId.startsWith('corner-'));
  if (corner.length > 0) {
    const centerX = corner.reduce((sum, entity) => sum + entity.position.x, 0) / corner.length;
    const frontZ = Math.max(...corner.map((entity) => entity.position.z + entity.size.z / 2));
    const lines = corner.map((entity) => {
      const x = entity.size.x / 2;
      const z = entity.size.z / 2;
      const y = entity.position.y + entity.size.y / 2 + 0.008;
      return [
        new Vector3(entity.position.x - x, y, entity.position.z + z),
        new Vector3(entity.position.x + x, y, entity.position.z + z),
        new Vector3(entity.position.x + x, y, entity.position.z - z),
      ];
    });
    lineSystem('corner-marks', lines, palette.corner, 0.65);
    labels.push({ text: '04  УГОЛ', x: centerX, z: frontZ + 0.9, color: palette.corner });
  }

  drawFloorLabels(scene, labels);
}

function drawFloorLabels(scene: Scene, labels: FloorLabel[]): void {
  // One small procedural atlas and one merged mesh for all four floor labels.
  const rowHeight = 64;
  const texture = new DynamicTexture(
    'floor-label-atlas',
    { width: 512, height: rowHeight * labels.length },
    scene,
    true,
  );
  texture.hasAlpha = true;
  const context = texture.getContext();
  context.clearRect(0, 0, 512, rowHeight * labels.length);
  context.font = '600 44px sans-serif';
  labels.forEach((label, index) => {
    context.fillStyle = label.color;
    context.fillText(
      label.text,
      (512 - context.measureText(label.text).width) / 2,
      index * rowHeight + 48,
    );
  });
  texture.update();
  const material = new StandardMaterial('floor-label-material', scene);
  material.diffuseTexture = texture;
  material.useAlphaFromDiffuseTexture = true;
  material.disableLighting = true;
  material.emissiveColor = Color3.White();
  material.alpha = 0.9;
  material.backFaceCulling = false;
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  labels.forEach((label, index) => {
    const uvTop = 1 - index / labels.length;
    const uvBottom = 1 - (index + 1) / labels.length;
    // Text faces the fixed camera: right is (+X, -Z), top points away from it.
    for (const [u, v] of [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ]) {
      const right = (u - 0.5) * 8 * Math.SQRT1_2;
      // Compensate the floor's foreshortening so letters remain legible at 600px height.
      const up = (v - 0.5) * 1.8 * Math.SQRT1_2;
      positions.push(label.x + right - up, floorY + 0.004, label.z - right - up);
      normals.push(0, 1, 0);
      uvs.push(u, uvBottom + v * (uvTop - uvBottom));
    }
    const first = index * 4;
    indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
  });
  const vertices = new VertexData();
  vertices.positions = positions;
  vertices.normals = normals;
  vertices.uvs = uvs;
  vertices.indices = indices;
  const mesh = new Mesh('floor-labels', scene);
  vertices.applyToMesh(mesh);
  mesh.material = material;
  mesh.isPickable = false;
  mesh.freezeWorldMatrix();
}
