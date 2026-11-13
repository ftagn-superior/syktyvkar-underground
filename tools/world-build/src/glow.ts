import { GLOW_KIND, type GlowKind } from '@su/contracts';
import type { StaticMeshPart } from './glb.js';

/**
 * Ночное свечение статичных моделей. Каждое окно или вывеска получает класс и
 * собственное случайное число: по нему клиент решает, горит ли это окно в данный час.
 * Числа детерминированы, поэтому повторная сборка даёт тот же GLB.
 */
export function glowRandom(key: string): () => number {
  // FNV-1a → mulberry32.
  let state = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) state = Math.imul(state ^ key.charCodeAt(i), 0x01000193);
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    // Шаг 1/65536 точно представим во float32 и не задевает границы 0 и 1.
    return (Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * 65534) + 1) / 65536;
  };
}

/** Помечает вершины части начиная с `start` одним светящимся элементом. */
export function markGlow(part: StaticMeshPart, start: number, kind: GlowKind, seed: number): void {
  const glow = (part.glow ??= []);
  const count = part.positions.length / 3;
  while (glow.length < start * 2) glow.push(0, 0);
  if (glow.length !== start * 2) throw new Error(`Glow data overlaps in ${part.partId}`);
  for (let i = start; i < count; i++) glow.push(GLOW_KIND[kind], seed);
}

/** Выполняет `draw` и помечает всё добавленное им как один элемент свечения. */
export function withGlow(part: StaticMeshPart, kind: GlowKind, seed: number, draw: () => void) {
  const start = part.positions.length / 3;
  draw();
  markGlow(part, start, kind, seed);
}

export { glowOf } from '@su/terrain-build/mesh';
