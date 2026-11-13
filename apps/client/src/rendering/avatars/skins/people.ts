import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import type { SimulationConfig } from '@su/contracts';
import { AvatarRig, clothingMesh as cloth, paintMesh as paint } from '../avatar-rig';
import {
  SKIN_TONE,
  buildPersonHead,
  hand,
  neck,
  placePersonJoints,
  shapes,
  shoe,
  shortHair,
  type Shapes,
} from './person';

const SNEAKER = Color3.FromHexString('#f2f2ef');

function sole(s: Shapes, h: number, r: number, color: Color3) {
  return paint(
    s.ellipsoid('sole', r * 0.56, h * 0.02, r * 0.82, new Vector3(0, -h * 0.33, r * 0.1)),
    color,
  );
}

function collar(rig: AvatarRig, h: number, r: number) {
  const ring = MeshBuilder.CreateTorus(
    'collar',
    { diameter: r * 0.5, thickness: r * 0.08, tessellation: 16 },
    rig.scene,
  );
  ring.position.y = h * 0.215;
  return cloth(ring, 0.8);
}

/** Обычный парень: футболка цвета игрока, джинсы и белые кеды. */
export function buildGuy(rig: AvatarRig, config: SimulationConfig['character']): void {
  const { height: h, radius: r } = config;
  const s = shapes(rig.scene);
  placePersonJoints(rig, config, 0.95, 0.38);
  const denim = Color3.FromHexString('#3e5c86');
  rig.part(
    'torso',
    rig.body,
    [
      cloth(s.ellipsoid('shoulders', r * 1.5, h * 0.08, r * 1.04, new Vector3(0, h * 0.18, 0))),
      cloth(s.cylinder('shirt', h * 0.28, r * 0.74, r * 0.69, h * 0.04)),
      cloth(s.cylinder('shirt-hem', h * 0.02, r * 0.7, r * 0.7, -h * 0.095), 0.85),
      collar(rig, h, r),
    ],
    [
      paint(s.cylinder('jeans', h * 0.1, r * 0.68, r * 0.7, -h * 0.15), denim),
      paint(
        s.cylinder('belt', h * 0.02, r * 0.69, r * 0.69, -h * 0.115),
        Color3.FromHexString('#4a3426'),
      ),
      neck(s, h, r),
    ],
  );
  buildPersonHead(rig, s, config, [shortHair(s, r, Color3.FromHexString('#3b2a20'))]);
  for (const [side, shoulder, hip] of [
    ['left', rig.leftShoulder, rig.leftHip],
    ['right', rig.rightShoulder, rig.rightHip],
  ] as const) {
    rig.part(
      `${side}Arm`,
      shoulder,
      [cloth(s.capsule('sleeve', h * 0.12, r * 0.29, new Vector3(0, -h * 0.04, 0)))],
      [
        paint(s.capsule('forearm', h * 0.18, r * 0.2, new Vector3(0, -h * 0.15, 0)), SKIN_TONE),
        hand(s, h, r),
      ],
    );
    rig.part(
      `${side}Leg`,
      hip,
      [],
      [
        paint(s.capsule('leg', h * 0.3, r * 0.24, new Vector3(0, -h * 0.15, 0)), denim),
        shoe(s, h, r, SNEAKER),
        sole(s, h, r, Color3.FromHexString('#9aa1a8')),
      ],
    );
  }
}

/** Обычная девушка: топ цвета игрока, джинсовая юбка, каре и кеды с носками. */
export function buildGirl(rig: AvatarRig, config: SimulationConfig['character']): void {
  const { height: h, radius: r } = config;
  const s = shapes(rig.scene);
  placePersonJoints(rig, config, 0.88, 0.34);
  const skirt = Color3.FromHexString('#3b4f7a');
  const hair = Color3.FromHexString('#a8743f');
  rig.part(
    'torso',
    rig.body,
    [
      cloth(s.ellipsoid('shoulders', r * 1.36, h * 0.075, r * 0.96, new Vector3(0, h * 0.18, 0))),
      cloth(s.cylinder('top', h * 0.24, r * 0.67, r * 0.58, h * 0.06)),
      collar(rig, h, r),
    ],
    [
      paint(s.cylinder('skirt', h * 0.19, r * 0.6, r * 0.95, -h * 0.155), skirt),
      paint(
        s.cylinder('skirt-hem', h * 0.018, r * 0.93, r * 0.96, -h * 0.24),
        Color3.FromHexString('#2c3b5c'),
      ),
      neck(s, h, r),
    ],
  );
  buildPersonHead(
    rig,
    s,
    config,
    [
      shortHair(s, r, hair),
      // Каре до подбородка: закрывает затылок и бока, лицо открыто.
      paint(
        s.ellipsoid('bob', r * 1.42, r * 1.24, r * 0.96, new Vector3(0, -r * 0.08, -r * 0.12)),
        hair,
      ),
    ],
    { blush: true },
  );
  for (const [side, shoulder, hip] of [
    ['left', rig.leftShoulder, rig.leftHip],
    ['right', rig.rightShoulder, rig.rightHip],
  ] as const) {
    rig.part(
      `${side}Arm`,
      shoulder,
      [cloth(s.capsule('sleeve', h * 0.1, r * 0.27, new Vector3(0, -h * 0.035, 0)))],
      [
        paint(s.capsule('forearm', h * 0.2, r * 0.18, new Vector3(0, -h * 0.14, 0)), SKIN_TONE),
        hand(s, h, r),
      ],
    );
    rig.part(
      `${side}Leg`,
      hip,
      [],
      [
        paint(s.capsule('leg', h * 0.3, r * 0.2, new Vector3(0, -h * 0.15, 0)), SKIN_TONE),
        paint(s.cylinder('sock', h * 0.04, r * 0.215, r * 0.215, -h * 0.275), SNEAKER),
        shoe(s, h, r, SNEAKER),
        sole(s, h, r, Color3.FromHexString('#e58fa6')),
      ],
    );
  }
}
