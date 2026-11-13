import { Ray } from '@babylonjs/core/Culling/ray';
import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera';
import { Camera } from '@babylonjs/core/Cameras/camera';
import { Vector3, Quaternion, Matrix } from '@babylonjs/core/Maths/math.vector';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { createModelVisual, type ModelResourceReader } from './model-visual';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { LinesMesh } from '@babylonjs/core/Meshes/linesMesh';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import type { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import { SceneInstrumentation } from '@babylonjs/core/Instrumentation/sceneInstrumentation';
import '@babylonjs/core/Rendering/edgesRenderer';
import {
  findReaction,
  normalizeYaw,
  type ItemPose,
  type Vec3,
  type WorldDefinition,
  type WorldHeader,
  type WorldCell,
  type StaticEntityDefinition,
  type BuildingInstance,
  type BuildingAssetManifest,
  type WorldManifest,
} from '@su/contracts';
import { decorateWorld } from './world-decoration';
import { StaticViews } from './statics';
import { applyRadialFog, radialOpacity, type RadialState } from './radial-fog';
import { Frustum } from '@babylonjs/core/Maths/math.frustum';
import { BoundingInfo } from '@babylonjs/core/Culling/boundingInfo';
import { worldCellBounds } from '@su/contracts';
import { renderQualitySettings, type RenderQuality } from './render-quality';
import { WorldEnvironment } from './environment/world-environment';
import type { DayClock, WorldWeather } from '@su/contracts';
import { BuildingViews } from './buildings';
import {
  CameraOrbit,
  INITIAL_CAMERA_ANGLE,
  FIRST_PERSON,
  yawFromOrbit,
  orbitFromYaw,
} from './camera-controller';
import type { DisplayEntity, DisplayPlayer } from '../presentation/display-state';
import { ReactionSoundGate } from '../presentation/reaction-sounds';
import { createSign } from '../ui/player-sign';
import type { GameAudio } from '../audio/game-audio';
import { AvatarView } from './avatars/avatar-view';
import { createItemMesh } from './items';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import type { StaticObjectSelection } from './static-selection';

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
  occlusion?: { at: number; blocked: boolean };
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
/** Пределы масштаба колёсиком мыши относительно исходного кадра. */
const MIN_ZOOM = 0.6;
const MAX_ZOOM = 30;

export class WorldView {
  readonly engine: Engine;
  readonly scene: Scene;
  private readonly camera: ArcRotateCamera;
  private readonly eyeCamera: FreeCamera;
  private firstPerson = false;
  private yaw = 0;
  private pitch = 0;
  private eyePosition?: Vec3;
  private overlayTest?: (from: Vec3, to: Vec3, targetId?: string) => boolean;
  private readonly environment: WorldEnvironment;
  private readonly shadow: ShadowGenerator;
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
  private audio?: GameAudio;
  private readonly reactionSounds = new ReactionSoundGate();
  private ring?: { mesh: Mesh; material: StandardMaterial; target?: string };
  private staticHighlight?: { mesh: LinesMesh; target?: string };
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
  private cameraFrameHook?: (now: number, delta: number) => void;
  private lastFrame = performance.now();
  private readonly visibilityChanged = () => {
    // A suspended background tab is not a rendered frame. Keep visible slow frames intact.
    this.lastFrame = performance.now();
    for (const view of this.entities.values()) view.avatar?.resetMotion();
    this.reactionSounds.suspend();
    if (document.hidden) {
      this.audio?.setListener(undefined);
      this.audio?.stopWorld();
    }
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
    this.scene.useRightHandedSystem = true;
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
    this.eyeCamera = new FreeCamera('first-person', Vector3.Zero(), this.scene);
    this.eyeCamera.inputs.clear();
    this.eyeCamera.fov = FIRST_PERSON.fov;
    this.eyeCamera.fovMode = Camera.FOVMODE_VERTICAL_FIXED;
    this.eyeCamera.minZ = FIRST_PERSON.minZ;
    this.eyeCamera.maxZ = FIRST_PERSON.maxZ;
    this.scene.activeCamera = this.camera;
    this.environment = new WorldEnvironment(this.scene, this.camera, [this.eyeCamera]);
    this.shadow = this.environment.shadow;
    this.applyQuality();
    this.sizeCamera();
    // Неподвижный мир отбрасывает тени в кэшируемую карту; аватары и предметы — в покадровую.
    this.buildings = new BuildingViews(
      this.scene,
      this.environment.staticShadow,
      definition,
      this.radial,
      this.environment.nightLights,
    );
    this.statics = new StaticViews(this.scene, this.environment.staticShadow);
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
      this.inputFrameHook?.(now, delta);
      this.camera.alpha = this.cameraOrbit.advance(delta);
      this.frameHook?.(now, delta);
      this.camera.setTarget(
        Vector3.Lerp(this.camera.target, this.target, 1 - Math.exp(-Math.min(delta, 0.1) * 5)),
        false,
        false,
        true, // Following translates the rig; pitch, orbit angle and radius remain fixed.
      );
      if (this.firstPerson && this.eyePosition) {
        this.eyeCamera.position.copyFrom(vector(this.eyePosition));
        this.eyeCamera.position.y += this.definition.simulation.character.height / 2 - 0.2;
        const cosPitch = Math.cos(this.pitch);
        this.eyeCamera.setTarget(
          this.eyeCamera.position.add(
            new Vector3(
              Math.sin(this.yaw) * cosPitch,
              Math.sin(this.pitch),
              Math.cos(this.yaw) * cosPitch,
            ),
          ),
        );
      }
      const active = this.activeCamera;
      this.environment.update({
        target: this.ownPosition ?? this.target,
        // On foot the cloud shadows remain, while the overhead layer is hidden.
        zoom: this.firstPerson ? 0 : this.zoom,
        visible: this.radial,
      });
      active.getViewMatrix(true);
      active.getProjectionMatrix(true);
      this.scene.updateTransformMatrix(true);
      this.cameraFrameHook?.(now, delta);
      const desiredRadius = this.firstPerson
        ? Math.min(FIRST_PERSON.radius, this.streamingRadius)
        : this.streamingRadius;
      this.radial.radius =
        desiredRadius < this.radial.radius
          ? desiredRadius
          : Math.min(
              desiredRadius,
              this.radial.radius + (Math.max(1, desiredRadius) * delta) / 0.3,
            );
      this.dynamicRadial.radius = this.firstPerson ? this.radial.radius : 500;
      this.buildings.update(
        this.ownPosition,
        active.globalPosition,
        active.getForwardRay().direction,
        active.minZ,
        now,
        delta,
        this.ownPosition ?? this.target,
        this.radial.radius,
        this.firstPerson,
      );
      this.statics.updateShadows(this.ownPosition ?? this.target, this.radial.radius);
      const center = this.ownPosition ?? this.target;
      this.radial.center = this.dynamicRadial.center = center;
      this.radial.time = this.dynamicRadial.time = now;
      this.radial.appearMs = this.dynamicRadial.appearMs = this.reducedMotion.matches ? 80 : 300;
      if (this.staticHighlight?.target) this.highlightStaticObject(this.staticHighlight.target);
      this.positionLabels();
      this.scene.render();
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
    this.engine.setHardwareScalingLevel(settings.hardwareScaling);
    this.engine.resize();
    this.environment.setQuality(this.quality);
  }
  setQuality(quality: RenderQuality): void {
    if (quality === this.quality) return;
    this.quality = quality;
    this.applyQuality();
    this.sizeCamera();
  }
  /** Holds the world at one game hour (0..24); `undefined` returns to the running clock. */
  setTimeOfDay(hour?: number): void {
    this.environment.setTimeOfDay(hour);
  }
  /** Игровой час последнего кадра (0..24): по нему интерфейс выбирает тему и показывает часы. */
  get hour(): number {
    return this.environment.hour;
  }
  /** Часы комнаты, которыми управляет `/time`; закреплённый `setTimeOfDay` час важнее. */
  setDayClock(clock: DayClock): void {
    this.environment.setDayClock(clock);
  }
  /** Погода комнаты, которой управляет `/weather`. */
  setWeather(weather: WorldWeather): void {
    this.environment.setWeather(weather);
  }
  get cameraAngle(): number {
    return this.firstPerson ? orbitFromYaw(this.yaw) : this.cameraOrbit.angle;
  }
  private get activeCamera(): Camera {
    return this.firstPerson ? this.eyeCamera : this.camera;
  }
  get facingYaw(): number {
    return this.yaw;
  }
  setFirstPerson(enabled: boolean): void {
    if (enabled === this.firstPerson) return;
    this.stopCamera();
    if (enabled) {
      this.yaw = yawFromOrbit(this.cameraOrbit.angle);
      this.pitch = 0;
      this.setItemRing(undefined);
      this.showPlacement();
    } else {
      this.cameraOrbit.setAngle(orbitFromYaw(this.yaw));
      this.camera.alpha = this.cameraOrbit.angle;
      this.camera.setTarget(this.target.clone(), false, false, true);
    }
    this.firstPerson = enabled;
    this.scene.activeCamera = this.activeCamera;
    this.graphicalFrame = undefined;
    this.sizeCamera();
    for (const [id, view] of this.entities) {
      view.occlusion = undefined;
      view.root.setEnabled(!enabled || id !== this.followed);
    }
  }
  lookBy(x: number, y: number): void {
    if (!this.firstPerson || !Number.isFinite(x) || !Number.isFinite(y)) return;
    // A right turn decreases world yaw in Babylon's right-handed scene.
    this.yaw = normalizeYaw(this.yaw - x * FIRST_PERSON.sensitivity);
    this.pitch = Math.max(
      -FIRST_PERSON.pitchLimit,
      Math.min(FIRST_PERSON.pitchLimit, this.pitch - y * FIRST_PERSON.sensitivity),
    );
  }
  setOverlayTest(test: (from: Vec3, to: Vec3, targetId?: string) => boolean): void {
    this.overlayTest = test;
  }
  setAudio(audio: GameAudio): void {
    if (this.audio === audio) return;
    this.audio?.setListener(undefined);
    this.audio?.stopWorld();
    this.audio = audio;
    this.reactionSounds.suspend();
    for (const view of this.entities.values()) view.avatar?.resetMotion();
  }
  setCameraRotation(direction: -1 | 0 | 1): void {
    if (!this.firstPerson) this.cameraOrbit.setDirection(direction);
  }
  rotateCameraBy(radians: number): void {
    if (!this.firstPerson) this.cameraOrbit.rotateBy(radians);
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
    if (this.staticHighlight?.target === entityId) this.highlightStaticObject(entityId);
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
    const shadows = this.environment.shadowDiagnostics();
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
      hour: this.environment.hour,
      nightLampSources: this.environment.nightLights.sourceCount,
      bloom: this.environment.bloomDiagnostics(),
      lights: this.scene.lights.map((light) => ({
        name: light.name,
        type: light.getClassName(),
        intensity: light.intensity,
        diffuse: { r: light.diffuse.r, g: light.diffuse.g, b: light.diffuse.b },
      })),
      dynamicEntities: [...this.entities].map(([entityId, view]) => ({
        entityId,
        position: { x: view.root.position.x, y: view.root.position.y, z: view.root.position.z },
        rotation: {
          x: view.root.rotationQuaternion!.x,
          y: view.root.rotationQuaternion!.y,
          z: view.root.rotationQuaternion!.z,
          w: view.root.rotationQuaternion!.w,
        },
        visible: view.root.isEnabled(),
        overlayBlocked: view.occlusion?.blocked ?? false,
        overlayVisible: view.label ? !view.label.hidden : false,
      })),
      geometries: this.scene.geometries.length,
      nodes: this.scene.transformNodes.length,
      textures: this.scene.textures.length,
      shadowCasters: shadows.staticCasters + shadows.dynamicCasters,
      shadowMaps: shadows,
      streaming: {
        drawRadius: this.graphicalArea().drawRadius,
        readyRadius: this.streamingRadius,
        shownRadius: this.radial.radius,
      },
      meshes: this.scene.meshes.length,
      transformNodes: this.scene.transformNodes.length,
      materials: this.scene.materials.length,
      pipelines: (this.scene.postProcessRenderPipelineManager?.supportedPipelines ?? []).map(
        (pipeline) => ({
          name: pipeline.name,
          cameras: pipeline.cameras.map((camera) => camera.name),
        }),
      ),
      drawCalls: this.instrumentation.drawCallsCounter.current,
      renderer: this.engine.getGlInfo(),
      camera: {
        mode: this.firstPerson ? 'first-person' : 'overview',
        yaw: this.yaw,
        pitch: this.pitch,
        position: {
          x: this.activeCamera.position.x,
          y: this.activeCamera.position.y,
          z: this.activeCamera.position.z,
        },
        fov: this.activeCamera.fov,
        minZ: this.activeCamera.minZ,
        maxZ: this.activeCamera.maxZ,
        cameras: this.scene.cameras.length,
        azimuth: this.cameraAngle,
        turning: this.cameraOrbit.turning,
        halfWidth: this.camera.orthoRight!,
        halfHeight: this.camera.orthoTop!,
        beta: this.camera.beta,
        zoom: this.zoom,
        target: { x: this.camera.target.x, y: this.camera.target.y, z: this.camera.target.z },
      },
      buildings: this.buildings.aggregateDiagnostics(),
    };
  }
  graphicalArea() {
    this.activeCamera.getViewMatrix(true);
    const center = this.ownPosition ?? this.target;
    const matrix = this.activeCamera.getTransformationMatrix();
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
    this.buildings?.setDetailScale(
      this.firstPerson ? 0 : (2 * halfHeight) / Math.max(1, this.canvas.clientHeight),
    );
    this.graphicalFrame = undefined;
  }
  private readonly wheel = (event: WheelEvent) => {
    event.preventDefault();
    if (this.touchMode || this.gamepadMode || this.firstPerson) return;
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
  private gamepadMode = false;
  setGamepadMode(enabled: boolean): void {
    this.gamepadMode = enabled;
    if (enabled) {
      this.zoom = 1;
      this.sizeCamera();
    }
  }
  onFrame(callback: (now: number, delta: number) => void): void {
    this.frameHook = callback;
  }
  private inputFrameHook?: (now: number, delta: number) => void;
  /** Samples local controls before the orbit advances and movement reads its actual angle. */
  onInputFrame(callback: (now: number, delta: number) => void): void {
    this.inputFrameHook = callback;
  }
  onCameraFrame(callback: (now: number, delta: number) => void): void {
    this.cameraFrameHook = callback;
  }
  follow(id?: string): void {
    this.followed = id;
    if (!id) {
      this.audio?.setListener(undefined);
      this.audio?.stopWorld();
      this.reactionSounds.suspend();
      const bounds = this.definition.bounds;
      if (bounds.min.x <= 0 && bounds.max.x >= 0 && bounds.min.z <= 0 && bounds.max.z >= 0)
        this.target.setAll(0);
      else {
        this.target.copyFrom(vector(this.definition.spawnPoints[0]));
      }
    }
  }
  update(
    entities: DisplayEntity[],
    ownId: string | undefined,
    delta: number,
    physicalPosition?: Vec3,
  ): void {
    this.ownPosition = undefined;
    this.eyePosition = physicalPosition;
    const ownPlayer = entities.find(
      (entity): entity is DisplayPlayer => entity.entityId === ownId && entity.kind === 'player',
    );
    const audible = !!ownPlayer && ownPlayer.connected !== false && !document.hidden;
    // The orthographic orbit can be kilometres away: distance belongs to the avatar.
    // Set this before any entity emits, regardless of entity ordering in the snapshot.
    this.audio?.setListener(
      audible
        ? this.firstPerson && physicalPosition
          ? physicalPosition
          : ownPlayer.position
        : undefined,
      this.cameraAngle,
    );
    const reactions = this.reactionSounds.update(
      entities.filter((entity): entity is DisplayPlayer => entity.kind === 'player'),
      audible && Number.isFinite(delta) && delta > 0 && delta <= 0.25,
    );
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
      view.root.setEnabled(!this.firstPerson || entity.entityId !== ownId);
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
          // Знак игрока и имя; своя подпись показывает «Вы».
          const text = document.createElement('span');
          text.textContent = own ? 'Вы' : name;
          const suffixes = offline
            ? [
                Object.assign(document.createElement('span'), {
                  className: 'note',
                  textContent: '· нет связи',
                }),
              ]
            : [];
          view.label.replaceChildren(createSign(name, entity.color ?? ''), text, ...suffixes);
          view.label.dataset.name = name;
          view.labelText = key;
        }
      }
      if (entity.kind === 'player') {
        const own = entity.entityId === ownId;
        const contacts = view.avatar!.update(entity, delta, own, this.reducedMotion.matches);
        // A slow rendered frame can cross two contacts; never play an audible catch-up burst.
        if (audible && contacts.count > 0)
          this.audio?.playWorld(contacts.running ? 'run' : 'step', entity.position, {
            sourceId: entity.entityId,
            own,
          });
        if (reactions.has(entity.entityId))
          this.audio?.playWorld('reaction', entity.position, { sourceId: entity.entityId, own });
      } else if (view.material) view.material.alpha = entity.connected === false ? 0.45 : 1;
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
        this.target.set(
          entity.position.x,
          entity.position.y - this.definition.simulation.character.height / 2,
          entity.position.z,
        );
    }
    if (this.firstPerson && physicalPosition) this.ownPosition = vector(physicalPosition);
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
      label.dataset.entityId = entity.entityId;
      this.labels.append(label);
      return { root, label, avatar };
    }
    const type = this.definition.itemCatalog.types[entity.typeId];
    const material = this.material(`material-${entity.entityId}`, '#ffffff');
    const mesh = createItemMesh(`item-${entity.entityId}`, type, this.scene);
    // Bevels and board seams provide the crate's silhouette without a screen-space outline.
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
      this.activeCamera,
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
  getStaticObject(entityId: string): StaticObjectSelection | undefined {
    return this.buildings.selection(entityId);
  }
  pickStaticObject(
    protectedEntityIds: ReadonlySet<string> = new Set(),
  ): StaticObjectSelection | undefined {
    const { from, to } = this.pointerRay();
    const direction = vector(to).subtract(vector(from)).normalize();
    const ray = new Ray(vector(from), direction, this.activeCamera.maxZ);
    const hit = this.buildings.pick(ray, protectedEntityIds);
    if (!hit) return;
    const { distance: _distance, ...selection } = hit;
    return selection;
  }
  /** A private bounds cage makes the whole deletion unit visible without cloning materials. */
  highlightStaticObject(entityId?: string): void {
    const selection = entityId ? this.getStaticObject(entityId) : undefined;
    if (!selection) {
      if (this.staticHighlight) {
        this.staticHighlight.target = undefined;
        this.staticHighlight.mesh.setEnabled(false);
      }
      return;
    }
    if (!this.staticHighlight) {
      const corners = Array.from(
        { length: 8 },
        (_, index) =>
          new Vector3(index & 1 ? 0.5 : -0.5, index & 2 ? 0.5 : -0.5, index & 4 ? 0.5 : -0.5),
      );
      const lines: Vector3[][] = [];
      for (let index = 0; index < 8; index++)
        for (const bit of [1, 2, 4])
          if (!(index & bit)) lines.push([corners[index], corners[index | bit]]);
      const mesh = MeshBuilder.CreateLineSystem('static-removal-highlight', { lines }, this.scene);
      mesh.color = Color3.FromHexString('#ff8b63');
      mesh.isPickable = false;
      this.staticHighlight = { mesh };
    }
    const { mesh } = this.staticHighlight;
    this.staticHighlight.target = entityId;
    const minimum = vector(selection.minimum),
      maximum = vector(selection.maximum);
    mesh.position.copyFrom(minimum.add(maximum).scale(0.5));
    mesh.scaling.copyFrom(maximum.subtract(minimum).add(new Vector3(0.06, 0.06, 0.06)));
    mesh.setEnabled(true);
  }
  /** An isolated local model; neither cell references nor the inventory ghost own it. */
  async createStaticGhost(
    descriptor: BuildingAssetManifest,
    read: ModelResourceReader,
    signal?: AbortSignal,
  ) {
    const visual = await createModelVisual(this.scene, descriptor, read, 'placement-ghost', signal);
    if (this.disposed) {
      visual.dispose();
      throw new Error('View disposed');
    }
    return visual;
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
    const viewport = this.activeCamera.viewport.toGlobal(width, height);
    this.labelPosition.set(position.x, position.y, position.z);
    Vector3.ProjectToRef(
      this.labelPosition,
      this.projection,
      this.activeCamera.getTransformationMatrix(),
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
    const viewport = this.activeCamera.viewport.toGlobal(width, height);
    const cssWidth = this.canvas.clientWidth;
    const cssHeight = this.canvas.clientHeight;
    const labelHeight = this.definition.simulation.character.height / 2 + 0.5;
    const anchors: [LabelAnchor, Vector3, number, number][] = [];
    for (const view of this.entities.values())
      if (view.label)
        anchors.push([
          view as LabelAnchor,
          view.root.position,
          labelHeight,
          this.dynamicRadial.radius,
        ]);
    for (const landmark of this.landmarks)
      anchors.push([landmark, landmark.position, 0, this.radial.radius]);
    for (const [view, position, lift, radius] of anchors) {
      this.labelPosition.copyFrom(position);
      this.labelPosition.y += lift;
      Vector3.ProjectToRef(
        this.labelPosition,
        this.projection,
        this.activeCamera.getTransformationMatrix(),
        viewport,
        this.projectedLabel,
      );
      const x = (this.projectedLabel.x * cssWidth) / width;
      const y = (this.projectedLabel.y * cssHeight) / height;
      const opacity = radialOpacity(this.radial.center, position, radius);
      view.label.style.opacity = String(opacity);
      let hidden =
        opacity <= 0.01 ||
        this.projectedLabel.z < 0 ||
        this.projectedLabel.z > 1 ||
        x < 0 ||
        x > cssWidth ||
        y < 0 ||
        y > cssHeight;
      if (this.firstPerson) {
        const entity = view as EntityView;
        if (view === this.entities.get(this.followed ?? '')) hidden = true;
        if (!hidden && this.overlayTest) {
          const now = performance.now();
          if (!entity.occlusion || now - entity.occlusion.at >= 100) {
            const targetId = view.label.dataset.entityId;
            const sightTarget = targetId
              ? {
                  x: position.x,
                  y: position.y + this.definition.simulation.character.height / 2 - 0.2,
                  z: position.z,
                }
              : this.labelPosition;
            entity.occlusion = {
              at: now,
              blocked: this.overlayTest(this.eyeCamera.position, sightTarget, targetId),
            };
          }
          hidden = entity.occlusion.blocked;
        }
      }
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
    this.audio?.setListener(undefined);
    this.audio?.stopWorld();
    this.reactionSounds.clear();
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
      this.environment.dispose();
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
