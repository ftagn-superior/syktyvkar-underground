/** Explicit terrain-bound entrance authoring, never inferred from arbitrary model bounds. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { canonicalJson, type BuildingInstance, type WorldLayoutSnapshot } from '@su/contracts';
import {
  validateFoundationSupportRule,
  type FoundationSupportRuleV2,
} from '@su/terrain-build/private-data';

export const RING_ENTRANCE_CATALOG_FILE =
  'content/worlds/ring-block/terrain-candidate/full-entrance-catalog.json';
type Pin = { file: string; sha256: string };
export type RingEntranceDoor = {
  partId: string;
  index: number;
  thresholdHeightMetres: number;
  approachId: string;
  maximumEmittedSlopeDegrees: number;
};
export interface RingEntranceOwner {
  entityId: string;
  assetId: string;
  placement: Pick<BuildingInstance, 'position' | 'rotation'>;
  kind: 'explicit-pedestrian-podium' | 'straight-approaches';
  rule: FoundationSupportRuleV2;
  doors: RingEntranceDoor[];
  maximumAllowedSlopeDegrees: number;
  podium?: {
    rationale: string;
    originalSupportAreaM2: number;
    addedPodiumAreaM2: number;
    authoringPrecisionMetres: number;
    precisionSymmetricDifferenceAreaM2: number;
  };
}
export interface RingEntranceCatalog {
  formatVersion: 1;
  worldId: 'ring-block';
  status:
    | 'incomplete-authoring-candidate'
    | 'geometry-checked-authoring-candidate'
    | 'physics-checked-authoring-candidate';
  terrain: Pin;
  sourcePins: Pin[];
  sourceWorldMapVersion: string;
  sourcePlacementSnapshotSha256: string;
  populationPoseSha256: string;
  overrideArtifact: Pin;
  evidence: Pin[];
  physicalEvidence: Pin[];
  physicalRuntimePins?: Pin[];
  physicalMapVersion?: string;
  gates: {
    allHighThresholdDoorsHaveGeneratedRules: boolean;
    kitProjectionClear: boolean;
    proposedStructureConflictsClear: boolean;
    fullCityRepresentativePhysics: 'pending' | 'failed' | 'passed';
    directTerrainDoorVolumes: 'pending' | 'failed' | 'passed';
  };
  summary: {
    owners: number;
    highThresholdDoors: number;
    coveredHighThresholdDoors: number;
    podiumOwners: number;
    directTerrainDoors: number;
    modelsWithoutAuthoredDoors: number;
    unresolvedHighThresholdDoors: number;
  };
  owners: RingEntranceOwner[];
  directTerrainDoors: Array<{
    entityId: string;
    assetId: string;
    partId: string;
    index: number;
    thresholdHeightMetres: number;
    status: string;
  }>;
  modelsWithoutAuthoredDoors: Array<{
    entityId: string;
    assetId: string;
    status: 'entrances-unverified-no-authored-door-data';
  }>;
  unresolved: unknown[];
}

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const digest = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

function validatePins(pins: Pin[]) {
  assert.ok(Array.isArray(pins));
  const files = new Set<string>();
  for (const pin of pins) {
    assert.ok(
      typeof pin.file === 'string' && !isAbsolute(pin.file) && !pin.file.split('/').includes('..'),
    );
    assert.ok(
      digest(pin.sha256) && !files.has(pin.file),
      'Invalid or duplicate entrance evidence pin',
    );
    files.add(pin.file);
  }
}

async function readVerifiedPins(pins: Pin[]) {
  validatePins(pins);
  return new Map(
    await Promise.all(
      pins.map(async (pin) => {
        const bytes = await readFile(pin.file);
        assert.equal(sha(bytes), pin.sha256, `Stale entrance evidence: ${pin.file}`);
        return [pin.file, bytes] as const;
      }),
    ),
  );
}

/** Record the actual runner, production physics/contracts code and dependency lock
 * before executing routes. Reports own this baseline; catalog regeneration cannot refresh it. */
