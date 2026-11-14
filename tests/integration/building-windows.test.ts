import { describe, expect, it } from 'vitest';
import { SURFACE_KIND } from '../../packages/contracts/src/index.js';
import { generateFootprint, type FootprintRecipe } from '../../tools/world-build/src/city.js';
import { encodeStaticGlb } from '../../tools/world-build/src/glb.js';
import { edgesOf } from '../../tools/world-build/src/facade.js';
import { meshPart } from '../../tools/world-build/src/house.js';
import { quadWithHoles, windowHoles } from '../../tools/world-build/src/windows.js';
import type { Point2 } from '../../tools/world-build/src/triangulate.js';

const box: FootprintRecipe = {
  formatVersion: 1,
  outline: [
    [-6, -4],
    [6, -4],
    [6, 4],
    [-6, 4],
  ] as Point2[],
  height: 9,
  floors: 3,
  windows: true,
  wallColor: '#d8c8a8',
  roofColor: '#555555',
  windowColor: '#223344',
};

/** Площадь треугольников части в плоскости фасада. */
function area(positions: number[], indices: number[]): number {
  let sum = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const [a, b, c] = indices.slice(i, i + 3).map((k) => positions.slice(k * 3, k * 3 + 3));
    const u = b.map((n, j) => n - a[j]),
      v = c.map((n, j) => n - a[j]);
    sum +=
      Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) /
      2;
  }
  return sum;
}

describe('окна зданий по контуру', () => {
  it('без раскладки сохраняют прежние шаг и размеры', () => {
    const holes = windowHoles(12, 0, 3, 3, undefined, () => false);
    // floor((12 − 1) / 2,8) = 3 окна на этаж, ширина min(1,3; 3·0,5), высота min(1,4; 3·0,48).
    expect(holes).toHaveLength(9);
    expect(holes[0].s1 - holes[0].s0).toBeCloseTo(1.3);
    expect(holes[0].y1 - holes[0].y0).toBeCloseTo(1.4);
    expect(holes[0].y0).toBeCloseTo(0.96);
    expect((holes[0].s0 + holes[0].s1) / 2).toBeCloseTo(2);
  });

  it('стена с проёмами теряет ровно площадь окон', () => {
    const [edge] = edgesOf(box.outline);
    const holes = windowHoles(edge.length, 0, 3, 3, { group: 2, spacing: 4 }, () => false);
    const part = meshPart('wall', 'wall', '#ffffff');
    quadWithHoles(part, edge, 0, edge.length, 0, 9, 0, holes);
    const cut = holes.reduce((s, h) => s + (h.s1 - h.s0) * (h.y1 - h.y0), 0);
    expect(area(part.positions, part.indices)).toBeCloseTo(edge.length * 9 - cut, 6);
  });

  it('проёмы дают откосы и стекло в глубине; recess 0 возвращает плоские окна', () => {
    const recessed = generateFootprint('test-windows', box);
    const flat = generateFootprint('test-windows', { ...box, windowLayout: { recess: 0 } });
    expect(recessed.parts.map((p) => p.partId)).toContain('window-reveals');
    expect(flat.parts.map((p) => p.partId)).toEqual(['walls', 'roof', 'windows']);
    const glassDepth = (parts: typeof flat.parts) => {
      const glass = parts.find((p) => p.partId === 'windows')!;
      // Южная стена z = 4: стекло на 3 см снаружи или на глубине проёма внутри.
      return Math.max(...glass.positions.filter((_, i) => i % 3 === 2));
    };
    expect(glassDepth(flat.parts)).toBeCloseTo(4.03);
    expect(glassDepth(recessed.parts)).toBeCloseTo(4 - 0.2 + 0, 5);
    // Столкновение не зависит от проёмов.
    expect(recessed.physics.colliders).toEqual(flat.physics.colliders);
  });

  it('материал стены попадает в вершины, слияние и TEXCOORD_1', () => {
    const merged = generateFootprint('test-brick', { ...box, wallMaterial: 'brick', merge: true });
    const [part] = merged.parts;
    const kinds = new Set(
      part.surface!.filter((_, i) => i % 2 === 0).map((u) => Math.floor(u / 1000)),
    );
    // Стены и откосы — кирпич, стекло и крыша — без материала.
    expect([...kinds].sort()).toEqual([0, SURFACE_KIND.brick]);
    const glb = Buffer.from(encodeStaticGlb(merged.parts));
    expect(glb.toString('latin1')).toContain('"TEXCOORD_1"');
    expect(() =>
      generateFootprint('test-bad', { ...box, wallMaterial: 'marble' as never }),
    ).toThrow(/wallMaterial/);
    // glTF требует TEXCOORD_0 при TEXCOORD_1, даже у стен без ночного свечения.
    const plain = Buffer.from(
      encodeStaticGlb(generateFootprint('test-brick', { ...box, wallMaterial: 'brick' }).parts),
    );
    const json = JSON.parse(plain.subarray(20, 20 + plain.readUInt32LE(12)).toString('utf8'));
    const primitives = json.meshes.flatMap((m: { primitives: object[] }) => m.primitives);
    for (const { attributes } of primitives as { attributes: Record<string, number> }[])
      if ('TEXCOORD_1' in attributes) expect(attributes).toHaveProperty('TEXCOORD_0');
  });

  it('панели размечаются в шагах окон и этажах', () => {
    const { parts } = generateFootprint('test-panel', { ...box, wallMaterial: 'panel' });
    const walls = parts.find((p) => p.partId === 'walls')!;
    const v = walls.surface!.filter((_, i) => i % 2 === 1);
    // Высота 9 м и три этажа: верх стены — третий шов.
    expect(Math.max(...v)).toBeCloseTo(3);
  });
});
