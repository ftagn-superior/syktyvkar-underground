import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateTerrainGrid, type TerrainGrid } from '@su/contracts';
import type {
  FoundationSupportRuleV2,
  TerrainSupportComponent,
} from '@su/terrain-build/private-data';
import { hash } from '@su/world-release';
import { readPilotSupportRule, PILOT_SUPPORT_ASSET_ID } from './pilot-support.js';
import {
  RING_TERRAIN_CANDIDATE_DIRECTORY,
  readRingTerrainCandidate,
  smoothstep,
} from './ring-terrain-candidate.js';

type Point = readonly [number, number];
export interface SyktsuTerrainPad {
  formatVersion: 1;
  kind: 'explicit-syktsu-ground-pad';
  status: 'selected-unapplied-gameplay-candidate';
  assetId: string;
  sourceGrid: string;
  sourceGridSha256: string;
  supportRule: { path: string; sha256: string };
  placement: {
    position: { x: number; y: number; z: number };
    rotation: { x: number; y: number; z: number; w: number };
  };
  levelMetres: number;
  plateauMarginMetres: number;
  blendWidthMetres: number;
  forecourt: { outline: Point[] };
}

function distanceToSegment(x: number, z: number, a: Point, b: Point) {
  const dx = b[0] - a[0],
    dz = b[1] - a[1];
  const lengthSquared = dx * dx + dz * dz;
  assert.ok(lengthSquared > 0, 'Zero-length pad edge');
  const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / lengthSquared));
  return Math.hypot(x - a[0] - t * dx, z - a[1] - t * dz);
}
function insideRing(x: number, z: number, ring: Point[]) {
  let inside = false;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i],
      b = ring[(i + 1) % ring.length];
    if (a[1] > z !== b[1] > z && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0])
      inside = !inside;
  }
  return inside;
}
export function componentDistance(x: number, z: number, component: TerrainSupportComponent) {
  if (
    insideRing(x, z, component.outline) &&
    !(component.holes ?? []).some((hole) => insideRing(x, z, hole))
  )
    return 0;
  let distance = Infinity;
  for (const ring of [component.outline, ...(component.holes ?? [])])
    for (let i = 0; i < ring.length; i++)
      distance = Math.min(distance, distanceToSegment(x, z, ring[i], ring[(i + 1) % ring.length]));
  return distance;
}

/** A single explicit authored ground intervention, never an automatic per-building flattening. */
export function generateSyktsuTerrainPad(
  base: TerrainGrid,
  rule: FoundationSupportRuleV2,
  pad: SyktsuTerrainPad,
): TerrainGrid {
  validateTerrainGrid(base);
  assert.equal(pad.formatVersion, 1);
  assert.equal(pad.kind, 'explicit-syktsu-ground-pad');
  assert.equal(pad.status, 'selected-unapplied-gameplay-candidate');
  assert.equal(pad.assetId, PILOT_SUPPORT_ASSET_ID);
  assert.equal(rule.assetId, pad.assetId);
  assert.deepEqual(pad.placement.rotation, { x: 0, y: 0, z: 0, w: 1 });
  assert.ok(Number.isFinite(pad.levelMetres) && pad.levelMetres > base.bottom);
  assert.ok(
    Number.isFinite(pad.plateauMarginMetres) &&
      pad.plateauMarginMetres >= Math.sqrt(2) * base.spacing,
  );
  assert.ok(Number.isFinite(pad.blendWidthMetres) && pad.blendWidthMetres > 0);
  assert.ok(
    pad.forecourt.outline.length >= 3 &&
      pad.forecourt.outline.every((p) => p.length === 2 && p.every(Number.isFinite)),
  );
  const { x: ox, z: oz } = pad.placement.position;
  const heights = base.heights.map((height, index) => {
    const x = base.origin.x + (index % base.columns) * base.spacing;
    const z = base.origin.z + Math.floor(index / base.columns) * base.spacing;
    const distance = Math.min(
      componentDistance(x, z, { outline: pad.forecourt.outline }),
      ...rule.components.map((component) => componentDistance(x - ox, z - oz, component)),
    );
    if (distance <= pad.plateauMarginMetres) return pad.levelMetres;
    if (distance >= pad.plateauMarginMetres + pad.blendWidthMetres) return height;
    const weight = 1 - smoothstep((distance - pad.plateauMarginMetres) / pad.blendWidthMetres);
    return height + (pad.levelMetres - height) * weight;
  });
  return validateTerrainGrid({ ...base, origin: { ...base.origin }, heights });
}

export async function readSyktsuTerrainPadInputs() {
  const directory = RING_TERRAIN_CANDIDATE_DIRECTORY;
  const pad: SyktsuTerrainPad = JSON.parse(await readFile(`${directory}/syktsu-pad.json`, 'utf8'));
  assert.equal(pad.sourceGrid, 'pilot-grid-4m.json');
  assert.equal(hash(await readFile(`${directory}/${pad.sourceGrid}`)), pad.sourceGridSha256);
  assert.equal(
    pad.supportRule.path,
    `content/buildings/ring-block/${PILOT_SUPPORT_ASSET_ID}/terrain-support.json`,
  );
  assert.equal(hash(await readFile(pad.supportRule.path)), pad.supportRule.sha256);
  const [base, rule] = await Promise.all([
    readRingTerrainCandidate('pilot'),
    readPilotSupportRule(),
  ]);
  return { base, rule, pad };
}

export async function readRingTerrainPilotWithPad(): Promise<TerrainGrid> {
  const { base, rule, pad } = await readSyktsuTerrainPadInputs();
  const grid = validateTerrainGrid(
    JSON.parse(
      await readFile(`${RING_TERRAIN_CANDIDATE_DIRECTORY}/pilot-grid-with-pad.json`, 'utf8'),
    ),
  );
  assert.deepEqual(
    grid,
    generateSyktsuTerrainPad(base, rule, pad),
    'Authored Syktsu pad grid is stale',
  );
  return grid;
}
