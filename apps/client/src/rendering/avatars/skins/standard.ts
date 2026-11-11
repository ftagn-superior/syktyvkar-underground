import { Color3 } from '@babylonjs/core/Maths/math.color';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import type { SimulationConfig } from '@su/contracts';
import { AvatarRig, clothingMesh as cloth, paintMesh as paint } from '../avatar-rig';

export function buildStandard(rig: AvatarRig, config: SimulationConfig['character']): void {
  const { height: h, radius: r } = config;
  const { scene, body, head, leftShoulder, rightShoulder, leftHip, rightHip } = rig;
  head.position.y = h * 0.365;
  leftShoulder.position.set(-r * 0.94, h * 0.15, 0);
  rightShoulder.position.set(r * 0.94, h * 0.15, 0);
  leftHip.position.set(-r * 0.39, -h * 0.16, 0);
  rightHip.position.set(r * 0.39, -h * 0.16, 0);
  rig.material.specularColor.set(0.07, 0.09, 0.1);
  rig.material.specularPower = 48;
  const capsule = (name: string, height: number, radius: number, y: number) => {
    const mesh = MeshBuilder.CreateCapsule(
      name,
      { height, radius, tessellation: 12, subdivisions: 1 },
      scene,
    );
    mesh.position.y = y;
    return mesh;
  };
  rig.part('torso', body, [
    cloth(capsule('torso', h * 0.39, r * 0.68, h * 0.025)),
    cloth(capsule('neck', h * 0.1, r * 0.27, h * 0.22)),
  ]);
  rig.part('head-shell', head, [cloth(capsule('head', h * 0.26, r * 0.64, 0))]);
  const visor = MeshBuilder.CreateBox(
    'visor',
    { width: r * 1.04, height: h * 0.085, depth: r * 0.2 },
    scene,
  );
  visor.position.set(0, h * 0.005, r * 0.59);
  rig.part('face', head, [], [paint(visor, Color3.FromHexString('#263b49'))]);
  for (const [side, shoulder, hip] of [
    ['left', leftShoulder, leftHip],
    ['right', rightShoulder, rightHip],
  ] as const) {
    rig.part(`${side}Arm`, shoulder, [
      cloth(capsule('sleeve', h * 0.28, r * 0.24, -h * 0.11)),
      cloth(capsule('hand', h * 0.11, r * 0.25, -h * 0.25)),
    ]);
    const shoe = MeshBuilder.CreateSphere('shoe', { diameter: 1, segments: 12 }, scene);
    shoe.scaling.set(r * 0.52, h * 0.05, r * 0.76);
    shoe.position.set(0, -h * 0.315, r * 0.11);
    rig.part(`${side}Leg`, hip, [
      cloth(capsule('leg', h * 0.3, r * 0.23, -h * 0.15), 0.94),
      cloth(shoe, 0.8),
    ]);
  }
}
