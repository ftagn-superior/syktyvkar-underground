import { expect, it } from 'vitest';
import { runStateViewProbe } from '../large-map/state-view.js';
import { runStaticLifecycleProbe } from '../large-map/physics.js';
import { loadServerWasm } from '../../packages/simulation/src/server.js';
import { generatePlacements } from '../large-map/content.js';

it('fixes a repeatable 256-cell scene with 1600 placements, dense content and remote dependencies', () => {
  const cells = generatePlacements();
  expect(cells).toEqual(generatePlacements());
  expect(cells).not.toEqual(generatePlacements(1));
  expect(cells).toHaveLength(256);
  const buildings = cells.flatMap((cell) => cell.buildings);
  expect(buildings).toHaveLength(1600);
  expect(new Set(buildings.map((building) => building.entityId)).size).toBe(1600);
  expect(cells.find((cell) => cell.cellId === '8_8')!.buildings).toHaveLength(64);
  expect(new Set(buildings.map((building) => building.assetId)).size).toBe(4);
  expect(
    buildings.every(
      (building) => Math.abs(building.position.x) < 1000 && Math.abs(building.position.z) < 1000,
    ),
  ).toBe(true);
});

it('filters the first snapshot, re-enters visibility, and acknowledges input after reconnect', async () => {
  const result = await runStateViewProbe();
  expect(result.result).toBe('passed');
  expect(result.encoding[0].meanBytesPerClientPerPatch).toBeLessThan(
    result.encoding[1].meanBytesPerClientPerPatch,
  );
});

it.each(['courtyard', 'arch'] as const)(
  'retains %s through cell release and frees the final native reference',
  async (kind) => {
    const result = await runStaticLifecycleProbe(await loadServerWasm(), kind);
    expect(result.result).toBe('passed');
    expect(result.final).toEqual({ instances: 0, assets: 0, shapes: 0, references: 0 });
  },
);
