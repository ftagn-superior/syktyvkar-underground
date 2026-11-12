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
      expect.arrayContaining(['entrance-body', 'entrance-attic-body', 'wing-south-body']),
    );
    expect(byAssetCount(definition, 'sorokin-monument')).toBe(1);
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
    expect(definition.buildings[0]).toMatchObject({
      entityId: 'ground',
      assetId: 'ring-block-ground',
    });
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
