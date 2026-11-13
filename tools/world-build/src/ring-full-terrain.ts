import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  canonicalJson,
  validateTerrainGrid,
  validateWorldLayoutSnapshot,
  type TerrainGrid,
  type WorldLayoutSnapshot,
} from '@su/contracts';
import type {
  FoundationSupportRuleV2,
  TerrainSupportComponent,
} from '@su/terrain-build/private-data';
import { hash } from '@su/world-release';
import { readRingModelSupportCatalog } from './ring-support-authoring.js';
import { readRingKitSupportDecisions } from './ring-kit-authoring.js';
import { readRingAnchorDecisions } from './ring-anchor-authoring.js';
import { generateRingTerrainPads, type RingTerrainPads } from './ring-pads.js';
import { componentDistance } from './syktsu-pad.js';
import {
  readRingTerrainCandidate,
  RING_TERRAIN_CANDIDATE_DIRECTORY as directory,
  smoothstep,
} from './ring-terrain-candidate.js';

export interface FullTerrainPad {
  id: string;
  ownerIds: string[];
  levelMetres: number;
  plateauMarginMetres: number;
  blendWidthMetres: number;
  reason: string;
}
interface LevelOverride {
  id: string;
  levelMetres: number;
  reason: string;
}
export interface FullRingTerrainConfig {
  formatVersion: 1;
  status: 'explicit-unapplied-full-terrain-pads';
  sourceGrid: 'full-grid-4m.json';
  sourceGridSha256: string;
  sourceExportSha256: string;
  buildingPads: {
    file: 'ring-pads.json';
    sha256: string;
    replacement: {
      reason: string;
      clusters: (RingTerrainPads['clusters'][number] & { reason: string })[];
      gradeCorrections: (RingTerrainPads['gradeCorrections'][number] & { reason: string })[];
      retiredOwners: { ownerId: string; reason: string }[];
    };
  };
  publicPads: { file: 'public-space-pads.json'; sha256: string; levelOverrides: LevelOverride[] };
  additionalPads: FullTerrainPad[];
}
interface PublicPads {
  pads: {
    id: string;
    owners: string[];
    level: number;
    margin: number;
    blend: number;
    placements: {
      owner: WorldLayoutSnapshot['instances'][number];
      ruleSha256: string;
      components: TerrainSupportComponent[];
    }[];
  }[];
}

function worldComponents(
  owner: WorldLayoutSnapshot['instances'][number],
  rule: FoundationSupportRuleV2,
): TerrainSupportComponent[] {
  assert.ok(Math.abs(owner.rotation.x) + Math.abs(owner.rotation.z) < 1e-8);
  const yaw = 2 * Math.atan2(owner.rotation.y, owner.rotation.w),
    c = Math.cos(yaw),
    s = Math.sin(yaw);
  const transform = ([x, z]: readonly [number, number]): [number, number] => [
    owner.position.x + x * c + z * s,
    owner.position.z - x * s + z * c,
  ];
  return rule.components.map((part) => ({
    outline: part.outline.map(transform),
    ...(part.holes ? { holes: part.holes.map((h) => h.map(transform)) } : {}),
  }));
}

