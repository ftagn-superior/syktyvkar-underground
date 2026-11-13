import { beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  generateSupportAssets,
  planSupportPlacement,
} from '../../packages/terrain-build/src/supports.js';
import { signedArea } from '../../packages/terrain-build/src/triangulate.js';
import {
  readRingKitSupportDecisions,
  type RingKitSupportDecision,
} from '../../tools/world-build/src/ring-kit-authoring.js';
import {
  readRingModelSupportCatalog,
  type RingModelSupportCatalog,
} from '../../tools/world-build/src/ring-support-authoring.js';
import type { Point2 } from '../../packages/terrain-build/src/triangulate.js';

function inside(p: Point2, ring: Point2[]) {
  let result = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i],
      b = ring[j];
    if (
      a[1] > p[1] !== b[1] > p[1] &&
      p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      result = !result;
  }
  return result;
}
const occupied = (d: RingKitSupportDecision, p: Point2) =>
  d.rule.components.some((c) => inside(p, c.outline) && !(c.holes ?? []).some((h) => inside(p, h)));
describe('explicit rigid-kit footing decisions', () => {
  let decisions: RingKitSupportDecision[], catalog: RingModelSupportCatalog;
  beforeAll(async () => {
    catalog = await readRingModelSupportCatalog();
    decisions = await readRingKitSupportDecisions(catalog);
  });

  it('supports the three actual shelter walls while keeping the interior and designed glass gap open', async () => {
    const shelters = decisions.filter((d) => d.treatment === 'shelter-wall-strips-and-sign-foot');
    expect(shelters).toHaveLength(6);
    for (const decision of shelters) {
      const model = catalog.models.find((m) => m.assetId === decision.assetId)!;
      const recipe = JSON.parse(await readFile(model.source.recipeFile, 'utf8'));
      const glass = recipe.parts.find((p: { id: string }) => p.id === 'glass');
      for (const shape of glass.shapes) {
        const b = shape.box;
        expect(occupied(decision, [b.center[0], b.center[2]])).toBe(true);
        expect(b.center[1] - b.size[1] / 2).toBeCloseTo(0.1, 12);
      }
      expect(occupied(decision, [0, 0.5])).toBe(false);
      expect(occupied(decision, [0, -0.1])).toBe(false);
      const area = decision.rule.components.reduce(
        (total, c) =>
          total +
          Math.abs(signedArea(c.outline)) -
          (c.holes ?? []).reduce((a, h) => a + Math.abs(signedArea(h)), 0),
        0,
      );
      expect(area).toBeLessThan(0.7);
    }
  });

  it('generates closed foundations on a slope for every reviewed kit without filling bench and fence gaps', () => {
    const grid = {
      formatVersion: 1 as const,
      origin: { x: -100, z: -100 },
      spacing: 4,
      columns: 51,
      rows: 51,
      bottom: -4,
      heights: Array.from(
        { length: 51 * 51 },
        (_, i) => 0.003 * ((i % 51) * 4 - 100) + 0.002 * (Math.floor(i / 51) * 4 - 100),
      ),
    };
    for (const decision of decisions) {
      const owner = {
        entityId: decision.assetId,
        assetId: decision.assetId,
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: Math.sin(0.17), z: 0, w: Math.cos(0.17) },
      };
      const plan = planSupportPlacement(grid, decision.rule, owner);
      owner.position.y = plan.minimumY;
      const assets = generateSupportAssets(grid, decision.rule, owner, {
        foundation: 'test-footing',
        approaches: {},
      });
      expect(assets).toHaveLength(1);
      expect(plan.minimumY + decision.rule.jointY - plan.terrainMin).toBeLessThan(
        decision.maximumVisibleHeight,
      );
    }
    const bench = decisions.find((d) => d.assetId === 'bench-0152a250d22ef0a9')!;
    expect(bench.rule.components).toHaveLength(2);
    expect(occupied(bench, [0, 0])).toBe(false);
    expect(decisions.find((d) => d.assetId === 'fence-long')!.rule.components).toHaveLength(3);
  });
});
