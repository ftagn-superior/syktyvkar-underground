import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import type { SimulationConfig } from '@su/contracts';
import { AvatarRig, paintMesh as paint, clothingMesh as cloth } from '../avatar-rig';

export function buildMinifigure(rig: AvatarRig, config: SimulationConfig['character']): void {
  const { height: h, radius: r } = config;
  const { scene, body, head, leftShoulder, rightShoulder, leftHip, rightHip } = rig;
  head.position.y = h * 0.325;
  leftShoulder.position.set(-r * 0.85, h * 0.145, 0);
  rightShoulder.position.set(r * 0.85, h * 0.145, 0);
  leftHip.position.set(-r * 0.42, -h * 0.23, 0);
  rightHip.position.set(r * 0.42, -h * 0.23, 0);
  const skin = Color3.FromHexString('#f2cc54');
  const ink = Color3.FromHexString('#20303a');

  const cylinder = (
    name: string,
    height: number,
    top: number,
    bottom: number,
    y: number,
    z = 0,
  ) => {
    const mesh = MeshBuilder.CreateCylinder(
      name,
      { height, diameterTop: top, diameterBottom: bottom, tessellation: 16 },
      scene,
    );
    mesh.position.set(0, y, z);
    return mesh;
  };
  const box = (name: string, width: number, height: number, depth: number, y: number, z = 0) => {
    const mesh = MeshBuilder.CreateBox(name, { width, height, depth }, scene);
    mesh.position.set(0, y, z);
    return mesh;
  };

  const torso = box('torso', r * 1.72, h * 0.36, r, h * 0.02);
  const positions = torso.getVerticesData(VertexBuffer.PositionKind)!;
  for (let offset = 0; offset < positions.length; offset += 3)
    if (positions[offset + 1] > 0) positions[offset] *= 1.35 / 1.72;
  const normals: number[] = [];
  VertexData.ComputeNormals(positions, torso.getIndices()!, normals);
  torso.setVerticesData(VertexBuffer.PositionKind, positions);
  torso.setVerticesData(VertexBuffer.NormalKind, normals);
  torso.refreshBoundingInfo();
  const buttons = [0.08, -0.015].map((y) => {
    const button = cylinder('button', h * 0.003, h * 0.016, h * 0.016, h * y, r * 0.505);
    button.rotation.x = Math.PI / 2;
    return paint(button, ink);
  });
  rig.part(
    'torso',
    body,
    [cloth(torso), cloth(box('waist', r * 1.66, h * 0.06, r * 0.96, -h * 0.19), 0.88)],
    buttons,
  );
  rig.part(
    'head-shell',
    head,
    [],
    [
      paint(cylinder('head', h * 0.17, r * 1.32, r * 1.32, 0), skin),
      paint(cylinder('head-top', h * 0.0225, r * 1.18, r * 1.32, h * 0.09625), skin),
      paint(cylinder('head-bottom', h * 0.0225, r * 1.32, r * 1.18, -h * 0.09625), skin),
      paint(cylinder('stud', h * 0.05, r * 0.6, r * 0.62, h * 0.1325), skin),
      paint(cylinder('neck', h * 0.07, r * 0.48, r * 0.48, -h * 0.125), skin),
    ],
  );
  const headRadius = r * 0.66;
  const eyes = [-1, 1].map((side) => {
    const angle = Math.asin((side * r * 0.23) / headRadius);
    const eye = MeshBuilder.CreateSphere('eye', { diameter: 1, segments: 8 }, scene);
    eye.scaling.set(h * 0.027, h * 0.027, h * 0.004);
    eye.rotation.y = angle;
    eye.position.set(
      Math.sin(angle) * (headRadius + 0.001),
      h * 0.02,
      Math.cos(angle) * (headRadius + 0.001),
    );
    return paint(eye, ink);
  });
  const smile = Array.from({ length: 13 }, (_, index) => {
    const t = index / 6 - 1;
    const x = t * r * 0.25;
    return new Vector3(
      x,
      -h * 0.018 - h * 0.026 * (1 - t * t),
      Math.sqrt(headRadius * headRadius - x * x) + h * 0.0015,
    );
  });
  rig.part(
    'face',
    head,
    [],
    [
      ...eyes,
      paint(
        MeshBuilder.CreateTube(
          'smile',
          { path: smile, radius: h * 0.0045, tessellation: 8 },
          scene,
        ),
        ink,
      ),
    ],
  );
  for (const [side, shoulder, hip] of [
    ['left', leftShoulder, leftHip],
    ['right', rightShoulder, rightHip],
  ] as const) {
    const forearm = cylinder('forearm', h * 0.13, r * 0.48, r * 0.4, -h * 0.201, h * 0.0223);
    forearm.rotation.x = -0.35;
    const elbow = MeshBuilder.CreateSphere('elbow', { diameter: r * 0.49, segments: 8 }, scene);
    elbow.position.y = -h * 0.14;
    const shoulderCap = MeshBuilder.CreateSphere(
      'shoulder',
      { diameter: r * 0.5, segments: 8 },
      scene,
    );
    const sign = side === 'left' ? -1 : 1;
    const grip = Array.from({ length: 17 }, (_, index) => {
      const angle = Math.PI / 4 + (index / 16) * Math.PI * 1.5;
      return new Vector3(
        sign * Math.cos(angle) * r * 0.24,
        -h * 0.31 + Math.sin(angle) * r * 0.24,
        h * 0.045,
      );
    });
    rig.part(
      `${side}Arm`,
      shoulder,
      [
        cloth(shoulderCap),
        cloth(cylinder('upper-arm', h * 0.16, r * 0.46, r * 0.5, -h * 0.07)),
        cloth(elbow),
        cloth(forearm),
      ],
      [
        paint(cylinder('wrist', h * 0.05, r * 0.28, r * 0.28, -h * 0.265, h * 0.045), skin),
        paint(
          MeshBuilder.CreateTube(
            'grip',
            { path: grip, radius: r * 0.075, tessellation: 8, cap: Mesh.CAP_ALL },
            scene,
          ),
          skin,
        ),
      ],
    );
    const hinge = cylinder('hip', r * 0.7, h * 0.1, h * 0.1, 0);
    hinge.rotation.z = Math.PI / 2;
    rig.part(`${side}Leg`, hip, [
      cloth(hinge, 0.9),
      cloth(box('leg', r * 0.7, h * 0.23, r * 0.84, -h * 0.115), 0.94),
      cloth(box('foot', r * 0.7, h * 0.055, r * 0.98, -h * 0.2425, r * 0.07), 0.85),
    ]);
  }
}
