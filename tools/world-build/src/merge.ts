import type { StaticMeshPart } from './glb.js';
import { meshPart } from './house.js';
import { glowOf } from './glow.js';

/** sRGB-цвет #RRGGBB → линейный RGB, как требует glTF. */
export const linear = (hex: string) =>
  [1, 3, 5].map((i) => {
    const srgb = parseInt(hex.slice(i, i + 2), 16) / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  });
/**
 * Сливает части с одинаковым режимом прозрачности; цвет каждой части переходит в вершины.
 * Ночное свечение тоже переносится в вершины; несветящиеся части получают класс 0.
 */
export function mergeParts(parts: StaticMeshPart[]): StaticMeshPart[] {
  const merged = new Map<string | null, StaticMeshPart>();
  const glowing = new Set<string | null>(
    parts.filter((part) => part.glow).map((part) => part.occlusionGroup),
  );
  for (const part of parts) {
    let target = merged.get(part.occlusionGroup);
    if (!target) {
      target = meshPart(
        part.occlusionGroup ? 'fading' : 'static',
        part.occlusionGroup ? 'wall' : 'detail',
        '#ffffff',
      );
      target.occlusionGroup = part.occlusionGroup;
      target.colors = [];
      if (glowing.has(part.occlusionGroup)) target.glow = [];
      merged.set(part.occlusionGroup, target);
    }
    const offset = target.positions.length / 3;
    const [r, g, b] = linear(part.color);
    target.positions.push(...part.positions);
    target.normals.push(...part.normals);
    for (let i = 0; i < part.positions.length; i += 3)
      target.colors!.push(
        r * (part.colors?.[i] ?? 1),
        g * (part.colors?.[i + 1] ?? 1),
        b * (part.colors?.[i + 2] ?? 1),
      );
    if (target.glow) {
      const glow = glowOf(part);
      if (glow) target.glow.push(...glow);
      else for (let i = 0; i < part.positions.length / 3; i++) target.glow.push(0, 0);
    }
    for (const index of part.indices) target.indices.push(index + offset);
  }
  return [...merged.values()];
}
