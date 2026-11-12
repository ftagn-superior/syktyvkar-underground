import { VertexBuffer } from '@babylonjs/core/Buffers/buffer';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import type { Scene } from '@babylonjs/core/scene';
import { itemShapeParts, type ItemType } from '@su/contracts';

/** One mesh and one material per instance, also used by the placement preview. */
export function createItemMesh(name: string, type: ItemType, scene: Scene): Mesh {
  const meshes: Mesh[] = [];
  const paint = (mesh: Mesh, color: string) => {
    const rgb = Color3.FromHexString(color);
    mesh.setVerticesData(
      VertexBuffer.ColorKind,
      Array.from({ length: mesh.getTotalVertices() }, () => [rgb.r, rgb.g, rgb.b, 1]).flat(),
    );
    meshes.push(mesh);
    return mesh;
  };
  for (const [index, part] of itemShapeParts(type).entries()) {
    const id = `${name}-shape-${index}`;
    let mesh: Mesh;
    switch (part.kind) {
      case 'box':
        mesh = MeshBuilder.CreateBox(
          id,
          { width: part.size.x, height: part.size.y, depth: part.size.z },
          scene,
        );
        break;
      case 'sphere':
        mesh = MeshBuilder.CreateSphere(id, { diameter: part.radius * 2, segments: 20 }, scene);
        break;
      case 'capsule':
        mesh = MeshBuilder.CreateCapsule(
          id,
          {
            height: part.height,
            radius: part.radius,
            tessellation: 24,
            subdivisions: 2,
            capSubdivisions: 8,
          },
          scene,
        );
        break;
    }
    mesh.position.set(part.center.x, part.center.y, part.center.z);
    paint(mesh, type.color);
    if (type.model === 'watermelon') {
      const positions = mesh.getVerticesData(VertexBuffer.PositionKind)!;
      const light = Color3.FromHexString(type.color),
        dark = Color3.FromHexString('#205b36');
      const colors: number[] = [];
      for (let i = 0; i < positions.length; i += 3) {
        const angle = Math.atan2(positions[i + 2], positions[i]);
        const stripe = Math.sin(angle * 10 + Math.sin(positions[i + 1] * 8) * 0.25);
        const color = stripe > 0.05 ? light : dark;
        colors.push(color.r, color.g, color.b, 1);
      }
      mesh.setVerticesData(VertexBuffer.ColorKind, colors);
    }
  }
  const { size } = type;
  switch (type.model) {
    case 'box':
      for (const x of [-size.x * 0.3, size.x * 0.3]) {
        const strap = paint(
          MeshBuilder.CreateBox(
            `${name}-strap`,
            { width: size.x * 0.07, height: size.y + 0.008, depth: size.z + 0.008 },
            scene,
          ),
          '#574b39',
        );
        strap.position.x = x;
      }
      break;
    case 'soap': {
      const inset = paint(
        MeshBuilder.CreateBox(
          `${name}-inset`,
          { width: size.x * 0.75, height: 0.008, depth: size.z * 0.65 },
          scene,
        ),
        '#ffc5dc',
      );
      inset.position.y = size.y / 2;
      for (const [x, z, scale] of [
        [-0.2, 0, 1],
        [0.04, 0.09, 0.65],
        [0.18, -0.05, 0.8],
      ]) {
        const bubble = paint(
          MeshBuilder.CreateSphere(
            `${name}-bubble`,
            {
              diameterX: size.z * 0.24 * scale,
              diameterY: 0.012,
              diameterZ: size.z * 0.24 * scale,
              segments: 12,
            },
            scene,
          ),
          '#fff1f6',
        );
        bubble.position.set(x * size.x, size.y / 2 + 0.004, z * size.z);
      }
      break;
    }
    case 'domino': {
      const divider = paint(
        MeshBuilder.CreateBox(
          `${name}-divider`,
          { width: size.x * 0.85, height: size.y * 0.012, depth: size.z + 0.008 },
          scene,
        ),
        '#27313b',
      );
      divider.position.y = 0;
      for (const side of [-1, 1])
        for (const half of [-1, 1])
          for (const column of [-1, 1])
            for (const row of [-1, 0, 1]) {
              const pip = paint(
                MeshBuilder.CreateSphere(
                  `${name}-pip`,
                  {
                    diameterX: size.x * 0.13,
                    diameterY: size.x * 0.13,
                    diameterZ: 0.012,
                    segments: 8,
                  },
                  scene,
                ),
                '#27313b',
              );
              pip.position.set(
                column * size.x * 0.22,
                (half * 0.25 + row * 0.09) * size.y,
                (side * size.z) / 2,
              );
            }
      break;
    }
  }
  const merged = Mesh.MergeMeshes(meshes, true, true)!;
  merged.name = name;
  merged.receiveShadows = true;
  return merged;
}
