import { it, expect } from 'vitest';
import { meshPart, addFace } from '@su/terrain-build/mesh';
import { simplifyTerrainPart, terrainReplacementError } from './terrain.js';
it('checks differences at crossing edges even when original vertex samples coincide', () => {
  const points: [number, number, number][] = [
    [0, 0, 0],
    [2, 1, 0],
    [2, 0, 2],
    [0, 1, 2],
  ];
  expect(
    terrainReplacementError(
      points,
      [
        [0, 1, 2],
        [0, 2, 3],
      ],
      [
        [0, 1, 3],
        [1, 2, 3],
      ],
    ),
  ).toBeCloseTo(1);
});
it('removes a flat interior vertex, preserves boundary vertices and removes the lower shell', () => {
  const p = meshPart('ground', 'detail', '#557744');
  const a = [0, 0, 0],
    b = [0, 0, 10],
    c = [10, 0, 10],
    d = [10, 0, 0],
    m = [5, 0, 5];
  for (const [u, v] of [
    [a, b],
    [b, c],
    [c, d],
    [d, a],
  ])
    addFace(p, [u, v, m]);
  addFace(p, [
    [0, -1, 0],
    [10, -1, 0],
    [0, -1, 10],
  ]);
  const q = simplifyTerrainPart(p);
  expect(q.indices.length / 3).toBe(2);
  for (const point of [a, b, c, d])
    expect(
      q.positions.some(
        (_, i) => i % 3 === 0 && q.positions.slice(i, i + 3).every((n, k) => n === point[k]),
      ),
    ).toBe(true);
  expect(q.positions.filter((_, i) => i % 3 === 1).every((y) => y === 0)).toBe(true);
});
it('retains a peak that would exceed the vertical tolerance', () => {
  const p = meshPart('ground', 'detail', '#557744');
  const ring = [
      [0, 0, 0],
      [0, 0, 10],
      [10, 0, 10],
      [10, 0, 0],
    ],
    m = [5, 1, 5];
  for (let i = 0; i < 4; i++) addFace(p, [ring[i], ring[(i + 1) % 4], m]);
  expect(simplifyTerrainPart(p).indices).toHaveLength(12);
});
it('keeps nearly collinear seam segments bit-for-bit while simplifying the interior', () => {
  const p = meshPart('seam', 'detail', '#557744');
  const ring = [
      [0, 0, 0],
      [0, 0, 5],
      [0.00001, 0, 10],
      [10, 0, 10],
      [10, 0, 0],
    ],
    center = [5, 0, 5];
  for (let i = 0; i < ring.length; i++) addFace(p, [ring[i], ring[(i + 1) % ring.length], center]);
  const q = simplifyTerrainPart(p);
  expect(q.indices.length / 3).toBe(ring.length - 2);
  const edges = new Map<string, number>();
  const key = (a: number[], b: number[]) => [a.join(','), b.join(',')].sort().join('|');
  for (let k = 0; k < q.indices.length; k += 3)
    for (let j = 0; j < 3; j++) {
      const a = q.indices[k + j],
        b = q.indices[k + ((j + 1) % 3)],
        edge = key(q.positions.slice(a * 3, a * 3 + 3), q.positions.slice(b * 3, b * 3 + 3));
      edges.set(edge, (edges.get(edge) ?? 0) + 1);
    }
  expect(
    [...edges]
      .filter(([, count]) => count === 1)
      .map(([edge]) => edge)
      .sort(),
  ).toEqual(
    ring
      .map((a, i) => key(a.map(Math.fround), ring[(i + 1) % ring.length].map(Math.fround)))
      .sort(),
  );
});
