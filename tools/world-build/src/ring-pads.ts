import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateTerrainGrid, type BuildingInstance, type TerrainGrid } from '@su/contracts';
import type { FoundationSupportRuleV2 } from '@su/terrain-build/private-data';
import { hash } from '@su/world-release';
import { componentDistance } from './syktsu-pad.js';
import {
  RING_TERRAIN_CANDIDATE_DIRECTORY as directory,
  readRingTerrainCandidate,
  smoothstep,
} from './ring-terrain-candidate.js';
import { readRingModelSupportCatalog } from './ring-support-authoring.js';

export interface RingTerrainPads {
  formatVersion: 1;
  status: 'selected-unapplied-explicit-pads';
  sourceGrid: string;
  sourceGridSha256: string;
  supportRulesSha256: string;
  plateauMarginMetres: number;
  blendWidthMetres: number;
  placements: BuildingInstance[];
  forecourt: { ownerId: string; outline: [number, number][] };
  clusters: { id: string; ownerIds: string[]; levelMetres: number }[];
  gradeCorrections: {
    ownerId: string;
    centerY: number;
    gain: number;
    plateauMarginMetres: number;
    blendWidthMetres: number;
  }[];
}

/** Simultaneous explicit pads and bounded local grade corrections; no model auto-selection. */
export function generateRingTerrainPads(
  base: TerrainGrid,
  rules: FoundationSupportRuleV2[],
  config: RingTerrainPads,
): TerrainGrid {
  validateTerrainGrid(base);
  assert.equal(config.formatVersion, 1);
  assert.equal(config.status, 'selected-unapplied-explicit-pads');
  assert.ok(config.plateauMarginMetres >= Math.sqrt(2) * base.spacing);
  assert.ok(config.blendWidthMetres > 0 && Number.isFinite(config.blendWidthMetres));
  const owners = new Map(config.placements.map((owner) => [owner.entityId, owner]));
  assert.equal(owners.size, config.placements.length);
  const rulesByAsset = new Map(rules.map((rule) => [rule.assetId, rule]));
  const ownerDistance = (ownerId: string, x: number, z: number) => {
    const owner = owners.get(ownerId);
    assert.ok(owner, `Missing explicit pad placement: ${ownerId}`);
    assert.deepEqual(owner.rotation, { x: 0, y: 0, z: 0, w: 1 });
    const rule = rulesByAsset.get(owner.assetId);
    assert.ok(rule, `Missing explicit pad support: ${owner.assetId}`);
    return Math.min(
      ...rule.components.map((component) =>
        componentDistance(x - owner.position.x, z - owner.position.z, component),
      ),
    );
  };
  const clusters = [...config.clusters].sort((a, b) => a.id.localeCompare(b.id));
  const corrections = [...config.gradeCorrections].sort((a, b) =>
    a.ownerId.localeCompare(b.ownerId),
  );
  const memberships = clusters.flatMap((cluster) => cluster.ownerIds);
  assert.equal(new Set(memberships).size, memberships.length, 'Duplicate plateau owner');
  assert.equal(new Set(corrections.map((c) => c.ownerId)).size, corrections.length);
  for (const cluster of clusters)
    assert.ok(Number.isFinite(cluster.levelMetres) && cluster.levelMetres > base.bottom);
  for (const correction of corrections) {
    assert.ok(Number.isFinite(correction.centerY) && correction.gain > 0 && correction.gain <= 1);
    assert.ok(
      correction.plateauMarginMetres >= Math.sqrt(2) * base.spacing &&
        correction.blendWidthMetres > 0,
    );
  }
  const heights = base.heights.map((height, index) => {
    const x = base.origin.x + (index % base.columns) * base.spacing;
    const z = base.origin.z + Math.floor(index / base.columns) * base.spacing;
    let numerator = height,
      denominator = 1,
      plateau: number | undefined;
    for (const cluster of clusters) {
      let distance = Math.min(...cluster.ownerIds.map((id) => ownerDistance(id, x, z)));
      if (cluster.ownerIds.includes(config.forecourt.ownerId))
        distance = Math.min(
          distance,
          componentDistance(x, z, { outline: config.forecourt.outline }),
        );
      const weight =
        1 - smoothstep((distance - config.plateauMarginMetres) / config.blendWidthMetres);
      if (weight === 1) {
        assert.ok(
          plateau === undefined || plateau === cluster.levelMetres,
          'Conflicting pad planes must be explicitly grouped',
        );
        plateau = cluster.levelMetres;
      } else {
        const q = weight / (1 - weight);
        numerator += q * cluster.levelMetres;
        denominator += q;
      }
    }
    const clusterHeight = plateau ?? numerator / denominator;
    let delta = 0,
      weights = 0;
    for (const correction of corrections) {
      const distance = ownerDistance(correction.ownerId, x, z);
      const weight =
        1 - smoothstep((distance - correction.plateauMarginMetres) / correction.blendWidthMetres);
      const target = correction.centerY + correction.gain * (clusterHeight - correction.centerY);
      delta += weight * (target - clusterHeight);
      weights += weight;
    }
    return clusterHeight + delta / Math.max(1, weights);
  });
  return validateTerrainGrid({ ...base, origin: { ...base.origin }, heights });
}

export async function readRingTerrainPadInputs() {
  const config: RingTerrainPads = JSON.parse(await readFile(`${directory}/ring-pads.json`, 'utf8'));
  assert.equal(config.sourceGrid, 'pilot-grid-4m.json');
  assert.equal(hash(await readFile(`${directory}/${config.sourceGrid}`)), config.sourceGridSha256);
  assert.equal(hash(await readFile(`${directory}/model-supports.json`)), config.supportRulesSha256);
  const [base, catalog] = await Promise.all([
    readRingTerrainCandidate('pilot'),
    readRingModelSupportCatalog(),
  ]);
  return { base, rules: catalog.rules, config };
}

export async function readRingTerrainPilotWithPads() {
  const { base, rules, config } = await readRingTerrainPadInputs();
  const grid = validateTerrainGrid(
    JSON.parse(await readFile(`${directory}/pilot-grid-with-pads.json`, 'utf8')),
  );
  assert.deepEqual(
    grid,
    generateRingTerrainPads(base, rules, config),
    'Explicit pad grid is stale',
  );
  return grid;
}
