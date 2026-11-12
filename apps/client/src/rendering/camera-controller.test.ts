import { describe, expect, it } from 'vitest';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import {
  CameraOrbit,
  INITIAL_CAMERA_ANGLE,
  screenMovement,
  orthographicFrame,
  yawFromOrbit,
  orbitFromYaw,
  firstPersonMovement,
} from './camera-controller';
import { OcclusionFade, orthographicSightRay } from './occlusion';

describe('orthographic camera controls', () => {
  it('preserves the actual horizontal camera direction when switching both ways', () => {
    for (const alpha of [0, Math.PI / 4, -Math.PI, 2.1, -1.8]) {
      const yaw = yawFromOrbit(alpha);
      const input = firstPersonMovement(screenMovement(0, 1, orbitFromYaw(yaw)), yaw);
      expect(input.moveX).toBeCloseTo(Math.sin(yaw));
      expect(input.moveZ).toBeCloseTo(Math.cos(yaw));
      expect(Math.cos(orbitFromYaw(yaw) - alpha)).toBeCloseTo(1);
      expect(input.facingYaw).toBe(yaw);
    }
  });
  it('keeps screen directions at every quarter turn and during a transition, with normalized diagonals', () => {
    for (const angle of [0, Math.PI / 4, Math.PI / 2, Math.PI, -Math.PI / 2, 0.39]) {
      const up = screenMovement(0, 1, angle),
        right = screenMovement(1, 0, angle);
      expect(up.moveX).toBeCloseTo(-Math.cos(angle));
      expect(up.moveZ).toBeCloseTo(-Math.sin(angle));
      expect(right.moveX).toBeCloseTo(Math.sin(angle));
      expect(right.moveZ).toBeCloseTo(-Math.cos(angle));
      expect(up.moveX * right.moveX + up.moveZ * right.moveZ).toBeCloseTo(0);
      const diagonal = screenMovement(1, 1, angle);
      expect(Math.hypot(diagonal.moveX, diagonal.moveZ)).toBeCloseTo(1);
    }
  });
  it('preserves full zoom and aspect without a network radius cap', () => {
    for (const aspect of [1920 / 1080, 360 / 800, 3840 / 720]) {
      for (const zoom of [0.6, 1, 30]) {
        const { halfWidth, halfHeight } = orthographicFrame(aspect, zoom);
        expect(halfWidth / halfHeight).toBeCloseTo(aspect);
        expect(halfHeight).toBe((aspect < 1 ? 20 : 15) * zoom);
      }
    }
    expect(orthographicFrame(3840 / 720, 30).halfWidth).toBe(2400);
  });
  const settle = (camera: CameraOrbit) => {
    for (let i = 0; i < 90; i++) camera.advance(1 / 60);
    expect(camera.turning).toBe(false);
  };
  const angleDifference = (a: number, b: number) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

  it('settles at any requested mouse angle and accepts a reversal during smoothing', () => {
    const camera = new CameraOrbit();
    camera.rotateBy(0.39);
    const intermediate = camera.advance(1 / 60);
    expect(intermediate).toBeGreaterThan(INITIAL_CAMERA_ANGLE);
    expect(intermediate).toBeLessThan(INITIAL_CAMERA_ANGLE + 0.39);
    camera.rotateBy(-0.12);
    settle(camera);
    expect(camera.angle).toBeCloseTo(INITIAL_CAMERA_ANGLE + 0.27, 10);
    expect(camera.advance(1)).toBe(camera.angle);
  });
  it('orbits continuously while held and stops at the angle requested before release', () => {
    const camera = new CameraOrbit();
    camera.setDirection(1);
    for (let i = 0; i < 137; i++) camera.advance(1 / 60);
    expect(camera.turning).toBe(true);
    camera.setDirection(0);
    const released = camera.angle;
    settle(camera);
    const expected = INITIAL_CAMERA_ANGLE + ((137 / 60) * Math.PI) / 2;
    expect(angleDifference(camera.angle, expected)).toBeCloseTo(0, 10);
    expect(Math.abs(angleDifference(camera.angle, released))).toBeLessThan(0.08);
  });
  it('has the same orbit at 30, 60 and 144 fps, including direction changes', () => {
    const angles = [30, 60, 144].map((fps) => {
      const camera = new CameraOrbit();
      camera.setDirection(1);
      for (let i = 0; i < fps * 2; i++) camera.advance(1 / fps);
      camera.setDirection(-1);
      for (let i = 0; i < fps; i++) camera.advance(1 / fps);
      return camera.angle;
    });
    for (const angle of angles) expect(angleDifference(angle, angles[0])).toBeCloseTo(0, 10);
  });
  it('crosses the angle boundary smoothly in both directions over repeated full orbits', () => {
    for (const direction of [-1, 1] as const) {
      const camera = new CameraOrbit();
      camera.setDirection(direction);
      let traveled = 0;
      for (let i = 0; i < 60 * 12; i++) {
        const before = camera.angle;
        camera.advance(1 / 60);
        const change = angleDifference(camera.angle, before);
        expect(change * direction).toBeGreaterThan(0);
        expect(Math.abs(change)).toBeLessThan(0.03);
        traveled += change;
      }
      expect(Math.abs(traveled)).toBeGreaterThan(5 * Math.PI);
      camera.setDirection(0);
      settle(camera);
      expect(angleDifference(camera.angle, INITIAL_CAMERA_ANGLE)).toBeCloseTo(0, 10);
    }
  });
  it('cancels held input and pending mouse motion without resuming after a reset', () => {
    const camera = new CameraOrbit();
    camera.setDirection(1);
    camera.rotateBy(2);
    camera.advance(1 / 60);
    camera.stop();
    const stopped = camera.angle;
    settle(camera);
    expect(camera.angle).toBe(stopped);
  });
  it('bounds a stalled frame and does not move for zero or negative elapsed time', () => {
    const camera = new CameraOrbit();
    camera.setDirection(1);
    expect(camera.advance(-1)).toBe(INITIAL_CAMERA_ANGLE);
    expect(camera.advance(0)).toBe(INITIAL_CAMERA_ANGLE);
    expect(camera.advance(30) - INITIAL_CAMERA_ANGLE).toBeLessThan(Math.PI / 20);
  });
  it('casts parallel rays through off-centre samples from the camera near plane and stops before the player', () => {
    const camera = new Vector3(10, 10, 10);
    const direction = new Vector3(-1, -1, -1).normalize();
    const target = new Vector3(-3, 1, 8);
    const ray = orthographicSightRay(camera, direction, target, 0.1);
    expect(Vector3.Dot(ray.origin.subtract(camera), direction)).toBeCloseTo(0.1);
    expect(
      Vector3.Distance(ray.origin.add(ray.direction.scale(ray.length + 0.04)), target),
    ).toBeCloseTo(0);
    expect(ray.direction.equals(direction)).toBe(true);
    expect(ray.origin.equals(camera)).toBe(false);
    expect(orthographicSightRay(camera, direction, camera.subtract(direction), 0.1).length).toBe(0);
  });
  it('holds transparency across brief silhouette gaps then recovers smoothly', () => {
    const fade = new OcclusionFade();
    fade.update(true, 0, 0.1);
    const blockedOpacity = fade.opacity;
    expect(fade.update(false, 100, 0.1)).toBeLessThan(blockedOpacity);
    const heldOpacity = fade.opacity;
    expect(fade.update(false, 170, 0.1)).toBeGreaterThan(heldOpacity);
    for (let t = 200; t < 1500; t += 20) fade.update(false, t, 0.02);
    expect(fade.opacity).toBe(1);
  });
});
