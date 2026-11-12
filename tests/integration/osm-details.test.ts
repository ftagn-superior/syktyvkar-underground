import { describe, expect, it } from 'vitest';
import { validateBuildingPhysicsAsset } from '../../packages/contracts/src/index.js';
import {
  normalize,
  toGame,
  toLatLon,
  type OsmSettings,
  type OsmSnapshot,
} from '../../tools/world-build/src/fetch-osm.js';
import { buildDetails } from '../../tools/world-build/src/osm-details.js';
import { generateKit } from '../../tools/world-build/src/kit.js';
import { generateFootprint } from '../../tools/world-build/src/city.js';
import type { Point2 } from '../../tools/world-build/src/triangulate.js';

const settings: OsmSettings = {
  snapshot: 'unused.json',
  origin: { lat: 61.66386729706631, lon: 50.815951774241576 },
  metersPerDegree: { lon: 52837.29, lat: 110573.15 },
  fetchMargin: 0,
};
/** Узел или линия OSM по игровым координатам [x, z]. */
const at = (x: number, z: number) => toLatLon(settings, x, -z);
const snapshot = (elements: OsmSnapshot['elements']): OsmSnapshot => ({
  formatVersion: 1,
  license: 'test',
  source: 'test',
  fetchedAt: '2026-11-11',
  bbox: { south: 0, west: 0, north: 0, east: 0 },
  elements,
});
const bounds = { minX: -100, maxX: 100, minZ: -100, maxZ: 100 };

describe('снимок OSM', () => {
  it('проекция совпадает с прототипом: север — −Z, обратное преобразование точное', () => {
    const [lat, lon] = toLatLon(settings, 100, 200);
    const [x, z] = toGame(settings, lat, lon);
    expect(x).toBeCloseTo(100, 6);
    expect(z).toBeCloseTo(-200, 6);
    expect(lat).toBeGreaterThan(settings.origin.lat);
  });

  it('нормализация убирает повторы, сортирует и сохраняет геометрию', () => {
    const elements = normalize({
      elements: [
        { type: 'way', id: 5, tags: { building: 'yes' } },
        { type: 'node', id: 9, lat: 1.123456789, lon: 2, tags: { natural: 'tree' } },
        {
          type: 'way',
          id: 5,
          tags: { building: 'yes' },
          nodes: [1, 2],
          geometry: [
            { lat: 1, lon: 2 },
            { lat: 3, lon: 4 },
          ],
        },
        { type: 'node', id: 3, lat: 0, lon: 0 },
      ],
    });
    expect(elements.map((e) => `${e.type}/${e.id}`)).toEqual(['node/9', 'way/5']);
    expect(elements[0].point).toEqual([1.1234568, 2]);
    expect(elements[1].geometry).toHaveLength(2);
  });
});

describe('мелкие объекты из OSM', () => {
  const building: Point2[] = [
    [20, 20],
    [40, 20],
    [40, 40],
    [20, 40],
  ];
  const result = buildDetails({
    settings,
    snapshot: snapshot([
      { type: 'node', id: 2, tags: { barrier: 'gate' }, point: at(10, 0) },
      { type: 'node', id: 10, tags: { natural: 'tree' }, point: at(-30, -30) },
      { type: 'node', id: 11, tags: { natural: 'tree' }, point: at(30, 30) },
      { type: 'node', id: 12, tags: { amenity: 'bench' }, point: at(-10, 30) },
      {
        type: 'way',
        id: 100,
        tags: { barrier: 'fence' },
        nodes: [1, 2, 3],
        geometry: [at(0, 0), at(10, 0), at(20, 0)],
      },
    ]),
    bounds,
    footprints: [building],
    roads: [],
    clear: [],
  });

  it('ворота оставляют проход в ограде, дерево внутри дома пропускается', () => {
    expect(result.stats.fence).toBe(2);
    expect((result.stats['tree-birch'] ?? 0) + (result.stats['tree-leaf'] ?? 0)).toBe(1);
    expect(result.stats.bench).toBe(1);
    const fenceColliders = result.chunks
      .flatMap((c) => c.recipe.colliders)
      .filter((c) => 'size' in c && Math.abs(c.size[1] - 1.6) < 1e-6);
    // Ворота шириной 3 м: от каждого 10-метрового отрезка остаётся 8,5 м.
    expect(fenceColliders.map((c) => ('size' in c ? c.size[0] : 0)).sort()).toEqual([8.5, 8.5]);
  });

  it('квадрат собирается в два меша с цветами вершин и проходит проверку', () => {
    for (const chunk of result.chunks) {
      expect(chunk.recipe.merge).toBe(true);
      const { parts, physics } = generateKit(chunk.id, chunk.recipe);
      expect(parts.length).toBeLessThanOrEqual(2);
      for (const part of parts) expect(part.colors).toHaveLength(part.positions.length);
      validateBuildingPhysicsAsset(physics);
    }
  });
});

describe('входы в здания', () => {
  it('вход у стены даёт дверь с козырьком на ближайшем фасаде', () => {
    const { parts } = generateFootprint('test-doors', {
      formatVersion: 1,
      outline: [
        [-10, -5],
        [10, -5],
        [10, 5],
        [-10, 5],
      ],
      height: 9,
      floors: 3,
      windows: true,
      wallColor: '#cccccc',
      roofColor: '#888888',
      windowColor: '#333333',
      doors: [[0, 5.4]],
    });
    const doors = parts.find((p) => p.partId === 'doors')!;
    const zs = doors.positions.filter((_, i) => i % 3 === 2);
    // Дверь лежит на южной стене (z = 5) с небольшим выносом наружу.
    expect(Math.min(...zs)).toBeGreaterThan(5);
    expect(Math.max(...zs)).toBeLessThan(5.1);
    expect(parts.some((p) => p.partId === 'door-canopies')).toBe(true);
  });

  it('слияние частей сохраняет цвет каждой части в вершинах', () => {
    const base = {
      formatVersion: 1 as const,
      outline: [
        [-5, -5],
        [5, -5],
        [5, 5],
        [-5, 5],
      ] as Point2[],
      height: 6,
      floors: 2,
      windows: true,
      wallColor: '#ffffff',
      roofColor: '#000000',
      windowColor: '#000000',
    };
    const plain = generateFootprint('test-merge', base);
    const merged = generateFootprint('test-merge', { ...base, merge: true });
    expect(merged.parts.map((p) => p.partId)).toEqual(['fading']);
    const [part] = merged.parts;
    expect(part.positions.length).toBe(plain.parts.reduce((s, p) => s + p.positions.length, 0));
    // Белые стены и чёрные окна: в вершинах есть оба цвета.
    const reds = new Set(part.colors!.filter((_, i) => i % 3 === 0));
    expect([...reds].sort()).toEqual([0, 1]);
  });
});
