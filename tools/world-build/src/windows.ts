import { SURFACE_KIND, type SurfaceKind } from '@su/contracts';
import type { StaticMeshPart } from './glb.js';
import { addFace } from './house.js';
import { addOutwardFace, type Edge } from './facade.js';

/**
 * Окна зданий по контуру: раскладка по фасаду, проёмы в стене с откосами и подоконником,
 * стекло в глубине проёма и необязательный переплёт. Материал стены (кирпич, доска,
 * панели…) записывается в вершины стены и рисуется шейдером клиента без текстур.
 */
export interface WindowLayout {
  /** Шаг окон (или групп окон) вдоль фасада, м; по умолчанию 2,8. */
  spacing?: number;
  /** Ширина и высота проёма, м; по умолчанию доли высоты этажа. */
  width?: number;
  height?: number;
  /** Низ окна над полом этажа, м. */
  sill?: number;
  /** Окон в группе (спаренные окна) и зазор между ними, м. */
  group?: number;
  gap?: number;
  /** Отступ крайних окон от углов фасада, м; по умолчанию 0,5. */
  margin?: number;
  /** Глубина проёма, м; 0 — плоское окно на стене без проёма. По умолчанию 0,2. */
  recess?: number;
  /** Цвет переплёта: рамка по контуру, импост и фрамуга. */
  frameColor?: string;
}

/** Проём окна на ребре: s — метры вдоль ребра от его начала, y — высота. */
export interface WindowHole {
  s0: number;
  s1: number;
  y0: number;
  y1: number;
  floor: number;
}

const DEFAULT_SPACING = 2.8;
const DEFAULT_MARGIN = 0.5;
export const DEFAULT_RECESS = 0.2;
const FRAME = 0.07;

function positive(value: number | undefined, name: string, max = 50): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < 0 || value > max)
    throw new Error(`Invalid window layout ${name}`);
  return value;
}

