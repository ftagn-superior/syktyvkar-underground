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
import { createGameServer } from '../../apps/server/src/index.js';
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

  it('неизвестная буква вывески останавливает сборку', () => {
    expect(() =>
      generateFootprint('test-sign', {
        ...base,
        details: { roofSign: { facing: 'S', text: 'Ы', width: 6, height: 2, color: '#ffffff' } },
      }),
    ).toThrow(/glyph/);
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
});

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

  it('содержит три ориентира, дома, землю и обслуживается по своему worldId', async () => {
    const { definition } = await readWorldDirectory(release);
    expect(definition.landmarks?.map((l) => l.name)).toEqual([
      'Кольцо · «Трудовая слава»',
      'Школа №1',
      'Баня №4',
    ]);
    // Памятник из manual/ стоит в центре кольца и имеет собственные столкновения.
    const monument = definition.buildings.find((b) => b.entityId === 'monument-trudovaya-slava');
    expect(monument).toMatchObject({ assetId: 'trudovaya-slava' });
    expect(Math.hypot(monument!.position.x, monument!.position.z)).toBeLessThan(3);
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
    world.landmarks[0].name = 'Кольцо Коммунистической';
    await writeFile(worldPath, JSON.stringify(world));
    const renamed = await buildWorld(worldPath, join(temporary, 'renamed'));
    const original = JSON.parse(await readFile(join(release, 'manifest.json'), 'utf8'));
    expect(renamed.simulationConfigHash).toBe(original.simulationConfigHash);
    expect(renamed.mapVersion).not.toBe(original.mapVersion);
  });
});
