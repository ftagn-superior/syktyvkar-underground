import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { FoundationSupportRuleV2 } from '../../packages/terrain-build/src/private-data.js';
import type { Point2 } from '../../packages/terrain-build/src/triangulate.js';
import {
  inspectPilotSupportModel,
  readPilotSupportRule,
  PILOT_SUPPORT_FILE,
} from '../../tools/world-build/src/pilot-support.js';

import { readRevalidatedRingTerrainInputs } from '../../tools/world-build/src/ring-terrain-revalidation.js';

function inside(point: Point2, ring: Point2[]) {
  let value = false;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i],
      b = ring[(i + 1) % ring.length];
    if (
      a[1] > point[1] !== b[1] > point[1] &&
      point[0] < a[0] + ((point[1] - a[1]) * (b[0] - a[0])) / (b[1] - a[1])
    )
      value = !value;
  }
  return value;
}
const occupies = (rule: FoundationSupportRuleV2, point: Point2) =>
  rule.components.some(
    (component) =>
      inside(point, component.outline) &&
      !(component.holes ?? []).some((hole) => inside(point, hole)),
  );

describe('explicit pilot support authoring', () => {
  let rule: FoundationSupportRuleV2;
  let observed: Awaited<ReturnType<typeof inspectPilotSupportModel>>;
  beforeAll(async () => {
    const revalidated = await readRevalidatedRingTerrainInputs();
    rule = revalidated.catalog.rules.find((rule) => rule.assetId === 'osm-way-1258973447')!;
    observed = revalidated.pilot;
  });

  it('matches the actual underside and leaves the open courtyards empty', async () => {
    expect(observed.bodyPlanes).toHaveLength(15);
    expect(observed.bodyPlanes.filter((body) => body.minY === 0)).toHaveLength(14);
    expect(observed.bodyPlanes.find((body) => body.id === 'entrance-attic-body')!.minY).toBeCloseTo(
      16.8,
      10,
    );
    expect(rule.jointY).toBe(0);
    expect(rule.components).toHaveLength(9);
    expect(rule.components.flatMap((component) => component.holes ?? [])).toHaveLength(0);
    expect(occupies(rule, [-40, -45])).toBe(false);
    expect(occupies(rule, [-22.47, -4.43])).toBe(true);
    expect(occupies(rule, [50, 40])).toBe(true);
    const companion = JSON.parse(await readFile(PILOT_SUPPORT_FILE, 'utf8'));
    expect(companion.evidence.precisionFilledFootprintHausdorffBoundMetres).toBeLessThanOrEqual(
      0.001,
    );
    expect(companion.evidence.unusedRootOutlineSymmetricDifferenceM2).toBeGreaterThan(12);
  });

  it('joins the actual step boundary and stops the capsule outside the decorative step', () => {
    const approach = rule.approaches![0];
    expect(approach.targetY).toBe(0.04);
    const middle: Point2 = [
      (approach.edge[0][0] + approach.edge[1][0]) / 2,
      (approach.edge[0][1] + approach.edge[1][1]) / 2,
    ];
    const at = (distance: number): Point2 => [
      middle[0] + distance * approach.outward[0],
      middle[1] + distance * approach.outward[1],
    ];
    expect(occupies(rule, at(-0.001))).toBe(true);
    expect(occupies(rule, at(0.001))).toBe(false);
    expect(occupies(rule, at(0.7))).toBe(false);
    expect(
      Math.hypot(
        approach.edge[1][0] - approach.edge[0][0],
        approach.edge[1][1] - approach.edge[0][1],
      ),
    ).toBeCloseTo(2.4, 12);
  });

  it('keeps historical source pins strict after explicit production revalidation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pilot-support-'));
    try {
      const data = JSON.parse(await readFile(PILOT_SUPPORT_FILE, 'utf8'));
      const path = join(directory, 'support.json');
      const changedSource = structuredClone(data);
      changedSource.source.recipeSha256 = '0'.repeat(64);
      await writeFile(path, JSON.stringify(changedSource));
      await expect(readPilotSupportRule(path)).rejects.toThrow(/Unreviewed pilot source/);
      await expect(readPilotSupportRule()).rejects.toThrow(/Pilot descriptor changed/);
      await expect(inspectPilotSupportModel()).rejects.toThrow(/Pilot model source changed/);
      await expect(inspectPilotSupportModel('0'.repeat(64))).rejects.toThrow(
        /Pilot model source changed/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
