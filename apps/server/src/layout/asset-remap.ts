import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  buildingBounds,
  canonicalJson,
  type Bounds,
  type WorldLayoutSnapshot,
} from '@su/contracts';
import {
  hash,
  staticAssetLibraryHash,
  transformStaticAssets,
  validateStaticAssetRemapRules,
  writeWorldPublication,
  type StaticAssetRemapRules,
} from '@su/world-release';
import { ItemStore } from '../items/store.js';
import type { WorldOwnership } from '../world-ownership.js';
import { validateLayoutSpawns } from './prepare.js';
import { createLayoutPublication, readAuthoringRelease, type AuthoringRelease } from './release.js';
import { StaticLayoutStore } from './store.js';

export interface AssetRemapOptions {
  dryRun?: boolean;
  /** A successful dry-run report, bound to this exact source snapshot and release. */
  plan?: unknown;
}
export interface AssetRemapIssue {
  kind: string;
  message: string;
  entityId?: string;
  assetId?: string;
}
export interface AssetRemapRejectionReport {
  formatVersion: 1;
  status: 'rejected';
  worldId: string;
  stage: string;
  rulesHash?: string;
  sourceRevision?: number;
  sourceSnapshotHash?: string;
  sourceAssetReleaseVersion?: string;
  targetAssetReleaseVersion?: string;
  transformation?: ReturnType<typeof transformStaticAssets>['report'];
  issues: AssetRemapIssue[];
}
export class AssetRemapFailure extends Error {
  constructor(
    error: unknown,
    readonly report: AssetRemapRejectionReport,
  ) {
    super(error instanceof Error ? error.message : 'Unknown asset-remap error', { cause: error });
  }
}

function rejectIssues(issues: AssetRemapIssue[]): never {
  const displayed = issues
    .slice(0, 5)
    .map((issue) => issue.message)
    .join('; ');
  throw new Error(
    issues.length > 5 ? `${displayed}; ${issues.length} issues total (see JSON report)` : displayed,
  );
}

/** Compiled GLB coordinates use Float32; recipes retain their authoring precision. */
export function assetRemapLibraryIssues(
  rules: StaticAssetRemapRules,
  release: AuthoringRelease,
): AssetRemapIssue[] {
  const issues: AssetRemapIssue[] = [];
  const sameEnvelope = (a: Bounds, b: Bounds) =>
    (['min', 'max'] as const).every((edge) =>
      (['x', 'y', 'z'] as const).every((axis) => Math.abs(a[edge][axis] - b[edge][axis]) <= 1e-5),
    );
  for (const [assetId, planting] of Object.entries(rules.vegetation)) {
    const actual = release.manifest.assets[rules.assetMap[assetId]]?.bounds;
    if (!actual || !sameEnvelope(actual, planting.targetBounds))
      issues.push({
        kind: 'vegetation-bounds',
        assetId,
        message: `Vegetation target bounds differ from the compiled asset: ${assetId}`,
      });
    if (
      actual &&
      (['x', 'y', 'z'] as const).some(
        (axis) =>
          Math.abs(
            (actual.max[axis] - actual.min[axis]) /
              (planting.bounds.max[axis] - planting.bounds.min[axis]) -
              1,
          ) >
          rules.tolerances.vegetationRelative + 1e-6,
      )
    )
      issues.push({
        kind: 'vegetation-tolerance',
        assetId,
        message: `Compiled vegetation exceeds the relative bounds tolerance: ${assetId}`,
      });
  }
  for (const section of Object.values(rules.sections)) {
    const colliders = release.definition.buildingAssets[section.assetId]?.colliders;
    const collider = colliders?.[0];
    if (
      colliders?.length !== 1 ||
      collider?.kind !== 'box' ||
      Math.abs(collider.size.x - section.length) > 1e-9 ||
      Math.abs(collider.size.y - 1.6) > 1e-9 ||
      Math.abs(collider.size.z - 0.12) > 1e-9 ||
      canonicalJson(collider.position) !== canonicalJson({ x: 0, y: 0.8, z: 0 }) ||
      canonicalJson(collider.rotation) !== canonicalJson({ x: 0, y: 0, z: 0, w: 1 })
    )
      issues.push({
        kind: 'fence-profile',
        assetId: section.assetId,
        message: `Fence section physics differs from the remap profile: ${section.assetId}`,
      });
  }
  return issues;
}

