import { describe, expect, it } from 'vitest';
import {
  closestPointOnSegment,
  distanceToSegment,
  INTERACTION_KINDS,
  selectInteractable,
  type Interactable,
} from './interactable';

const make = (id: string, priority: number, distance: number, range = 3): Interactable => ({
  id,
  kind: 'pickup',
  key: 'Space',
  keyLabel: 'Пробел',
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
  it('uses Space for pickups, stops and vaults', () => {
    for (const kind of Object.values(INTERACTION_KINDS)) {
      expect(kind.key).toBe('Space');
      expect(kind.keyLabel).toBe('Пробел');
    }
  });
  it('shows one prompt: the nearest within range', () => {
    expect(selectInteractable([make('far', 2, 2.5), make('near', 2, 1)], origin)?.id).toBe('near');
    expect(selectInteractable([make('out', 2, 3.1)], origin)).toBeUndefined();
  });
  it('lets pickups beat vaults even when the vault is closer', () => {
    expect(selectInteractable([make('vault', 1, 0.5), make('box', 2, 2.9)], origin)?.id).toBe(
      'box',
    );
  });
  it('prioritizes a pickup at a bus stop and chooses the nearest stop once it is gone', () => {
    const pickup = { ...make('box', 0, 2.9), ...INTERACTION_KINDS.pickup };
    const stop = { ...make('stop', 0, 1), ...INTERACTION_KINDS.bus };
    const fartherStop = { ...make('other-stop', 0, 2), ...INTERACTION_KINDS.bus };
    expect(selectInteractable([fartherStop, stop, pickup], origin)).toBe(pickup);
    expect(selectInteractable([fartherStop, stop], origin)).toBe(stop);
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
