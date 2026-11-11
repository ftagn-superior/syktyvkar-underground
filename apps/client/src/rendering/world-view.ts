import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { Camera } from '@babylonjs/core/Cameras/camera';
import { Vector3, Quaternion, Matrix } from '@babylonjs/core/Maths/math.vector';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import { SceneInstrumentation } from '@babylonjs/core/Instrumentation/sceneInstrumentation';
import '@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent';
import '@babylonjs/core/Rendering/edgesRenderer';
import {
  findReaction,
  REACTION_DURATION_MS,
  type DisplayReaction,
  type EntityState,
  type Vec3,
  type WorldDefinition,
  type WorldManifest,
} from '@su/contracts';
import { decorateWorld, obstacleAccent } from './world-decoration';
import { renderQualitySettings, type RenderQuality } from './render-quality';
import { BuildingViews } from './buildings';
import { CameraTurn, INITIAL_CAMERA_ANGLE } from './camera-controller';

export interface DisplayEntity extends EntityState {
  name?: string;
  color?: string;
  connected?: boolean;
  reaction?: DisplayReaction;
}
type EntityView = {
  root: TransformNode;
  label?: HTMLElement;
  material: StandardMaterial;
  labelText?: string;
  labelTransform?: string;
  reaction?: HTMLElement;
  reactionImage?: HTMLImageElement;
  reactionSequence?: number;
  expiredReactionSequence?: number;
};
const vector = (p: Vec3) => new Vector3(p.x, p.y, p.z);

