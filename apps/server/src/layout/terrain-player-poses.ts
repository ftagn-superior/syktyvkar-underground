import type { ItemState, Vec3, WorldDefinition } from '@su/contracts';
import { createAuthoritativeWorld, type AuthoritativeWorld } from '@su/simulation/server';
import type { TerrainMigrationIssue, TerrainPlayerPosition } from './terrain-migration.js';
import { terrainSupportOwnerDelta } from './terrain-item-poses.js';

export interface TerrainPlayerPoseOptions {
  sourceWorld: WorldDefinition;
  targetWorld: WorldDefinition;
  sourcePlayers: TerrainPlayerPosition[];
  sourceItems: ItemState[];
  targetItems: ItemState[];
  sourceGroundIds: readonly string[];
  targetGroundIds: readonly string[];
}

const groundKey = '\u0000ground';
const supportKey = (id: string, ground: Set<string>) => (ground.has(id) ? groundKey : id);
const near = (world: AuthoritativeWorld, center: Vec3) =>
  world
    .queryPlayerSupports(center, {
      startY: center.y + 0.02,
      endY: center.y - 0.06,
    })
    .filter((hit) => hit.normal.y >= 0.5);

/** Offline positions are alternatives, not simultaneous live character obstacles. */
export async function planTerrainPlayerPoses(options: TerrainPlayerPoseOptions) {
  const targetPlayers = structuredClone(options.sourcePlayers);
  const issues: TerrainMigrationIssue[] = [];
  const audit: {
    accountId: string;
    sourcePosition: Vec3;
    targetPosition: Vec3;
    sourceSupportIds: string[];
    targetSupportIds: string[];
    sourceContactY: number;
    targetContactY: number;
    clearance: number;
  }[] = [];
  if (!targetPlayers.length) return { targetPlayers, audit, issues };
  const sourceCharacter = options.sourceWorld.simulation.character;
  const targetCharacter = options.targetWorld.simulation.character;
  if (
    sourceCharacter.height !== targetCharacter.height ||
    sourceCharacter.radius !== targetCharacter.radius
  ) {
    issues.push({ kind: 'changed-player-shape', message: 'Player capsule dimensions changed' });
    return { targetPlayers, audit, issues };
  }
  let source: AuthoritativeWorld | undefined, target: AuthoritativeWorld | undefined;
  const sourceGround = new Set(options.sourceGroundIds),
    targetGround = new Set(options.targetGroundIds);
  try {
    source = await createAuthoritativeWorld({ ...options.sourceWorld, initialItems: [] });
    source.replaceItems(options.sourceItems);
    target = await createAuthoritativeWorld({ ...options.targetWorld, initialItems: [] });
    target.replaceItems(options.targetItems);
    for (const player of targetPlayers) {
      const problem = (kind: string, message: string) =>
        issues.push({ kind, entityId: player.accountId, message });
      try {
        const before = { ...player.position };
        const checked = source.checkPlayerSpawnPosition(before);
        if (!checked.ok) {
          problem('invalid-source-player-pose', checked.reason);
          continue;
        }
        const hits = near(source, before);
        const keys = new Set(hits.map((hit) => supportKey(hit.entityId, sourceGround)));
        if (keys.size !== 1) {
          problem(
            keys.size ? 'ambiguous-player-support' : 'airborne-player',
            'Source capsule must have exactly one unambiguous retained support',
          );
          continue;
        }
        const key = [...keys][0];
        const sourceContactY = Math.max(...hits.map((hit) => hit.contactY));
        const clearance = before.y - sourceContactY;
        let targetContactY: number;
        if (key === groundKey) {
          const groundHits = target
            .queryPlayerSupports(before, {
              startY: options.targetWorld.bounds.max.y + targetCharacter.height,
              endY: options.targetWorld.bounds.min.y - targetCharacter.height,
            })
            .filter((hit) => targetGround.has(hit.entityId) && hit.normal.y >= 0.5);
          if (!groundHits.length) {
            problem(
              'changed-player-support',
              'No walkable target terrain beneath the actual capsule',
            );
            continue;
          }
          targetContactY = Math.max(...groundHits.map((hit) => hit.contactY));
        } else {
          const delta = terrainSupportOwnerDelta(options.sourceWorld, options.targetWorld, key);
          if (delta === undefined) {
            problem(
              'changed-player-support',
              'Source support is dynamic, absent or changed beyond vertical translation',
            );
            continue;
          }
          targetContactY = sourceContactY + delta;
        }
        const candidate = { ...before, y: targetContactY + clearance };
        const targetCheck = target.checkPlayerSpawnPosition(candidate);
        if (!targetCheck.ok) {
          problem('invalid-target-player-pose', targetCheck.reason);
          continue;
        }
        const targetHits = near(target, candidate);
        const targetKeys = new Set(targetHits.map((hit) => supportKey(hit.entityId, targetGround)));
        if (targetKeys.size !== 1 || !targetKeys.has(key)) {
          problem('changed-player-support', 'Target capsule support differs or is ambiguous');
          continue;
        }
        player.position = candidate;
        audit.push({
          accountId: player.accountId,
          sourcePosition: before,
          targetPosition: { ...candidate },
          sourceSupportIds: [...new Set(hits.map((hit) => hit.entityId))].sort(),
          targetSupportIds: [...new Set(targetHits.map((hit) => hit.entityId))].sort(),
          sourceContactY,
          targetContactY,
          clearance,
        });
      } catch (error) {
        problem(
          'player-support-query-failed',
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  } finally {
    target?.dispose();
    source?.dispose();
  }
  return { targetPlayers, audit, issues };
}
