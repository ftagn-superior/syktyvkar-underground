import { describe, expect, it } from 'vitest';
import { CharacterAnimator, type AvatarMotion } from './character-animator';
import { ANIMATION_CLIPS } from './animation-clips';
import type { AnimationId } from '@su/contracts';

function frame(): AvatarMotion {
  return {
    position: { x: 0, y: 0.915, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    velocity: { x: 0, y: 0, z: 0 },
    grounded: true,
    revision: 0,
    motionRevision: 0,
    motionEnabled: true,
    connected: true,
  };
}

function advance(
  animator: CharacterAnimator,
  input: AvatarMotion,
  seconds: number,
  { fps = 60, predicted = true, reduced = false } = {},
) {
  for (let step = 0; step < Math.round(seconds * fps); step++) {
    input.position.x += input.velocity.x / fps;
    input.position.z += input.velocity.z / fps;
    animator.update(input, 1 / fps, predicted, reduced);
  }
}

describe('character animation from displayed motion', () => {
  const playback = (id: AnimationId, tick = 60) => ({
    worldEpoch: 'epoch',
    animationId: id,
    sequence: 1,
    startedAtTick: 0,
    endsAtTick: id === 'dance' ? 300 : 180,
    changedAtTick: 0,
    displayTick: tick,
  });

  it.each(['wave', 'clap'] as const)('keeps unmasked locomotion under %s', (id) => {
    const base = new CharacterAnimator(4, 14),
      selected = new CharacterAnimator(4, 14);
    const input = frame();
    input.velocity.z = 4;
    advance(base, input, 1);
    const other = frame();
    other.velocity.z = 4;
    other.animation = playback(id);
    advance(selected, other, 1);
    expect(selected.pose.leftLeg).toBeCloseTo(base.pose.leftLeg);
    expect(selected.pose.rightLeg).toBeCloseTo(base.pose.rightLeg);
    if (id === 'wave') expect(selected.pose.leftArm).toBeCloseTo(base.pose.leftArm);
    expect(selected.pose.rightArmRoll).not.toBeCloseTo(base.pose.rightArmRoll);
  });
  it('uses absolute phase at all frame rates, survives motion resets, and expires without a patch', () => {
    const poses = [30, 60, 120].map((fps) => {
      const animator = new CharacterAnimator(4, 14),
        input = frame();
      input.animation = playback('dance', 0);
      for (let i = 0; i <= fps; i++) {
        input.animation.displayTick = (i * 60) / fps;
        animator.update(input, 1 / fps, true);
      }
      const pose = { ...animator.pose };
      input.motionRevision++;
      animator.resetMotion();
      animator.update(input, 10, true);
      expect(animator.pose).toEqual(pose);
      input.animation.displayTick = 305;
      animator.update(input, 4, true);
      expect(animator.diagnostics().animation.reason).toBe('expired');
      expect(animator.pose.rightArm).toBeCloseTo(0);
      return pose;
    });
    expect(poses[0]).toEqual(poses[1]);
    expect(poses[1]).toEqual(poses[2]);
  });
  it.each(['wave', 'clap', 'dance'] as const)(
    'cycles %s indefinitely until a movement deadline, with falling priority',
    (id) => {
      const animator = new CharacterAnimator(4, 14),
        input = frame();
      input.animation = { ...playback(id, 600), endsAtTick: 0 };
      animator.update(input, 1 / 60, true);
      const before = { ...animator.pose };
      expect(animator.diagnostics().animation.reason).toBe('playing');
      expect(animator.diagnostics().animation.weight).toBe(1);
      input.animation.displayTick = 610;
      animator.update(input, 1 / 60, true);
      expect(animator.pose).not.toEqual(before);
      input.velocity.x = 4;
      input.animation.endsAtTick = 910;
      animator.update(input, 1 / 60, true);
      expect(animator.diagnostics().animation.reason).toBe('playing');
      expect(animator.diagnostics().animation.weight).toBe(1);
      input.velocity.x = 0;
      input.animation.displayTick = 900;
      animator.update(input, 1 / 60, true);
      expect(animator.diagnostics().animation.reason).toBe('playing');
      input.grounded = false;
      animator.update(input, 1 / 60, true);
      expect(animator.diagnostics().animation.weight).toBe(0);
      input.grounded = true;
      input.animation.displayTick = 911;
      animator.update(input, 1 / 60, true);
      expect(animator.diagnostics().animation.reason).toBe('expired');
    },
  );
  it('fades cancellation into the current base and allows another clip during the fade', () => {
    const animator = new CharacterAnimator(4, 14),
      input = frame();
    input.animation = playback('wave');
    animator.update(input, 1 / 60, true);
    const arm = animator.pose.rightArmRoll;
    input.animation = { ...input.animation, animationId: null, sequence: 2, changedAtTick: 60 };
    animator.update(input, 1 / 60, true);
    expect(animator.pose.rightArmRoll).toBe(arm);
    input.animation.displayTick = 63;
    animator.update(input, 1 / 60, true);
    expect(animator.pose.rightArmRoll).toBeGreaterThan(0.1);
    const mid = animator.pose.rightArmRoll;
    input.animation = { ...playback('clap', 63), sequence: 3, startedAtTick: 63 };
    animator.update(input, 1 / 60, true);
    expect(animator.pose.rightArmRoll).toBe(mid);
    input.animation.displayTick = 80;
    animator.update(input, 1 / 60, true);
    expect(animator.pose.rightArm).toBeCloseTo(-Math.PI / 2);
  });
  it('finishes a decorative cancellation while the simulation tick is paused', () => {
    const animator = new CharacterAnimator(4, 14),
      input = frame();
    input.animation = { ...playback('wave'), displayTimeMs: 1000 };
    animator.update(input, 1 / 60, true);
    input.animation = { ...input.animation, animationId: null, sequence: 2 };
    animator.update(input, 1 / 60, true);
    expect(animator.pose.rightArmRoll).toBeGreaterThan(1);
    input.animation.displayTimeMs = 1150;
    animator.update(input, 1 / 60, true);
    expect(animator.pose.rightArmRoll).toBeCloseTo(0.1);
  });
  it('reduces body motion, diagnoses unavailable clips, and joins their current phase when restored', () => {
    const animator = new CharacterAnimator(4, 14),
      input = frame();
    input.animation = playback('dance', 72);
    animator.update(input, 1 / 60, true);
    const normal = { ...animator.pose };
    animator.update(input, 1 / 60, true, true);
    expect(Math.abs(animator.pose.roll)).toBeLessThan(Math.abs(normal.roll));
    expect(animator.pose.rightArm).toBe(normal.rightArm);
    const clip = ANIMATION_CLIPS.dance;
    try {
      delete (ANIMATION_CLIPS as Partial<typeof ANIMATION_CLIPS>).dance;
      animator.update(input, 1 / 60, true);
      expect(animator.diagnostics().animation.reason).toBe('missing-clip');
      expect(animator.pose.rightArm).toBeCloseTo(0);
    } finally {
      ANIMATION_CLIPS.dance = clip;
    }
    animator.update(input, 1 / 60, true);
    expect(animator.diagnostics().animation.elapsedMs).toBe(1200);
  });
  it('walks with opposing limbs, runs with a larger swing, and settles when physically blocked', () => {
    const animator = new CharacterAnimator(4, 14);
    const input = frame();
    animator.update(input, 1 / 60, true);
    input.velocity.z = 4;
    advance(animator, input, 1);
    const walk = animator.diagnostics();
    expect(walk.mode).toBe('walk');
    expect(walk.movement).toBeGreaterThan(0.99);
    expect(walk.pose.leftLeg).toBeCloseTo(-walk.pose.rightLeg);
    expect(walk.pose.leftArm * walk.pose.rightLeg).toBeGreaterThan(0);
    input.velocity.z = 14;
    advance(animator, input, 1);
    expect(animator.diagnostics().mode).toBe('run');
    expect(animator.diagnostics().running).toBeGreaterThan(0.99);
    expect(animator.pose.lean).toBeGreaterThan(walk.pose.lean);
    input.velocity.z = 0;
    advance(animator, input, 1);
    expect(animator.diagnostics().mode).toBe('idle');
    expect(animator.diagnostics().movement).toBeLessThan(0.001);
    expect(Math.abs(animator.pose.leftLeg)).toBeLessThan(0.001);
  });

  it('uses interpolated displacement for observers and physical velocity for the local player', () => {
    const local = new CharacterAnimator(4, 14);
    const remote = new CharacterAnimator(4, 14);
    const input = frame();
    input.velocity.z = 4;
    for (let step = 0; step < 60; step++) {
      // A stale velocity alone must not animate a stationary remote entity.
      local.update(input, 1 / 60, true);
      remote.update(input, 1 / 60, false);
    }
    expect(local.diagnostics().mode).toBe('walk');
    expect(remote.diagnostics().mode).toBe('idle');
    input.velocity.z = 0;
    for (let step = 0; step < 60; step++) {
      input.position.z += 4 / 60;
      local.update(input, 1 / 60, true);
      remote.update(input, 1 / 60, false);
    }
    expect(local.diagnostics().mode).toBe('idle');
    expect(remote.diagnostics().mode).toBe('walk');
  });

  it.each(['revision', 'motionRevision', 'teleport', 'long-frame', 'visibility'] as const)(
    'discards displacement and phase on %s instead of treating it as a sprint',
    (reset) => {
      const animator = new CharacterAnimator(4, 14);
      const input = frame();
      input.velocity.z = 4;
      advance(animator, input, 1, { predicted: false });
      input.velocity.z = 0;
      if (reset === 'revision' || reset === 'motionRevision') input[reset]++;
      if (reset === 'teleport') input.position.x += 10;
      if (reset === 'visibility') animator.resetMotion();
      animator.update(input, reset === 'long-frame' ? 10 : 1 / 60, false);
      expect(animator.diagnostics().phase).toBe(0);
      expect(animator.diagnostics().movement).toBe(0);
      expect(animator.pose.leftLeg).toBe(0);
    },
  );

  it('keeps the same cadence at 30, 60 and 120 FPS, with a bounded sprint frequency', () => {
    const cadences = [30, 60, 120].map((fps) => {
      const animator = new CharacterAnimator(4, 14);
      const input = frame();
      input.velocity.z = 14;
      advance(animator, input, 2, { fps });
      let cycles = 0;
      let previous = animator.diagnostics().phase;
      for (let step = 0; step < fps; step++) {
        advance(animator, input, 1 / fps, { fps });
        const next = animator.diagnostics().phase;
        cycles += ((next - previous + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2);
        previous = next;
      }
      return cycles;
    });
    for (const cadence of cadences) {
      expect(cadence).toBeGreaterThan(2);
      expect(cadence).toBeLessThan(3);
      expect(cadence).toBeCloseTo(cadences[0], 4);
    }
  });

  it('holds a falling pose without cycling, suppresses secondary motion, and stops while disconnected', () => {
    const animator = new CharacterAnimator(4, 14);
    const input = frame();
    input.velocity.z = 4;
    advance(animator, input, 1);
    input.grounded = false;
    advance(animator, input, 1);
    const fall = animator.diagnostics();
    advance(animator, input, 1);
    expect(animator.diagnostics().phase).toBe(fall.phase);
    expect(animator.diagnostics().mode).toBe('airborne');
    expect(animator.pose.rightArmRoll).toBeGreaterThan(0.6);
    expect(animator.pose.leftLeg).toBeCloseTo(animator.pose.rightLeg, 4);
    input.grounded = true;
    advance(animator, input, 1, { reduced: true });
    expect(animator.pose.lift).toBe(0);
    expect(animator.pose.roll).toBe(0);
    expect(animator.diagnostics().movement).toBeGreaterThan(0.99);
    input.connected = false;
    advance(animator, input, 1);
    expect(animator.diagnostics().mode).toBe('idle');
    expect(animator.diagnostics().movement).toBeLessThan(0.001);
  });

  it('turns through the shortest arc across the quaternion wraparound', () => {
    const animator = new CharacterAnimator(4, 14);
    const input = frame();
    const turn = (yaw: number) => {
      input.rotation = { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
    };
    turn(Math.PI - 0.02);
    animator.update(input, 1 / 60, true);
    turn(-Math.PI + 0.02);
    animator.update(input, 1 / 60, true);
    expect(Math.abs(animator.pose.facingOffset)).toBeLessThan(0.04);
    advance(animator, input, 1);
    expect(animator.pose.facingOffset).toBeCloseTo(0, 5);
  });
});
