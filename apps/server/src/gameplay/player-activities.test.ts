import { describe, expect, it } from 'vitest';
import {
  NEUTRAL_INPUT,
  TICK_RATE,
  WORLD_ACTIVITY_MOVE_DURATION_MS,
  type PlayerState,
} from '@su/contracts';
import { PlayerSchema } from '@su/protocol';
import { cancelAnimation, PlayerActivities, updatePlayerActivities } from './player-activities.js';

function fixture() {
  const player = new PlayerSchema();
  const activities = new PlayerActivities();
  const actual: PlayerState = {
    entityId: 'player',
    kind: 'player',
    revision: 0,
    grounded: true,
    position: { x: 0, y: 1, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    velocity: { x: 0, y: 0, z: 0 },
    angularVelocity: { x: 0, y: 0, z: 0 },
  };
  return { player, actual, activities };
}

describe('authoritative player activities', () => {
  it('keeps stationary activities indefinitely, then starts one nonextendable movement deadline', () => {
    const { player, actual, activities } = fixture();
    expect(activities.react(player, 'hello', 1).ok).toBe(true);
    expect(activities.animate(player, actual, NEUTRAL_INPUT, 'wave', 1).ok).toBe(true);
    expect(activities.chat(player, 'Привет', 1).ok).toBe(true);
    updatePlayerActivities(player, actual, 10_000);
    expect([
      player.reactionExpiresAtTick,
      player.animationEndsAtTick,
      player.chatExpiresAtTick,
    ]).toEqual([0, 0, 0]);
    actual.velocity.x = 0.08;
    updatePlayerActivities(player, actual, 10_001);
    expect(player.animationEndsAtTick).toBe(0);
    actual.velocity.x = 4;
    updatePlayerActivities(player, actual, 10_002);
    const end = 10_002 + (WORLD_ACTIVITY_MOVE_DURATION_MS * TICK_RATE) / 1000;
    expect([
      player.reactionExpiresAtTick,
      player.animationEndsAtTick,
      player.chatExpiresAtTick,
    ]).toEqual([end, end, end]);
    actual.velocity.x = 0;
    updatePlayerActivities(player, actual, 10_100);
    actual.velocity.z = 4;
    updatePlayerActivities(player, actual, end - 1);
    expect(player.animationEndsAtTick).toBe(end);
    expect(player.animationId).toBe('wave');
    updatePlayerActivities(player, actual, end);
    expect([player.reactionId, player.animationId, player.chatText]).toEqual(['', '', '']);
    expect([player.reactionExpiresAtTick, player.chatExpiresAtTick]).toEqual([0, 0]);
    expect(player.animationChangedAtTick).toBe(end);
    expect(player.animationSequence).toBe(1);
  });

  it('keeps selection cooldowns independent and limits replacements until movement expiry', () => {
    const { player, actual, activities } = fixture();
    expect(activities.react(player, 'hello', 0)).toEqual({ ok: true, retryAfterMs: 3000 });
    expect(activities.react(player, 'love', 1)).toEqual({
      ok: false,
      code: 'RATE_LIMITED',
      retryAfterMs: 2984,
    });
    expect(activities.chat(player, 'Привет', 1)).toEqual({ ok: true, retryAfterMs: 5000 });
    expect(activities.animate(player, actual, NEUTRAL_INPUT, 'wave', 1)).toEqual({ ok: true });
    expect(activities.react(player, 'love', 180).ok).toBe(true);
    actual.velocity.x = 4;
    updatePlayerActivities(player, actual, 181);
    expect(activities.react(player, 'hello', 400)).toEqual({
      ok: false,
      code: 'RATE_LIMITED',
      retryAfterMs: 1350,
    });
    expect(activities.chat(player, 'Ещё', 400)).toEqual({
      ok: false,
      code: 'RATE_LIMITED',
      retryAfterMs: 1350,
    });
    updatePlayerActivities(player, actual, 481);
    expect(activities.react(player, 'hello', 481).ok).toBe(true);
    expect(activities.chat(player, 'Ещё', 481).ok).toBe(true);
  });

  it('distinguishes animation interruptions from natural completion at the same tick', () => {
    const { player, actual, activities } = fixture();
    activities.animate(player, actual, NEUTRAL_INPUT, 'dance', 5);
    cancelAnimation(player, 10);
    expect([player.animationId, player.animationSequence, player.animationChangedAtTick]).toEqual([
      '',
      2,
      10,
    ]);
    cancelAnimation(player, 11);
    expect(player.animationSequence).toBe(2);
    activities.animate(player, actual, NEUTRAL_INPUT, 'wave', 12);
    actual.velocity.x = 1;
    updatePlayerActivities(player, actual, 13);
    const end = player.animationEndsAtTick;
    cancelAnimation(player, end);
    expect(player.animationSequence).toBe(3);
    expect(player.animationChangedAtTick).toBe(end);
  });

  it('interrupts animation on airborne movement or a physics revision, leaving speech and reaction intact', () => {
    for (const reason of ['airborne', 'revision']) {
      const { player, actual, activities } = fixture();
      activities.animate(player, actual, NEUTRAL_INPUT, 'wave', 0);
      activities.react(player, 'hello', 0);
      activities.chat(player, 'Текст', 0);
      if (reason === 'airborne') actual.grounded = false;
      else actual.revision++;
      updatePlayerActivities(player, actual, 1);
      expect(player.animationId).toBe('');
      expect(player.animationSequence).toBe(2);
      expect(player.reactionId).toBe('hello');
      expect(player.chatText).toBe('Текст');
    }
  });

  it('requires a stationary grounded supported character for full-body clips while allowing moving gestures', () => {
    const { player, actual, activities } = fixture();
    expect(activities.animate(player, actual, { moveX: 1, moveZ: 0 }, 'dance', 1).code).toBe(
      'ANIMATION_NOT_ALLOWED',
    );
    actual.velocity.x = 4;
    expect(activities.animate(player, actual, NEUTRAL_INPUT, 'dance', 1).code).toBe(
      'ANIMATION_NOT_ALLOWED',
    );
    expect(activities.animate(player, actual, NEUTRAL_INPUT, 'wave', 1).ok).toBe(true);
    cancelAnimation(player, 2);
    actual.grounded = false;
    expect(activities.animate(player, actual, NEUTRAL_INPUT, 'wave', 2).code).toBe(
      'ANIMATION_NOT_ALLOWED',
    );
    actual.grounded = true;
    player.skinId = 'unsupported';
    expect(activities.animate(player, actual, NEUTRAL_INPUT, 'wave', 2).code).toBe(
      'ANIMATION_NOT_ALLOWED',
    );
  });

  it('does not mutate state when admission or payload fails, and acknowledgements contain no speech', () => {
    const { player, actual, activities } = fixture();
    expect(activities.react(player, 'hello', 0, 'STALE_WORLD')).toEqual({
      ok: false,
      code: 'STALE_WORLD',
    });
    expect(activities.chat(player, 'Привет', 0, 'WORLD_NOT_READY')).toEqual({
      ok: false,
      code: 'WORLD_NOT_READY',
    });
    expect(activities.animate(player, actual, NEUTRAL_INPUT, 'wave', 0, 'STALE_WORLD')).toEqual({
      ok: false,
      code: 'STALE_WORLD',
    });
    expect(activities.react(player, 'missing', 0).code).toBe('INVALID_INPUT');
    expect(activities.chat(player, undefined, 0).code).toBe('INVALID_INPUT');
    expect(activities.animate(player, actual, NEUTRAL_INPUT, 'missing', 0).code).toBe(
      'INVALID_INPUT',
    );
    expect([player.reactionSequence, player.chatSequence, player.animationSequence]).toEqual([
      0, 0, 0,
    ]);
    expect(JSON.stringify(activities.chat(player, 'Привет', 1))).not.toContain('Привет');
  });

  it('expires activities even if a physics snapshot has no player', () => {
    const { player, actual, activities } = fixture();
    activities.animate(player, actual, NEUTRAL_INPUT, 'wave', 0);
    activities.react(player, 'hello', 0);
    activities.chat(player, 'Привет', 0);
    actual.velocity.x = 1;
    updatePlayerActivities(player, actual, 1);
    updatePlayerActivities(player, undefined, 301);
    expect([player.reactionId, player.animationId, player.chatText]).toEqual(['', '', '']);
  });
});
