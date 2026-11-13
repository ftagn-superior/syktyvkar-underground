import { createHash } from 'node:crypto';
import {
  canonicalJson,
  validateWorldLayoutSnapshot,
  type Bounds,
  type BuildingAssetManifest,
  type Quat,
  type StaticObjectInstance,
  type Vec3,
  type WorldLayoutSnapshot,
} from '@su/contracts';

export const STATIC_ASSET_REMAP_ALGORITHM = 'static-library-v1';
export interface StaticAssetRemapRules {
  formatVersion: 1;
  algorithmVersion: typeof STATIC_ASSET_REMAP_ALGORITHM;
  worldId: string;
  sourceAssetReleaseVersion: string;
  targetAssetReleaseVersion: string;
  sourceDescriptionHash: string;
  targetLibraryHash: string;
  assetMap: Record<string, string>;
  fences: Record<string, { length: number; center: Vec3 }>;
  /** Reviewed passage corrections in the source fence's local X direction. */
  fenceCenterOffsets: Record<string, number>;
  unchangedAssetIds: string[];
  vegetation: Record<string, { bounds: Bounds; targetBounds: Bounds }>;
  sections: {
    short: { assetId: string; length: number };
    long: { assetId: string; length: number };
  };
  tolerances: { vegetationRelative: number; fenceEndpoint: number };
}
export interface FenceRemap {
  sourceEntityId: string;
  sourceLength: number;
  targetLength: number;
  endpointShift: number;
  centerOffset: number;
  endpointShifts: [number, number];
  sourceEndpoints: [Vec3, Vec3];
  targetEndpoints: [Vec3, Vec3];
  entityIds: string[];
  sections: { entityId: string; assetId: string; position: Vec3; length: number }[];
}
export interface StaticAssetRemapReport {
  sourceCount: number;
  targetCount: number;
  alreadyApplied: boolean;
  fences: FenceRemap[];
  changes: { before: StaticObjectInstance | null; after: StaticObjectInstance }[];
}

const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const requireValue = (value: unknown, message: string): void => {
  if (!value) throw new Error(`Invalid asset remap: ${message}`);
};
const id = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const vector = (value: unknown): value is Vec3 =>
  record(value) && ['x', 'y', 'z'].every((axis) => Number.isFinite(value[axis]));

/** Hash of the self-contained legacy descriptions; no old runtime recipe is required. */
export function staticAssetSourceHash(rules: StaticAssetRemapRules): string {
  return digest({
    assetMap: rules.assetMap,
    fences: rules.fences,
    fenceCenterOffsets: rules.fenceCenterOffsets,
    unchangedAssetIds: rules.unchangedAssetIds,
    vegetation: rules.vegetation,
  });
}

export function staticAssetLibraryHash(
  rules: StaticAssetRemapRules,
  assets: Record<string, BuildingAssetManifest>,
): string {
  const ids = [
    ...new Set([
      ...Object.values(rules.assetMap),
      rules.sections.short.assetId,
      rules.sections.long.assetId,
    ]),
  ].sort();
  return digest(
    Object.fromEntries(
      ids.map((assetId) => {
        if (!Object.hasOwn(assets, assetId) || !assets[assetId])
          throw new Error(`Missing remap library asset ${assetId}`);
        return [assetId, assets[assetId]];
      }),
    ),
  );
}

