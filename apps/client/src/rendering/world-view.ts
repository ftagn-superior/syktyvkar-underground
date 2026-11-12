import '@babylonjs/core/Culling/ray';
import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { Camera } from '@babylonjs/core/Cameras/camera';
import { Vector3, Quaternion, Matrix } from '@babylonjs/core/Maths/math.vector';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import { DefaultRenderingPipeline } from '@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline';
import { ImageProcessingConfiguration } from '@babylonjs/core/Materials/imageProcessingConfiguration';
import { ColorCurves } from '@babylonjs/core/Materials/colorCurves';
import { SceneInstrumentation } from '@babylonjs/core/Instrumentation/sceneInstrumentation';
import '@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent';
import '@babylonjs/core/Rendering/edgesRenderer';
import {
  findReaction,
  type ItemPose,
  type Vec3,
  type WorldDefinition,
  type WorldHeader,
  type WorldCell,
  type StaticEntityDefinition,
  type BuildingInstance,
  type WorldManifest,
} from '@su/contracts';
import { decorateWorld } from './world-decoration';
import { StaticViews } from './statics';
import { applyRadialFog, radialOpacity, type RadialState } from './radial-fog';
import { Frustum } from '@babylonjs/core/Maths/math.frustum';
import { BoundingInfo } from '@babylonjs/core/Culling/boundingInfo';
import { worldCellBounds } from '@su/contracts';
import { renderQualitySettings, type RenderQuality } from './render-quality';
import { BuildingViews } from './buildings';
import { CameraOrbit, INITIAL_CAMERA_ANGLE } from './camera-controller';
import type { DisplayEntity } from '../presentation/display-state';
import { AvatarView } from './avatars/avatar-view';
import { createItemMesh } from './items';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';

type EntityView = {
  root: TransformNode;
  label?: HTMLElement;
  material?: StandardMaterial;
  avatar?: AvatarView;
  labelText?: string;
  labelTransform?: string;
  reaction?: HTMLElement;
  reactionImage?: HTMLImageElement;
  reactionSequence?: number;
  reactionShownAt?: number;
  expiredReactionSequence?: number;
  chat?: HTMLElement;
  chatSequence?: number;
  expiredChatSequence?: number;
};
type LabelAnchor = {
  label: HTMLElement;
  labelTransform?: string;
  reaction?: HTMLElement;
  chat?: HTMLElement;
};
const vector = (p: Vec3) => new Vector3(p.x, p.y, p.z);
/** Сторона квадрата теней в метрах и удаление солнца от цели камеры. */
const SHADOW_EXTENT = 90;
const SUN_DISTANCE = 150;
/** Пределы масштаба колёсиком мыши относительно исходного кадра. */
const MIN_ZOOM = 0.6;
const MAX_ZOOM = 30;

