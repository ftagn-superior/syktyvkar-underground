import { describe, expect, it } from 'vitest';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import {
  CameraTurn,
  INITIAL_CAMERA_ANGLE,
  screenMovement,
  orthographicFrame,
} from './camera-controller';
import { OcclusionFade, orthographicSightRay } from './occlusion';

describe('orthographic camera controls', () => {
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
  it('keeps the visible dynamic ground footprint within 80m on landscape, portrait and ultrawide windows', () => {
    for (const aspect of [1920 / 1080, 360 / 800, 2560 / 1080, 3840 / 720]) {
      const { halfWidth, halfHeight } = orthographicFrame(aspect);
      expect(halfWidth / halfHeight).toBeCloseTo(aspect);
      const beta = Math.PI / 3.15;
      const groundDepth = halfHeight / Math.cos(beta) + 2 * Math.tan(beta);
      expect(Math.hypot(halfWidth, groundDepth)).toBeLessThan(80);
    }
    expect(orthographicFrame(1920 / 1080).halfHeight).toBe(15);
    expect(orthographicFrame(360 / 800).halfHeight).toBe(20);
  });
  it('completes a smooth full circuit and bounds rapid repeated turns', () => {
    const camera = new CameraTurn();
    camera.rotate(1);
    camera.advance(0.14);
    expect(camera.angle).toBeCloseTo(INITIAL_CAMERA_ANGLE + Math.PI / 4);
    camera.rotate(1);
    camera.advance(0.14);
    expect(camera.turning).toBe(false);
    expect(camera.angle).toBeCloseTo(INITIAL_CAMERA_ANGLE + Math.PI / 2);
    for (let i = 0; i < 3; i++) {
      camera.rotate(1);
      camera.advance(1);
    }
    expect(camera.angle).toBeCloseTo(INITIAL_CAMERA_ANGLE);
    camera.rotate(-1);
    camera.advance(1);
    expect(camera.angle).toBeCloseTo(-Math.PI / 4);
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
