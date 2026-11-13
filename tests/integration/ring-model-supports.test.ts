import { beforeAll, describe, expect, it } from 'vitest';
import {
  type RingKitSupportCandidate,
  type RingModelSupportCatalog,
} from '../../tools/world-build/src/ring-support-authoring.js';

import { readRevalidatedRingTerrainInputs } from '../../tools/world-build/src/ring-terrain-revalidation.js';

describe('explicit ring model support authoring', () => {
  let catalog: RingModelSupportCatalog;
  let candidates: RingKitSupportCandidate[];
  beforeAll(async () => {
    ({ catalog, candidates } = await readRevalidatedRingTerrainInputs());
  });

  it('accounts for every catalog model and keeps unsupported kit candidates separate', () => {
    expect(catalog.models).toHaveLength(222);
    expect(catalog.rules).toHaveLength(136);
    expect(catalog.models.filter((m) => m.policy.kind === 'ground-anchor')).toHaveLength(21);
    expect(catalog.models.filter((m) => m.policy.kind === 'unsupported')).toHaveLength(64);
    expect(candidates).toHaveLength(64);
    for (const candidate of candidates)
      expect(catalog.rules.some((rule) => rule.assetId === candidate.assetId)).toBe(false);
  });

  it('uses actual separated feet instead of broad collision or bounding rectangles', () => {
    const bench = candidates.find((c) => c.assetId === 'bench-0152a250d22ef0a9')!;
    expect(bench.candidateRule?.components).toHaveLength(2);
    expect(bench.evidence?.supportAreaM2).toBeCloseTo(2 * 0.08 * 0.4, 9);
    expect(
      candidates.find((c) => c.assetId === 'fence-long')?.candidateRule?.components,
    ).toHaveLength(3);
    expect(
      candidates.find((c) => c.assetId === 'fence-short')?.candidateRule?.components,
    ).toHaveLength(2);
    // The sign reaches Y=0; shelter glass bottoms at Y=0.1 require a separate decision.
    const shelter = candidates.find((c) => c.assetId === 'bus-stop-32df9c483410f2a3')!;
    expect(shelter.candidateRule?.components).toHaveLength(1);
    expect(shelter.evidence?.supportAreaM2).toBeCloseTo(0.01, 6);
  });

  it('excludes raised bodies and leaves absent entrance data explicitly unresolved', () => {
    const raised = catalog.models.filter(
      (m) =>
        Array.isArray(m.evidence.excludedElevatedBodies) &&
        m.evidence.excludedElevatedBodies.length > 0,
    );
    expect(raised.map((m) => m.assetId).sort()).toEqual([
      'osm-way-117389706',
      'osm-way-1258973447',
      'osm-way-92104661',
    ]);
    const pilot = catalog.rules.find((r) => r.assetId === 'osm-way-1258973447')!;
    expect(pilot.components).toHaveLength(9);
    expect(pilot.approaches).toHaveLength(1);
    expect(
      catalog.models.filter((m) => m.evidence.entranceStatus === 'no-authored-entrance-data'),
    ).toHaveLength(82);
    expect(catalog.rules.filter((r) => r.approaches?.length)).toHaveLength(1);
  });

  it('retains authored planting roots independently of rendered or collider bottom roundoff', () => {
    const tree = catalog.models.find((m) => m.assetId === 'tree-leaf-medium')!;
    expect(tree.policy).toMatchObject({ kind: 'ground-anchor', anchor: { x: 0, y: 0, z: 0 } });
    const bases = tree.evidence.authoredBasePlanes as { localY: number }[];
    expect(bases.some((plane) => plane.localY < 0)).toBe(true);
    const bush = catalog.models.find((m) => m.assetId === 'bush-large-high')!;
    expect(bush.policy).toMatchObject({ kind: 'ground-anchor', anchor: { x: 0, y: 0, z: 0 } });
    expect(bush.evidence.authoredBasePlanes).toEqual([
      expect.objectContaining({
        localY: 0,
        interpretation: 'authored-root-plane-not-rendered-minimum',
      }),
    ]);
  });
});