export function validateStaticAssetRemapRules(
  value: unknown,
): asserts value is StaticAssetRemapRules {
  requireValue(record(value), 'rules object');
  const r = value as StaticAssetRemapRules;
  requireValue(
    r.formatVersion === 1 && r.algorithmVersion === STATIC_ASSET_REMAP_ALGORITHM,
    'algorithm/version',
  );
  requireValue(typeof r.worldId === 'string' && /^[a-z0-9-]{1,64}$/.test(r.worldId), 'worldId');
  for (const key of [
    'sourceAssetReleaseVersion',
    'targetAssetReleaseVersion',
    'sourceDescriptionHash',
    'targetLibraryHash',
  ] as const)
    requireValue(hash(r[key]), key);
  requireValue(r.sourceAssetReleaseVersion !== r.targetAssetReleaseVersion, 'releases must differ');
  requireValue(
    record(r.assetMap) && record(r.fences) && record(r.vegetation) && record(r.fenceCenterOffsets),
    'source descriptors',
  );
  requireValue(
    Array.isArray(r.unchangedAssetIds) && r.unchangedAssetIds.every(id),
    'unchangedAssetIds',
  );
  const sourceIds = new Set(r.unchangedAssetIds);
  requireValue(sourceIds.size === r.unchangedAssetIds.length, 'duplicate unchanged asset');
  for (const [from, to] of Object.entries(r.assetMap)) {
    requireValue(id(from) && id(to) && !sourceIds.has(from), `asset mapping ${from}`);
    sourceIds.add(from);
  }
  for (const [from, fence] of Object.entries(r.fences)) {
    requireValue(id(from) && !sourceIds.has(from) && record(fence), `fence ${from}`);
    requireValue(
      Number.isFinite(fence.length) &&
        fence.length > 0 &&
        fence.length < 1000 &&
        vector(fence.center),
      `fence dimensions ${from}`,
    );
    sourceIds.add(from);
  }
  requireValue(
    record(r.sections) && record(r.sections.short) && record(r.sections.long),
    'sections',
  );
  for (const section of Object.values(r.sections))
    requireValue(
      id(section.assetId) &&
        Number.isFinite(section.length) &&
        section.length >= 0.01 &&
        section.length <= 1000,
      'section',
    );
  const ratio = r.sections.long.length / r.sections.short.length;
  requireValue(
    r.sections.short.assetId !== r.sections.long.assetId && ratio > 1 && Number.isInteger(ratio),
    'two integral section lengths',
  );
  requireValue(
    record(r.tolerances) &&
      r.tolerances.vegetationRelative > 0 &&
      r.tolerances.vegetationRelative <= 0.1 &&
      r.tolerances.fenceEndpoint > 0 &&
      r.tolerances.fenceEndpoint <= 0.125,
    'tolerances',
  );
  for (const [entityId, offset] of Object.entries(r.fenceCenterOffsets))
    requireValue(
      id(entityId) && Number.isFinite(offset) && Math.abs(offset) <= r.tolerances.fenceEndpoint,
      `fence center offset ${entityId}`,
    );
  for (const [assetId, planting] of Object.entries(r.vegetation)) {
    requireValue(Object.hasOwn(r.assetMap, assetId) && record(planting), `vegetation ${assetId}`);
    for (const bounds of [planting.bounds, planting.targetBounds])
      requireValue(
        record(bounds) &&
          vector(bounds.min) &&
          vector(bounds.max) &&
          ['x', 'y', 'z'].every((a) => bounds.max[a as keyof Vec3] > bounds.min[a as keyof Vec3]),
        `vegetation bounds ${assetId}`,
      );
    for (const axis of ['x', 'y', 'z'] as const) {
      const previous = planting.bounds.max[axis] - planting.bounds.min[axis];
      const next = planting.targetBounds.max[axis] - planting.targetBounds.min[axis];
      requireValue(
        Math.abs(next / previous - 1) <= r.tolerances.vegetationRelative + 1e-9,
        `vegetation tolerance ${assetId}/${axis}`,
      );
    }
  }
  requireValue(staticAssetSourceHash(r) === r.sourceDescriptionHash, 'source description checksum');
}

function rotated(v: Vec3, q: Quat): Vec3 {
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + q.y * tz - q.z * ty,
    y: v.y + q.w * ty + q.z * tx - q.x * tz,
    z: v.z + q.w * tz + q.x * ty - q.y * tx,
  };
}
function translated(instance: StaticObjectInstance, local: Vec3): Vec3 {
  const offset = rotated(local, instance.rotation);
  return {
    x: instance.position.x + offset.x,
    y: instance.position.y + offset.y,
    z: instance.position.z + offset.z,
  };
}
export function staticFenceSectionId(entityId: string, index: number): string {
  return `fence-v1-${digest([entityId, STATIC_ASSET_REMAP_ALGORITHM, index]).slice(0, 40)}`;
}

