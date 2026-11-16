import { describe, expect, it } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera';
import { Camera } from '@babylonjs/core/Cameras/camera';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Bounds } from '@su/contracts';
import { WorldView } from './world-view';
import { graphicsLevel } from '../streaming/graphics-plan';

const bounds = (x: number, y = 0, z = 0): Bounds => ({
  min: { x, y: y - 1, z: z - 1 },
  max: { x: x + 4, y: y + 1, z: z + 1 },
});

function fixture() {
  const engine = new NullEngine(),
    scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  const camera = new FreeCamera('overview', new Vector3(0, 0, 10), scene),
    eyeCamera = new FreeCamera('first-person', new Vector3(0, 0, 10), scene);
  camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
  camera.orthoLeft = camera.orthoBottom = -10;
  camera.orthoRight = camera.orthoTop = 10;
  for (const c of [camera, eyeCamera]) {
    c.setTarget(Vector3.Zero());
    c.minZ = 0.1;
    c.maxZ = 500;
  }
  eyeCamera.fov = Math.PI / 2;
  const canvas = { clientWidth: 800, clientHeight: 600 };
  const view = Object.create(WorldView.prototype) as WorldView;
  Object.assign(view, {
    camera,
    eyeCamera,
    canvas,
    scene,
    target: Vector3.Zero(),
    firstPerson: false,
    lastFrame: 1,
    graphicsBoxes: new WeakMap(),
    graphicsIds: new WeakMap(),
    placementPins: 0,
    editorRayUntil: 0,
  });
  return {
    view,
    camera,
    eyeCamera,
    canvas,
    perspective: (enabled: boolean) => Object.assign(view, { firstPerson: enabled }),
    dispose: () => {
      scene.dispose();
      engine.dispose();
    },
  };
}

describe('camera coverage for graphical streaming', () => {
  it('does not force near LOD when an orthographic group crosses the camera near plane', () => {
    const f = fixture();
    try {
      const crossing: Bounds = {
        min: { x: -0.5, y: -1, z: 9 },
        max: { x: 0.5, y: 1, z: 11 },
      };
      const projection = f.view.projectGraphicsGroup(crossing);
      expect(projection.visible).toBe(true);
      expect(projection.nearPlane).toBe(false);
      expect(projection.pixels).toBeGreaterThan(0);
      expect(projection.pixels).toBeLessThan(240);
      expect(graphicsLevel(crossing, projection, [], 'near')).toBe('far');
    } finally {
      f.dispose();
    }
  });

  it('keeps perspective near-plane crossings conservative without projecting behind the eye', () => {
    const f = fixture();
    try {
      f.perspective(true);
      const crossing: Bounds = {
        min: { x: -1, y: -1, z: 9 },
        max: { x: 1, y: 1, z: 11 },
      };
      const projection = f.view.projectGraphicsGroup(crossing);
      expect(projection.visible).toBe(true);
      expect(projection.nearPlane).toBe(true);
      expect(Number.isFinite(projection.pixels)).toBe(true);
      expect(graphicsLevel(crossing, projection, [], 'far')).toBe('near');
    } finally {
      f.dispose();
    }
  });

  it('preloads the first-person ring behind the eye while respecting its distance limit', () => {
    const f = fixture();
    try {
      f.perspective(true);
      const behind = bounds(0, 0, 40);
      expect(f.view.isGraphicsVisible(behind)).toBe(false);
      expect(f.view.isGraphicsVisible(behind, 125)).toBe(true);
      expect(f.view.isGraphicsVisible(bounds(400), 125)).toBe(false);
    } finally {
      f.dispose();
    }
  });

  it('uses complete bounds and fixed world X/Z guards without inflating the vertical extent', () => {
    const f = fixture();
    try {
      expect(f.view.isGraphicsVisible(bounds(8))).toBe(true);
      expect(f.view.isGraphicsVisible(bounds(134))).toBe(false);
      expect(f.view.isGraphicsVisible(bounds(134), 125)).toBe(true);
      expect(f.view.isGraphicsVisible(bounds(136), 125)).toBe(false);
      expect(f.view.isGraphicsVisible(bounds(259), 250)).toBe(true);
      expect(f.view.isGraphicsVisible(bounds(261), 250)).toBe(false);
      expect(f.view.isGraphicsVisible(bounds(0, 136), 250)).toBe(false);
      const partlyVisible = bounds(-30);
      partlyVisible.max.x = -8;
      expect(f.view.isGraphicsVisible(partlyVisible)).toBe(true);
      expect(f.view.projectGraphicsGroup(partlyVisible).visible).toBe(true);
    } finally {
      f.dispose();
    }
  });

  it('refreshes the shared camera frame after same-frame movement, projection changes and view switches', () => {
    const f = fixture();
    try {
      const origin = bounds(0),
        west = bounds(-200),
        distant = bounds(50, 0, -90);
      expect(f.view.isGraphicsVisible(origin)).toBe(true);
      expect(f.view.isGraphicsVisible(west)).toBe(false);
      f.camera.position.x = -200;
      f.camera.setTarget(new Vector3(-200, 0, 0));
      expect(f.view.isGraphicsVisible(origin)).toBe(false);
      expect(f.view.isGraphicsVisible(west)).toBe(true);
      f.camera.orthoRight = 250;
      expect(f.view.isGraphicsVisible(origin)).toBe(true);
      expect(f.view.projectGraphicsGroup(origin).visible).toBe(true);

      f.camera.orthoRight = 10;
      expect(f.view.isGraphicsVisible(distant)).toBe(false);
      f.perspective(true);
      expect(f.view.isGraphicsVisible(distant)).toBe(true);
      const initialPixels = f.view.projectGraphicsGroup(distant).pixels;
      f.canvas.clientWidth *= 2;
      expect(f.view.projectGraphicsGroup(distant).pixels).toBeCloseTo(initialPixels * 2);
      f.perspective(false);
      expect(f.view.isGraphicsVisible(distant)).toBe(false);
    } finally {
      f.dispose();
    }
  });
});
