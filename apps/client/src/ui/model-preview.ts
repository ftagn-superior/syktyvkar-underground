import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import type { BuildingAssetManifest, Bounds } from '@su/contracts';
import {
  createModelVisual,
  type ModelResourceReader,
  type ModelVisual,
} from '../rendering/model-visual';

/** One small engine per visible catalog, reusing its scene when the selection changes. */
export class ModelPreview {
  private readonly engine: Engine;
  private readonly scene: Scene;
  private readonly camera: ArcRotateCamera;
  private readonly resizeObserver: ResizeObserver;
  private readonly listeners = new AbortController();
  private visual?: ModelVisual;
  private bounds?: Bounds;
  private generation = 0;
  private dragging?: { pointer: number; x: number; y: number };
  private disposed = false;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.engine = new Engine(canvas, true, { antialias: true, alpha: true, stencil: false });
    this.engine.setHardwareScalingLevel(1 / Math.min(1.5, window.devicePixelRatio || 1));
    this.scene = new Scene(this.engine);
    this.scene.useRightHandedSystem = true;
    this.scene.clearColor = new Color4(0, 0, 0, 0);
    this.camera = new ArcRotateCamera('model-preview-camera', 0, 0, 1, Vector3.Zero(), this.scene);
    this.camera.inputs.clear();
    this.camera.fov = 0.65;
    this.camera.minZ = 0.01;
    const sky = new HemisphericLight('model-preview-sky', new Vector3(0, 1, 0), this.scene);
    sky.intensity = 0.9;
    sky.diffuse = Color3.FromHexString('#d5e7ee');
    sky.groundColor = Color3.FromHexString('#2b3640');
    const sun = new DirectionalLight('model-preview-sun', new Vector3(-0.5, -1, -0.8), this.scene);
    sun.intensity = 1.1;
    const options = { signal: this.listeners.signal };
    canvas.addEventListener(
      'pointerdown',
      (event) => {
        this.dragging = { pointer: event.pointerId, x: event.clientX, y: event.clientY };
        canvas.setPointerCapture(event.pointerId);
      },
      options,
    );
    canvas.addEventListener(
      'pointermove',
      (event) => {
        if (this.dragging?.pointer !== event.pointerId) return;
        this.camera.alpha -= (event.clientX - this.dragging.x) * 0.012;
        this.camera.beta = Math.max(
          0.2,
          Math.min(Math.PI - 0.2, this.camera.beta - (event.clientY - this.dragging.y) * 0.008),
        );
        this.dragging.x = event.clientX;
        this.dragging.y = event.clientY;
      },
      options,
    );
    const release = () => {
      this.dragging = undefined;
    };
    canvas.addEventListener('pointerup', release, options);
    canvas.addEventListener('pointercancel', release, options);
    this.resizeObserver = new ResizeObserver(() => {
      this.engine.resize();
      this.fit();
    });
    this.resizeObserver.observe(canvas);
    this.engine.runRenderLoop(() => {
      if (!document.hidden && canvas.isConnected && !canvas.hidden && this.visual)
        this.scene.render();
    });
  }
  async select(descriptor: BuildingAssetManifest, read: ModelResourceReader, signal: AbortSignal) {
    this.clear();
    const generation = this.generation;
    const visual = await createModelVisual(this.scene, descriptor, read, 'catalog-preview', signal);
    if (generation !== this.generation || this.disposed || signal.aborted) {
      visual.dispose();
      signal.throwIfAborted();
      return;
    }
    this.visual = visual;
    this.bounds = descriptor.bounds;
    this.reset();
  }
  clear() {
    this.generation++;
    this.visual?.dispose();
    this.visual = undefined;
    this.bounds = undefined;
    // Remove the old framebuffer while the next selected model is loading.
    if (!this.disposed && !this.scene.isDisposed) this.scene.render();
  }
  rotate(direction = 1) {
    this.camera.alpha += (direction * Math.PI) / 8;
  }
  reset() {
    this.camera.alpha = Math.PI / 2 + Math.PI / 5;
    this.camera.beta = Math.PI / 2.5;
    this.fit();
  }
  private fit() {
    if (!this.bounds || this.disposed) return;
    const { min, max } = this.bounds;
    this.camera.setTarget(
      new Vector3((min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2),
      false,
      false,
      true,
    );
    const radius = Math.hypot(max.x - min.x, max.y - min.y, max.z - min.z) / 2;
    const aspect = Math.max(0.1, this.canvas.clientWidth / Math.max(1, this.canvas.clientHeight));
    const halfFov = Math.min(
      this.camera.fov / 2,
      Math.atan(Math.tan(this.camera.fov / 2) * aspect),
    );
    this.camera.radius = Math.max(0.1, (radius * 1.12) / Math.sin(halfFov));
    this.camera.maxZ = Math.max(100, this.camera.radius * 4);
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.clear();
    this.listeners.abort();
    this.resizeObserver.disconnect();
    this.engine.stopRenderLoop();
    this.scene.dispose();
    this.engine.dispose();
  }
}