export function validateLayout(layout: WindowLayout | undefined): void {
  if (!layout) return;
  for (const key of ['spacing', 'width', 'height', 'sill', 'gap', 'margin'] as const)
    positive(layout[key], key);
  positive(layout.recess, 'recess', 1);
  if (
    layout.group !== undefined &&
    !(Number.isInteger(layout.group) && layout.group >= 1 && layout.group <= 6)
  )
    throw new Error('Invalid window layout group');
  if (layout.spacing !== undefined && layout.spacing < 0.8)
    throw new Error('Invalid window layout spacing');
  if (layout.frameColor !== undefined && !/^#[0-9a-f]{6}$/i.test(layout.frameColor))
    throw new Error('Invalid window layout frameColor');
}

/**
 * Проёмы одного ребра. Без `layout` повторяет прежнюю раскладку: окна равномерно
 * на всю длину с шагом около 2,8 м, размеры — доли высоты этажа.
 */
export function windowHoles(
  length: number,
  base: number,
  storey: number,
  floors: number,
  layout: WindowLayout | undefined,
  skip: (floor: number) => boolean,
): WindowHole[] {
  if (length < 3) return [];
  const spacing = layout?.spacing ?? DEFAULT_SPACING;
  const margin = layout?.margin ?? DEFAULT_MARGIN;
  const count = Math.floor((length - 2 * margin) / spacing);
  if (count < 1) return [];
  const group = layout?.group ?? 1;
  const gap = layout?.gap ?? 0.35;
  const pitch = length / count;
  let width = layout?.width ?? Math.min(1.3, storey * 0.5);
  // Группа не шире своего шага: иначе соседние проёмы сольются.
  width = Math.max(0.3, Math.min(width, (pitch - 0.3 - (group - 1) * gap) / group));
  const height = Math.min(layout?.height ?? Math.min(1.4, storey * 0.48), storey - 0.3);
  const sill = Math.min(layout?.sill ?? storey * 0.32, storey - height - 0.15);
  const span = group * width + (group - 1) * gap;
  const holes: WindowHole[] = [];
  for (let floor = 0; floor < floors; floor++) {
    if (skip(floor)) continue;
    const y0 = base + floor * storey + Math.max(0.1, sill);
    for (let k = 0; k < count; k++) {
      const left = pitch * (k + 0.5) - span / 2;
      for (let g = 0; g < group; g++) {
        const s0 = left + g * (width + gap);
        holes.push({ s0, s1: s0 + width, y0, y1: y0 + height, floor });
      }
    }
  }
  return holes;
}

/** Шаг окон фасада: для швов панелей между окнами. */
export function windowPitch(length: number, layout: WindowLayout | undefined): number {
  const spacing = layout?.spacing ?? DEFAULT_SPACING;
  const count = Math.floor((length - 2 * (layout?.margin ?? DEFAULT_MARGIN)) / spacing);
  return count >= 1 ? length / count : spacing;
}

/** Точка на фасаде: s — вдоль ребра, y — высота, out — вынос наружу (минус — вглубь). */
export function onEdge(edge: Edge, s: number, y: number, out: number): number[] {
  return [
    edge.p[0] + edge.d[0] * s + edge.n[0] * out,
    y,
    edge.p[1] + edge.d[1] * s + edge.n[1] * out,
  ];
}

/**
 * Прямоугольник фасада [s0, s1] × [y0, y1] с вырезанными проёмами. Проёмы одного ряда
 * имеют общие высоты, поэтому полосы между всеми их границами режутся без перекрытий.
 */
export function quadWithHoles(
  part: StaticMeshPart,
  edge: Edge,
  s0: number,
  s1: number,
  y0: number,
  y1: number,
  out: number,
  holes: readonly WindowHole[],
): void {
  const inside = holes.filter((h) => h.s1 > s0 && h.s0 < s1 && h.y1 > y0 && h.y0 < y1);
  const ys = [
    ...new Set([y0, y1, ...inside.flatMap((h) => [h.y0, h.y1]).filter((y) => y > y0 && y < y1)]),
  ].sort((a, b) => a - b);
  const quad = (a: number, b: number, c: number, d: number) => {
    if (b - a < 1e-4 || d - c < 1e-4) return;
    addFace(part, [
      onEdge(edge, a, c, out),
      onEdge(edge, a, d, out),
      onEdge(edge, b, d, out),
      onEdge(edge, b, c, out),
    ]);
  };
  for (let i = 0; i + 1 < ys.length; i++) {
    const [ya, yb] = [ys[i], ys[i + 1]];
    const cuts = inside
      .filter((h) => h.y0 <= ya + 1e-6 && h.y1 >= yb - 1e-6)
      .map((h) => [Math.max(s0, h.s0), Math.min(s1, h.s1)] as const)
      .sort((a, b) => a[0] - b[0]);
    let s = s0;
    for (const [a, b] of cuts) {
      quad(s, a, ya, yb);
      s = Math.max(s, b);
    }
    quad(s, s1, ya, yb);
  }
}

/**
 * Откосы, верх и подоконник проёма: от плоскости стены до стекла. Вместо запекания AO
 * (дорого при сотнях окон) грани получают постоянное затенение в цветах вершин:
 * верх проёма темнее всего, подоконник светлее откосов.
 */
export function addReveals(part: StaticMeshPart, edge: Edge, hole: WindowHole, recess: number) {
  const { s0, s1, y0, y1 } = hole;
  const ym = (y0 + y1) / 2,
    sm = (s0 + s1) / 2;
  const shades = [0.78, 0.78, 0.65, 0.9];
  let next = 0;
  const face = (points: number[][], away: number[]) => {
    const colors = (part.colors ??= []);
    while (colors.length < part.positions.length) colors.push(1);
    addOutwardFace(part, points, away);
    const shade = shades[next++];
    while (colors.length < part.positions.length) colors.push(shade);
  };
  face(
    [
      onEdge(edge, s0, y0, 0),
      onEdge(edge, s0, y1, 0),
      onEdge(edge, s0, y1, -recess),
      onEdge(edge, s0, y0, -recess),
    ],
    onEdge(edge, s0 - 1, ym, -recess / 2),
  );
  face(
    [
      onEdge(edge, s1, y0, 0),
      onEdge(edge, s1, y1, 0),
      onEdge(edge, s1, y1, -recess),
      onEdge(edge, s1, y0, -recess),
    ],
    onEdge(edge, s1 + 1, ym, -recess / 2),
  );
  face(
    [
      onEdge(edge, s0, y1, 0),
      onEdge(edge, s1, y1, 0),
      onEdge(edge, s1, y1, -recess),
      onEdge(edge, s0, y1, -recess),
    ],
    onEdge(edge, sm, y1 + 1, -recess / 2),
  );
  face(
    [
      onEdge(edge, s0, y0, 0),
      onEdge(edge, s1, y0, 0),
      onEdge(edge, s1, y0, -recess),
      onEdge(edge, s0, y0, -recess),
    ],
    onEdge(edge, sm, y0 - 1, -recess / 2),
  );
}

/** Переплёт в плоскости стекла: рамка, импост посередине и фрамуга сверху. */
export function addFrame(part: StaticMeshPart, edge: Edge, hole: WindowHole, out: number) {
  const { s0, s1, y0, y1 } = hole;
  const rect = (a: number, b: number, c: number, d: number) =>
    addFace(part, [
      onEdge(edge, a, c, out),
      onEdge(edge, a, d, out),
      onEdge(edge, b, d, out),
      onEdge(edge, b, c, out),
    ]);
  rect(s0, s1, y0, y0 + FRAME);
  rect(s0, s1, y1 - FRAME, y1);
  rect(s0, s0 + FRAME, y0 + FRAME, y1 - FRAME);
  rect(s1 - FRAME, s1, y0 + FRAME, y1 - FRAME);
  const transom = y1 - (y1 - y0) * 0.28;
  rect(s0 + FRAME, s1 - FRAME, transom - FRAME / 2, transom + FRAME / 2);
  if (s1 - s0 >= 0.9) {
    const sm = (s0 + s1) / 2;
    rect(sm - FRAME / 2, sm + FRAME / 2, y0 + FRAME, transom - FRAME / 2);
  }
}

/**
 * Записывает материал стены в вершины части начиная с `start`. `u` — метры вдоль ребра
 * (у панелей — в шагах окон), `v` — метры от низа стены (у панелей — в этажах).
 */
export function markSurface(
  part: StaticMeshPart,
  start: number,
  kind: SurfaceKind,
  edge: Edge,
  base: number,
  scale: { u: number; v: number } = { u: 1, v: 1 },
): void {
  const surface = (part.surface ??= []);
  const count = part.positions.length / 3;
  while (surface.length < start * 2) surface.push(0, 0);
  if (surface.length !== start * 2) throw new Error(`Surface data overlaps in ${part.partId}`);
  const id = SURFACE_KIND[kind];
  if (!id) throw new Error(`Unknown wall material ${kind}`);
  for (let i = start; i < count; i++) {
    const x = part.positions[i * 3],
      y = part.positions[i * 3 + 1],
      z = part.positions[i * 3 + 2];
    const s = (x - edge.p[0]) * edge.d[0] + (z - edge.p[1]) * edge.d[1];
    // Отрицательные координаты (откосы у угла) сдвигаются, чтобы класс не путался с соседним.
    const u = Math.min(999, Math.max(0, s / scale.u + 1));
    surface.push(id * 1000 + u, (y - base) / scale.v);
  }
}
