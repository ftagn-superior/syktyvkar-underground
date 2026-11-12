import type { TreeRenderRecipe } from '@su/contracts';
import type { KitRecipe } from './kit.js';

/** Opt in only the exact current tree profile; edited/imported trees keep their GLB path. */
export function treeRenderRecipe(assetId: string, recipe: KitRecipe): TreeRenderRecipe | undefined {
  if (!assetId.startsWith('tree-') || !recipe.merge || recipe.parts.length !== 2) return;
  const crown = recipe.parts.find((p) => p.id.startsWith('crown-'));
  const trunk = recipe.parts.find((p) => p.id === 'trunk' || p.id.startsWith('trunk-'));
  if (!crown?.fade || !trunk?.fade || crown.shapes.length !== 2 || trunk.shapes.length !== 1)
    return;
  const crowns: TreeRenderRecipe['crowns'][number][] = [];
  for (const shape of crown.shapes) {
    if (!('cone' in shape)) return;
    const c = shape.cone;
    if (c.sides !== 7 || c.center[0] !== 0 || c.center[2] !== 0) return;
    crowns.push([c.radiusBottom, Math.max(0.001, c.radiusTop), c.center[1], c.height]);
  }
  const shape = trunk.shapes[0];
  if (!('box' in shape)) return;
  const b = shape.box;
  if (b.center[0] !== 0 || b.center[2] !== 0) return;
  const result: TreeRenderRecipe = {
    formatVersion: 1,
    ...(recipe.foliage ? { foliage: recipe.foliage, ambientOcclusion: 'foliage-v1' as const } : {}),
    crowns: [crowns[0], crowns[1]],
    trunk: [...b.size, ((b.yaw ?? 0) * Math.PI) / 180],
    trunkBase: b.center[1] - b.size[1] / 2,
    crownColor: crown.color,
    trunkColor: trunk.color,
  };
  if (
    [...result.crowns.flat(), ...result.trunk, result.trunkBase].some(
      (value) => !Number.isFinite(value) || Math.abs(value) > 1000,
    ) ||
    result.trunk.slice(0, 3).some((value) => value <= 0)
  )
    return;
  return result;
}
