import { describe, expect, it } from 'vitest';
import {
  closestPointOnSegment,
  distanceToSegment,
  selectInteractable,
  type Interactable,
} from './interactable';

const make = (id: string, priority: number, distance: number, range = 3): Interactable => ({
  id,
  kind: 'pickup',
  key: 'KeyZ',
  keyLabel: 'Z',
  action: 'x',
  objectName: id,
  range,
  priority,
  getAnchor: () => ({ x: 0, y: 0, z: 0 }),
  getDistance: () => distance,
  onActivate: () => {},
  setHighlighted: () => {},
});
const origin = { x: 0, y: 0, z: 0 };

describe('interactable selection', () => {
  it('shows one prompt: the nearest within range', () => {
    expect(selectInteractable([make('far', 2, 2.5), make('near', 2, 1)], origin)?.id).toBe('near');
    expect(selectInteractable([make('out', 2, 3.1)], origin)).toBeUndefined();
  });
  it('lets pickups beat vaults even when the vault is closer', () => {
    expect(selectInteractable([make('vault', 1, 0.5), make('box', 2, 2.9)], origin)?.id).toBe(
      'box',
    );
  });
});

describe('segment geometry', () => {
  const a = { x: 0, y: 0, z: 0 };
  const b = { x: 10, y: 0, z: 0 };
  it('measures to the closest point and clamps to 4–96% of the length', () => {
    expect(distanceToSegment(a, b, { x: 5, y: 0, z: 3 })).toBeCloseTo(3);
    expect(closestPointOnSegment(a, b, { x: -20, y: 0, z: 0 }).t).toBeCloseTo(0.04);
    expect(closestPointOnSegment(a, b, { x: 99, y: 0, z: 0 }).point.x).toBeCloseTo(9.6);
  });
});
