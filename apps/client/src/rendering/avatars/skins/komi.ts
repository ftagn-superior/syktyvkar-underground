import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { SimulationConfig } from '@su/contracts';
import { AvatarRig, clothingMesh as cloth, paintMesh as paint } from '../avatar-rig';
import {
  buildPersonHead,
  hand,
  neck,
  pimy,
  placePersonJoints,
  shapes,
  shortHair,
  type Shapes,
} from './person';

const LINEN = Color3.FromHexString('#f1ece1');
const RED = Color3.FromHexString('#b3262d');

/** Красный тканый пояс (вöнь) с белыми ромбами и свисающими концами слева спереди. */
function belt(s: Shapes, h: number, r: number, radius: number, y: number) {
  return [
    paint(s.cylinder('belt', h * 0.035, radius, radius, y), RED),
    ...Array.from({ length: 12 }, (_, index) =>
      paint(
        s.diamond('belt-diamond', h * 0.017, radius + r * 0.015, (index / 12) * Math.PI * 2, y),
        LINEN,
      ),
    ),
    ...[-1, 1].map((offset) => {
      const end = s.box('belt-end', r * 0.1, h * 0.11, r * 0.035, Vector3.Zero());
      const angle = -0.75 + offset * 0.09;
      end.rotation.set(0.12, angle, 0);
      end.position.set(
        Math.sin(angle) * (radius + r * 0.07),
        y - h * 0.06,
        Math.cos(angle) * (radius + r * 0.07),
      );
      return paint(end, RED);
    }),
  ];
}

/** Белая полоса с красными ромбами по окружности (подол, ворот, манжеты). */
function ornamentBand(
  s: Shapes,
  h: number,
  name: string,
  top: number,
  bottom: number,
  radiusTop: number,
  radiusBottom: number,
  count: number,
) {
  const y = (top + bottom) / 2;
  const radius = (radiusTop + radiusBottom) / 2;
  const size = (top - bottom) * 0.62;
  return [
    paint(s.cylinder(name, top - bottom, radiusTop, radiusBottom, y), LINEN),
    ...Array.from({ length: count }, (_, index) =>
      paint(
        s.diamond(`${name}-diamond`, size, radius + h * 0.003, (index / count) * Math.PI * 2, y),
        RED,
      ),
    ),
  ];
}

/**
 * Девушка в коми народном костюме: дубас (сарафан) и вышивка на рукавах окрашиваются
 * цветом игрока; белая рубаха, тканый пояс с ромбами, платок, коса и пимы — постоянные.
 */
