import type { StaticMeshPart } from './glb.js';
import { meshPart } from './house.js';

/** sRGB-цвет #RRGGBB → линейный RGB, как требует glTF. */
export const linear = (hex: string) =>
  [1, 3, 5].map((i) => {
    const srgb = parseInt(hex.slice(i, i + 2), 16) / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  });
/** Сливает части с одинаковым режимом прозрачности; цвет каждой части переходит в вершины. */
export function mergeParts(parts: StaticMeshPart[]): StaticMeshPart[] {
  const merged = new Map<string | null, StaticMeshPart>();
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
      merged.set(part.occlusionGroup, target);
    }
    const offset = target.positions.length / 3;
    const [r, g, b] = linear(part.color);
    // Large terrain parts exceed the engine's argument-count limit for push(...values).
    for (const value of part.positions) target.positions.push(value);
    for (const value of part.normals) target.normals.push(value);
    for (let i = 0; i < part.positions.length; i += 3)
      target.colors!.push(
        r * (part.colors?.[i] ?? 1),
        g * (part.colors?.[i + 1] ?? 1),
        b * (part.colors?.[i + 2] ?? 1),
      );
    for (const index of part.indices) target.indices.push(index + offset);
  }
  return [...merged.values()];
}
