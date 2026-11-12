import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  validateBuildingPhysicsAsset,
  pointInsideClosedMesh,
} from '../../packages/contracts/src/index.js';
import { triangulate, clipRing, type Point2 } from '../../tools/world-build/src/triangulate.js';
import { generateFootprint, generateGround } from '../../tools/world-build/src/city.js';
import { generateKit } from '../../tools/world-build/src/kit.js';
import { buildWorld } from '../../tools/world-build/src/index.js';
import {
  clampOutOfIsland,
  replacedByRoundabout,
  roundaboutApproaches,
  roundaboutCrosswalks,
  roundaboutCurbPatches,
  roundaboutFillets,
  roundaboutIslands,
  roundaboutTracedLines,
  roundaboutMarkings,
  smoothTrace,
  tracedGeometry,
  validateRoundabout,
  type RoundaboutConfig,
} from '../../tools/world-build/src/roundabout.js';
import { createGameServer } from '../helpers/game-server.js';
import { readWorldDirectory } from '../../apps/server/src/world-bundle.js';

const area = (points: Point2[], triangles: number[]) => {
  let sum = 0;
  for (let i = 0; i < triangles.length; i += 3) {
    const [a, b, c] = triangles.slice(i, i + 3).map((k) => points[k]);
    sum += ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
  }
  return sum;
};

describe('триангуляция контуров', () => {
  it('покрывает вогнутый контур без потери площади при любом обходе', () => {
    const l: Point2[] = [
      [0, 0],
      [10, 0],
      [10, 4],
      [4, 4],
      [4, 10],
      [0, 10],
    ];
    for (const ring of [l, [...l].reverse()]) {
      const result = triangulate(ring);
      expect(result.coverage).toBeCloseTo(1, 9);
      expect(area(result.points, result.triangles)).toBeCloseTo(64, 9);
    }
  });
  it('учитывает отверстие, например кольцевую дорогу', () => {
    const outer: Point2[] = [
      [-10, -10],
      [10, -10],
      [10, 10],
      [-10, 10],
    ];
    const hole: Point2[] = [
      [-3, -3],
      [3, -3],
      [3, 3],
      [-3, 3],
    ];
    const result = triangulate(outer, [hole]);
    expect(result.coverage).toBeCloseTo(1, 9);
    expect(area(result.points, result.triangles)).toBeCloseTo(400 - 36, 9);
  });
  it('не проводит диагональ через вершину, случайно лежащую на прямой', () => {
    // Контур корпуса театра: вершины 4, 1 и 0 лежат на одной прямой с разных сторон.
    const body: Point2[] = [
      [16.54, -20.75],
      [11.74, -18.35],
      [-6.86, -54.85],
      [-37.16, -39.65],
      [-18.66, -3.15],
      [-23.66, -0.55],
      [-16.26, 14.15],
      [-12.56, 21.35],
      [-7.46, 18.75],
      [-2.31, 28.91],
      [27.99, 13.71],
      [22.84, 3.55],
      [27.74, 1.15],
    ];
    const { physics } = generateFootprint('test-theatre', {
      formatVersion: 1,
      outline: body,
      height: 9,
      floors: 3,
      windows: true,
      wallColor: '#a9aaa6',
      roofColor: '#8c8d89',
      windowColor: '#3d4d57',
    });
    // Без допуска крышка получала Т-образный стык и не проходила проверку замкнутости.
    validateBuildingPhysicsAsset(physics);
  });
  it('отбрасывает повторы, иглы и вершины на прямой', () => {
    const result = triangulate([
      [0, 0],
      [5, 0],
      [10, 0],
      [10, 10],
      [10, 10],
      [12, 10],
      [10, 10],
      [0, 10],
      [0, 0],
    ]);
    expect(result.points).toHaveLength(4);
    expect(result.coverage).toBeCloseTo(1, 9);
  });
  it('обрезает многоугольник прямоугольником мира', () => {
    const clipped = clipRing(
      [
        [-5, -5],
        [5, -5],
        [5, 5],
        [-5, 5],
      ],
      [0, 0],
      [10, 10],
    );
    expect(Math.abs(area(clipped, [0, 1, 2, 0, 2, 3]))).toBeCloseTo(25, 9);
  });
});