/** Deterministic data transformation shared by seed preparation and offline DB migration. */
export function transformStaticAssets(
  snapshot: WorldLayoutSnapshot,
  rules: StaticAssetRemapRules,
): { snapshot: WorldLayoutSnapshot; report: StaticAssetRemapReport } {
  validateStaticAssetRemapRules(rules);
  validateWorldLayoutSnapshot(snapshot);
  requireValue(snapshot.worldId === rules.worldId, 'world mismatch');
  const report: StaticAssetRemapReport = {
    sourceCount: snapshot.instances.length,
    targetCount: snapshot.instances.length,
    alreadyApplied: snapshot.assetReleaseVersion === rules.targetAssetReleaseVersion,
    fences: [],
    changes: [],
  };
  if (report.alreadyApplied) {
    const allowed = new Set([
      ...rules.unchangedAssetIds,
      ...Object.values(rules.assetMap),
      rules.sections.short.assetId,
      rules.sections.long.assetId,
    ]);
    for (const instance of snapshot.instances)
      requireValue(allowed.has(instance.assetId), `unmapped target asset ${instance.assetId}`);
    return { snapshot: structuredClone(snapshot), report };
  }
  requireValue(
    snapshot.assetReleaseVersion === rules.sourceAssetReleaseVersion,
    'source release mismatch',
  );
  const ids = new Set(snapshot.instances.map((instance) => instance.entityId));
  const unchanged = new Set(rules.unchangedAssetIds);
  const instances: StaticObjectInstance[] = [];
  for (const source of [...snapshot.instances].sort((a, b) =>
    a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0,
  )) {
    const fence = Object.hasOwn(rules.fences, source.assetId)
      ? rules.fences[source.assetId]
      : undefined;
    if (!fence) {
      const assetId = Object.hasOwn(rules.assetMap, source.assetId)
        ? rules.assetMap[source.assetId]
        : undefined;
      requireValue(
        !!assetId || unchanged.has(source.assetId),
        `unmapped source asset ${source.assetId}`,
      );
      const after = { ...structuredClone(source), assetId: assetId ?? source.assetId };
      instances.push(after);
      if (after.assetId !== source.assetId)
        report.changes.push({ before: structuredClone(source), after });
      continue;
    }
    const units = Math.max(1, Math.round(fence.length / rules.sections.short.length));
    const longUnits = rules.sections.long.length / rules.sections.short.length;
    requireValue(
      Math.floor(units / longUnits) + (units % longUnits) <= 10_000,
      `section limit ${source.entityId}`,
    );
    const sections = [
      ...Array.from({ length: Math.floor(units / longUnits) }, () => rules.sections.long),
      ...Array.from({ length: units % longUnits }, () => rules.sections.short),
    ];
    const targetLength = units * rules.sections.short.length;
    const endpointShift = (targetLength - fence.length) / 2;
    const centerOffset = Object.hasOwn(rules.fenceCenterOffsets, source.entityId)
      ? rules.fenceCenterOffsets[source.entityId]
      : 0;
    const endpointShifts: [number, number] = [
      centerOffset - endpointShift,
      centerOffset + endpointShift,
    ];
    requireValue(
      endpointShifts.every((shift) => Math.abs(shift) <= rules.tolerances.fenceEndpoint + 1e-9),
      `fence endpoint tolerance ${source.entityId}`,
    );
    let cursor = -targetLength / 2;
    const centers = sections.map((section) => {
      const center = fence.center.x + centerOffset + cursor + section.length / 2;
      cursor += section.length;
      return center;
    });
    let retainedIndex = 0;
    for (let i = 1; i < centers.length; i++)
      if (Math.abs(centers[i]) < Math.abs(centers[retainedIndex]) - 1e-9) retainedIndex = i;
    const mapped = sections.map((section, index) => {
      const entityId =
        index === retainedIndex ? source.entityId : staticFenceSectionId(source.entityId, index);
      if (index !== retainedIndex) {
        requireValue(!ids.has(entityId), `entity ID conflict ${entityId}`);
        ids.add(entityId);
      }
      const after: StaticObjectInstance = {
        ...structuredClone(source),
        entityId,
        assetId: section.assetId,
        position: translated(source, {
          x: centers[index],
          y: fence.center.y - 0.8,
          z: fence.center.z,
        }),
        instanceRevision: index === retainedIndex ? source.instanceRevision : 1,
      };
      instances.push(after);
      report.changes.push({
        before: index === retainedIndex ? structuredClone(source) : null,
        after,
      });
      return {
        entityId,
        assetId: section.assetId,
        position: after.position,
        length: section.length,
      };
    });
    const endpoints = (length: number, offset = 0): [Vec3, Vec3] =>
      [-1, 1].map((side) =>
        translated(source, {
          x: fence.center.x + offset + (side * length) / 2,
          y: fence.center.y - 0.8,
          z: fence.center.z,
        }),
      ) as [Vec3, Vec3];
    report.fences.push({
      sourceEntityId: source.entityId,
      sourceLength: fence.length,
      targetLength,
      endpointShift,
      centerOffset,
      endpointShifts,
      sourceEndpoints: endpoints(fence.length),
      targetEndpoints: endpoints(targetLength, centerOffset),
      entityIds: mapped.map((section) => section.entityId),
      sections: mapped,
    });
  }
  instances.sort((a, b) => (a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0));
  const result = {
    ...structuredClone(snapshot),
    assetReleaseVersion: rules.targetAssetReleaseVersion,
    instances,
  };
  validateWorldLayoutSnapshot(result);
  report.targetCount = instances.length;
  return { snapshot: result, report };
}