export async function captureRingEntrancePhysicalRuntimePins(): Promise<Pin[]> {
  const files = [
    'tools/probe-ring-entrance-catalog.ts',
    'tools/world-build/src/ring-entrance-authoring.ts',
    'package.json',
    'packages/simulation/package.json',
    'packages/contracts/package.json',
    'pnpm-lock.yaml',
  ];
  for (const directory of ['packages/simulation/src', 'packages/contracts/src']) {
    const names = await readdir(directory, { recursive: true });
    files.push(
      ...names
        .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
        .map((name) => `${directory}/${name}`),
    );
  }
  return Promise.all(
    files.sort().map(async (file) => ({ file, sha256: sha(await readFile(file)) })),
  );
}

/** All owner poses, including kits. 10 nm position precision absorbs final-build
 * floating-point roundoff and remains 100x below the physics 1 micrometre weld. */
export function ringEntrancePopulationPoseDigest(snapshot: WorldLayoutSnapshot): string {
  const rows = [...snapshot.instances]
    .sort((a, b) => (a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0))
    .map((owner) => [
      owner.entityId,
      owner.assetId,
      owner.enabled,
      ...(['x', 'y', 'z'] as const).map((key) => Math.round(owner.position[key] * 1e8)),
      ...(['x', 'y', 'z', 'w'] as const).map((key) => Math.round(owner.rotation[key] * 1e10)),
    ]);
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

export function validateRingEntranceCatalog(value: unknown): RingEntranceCatalog {
  assert.ok(value && typeof value === 'object', 'Missing entrance catalog');
  const catalog = value as RingEntranceCatalog;
  assert.equal(catalog.formatVersion, 1);
  assert.equal(catalog.worldId, 'ring-block');
  assert.ok(
    [
      'incomplete-authoring-candidate',
      'geometry-checked-authoring-candidate',
      'physics-checked-authoring-candidate',
    ].includes(catalog.status),
  );
  assert.ok(digest(catalog.sourceWorldMapVersion) && digest(catalog.sourcePlacementSnapshotSha256));
  assert.ok(digest(catalog.populationPoseSha256));
  validatePins(catalog.evidence);
  validatePins(catalog.physicalEvidence);
  if (catalog.physicalRuntimePins !== undefined) validatePins(catalog.physicalRuntimePins);
  validatePins([catalog.overrideArtifact]);
  if (catalog.physicalMapVersion !== undefined) assert.ok(digest(catalog.physicalMapVersion));
  assert.ok(Array.isArray(catalog.sourcePins) && catalog.sourcePins.length > 0);
  const pinFiles = new Set<string>();
  for (const pin of catalog.sourcePins) {
    assert.ok(
      typeof pin.file === 'string' && !isAbsolute(pin.file) && !pin.file.split('/').includes('..'),
    );
    assert.ok(
      digest(pin.sha256) && !pinFiles.has(pin.file),
      'Invalid or duplicate entrance source pin',
    );
    pinFiles.add(pin.file);
  }
  assert.ok(
    catalog.sourcePins.some(
      (p) => p.file === catalog.terrain.file && p.sha256 === catalog.terrain.sha256,
    ),
    'Terrain must be source-pinned',
  );
  assert.ok(Array.isArray(catalog.owners) && Array.isArray(catalog.unresolved));
  const owners = new Set<string>();
  const doors = new Set<string>();
  for (const owner of catalog.owners) {
    assert.ok(!owners.has(owner.entityId), 'Duplicate entrance owner');
    owners.add(owner.entityId);
    const rule = validateFoundationSupportRule(owner.rule);
    assert.equal(rule.assetId, owner.assetId);
    assert.equal(rule.ownerId, owner.entityId, 'Entrance rules must select an explicit owner');
    assert.ok(
      Number.isFinite(owner.maximumAllowedSlopeDegrees) && owner.maximumAllowedSlopeDegrees > 0,
    );
    assert.ok(Object.values(owner.placement.position).every(Number.isFinite));
    assert.ok(Object.values(owner.placement.rotation).every(Number.isFinite));
    for (const door of owner.doors) {
      const key = `${owner.entityId}/${door.partId}/${door.index}`;
      assert.ok(!doors.has(key), 'Duplicate authored entrance');
      doors.add(key);
      assert.ok(
        Number.isInteger(door.index) && door.index >= 0 && door.thresholdHeightMetres > 0.2,
      );
      assert.ok(
        rule.approaches?.some((a) => a.id === door.approachId),
        'Entrance has no authored approach',
      );
      assert.ok(
        Number.isFinite(door.maximumEmittedSlopeDegrees) &&
          door.maximumEmittedSlopeDegrees <= owner.maximumAllowedSlopeDegrees,
        'Entrance exceeds its explicit slope limit',
      );
    }
  }
  assert.equal(owners.size, catalog.summary.owners);
  assert.equal(doors.size, catalog.summary.coveredHighThresholdDoors);
  assert.equal(catalog.unresolved.length, catalog.summary.unresolvedHighThresholdDoors);
  assert.equal(catalog.directTerrainDoors.length, catalog.summary.directTerrainDoors);
  assert.equal(
    catalog.modelsWithoutAuthoredDoors.length,
    catalog.summary.modelsWithoutAuthoredDoors,
  );
  assert.ok(
    catalog.modelsWithoutAuthoredDoors.every(
      (m) => m.status === 'entrances-unverified-no-authored-door-data',
    ),
  );
  if (catalog.status !== 'incomplete-authoring-candidate') {
    assert.equal(catalog.unresolved.length, 0);
    assert.equal(doors.size, catalog.summary.highThresholdDoors);
    assert.ok(
      catalog.gates.allHighThresholdDoorsHaveGeneratedRules &&
        catalog.gates.kitProjectionClear &&
        catalog.gates.proposedStructureConflictsClear,
      'Incomplete geometry gates',
    );
  }
  return catalog;
}

export async function readRingEntranceCatalog(
  file = RING_ENTRANCE_CATALOG_FILE,
): Promise<RingEntranceCatalog> {
  const catalog = validateRingEntranceCatalog(JSON.parse(await readFile(file, 'utf8')));
  await Promise.all(
    catalog.sourcePins.map(async (pin) => {
      assert.equal(sha(await readFile(pin.file)), pin.sha256, `Stale entrance source: ${pin.file}`);
    }),
  );
  return catalog;
}

/** Must also run after a strict build: a changed generated release cannot inherit
 * acceptance from the previous target, even if source validation happened first. */
export function assertRingEntranceReleaseMatchesEvidence(
  catalog: RingEntranceCatalog,
  mapVersion: string,
) {
  assert.equal(catalog.status, 'physics-checked-authoring-candidate');
  assert.ok(digest(catalog.physicalMapVersion), 'Missing physically checked target release');
  assert.equal(
    mapVersion,
    catalog.physicalMapVersion,
    'Generated entrance release differs from physically checked target',
  );
}

async function verifyPhysicalEvidence(catalog: RingEntranceCatalog) {
  assert.equal(catalog.status, 'physics-checked-authoring-candidate');
  assert.equal(catalog.gates.fullCityRepresentativePhysics, 'passed');
  assert.equal(catalog.gates.directTerrainDoorVolumes, 'passed');
  assert.ok(digest(catalog.physicalMapVersion));
  assert.ok(catalog.physicalRuntimePins?.length, 'Missing physically checked runtime pins');
  await readVerifiedPins(catalog.physicalRuntimePins);
  assert.equal(
    catalog.physicalEvidence.length,
    2,
    'Both authored and low-door physical reports are required',
  );
  // The detailed geometry reports are also pinned: a green label cannot replace
  // missing execution evidence or silently reuse regenerated diagnostic output.
  await readVerifiedPins(catalog.evidence);
  const bytes = await readVerifiedPins(catalog.physicalEvidence);
  const expected = new Map([
    [
      'full-city-authored-entrances',
      catalog.owners.flatMap((o) => o.doors.map((d) => `${o.entityId}/${d.partId}/${d.index}`)),
    ],
    [
      'full-city-low-door-volumes',
      catalog.directTerrainDoors.map((d) => `${d.entityId}/${d.partId}/${d.index}`),
    ],
  ]);
  const kinds = new Set<string>();
  for (const pin of catalog.physicalEvidence) {
    const report = JSON.parse(bytes.get(pin.file)!.toString());
    assert.ok(
      expected.has(report.kind) && !kinds.has(report.kind),
      'Wrong or duplicate physical report kind',
    );
    kinds.add(report.kind);
    assert.equal(report.status, 'passed');
    assert.equal(report.failures, 0);
    assert.equal(
      report.mapVersion,
      catalog.physicalMapVersion,
      'Physical report belongs to another release',
    );
    assert.equal(report.terrainSha256, catalog.terrain.sha256);
    assert.equal(report.overridesSha256, catalog.overrideArtifact.sha256);
    assert.equal(
      canonicalJson(report.physicalRuntimePins),
      canonicalJson(catalog.physicalRuntimePins),
      'Physical report belongs to another runtime baseline',
    );
    const routeIds = expected.get(report.kind)!;
    assert.equal(report.routes, routeIds.length);
    assert.equal(report.runs, routeIds.length * 2);
    assert.ok(Array.isArray(report.results) && report.results.length === routeIds.length * 2);
    const covered = new Set<string>();
    for (const result of report.results) {
      assert.equal(result.status, 'passed');
      assert.ok(routeIds.includes(result.routeId) && typeof result.sprint === 'boolean');
      const key = `${result.routeId}/${result.sprint}`;
      assert.ok(!covered.has(key), 'Duplicate physical route mode');
      covered.add(key);
    }
    assert.equal(covered.size, routeIds.length * 2);
  }
}

/** A diagnostic build may consume geometry-checked rules before physical acceptance. */
export async function readRingEntranceSupportOverrides(
  snapshot: WorldLayoutSnapshot,
  options: { file?: string; requirePhysicalAcceptance?: boolean } = {},
): Promise<FoundationSupportRuleV2[]> {
  const catalog = await readRingEntranceCatalog(options.file);
  assert.notEqual(
    catalog.status,
    'incomplete-authoring-candidate',
    'Entrance authoring is incomplete',
  );
  assert.equal(snapshot.worldId, catalog.worldId);
  assert.equal(
    ringEntrancePopulationPoseDigest(snapshot),
    catalog.populationPoseSha256,
    'Stale entrance population poses (including kit obstacles)',
  );
  const overrides = await readVerifiedPins([catalog.overrideArtifact]);
  assert.equal(
    canonicalJson(JSON.parse(overrides.get(catalog.overrideArtifact.file)!.toString())),
    canonicalJson(catalog.owners.map((owner) => owner.rule)),
    'Catalog rules differ from physically referenced override artifact',
  );
  if (options.requirePhysicalAcceptance) {
    await verifyPhysicalEvidence(catalog);
  }
  for (const entry of catalog.owners) {
    const owner = snapshot.instances.find((o) => o.entityId === entry.entityId);
    assert.ok(
      owner?.enabled && owner.assetId === entry.assetId,
      `Missing or changed entrance owner: ${entry.entityId}`,
    );
    for (const key of ['x', 'y', 'z'] as const)
      assert.ok(
        Math.abs(owner.position[key] - entry.placement.position[key]) <= 1e-8,
        `Stale entrance position: ${entry.entityId}`,
      );
    for (const key of ['x', 'y', 'z', 'w'] as const)
      assert.ok(
        Math.abs(owner.rotation[key] - entry.placement.rotation[key]) <= 1e-8,
        `Stale entrance rotation: ${entry.entityId}`,
      );
  }
  return catalog.owners.map((owner) => owner.rule);
}
