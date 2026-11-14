/**
 * Высота seed для нового или перенесённого экземпляра — так же, как её считает сборка рельефа
 * (`ring-terrain-build.ts`): у модели с фундаментом — допустимый Y фундамента над рельефом,
 * у модели с опорной точкой — минимум (или точка) рельефа под ней, иначе — рельеф в точке.
 * Разница с «прежняя высота + перепад рельефа» мала, но фундамент на миграции отклоняется,
 * если Y ниже допустимого хоть на микрон.
 */
import type { BuildingInstance, TerrainGrid } from '@su/contracts';
import type { FoundationSupportRuleV2 } from '@su/terrain-build/private-data';
import { planSupportPlacement } from '@su/terrain-build/supports';
import { patchRange, rectangle, terrainPatch } from '@su/terrain-build/terrain';
import { terrainHeight } from './ring-terrain-layout.js';

interface Ground {
  supports: { assetId: string; kind: string; ownerId?: string }[];
  placementModels: { assetId: string; policy: any }[];
}

export function seedHeight(ground: Ground, grid: TerrainGrid, instance: BuildingInstance) {
  const owner = { ...instance, position: { ...instance.position, y: 0 } };
  const rules = ground.supports.filter(
    (r) =>
      r.kind === 'foundation-v2' &&
      r.assetId === instance.assetId &&
      (r.ownerId === undefined || r.ownerId === instance.entityId),
  );
  const rule = rules.find((r) => r.ownerId !== undefined) ?? rules[0];
  if (rule)
    return planSupportPlacement(grid, rule as unknown as FoundationSupportRuleV2, owner).minimumY;
  const policy = ground.placementModels.find((m) => m.assetId === instance.assetId)?.policy;
  if (policy?.kind === 'ground-anchor') {
    const yaw = 2 * Math.atan2(instance.rotation.y, instance.rotation.w);
    const a = policy.anchor;
    const point = {
      x: instance.position.x + a.x * Math.cos(yaw) + a.z * Math.sin(yaw),
      z: instance.position.z - a.x * Math.sin(yaw) + a.z * Math.cos(yaw),
    };
    const r = policy.contactRadius;
    return policy.contactDatum === 'minimum'
      ? patchRange(terrainPatch(grid, rectangle(point.x, point.z, r * 2, r * 2))).min
      : terrainHeight(grid, point);
  }
  return terrainHeight(grid, instance.position);
}
