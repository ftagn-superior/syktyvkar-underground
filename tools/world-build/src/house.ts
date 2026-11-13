import type { BuildingPhysicsAsset, StaticCollider, Vec3 } from '@su/contracts';
import { addFace, meshPart, type StaticMeshPart } from '@su/terrain-build/mesh';
export { addFace, meshPart } from '@su/terrain-build/mesh';
import { bakeLocalAo } from './ambient-occlusion.js';

export interface HouseRecipe {
  formatVersion: 1;
  width: number;
  depth: number;
  floors: number;
  floorHeight: number;
  roofHeight: number;
  wallColor: string;
  roofColor: string;
  windowColor: string;
  doorColor: string;
}
export function addBox(part: StaticMeshPart, position: Vec3, size: Vec3): void {
  const x = size.x / 2,
    y = size.y / 2,
    z = size.z / 2;
  const faces = [
    [
      [x, -y, -z],
      [x, y, -z],
      [x, y, z],
      [x, -y, z],
    ],
    [
      [-x, -y, z],
      [-x, y, z],
      [-x, y, -z],
      [-x, -y, -z],
    ],
    [
      [-x, y, -z],
      [-x, y, z],
      [x, y, z],
      [x, y, -z],
    ],
    [
      [-x, -y, z],
      [-x, -y, -z],
      [x, -y, -z],
      [x, -y, z],
    ],
    [
      [x, -y, z],
      [x, y, z],
      [-x, y, z],
      [-x, -y, z],
    ],
    [
      [-x, -y, -z],
      [-x, y, -z],
      [x, y, -z],
      [x, -y, -z],
    ],
  ];
  for (const face of faces)
    addFace(
      part,
      face.map(([a, b, c]) => [a + position.x, b + position.y, c + position.z]),
    );
}
export function generateHouse(
  assetId: string,
  recipe: HouseRecipe,
): { parts: StaticMeshPart[]; physics: BuildingPhysicsAsset } {
  if (recipe.formatVersion !== 1) throw new Error('Unsupported house recipe version');
  for (const key of ['width', 'depth', 'floorHeight', 'roofHeight'] as const)
    if (!Number.isFinite(recipe[key]) || recipe[key] <= 0 || recipe[key] > 100)
      throw new Error(`Invalid house ${key}`);
  if (
    !Number.isInteger(recipe.floors) ||
    recipe.floors < 1 ||
    recipe.floors > 12 ||
    recipe.width < 4 ||
    recipe.depth < 4 ||
    recipe.floorHeight < 2.4
  )
    throw new Error('Invalid house proportions');
  for (const key of ['wallColor', 'roofColor', 'windowColor', 'doorColor'] as const)
    if (!/^#[a-f0-9]{6}$/i.test(recipe[key])) throw new Error(`Invalid house ${key}`);
  const { width, depth } = recipe,
    height = recipe.floors * recipe.floorHeight;
  const walls = meshPart('walls', 'wall', recipe.wallColor);
  addBox(walls, { x: 0, y: height / 2, z: 0 }, { x: width, y: height, z: depth });
  const roof = meshPart('roof', 'roof', recipe.roofColor);
  const x = width / 2 + 0.2,
    z = depth / 2 + 0.2,
    top = height + recipe.roofHeight;
  addFace(roof, [
    [-x, height, -z],
    [0, top, -z],
    [x, height, -z],
  ]);
  addFace(roof, [
    [-x, height, z],
    [x, height, z],
    [0, top, z],
  ]);
  addFace(roof, [
    [-x, height, -z],
    [-x, height, z],
    [0, top, z],
    [0, top, -z],
  ]);
  addFace(roof, [
    [x, height, z],
    [x, height, -z],
    [0, top, -z],
    [0, top, z],
  ]);
  addFace(roof, [
    [-x, height, z],
    [-x, height, -z],
    [x, height, -z],
    [x, height, z],
  ]);
  const windows = meshPart('windows', 'detail', recipe.windowColor);
  for (let floor = 0; floor < recipe.floors; floor++) {
    const y = floor * recipe.floorHeight + 1.5;
    for (const side of [-1, 1]) {
      for (const offset of [-width * 0.3, width * 0.3])
        addBox(
          windows,
          { x: offset, y, z: side * (depth / 2 + 0.014) },
          { x: 1.2, y: 1.2, z: 0.025 },
        );
      for (const offset of [-depth * 0.27, depth * 0.27])
        addBox(
          windows,
          { x: side * (width / 2 + 0.014), y, z: offset },
          { x: 0.025, y: 1.2, z: 1.2 },
        );
    }
  }
  const doors = meshPart('doors', 'detail', recipe.doorColor);
  for (const side of [-1, 1])
    addBox(doors, { x: 0, y: 1.05, z: side * (depth / 2 + 0.015) }, { x: 1, y: 2.1, z: 0.025 });
  const plinth = meshPart('plinth', 'detail', '#49545a');
  addBox(plinth, { x: 0, y: 0.09, z: 0 }, { x: width + 0.015, y: 0.18, z: depth + 0.015 });
  const transform = {
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    friction: 0.6,
    restitution: 0.05,
  };
  const colliders: StaticCollider[] = [
    {
      id: 'body',
      kind: 'box',
      ...transform,
      position: { x: 0, y: height / 2, z: 0 },
      size: { x: width, y: height, z: depth },
    },
    {
      id: 'roof',
      kind: 'mesh',
      ...transform,
      vertices: [...roof.positions],
      indices: [...roof.indices],
    },
  ];
  const parts = [walls, roof, windows, doors, plinth];
  bakeLocalAo(parts);
  return {
    parts,
    physics: { assetId, bounds: { min: { x: -x, y: 0, z: -z }, max: { x, y: top, z } }, colliders },
  };
}
