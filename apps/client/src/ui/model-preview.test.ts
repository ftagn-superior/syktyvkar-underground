import { describe, expect, it } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { ModelPreview } from './model-preview';

const methods = ModelPreview.prototype as unknown as {
  fit: (this: unknown) => void;
  reset: (this: unknown) => void;
};

describe('model preview camera framing', () => {
  it('keeps an oblique view when changing the target and fits tall trees and wide fences completely', () => {
    const engine = new NullEngine({
      renderWidth: 320,
      renderHeight: 250,
      textureSize: 256,
      deterministicLockstep: false,
      lockstepMaxSteps: 4,
    });
    const scene = new Scene(engine);
    const camera = new ArcRotateCamera('preview', 0, 0, 1, Vector3.Zero(), scene);
    camera.fov = 0.65;
    try {
      for (const bounds of [
        { min: { x: -2, y: 0, z: -2 }, max: { x: 2, y: 15, z: 2 } },
        { min: { x: -4, y: 0, z: -0.05 }, max: { x: 4, y: 1, z: 0.05 } },
      ]) {
        const preview = {
          camera,
          bounds,
          disposed: false,
          canvas: { clientWidth: 320, clientHeight: 250 },
          fit: methods.fit,
        };
        methods.reset.call(preview);
        camera.getViewMatrix(true);
        const offset = camera.position.subtract(camera.getTarget());
        // The original bug reset beta to a pole as setTarget rebuilt the orbit.
        expect(Math.hypot(offset.x, offset.z)).toBeGreaterThan(offset.length() * 0.8);
        scene.render();
        for (const x of [bounds.min.x, bounds.max.x])
          for (const y of [bounds.min.y, bounds.max.y])
            for (const z of [bounds.min.z, bounds.max.z]) {
              const pixel = Vector3.Project(
                new Vector3(x, y, z),
                Matrix.Identity(),
                scene.getTransformMatrix(),
                camera.viewport.toGlobal(320, 250),
              );
              expect(pixel.x).toBeGreaterThan(0);
              expect(pixel.x).toBeLessThan(320);
              expect(pixel.y).toBeGreaterThan(0);
              expect(pixel.y).toBeLessThan(250);
            }
        camera.alpha += 0.4;
        camera.beta -= 0.2;
        const orbit = [camera.alpha, camera.beta];
        methods.fit.call(preview);
        expect([camera.alpha, camera.beta]).toEqual(orbit);
      }
    } finally {
      scene.dispose();
      engine.dispose();
    }
  });
});
