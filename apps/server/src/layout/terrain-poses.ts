import {
  buildingBounds,
  canonicalJson,
  sampleTerrain,
  terrainPlaneHeight,
  validateTerrainGrid,
  type TerrainGrid,
  type Vec3,
} from '@su/contracts';
import { rectangle, terrainPatch, patchRange, type Point2 } from '@su/terrain-build';
import { planSupportPlacement, selectSupportRule } from '@su/terrain-build/supports';
import { createLayoutPublication } from './release.js';
import { planTerrainItemPoses, type TerrainItemPoseDecision } from './terrain-item-poses.js';
import { planTerrainPlayerPoses } from './terrain-player-poses.js';
import type {
  TerrainMigrationContext,
  TerrainMigrationPreparation,
  TerrainMigrationIssue,
} from './terrain-migration.js';

export type TerrainObjectPolicy =
  | { kind: 'foundation'; maximumVisibleHeight: number }
  | {
      kind: 'ground-anchor';
      anchor: Vec3;
      contactRadius: number;
      maximumTerrainReliefMetres: number;
      /** Minimum plants the local root plane into the high side of the contact patch. */
      contactDatum?: 'anchor' | 'minimum';
    }
  | { kind: 'absolute'; reason: string }
  | { kind: 'unsupported'; reason: string };
export interface TerrainPoseRules {
  formatVersion: 1;
  algorithmVersion: 'terrain-poses/1';
  /** Explicitly verified input surface for releases without a private grid. */
  sourceFlatGroundY?: number;
  sourceGroundIds: string[];
  targetGroundIds: string[];
  models: { assetId: string; policy: TerrainObjectPolicy }[];
  overrides?: { entityId: string; assetId: string; policy: TerrainObjectPolicy }[];
  itemPoseDecisions?: TerrainItemPoseDecision[];
}

type Rectangle = { minX: number; maxX: number; minZ: number; maxZ: number };
const EPS = 1e-8;
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

/** Prove rectangle-union coverage, including multiple ground slabs within one cell. */
function covered(area: Rectangle, slabs: Rectangle[]): boolean {
  const xs = [...new Set([area.minX, area.maxX, ...slabs.flatMap((s) => [s.minX, s.maxX])])]
    .filter((x) => x >= area.minX && x <= area.maxX)
    .sort((a, b) => a - b);
  for (let i = 1; i < xs.length; i++) {
    const x = (xs[i - 1] + xs[i]) / 2;
    const intervals = slabs
      .filter((s) => s.minX <= x && s.maxX >= x)
      .map((s) => [s.minZ, s.maxZ])
      .sort((a, b) => a[0] - b[0]);
    let end = area.minZ;
    for (const [lo, hi] of intervals) {
      if (hi < end) continue;
      if (lo > end + EPS) return false;
      end = Math.max(end, hi);
      if (end >= area.maxZ - EPS) break;
    }
    if (end < area.maxZ - EPS) return false;
  }
  return xs.length >= 2;
}

function verifyGroundIds(context: TerrainMigrationContext, rules: TerrainPoseRules) {
  for (const [label, release, world, ids] of [
    ['source', context.sourceRelease, context.sourceWorld, rules.sourceGroundIds],
    ['target', context.targetRelease, context.targetRelease.definition, rules.targetGroundIds],
  ] as const) {
    if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length)
      throw new Error(`Invalid ${label} ground IDs`);
    for (const id of ids) {
      const owner = world.buildings.find((b) => b.entityId === id);
      if (owner && release.metadata.fixedInstanceIds.includes(id)) continue;
      if (world.entities.some((e) => e.entityId === id)) continue;
      throw new Error(`Unknown or editable ${label} ground ID: ${id}`);
    }
  }
}

