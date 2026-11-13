import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import type { SimulationConfig } from '@su/contracts';
import { AvatarRig, clothingMesh as cloth, paintMesh as paint } from '../avatar-rig';

/** Плюшевый медведь: мех и мордочка постоянного цвета, свитер окрашивается цветом игрока. */
export function buildBear(rig: AvatarRig, config: SimulationConfig['character']): void {
  buildBearBody(rig, config, false);
}

/** Тот же мишка сидит в коляске: рама цвета игрока, задние колёса крутятся по пройденному пути. */
export function buildBearWheelchair(rig: AvatarRig, config: SimulationConfig['character']): void {
  buildBearBody(rig, config, true);
  buildWheelchair(rig, config);
}

function buildBearBody(
  rig: AvatarRig,
  config: SimulationConfig['character'],
  seated: boolean,
): void {
  const { height: h, radius: r } = config;
  const { scene, body, head, leftShoulder, rightShoulder, leftHip, rightHip } = rig;
  head.position.y = h * 0.325;
  leftShoulder.position.set(-r * 1.0, h * 0.13, 0);
  rightShoulder.position.set(r * 1.0, h * 0.13, 0);
  leftHip.position.set(-r * 0.42, -h * 0.17, 0);
  rightHip.position.set(r * 0.42, -h * 0.17, 0);
  rig.material.specularColor.set(0.05, 0.05, 0.05);
  rig.material.specularPower = 24;
  const fur = Color3.FromHexString('#8a5a3b');
  const light = Color3.FromHexString('#d8b48e');
  const ink = Color3.FromHexString('#2a1d17');

  const ellipsoid = (name: string, x: number, y: number, z: number, at: Vector3) => {
    const mesh = MeshBuilder.CreateSphere(name, { diameter: 1, segments: 12 }, scene);
    mesh.scaling.set(x, y, z);
    mesh.position.copyFrom(at);
    return mesh;
  };
  const capsule = (name: string, height: number, radius: number, y: number) => {
    const mesh = MeshBuilder.CreateCapsule(
      name,
      { height, radius, tessellation: 12, subdivisions: 1 },
      scene,
    );
    mesh.position.y = y;
    return mesh;
  };

  // Свитер — тело вращения по профилю (радиус в долях r, высота в долях h), сплюснутое спереди назад.
  const depth = 0.84;
  const profile: [number, number][] = [
    [0.5, 0.2],
    [0.76, 0.15],
    [0.88, 0.06],
    [0.9, -0.04],
    [0.86, -0.13],
    [0.8, -0.2],
  ];
  const radiusAt = (y: number) => {
    for (let index = 1; index < profile.length; index++) {
      const [r0, y0] = profile[index - 1];
      const [r1, y1] = profile[index];
      if (y <= y0 && y >= y1) return r0 + ((y0 - y) / (y0 - y1)) * (r1 - r0);
    }
    return profile[profile.length - 1][0];
  };
  const lathe = (name: string, points: [number, number][]) => {
    const mesh = MeshBuilder.CreateLathe(
      name,
      {
        // Профиль задан сверху вниз; лате ждёт снизу вверх, иначе нормали смотрят внутрь.
        shape: points.map(([x, y]) => new Vector3(x * r, y * h, 0)).reverse(),
        tessellation: 20,
        cap: Mesh.CAP_ALL,
      },
      scene,
    );
    mesh.scaling.z = depth;
    return mesh;
  };
  const band = (name: string, top: number, bottom: number, grow = 0.03) =>
    lathe(name, [
      [radiusAt(top) + grow, top],
      [radiusAt(bottom) + grow, bottom],
    ]);
  const collar = MeshBuilder.CreateTorus(
    'collar',
    { diameter: r * 1.02, thickness: r * 0.2, tessellation: 18 },
    scene,
  );
  collar.position.y = h * 0.195;
  rig.part(
    'torso',
    body,
    [
      cloth(lathe('sweater', profile)),
      cloth(band('stripe-high', 0.075, 0.045), 0.72),
      cloth(band('stripe-low', 0.02, -0.01), 0.72),
      cloth(band('hem', -0.17, -0.205, 0.035), 0.82),
      cloth(collar, 0.82),
    ],
    [
      paint(ellipsoid('rump', r * 1.6, h * 0.17, r * 1.32, new Vector3(0, -h * 0.17, 0)), fur),
      paint(
        ellipsoid('tail', r * 0.32, r * 0.32, r * 0.3, new Vector3(0, -h * 0.19, -r * 0.6)),
        fur,
      ),
    ],
  );

  const ears = [-1, 1].flatMap((side) => [
    paint(
      ellipsoid(
        'ear',
        r * 0.5,
        r * 0.48,
        r * 0.26,
        new Vector3(side * r * 0.5, h * 0.095, -r * 0.05),
      ),
      fur,
    ),
    paint(
      ellipsoid(
        'ear-inner',
        r * 0.28,
        r * 0.26,
        r * 0.1,
        new Vector3(side * r * 0.5, h * 0.092, r * 0.07),
      ),
      light,
    ),
  ]);
  rig.part(
    'head-shell',
    head,
    [],
    [
      paint(ellipsoid('head', r * 1.5, r * 1.4, r * 1.38, Vector3.Zero()), fur),
      paint(
        ellipsoid('muzzle', r * 0.72, r * 0.5, r * 0.5, new Vector3(0, -h * 0.04, r * 0.52)),
        light,
      ),
      ...ears,
    ],
  );
  rig.part(
    'face',
    head,
    [],
    [
      paint(
        ellipsoid('nose', r * 0.26, r * 0.17, r * 0.16, new Vector3(0, -h * 0.022, r * 0.76)),
        ink,
      ),
      ...[-1, 1].map((side) =>
        paint(
          ellipsoid(
            'eye',
            r * 0.13,
            r * 0.15,
            r * 0.08,
            new Vector3(side * r * 0.25, h * 0.025, r * 0.63),
          ),
          ink,
        ),
      ),
    ],
  );

  for (const [side, shoulder, hip] of [
    ['left', leftShoulder, leftHip],
    ['right', rightShoulder, rightHip],
  ] as const) {
    const cuff = MeshBuilder.CreateCylinder(
      'cuff',
      { height: h * 0.035, diameter: r * 0.62, tessellation: 14 },
      scene,
    );
    cuff.position.y = -h * 0.19;
    rig.part(
      `${side}Arm`,
      shoulder,
      [cloth(capsule('sleeve', h * 0.24, r * 0.29, -h * 0.085)), cloth(cuff, 0.82)],
      [paint(ellipsoid('paw', r * 0.56, h * 0.085, r * 0.56, new Vector3(0, -h * 0.235, 0)), fur)],
    );
    // Сидя: бедро вперёд по сиденью, голень вниз до подножки (размеры в метрах при росте 1.8).
    const m = h / 1.8;
    const seatedLegs = () => {
      const thigh = capsule('thigh', 0.36 * m, r * 0.32, 0);
      thigh.rotation.x = Math.PI / 2;
      thigh.position.set(0, -0.03 * m, 0.12 * m);
      const shin = capsule('shin', 0.4 * m, r * 0.3, -0.215 * m);
      shin.position.z = 0.29 * m;
      return [
        paint(thigh, fur),
        paint(shin, fur),
        paint(
          ellipsoid('foot', r * 0.66, h * 0.07, r * 0.9, new Vector3(0, -0.431 * m, 0.36 * m)),
          fur,
        ),
        paint(
          ellipsoid(
            'sole',
            r * 0.46,
            h * 0.04,
            r * 0.08,
            new Vector3(0, -0.436 * m, 0.36 * m + r * 0.44),
          ),
          light,
        ),
      ];
    };
    const legs = seated
      ? seatedLegs()
      : [
          paint(capsule('leg', h * 0.28, r * 0.32, -h * 0.13), fur),
          paint(
            ellipsoid('foot', r * 0.66, h * 0.07, r * 0.9, new Vector3(0, -h * 0.295, r * 0.12)),
            fur,
          ),
          paint(
            ellipsoid('sole', r * 0.46, h * 0.04, r * 0.08, new Vector3(0, -h * 0.3, r * 0.56)),
            light,
          ),
        ];
    rig.part(`${side}Leg`, hip, [], legs);
  }
}