describe('городские модели', () => {
  it('здание по вогнутому контуру получает замкнутый коллайдер той же формы', () => {
    const { parts, physics } = generateFootprint('test-l', {
      formatVersion: 1,
      outline: [
        [-6, -6],
        [6, -6],
        [6, -1],
        [-1, -1],
        [-1, 6],
        [-6, 6],
      ],
      height: 9,
      floors: 3,
      windows: true,
      wallColor: '#dddddd',
      roofColor: '#999999',
      windowColor: '#333333',
    });
    expect(parts.map((p) => p.partId)).toEqual(['walls', 'roof', 'windows']);
    expect(parts.every((p) => p.occlusionGroup === 'shell')).toBe(true);
    validateBuildingPhysicsAsset(physics);
    const [body] = physics.colliders;
    if (body.kind !== 'mesh') throw new Error('mesh expected');
    // Внутренний угол буквы «Г» свободен, крыло — внутри.
    expect(pointInsideClosedMesh({ x: 3, y: 4, z: 3 }, body.vertices, body.indices)).toBe(false);
    expect(pointInsideClosedMesh({ x: -3, y: 4, z: 3 }, body.vertices, body.indices)).toBe(true);
  });
  it('земля — одна плита столкновений и визуальные слои без прозрачности', () => {
    const { parts, physics } = generateGround('test-ground', {
      formatVersion: 1,
      min: [-20, -30],
      max: [40, 10],
      depth: 1,
      color: '#777777',
      layers: [
        {
          id: 'green',
          color: '#00aa00',
          elevation: 0.002,
          polygons: [
            [
              [
                [-5, -5],
                [5, -5],
                [5, 5],
                [-5, 5],
              ],
            ],
          ],
        },
        { id: 'road', color: '#333333', elevation: 0.01, polygons: [] },
      ],
    });
    expect(parts.map((p) => p.partId)).toEqual(['ground', 'green']);
    expect(parts.every((p) => p.occlusionGroup === null)).toBe(true);
    validateBuildingPhysicsAsset(physics);
    expect(physics.colliders).toEqual([
      expect.objectContaining({
        kind: 'box',
        position: { x: 10, y: -0.5, z: -10 },
        size: { x: 60, y: 1, z: 40 },
      }),
    ]);
  });
});