/** Every edited footprint/level is named in the authored config; nothing auto-selects owners. */
export function generateFullRingTerrain(
  base: TerrainGrid,
  buildingRules: FoundationSupportRuleV2[],
  allRules: FoundationSupportRuleV2[],
  snapshot: WorldLayoutSnapshot,
  inheritedBuildings: RingTerrainPads,
  inheritedPublic: PublicPads,
  config: FullRingTerrainConfig,
): TerrainGrid {
  validateTerrainGrid(base);
  assert.equal(config.formatVersion, 1);
  assert.equal(config.status, 'explicit-unapplied-full-terrain-pads');
  const buildings = structuredClone(inheritedBuildings);
  const levelOverrides = (values: LevelOverride[]) => {
    assert.equal(new Set(values.map((v) => v.id)).size, values.length);
    for (const value of values)
      assert.ok(
        Number.isFinite(value.levelMetres) &&
          value.levelMetres > base.bottom &&
          value.reason.trim(),
      );
    return new Map(values.map((v) => [v.id, v.levelMetres]));
  };
  const replacement = config.buildingPads.replacement;
  assert.ok(replacement.reason.trim());
  for (const decision of [...replacement.clusters, ...replacement.gradeCorrections])
    assert.ok(decision.reason.trim(), 'Missing full building intervention rationale');
  buildings.clusters = replacement.clusters;
  buildings.gradeCorrections = replacement.gradeCorrections;
  const selectedIds = [
    ...replacement.clusters.flatMap((c) => c.ownerIds),
    ...replacement.gradeCorrections.map((c) => c.ownerId),
  ];
  const selected = new Set(selectedIds);
  assert.equal(selected.size, selectedIds.length, 'Duplicate full building owner');
  const retired = new Set(replacement.retiredOwners.map((r) => r.ownerId));
  assert.equal(retired.size, replacement.retiredOwners.length);
  for (const r of replacement.retiredOwners) {
    assert.ok(r.reason.trim() && !selected.has(r.ownerId));
    assert.ok(inheritedBuildings.placements.some((p) => p.entityId === r.ownerId));
  }
  for (const owner of inheritedBuildings.placements)
    assert.ok(
      selected.has(owner.entityId) || retired.has(owner.entityId),
      'Unexplained pilot intervention',
    );
  buildings.placements = snapshot.instances.filter(
    (owner) => owner.enabled && selected.has(owner.entityId),
  );
  assert.equal(buildings.placements.length, selected.size, 'Unknown full building owner');
  const clustered = generateRingTerrainPads(base, buildingRules, buildings);
  const owners = new Map(snapshot.instances.filter((i) => i.enabled).map((i) => [i.entityId, i]));
  const rules = new Map(allRules.map((r) => [r.assetId, r]));
  const publicLevels = levelOverrides(config.publicPads.levelOverrides);
  for (const id of publicLevels.keys())
    assert.ok(
      inheritedPublic.pads.some((p) => p.id === id),
      `Unknown public pad ${id}`,
    );
  const pads = inheritedPublic.pads.map((pad) => {
    for (const placement of pad.placements) {
      assert.equal(
        canonicalJson(placement.owner),
        canonicalJson(owners.get(placement.owner.entityId)),
        'Public pad placement changed',
      );
      const rule = rules.get(placement.owner.assetId)!;
      assert.equal(hash(canonicalJson(rule)), placement.ruleSha256, 'Public pad contact changed');
      assert.deepEqual(worldComponents(placement.owner, rule), placement.components);
    }
    return {
      id: pad.id,
      ownerIds: pad.owners,
      levelMetres: publicLevels.get(pad.id) ?? pad.level,
      plateauMarginMetres: pad.margin,
      blendWidthMetres: pad.blend,
      components: pad.placements.flatMap((p) => p.components),
    };
  });
  for (const pad of config.additionalPads) {
    assert.ok(pad.id && pad.reason.trim() && pad.ownerIds.length);
    const components = pad.ownerIds.flatMap((id) => {
      const owner = owners.get(id);
      assert.ok(owner, `Unknown extra pad owner ${id}`);
      const rule = rules.get(owner.assetId);
      assert.ok(rule, `Extra pad owner requires an explicit footprint: ${id}`);
      return worldComponents(owner, rule);
    });
    pads.push({ ...pad, components });
  }
  assert.equal(new Set(pads.map((p) => p.id)).size, pads.length, 'Duplicate full-terrain pad');
  const padOwners = pads.flatMap((p) => p.ownerIds);
  assert.equal(new Set(padOwners).size, padOwners.length, 'Duplicate full-terrain pad owner');
  pads.sort((a, b) => a.id.localeCompare(b.id));
  for (const pad of pads) {
    assert.ok(Number.isFinite(pad.levelMetres) && pad.levelMetres > base.bottom);
    assert.ok(
      Number.isFinite(pad.plateauMarginMetres) &&
        pad.plateauMarginMetres >= Math.SQRT2 * base.spacing,
    );
    assert.ok(Number.isFinite(pad.blendWidthMetres) && pad.blendWidthMetres > 0);
  }
  const heights = clustered.heights.map((height, index) => {
    const x = base.origin.x + (index % base.columns) * base.spacing;
    const z = base.origin.z + Math.floor(index / base.columns) * base.spacing;
    let numerator = height,
      denominator = 1,
      plateau: number | undefined;
    for (const pad of pads) {
      const distance = Math.min(
        ...pad.components.map((component) => componentDistance(x, z, component)),
      );
      const weight = 1 - smoothstep((distance - pad.plateauMarginMetres) / pad.blendWidthMetres);
      if (weight === 1) {
        assert.ok(
          plateau === undefined || plateau === pad.levelMetres,
          `Conflicting full pad planes near ${pad.id}`,
        );
        plateau = pad.levelMetres;
      } else {
        const q = weight / (1 - weight);
        numerator += q * pad.levelMetres;
        denominator += q;
      }
    }
    return plateau ?? numerator / denominator;
  });
  return validateTerrainGrid({ ...base, origin: { ...base.origin }, heights });
}

export async function readFullRingTerrainInputs() {
  const config: FullRingTerrainConfig = JSON.parse(
    await readFile(`${directory}/full-terrain-pads.json`, 'utf8'),
  );
  assert.equal(config.sourceGrid, 'full-grid-4m.json');
  const [gridBytes, snapshotBytes, buildingBytes, publicBytes] = await Promise.all([
    readFile(`${directory}/${config.sourceGrid}`),
    readFile('data/map-layout.json'),
    readFile(`${directory}/${config.buildingPads.file}`),
    readFile(`${directory}/${config.publicPads.file}`),
  ]);
  assert.equal(hash(gridBytes), config.sourceGridSha256);
  assert.equal(hash(snapshotBytes), config.sourceExportSha256);
  assert.equal(hash(buildingBytes), config.buildingPads.sha256);
  assert.equal(hash(publicBytes), config.publicPads.sha256);
  const snapshot: WorldLayoutSnapshot = JSON.parse(snapshotBytes.toString());
  validateWorldLayoutSnapshot(snapshot);
  const catalog = await readRingModelSupportCatalog();
  const [base, kits, anchors] = await Promise.all([
    readRingTerrainCandidate('full'),
    readRingKitSupportDecisions(catalog),
    readRingAnchorDecisions(catalog),
  ]);
  return {
    base,
    snapshot,
    catalog,
    kits,
    anchors,
    config,
    inheritedBuildings: JSON.parse(buildingBytes.toString()) as RingTerrainPads,
    inheritedPublic: JSON.parse(publicBytes.toString()) as PublicPads,
  };
}