export class WorldView {
  readonly engine: Engine;
  readonly scene: Scene;
  private readonly camera: ArcRotateCamera;
  private readonly sun: DirectionalLight;
  private readonly shadow: ShadowGenerator;
  private pipeline?: DefaultRenderingPipeline;
  private readonly buildings: BuildingViews;
  private readonly statics: StaticViews;
  private manifest?: WorldManifest;
  private cellBounds: BoundingInfo[] = [];
  private graphicalFrame?: { matrix: Matrix; x: number; z: number; radius: number };
  private readonly cellPreparations = new Set<Promise<unknown>>();
  private readonly radial: RadialState = {
    center: { x: 0, y: 0, z: 0 },
    radius: 0,
    time: 0,
    appearMs: 300,
  };
  private readonly dynamicRadial: RadialState = {
    center: { x: 0, y: 0, z: 0 },
    radius: 500,
    dynamic: true,
    time: 0,
    appearMs: 300,
  };
  private streamingRadius = 0;
  private readonly cameraOrbit = new CameraOrbit();
  private readonly instrumentation: SceneInstrumentation;
  private readonly entities = new Map<string, EntityView>();
  private ring?: { mesh: Mesh; material: StandardMaterial; target?: string };
  private readonly landmarks: (LabelAnchor & { position: Vector3 })[] = [];
  private readonly target = Vector3.Zero();
  private readonly projection = Matrix.Identity();
  private readonly labelPosition = Vector3.Zero();
  private readonly projectedLabel = Vector3.Zero();
  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  private quality: RenderQuality;
  private zoom = 1;
  private touchMode = false;
  private readonly resize = () => {
    this.applyQuality();
    this.sizeCamera();
  };
  private frameHook?: (now: number, delta: number) => void;
  private lastFrame = performance.now();
  private readonly visibilityChanged = () => {
    // A suspended background tab is not a rendered frame. Keep visible slow frames intact.
    this.lastFrame = performance.now();
    for (const view of this.entities.values()) view.avatar?.resetMotion();
  };
  private followed?: string;
  private ownPosition?: Vector3;
  private disposed = false;
  private preparation?: Promise<void>;
  private ghost?: Mesh;
  private ghostType?: string;
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
    // Игра не использует события указателя Babylon над мешами: без этого каждое движение
    // мыши запускало бы поиск по всем мешам города.
    this.scene.skipPointerMovePicking = true;
    this.instrumentation = new SceneInstrumentation(this.scene);
    this.applyQuality();
    this.scene.useRightHandedSystem = true;
    this.scene.clearColor = Color4.FromHexString('#101820ff');
    this.scene.ambientColor = Color3.FromHexString('#8199ac');
    this.camera = new ArcRotateCamera(
      'isometric',
      INITIAL_CAMERA_ANGLE,
      Math.PI / 3.15,
      // Исходное удаление камеры: выше 10-этажных домов.
      120,
      Vector3.Zero(),
      this.scene,
    );
    this.camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
    this.camera.minZ = 0.1;
    this.camera.maxZ = 300;
    this.camera.inputs.clear();
    this.sizeCamera();
    // Вечернее освещение: низкое тёплое солнце, холодное небо в тенях, отражённый тёплый свет от земли.
    const sky = new HemisphericLight('sky', new Vector3(0, 1, 0), this.scene);
    sky.intensity = 0.85;
    sky.diffuse = Color3.FromHexString('#bcd4f0');
    sky.groundColor = Color3.FromHexString('#8a7058');
    sky.specular = Color3.Black();
    // Высота солнца около 32°: длинные мягкие тени, фасады с разной освещённостью сторон.
    const sun = new DirectionalLight('sun', new Vector3(-1.1, -0.8, -0.65), this.scene);
    sun.position.set(20, 35, 15);
    sun.intensity = 2.4;
    sun.diffuse = Color3.FromHexString('#ffd9a0');
    // Карта теней покрывает квадрат вокруг камеры, а не весь город: иначе тени размываются.
    sun.shadowFrustumSize = SHADOW_EXTENT;
    sun.shadowMinZ = 0;
    sun.shadowMaxZ = SUN_DISTANCE * 2;
    this.sun = sun;
    this.sizeCamera();
    this.shadow = new ShadowGenerator(2048, sun);
    // PCF даёт чёткий край у основания и мягкий на расстоянии, в отличие от размытой ESM.
    this.shadow.usePercentageCloserFiltering = true;
    this.shadow.filteringQuality = ShadowGenerator.QUALITY_MEDIUM;
    this.shadow.bias = 0.0012;
    this.shadow.normalBias = 0.08;
    this.shadow.setDarkness(0.3);
    this.applyQuality();
    this.buildings = new BuildingViews(this.scene, this.shadow, definition, this.radial);
    this.statics = new StaticViews(this.scene, this.shadow);
    this.sizeCamera();
    if ('entities' in definition) {
      for (const entity of definition.entities)
        if (entity.kind === 'obstacle')
          this.statics.add(entity as StaticEntityDefinition, 'initial');
      decorateWorld(this.scene, definition);
      this.streamingRadius = this.radial.radius = Infinity;
    }
    if (!(
      definition.bounds.min.x <= 0 &&
      definition.bounds.max.x >= 0 &&
      definition.bounds.min.z <= 0 &&
      definition.bounds.max.z >= 0
    )) {
      this.target.copyFrom(vector(definition.spawnPoints[0]));
      this.target.y = 0;
      this.camera.setTarget(this.target);
    }
    for (const landmark of definition.landmarks ?? []) {
      const label = document.createElement('div');
      label.className = 'landmark-label';
      label.textContent = landmark.name;
      label.hidden = true;
      this.labels.append(label);
      this.landmarks.push({ label, position: vector(landmark.position) });
    }
    window.addEventListener('resize', this.resize);
    canvas.addEventListener('wheel', this.wheel, { passive: false });
    document.addEventListener('visibilitychange', this.visibilityChanged);
    this.engine.runRenderLoop(() => {
      const now = performance.now();
      const delta = (now - this.lastFrame) / 1000;
      this.lastFrame = now;
      this.camera.alpha = this.cameraOrbit.advance(delta);
      this.frameHook?.(now, delta);
      this.camera.setTarget(
        Vector3.Lerp(this.camera.target, this.target, 1 - Math.exp(-Math.min(delta, 0.1) * 5)),
        false,
        false,
        true, // Following translates the rig; pitch, orbit angle and radius remain fixed.
      );
      // Солнце движется вместе с целью камеры; направление лучей не меняется.
      this.sun.position
        .copyFrom(this.sun.direction)
        .normalize()
        .scaleInPlace(-SUN_DISTANCE)
        .addInPlace(this.camera.target);
      // Update the orbit before casting parallel orthographic rays; alpha may be mid-turn.
      this.camera.getViewMatrix(true);
      this.buildings.update(
        this.ownPosition,
        this.camera.globalPosition,
        this.camera.target.subtract(this.camera.globalPosition).normalize(),
        this.camera.minZ,
        now,
        delta,
        this.ownPosition ?? this.target,
        this.radial.radius,
      );
      this.statics.updateShadows(this.ownPosition ?? this.target, this.radial.radius);
      const center = this.ownPosition ?? this.target;
      this.radial.center = this.dynamicRadial.center = center;
      this.radial.time = this.dynamicRadial.time = now;
      this.radial.appearMs = this.dynamicRadial.appearMs = this.reducedMotion.matches ? 80 : 300;
      // Closing is immediate; opening follows only the completely prepared circle.
      this.radial.radius =
        this.streamingRadius < this.radial.radius
          ? this.streamingRadius
          : Math.min(
              this.streamingRadius,
              this.radial.radius + (Math.max(1, this.streamingRadius) * delta) / 0.3,
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
    const settings = renderQualitySettings(this.quality);
    this.scene.shadowsEnabled = settings.shadows;
    this.engine.setHardwareScalingLevel(settings.hardwareScaling);
    this.engine.resize();
    this.updatePipeline(settings.postProcessing);
  }
  /** Тональная компрессия, лёгкое свечение и MSAA; в режиме экономии отключены целиком. */
  private updatePipeline(enabled: boolean): void {
    if (!this.camera) return;
    if (!enabled) {
      this.pipeline?.dispose();
      this.pipeline = undefined;
      return;
    }
    if (this.pipeline) return;
    const pipeline = new DefaultRenderingPipeline('lighting', true, this.scene, [this.camera]);
    pipeline.samples = 4;
    pipeline.fxaaEnabled = false;
    pipeline.bloomEnabled = true;
    pipeline.bloomThreshold = 0.95;
    pipeline.bloomWeight = 0.15;
    pipeline.bloomKernel = 48;
    pipeline.bloomScale = 0.5;
    const ip = pipeline.imageProcessing;
    ip.toneMappingEnabled = true;
    ip.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
    ip.exposure = 1.55;
    ip.contrast = 1.12;
    ip.colorCurvesEnabled = true;
    ip.colorCurves = new ColorCurves();
    ip.colorCurves.globalSaturation = 25;
    ip.vignetteEnabled = true;
    ip.vignetteWeight = 0.9;
    ip.vignetteStretch = 0.2;
    ip.vignetteColor = new Color4(0.12, 0.08, 0.05, 0);
    this.pipeline = pipeline;
  }
  setQuality(quality: RenderQuality): void {
    if (quality === this.quality) return;
    this.quality = quality;
    this.applyQuality();
    this.sizeCamera();
  }
  get cameraAngle(): number {
    return this.cameraOrbit.angle;
  }
  setCameraRotation(direction: -1 | 0 | 1): void {
    this.cameraOrbit.setDirection(direction);
  }
  rotateCameraBy(radians: number): void {
    this.cameraOrbit.rotateBy(radians);
  }
  stopCamera(): void {
    this.cameraOrbit.stop();
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
    if (this.manifest !== manifest) {
      this.manifest = manifest;
      this.cellBounds = manifest.cells.map((cell) => {
        const bounds = worldCellBounds(manifest.bounds, manifest.grid, cell.cellId);
        return new BoundingInfo(vector(bounds.min), vector(bounds.max));
      });
      this.graphicalFrame = undefined;
    }
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
      decorateWorld(this.scene, {
        bounds: this.definition.bounds,
        spawnPoints: this.definition.spawnPoints,
        entities: cell.statics,
        worldId: this.definition.worldId,
        initialItems: this.definition.initialItems,
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
    let root;
    if ('assetId' in item) root = this.buildings.add(item, version);
    else {
      this.statics.add(item, version);
      root =
        this.scene.getTransformNodeByName(item.entityId) ?? this.scene.getMeshByName(item.entityId);
    }
    if (root) {
      const meshes = root instanceof TransformNode ? root.getChildMeshes() : [];
      if ('material' in root)
        meshes.push(root as import('@babylonjs/core/Meshes/abstractMesh').AbstractMesh);
      for (const mesh of meshes) applyRadialFog(mesh, this.radial, performance.now());
    }
  }
  releaseStatic(entityId: string) {
    this.buildings.remove(entityId);
    this.statics.remove(entityId);
  }
  buildingDiagnostics() {
    return this.buildings.diagnostics();
  }
  avatarDiagnostics() {
    return Array.from(this.entities.values()).flatMap((view) =>
      view.avatar ? [view.avatar.diagnostics()] : [],
    );
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
      streaming: {
        drawRadius: this.graphicalArea().drawRadius,
        readyRadius: this.streamingRadius,
        shownRadius: this.radial.radius,
      },
      meshes: this.scene.meshes.length,
      transformNodes: this.scene.transformNodes.length,
      materials: this.scene.materials.length,
      drawCalls: this.instrumentation.drawCallsCounter.current,
      renderer: this.engine.getGlInfo(),
      camera: {
        azimuth: this.cameraAngle,
        turning: this.cameraOrbit.turning,
        halfWidth: this.camera.orthoRight!,
        halfHeight: this.camera.orthoTop!,
        beta: this.camera.beta,
        zoom: this.zoom,
      },
      buildings: this.buildings.aggregateDiagnostics(),
    };
  }
  graphicalArea() {
    this.camera.getViewMatrix(true);
    const center = this.ownPosition ?? this.target;
    const matrix = this.camera.getTransformationMatrix();
    let frame = this.graphicalFrame;
    if (!frame || frame.x !== center.x || frame.z !== center.z || !frame.matrix.equals(matrix)) {
      let radius = 0;
      const planes = Frustum.GetPlanes(matrix);
      for (const bounds of this.cellBounds) {
        if (!bounds.isInFrustum(planes)) continue;
        const { minimum: min, maximum: max } = bounds.boundingBox;
        for (const x of [min.x, max.x])
          for (const z of [min.z, max.z])
            radius = Math.max(radius, Math.hypot(x - center.x, z - center.z));
      }
      frame = this.graphicalFrame = { matrix: matrix.clone(), x: center.x, z: center.z, radius };
    }
    // Keep the 75 m fog transition outside every visible cell, including tall buildings.
    // Physics and network AOI keep their independent 500/800 m safety margins.
    const drawRadius = Math.max(125, frame.radius + 75);
    return {
      center: { x: center.x, y: center.y, z: center.z },
      drawRadius,
      preloadRadius: drawRadius + 125,
      retainRadius: drawRadius + 300,
    };
  }
  setStreamingRadius(radius: number) {
    this.streamingRadius = Math.max(0, radius);
  }
  private sizeCamera(): void {
    // Quality changes raster resolution, never the world visible through the camera.
    const aspect = this.canvas.clientWidth / Math.max(1, this.canvas.clientHeight);
    const halfHeight = (aspect < 1 ? 20 : 15) * this.zoom;
    this.camera.orthoTop = halfHeight;
    this.camera.orthoBottom = -halfHeight;
    this.camera.orthoLeft = -halfHeight * aspect;
    this.camera.orthoRight = halfHeight * aspect;
    // При отдалении расширяем глубину обзора: ближняя и дальняя плоскости не режут город.
    const depthScale = Math.max(1, this.zoom);
    this.camera.radius = 120 * depthScale;
    this.camera.maxZ = 300 * depthScale;
    if (this.sun) this.sun.shadowFrustumSize = SHADOW_EXTENT;
    this.buildings?.setDetailScale((2 * halfHeight) / Math.max(1, this.canvas.clientHeight));
  }
  private readonly wheel = (event: WheelEvent) => {
    event.preventDefault();
    if (this.touchMode) return;
    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.zoom * Math.exp(event.deltaY * 0.001)));
    if (zoom === this.zoom) return;
    this.zoom = zoom;
    this.sizeCamera();
  };
  /** Масштаб кадра: 1 — исходный ракурс, больше — дальше. */
  get cameraZoom(): number {
    return this.zoom;
  }
  setTouchMode(enabled: boolean): void {
    this.touchMode = enabled;
    if (enabled) {
      this.zoom = 1;
      this.sizeCamera();
    }
  }
  onFrame(callback: (now: number, delta: number) => void): void {
    this.frameHook = callback;
  }
  follow(id?: string): void {
    this.followed = id;
    if (!id) {
      const bounds = this.definition.bounds;
      if (bounds.min.x <= 0 && bounds.max.x >= 0 && bounds.min.z <= 0 && bounds.max.z >= 0)
        this.target.setAll(0);
      else {
        this.target.copyFrom(vector(this.definition.spawnPoints[0]));
        this.target.y = 0;
      }
    }
  }
  update(entities: DisplayEntity[], ownId: string | undefined, delta: number): void {
    this.ownPosition = undefined;
    this.updateRing();
    const current = new Set(entities.map((entity) => entity.entityId));
    for (const [id, view] of this.entities)
      if (!current.has(id)) {
        this.disposeEntity(view);
        this.entities.delete(id);
      }
    const shadowCenter =
      entities.find((entity) => entity.entityId === ownId)?.position ?? this.target;
    // Одна копия списка на кадр, а не на каждую сущность; ниже она ведётся синхронно.
    const shadowCasters = new Set(this.shadow.getShadowMap()?.renderList ?? []);
    const fogNow = performance.now();
    for (const entity of entities) {
      let view = this.entities.get(entity.entityId);
      if (!view) {
        view = this.createEntity(entity, entity.entityId === ownId);
        this.entities.set(entity.entityId, view);
        // Новая сущность только что зарегистрировала свои меши как источники тени.
        for (const mesh of this.shadow.getShadowMap()?.renderList ?? []) shadowCasters.add(mesh);
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
        view.label.classList.toggle('own', entity.entityId === ownId);
        const own = entity.entityId === ownId;
        const name = entity.name ?? 'Гость';
        const offline = entity.connected === false;
        const key = `${name}|${own}|${offline}|${entity.color ?? ''}`;
        if (key !== view.labelText) {
          // Each tag carries the player's own colour as its gem; own tag adds "· Вы".
          const gem = document.createElement('span');
          gem.className = 'su-gem sm';
          if (entity.color) gem.style.setProperty('--gem', entity.color);
          const text = document.createElement('span');
          text.textContent = name;
          const suffixes = [...(own ? ['· Вы'] : []), ...(offline ? ['· нет связи'] : [])].map(
            (suffix) => {
              const node = document.createElement('span');
              node.className = 'you';
              node.textContent = suffix;
              return node;
            },
          );
          view.label.replaceChildren(gem, text, ...suffixes);
          view.labelText = key;
        }
      }
      if (entity.kind === 'player')
        view.avatar!.update(entity, delta, entity.entityId === ownId, this.reducedMotion.matches);
      else if (view.material) view.material.alpha = entity.connected === false ? 0.45 : 1;
      const nearShadow =
        Math.hypot(entity.position.x - shadowCenter.x, entity.position.z - shadowCenter.z) <= 80;
      for (const mesh of view.root.getChildMeshes()) {
        applyRadialFog(mesh, this.dynamicRadial, fogNow);
        // Remember authored eligibility: returning into range must restore body shadows,
        // while markers and other intentionally unshadowed avatar pieces remain excluded.
        mesh.metadata.suStreamingShadow ??= shadowCasters.has(mesh);
        if (nearShadow && mesh.metadata.suStreamingShadow && !shadowCasters.has(mesh)) {
          this.shadow.addShadowCaster(mesh);
          shadowCasters.add(mesh);
        } else if (!nearShadow && shadowCasters.has(mesh)) {
          this.shadow.removeShadowCaster(mesh);
          shadowCasters.delete(mesh);
        }
      }
      this.updateReaction(view, entity);
      this.updateChat(view, entity);
      if (entity.entityId === this.followed)
        this.target.set(entity.position.x, 0, entity.position.z);
    }
  }
  private disposeEntity(view: EntityView): void {
    view.label?.remove();
    view.reaction?.remove();
    view.chat?.remove();
    view.avatar?.dispose();
    for (const mesh of view.root.getChildMeshes()) this.shadow.removeShadowCaster(mesh);
    view.root.dispose(false, true);
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
      view.reactionShownAt = performance.now();
      view.reaction.dataset.reactionId = definition.id;
      view.reactionImage!.src = `/reactions/${definition.asset}`;
      view.reactionImage!.alt = definition.label;
    }
    const appear = Math.min(1, (performance.now() - view.reactionShownAt!) / 150);
    const disappear = Math.min(1, active.remainingMs / 250);
    const progress = Math.max(0, Math.min(appear, disappear));
    view.reaction.style.opacity = this.reducedMotion.matches ? '1' : progress.toFixed(3);
    view.reactionImage!.style.transform = this.reducedMotion.matches
      ? ''
      : `scale(${0.8 + 0.2 * progress})`;
  }
  private updateChat(view: EntityView, entity: DisplayEntity): void {
    const active = entity.chat;
    if (!active || active.remainingMs <= 0) {
      if (active) view.expiredChatSequence = active.sequence;
      view.chat?.remove();
      view.chat = undefined;
      view.chatSequence = undefined;
      return;
    }
    if (view.expiredChatSequence === active.sequence) return;
    if (!view.chat) {
      view.chat = document.createElement('div');
      view.chat.className = 'player-chat';
      view.chat.dataset.entityId = entity.entityId;
      this.labels.append(view.chat);
    }
    if (view.chatSequence !== active.sequence) {
      view.chatSequence = active.sequence;
      view.chat.textContent = active.text;
    }
    view.chat.style.opacity = this.reducedMotion.matches
      ? '1'
      : Math.min(1, active.remainingMs / 250).toFixed(3);
  }
  private createEntity(entity: DisplayEntity, own: boolean): EntityView {
    const root = new TransformNode(entity.entityId, this.scene);
    root.rotationQuaternion = Quaternion.Identity();
    if (entity.kind === 'player') {
      const avatar = new AvatarView(
        root,
        this.scene,
        this.shadow,
        this.definition.simulation.character,
        entity.skinId,
      );
      const label = document.createElement('div');
      label.className = `player-label${own ? ' own' : ''}`;
      this.labels.append(label);
      return { root, label, avatar };
    }
    const type = this.definition.itemCatalog.types[entity.typeId];
    const material = this.material(`material-${entity.entityId}`, '#ffffff');
    const mesh = createItemMesh(`item-${entity.entityId}`, type, this.scene);
    if (type.model === 'box') {
      mesh.enableEdgesRendering();
      mesh.edgesWidth = 1.5;
      mesh.edgesColor = new Color4(0.24, 0.17, 0.1, 0.6);
    }
    mesh.parent = root;
    mesh.material = material;
    mesh.receiveShadows = true;
    this.shadow.addShadowCaster(mesh, true);
    return { root, material };
  }
  pointerRay() {
    const ray = this.scene.createPickingRay(
      this.scene.pointerX,
      this.scene.pointerY,
      Matrix.Identity(),
      this.camera,
    );
    return {
      from: { x: ray.origin.x, y: ray.origin.y, z: ray.origin.z },
      to: {
        x: ray.origin.x + ray.direction.x * 5000,
        y: ray.origin.y + ray.direction.y * 5000,
        z: ray.origin.z + ray.direction.z * 5000,
      },
    };
  }
  showPlacement(typeId?: string, pose?: ItemPose, valid = false) {
    if (!typeId || !pose) {
      this.ghost?.setEnabled(false);
      return;
    }
    if (!this.ghost || this.ghostType !== typeId) {
      this.ghost?.dispose(false, true);
      this.ghost = createItemMesh(
        'placement-preview',
        this.definition.itemCatalog.types[typeId],
        this.scene,
      );
      this.ghost.useVertexColors = false;
      this.ghost.isPickable = false;
      this.ghost.material = this.material('placement-preview', '#65d6bc');
      this.ghostType = typeId;
    }
    this.ghost.setEnabled(true);
    this.ghost.position.copyFrom(vector(pose.position));
    this.ghost.rotationQuaternion = new Quaternion(
      pose.rotation.x,
      pose.rotation.y,
      pose.rotation.z,
      pose.rotation.w,
    );
    const material = this.ghost.material as StandardMaterial;
    material.alpha = 0.45;
    material.diffuseColor = Color3.FromHexString(valid ? '#65d6bc' : '#ed7272');
    material.emissiveColor = material.diffuseColor.scale(0.3);
  }
  /** Projects a world point to CSS pixels of the canvas. `visible` is false behind the camera or off-screen. */
  project(position: Vec3, out: { x: number; y: number; visible: boolean }): void {
    const width = this.engine.getRenderWidth(true);
    const height = this.engine.getRenderHeight(true);
    const viewport = this.camera.viewport.toGlobal(width, height);
    this.labelPosition.set(position.x, position.y, position.z);
    Vector3.ProjectToRef(
      this.labelPosition,
      this.projection,
      this.scene.getTransformMatrix(),
      viewport,
      this.projectedLabel,
    );
    const cssWidth = this.canvas.clientWidth;
    const cssHeight = this.canvas.clientHeight;
    out.x = (this.projectedLabel.x * cssWidth) / width;
    out.y = (this.projectedLabel.y * cssHeight) / height;
    out.visible =
      this.projectedLabel.z >= 0 &&
      this.projectedLabel.z <= 1 &&
      out.x >= 0 &&
      out.x <= cssWidth &&
      out.y >= 0 &&
      out.y <= cssHeight;
  }
  /** Pulsing hexagon decal on the ground under an interactable item; pass undefined to clear. */
  setItemRing(entityId: string | undefined, hex = '#6ee0c4'): void {
    if (!entityId) {
      if (this.ring) {
        this.ring.target = undefined;
        this.ring.mesh.setEnabled(false);
      }
      return;
    }
    if (!this.ring) {
      const mesh = MeshBuilder.CreateDisc('item-ring', { radius: 1, tessellation: 6 }, this.scene);
      mesh.rotation.x = Math.PI / 2;
      mesh.isPickable = false;
      const material = new StandardMaterial('item-ring', this.scene);
      material.disableLighting = true;
      material.backFaceCulling = false;
      mesh.material = material;
      this.ring = { mesh, material };
    }
    this.ring.target = entityId;
    this.ring.material.emissiveColor = Color3.FromHexString(hex);
    this.ring.mesh.setEnabled(true);
  }
  private updateRing(): void {
    const ring = this.ring;
    if (!ring?.target) return;
    const bounds = this.itemBounds(ring.target);
    if (!bounds) return ring.mesh.setEnabled(false);
    const radius = 0.55 + Math.max(0, bounds.top - bounds.bottom) * 0.6;
    ring.mesh.position.set(bounds.x, bounds.bottom + 0.04, bounds.z);
    ring.mesh.scaling.setAll(radius);
    ring.mesh.setEnabled(true);
    ring.material.alpha = this.reducedMotion.matches
      ? 0.5
      : 0.3 + 0.35 * (0.5 + 0.5 * Math.sin(performance.now() / 255));
  }
  /** World-space extent of a replicated item, used to anchor prompts and ground rings. */
  itemBounds(entityId: string): { x: number; z: number; top: number; bottom: number } | undefined {
    const view = this.entities.get(entityId);
    if (!view) return;
    let top = -Infinity;
    let bottom = Infinity;
    for (const mesh of view.root.getChildMeshes()) {
      const box = mesh.getBoundingInfo().boundingBox;
      top = Math.max(top, box.maximumWorld.y);
      bottom = Math.min(bottom, box.minimumWorld.y);
    }
    if (!Number.isFinite(top)) return;
    return { x: view.root.position.x, z: view.root.position.z, top, bottom };
  }
  private positionLabels(): void {
    const width = this.engine.getRenderWidth(true);
    const height = this.engine.getRenderHeight(true);
    const viewport = this.camera.viewport.toGlobal(width, height);
    const cssWidth = this.canvas.clientWidth;
    const cssHeight = this.canvas.clientHeight;
    const labelHeight = this.definition.simulation.character.height / 2 + 0.5;
    const anchors: [LabelAnchor, Vector3, number, number][] = [];
    for (const view of this.entities.values())
      if (view.label) anchors.push([view as LabelAnchor, view.root.position, labelHeight, 500]);
    for (const landmark of this.landmarks)
      anchors.push([landmark, landmark.position, 0, this.radial.radius]);
    for (const [view, position, lift, radius] of anchors) {
      this.labelPosition.copyFrom(position);
      this.labelPosition.y += lift;
      Vector3.ProjectToRef(
        this.labelPosition,
        this.projection,
        this.scene.getTransformMatrix(),
        viewport,
        this.projectedLabel,
      );
      const x = (this.projectedLabel.x * cssWidth) / width;
      const y = (this.projectedLabel.y * cssHeight) / height;
      const opacity = radialOpacity(this.radial.center, position, radius);
      view.label.style.opacity = String(opacity);
      const hidden =
        opacity <= 0.01 ||
        this.projectedLabel.z < 0 ||
        this.projectedLabel.z > 1 ||
        x < 0 ||
        x > cssWidth ||
        y < 0 ||
        y > cssHeight;
      if (view.label.hidden !== hidden) view.label.hidden = hidden;
      if (view.reaction) {
        view.reaction.hidden = hidden;
        view.reaction.style.filter = `opacity(${opacity})`;
        view.reaction.style.transform = `translate(${(x + 38).toFixed(2)}px, ${(y - 30).toFixed(2)}px) translate(-50%, -100%)`;
      }
      if (view.chat) {
        view.chat.hidden = hidden;
        view.chat.style.filter = `opacity(${opacity})`;
        // Keep text above the name and any simultaneous reaction. Clamp horizontally
        // so a long line near the edge of the viewport remains readable.
        const halfWidth = view.chat.offsetWidth / 2;
        const chatX = Math.min(cssWidth - halfWidth - 8, Math.max(halfWidth + 8, x));
        const chatY = Math.max(view.chat.offsetHeight + 8, y - (view.reaction ? 104 : 34));
        view.chat.style.transform = `translate(${chatX.toFixed(2)}px, ${chatY.toFixed(2)}px) translate(-50%, -100%)`;
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
    this.canvas.removeEventListener('wheel', this.wheel);
    document.removeEventListener('visibilitychange', this.visibilityChanged);
    this.engine.stopRenderLoop();
    for (const view of this.entities.values()) this.disposeEntity(view);
    this.entities.clear();
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