describe('детали фасадов и модели из конструктора', () => {
  const rectangle: Point2[] = [
    [-15, -6],
    [15, -6],
    [15, 6],
    [-15, 6],
  ];
  const base = {
    formatVersion: 1 as const,
    outline: rectangle,
    height: 15,
    floors: 5,
    windows: true,
    wallColor: '#c8936a',
    roofColor: '#5e6264',
    windowColor: '#3d4d57',
  };

  it('витрины, балконы, вальмовая крыша и буквы вывески дают корректную модель', () => {
    const { parts, physics } = generateFootprint('test-details', {
      ...base,
      details: {
        plinth: { height: 0.8, color: '#8f7558' },
        shopfront: {
          facing: ['S'],
          height: 3.6,
          glassColor: '#2f4652',
          signColor: '#d42a2a',
          awningColor: '#c0392b',
        },
        balconies: [{ facing: ['N'], every: 7, color: '#bfb6a8', glazing: '#c9d3d6' }],
        hippedRoof: { height: 3, color: '#5f5a55', chimneys: 3 },
        roofSign: { facing: 'S', text: 'ТАЙБАЛА', width: 16, height: 2.4, color: '#d8322f' },
      },
    });
    const ids = parts.map((part) => part.partId);
    for (const id of ['shop-glass', 'shop-sign', 'awning', 'plinth', 'balconies-0', 'loggias-0'])
      expect(ids).toContain(id);
    for (const id of ['roof-slopes', 'chimneys', 'sign', 'sign-back']) expect(ids).toContain(id);
    // Тело крыши замкнуто, поэтому проходит ту же проверку, что и стены.
    validateBuildingPhysicsAsset(physics);
    expect(physics.colliders.map((c) => c.id)).toEqual(['body', 'roof']);
    expect(physics.bounds.max.y).toBeGreaterThan(18);
    // Окна первого этажа на южной витрине не рисуются: их меньше, чем без витрины.
    const plain = generateFootprint('test-plain', base).parts.find((p) => p.partId === 'windows')!;
    const detailed = parts.find((p) => p.partId === 'windows')!;
    expect(detailed.indices.length).toBeLessThan(plain.indices.length);
  });

  it('корпуса, арка, пилястры, роспись и крыльцо собираются в одну модель', () => {
    const { parts, physics } = generateFootprint('test-sections', {
      ...base,
      sections: [
        {
          id: 'main',
          outline: rectangle,
          details: {
            pilasters: { facing: ['W'], every: 3.4, color: '#e6b3a1' },
            paint: [{ facing: ['E'], from: 0, to: 1, bottom: 0, top: 15, color: '#86b9df' }],
            porch: {
              facing: 'S',
              width: 8,
              depth: 4,
              height: 3.4,
              wallColor: '#e7c548',
              roofColor: '#e9e6df',
              signColor: '#d9452f',
            },
          },
        },
        {
          id: 'bridge',
          outline: [
            [15, -3],
            [25, -3],
            [25, 3],
            [15, 3],
          ],
          elevation: 3.6,
          height: 9,
          floors: 2,
          wallColor: '#7fb0dc',
        },
      ],
    });
    const ids = parts.map((part) => part.partId);
    for (const id of [
      'main-pilasters',
      'main-paint-0',
      'main-porch',
      'main-porch-sign',
      'bridge-walls',
    ])
      expect(ids).toContain(id);
    validateBuildingPhysicsAsset(physics);
    // Крыльцо получает коробку столкновений, корпус над аркой начинается на высоте 3,6 м.
    expect(physics.colliders.map((c) => c.id)).toEqual([
      'main-body',
      'main-detail-0',
      'bridge-body',
    ]);
    const bridge = physics.colliders.find((c) => c.id === 'bridge-body')!;
    if (bridge.kind !== 'mesh') throw new Error('mesh expected');
    const heights = bridge.vertices.filter((_, i) => i % 3 === 1);
    expect(Math.min(...heights)).toBeCloseTo(3.6, 9);
    expect(pointInsideClosedMesh({ x: 20, y: 1, z: 0 }, bridge.vertices, bridge.indices)).toBe(
      false,
    );
  });

  it('heightScale растягивает стены, но не окна', () => {
    const measure = (recipe: Parameters<typeof generateFootprint>[1]) => {
      const { parts, physics } = generateFootprint('test-scale', recipe);
      const windows = parts.find((p) => p.partId === 'windows')!;
      // Первое окно — первые четыре вершины части.
      const ys = windows.positions.slice(0, 12).filter((_, i) => i % 3 === 1);
      return { top: physics.bounds.max.y, window: Math.max(...ys) - Math.min(...ys) };
    };
    const plain = measure(base);
    const tall = measure({ ...base, heightScale: 1.4 });
    expect(tall.top).toBeCloseTo(plain.top * 1.4, 6);
    // Окно остаётся 1,4 м: растёт только простенок между рядами.
    expect(tall.window).toBeCloseTo(1.4, 6);
    expect(plain.window).toBeCloseTo(1.4, 6);
  });

  it('несколько крышных вывесок: буквы «Пятёрочки», логотип на щите и щит «Магнита»', () => {
    const { parts } = generateFootprint('test-signs', {
      ...base,
      details: {
        roofSigns: [
          { facing: 'S', text: 'ПЯТЕРОЧКА', at: 0.42, width: 11.5, height: 2, color: '#d8322f' },
          {
            facing: 'S',
            text: '5',
            at: 0.08,
            width: 2.2,
            height: 2.2,
            color: '#ffffff',
            board: '#d8322f',
          },
          {
            facing: 'S',
            text: 'МАГНИТ',
            at: 0.82,
            width: 6,
            height: 1.3,
            color: '#c2185b',
            board: '#f4f4f2',
          },
        ],
      },
    });
    const ids = parts.map((p) => p.partId);
    for (const id of ['sign', 'sign-back', 'sign-1', 'sign-board-1', 'sign-2', 'sign-board-2'])
      expect(ids).toContain(id);
    expect(new Set(ids).size).toBe(ids.length);
    // Вывески не наезжают друг на друга: центры по оси X в порядке слева направо для зрителя с юга.
    const centre = (id: string) => {
      const xs = parts.find((p) => p.partId === id)!.positions.filter((_, i) => i % 3 === 0);
      return (Math.min(...xs) + Math.max(...xs)) / 2;
    };
    expect(centre('sign-1')).toBeLessThan(centre('sign'));
    expect(centre('sign')).toBeLessThan(centre('sign-2'));
  });

  it('неизвестная буква вывески останавливает сборку', () => {
    expect(() =>
      generateFootprint('test-sign', {
        ...base,
        details: { roofSign: { facing: 'S', text: 'Ж', width: 6, height: 2, color: '#ffffff' } },
      }),
    ).toThrow(/glyph/);
  });

  it('надпись на стене висит на нужной высоте прямо на южном фасаде', () => {
    const { parts } = generateFootprint('test-wall-text', {
      ...base,
      details: {
        wallText: [
          {
            facing: 'S',
            text: 'СЫКТЫВКАРСКИЙ УНИВЕРСИТЕТ',
            fromTop: 1,
            height: 1.4,
            width: 20,
            color: '#c9a64a',
          },
        ],
      },
    });
    const text = parts.find((p) => p.partId === 'wall-text-0')!;
    expect(text).toBeDefined();
    const axis = (k: number) => text.positions.filter((_, i) => i % 3 === k);
    // Верх строки на метр ниже верха стены (15 м), высота строки не больше заданной.
    expect(Math.max(...axis(1))).toBeCloseTo(14, 6);
    expect(Math.min(...axis(1))).toBeGreaterThanOrEqual(14 - 1.4 - 1e-9);
    // Буквы чуть выступают из южной стены z = 6 и не выходят за её ширину.
    expect(Math.min(...axis(2))).toBeGreaterThan(6);
    expect(Math.max(...axis(2))).toBeLessThan(6.2);
    expect(Math.max(...axis(0).map(Math.abs))).toBeLessThanOrEqual(10 + 1e-9);
  });

  it('конструктор собирает части, цилиндры и повёрнутые коробки столкновений', () => {
    const { parts, physics } = generateKit('test-kit', {
      formatVersion: 1,
      parts: [
        {
          id: 'pillar',
          role: 'wall',
          fade: true,
          color: '#aaaaaa',
          shapes: [{ box: { center: [0, 5, 0], size: [1, 10, 1], yaw: 45 } }],
        },
        {
          id: 'disc',
          role: 'detail',
          fade: false,
          color: '#333333',
          shapes: [{ cylinder: { center: [0, 8, 0], radius: 1.5, length: 0.4, axis: 'z' } }],
        },
      ],
      colliders: [{ id: 'pillar', center: [0, 5, 0], size: [1, 10, 1], yaw: 45 }],
    });
    expect(parts.map((p) => [p.partId, p.occlusionGroup])).toEqual([
      ['pillar', 'shell'],
      ['disc', null],
    ]);
    validateBuildingPhysicsAsset(physics);
    expect(physics.colliders[0].rotation.y).toBeCloseTo(Math.sin(Math.PI / 8), 9);
  });

  it('холм из усечённого конуса проходим, пандус-клин понижается наружу', () => {
    const mound = { center: [0, 0, 0], radiusBottom: 9.5, radiusTop: 3.6, height: 0.45, sides: 24 };
    const { parts, physics } = generateKit('test-mound', {
      formatVersion: 1,
      parts: [
        { id: 'mound', role: 'detail', fade: false, color: '#7da467', shapes: [{ cone: mound }] },
        {
          id: 'ramp',
          role: 'detail',
          fade: false,
          color: '#bdb7aa',
          shapes: [{ wedge: { center: [6, 0, 0], size: [6, 0.5, 2], low: 0.04 } }],
        },
      ],
      colliders: [{ id: 'mound', cone: mound }],
    } as Parameters<typeof generateKit>[1]);
    // Замкнутая треугольная форма холма проходит общую проверку коллайдеров.
    validateBuildingPhysicsAsset(physics);
    const shell = physics.colliders[0];
    if (shell.kind !== 'mesh') throw new Error('mesh expected');
    expect(pointInsideClosedMesh({ x: 0, y: 0.2, z: 0 }, shell.vertices, shell.indices)).toBe(true);
    expect(pointInsideClosedMesh({ x: 9, y: 0.4, z: 0 }, shell.vertices, shell.indices)).toBe(
      false,
    );
    const ramp = parts.find((p) => p.partId === 'ramp')!;
    const top = (x: number) =>
      Math.max(
        ...ramp.positions.flatMap((_, i) =>
          i % 3 === 0 && Math.abs(ramp.positions[i] - x) < 1e-6 ? [ramp.positions[i + 1]] : [],
        ),
      );
    expect(top(3)).toBeCloseTo(0.5, 9);
    expect(top(9)).toBeCloseTo(0.04, 9);
  });
});

