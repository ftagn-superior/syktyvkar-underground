import { describe, expect, it } from 'vitest';
import { createWorldGrid, type WorldManifest } from '@su/contracts';
import { predictionCells } from './prediction-area';
const bounds = { min: { x: -1000, y: -10, z: -1000 }, max: { x: 1000, y: 20, z: 1000 } };
const manifest = { bounds, grid: createWorldGrid(bounds, 125) } as WorldManifest;
describe('prediction collision history', () => {
  it('pins the capsule on both sides of a seam', () => {
    expect(
      predictionCells(manifest, { x: -0.4, y: 1, z: 4 }, { x: 0.05, y: 1, z: 4 }, 0.35),
    ).toEqual(['7_8', '8_8']);
  });
  it('pins four cells at a diagonal corner without depending on an unloaded outer row', () => {
    expect(
      predictionCells(manifest, { x: -0.05, y: 1, z: -0.05 }, { x: 0.05, y: 1, z: 0.05 }, 0.35),
    ).toEqual(['7_7', '8_7', '7_8', '8_8']);
  });
});
