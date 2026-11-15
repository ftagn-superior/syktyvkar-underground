import { describe, expect, it } from 'vitest';
import { PlayerSchema } from '../packages/protocol/src';
import { NEUTRAL_INPUT, type PlayerState } from '../packages/contracts/src';
import {
  PlayerActivities,
  updatePlayerActivities,
} from '../apps/server/src/gameplay/player-activities';
import { rigLibrary } from './fixtures/animation-rig';
const actual = (): PlayerState => ({
  entityId: 'p',
  kind: 'player',
  revision: 0,
  position: { x: 0, y: 0.9, z: 0 },
  rotation: { x: 0, y: 0, z: 0, w: 1 },
  velocity: { x: 0, y: 0, z: 0 },
  angularVelocity: { x: 0, y: 0, z: 0 },
  grounded: true,
});

describe('authoritative v2 skin and support policy', () => {
  it('requires measured space, leaves a rejected request replaceable, and cancels on movement or an unsupported skin', () => {
    const player = new PlayerSchema(),
      state = actual(),
      activities = new PlayerActivities(rigLibrary.find);
    expect(activities.animate(player, state, NEUTRAL_INPUT, 'rig-lie', 0).code).toBe(
      'ANIMATION_NO_SPACE',
    );
    expect(player.animationSequence).toBe(0);
    expect(
      activities.animate(player, state, NEUTRAL_INPUT, 'rig-lie', 0, undefined, () => true).ok,
    ).toBe(true);
    state.velocity.x = 0.1;
    updatePlayerActivities(player, state, 1, rigLibrary.find);
    expect(player.animationId).toBe('');
    state.velocity.x = 0;
    expect(
      activities.animate(player, state, NEUTRAL_INPUT, 'rig-side', 120, undefined, () => true).ok,
    ).toBe(true);
    player.skinId = 'bear-wheelchair';
    updatePlayerActivities(player, state, 121, rigLibrary.find);
    expect(player.animationId).toBe('');
  });
  it('rejects wheelchair lying/cartwheel but admits the explicit seated sit without a ground-space query', () => {
    const player = new PlayerSchema();
    player.skinId = 'bear-wheelchair';
    const activities = new PlayerActivities(rigLibrary.find),
      state = actual();
    for (const id of ['rig-lie', 'rig-side', 'rig-cartwheel'])
      expect(activities.animate(player, state, NEUTRAL_INPUT, id, 0).code).toBe(
        'ANIMATION_SKIN_UNSUPPORTED',
      );
    expect(
      activities.animate(player, state, NEUTRAL_INPUT, 'rig-sit', 0, undefined, () => {
        throw new Error('a seated variant does not lie on the floor');
      }).ok,
    ).toBe(true);
  });
});