describe('кольцевая развязка', () => {
  const config: RoundaboutConfig = {
    center: [0, 0],
    inner: 30,
    outer: 42,
    lanes: 4,
    arms: [
      // Подъезд с севера: ось x = 0, направление от кольца на север (−z).
      { id: 'north', at: [0, -80], direction: [0, -1], width: 18, island: { base: 5, length: 15 } },
      { id: 'east', at: [80, 0], direction: [1, 0], width: 12, entry: 'full' },
    ],
  };
  const radius = (p: Point2) => Math.hypot(p[0], p[1]);

  it('концы дорог не заходят на центральный остров', () => {
    const cap: Point2[] = [
      [-5, -60],
      [5, -60],
      [5, -28],
      [0, -25],
      [-5, -28],
    ];
    const clamped = clampOutOfIsland(cap, config);
    for (const p of clamped) expect(radius(p)).toBeGreaterThanOrEqual(30 - 1e-9);
    // Точки снаружи острова не двигаются.
    expect(clamped.slice(0, 2)).toEqual(cap.slice(0, 2));
  });

  it('островок — треугольник у кольца с вершиной на оси подъезда', () => {
    const islands = roundaboutIslands(config);
    expect(islands).toHaveLength(1);
    const [left, apex, right] = islands[0];
    expect(apex[0]).toBeCloseTo(0, 9);
    expect(apex[1]).toBeCloseTo(-(42 + 1 + 15), 9);
    expect(radius(left)).toBeCloseTo(43, 9);
    expect(radius(right)).toBeCloseTo(43, 9);
    expect(Math.abs(left[0] - right[0])).toBeCloseTo(5, 9);
    // Положительная площадь, как у остальных многоугольников земли.
    expect(triangulate(islands[0]).coverage).toBeCloseTo(1, 9);
  });

  it('скругление касается края подъезда и кольца и лежит снаружи проезжей части', () => {
    const arm = { ...config.arms[0], fillet: { left: 20, right: 20 } };
    const fillets = roundaboutFillets({ ...config, arms: [arm] });
    expect(fillets).toHaveLength(2);
    for (const polygon of fillets) {
      // Край подъезда x = ±9, внешний радиус кольца 42: асфальт скругления не заходит ни в подъезд, ни в кольцо.
      for (const p of polygon) {
        expect(Math.abs(p[0])).toBeGreaterThanOrEqual(9 - 1e-6);
        expect(radius(p)).toBeGreaterThanOrEqual(42 - 1e-6);
      }
      expect(triangulate(polygon).coverage).toBeCloseTo(1, 6);
    }
    // Без поля fillet край дороги не трогается; слишком маленькая дуга, не достающая до кольца, останавливает сборку.
    expect(roundaboutFillets(config)).toHaveLength(0);
    expect(() =>
      roundaboutFillets({ ...config, arms: [{ ...arm, at: [200, -80], fillet: { left: 1 } }] }),
    ).toThrow(/fillet/);
  });

  it('линии между полосами можно задать радиусами', () => {
    const marks = roundaboutMarkings({ ...config, lines: [35.5], arms: [] });
    const radii = marks.map((m) => radius(m[0]));
    expect(marks.length).toBe(Math.round((2 * Math.PI * 35.5) / 9));
    for (const r of radii) expect(Math.abs(r - 35.5)).toBeLessThan(0.2);
    expect(() => validateRoundabout({ ...config, lines: [50] })).toThrow(/lane lines/);
  });

  it('«зебра» ложится полосами вдоль движения поперёк отрезка', () => {
    const stripes = roundaboutCrosswalks({
      ...config,
      crosswalks: [{ from: [60, -6], to: [60, 6] }],
    });
    // Отрезок идёт по оси z, значит полосы вытянуты по x (3 м) и стоят с шагом около 1,1 м.
    expect(stripes.length).toBe(Math.floor(12 / 1.1));
    for (const stripe of stripes) {
      const xs = stripe.map((p) => p[0]);
      expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(3, 9);
      expect(triangulate(stripe).coverage).toBeCloseTo(1, 9);
    }
    const zs = stripes.map((s) => s.reduce((sum, p) => sum + p[1], 0) / 4);
    expect(Math.min(...zs)).toBeGreaterThan(-6);
    expect(Math.max(...zs)).toBeLessThan(6);
    expect(roundaboutCrosswalks(config)).toHaveLength(0);
    expect(() =>
      roundaboutCrosswalks({ ...config, crosswalks: [{ from: [0, 0], to: [1, 0] }] }),
    ).toThrow(/crosswalk/);
  });

  describe('трассировка по снимку', () => {
    // Северный подъезд (ось x = 0): края x = ±13, островок шире расчётного, «зебра» поперёк подъезда.
    const traced = tracedGeometry({
      traces: [
        {
          name: 'north:edge-east',
          points: [
            [13, -90],
            [14, -60],
            [45, -45],
            [90, -20],
          ],
        },
        {
          name: 'north:island',
          points: [
            [-6, -70],
            [0, -45],
            [6, -70],
          ],
        },
        {
          name: 'north:crosswalk',
          points: [
            [-13, -80],
            [13, -80],
            [13, -84],
          ],
        },
        {
          name: 'ring:lane-dashed',
          points: [
            [0, 0],
            [1, 1],
          ],
        },
      ],
    });
    const withTrace: RoundaboutConfig = { ...config, traced };

    it('разбирает края, островки и «зебры», остальные трассы пропускает', () => {
      expect(traced.curbs).toHaveLength(1);
      expect(traced.islands).toHaveLength(1);
      expect(traced.islands[0].arm).toBe('north');
      expect(traced.crosswalks).toHaveLength(1);
      expect(() =>
        tracedGeometry({
          traces: [
            {
              name: 'north:island',
              points: [
                [0, 0],
                [1, 1],
              ],
            },
          ],
        }),
      ).toThrow(/at least 3/);
    });

    it('обведённый островок заменяет расчётный треугольник', () => {
      const islands = roundaboutIslands(withTrace);
      expect(islands).toHaveLength(1);
      expect(islands[0].map((p) => p[0])).toContain(-6);
      // Запас для очистки разметки раздвигает контур во все стороны.
      const grown = roundaboutIslands(withTrace, 1)[0];
      expect(Math.min(...grown.map((p) => p[0]))).toBeLessThan(-6);
      // Островок без трассы остаётся расчётным: у восточного подъезда его нет совсем.
      expect(roundaboutIslands({ ...withTrace, traced: { ...traced, islands: [] } })).toHaveLength(
        1,
      );
    });

    it('продолжение подъезда держит реальную ширину, затем сужается до прежней', () => {
      const both = tracedGeometry({
        traces: [
          {
            name: 'a:edge-east',
            points: [
              [13, -90],
              [45, -45],
              [90, -20],
            ],
          },
          {
            name: 'a:edge-west',
            points: [
              [-13, -90],
              [-45, -45],
              [-90, 0],
            ],
          },
        ],
      });
      const arms = [{ ...config.arms[0], approach: { length: 20, taper: 30 } }, config.arms[1]];
      const [straight, taper] = roundaboutApproaches({ ...config, arms, traced: both });
      // Прямой участок: ширина обводки 26 м на 20 м длины; сужение — до ширины подъезда 18 м.
      expect(Math.min(...straight.map((p) => p[0]))).toBeCloseTo(-13, 9);
      expect(Math.min(...straight.map((p) => p[1]))).toBeCloseTo(-110, 9);
      expect(Math.min(...taper.map((p) => p[1]))).toBeCloseTo(-140, 9);
      const far = taper.filter((p) => p[1] < -139);
      expect(far.map((p) => Math.abs(p[0])).sort()).toEqual([9, 9]);
      // Подъезд без поля approach не трогается.
      expect(roundaboutApproaches({ ...config, traced: both })).toHaveLength(0);
      for (const shape of [straight, taper]) expect(triangulate(shape).coverage).toBeCloseTo(1, 9);
    });

    it('сглаживание сохраняет концы ломаной и замкнутый контур остаётся замкнутым', () => {
      const line: Point2[] = [
        [0, 0],
        [10, 0],
        [10, 10],
      ];
      const smooth = smoothTrace(line, 2);
      expect(smooth[0]).toEqual([0, 0]);
      expect(smooth[smooth.length - 1]).toEqual([10, 10]);
      expect(smooth.length).toBeGreaterThan(line.length);
      // Угол срезан: ни одна точка не лежит в самом углу (10, 0).
      expect(smooth.some((p) => p[0] === 10 && p[1] === 0)).toBe(false);
      const ring = smoothTrace(line, 1, true);
      expect(ring.length).toBe(6);
    });

    it('замкнутая повторной точкой обводка островка теряет дубль', () => {
      const repeated = tracedGeometry({
        traces: [
          {
            name: 'x:island',
            points: [
              [0, 0],
              [10, 0],
              [5, 8],
              [0.2, 0.1],
            ],
          },
        ],
      });
      expect(repeated.islands[0].ring).toHaveLength(3);
    });

    it('линии разметки: прерывистая 3 + 6 м, сплошная и двойная', () => {
      const lines = tracedGeometry({
        traces: [
          {
            name: 'north:lane-dashed',
            points: [
              [0, 0],
              [0, -20],
            ],
          },
          {
            name: 'north:lane-line',
            points: [
              [2, 0],
              [2, -20],
            ],
          },
          {
            name: 'north:lane-solid',
            points: [
              [4, 0],
              [4, -20],
            ],
          },
          {
            name: 'north:lane-double',
            points: [
              [6, 0],
              [6, -20],
            ],
          },
          {
            name: 'ring:lane-dashed',
            points: [
              [8, 0],
              [8, -20],
            ],
          },
        ],
      });
      // Подпись «ring» обслуживает окружность кольца из `lines`, а не трасса.
      expect(lines.lines.map((l) => l.style)).toEqual(['dashed', 'dashed', 'solid', 'double']);
      const marks = (index: number) =>
        roundaboutTracedLines({ ...config, traced: { ...lines, lines: [lines.lines[index]] } });
      const dashes = marks(0);
      expect(dashes).toHaveLength(3);
      const span = (ring: Point2[]) =>
        Math.max(...ring.map((p) => p[1])) - Math.min(...ring.map((p) => p[1]));
      expect(span(dashes[0])).toBeCloseTo(3, 9);
      expect(Math.min(...dashes[1].map((p) => p[1]))).toBeCloseTo(-12, 9);
      expect(marks(2)).toHaveLength(1);
      expect(span(marks(2)[0])).toBeCloseTo(20, 9);
      expect(marks(3)).toHaveLength(2);
      for (const ring of [...dashes, ...marks(2), ...marks(3)])
        expect(triangulate(ring).coverage).toBeCloseTo(1, 9);
    });

    it('разметка OSM внутри обведённой дороги и рядом с обведённой «зеброй» заменяется', () => {
      const both = tracedGeometry({
        traces: [
          {
            name: 'a:edge-east',
            points: [
              [13, -90],
              [45, -45],
              [90, -20],
            ],
          },
          {
            name: 'a:edge-west',
            points: [
              [-13, -90],
              [-45, -45],
              [-90, 0],
            ],
          },
          {
            name: 'a:crosswalk',
            points: [
              [-13, -80],
              [13, -80],
              [13, -84],
            ],
          },
        ],
      });
      const cfg: RoundaboutConfig = { ...config, traced: both };
      const dash = (x: number, z: number): Point2[] => [
        [x - 0.1, z - 1],
        [x + 0.1, z - 1],
        [x + 0.1, z + 1],
        [x - 0.1, z + 1],
      ];
      // Между обведёнными краями и у «зебры» OSM-линии лишние; дальше по подъезду остаются.
      expect(replacedByRoundabout(dash(0, -60), cfg)).toBe(true);
      expect(replacedByRoundabout(dash(0, -86), cfg)).toBe(true);
      expect(replacedByRoundabout(dash(0, -140), cfg)).toBe(false);
      expect(replacedByRoundabout(dash(0, -140), config)).toBe(false);
    });

    it('островок относится к подъезду по месту, а не по имени трассы', () => {
      // Подпись «east» неверна: контур лежит у северного подъезда, значит заменит его треугольник.
      const mislabeled: RoundaboutConfig = {
        ...config,
        traced: { ...traced, islands: [{ arm: 'east', ring: traced.islands[0].ring }] },
      };
      const islands = roundaboutIslands(mislabeled);
      expect(islands).toHaveLength(1);
      expect(islands[0].map((p) => p[0])).toContain(-6);
    });

    it('«зебра» не зависит от того, с какой стороны начата обводка', () => {
      const longFirst = roundaboutCrosswalks({
        ...config,
        traced: {
          ...traced,
          crosswalks: [
            [
              [-13, -80],
              [13, -80],
              [13, -84],
            ],
          ],
        },
      });
      const shortFirst = roundaboutCrosswalks({
        ...config,
        traced: {
          ...traced,
          crosswalks: [
            [
              [-13, -84],
              [-13, -80],
              [13, -80],
            ],
          ],
        },
      });
      expect(shortFirst.length).toBe(longFirst.length);
      const xs = shortFirst.map((s) => s.reduce((sum, p) => sum + p[0], 0) / 4);
      expect(Math.min(...xs)).toBeLessThan(-12);
      expect(Math.max(...xs)).toBeGreaterThan(12);
    });

    it('участок края замыкается по осям подъездов и дугой по острову', () => {
      const [patch] = roundaboutCurbPatches(withTrace);
      expect(triangulate(patch).coverage).toBeCloseTo(1, 6);
      // Край идёт снаружи дороги, а замыкающая дуга лежит на внутреннем радиусе острова кольца.
      const arc = patch.filter((p) => Math.abs(radius(p) - 30) < 1e-6);
      expect(arc.length).toBeGreaterThan(5);
      // Начало края (x = 13, ось север) замыкается на оси x = 0, а не на соседнем подъезде.
      expect(patch.some((p) => Math.abs(p[0]) < 1e-6 && p[1] < -80)).toBe(true);
    });

    it('«зебра» по снимку: полосы поперёк подъезда, под островком пропуска полос', () => {
      const stripes = roundaboutCrosswalks(withTrace);
      expect(stripes.length).toBeGreaterThan(15);
      for (const stripe of stripes) expect(triangulate(stripe).coverage).toBeCloseTo(1, 9);
      // Островок лежит дальше от кольца, чем «зебра» (z < −45 … −70, зебра на z = −82): полосы не пропадают.
      const centres = stripes.map((s) => s.reduce((sum, p) => sum + p[0], 0) / 4);
      expect(Math.min(...centres)).toBeLessThan(-12);
      expect(Math.max(...centres)).toBeGreaterThan(12);
    });
  });

  it('разметка: штрихи по всему кругу и «зубы» справа по ходу въезда', () => {
    const marks = roundaboutMarkings(config);
    const centroid = (ring: Point2[]): Point2 => [
      ring.reduce((s, p) => s + p[0], 0) / ring.length,
      ring.reduce((s, p) => s + p[1], 0) / ring.length,
    ];
    const dashes = marks.filter((m) => m.length === 4).map(centroid);
    const teeth = marks.filter((m) => m.length === 3).map(centroid);
    // Три линии между четырьмя полосами, каждая — целое число штрихов во всех четвертях круга.
    for (const r of [33, 36, 39]) {
      const ring = dashes.filter((p) => Math.abs(radius(p) - r) < 0.2);
      expect(ring.length).toBe(Math.round((2 * Math.PI * r) / 9));
      for (const [sx, sz] of [
        [1, 1],
        [1, -1],
        [-1, 1],
        [-1, -1],
      ])
        expect(ring.some(([x, z]) => Math.sign(x) === sx && Math.sign(z) === sz)).toBe(true);
    }
    // Северный въезд: машины едут на юг, правая половина — запад (x < 0), за островком.
    const north = teeth.filter(([, z]) => z < -30);
    expect(north.length).toBeGreaterThan(3);
    for (const [x] of north) expect(x).toBeLessThan(-2.5);
    // Восточная въездная ветка: «зубы» во всю ширину.
    const east = teeth.filter(([x]) => x > 30);
    expect(Math.min(...east.map(([, z]) => z))).toBeLessThan(-4);
    expect(Math.max(...east.map(([, z]) => z))).toBeGreaterThan(4);
  });

  it('разметка OSM на кольце и под островками заменяется, на подъезде остаётся', () => {
    const strip = (x: number, z: number): Point2[] => [
      [x - 0.1, z - 1],
      [x + 0.1, z - 1],
      [x + 0.1, z + 1],
      [x - 0.1, z + 1],
    ];
    expect(replacedByRoundabout(strip(0, -36), config)).toBe(true);
    expect(replacedByRoundabout(strip(0, -50), config)).toBe(true);
    expect(replacedByRoundabout(strip(-7, -50), config)).toBe(false);
    expect(replacedByRoundabout(strip(0, -70), config)).toBe(false);
  });

  it('неверные параметры кольца останавливают сборку', () => {
    expect(() => validateRoundabout({ ...config, outer: 31 })).toThrow(/radii/);
    expect(() =>
      validateRoundabout({ ...config, arms: [{ ...config.arms[0], direction: [1, 1] }] }),
    ).toThrow(/unit/);
  });
});