/** Коляска в координатах корня (земля на −h/2), размеры в метрах при росте 1.8. */
function buildWheelchair(rig: AvatarRig, config: SimulationConfig['character']): void {
  const { height: h } = config;
  const { scene, facing } = rig;
  const m = h / 1.8;
  rig.seated = true;
  const at = (x: number, y: number, z: number) => new Vector3(x * m, y * m, z * m);
  const tube = (from: Vector3, to: Vector3, radius = 0.018) =>
    MeshBuilder.CreateTube(
      'frame',
      { path: [from, to], radius: radius * m, tessellation: 8, cap: Mesh.CAP_ALL },
      scene,
    );
  const box = (width: number, height: number, depth: number, center: Vector3) => {
    const mesh = MeshBuilder.CreateBox(
      'chair',
      { width: width * m, height: height * m, depth: depth * m },
      scene,
    );
    mesh.position.copyFrom(center);
    return mesh;
  };
  const fabric = Color3.FromHexString('#2f3640');
  const rubber = Color3.FromHexString('#26272b');
  const steel = Color3.FromHexString('#c9cdd2');

  const frame = [-1, 1].flatMap((side) => [
    tube(at(side * 0.28, -0.46, -0.3), at(side * 0.28, -0.46, 0.26)),
    tube(at(side * 0.28, -0.62, -0.3), at(side * 0.28, 0.08, -0.33)),
    tube(at(side * 0.28, 0.08, -0.33), at(side * 0.28, 0.1, -0.42)),
    tube(at(side * 0.25, -0.46, 0.26), at(side * 0.22, -0.8, 0.4)),
    tube(at(side * 0.28, -0.62, -0.3), at(side * 0.26, -0.62, 0.2)),
    tube(at(side * 0.26, -0.62, 0.2), at(side * 0.26, -0.83, 0.2), 0.014),
    tube(at(side * 0.28, -0.6, -0.08), at(side * 0.35, -0.6, -0.08), 0.014),
    tube(at(-side * 0.28, -0.62, -0.05), at(side * 0.28, -0.46, -0.05), 0.012),
  ]);
  const fixed = [-1, 1].flatMap((side) => {
    const caster = MeshBuilder.CreateCylinder(
      'caster',
      { diameter: 0.14 * m, height: 0.035 * m, tessellation: 14 },
      scene,
    );
    caster.rotation.z = Math.PI / 2;
    caster.position.copyFrom(at(side * 0.26, -0.83, 0.2));
    return [
      paint(caster, rubber),
      paint(tube(at(side * 0.28, 0.095, -0.4), at(side * 0.28, 0.1, -0.47), 0.026), rubber),
    ];
  });
  rig.part(
    'wheelchair',
    facing,
    frame.map((mesh) => cloth(mesh)),
    [
      paint(box(0.58, 0.05, 0.56, at(0, -0.475, -0.02)), fabric),
      paint(box(0.56, 0.4, 0.03, at(0, -0.2, -0.31)), fabric),
      paint(box(0.5, 0.025, 0.2, at(0, -0.81, 0.38)), rubber),
      ...fixed,
    ],
  );

  // Задние колёса на общей оси; поворот = путь / радиус, так что колесо катится без проскальзывания.
  const radius = 0.3;
  const axle = new TransformNode(`axle-${facing.parent!.name}`, scene);
  axle.parent = facing;
  axle.position.copyFrom(at(0, -0.6, -0.08));
  const wheels = [-1, 1].flatMap((side) => {
    const x = side * 0.35 * m;
    const tire = MeshBuilder.CreateTorus(
      'tire',
      { diameter: (radius - 0.0225) * 2 * m, thickness: 0.045 * m, tessellation: 28 },
      scene,
    );
    const rim = MeshBuilder.CreateTorus(
      'hand-rim',
      { diameter: 0.5 * m, thickness: 0.016 * m, tessellation: 24 },
      scene,
    );
    const hub = MeshBuilder.CreateCylinder('hub', { diameter: 0.07 * m, height: 0.05 * m }, scene);
    for (const mesh of [tire, rim, hub]) mesh.rotation.z = Math.PI / 2;
    tire.position.x = hub.position.x = x;
    rim.position.x = x + side * 0.045 * m;
    const spokes = [0, 1, 2].map((index) => {
      const spoke = MeshBuilder.CreateBox(
        'spoke',
        { width: 0.008 * m, height: 0.52 * m, depth: 0.014 * m },
        scene,
      );
      spoke.rotation.x = (index * Math.PI) / 3;
      spoke.position.x = x;
      return paint(spoke, steel);
    });
    return [paint(tire, rubber), paint(rim, steel), paint(hub, steel), ...spokes];
  });
  rig.part('wheels', axle, [], wheels);
  rig.onTravel = (distance) => {
    axle.rotation.x = distance / (radius * m);
  };
}