function sourceGrid(context: TerrainMigrationContext, rules: TerrainPoseRules): TerrainGrid {
  if (context.sourceRelease.terrain) return validateTerrainGrid(context.sourceRelease.terrain.grid);
  const target = context.targetRelease.terrain?.grid;
  if (!target || !Number.isFinite(rules.sourceFlatGroundY))
    throw new Error('A verified source surface is required for terrain pose planning');
  const slabs: Rectangle[] = [];
  const ids = new Set(rules.sourceGroundIds);
  const identity = (q: { x: number; y: number; z: number; w: number }) =>
    Math.abs(q.x) + Math.abs(q.y) + Math.abs(q.z) < 1e-9 && Math.abs(Math.abs(q.w) - 1) < 1e-9;
  for (const owner of context.sourceWorld.buildings.filter((b) => ids.has(b.entityId))) {
    if (!identity(owner.rotation)) throw new Error('Source flat ground must be axis aligned');
    for (const c of context.sourceWorld.buildingAssets[owner.assetId].colliders) {
      if (
        c.kind !== 'box' ||
        !identity(c.rotation) ||
        Math.abs(owner.position.y + c.position.y + c.size.y / 2 - rules.sourceFlatGroundY!) > 1e-8
      )
        throw new Error('Declared flat ground differs from the actual source collision');
      slabs.push({
        minX: owner.position.x + c.position.x - c.size.x / 2,
        maxX: owner.position.x + c.position.x + c.size.x / 2,
        minZ: owner.position.z + c.position.z - c.size.z / 2,
        maxZ: owner.position.z + c.position.z + c.size.z / 2,
      });
    }
  }
  for (const c of context.sourceWorld.entities.filter((b) => ids.has(b.entityId))) {
    if (Math.abs(c.position.y + c.size.y / 2 - rules.sourceFlatGroundY!) > 1e-8)
      throw new Error('Declared flat source primitive has a different surface');
    slabs.push({
      minX: c.position.x - c.size.x / 2,
      maxX: c.position.x + c.size.x / 2,
      minZ: c.position.z - c.size.z / 2,
      maxZ: c.position.z + c.size.z / 2,
    });
  }
  const b = context.sourceWorld.bounds;
  if (!covered({ minX: b.min.x, maxX: b.max.x, minZ: b.min.z, maxZ: b.max.z }, slabs))
    throw new Error('Declared flat source ground does not cover the world');
  return validateTerrainGrid({
    ...target,
    bottom: Math.min(target.bottom, rules.sourceFlatGroundY! - 1),
    heights: target.heights.map(() => rules.sourceFlatGroundY!),
  });
}
function finitePositive(value: number, name: string) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid ${name}`);
}
function localPoint(
  owner: TerrainMigrationContext['sourceSnapshot']['instances'][number],
  p: Vec3,
) {
  const q = owner.rotation;
  if (Math.abs(q.x) + Math.abs(q.z) > 1e-8)
    throw new Error('Terrain placement requires a vertical owner');
  const yaw = 2 * Math.atan2(q.y, q.w),
    c = Math.cos(yaw),
    s = Math.sin(yaw);
  return { x: owner.position.x + p.x * c + p.z * s, z: owner.position.z - p.x * s + p.z * c };
}

function coversPolygon(grid: TerrainGrid, polygon: Point2[]) {
  if (!polygon.length || polygon.some(([x, z]) => !sampleTerrain(grid, x, z)))
    throw new Error('Object contact/envelope is outside the terrain grid');
}

/** Compare on the overlay, not only one grid's nodes: the other grid may have a hidden peak. */
function sameTerrain(previous: TerrainGrid, next: TerrainGrid, footprint: Point2[]) {
  coversPolygon(previous, footprint);
  coversPolygon(next, footprint);
  if (
    same(previous.origin, next.origin) &&
    previous.spacing === next.spacing &&
    previous.columns === next.columns &&
    previous.rows === next.rows
  ) {
    const patch = terrainPatch(next, footprint);
    return (
      patch.length > 0 &&
      patch.every((t) =>
        t.every((p) => {
          const old = sampleTerrain(previous, p.x, p.z);
          return old && Math.abs(old.height - p.y) <= EPS;
        }),
      )
    );
  }
  const previousPatch = terrainPatch(previous, footprint);
  if (!previousPatch.length) return false;
  for (const before of previousPatch) {
    const overlay = terrainPatch(
      next,
      before.map((p): Point2 => [p.x, p.z]),
    );
    if (!overlay.length) return false;
    for (const triangle of overlay)
      for (const point of triangle)
        if (Math.abs(terrainPlaneHeight(before, point.x, point.z) - point.y) > EPS) return false;
  }
  return true;
}

function checkGridReference(
  grid: TerrainGrid,
  context: TerrainMigrationContext,
  label: 'source' | 'target',
) {
  validateTerrainGrid(grid);
  const b = (label === 'source' ? context.sourceWorld : context.targetRelease.definition).bounds;
  if (
    grid.origin.x !== b.min.x ||
    grid.origin.z !== b.min.z ||
    grid.origin.x + (grid.columns - 1) * grid.spacing !== b.max.x ||
    grid.origin.z + (grid.rows - 1) * grid.spacing !== b.max.z
  )
    throw new Error(`${label} terrain grid reference differs from its world bounds`);
}

/** Explicit dry-run transform. No accepted pose is changed outside a returned migration plan. */
export function planStaticTerrainPoses(context: TerrainMigrationContext, rules: TerrainPoseRules) {
  if (rules.formatVersion !== 1 || rules.algorithmVersion !== 'terrain-poses/1')
    throw new Error('Unsupported terrain pose rules');
  const terrain = context.targetRelease.terrain;
  if (!terrain || terrain.formatVersion !== 2)
    throw new Error('Target release requires terrain v2');
  verifyGroundIds(context, rules);
  checkGridReference(terrain.grid, context, 'target');
  const previous = sourceGrid(context, rules);
  checkGridReference(previous, context, 'source');
  const models = new Map<string, TerrainObjectPolicy>();
  for (const m of rules.models) {
    if (models.has(m.assetId)) throw new Error('Duplicate terrain model policy');
    models.set(m.assetId, m.policy);
  }
  const overrides = new Map<string, TerrainObjectPolicy>();
  for (const m of rules.overrides ?? []) {
    const key = JSON.stringify([m.entityId, m.assetId]);
    if (overrides.has(key)) throw new Error('Duplicate terrain instance policy');
    overrides.set(key, m.policy);
  }
  const targetSnapshot = structuredClone(context.sourceSnapshot);
  targetSnapshot.assetReleaseVersion = context.targetRelease.metadata.assetReleaseVersion;
  const audit: unknown[] = [],
    issues: TerrainMigrationIssue[] = [];
  for (const owner of targetSnapshot.instances) {
    const beforeY = owner.position.y;
    const policy =
      overrides.get(JSON.stringify([owner.entityId, owner.assetId])) ?? models.get(owner.assetId);
    try {
      if (!owner.enabled) {
        audit.push({
          entityId: owner.entityId,
          assetId: owner.assetId,
          rule: 'disabled-preserved',
          beforeY,
          afterY: beforeY,
        });
        continue;
      }
      if (!policy) throw new Error('Model has no explicit terrain policy');
      const targetRule = selectSupportRule(terrain.supports, owner);
      if (policy.kind !== 'foundation' && targetRule)
        throw new Error(
          `Policy ${policy.kind} conflicts with an active private foundation rule; a persistent no-support override is required`,
        );
      if (policy.kind === 'foundation') {
        finitePositive(policy.maximumVisibleHeight, 'maximum foundation height');
        const rule = targetRule;
        if (!rule) throw new Error('Foundation policy has no corresponding private support rule');
        const sourceRule =
          context.sourceRelease.terrain?.formatVersion === 2
            ? selectSupportRule(context.sourceRelease.terrain.supports, owner)
            : undefined;
        if (!sourceRule) {
          if (
            context.sourceRelease.terrain?.supports.some(
              (s) => s.ownerId === owner.entityId && s.assetId === owner.assetId,
            )
          )
            throw new Error('Source foundation rule requires an explicit compatible reference');
          const sourceAsset = context.sourceWorld.buildingAssets[owner.assetId];
          const targetAsset = context.targetRelease.definition.buildingAssets[owner.assetId];
          if (!sourceAsset || !targetAsset || !same(sourceAsset.colliders, targetAsset.colliders))
            throw new Error(
              'Target footprint cannot establish the source support of a changed model',
            );
        }
        const old = planSupportPlacement(previous, sourceRule ?? rule, owner);
        const sourceBase = sourceRule ? old.minimumY : old.terrainMax - rule.jointY;
        if (beforeY < sourceBase - 1e-8)
          throw new Error(
            'Source owner is below its declared support; preserving its offset would invalidate the target foundation',
          );
        const next = planSupportPlacement(terrain.grid, rule, owner);
        const offset = beforeY - sourceBase;
        const y = next.minimumY + offset;
        if (y + rule.jointY - next.terrainMin > policy.maximumVisibleHeight + 1e-8)
          throw new Error(
            `Foundation height ${(y + rule.jointY - next.terrainMin).toFixed(6)} exceeds authored limit ${policy.maximumVisibleHeight}`,
          );
        owner.position.y = y;
        audit.push({
          entityId: owner.entityId,
          assetId: owner.assetId,
          rule: policy.kind,
          beforeY,
          afterY: y,
          sourceBase,
          preservedOffset: offset,
          ...next,
        });
      } else if (policy.kind === 'ground-anchor') {
        const sourceAsset = context.sourceWorld.buildingAssets[owner.assetId];
        const targetAsset = context.targetRelease.definition.buildingAssets[owner.assetId];
        if (!sourceAsset || !targetAsset || !same(sourceAsset, targetAsset))
          throw new Error('A changed anchored model requires an explicit source anchor reference');
        finitePositive(policy.contactRadius, 'anchor contact radius');
        if (
          !Number.isFinite(policy.maximumTerrainReliefMetres) ||
          policy.maximumTerrainReliefMetres < 0
        )
          throw new Error('Invalid anchor relief limit');
        if (
          !policy.anchor ||
          !['x', 'y', 'z'].every((axis) => Number.isFinite(policy.anchor[axis as keyof Vec3]))
        )
          throw new Error('Invalid local anchor');
        const anchor = localPoint(owner, policy.anchor);
        const old = sampleTerrain(previous, anchor.x, anchor.z);
        const next = sampleTerrain(terrain.grid, anchor.x, anchor.z);
        if (!old || !next) throw new Error('Anchor is outside the terrain grid');
        const contactDatum = policy.contactDatum ?? 'anchor';
        if (contactDatum !== 'anchor' && contactDatum !== 'minimum')
          throw new Error('Invalid anchor contact datum');
        const contact = rectangle(
          anchor.x,
          anchor.z,
          policy.contactRadius * 2,
          policy.contactRadius * 2,
        );
        coversPolygon(previous, contact);
        coversPolygon(terrain.grid, contact);
        const sourceRange = patchRange(terrainPatch(previous, contact));
        const patch = terrainPatch(terrain.grid, contact);
        const range = patchRange(patch);
        if (range.max - range.min > policy.maximumTerrainReliefMetres + EPS)
          throw new Error('Terrain relief exceeds the explicitly allowed planting/contact depth');
        const sourceHeight = contactDatum === 'minimum' ? sourceRange.min : old.height;
        const targetHeight = contactDatum === 'minimum' ? range.min : next.height;
        owner.position.y = beforeY + targetHeight - sourceHeight;
        audit.push({
          entityId: owner.entityId,
          assetId: owner.assetId,
          rule: policy.kind,
          beforeY,
          afterY: owner.position.y,
          anchor,
          contactDatum,
          sourceHeight,
          targetHeight,
          preservedOffset: beforeY + policy.anchor.y - sourceHeight,
          sourceRelief: sourceRange.max - sourceRange.min,
          relief: range.max - range.min,
        });
      } else if (policy.kind === 'unsupported') {
        const asset = context.sourceWorld.buildingAssets[owner.assetId];
        if (!asset) throw new Error('Missing source model');
        const b = buildingBounds(owner, asset.bounds);
        const footprint = rectangle(
          (b.min.x + b.max.x) / 2,
          (b.min.z + b.max.z) / 2,
          b.max.x - b.min.x,
          b.max.z - b.min.z,
        );
        // The envelope is a conservative change detector, never a foundation footprint.
        const targetAsset = context.targetRelease.definition.buildingAssets[owner.assetId];
        if (!targetAsset || !same(asset, targetAsset))
          throw new Error('Unsupported model geometry changed');
        if (!sameTerrain(previous, terrain.grid, footprint))
          throw new Error(policy.reason || 'Terrain changed under an unsupported model');
        audit.push({
          entityId: owner.entityId,
          rule: 'unchanged-terrain-envelope',
          beforeY,
          afterY: beforeY,
        });
      } else if (policy.kind === 'absolute') {
        if (typeof policy.reason !== 'string' || !policy.reason.trim())
          throw new Error('Absolute placement requires a reason');
        const sourceAsset = context.sourceWorld.buildingAssets[owner.assetId];
        const targetAsset = context.targetRelease.definition.buildingAssets[owner.assetId];
        if (!sourceAsset || !targetAsset || !same(sourceAsset, targetAsset))
          throw new Error(
            'Absolute model geometry changed and requires an explicit intersection review',
          );
        const bounds = buildingBounds(owner, targetAsset.bounds);
        const footprint = rectangle(
          (bounds.min.x + bounds.max.x) / 2,
          (bounds.min.z + bounds.max.z) / 2,
          bounds.max.x - bounds.min.x,
          bounds.max.z - bounds.min.z,
        );
        // A reason preserves the pose, not permission to bury its geometry.
        // Bounds are deliberately conservative for arches/partial supports;
        // those cases need a specific rule instead of an inferred safe passage.
        coversPolygon(terrain.grid, footprint);
        if (
          patchRange(terrainPatch(terrain.grid, footprint)).max > bounds.min.y + EPS &&
          !sameTerrain(previous, terrain.grid, footprint)
        )
          throw new Error(
            'Changed terrain may intersect an absolute owner; explicit contact/intersection review is required',
          );
        audit.push({
          entityId: owner.entityId,
          rule: 'absolute',
          reason: policy.reason,
          beforeY,
          afterY: beforeY,
        });
      } else throw new Error('Unknown terrain policy');
    } catch (error) {
      issues.push({
        kind: 'static-support',
        entityId: owner.entityId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { targetSnapshot, audit, issues };
}

export async function prepareTerrainPoses(
  context: TerrainMigrationContext,
  rules: TerrainPoseRules,
): Promise<TerrainMigrationPreparation> {
  const { targetSnapshot, audit, issues } = planStaticTerrainPoses(context, rules);
  if (issues.length)
    return {
      targetSnapshot,
      targetItems: structuredClone(context.sourceItems),
      targetPlayers: structuredClone(context.sourcePlayers),
      audit: { statics: audit, items: [], players: [] },
      issues,
    };
  try {
    const target = await createLayoutPublication(context.targetRelease, targetSnapshot);
    const items = await planTerrainItemPoses({
      sourceWorld: context.sourceWorld,
      targetWorld: target.world,
      sourceItems: context.sourceItems,
      sourceGroundIds: rules.sourceGroundIds,
      targetGroundIds: rules.targetGroundIds,
      decisions: rules.itemPoseDecisions,
    });
    const players = items.issues.length
      ? { targetPlayers: structuredClone(context.sourcePlayers), audit: [], issues: [] }
      : await planTerrainPlayerPoses({
          sourceWorld: context.sourceWorld,
          targetWorld: target.world,
          sourcePlayers: context.sourcePlayers,
          sourceItems: context.sourceItems,
          targetItems: items.targetItems,
          sourceGroundIds: rules.sourceGroundIds,
          targetGroundIds: rules.targetGroundIds,
        });
    return {
      targetSnapshot,
      targetItems: items.targetItems,
      targetPlayers: players.targetPlayers,
      audit: { statics: audit, items: items.audit, players: players.audit },
      issues: [...items.issues, ...players.issues],
    };
  } catch (error) {
    return {
      targetSnapshot,
      targetItems: structuredClone(context.sourceItems),
      targetPlayers: structuredClone(context.sourcePlayers),
      audit: { statics: audit, items: [], players: [] },
      issues: [
        {
          kind: 'target-geometry',
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
}
