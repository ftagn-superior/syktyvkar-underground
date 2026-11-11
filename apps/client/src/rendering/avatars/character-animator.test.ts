import { describe, expect, it } from 'vitest';
import { CharacterAnimator, type AvatarMotion } from './character-animator';

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
    expect(animator.pose.armSpread).toBeGreaterThan(0.6);
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
