import {
  canonicalJson,
  itemPhysicsDefinition,
  type ItemPose,
  type ItemState,
  type WorldDefinition,
} from '@su/contracts';
import {
  createAuthoritativeWorld,
  type AuthoritativeWorld,
  type ItemSupportHit,
} from '@su/simulation/server';
import type { TerrainMigrationIssue } from './terrain-migration.js';

export interface TerrainItemPoseAudit {
  entityId: string;
  pose: 'current' | 'safePose';
  support: { kind: 'ground' | 'static'; entityIds: string[] };
  targetSupportIds: string[];
  sourceY: number;
  targetY: number;
  sourceContactY: number;
  targetContactY: number;
  clearance: number;
}
export interface TerrainItemPosesOptions {
  sourceWorld: WorldDefinition;
  targetWorld: WorldDefinition;
  /** World items only. Inventory records never enter this geometry operation. */
  sourceItems: ItemState[];
  sourceGroundIds: readonly string[];
  targetGroundIds: readonly string[];
}
export interface TerrainItemPosesPlan {
  targetItems: ItemState[];
  audit: TerrainItemPoseAudit[];
  issues: TerrainMigrationIssue[];
}

// Existing accepted placements use a short downward sweep and allow <=1cm
// penetration. Do not extend this window to silently land an airborne item.
const above = 0.03;
const below = 0.06;
const contactTolerance = 0.04;
const groundKey = '\u0000ground';
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const supportKey = (id: string, groundIds: Set<string>) => (groundIds.has(id) ? groundKey : id);
const ids = (hits: ItemSupportHit[]) => [...new Set(hits.map((hit) => hit.entityId))].sort();

function nearSupports(world: AuthoritativeWorld, typeId: string, pose: ItemPose, ignoreId: string) {
  return world
    .queryItemSupports(typeId, pose, {
      startY: pose.position.y + above,
      endY: pose.position.y - below,
      ignoreId,
    })
    .filter(
      (hit) => hit.normal.y >= 0.4 && Math.abs(hit.contactY - pose.position.y) <= contactTolerance,
    );
}

/** Static owners may translate vertically, but their contact geometry must survive unchanged. */
function ownerDelta(
  source: WorldDefinition,
  target: WorldDefinition,
  entityId: string,
): number | undefined {
  const a = source.entities.find((owner) => owner.entityId === entityId);
  const b = target.entities.find((owner) => owner.entityId === entityId);
  if (a || b) {
    if (
      !a ||
      !b ||
      !same(a.size, b.size) ||
      a.position.x !== b.position.x ||
      a.position.z !== b.position.z
    )
      return;
    return b.position.y - a.position.y;
  }
  const c = source.buildings.find((owner) => owner.entityId === entityId);
  const d = target.buildings.find((owner) => owner.entityId === entityId);
  if (
    !c ||
    !d ||
    c.position.x !== d.position.x ||
    c.position.z !== d.position.z ||
    !same(c.rotation, d.rotation)
  )
    return;
  const sourceAsset = source.buildingAssets[c.assetId];
  const targetAsset = target.buildingAssets[d.assetId];
  if (!sourceAsset || !targetAsset || !same(sourceAsset.colliders, targetAsset.colliders)) return;
  return d.position.y - c.position.y;
}

/**
 * Identify current and recovery support independently, without advancing either
 * world. Every successful output differs only in those two Y coordinates. Issues
 * are blocking: the migration coordinator must reject the whole plan.
 */
