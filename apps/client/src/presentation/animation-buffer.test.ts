import { describe, expect, it } from 'vitest';
import { AnimationBuffer, type AnimationSource } from './animation-buffer';

const source = (): AnimationSource => ({
  entityId: 'p',
  revision: 0,
  grounded: true,
  animationId: '',
  animationSequence: 0,
  animationStartedAtTick: 0,
  animationEndsAtTick: 0,
  animationChangedAtTick: 0,
});
describe('animation presentation timeline', () => {
  it('applies a movement deadline on the delayed timeline without restarting the clip', () => {
    const buffer = new AnimationBuffer(),
      player = source();
    Object.assign(player, {
      animationId: 'wave',
      animationSequence: 1,
      animationStartedAtTick: 20,
      animationChangedAtTick: 20,
    });
    buffer.capture('epoch', 600, 10000, [player], false);
    Object.assign(player, { animationEndsAtTick: 903, animationChangedAtTick: 603 });
    buffer.capture('epoch', 606, 10100, [player], false);
    expect(buffer.sample('p', 10025)!.animation.endsAtTick).toBe(0);
    const after = buffer.sample('p', 10075)!.animation;
    expect(after.endsAtTick).toBe(903);
    expect(after.sequence).toBe(1);
    expect(after.startedAtTick).toBe(20);
    expect(after.displayTick).toBeCloseTo(604.5);
  });
  it('holds multiple transitions and support on the delayed position timeline', () => {
    const buffer = new AnimationBuffer(),
      player = source();
    buffer.capture('epoch', 60, 1000, [player], false);
    Object.assign(player, {
      animationId: 'wave',
      animationSequence: 1,
      animationStartedAtTick: 62,
      animationEndsAtTick: 242,
      animationChangedAtTick: 62,
    });
    buffer.capture('epoch', 63, 1050, [player], false);
    Object.assign(player, {
      grounded: false,
      animationId: '',
      animationSequence: 2,
      animationChangedAtTick: 66,
    });
    buffer.capture('epoch', 66, 1100, [player], false);
    expect(buffer.sample('p', 1020)!.animation.animationId).toBe(null);
    const during = buffer.sample('p', 1075)!;
    expect(during.grounded).toBe(true);
    expect(during.animation.animationId).toBe('wave');
    expect(during.animation.displayTick).toBeCloseTo(64.5);
    expect(buffer.sample('p', 1100)!.grounded).toBe(false);
    expect(buffer.sample('p', 1100)!.animation.animationId).toBe(null);
  });
  it('anchors ticks to snapshots through pauses instead of room uptime', () => {
    const buffer = new AnimationBuffer(),
      player = source();
    buffer.capture('epoch', 60, 9000, [player], true);
    expect(buffer.sample('p', 10000)!.animation.displayTick).toBe(60);
    buffer.capture('epoch', 63, 11000, [player], false);
    expect(buffer.sample('p', 11050)!.animation.displayTick).toBeCloseTo(66);
  });
  it('starts late observers at the current phase and resets identity and removed entities', () => {
    const buffer = new AnimationBuffer(),
      player = source();
    Object.assign(player, {
      animationId: 'dance',
      animationSequence: 1,
      animationStartedAtTick: 20,
      animationEndsAtTick: 320,
      animationChangedAtTick: 20,
    });
    buffer.capture('epoch', 120, 5000, [player], false);
    expect(buffer.sample('p', 5050)!.animation.displayTick).toBeCloseTo(123);
    player.revision++;
    player.animationId = '';
    buffer.capture('epoch', 121, 5050, [player], false);
    expect(buffer.sample('p', 4950)!.animation.animationId).toBe(null);
    buffer.capture('new', 0, 50, [player], false);
    expect(buffer.sample('p', 50)!.animation.worldEpoch).toBe('new');
    for (let i = 0; i < 200; i++) buffer.capture('new', i, 50 + i * 50, [player], false);
    buffer.capture('new', 201, 10100, [], false);
    expect(buffer.size).toBe(0);
    expect(buffer.sample('p', 10100)).toBeUndefined();
  });
});