/** Offline catalog cutover. Every database access uses the session owning the world lock. */
export async function migrateStaticAssets(
  directory: string,
  ownership: WorldOwnership,
  input: unknown,
  options: AssetRemapOptions = {},
) {
  const diagnostics: AssetRemapRejectionReport = {
    formatVersion: 1,
    status: 'rejected',
    worldId: ownership.worldId,
    stage: 'rules',
    issues: [],
  };
  try {
    return await runAssetRemap(directory, ownership, input, options, diagnostics);
  } catch (error) {
    if (!diagnostics.issues.length)
      diagnostics.issues.push({
        kind: diagnostics.stage,
        message: error instanceof Error ? error.message : 'Unknown asset-remap error',
      });
    throw new AssetRemapFailure(error, diagnostics);
  }
}

async function runAssetRemap(
  directory: string,
  ownership: WorldOwnership,
  input: unknown,
  options: AssetRemapOptions,
  diagnostics: AssetRemapRejectionReport,
) {
  const rules: unknown = structuredClone(input);
  diagnostics.rulesHash = hash(canonicalJson(rules));
  validateStaticAssetRemapRules(rules);
  diagnostics.targetAssetReleaseVersion = rules.targetAssetReleaseVersion;
  diagnostics.stage = 'release';
  const release = await readAuthoringRelease(directory);
  if (release.definition.worldId !== ownership.worldId || rules.worldId !== ownership.worldId)
    throw new Error('Asset remap belongs to a different world');
  if (rules.targetAssetReleaseVersion !== release.metadata.assetReleaseVersion)
    throw new Error('Asset remap target release differs from the built release');
  if (staticAssetLibraryHash(rules, release.manifest.assets) !== rules.targetLibraryHash)
    throw new Error('Asset remap target library checksum differs from the built release');
  // Check actual compiled envelopes, independently of the bounds stored in the migration rules.
  diagnostics.issues.push(...assetRemapLibraryIssues(rules, release));
  if (diagnostics.issues.length) rejectIssues(diagnostics.issues);
  diagnostics.stage = 'ownership';
  await ownership.connect();
  const layouts = new StaticLayoutStore(ownership, release);
  const before = await layouts.readCandidate(true);
  const source: WorldLayoutSnapshot = {
    ...before.snapshot,
    assetReleaseVersion: before.previousRelease ?? release.metadata.assetReleaseVersion,
  };
  diagnostics.sourceRevision = source.revision;
  diagnostics.sourceSnapshotHash = hash(canonicalJson(source));
  diagnostics.sourceAssetReleaseVersion = source.assetReleaseVersion;
  diagnostics.stage = 'references';
  const allowed = new Set(
    source.assetReleaseVersion === rules.targetAssetReleaseVersion
      ? [
          ...rules.unchangedAssetIds,
          ...Object.values(rules.assetMap),
          rules.sections.short.assetId,
          rules.sections.long.assetId,
        ]
      : [...rules.unchangedAssetIds, ...Object.keys(rules.assetMap), ...Object.keys(rules.fences)],
  );
  for (const instance of source.instances)
    if (!allowed.has(instance.assetId))
      diagnostics.issues.push({
        kind: 'unknown-reference',
        assetId: instance.assetId,
        entityId: instance.entityId,
        message: `Invalid asset remap: unmapped source asset ${instance.assetId} (${instance.entityId})`,
      });
  if (diagnostics.issues.length) rejectIssues(diagnostics.issues);
  diagnostics.stage = 'transformation';
  const transformed = transformStaticAssets(source, rules);
  diagnostics.transformation = transformed.report;
  let snapshot = transformed.snapshot;
  const alreadyApplied = before.initialized && transformed.report.alreadyApplied;
  diagnostics.stage = 'bounds';
  for (const instance of snapshot.instances) {
    const asset = release.manifest.assets[instance.assetId];
    if (!asset) continue; // createLayoutPublication also rejects unknown target assets.
    const bounds = buildingBounds(instance, asset.bounds);
    if (
      (['x', 'y', 'z'] as const).some(
        (axis) =>
          bounds.min[axis] < release.definition.bounds.min[axis] ||
          bounds.max[axis] > release.definition.bounds.max[axis],
      )
    )
      diagnostics.issues.push({
        kind: 'outside-bounds',
        entityId: instance.entityId,
        assetId: instance.assetId,
        message: `Static building ${instance.entityId} outside containing bounds`,
      });
  }
  if (diagnostics.issues.length) rejectIssues(diagnostics.issues);
  diagnostics.stage = 'publication';
  const {
    world,
    publication,
    hash: validatedHash,
  } = await createLayoutPublication(release, snapshot);
  diagnostics.stage = 'spawn-conflict';
  await validateLayoutSpawns(world);
  const categoryCounts = (value: WorldLayoutSnapshot) => {
    const counts: Record<string, { total: number; enabled: number; disabled: number }> = {};
    for (const instance of value.instances) {
      const target = rules.fences[instance.assetId]
        ? 'fence'
        : (rules.assetMap[instance.assetId] ?? instance.assetId);
      const category =
        target.match(/^(tree|bush|bench|bollard|lamp|traffic-light|fence)(?:-|$)/)?.[1] ??
        'unchanged';
      const entry = (counts[category] ??= { total: 0, enabled: 0, disabled: 0 });
      entry.total++;
      entry[instance.enabled ? 'enabled' : 'disabled']++;
    }
    return counts;
  };
  const report = {
    formatVersion: 1 as const,
    status: 'valid' as const,
    algorithmVersion: rules.algorithmVersion,
    worldId: ownership.worldId,
    rulesHash: diagnostics.rulesHash,
    sourceDescriptionHash: rules.sourceDescriptionHash,
    targetLibraryHash: rules.targetLibraryHash,
    sourceAssetReleaseVersion: source.assetReleaseVersion,
    targetAssetReleaseVersion: snapshot.assetReleaseVersion,
    sourceRevision: source.revision,
    sourceSnapshotHash: diagnostics.sourceSnapshotHash,
    targetSnapshotHash: hash(canonicalJson(snapshot)),
    initialized: before.initialized,
    alreadyApplied,
    layoutHash: validatedHash,
    categories: { before: categoryCounts(source), after: categoryCounts(snapshot) },
    transformation: transformed.report,
    issues: [] as AssetRemapIssue[],
  };
  diagnostics.stage = 'accepted-plan';
  if (
    !options.dryRun &&
    !alreadyApplied &&
    (!options.plan || canonicalJson(options.plan) !== canonicalJson(report))
  )
    throw new Error(
      'Asset remap requires a matching accepted dry-run report (--plan). The source revision, snapshot or rules changed; run a new dry-run.',
    );
  const items = new ItemStore(ownership.pool, world, ownership.epoch, ownership);
  const operationId = options.dryRun || alreadyApplied ? undefined : randomUUID();
  diagnostics.stage = 'saved-item-conflict';
  const geometry = await items.migrateGeometry(
    async () => {
      diagnostics.stage = 'database-write';
      snapshot = await layouts.applyAssetRemap(before, snapshot, validatedHash, operationId!);
      // A failed write rolls back rows, revisions, history, catalog and physics compatibility.
      // Uncommitted immutable files cannot activate a layout on their own.
      diagnostics.stage = 'resource-write';
      await writeWorldPublication(
        publication,
        resolve(directory, 'layouts', release.metadata.assetReleaseVersion, validatedHash),
      );
    },
    options.dryRun || alreadyApplied,
    true,
  );
  return { report, snapshot, operationId, geometry, cells: publication.manifest.cells.length };
}