export async function planTerrainItemPoses(
  options: TerrainItemPosesOptions,
): Promise<TerrainItemPosesPlan> {
  const { sourceWorld, targetWorld, sourceItems } = options;
  const sourceGround = new Set(options.sourceGroundIds);
  const targetGround = new Set(options.targetGroundIds);
  const result: TerrainItemPosesPlan = {
    targetItems: structuredClone(sourceItems),
    audit: [],
    issues: [],
  };
  let source: AuthoritativeWorld | undefined;
  let target: AuthoritativeWorld | undefined;
  const issue = (entityId: string, pose: string, kind: string, message: string) => {
    result.issues.push({ entityId, kind, message: `${pose}: ${message}` });
  };
  try {
    source = await createAuthoritativeWorld({ ...sourceWorld, initialItems: [] });
    source.replaceItems(sourceItems);
    target = await createAuthoritativeWorld({ ...targetWorld, initialItems: [] });
    for (const item of result.targetItems) {
      const sourceType = sourceWorld.itemCatalog.types[item.typeId];
      const targetType = targetWorld.itemCatalog.types[item.typeId];
      if (
        !sourceType ||
        !targetType ||
        !same(itemPhysicsDefinition(sourceType), itemPhysicsDefinition(targetType))
      ) {
        issue(item.entityId, 'item', 'changed-item-shape', 'item physics changed between releases');
        continue;
      }
      const poses = [['current', item] as const, ['safePose', item.safePose] as const];
      for (const [poseName, pose] of poses) {
        try {
          const sourceError = source.checkSavedItem({
            ...item,
            position: pose.position,
            rotation: pose.rotation,
            safePose: pose,
          });
          if (sourceError) {
            issue(item.entityId, poseName, 'invalid-source-item-pose', sourceError);
            continue;
          }
          const hits = nearSupports(source, item.typeId, pose, item.entityId);
          const keys = new Set(hits.map((hit) => supportKey(hit.entityId, sourceGround)));
          if (keys.size !== 1) {
            issue(
              item.entityId,
              poseName,
              keys.size ? 'ambiguous-item-support' : 'airborne-item',
              keys.size
                ? `multiple possible supports: ${ids(hits).join(', ')}`
                : 'no support within the saved contact window',
            );
            continue;
          }
          const key = [...keys][0];
          const sourceContactY = Math.max(...hits.map((hit) => hit.contactY));
          const clearance = pose.position.y - sourceContactY;
          let targetContactY: number;
          if (key === groundKey) {
            const groundHits = target
              .queryItemSupports(item.typeId, pose, {
                startY: targetWorld.bounds.max.y + 100,
                endY: targetWorld.bounds.min.y - 100,
              })
              .filter((hit) => targetGround.has(hit.entityId) && hit.normal.y >= 0.4);
            if (!groundHits.length) {
              issue(
                item.entityId,
                poseName,
                'changed-item-support',
                'target terrain has no support for the item shape',
              );
              continue;
            }
            targetContactY = Math.max(...groundHits.map((hit) => hit.contactY));
          } else {
            const delta = ownerDelta(sourceWorld, targetWorld, key);
            if (delta === undefined) {
              issue(
                item.entityId,
                poseName,
                'changed-item-support',
                `support ${key} is absent, dynamic, or changed beyond vertical translation`,
              );
              continue;
            }
            targetContactY = sourceContactY + delta;
          }
          const candidate: ItemPose = {
            position: { ...pose.position, y: targetContactY + clearance },
            rotation: { ...pose.rotation },
          };
          const targetHits = nearSupports(target, item.typeId, candidate, item.entityId);
          const targetKeys = new Set(
            targetHits.map((hit) => supportKey(hit.entityId, targetGround)),
          );
          if (targetKeys.size !== 1 || !targetKeys.has(key)) {
            issue(
              item.entityId,
              poseName,
              targetKeys.size > 1 ? 'ambiguous-item-support' : 'changed-item-support',
              `target support differs: ${ids(targetHits).join(', ') || 'none'}`,
            );
            continue;
          }
          const probe = {
            ...item,
            position: candidate.position,
            rotation: candidate.rotation,
            safePose: candidate,
          };
          const error = target.checkSavedItem(probe);
          if (error) {
            issue(item.entityId, poseName, 'invalid-target-item-pose', error);
            continue;
          }
          result.audit.push({
            entityId: item.entityId,
            pose: poseName,
            support: { kind: key === groundKey ? 'ground' : 'static', entityIds: ids(hits) },
            targetSupportIds: ids(targetHits),
            sourceY: pose.position.y,
            targetY: candidate.position.y,
            sourceContactY,
            targetContactY,
            clearance,
          });
          pose.position.y = candidate.position.y;
        } catch (error) {
          issue(
            item.entityId,
            poseName,
            'item-support-query-failed',
            error instanceof Error ? error.message : String(error),
          );
        }
      }
    }
    // Validate against migrated peers as well as statics; a vertical move must not
    // create a new overlap. No simulation step or velocity reset is performed.
    if (!result.issues.length) {
      target.replaceItems(result.targetItems);
      for (const item of result.targetItems) {
        const error = target.checkSavedItem(item);
        if (error) issue(item.entityId, 'item', 'invalid-target-item-pose', error);
        for (const [poseName, pose] of [
          ['current', item],
          ['safePose', item.safePose],
        ] as const) {
          const expected = result.audit.find(
            (entry) => entry.entityId === item.entityId && entry.pose === poseName,
          )!;
          const key =
            expected.support.kind === 'ground' ? groundKey : expected.support.entityIds[0];
          const hits = nearSupports(target, item.typeId, pose, item.entityId);
          const keys = new Set(hits.map((hit) => supportKey(hit.entityId, targetGround)));
          if (keys.size !== 1 || !keys.has(key)) {
            issue(
              item.entityId,
              poseName,
              'ambiguous-item-support',
              `migrated peers changed the support: ${ids(hits).join(', ') || 'none'}`,
            );
          }
        }
      }
    }
    return result;
  } finally {
    target?.dispose();
    source?.dispose();
  }
}
