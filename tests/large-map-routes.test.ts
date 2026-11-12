import { describe, expect, it } from 'vitest';
import {
  expectedInterest,
  spreadRoute,
  direction,
  crowdTarget,
} from '../tools/load-test/src/routes.js';
import type { WorldHeader } from '../packages/contracts/src/index.js';
describe('large-map load contracts', () => {
  it('selects the nearest declared map route, rejects missing routes and does not normalize short moves upwards', () => {
    const near = [
        { x: -504, z: 504 },
        { x: -512, z: 496 },
      ],
      far = [
        { x: 504, z: -504 },
        { x: 512, z: -496 },
      ];
    const header = { routes: { 'spread-far': far, 'spread-near': near } } as unknown as WorldHeader;
    expect(spreadRoute(header, { x: -500, z: 500 })).toBe(near);
    expect(() => spreadRoute({} as WorldHeader, { x: 0, z: 0 })).toThrow('spread-*');
    expect(direction({ x: 0, z: 0 }, { x: 0.2, z: 0 })).toEqual({ moveX: 0.2, moveZ: 0 });
    expect(crowdTarget({ x: 400, z: -300 }, 0, 0)).toEqual({ x: 400, z: -300 });
  });
  it('independently computes exact enter/leave thresholds and ignores Y/cell affiliation', () => {
    const entities = [
      { entityId: 'self', x: -125, z: 0 },
      { entityId: 'enter', x: -45, z: 0 },
      { entityId: 'band', x: -35, z: 0 },
      { entityId: 'leave', x: -25, z: 0 },
      { entityId: 'far', x: -24.999, z: 0 },
    ];
    expect([...expectedInterest(entities, 'self', new Set())]).toEqual(['self', 'enter']);
    expect([...expectedInterest(entities, 'self', new Set(['band', 'leave', 'far']))]).toEqual([
      'self',
      'enter',
      'band',
      'leave',
    ]);
    expect(expectedInterest(entities, 'absent', new Set()).size).toBe(0);
  });
});