export class WorldView {
  readonly engine: Engine;
  readonly scene: Scene;
  private readonly camera: ArcRotateCamera;
  private readonly shadow: ShadowGenerator;
  private readonly buildings: BuildingViews;
  private readonly cameraTurn = new CameraTurn();
  private readonly instrumentation: SceneInstrumentation;
  private readonly entities = new Map<string, EntityView>();
  private readonly target = Vector3.Zero();
  private readonly projection = Matrix.Identity();
  private readonly labelPosition = Vector3.Zero();
  private readonly projectedLabel = Vector3.Zero();
  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  private quality: RenderQuality;
  private readonly resize = () => {
    this.applyQuality();
    this.sizeCamera();
  };
  private frameHook?: (now: number, delta: number) => void;
  private lastFrame = performance.now();
  private readonly visibilityChanged = () => {
    // A suspended background tab is not a rendered frame. Keep visible slow frames intact.
    this.lastFrame = performance.now();
  };
  private followed?: string;
  private ownPosition?: Vector3;
  private disposed = false;
  private preparation?: Promise<void>;
  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly labels: HTMLElement,
    private readonly definition: WorldDefinition,
    quality: RenderQuality = 'standard',
  ) {
    this.quality = quality;
    this.engine = new Engine(canvas, true, {
      preserveDrawingBuffer: false,
      stencil: true,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.scene = new Scene(this.engine);
    this.instrumentation = new SceneInstrumentation(this.scene);
    this.applyQuality();
    this.scene.useRightHandedSystem = true;
    this.scene.clearColor = Color4.FromHexString('#101820ff');
    this.scene.ambientColor = Color3.FromHexString('#8199ac');
    this.camera = new ArcRotateCamera(
      'isometric',
      INITIAL_CAMERA_ANGLE,
      Math.PI / 3.15,
      48,
      Vector3.Zero(),
      this.scene,
    );
    this.camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
    this.camera.minZ = 0.1;
    this.camera.maxZ = 150;
    this.camera.inputs.clear();
    this.sizeCamera();
    const sky = new HemisphericLight('sky', new Vector3(0, 1, 0), this.scene);
    sky.intensity = 0.86;
    sky.diffuse = Color3.FromHexString('#c7e0e9');
    sky.groundColor = Color3.FromHexString('#27333f');
    const sun = new DirectionalLight('sun', new Vector3(-0.6, -1, -0.35), this.scene);
    sun.position.set(20, 35, 15);
    sun.intensity = 1.25;
    sun.diffuse = Color3.FromHexString('#fff2da');
    this.shadow = new ShadowGenerator(1024, sun);
    this.shadow.useBlurExponentialShadowMap = true;
    this.shadow.blurKernel = 16;
    this.shadow.setDarkness(0.25);
    this.buildings = new BuildingViews(this.scene, this.shadow, definition);
    const staticMaterials = new Map<string, StandardMaterial>();
    for (const entity of definition.entities) {
      if (entity.kind !== 'obstacle') continue;
      const mesh = MeshBuilder.CreateBox(
        entity.entityId,
        { width: entity.size.x, height: entity.size.y, depth: entity.size.z },
        this.scene,
      );
      mesh.position.copyFrom(vector(entity.position));
      let material = staticMaterials.get(entity.color);
      if (!material) {
        material = this.material(`static-${entity.color}`, entity.color);
        staticMaterials.set(entity.color, material);
      }
      mesh.material = material;
      mesh.receiveShadows = true;
      mesh.isPickable = false;
      mesh.freezeWorldMatrix();
      if (entity.entityId !== 'ground-01') {
        this.shadow.addShadowCaster(mesh);
        mesh.enableEdgesRendering();
        mesh.edgesWidth = 0.6;
        const accent = obstacleAccent(entity);
        mesh.edgesColor = accent
          ? Color4.FromHexString(`${accent}66`)
          : new Color4(0.65, 0.77, 0.79, 0.18);
      }
    }
    decorateWorld(this.scene, definition);
    window.addEventListener('resize', this.resize);
    document.addEventListener('visibilitychange', this.visibilityChanged);
    this.engine.runRenderLoop(() => {
      const now = performance.now();
      const delta = (now - this.lastFrame) / 1000;
      this.lastFrame = now;
      this.camera.alpha = this.cameraTurn.advance(delta);
      this.frameHook?.(now, delta);
      this.camera.setTarget(
        Vector3.Lerp(this.camera.target, this.target, 1 - Math.exp(-Math.min(delta, 0.1) * 5)),
        false,
        false,
        true, // Following translates the rig; pitch, orbit angle and radius remain fixed.
      );
      // Update the orbit before casting parallel orthographic rays; alpha may be mid-turn.
      this.camera.getViewMatrix(true);
      this.buildings.update(
        this.ownPosition,
        this.camera.globalPosition,
        this.camera.target.subtract(this.camera.globalPosition).normalize(),
        this.camera.minZ,
        now,
        delta,
      );
      this.scene.render();
      this.positionLabels();
    });
  }
  private material(id: string, color: string): StandardMaterial {
    const material = new StandardMaterial(id, this.scene);
    material.diffuseColor = Color3.FromHexString(color);
    material.specularColor = new Color3(0.07, 0.09, 0.1);
    material.specularPower = 48;
    return material;
  }
  private applyQuality(): void {
    const settings = renderQualitySettings(this.quality, window.devicePixelRatio);
    this.scene.shadowsEnabled = settings.shadows;
    this.engine.setHardwareScalingLevel(settings.hardwareScaling);
    this.engine.resize();
  }
  setQuality(quality: RenderQuality): void {
    if (quality === this.quality) return;
    this.quality = quality;
    this.applyQuality();
    this.sizeCamera();
  }
  get cameraAngle(): number {
    return this.cameraTurn.angle;
  }
  rotateCamera(direction: -1 | 1): void {
    this.cameraTurn.rotate(direction);
  }
  prepareBuildings(
    manifest: WorldManifest,
    readBytes: (path: string) => Promise<Uint8Array>,
  ): Promise<void> {
    this.preparation = this.buildings.prepare(manifest, readBytes);
    return this.preparation;
  }
  buildingDiagnostics() {
    return this.buildings.diagnostics();
  }
  renderingDiagnostics() {
    return {
      quality: this.quality,
      canvasSize: { width: this.canvas.clientWidth, height: this.canvas.clientHeight },
      renderSize: {
        width: this.engine.getRenderWidth(true),
        height: this.engine.getRenderHeight(true),
      },
      pixelRatio: window.devicePixelRatio,
      hardwareScaling: this.engine.getHardwareScalingLevel(),
      shadows: this.scene.shadowsEnabled,
      meshes: this.scene.meshes.length,
      materials: this.scene.materials.length,
      drawCalls: this.instrumentation.drawCallsCounter.current,
      renderer: this.engine.getGlInfo(),
      camera: { azimuth: this.cameraAngle, turning: this.cameraTurn.turning },
      buildings: this.buildings.aggregateDiagnostics(),
    };
  }
  private sizeCamera(): void {
    // Quality changes raster resolution, never the world visible through the camera.
    const aspect = this.canvas.clientWidth / Math.max(1, this.canvas.clientHeight);
    const halfHeight = aspect < 1 ? 20 : 15;
    this.camera.orthoTop = halfHeight;
    this.camera.orthoBottom = -halfHeight;
    this.camera.orthoLeft = -halfHeight * aspect;
    this.camera.orthoRight = halfHeight * aspect;
  }
  onFrame(callback: (now: number, delta: number) => void): void {
    this.frameHook = callback;
  }
  follow(id?: string): void {
    this.followed = id;
    if (!id) this.target.setAll(0);
  }
  update(entities: DisplayEntity[], ownId?: string): void {
    this.ownPosition = undefined;
    const current = new Set(entities.map((entity) => entity.entityId));
    for (const [id, view] of this.entities)
      if (!current.has(id)) {
        view.label?.remove();
        view.reaction?.remove();
        for (const mesh of view.root.getChildMeshes()) this.shadow.removeShadowCaster(mesh);
        view.root.dispose(false, true);
        this.entities.delete(id);
      }
    for (const entity of entities) {
      let view = this.entities.get(entity.entityId);
      if (!view) {
        view = this.createEntity(entity, entity.entityId === ownId);
        this.entities.set(entity.entityId, view);
      }
      view.root.position.set(entity.position.x, entity.position.y, entity.position.z);
      if (entity.entityId === ownId) this.ownPosition = view.root.position;
      view.root
        .rotationQuaternion!.set(
          entity.rotation.x,
          entity.rotation.y,
          entity.rotation.z,
          entity.rotation.w,
        )
        .normalize();
      if (view.label) {
        const text = `${entity.name ?? 'Гость'}${entity.entityId === ownId ? ' · Вы' : ''}${entity.connected === false ? ' · нет связи' : ''}`;
        if (text !== view.labelText) {
          view.label.textContent = text;
          view.labelText = text;
        }
      }
      view.material.alpha = entity.connected === false ? 0.45 : 1;
      this.updateReaction(view, entity);
      if (entity.entityId === this.followed)
        this.target.set(entity.position.x, 0, entity.position.z);
    }
  }
  private updateReaction(view: EntityView, entity: DisplayEntity): void {
    const active = entity.reaction;
    const definition = findReaction(active?.id);
    if (!active || !definition || active.remainingMs <= 0) {
      if (active && active.remainingMs <= 0) view.expiredReactionSequence = active.sequence;
      view.reaction?.remove();
      view.reaction = undefined;
      view.reactionImage = undefined;
      view.reactionSequence = undefined;
      return;
    }
    // A late patch for the same show must not revive an already expired sticker.
    if (view.expiredReactionSequence === active.sequence) return;
    if (!view.reaction) {
      view.reaction = document.createElement('div');
      view.reaction.className = 'player-reaction';
      view.reaction.dataset.entityId = entity.entityId;
      view.reactionImage = document.createElement('img');
      view.reactionImage.width = view.reactionImage.height = 44;
      view.reaction.append(view.reactionImage);
      this.labels.append(view.reaction);
    }
    if (view.reactionSequence !== active.sequence) {
      view.reactionSequence = active.sequence;
      view.reaction.dataset.reactionId = definition.id;
      view.reactionImage!.src = `/reactions/${definition.asset}`;
      view.reactionImage!.alt = definition.label;
    }
    const appear = Math.min(1, (REACTION_DURATION_MS - active.remainingMs) / 150);
    const disappear = Math.min(1, active.remainingMs / 250);
    const progress = Math.max(0, Math.min(appear, disappear));
    view.reaction.style.opacity = this.reducedMotion.matches ? '1' : progress.toFixed(3);
    view.reactionImage!.style.transform = this.reducedMotion.matches
      ? ''
      : `scale(${0.8 + 0.2 * progress})`;
  }
  private createEntity(entity: DisplayEntity, own: boolean): EntityView {
    const root = new TransformNode(entity.entityId, this.scene);
    root.rotationQuaternion = Quaternion.Identity();
    const material = this.material(`material-${entity.entityId}`, entity.color ?? '#d6a15a');
    let mesh: Mesh;
    let label: HTMLElement | undefined;
    if (entity.kind === 'player') {
      const { height, radius } = this.definition.simulation.character;
      mesh = MeshBuilder.CreateCapsule(
        `body-${entity.entityId}`,
        { height, radius, tessellation: 16, subdivisions: 2 },
        this.scene,
      );
      const visor = MeshBuilder.CreateBox(
        `visor-${entity.entityId}`,
        { width: radius * 1.05, height: height * 0.072, depth: radius * 0.34 },
        this.scene,
      );
      visor.parent = root;
      visor.position.set(0, height * 0.26, radius * 0.86);
      visor.material = this.material(`visor-material-${entity.entityId}`, '#20323a');
      label = document.createElement('div');
      label.className = `player-label${own ? ' own' : ''}`;
      this.labels.append(label);
      if (own) {
        const marker = MeshBuilder.CreateTorus(
          `marker-${entity.entityId}`,
          { diameter: radius * 3, thickness: 0.028, tessellation: 40 },
          this.scene,
        );
        marker.parent = root;
        marker.position.y = -height / 2 + 0.04;
        const markerMaterial = this.material(
          `marker-material-${entity.entityId}`,
          entity.color ?? '#65d6bc',
        );
        markerMaterial.emissiveColor = Color3.FromHexString(entity.color ?? '#65d6bc').scale(0.35);
        marker.material = markerMaterial;
      }
    } else {
      const size = this.definition.entities.find((item) => item.entityId === entity.entityId)!.size;
      mesh = MeshBuilder.CreateBox(
        'crate',
        { width: size.x, height: size.y, depth: size.z },
        this.scene,
      );
      mesh.enableEdgesRendering();
      mesh.edgesWidth = 1.5;
      mesh.edgesColor = new Color4(0.24, 0.17, 0.1, 0.6);
      const strapMaterial = this.material('crate-straps', '#574b39');
      for (const x of [-size.x * 0.3, size.x * 0.3]) {
        const strap = MeshBuilder.CreateBox(
          `strap-${x}`,
          { width: size.x * 0.07, height: size.y + 0.008, depth: size.z + 0.008 },
          this.scene,
        );
        strap.parent = root;
        strap.position.x = x;
        strap.material = strapMaterial;
      }
    }
    mesh.parent = root;
    mesh.material = material;
    mesh.receiveShadows = true;
    this.shadow.addShadowCaster(mesh, true);
    return { root, label, material };
  }
  private positionLabels(): void {
    const width = this.engine.getRenderWidth(true);
    const height = this.engine.getRenderHeight(true);
    const viewport = this.camera.viewport.toGlobal(width, height);
    const cssWidth = this.canvas.clientWidth;
    const cssHeight = this.canvas.clientHeight;
    const labelHeight = this.definition.simulation.character.height / 2 + 0.5;
    for (const view of this.entities.values()) {
      if (!view.label) continue;
      this.labelPosition.copyFrom(view.root.position);
      this.labelPosition.y += labelHeight;
      Vector3.ProjectToRef(
        this.labelPosition,
        this.projection,
        this.scene.getTransformMatrix(),
        viewport,
        this.projectedLabel,
      );
      const x = (this.projectedLabel.x * cssWidth) / width;
      const y = (this.projectedLabel.y * cssHeight) / height;
      const hidden =
        this.projectedLabel.z < 0 ||
        this.projectedLabel.z > 1 ||
        x < 0 ||
        x > cssWidth ||
        y < 0 ||
        y > cssHeight;
      if (view.label.hidden !== hidden) view.label.hidden = hidden;
      if (view.reaction) {
        view.reaction.hidden = hidden;
        view.reaction.style.transform = `translate(${(x + 38).toFixed(2)}px, ${(y - 30).toFixed(2)}px) translate(-50%, -100%)`;
      }
      if (hidden) continue;
      const transform = `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px) translate(-50%, -100%)`;
      if (transform !== view.labelTransform) {
        view.label.style.transform = transform;
        view.labelTransform = transform;
      }
    }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener('resize', this.resize);
    document.removeEventListener('visibilitychange', this.visibilityChanged);
    this.engine.stopRenderLoop();
    this.labels.replaceChildren();
    this.buildings.dispose();
    this.instrumentation.dispose();
    const releaseGraphics = () => {
      this.scene.dispose();
      this.engine.dispose();
    };
    // Stop gameplay immediately, but retain the graphics context while started glTF
    // loaders unwind. They may allocate shared scene textures after cancellation.
    if (this.preparation) void this.preparation.then(releaseGraphics, releaseGraphics);
    else releaseGraphics();
  }
}
