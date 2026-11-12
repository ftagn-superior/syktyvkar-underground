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
import type {
  EntityState,
  WorldDefinition,
  WorldHeader,
  WorldCell,
  WorldManifest,
  StaticEntityDefinition,
  BuildingInstance,
} from '@su/contracts';
import { StaticViews } from './statics';
import { decorateWorld } from './world-decoration';
import { renderQualitySettings, type RenderQuality } from './render-quality';
import { BuildingViews } from './buildings';
import { CameraTurn, INITIAL_CAMERA_ANGLE, orthographicFrame } from './camera-controller';

export interface DisplayEntity extends EntityState {
  name?: string;
  color?: string;
  connected?: boolean;
}
type EntityView = {
  root: TransformNode;
  label?: HTMLElement;
  material: StandardMaterial;
  labelText?: string;
  labelTransform?: string;
};

export class WorldView {
  readonly engine: Engine;
  readonly scene: Scene;
  private readonly camera: ArcRotateCamera;
  private readonly shadow: ShadowGenerator;
  private readonly buildings: BuildingViews;
  private readonly statics: StaticViews;
  private readonly cameraTurn = new CameraTurn();
  private readonly instrumentation: SceneInstrumentation;
  private readonly entities = new Map<string, EntityView>();
  private readonly target = Vector3.Zero();
  private readonly projection = Matrix.Identity();
  private readonly labelPosition = Vector3.Zero();
  private readonly projectedLabel = Vector3.Zero();
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
  private readonly cellPreparations = new Set<Promise<unknown>>();
  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly labels: HTMLElement,
    private readonly definition: WorldDefinition | WorldHeader,
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
    this.statics = new StaticViews(this.scene, this.shadow);
    if ('entities' in definition) {
      for (const entity of definition.entities)
        if (entity.kind === 'obstacle')
          this.statics.add(entity as StaticEntityDefinition, 'initial');
      decorateWorld(this.scene, definition);
    }
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
  prepareCellAssets(
    manifest: WorldManifest,
    ids: string[],
    read: (path: string, signal?: AbortSignal) => Promise<Uint8Array>,
    signal?: AbortSignal,
  ) {
    const pending = this.buildings.prepareAssets(manifest, ids, read, signal);
    this.cellPreparations.add(pending);
    void pending.then(
      () => this.cellPreparations.delete(pending),
      () => this.cellPreparations.delete(pending),
    );
    return pending;
  }
  /** Decorations stay local to a one-cell arena and are released with that cell. */
  activateCell(cell: WorldCell): () => void {
    const meshes = new Set(this.scene.meshes);
    const materials = new Set(this.scene.materials);
    const textures = new Set(this.scene.textures);
    const release = () => {
      for (const mesh of [...this.scene.meshes]) if (!meshes.has(mesh)) mesh.dispose();
      for (const material of [...this.scene.materials])
        if (!materials.has(material)) material.dispose(false, false);
      for (const texture of [...this.scene.textures]) if (!textures.has(texture)) texture.dispose();
    };
    try {
      const crate =
        'crate' in this.definition
          ? this.definition.crate
          : this.definition.entities.find((entity) => entity.kind === 'crate')!;
      decorateWorld(this.scene, {
        bounds: this.definition.bounds,
        spawnPoints: this.definition.spawnPoints,
        entities: [...cell.statics, crate],
      });
      // Capture only decoration resources; later characters/buildings belong to other owners.
      const ownedMeshes = this.scene.meshes.filter((mesh) => !meshes.has(mesh));
      const ownedMaterials = this.scene.materials.filter((material) => !materials.has(material));
      const ownedTextures = this.scene.textures.filter((texture) => !textures.has(texture));
      return () => {
        for (const mesh of ownedMeshes) mesh.dispose();
        for (const material of ownedMaterials) material.dispose(false, false);
        for (const texture of ownedTextures) texture.dispose();
      };
    } catch (error) {
      release();
      throw error;
    }
  }
  retainStatic(item: StaticEntityDefinition | BuildingInstance, version: string) {
    if ('assetId' in item) this.buildings.add(item, version);
    else this.statics.add(item, version);
  }
  releaseStatic(entityId: string) {
    this.buildings.remove(entityId);
    this.statics.remove(entityId);
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
      dynamicEntities: [...this.entities].map(([entityId, view]) => ({
        entityId,
        position: { x: view.root.position.x, y: view.root.position.y, z: view.root.position.z },
      })),
      geometries: this.scene.geometries.length,
      nodes: this.scene.transformNodes.length,
      textures: this.scene.textures.length,
      shadowCasters: this.shadow.getShadowMap()?.renderList?.length ?? 0,
      meshes: this.scene.meshes.length,
      materials: this.scene.materials.length,
      drawCalls: this.instrumentation.drawCallsCounter.current,
      renderer: this.engine.getGlInfo(),
      camera: {
        azimuth: this.cameraAngle,
        turning: this.cameraTurn.turning,
        halfWidth: this.camera.orthoRight!,
        halfHeight: this.camera.orthoTop!,
        beta: this.camera.beta,
      },
      buildings: this.buildings.aggregateDiagnostics(),
    };
  }
  private sizeCamera(): void {
    // Quality changes raster resolution, never the world visible through the camera.
    const aspect = Math.max(1, this.canvas.clientWidth) / Math.max(1, this.canvas.clientHeight);
    const { halfHeight, halfWidth } = orthographicFrame(aspect);
    this.camera.orthoTop = halfHeight;
    this.camera.orthoBottom = -halfHeight;
    this.camera.orthoLeft = -halfWidth;
    this.camera.orthoRight = halfWidth;
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
      if (entity.entityId === this.followed)
        this.target.set(entity.position.x, 0, entity.position.z);
    }
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
      const size =
        'crate' in this.definition
          ? this.definition.crate.size
          : this.definition.entities.find((item) => item.entityId === entity.entityId)!.size;
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
    this.statics.dispose();
    this.instrumentation.dispose();
    const releaseGraphics = () => {
      this.scene.dispose();
      this.engine.dispose();
    };
    // Stop gameplay immediately, but retain the graphics context while started glTF
    // loaders unwind. They may allocate shared scene textures after cancellation.
    if (this.preparation || this.cellPreparations.size)
      void Promise.allSettled([this.preparation, ...this.cellPreparations]).then(releaseGraphics);
    else releaseGraphics();
  }
}