export function buildKomiGirl(rig: AvatarRig, config: SimulationConfig['character']): void {
  const { height: h, radius: r } = config;
  const s = shapes(rig.scene);
  placePersonJoints(rig, config, 0.9, 0.36);
  const hair = Color3.FromHexString('#4a2c1d');

  // Юбка дубаса — конус от талии до середины голени; радиус в любой точке нужен для отделки.
  const waist = -h * 0.08;
  const hem = -h * 0.35;
  const skirtTop = r * 0.66;
  const skirtBottom = r * 1.08;
  const skirtAt = (y: number) =>
    skirtTop + ((waist - y) / (waist - hem)) * (skirtBottom - skirtTop);
  const trim = (name: string, top: number, bottom: number, grow: number) =>
    s.cylinder(name, top - bottom, skirtAt(top) + grow, skirtAt(bottom) + grow, (top + bottom) / 2);
  rig.part(
    'torso',
    rig.body,
    [
      cloth(s.cylinder('bodice', h * 0.2, r * 0.7, r * 0.64, h * 0.02)),
      cloth(s.cylinder('skirt', waist - hem, skirtTop, skirtBottom, (waist + hem) / 2)),
      cloth(trim('hem-band', -h * 0.335, hem, r * 0.015), 0.62),
    ],
    [
      paint(s.cylinder('shirt-yoke', h * 0.075, r * 0.5, r * 0.71, h * 0.1575), LINEN),
      ...ornamentBand(
        s,
        h,
        'hem-ornament',
        -h * 0.265,
        -h * 0.3,
        skirtAt(-h * 0.265) + r * 0.008,
        skirtAt(-h * 0.3) + r * 0.008,
        14,
      ),
      ...belt(s, h, r, r * 0.69, waist),
      neck(s, h, r),
    ],
  );

  // Платок закрывает макушку, затылок и бока; лицо открыто спереди.
  const braid = Array.from({ length: 5 }, (_, index) =>
    paint(
      s.ellipsoid(
        'braid',
        r * (0.2 - index * 0.015),
        r * 0.26,
        r * (0.18 - index * 0.012),
        new Vector3(0, -h * 0.07 - index * h * 0.045, -r * 0.62 - index * r * 0.025),
      ),
      hair,
    ),
  );
  buildPersonHead(
    rig,
    s,
    config,
    [
      paint(
        s.ellipsoid('hair', r * 1.04, r * 0.4, r * 0.4, new Vector3(0, h * 0.052, r * 0.345)),
        hair,
      ),
      paint(
        s.ellipsoid('scarf', r * 1.3, r * 1.32, r * 1.2, new Vector3(0, h * 0.022, -r * 0.13)),
        RED,
      ),
      paint(
        s.ellipsoid('scarf-knot', r * 0.3, r * 0.22, r * 0.2, new Vector3(0, -h * 0.07, -r * 0.48)),
        RED,
      ),
      ...braid,
      paint(
        s.ellipsoid(
          'braid-tie',
          r * 0.17,
          r * 0.08,
          r * 0.15,
          new Vector3(0, -h * 0.27, -r * 0.73),
        ),
        RED,
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
      [
        // Вышитые вставки на плече и манжете — цвет игрока.
        cloth(s.cylinder('shoulder-band', h * 0.035, r * 0.275, r * 0.275, -h * 0.045)),
        cloth(s.cylinder('cuff', h * 0.03, r * 0.24, r * 0.24, -h * 0.205), 0.85),
      ],
      [
        paint(s.capsule('sleeve', h * 0.27, r * 0.26, new Vector3(0, -h * 0.11, 0)), LINEN),
        hand(s, h, r),
      ],
    );
    rig.part(
      `${side}Leg`,
      hip,
      [],
      [
        paint(
          s.capsule('leg', h * 0.22, r * 0.2, new Vector3(0, -h * 0.1, 0)),
          Color3.FromHexString('#3b3338'),
        ),
        ...pimy(s, h, r),
      ],
    );
  }
}

/**
 * Парень в коми народном костюме: длинная рубаха навыпуск (дöрöм) окрашивается цветом игрока;
 * ворот и подол с белой вышивкой и красными ромбами, тканый пояс, тёмные порты, пимы и валяная шляпа.
 */
export function buildKomiGuy(rig: AvatarRig, config: SimulationConfig['character']): void {
  const { height: h, radius: r } = config;
  const s = shapes(rig.scene);
  placePersonJoints(rig, config, 0.95, 0.38);
  const trousers = Color3.FromHexString('#4d5366');
  const felt = Color3.FromHexString('#5a4a3e');

  const shoulders = s.ellipsoid(
    'shoulders',
    r * 1.5,
    h * 0.08,
    r * 1.04,
    new Vector3(0, h * 0.18, 0),
  );
  const shirtTop = h * 0.18;
  const shirtHem = -h * 0.2;
  const shirtAt = (y: number) => r * 0.74 + ((shirtTop - y) / (shirtTop - shirtHem)) * r * 0.1;
  const waist = -h * 0.04;
  rig.part(
    'torso',
    rig.body,
    [
      cloth(shoulders),
      cloth(
        s.cylinder(
          'shirt',
          shirtTop - shirtHem,
          shirtAt(shirtTop),
          shirtAt(shirtHem),
          (shirtTop + shirtHem) / 2,
        ),
      ),
    ],
    [
      // Порты видны под рубахой, между подолом и пимами.
      paint(s.cylinder('trousers', h * 0.06, r * 0.7, r * 0.72, -h * 0.2), trousers),
      ...ornamentBand(
        s,
        h,
        'hem-ornament',
        -h * 0.165,
        shirtHem,
        shirtAt(-h * 0.165) + r * 0.012,
        shirtAt(shirtHem) + r * 0.012,
        14,
      ),
      ...ornamentBand(s, h, 'collar', h * 0.235, h * 0.2, r * 0.25, r * 0.3, 8),
      ...belt(s, h, r, shirtAt(waist) + r * 0.01, waist),
      neck(s, h, r),
    ],
  );

  buildPersonHead(rig, s, config, [
    shortHair(s, r, Color3.FromHexString('#7a5232')),
    paint(s.cylinder('hat-brim', h * 0.012, r * 0.74, r * 0.74, r * 0.38), felt),
    paint(s.cylinder('hat-crown', r * 0.28, r * 0.46, r * 0.52, r * 0.54), felt),
    paint(s.ellipsoid('hat-top', r * 0.92, r * 0.2, r * 0.92, new Vector3(0, r * 0.68, 0)), felt),
    paint(s.cylinder('hat-band', h * 0.018, r * 0.5, r * 0.52, r * 0.44), RED),
  ]);

  for (const [side, shoulder, hip] of [
    ['left', rig.leftShoulder, rig.leftHip],
    ['right', rig.rightShoulder, rig.rightHip],
  ] as const) {
    rig.part(
      `${side}Arm`,
      shoulder,
      [cloth(s.capsule('sleeve', h * 0.25, r * 0.25, new Vector3(0, -h * 0.1, 0)))],
      [
        ...ornamentBand(s, h, 'cuff', -h * 0.19, -h * 0.215, r * 0.255, r * 0.255, 6),
        hand(s, h, r),
      ],
    );
    rig.part(
      `${side}Leg`,
      hip,
      [],
      [
        paint(s.capsule('leg', h * 0.24, r * 0.23, new Vector3(0, -h * 0.1, 0)), trousers),
        ...pimy(s, h, r),
      ],
    );
  }
}