const byAssetCount = (definition: { buildings: { assetId: string }[] }, assetId: string) =>
  definition.buildings.filter((b) => b.assetId === assetId).length;

describe('мир ring-block', () => {
  let temporary: string;
  let release: string;
  beforeAll(async () => {
    temporary = await mkdtemp(join(tmpdir(), 'su-ring-block-'));
    release = join(temporary, 'release');
    await buildWorld('content/worlds/ring-block/world.json', release);
  }, 120_000);
  afterAll(async () => {
    await rm(temporary, { recursive: true, force: true });
  });

  it('содержит ориентиры, дома, землю и обслуживается по своему worldId', async () => {
    const { definition } = await readWorldDirectory(release);
    expect(definition.landmarks?.map((l) => l.name)).toEqual([
      'Кольцо · «Трудовая слава»',
      'Школа №1',
      'Баня №4',
      'Театр оперы и балета',
      'Театральная площадь',
      'СыктГУ им. Питирима Сорокина',
    ]);
    // Главный корпус СыктГУ: дубликат-мультиполигон из OSM отброшен, остался уточнённый контур.
    expect(definition.buildings.some((b) => b.assetId === 'osm-relation-13601216')).toBe(false);
    expect(definition.buildingAssets['osm-way-1258973447'].colliders.map((c) => c.id)).toEqual(
      expect.arrayContaining([
        'entrance-body',
        'entrance-attic-body',
        'wing-south-body',
        'wing-south-end-body',
      ]),
    );
    expect(byAssetCount(definition, 'sorokin-monument')).toBe(1);
    // Кольцо: островки на въездах лежат отдельным слоем земли поверх асфальта.
    const ground = JSON.parse(
      await readFile('content/buildings/ring-block/ring-block-ground/source.json', 'utf8'),
    ) as { layers: { id: string; elevation: number; polygons: unknown[] }[] };
    const groundLayer = (id: string) => ground.layers.find((l) => l.id === id)!;
    expect(groundLayer('islands').polygons).toHaveLength(4);
    expect(groundLayer('islands').elevation).toBeGreaterThan(groundLayer('road').elevation);
    expect(groundLayer('islands').elevation).toBeLessThan(groundLayer('markings').elevation);
    // Памятник из manual/ стоит в центре кольца и имеет собственные столкновения.
    const monument = definition.buildings.find((b) => b.entityId === 'monument-trudovaya-slava');
    expect(monument).toMatchObject({ assetId: 'trudovaya-slava' });
    expect(Math.hypot(monument!.position.x, monument!.position.z)).toBeLessThan(3);
    // Театральная площадь: два фонтана, памятник Куратову и фонари используют общие модели.
    const byAsset = (assetId: string) => definition.buildings.filter((b) => b.assetId === assetId);
    expect(byAsset('theatre-fountain')).toHaveLength(2);
    expect(byAsset('kuratov-monument')).toHaveLength(1);
    expect(byAsset('lamp-five-globe').length).toBeGreaterThanOrEqual(8);
    expect(definition.buildingAssets['osm-way-146724915'].colliders.map((c) => c.id)).toEqual(
      expect.arrayContaining(['lobby-body', 'body-body', 'stage-body']),
    );
    expect(definition.buildingAssets['trudovaya-slava'].colliders.length).toBeGreaterThan(2);
    // Ручные уточнения из import.json попали в модель Октябрьского проспекта, 40.
    const taibala = definition.buildingAssets['osm-way-1292842070'];
    expect(taibala.bounds.max.y).toBeGreaterThan(30);
    expect(
      definition.buildings.filter((b) => b.sourceRef?.provider === 'osm').length,
    ).toBeGreaterThan(90);
    const groundTiles = definition.buildings.filter((building) =>
      building.entityId.startsWith('ground-'),
    );
    expect(groundTiles).toHaveLength(40);
    expect(new Set(groundTiles.map((tile) => tile.assetId)).size).toBe(40);
    expect(groundTiles.find((tile) => tile.entityId === 'ground-0_0')?.assetId).toBe(
      'ring-block-ground-0-0',
    );
    expect(definition.buildingAssets['ring-block-ground']).toBeUndefined();
    const manifest = JSON.parse(await readFile(join(release, 'manifest.json'), 'utf8'));
    for (const cell of manifest.cells) {
      const expected = `ring-block-ground-${cell.cellId.replace('_', '-')}`;
      expect(
        cell.assetIds.filter((asset: string) => asset.startsWith('ring-block-ground-')),
      ).toEqual([expected]);
    }
    if (!process.env.SU_TEST_DATABASE_URL) return;
    const app = await createGameServer({ port: 0, worldDirectory: release });
    try {
      const info = await fetch(app.url + '/api/world').then((r) => r.json());
      expect(info.manifestUrl).toBe('/worlds/ring-block/manifest.json');
      expect((await fetch(app.url + info.manifestUrl)).status).toBe(200);
      expect((await fetch(app.url + '/worlds/physics-lab/manifest.json')).status).not.toBe(200);
    } finally {
      await app.close();
    }
  });

  it('подписи меняют версию карты, но не физический хеш', async () => {
    const source = join(temporary, 'source');
    await cp('content/worlds/ring-block', source, { recursive: true });
    const worldPath = join(source, 'world.json');
    const world = JSON.parse(await readFile(worldPath, 'utf8'));
    world.assetCatalog = join(process.cwd(), 'content/buildings/ring-block/catalog.json');
    world.itemCatalog = join(process.cwd(), 'content/items/catalog.json');
    world.landmarks[0].name = 'Кольцо Коммунистической';
    await writeFile(worldPath, JSON.stringify(world));
    const renamed = await buildWorld(worldPath, join(temporary, 'renamed'));
    const original = JSON.parse(await readFile(join(release, 'manifest.json'), 'utf8'));
    expect(renamed.simulationConfigHash).toBe(original.simulationConfigHash);
    expect(renamed.mapVersion).not.toBe(original.mapVersion);
  });
});
