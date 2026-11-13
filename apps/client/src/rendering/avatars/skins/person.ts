import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import type { Scene } from '@babylonjs/core/scene';
import type { SimulationConfig } from '@su/contracts';
import { AvatarRig, paintMesh as paint } from '../avatar-rig';

/** Примитивы с позицией; размеры в метрах, радиусы — половина диаметра. */
export function shapes(scene: Scene) {
  return {
    cylinder(name: string, height: number, top: number, bottom: number, y: number) {
      const mesh = MeshBuilder.CreateCylinder(
        name,
        { height, diameterTop: top * 2, diameterBottom: bottom * 2, tessellation: 20 },
        scene,
      );
      mesh.position.y = y;
      return mesh;
    },
    ellipsoid(name: string, x: number, y: number, z: number, at: Vector3) {
      const mesh = MeshBuilder.CreateSphere(name, { diameter: 1, segments: 10 }, scene);
      mesh.scaling.set(x, y, z);
      mesh.position.copyFrom(at);
      return mesh;
    },
    capsule(name: string, height: number, radius: number, at: Vector3) {
      const mesh = MeshBuilder.CreateCapsule(
        name,
        { height, radius, tessellation: 12, subdivisions: 1 },
        scene,
      );
      mesh.position.copyFrom(at);
      return mesh;
    },
    box(name: string, width: number, height: number, depth: number, at: Vector3) {
      const mesh = MeshBuilder.CreateBox(name, { width, height, depth }, scene);
      mesh.position.copyFrom(at);
      return mesh;
    },
    tube(name: string, path: Vector3[], radius: number) {
      return MeshBuilder.CreateTube(
        name,
        { path, radius, tessellation: 8, cap: Mesh.CAP_ALL },
        scene,
      );
    },
    /** Ромб коми орнамента на окружности радиуса `radius`, повёрнутый наружу. */
    diamond(name: string, size: number, radius: number, angle: number, y: number) {
      const mesh = MeshBuilder.CreateBox(
        name,
        { width: size, height: size, depth: size * 0.25 },
        scene,
      );
      mesh.rotation.set(0, angle, Math.PI / 4);
      mesh.position.set(Math.sin(angle) * radius, y, Math.cos(angle) * radius);
      return mesh;
    },
  };
}
export type Shapes = ReturnType<typeof shapes>;

export const SKIN_TONE = Color3.FromHexString('#f0c9a4');
const INK = Color3.FromHexString('#2a2222');
const BLUSH = Color3.FromHexString('#e79a8c');

/** Суставы людей одного роста: различаются только ширина плеч и бёдер. */
export function placePersonJoints(
  rig: AvatarRig,
  config: SimulationConfig['character'],
  shoulder: number,
  hip: number,
): void {
  const { height: h, radius: r } = config;
  rig.head.position.y = h * 0.34;
  rig.leftShoulder.position.set(-r * shoulder, h * 0.15, 0);
  rig.rightShoulder.position.set(r * shoulder, h * 0.15, 0);
  rig.leftHip.position.set(-r * hip, -h * 0.16, 0);
  rig.rightHip.position.set(r * hip, -h * 0.16, 0);
  rig.material.specularColor.set(0.06, 0.06, 0.06);
  rig.material.specularPower = 32;
}

/**
 * Голова-капсула (вертикальное лицо освещается ровно, без серого подбородка), глаза и улыбка.
 * `extras` — волосы и головные уборы постоянного цвета.
 */
export function buildPersonHead(
  rig: AvatarRig,
  s: Shapes,
  config: SimulationConfig['character'],
  extras: Mesh[],
  { blush = false } = {},
): void {
  const { height: h, radius: r } = config;
  const face = s.capsule('head', r * 1.42, r * 0.55, new Vector3(0, -h * 0.012, 0));
  face.scaling.z = 0.96;
  rig.part('head-shell', rig.head, [], [paint(face, SKIN_TONE), ...extras]);
  const smile = Array.from({ length: 9 }, (_, index) => {
    const t = index / 4 - 1;
    return new Vector3(t * r * 0.13, -h * 0.042 - h * 0.012 * (1 - t * t), r * 0.555);
  });
  rig.part(
    'face',
    rig.head,
    [],
    [
      ...[-1, 1].flatMap((side) => [
        paint(
          s.ellipsoid(
            'eye',
            r * 0.085,
            r * 0.11,
            r * 0.05,
            new Vector3(side * r * 0.19, h * 0.006, r * 0.535),
          ),
          INK,
        ),
        ...(blush
          ? [
              paint(
                s.ellipsoid(
                  'cheek',
                  r * 0.17,
                  r * 0.1,
                  r * 0.05,
                  new Vector3(side * r * 0.3, -h * 0.03, r * 0.49),
                ),
                BLUSH,
              ),
            ]
          : []),
      ]),
      paint(s.tube('smile', smile, h * 0.004), INK),
    ],
  );
}

/** Короткая стрижка: шапочка волос сверху и сзади, чёлка над глазами. */
export function shortHair(s: Shapes, r: number, color: Color3): Mesh {
  return paint(
    s.ellipsoid('hair', r * 1.2, r * 0.9, r * 1.24, new Vector3(0, r * 0.3, -r * 0.1)),
    color,
  );
}

export function neck(s: Shapes, h: number, r: number): Mesh {
  return paint(s.cylinder('neck', h * 0.08, r * 0.2, r * 0.22, h * 0.215), SKIN_TONE);
}

export function hand(s: Shapes, h: number, r: number): Mesh {
  return paint(
    s.ellipsoid('hand', r * 0.36, h * 0.06, r * 0.34, new Vector3(0, -h * 0.25, 0)),
    SKIN_TONE,
  );
}

/** Обувь, касающаяся земли: низ на −0.34h от бедра (как у остальных скинов). */
export function shoe(s: Shapes, h: number, r: number, color: Color3): Mesh {
  return paint(
    s.ellipsoid('shoe', r * 0.52, h * 0.055, r * 0.78, new Vector3(0, -h * 0.3125, r * 0.1)),
    color,
  );
}

/** Пимы — валяные сапоги до колена с красной отделкой; низ на −0.34h от бедра. */
export function pimy(s: Shapes, h: number, r: number): Mesh[] {
  const felt = Color3.FromHexString('#ece4d4');
  const red = Color3.FromHexString('#b3262d');
  return [
    paint(s.cylinder('pima', h * 0.15, r * 0.25, r * 0.235, -h * 0.25), felt),
    paint(
      s.ellipsoid('pima-foot', r * 0.5, h * 0.05, r * 0.72, new Vector3(0, -h * 0.315, r * 0.1)),
      felt,
    ),
    paint(s.cylinder('pima-top', h * 0.022, r * 0.27, r * 0.27, -h * 0.182), red),
    paint(s.cylinder('pima-stripe', h * 0.014, r * 0.255, r * 0.248, -h * 0.25), red),
  ];
}
