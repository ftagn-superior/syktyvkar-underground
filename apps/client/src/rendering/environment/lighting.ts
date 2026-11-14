import type { Scene } from '@babylonjs/core/scene';
import type { Camera } from '@babylonjs/core/Cameras/camera';
import { TmpVectors, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import { RenderTargetTexture } from '@babylonjs/core/Materials/Textures/renderTargetTexture';
import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import type { SubMesh } from '@babylonjs/core/Meshes/subMesh';
import type { Observer } from '@babylonjs/core/Misc/observable';
import '@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent';
import { DefaultRenderingPipeline } from '@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline';
import { ImageProcessingConfiguration } from '@babylonjs/core/Materials/imageProcessingConfiguration';
import { ColorCurves } from '@babylonjs/core/Materials/colorCurves';
import { renderQualitySettings, type RenderQuality } from '../render-quality';
import { REFERENCE_HOUR, skyAt, type Sky } from './day-cycle';
import { darkness } from './night-schedule';
import { CLEAR_AMOUNTS, type WeatherAmounts } from './weather-mix';
import { weatherSky } from './weather-sky';
import { GLOW_MASK_SUPPORTED, glowMaskPatches } from './glow-mask';
import { shadowUpdatesMuted } from '../shadow-casters';

/** Сторона квадрата теней в метрах и удаление солнца от цели камеры. */
const SHADOW_EXTENT = 90;
const SUN_DISTANCE = 150;
const SHADOW_MAP_SIZE = 2048;
/**
 * Солнце следует за камерой шагами в целое число текселей карты теней. Между шагами
 * проекция теней не меняется, поэтому неподвижный город можно не перерисовывать,
 * а края теней не дрожат при движении камеры.
 */
const SHADOW_STEPS = [90, 180, 360, 720] as const;
/**
 * Свет поворачивается шагами, а не непрерывно: каждый поворот меняет проекцию теней
 * и требует перерисовать карту неподвижного мира. Шаг в 0,1° на глаз незаметен.
 */
const LIGHT_STEP_COS = Math.cos((0.1 * Math.PI) / 180);
/**
 * Ореол ночных огней. Размываются только пиксели, помеченные шейдером огней
 * (см. `glow-mask.ts`): окна, витрины, вывески и плафоны, но не освещённые фонарями
 * стены. Днём ореол выключен целиком: проходы размытия стоили бы кадра впустую.
 */
const BLOOM_WEIGHT = 1.5;
/**
 * Запасной порог яркости (с учётом экспозиции), если метку огней поставить нельзя:
 * выше освещённых луной стен, ниже окон. Пятна под фонарями тогда тоже светятся.
 */
const BLOOM_THRESHOLD = 0.2;
const BLOOM_KERNEL = 64;
const BLOOM_SCALE = 0.5;
/** Темнота, с которой включается ореол; ниже неё его вес и так незаметен. */
const BLOOM_MIN_DARK = 0.05;
/** Тон теней (холодный синий) и светов (тёплый янтарный) в градусах ColorCurves. */
const SHADOWS_HUE = 225;
const HIGHLIGHTS_HUE = 35;
/**
 * Шаг веса виньетки. Каждое изменение помечает материалы экономичного режима
 * (там коррекция в их шейдерах), поэтому вес меняется ступенями, а не каждый кадр.
 */
const VIGNETTE_STEP = 0.05;

/** Both game cameras sample the same composed map, with one fixed light-space projection. */
class WorldSun extends DirectionalLight {
  constructor(
    scene: Scene,
    private readonly shadowCamera: Camera,
  ) {
    super('sun', new Vector3(0, -1, 0), scene);
  }

  override getShadowGenerator(camera: Camera | null = null) {
    // Keep the registry at two unique generators: Babylon renders every registry entry.
    // Only receiver selection changes; the default generator remains the static cache.
    return super.getShadowGenerator(camera ? this.shadowCamera : null);
  }
}

/** A rejected refresh can restore a projection within the same Babylon render id. */
class WorldShadowGenerator extends ShadowGenerator {
  resetProjection(): void {
    this._currentRenderId = -1;
    this.getLight().forceProjectionMatrixCompute();
  }
}

type ShadowProjection = {
  position: Vector3;
  direction: Vector3;
  extent: number;
  near: number;
  far: number;
  bias: number;
  normalBias: number;
};

const MAX_INCOMPLETE_REFRESHES = 5;

/**
 * Тени неподвижного мира. Карта рисуется один раз и обновляется только по запросу:
 * при изменении списка источников, их геометрии или проекции солнца.
 */
export class StaticShadowGenerator extends WorldShadowGenerator {
  /** Сколько раз карта действительно перерисована; для диагностики. */
  refreshes = 0;
  incomplete = false;
  private rendering = false;

  /** Call after the generator's filtering is configured: reconfiguring recreates the map. */
  cache(before: () => void, after: () => void): void {
    const map = this.getShadowMap()!;
    map.refreshRate = RenderTargetTexture.REFRESHRATE_RENDER_ONCE;
    map.onBeforeBindObservable.add(() => {
      before();
      this.incomplete = false;
      this.rendering = false;
    });
    // Prewarming also emits before/after-render, but never clears a target.
    map.onClearObservable.add(() => {
      this.rendering = true;
    });
    map.onAfterRenderObservable.add(() => {
      if (!this.rendering) return;
      this.rendering = false;
      this.refreshes++;
      after();
    });
  }
  override isReady(subMesh: SubMesh, useInstances: boolean, isTransparent: boolean): boolean {
    const ready = super.isReady(subMesh, useInstances, isTransparent);
    // Prewarming is not an attempted map: only actual skipped draws reject a refresh.
    if (this.rendering && !ready) this.incomplete = true;
    return ready;
  }
  /** Requests one redraw on the next frame. Cheap to call repeatedly. */
  invalidate(): void {
    this.getShadowMap()?.resetRefreshCounter();
  }
  override addShadowCaster(mesh: AbstractMesh, includeDescendants = true): ShadowGenerator {
    if (!shadowUpdatesMuted(this) && this.covers(mesh, includeDescendants)) this.invalidate();
    return super.addShadowCaster(mesh, includeDescendants);
  }
  override removeShadowCaster(mesh: AbstractMesh, includeDescendants = true): ShadowGenerator {
    if (!shadowUpdatesMuted(this) && this.covers(mesh, includeDescendants)) this.invalidate();
    return super.removeShadowCaster(mesh, includeDescendants);
  }
  /**
   * Whether a caster can appear in the map at its current projection. Streaming registers
   * far buildings long before the camera reaches them; those must not cost a redraw.
   * The test is conservative: bounding spheres against the map's square footprint.
   */
  private covers(mesh: AbstractMesh, includeDescendants: boolean): boolean {
    const light = this.getLight() as DirectionalLight;
    const half = light.shadowFrustumSize / 2;
    if (!(half > 0)) return true;
    const forward = TmpVectors.Vector3[0].copyFrom(light.direction).normalize();
    const right = Vector3.CrossToRef(Vector3.UpReadOnly, forward, TmpVectors.Vector3[1]);
    right.normalize();
    const up = Vector3.CrossToRef(forward, right, TmpVectors.Vector3[2]);
    const offset = TmpVectors.Vector3[3];
    const inside = (candidate: AbstractMesh) => {
      const sphere = candidate.getBoundingInfo().boundingSphere;
      sphere.centerWorld.subtractToRef(light.position, offset);
      const reach = half + sphere.radiusWorld;
      return (
        Math.abs(Vector3.Dot(offset, right)) <= reach && Math.abs(Vector3.Dot(offset, up)) <= reach
      );
    };
    return inside(mesh) || (includeDescendants && mesh.getChildMeshes().some(inside));
  }
}

/**
 * Owns the world's lights, shadow maps and shared tone curve in both quality modes.
 *
 * The sun has two shadow maps with one projection. `staticShadow` holds buildings, trees
 * and other immovable casters and is redrawn only when invalidated. `shadow` is what
 * receivers sample: every frame it starts from a copy of the static depth and adds the
 * moving casters (avatars, items) on top.
 */
export class WorldLighting {
  /** Per-frame casters: avatars and items. This is the map receivers sample. */
  readonly shadow: WorldShadowGenerator;
  /** Immovable casters: buildings, trees, primitives. Cached between invalidations. */
  readonly staticShadow: StaticShadowGenerator;
  private readonly fill: HemisphericLight;
  private readonly sun: DirectionalLight;
  private pipeline?: DefaultRenderingPipeline;
  private readonly heldDepth?: RenderTargetTexture;
  private heldProjection?: ShadowProjection;
  private pendingProjection?: ShadowProjection;
  private incompleteRefreshes = 0;
  private discardedRefreshes = 0;
  private fallbackRefreshes = 0;
  private readonly contextRestored: Observer<AbstractEngine>;
  /** 0 днём, 1 ночью; управляет ореолом огней. */
  private dark = 0;
  private readonly forward = new Vector3();
  private readonly right = new Vector3();
  private readonly up = new Vector3();
  private readonly position = new Vector3();
  private readonly scratch = new Vector3();
  private readonly target = new Vector3();
  private readonly direction = new Vector3();
  private viewWidth = 0;

  constructor(
    private readonly scene: Scene,
    private readonly camera: Camera,
    private readonly additionalCameras: Camera[] = [],
  ) {
    // Economy applies this in the material shader; standard uses the HDR pipeline.
    // Changing quality must not change the art direction.
    const imageProcessing = scene.imageProcessingConfiguration;
    imageProcessing.toneMappingEnabled = true;
    imageProcessing.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
    imageProcessing.exposure = 1.5;
    imageProcessing.contrast = 1.05;
    imageProcessing.colorCurvesEnabled = true;
    imageProcessing.colorCurves = new ColorCurves();
    imageProcessing.colorCurves.globalSaturation = 8;
    // Тона теней и светов, насыщенность и виньетку задаёт час (`Sky.grade`).
    imageProcessing.colorCurves.shadowsHue = SHADOWS_HUE;
    imageProcessing.colorCurves.highlightsHue = HIGHLIGHTS_HUE;
    // Виньетка включена всегда, меняется только вес: переключение пересобрало бы шейдеры.
    imageProcessing.vignetteEnabled = true;
    imageProcessing.vignetteWeight = 0;
    imageProcessing.vignetteColor = new Color4(0, 0, 0, 0);
    // Пустота вокруг города; цвет задаёт час, туман на краю берёт его отсюда.
    scene.clearColor = Color4.FromHexString('#101820ff');
    scene.ambientColor = Color3.FromHexString('#8199ac');

    // Colours, strengths and the direction of both lights come from the day cycle.
    // PBR's hemispheric diffuse is stronger than its directional BRDF at the same
    // intensity; the cycle keeps this fill low enough for the facade orientations to read.
    const fill = (this.fill = new HemisphericLight('sky', new Vector3(0, 1, 0), scene));
    fill.specular = Color3.Black();
    // The direct light: the sun by day, the moon by night. It never turns with the camera.
    const sun = (this.sun = new WorldSun(scene, camera));
    // Карта теней покрывает квадрат вокруг камеры, а не весь город: иначе тени размываются.
    sun.shadowFrustumSize = SHADOW_EXTENT;
    sun.shadowMinZ = 0;
    sun.shadowMaxZ = SUN_DISTANCE * 2;
    // The default generator is the cache. All receivers use the composed generator,
    // which is registered once after the cache and rendered after it within the frame.
    this.staticShadow = new StaticShadowGenerator(SHADOW_MAP_SIZE, sun);
    // Occlusion alpha reveals the player; it does not change a building/tree silhouette.
    this.staticShadow.transparencyShadow = true;
    this.shadow = new WorldShadowGenerator(SHADOW_MAP_SIZE, sun, undefined, camera);
    for (const shadow of [this.staticShadow, this.shadow]) {
      // PCF даёт чёткий край у основания и мягкий на расстоянии, в отличие от размытой ESM.
      shadow.usePercentageCloserFiltering = true;
      shadow.filteringQuality = ShadowGenerator.QUALITY_HIGH;
      shadow.bias = 0.0012;
      shadow.normalBias = 0.08;
      shadow.setDarkness(0.22);
    }
    const engine = scene.getEngine();
    if ((engine as { _gl?: WebGL2RenderingContext })._gl?.blitFramebuffer) {
      // This target is never rendered by Babylon: it holds only the last published depth.
      this.heldDepth = new RenderTargetTexture('held-static-shadow', SHADOW_MAP_SIZE, scene, {
        generateMipMaps: false,
        generateDepthBuffer: true,
        noColorAttachment: true,
      });
      // A depth renderbuffer is attached immediately and blits like a depth texture.
      // A depth texture would defer its attachment until Babylon binds this target.
    }
    this.staticShadow.cache(
      () => this.restorePendingProjection(),
      () => this.publishStatic(),
    );
    this.contextRestored = engine.onContextRestoredObservable.add(() => {
      // Restored textures have no pixels from the old context.
      this.heldProjection = undefined;
      this.incompleteRefreshes = 0;
      this.staticShadow.invalidate();
    });
    this.shadow.getShadowMap()!.onClearObservable.add((engine) => this.startFromStatic(engine));
    this.setTimeOfDay(REFERENCE_HOUR);
  }

  /**
   * Lights the world for a game hour (0..24) under the current weather and returns the sky
   * it produced.
   * Colours and strengths follow the hour exactly. The direction of the direct light
   * advances in small steps, each of which redraws the cached static shadows once.
   */
  setTimeOfDay(hour: number, weather: WeatherAmounts = CLEAR_AMOUNTS): Sky {
    this.restorePendingProjection();
    const sky = weatherSky(skyAt(hour), weather);
    this.fill.intensity = sky.skyIntensity;
    this.fill.diffuse.set(...sky.skyColor);
    this.fill.groundColor.set(...sky.groundColor);
    this.sun.intensity = sky.lightIntensity;
    this.sun.diffuse.set(...sky.lightColor);
    this.dark = darkness(hour);
    this.applyBloom();
    this.applyAtmosphere(sky);
    const { x, y, z } = sky.lightDirection;
    const direction = this.direction.set(x, y, z);
    if (Vector3.Dot(direction, this.sun.direction) < LIGHT_STEP_COS) {
      this.sun.direction.copyFrom(direction);
      this.follow(this.target, this.viewWidth);
      this.staticShadow.invalidate();
    }
    return sky;
  }

  /**
   * Replaces the per-frame clear of the sampled map with a copy of the cached static depth.
   * Both maps share size, format and projection, so this is a plain depth blit.
   */
  private copyDepth(
    engine: AbstractEngine,
    sourceMap: RenderTargetTexture | null | undefined,
    targetMap: RenderTargetTexture | null | undefined,
    restoreMap: RenderTargetTexture | null | undefined,
  ): boolean {
    const gl = (engine as { _gl?: WebGL2RenderingContext })._gl;
    const framebuffer = (map: RenderTargetTexture | null | undefined) =>
      (map?.renderTarget as { _framebuffer?: WebGLFramebuffer | null } | null)?._framebuffer;
    const source = framebuffer(sourceMap);
    const target = framebuffer(targetMap);
    const restore = framebuffer(restoreMap);
    if (!gl?.blitFramebuffer || !source || !target || !restore) return false;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, source);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, target);
    gl.blitFramebuffer(
      0,
      0,
      SHADOW_MAP_SIZE,
      SHADOW_MAP_SIZE,
      0,
      0,
      SHADOW_MAP_SIZE,
      SHADOW_MAP_SIZE,
      gl.DEPTH_BUFFER_BIT,
      gl.NEAREST,
    );
    // Babylon tracks one binding for both targets; leave them equal again.
    gl.bindFramebuffer(gl.FRAMEBUFFER, restore);
    return true;
  }

  private captureProjection(): ShadowProjection {
    return {
      position: this.sun.position.clone(),
      direction: this.sun.direction.clone(),
      extent: this.sun.shadowFrustumSize,
      near: this.sun.shadowMinZ,
      far: this.sun.shadowMaxZ,
      bias: this.shadow.bias,
      normalBias: this.shadow.normalBias,
    };
  }

  private applyProjection(projection: ShadowProjection): void {
    this.sun.position.copyFrom(projection.position);
    this.sun.direction.copyFrom(projection.direction);
    this.sun.shadowFrustumSize = projection.extent;
    this.sun.shadowMinZ = projection.near;
    this.sun.shadowMaxZ = projection.far;
    for (const shadow of [this.staticShadow, this.shadow]) {
      shadow.bias = projection.bias;
      shadow.normalBias = projection.normalBias;
      shadow.resetProjection();
    }
  }

  private restorePendingProjection(): void {
    if (!this.pendingProjection) return;
    this.applyProjection(this.pendingProjection);
    this.pendingProjection = undefined;
  }

  private publishStatic(): void {
    if (this.staticShadow.incomplete) {
      this.incompleteRefreshes++;
      this.staticShadow.invalidate();
      if (this.incompleteRefreshes <= MAX_INCOMPLETE_REFRESHES) {
        this.discardedRefreshes++;
        if (this.heldProjection) {
          this.pendingProjection = this.captureProjection();
          this.applyProjection(this.heldProjection);
        }
        return;
      }
      // A permanently unready caster must not freeze the world's shadow projection.
      // Retry again next frame, and expose the degraded publication in diagnostics.
      this.fallbackRefreshes++;
    } else this.incompleteRefreshes = 0;
    this.copyDepth(
      this.scene.getEngine(),
      this.staticShadow.getShadowMap(),
      this.heldDepth,
      this.staticShadow.getShadowMap(),
    );
    this.heldProjection = this.captureProjection();
  }

  private startFromStatic(engine: AbstractEngine): void {
    const target = this.shadow.getShadowMap();
    if (!this.heldProjection || !this.copyDepth(engine, this.heldDepth, target, target)) {
      // Initial compilation or no WebGL2 target (NullEngine): dynamic casters still render.
      engine.clear(null, false, true, false);
    }
  }

  /** Standard adds HDR and MSAA; economy retains the same tone curve in its materials. */
  setQuality(quality: RenderQuality): void {
    const settings = renderQualitySettings(quality);
    this.scene.shadowsEnabled = settings.shadows;
    // Disabled shadows skip the map entirely; draw it afresh when they return.
    this.staticShadow.invalidate();
    if (!settings.postProcessing) {
      this.pipeline?.dispose();
      this.pipeline = undefined;
      return;
    }
    if (this.pipeline) return;
    const pipeline = new DefaultRenderingPipeline('lighting', true, this.scene, [
      this.camera,
      ...this.additionalCameras,
    ]);
    pipeline.samples = 4;
    pipeline.fxaaEnabled = false;
    pipeline.bloomThreshold = BLOOM_THRESHOLD;
    pipeline.bloomKernel = BLOOM_KERNEL;
    pipeline.bloomScale = BLOOM_SCALE;
    pipeline.bloomEnabled = false;
    this.pipeline = pipeline;
    this.applyBloom();
  }

  /** Пустота вокруг города, тон картинки и виньетка этого часа. */
  private applyAtmosphere(sky: Sky): void {
    this.scene.clearColor.set(...sky.backdrop, 1);
    const imageProcessing = this.scene.imageProcessingConfiguration;
    // ColorCurves пересчитываются при привязке, без пересборки шейдеров.
    const curves = imageProcessing.colorCurves!;
    curves.shadowsDensity = sky.grade.shadows;
    curves.highlightsDensity = sky.grade.highlights;
    curves.globalSaturation = sky.grade.saturation;
    const vignette = Math.round(sky.grade.vignette / VIGNETTE_STEP) * VIGNETTE_STEP;
    if (Math.abs(imageProcessing.vignetteWeight - vignette) > 1e-6)
      imageProcessing.vignetteWeight = vignette;
  }

  /**
   * Ореол растёт вместе с темнотой. Включение пересобирает цепочку постобработки,
   * поэтому оно происходит дважды за игровые сутки, а не каждый кадр.
   */
  private applyBloom(): void {
    const pipeline = this.pipeline;
    if (!pipeline) return;
    const enabled = this.dark >= BLOOM_MIN_DARK;
    if (pipeline.bloomEnabled !== enabled) pipeline.bloomEnabled = enabled;
    if (enabled) pipeline.bloomWeight = BLOOM_WEIGHT * this.dark;
  }

  /**
   * Должны ли огни помечать себя для ореола в этом кадре. Метка допустима только при
   * включённом ореоле: его проход слияния возвращает альфу холста к единице.
   */
  get glowMask(): boolean {
    return GLOW_MASK_SUPPORTED && (this.pipeline?.bloomEnabled ?? false);
  }

  /** Состояние ореола для диагностики и тестов. */
  bloomDiagnostics() {
    const pipeline = this.pipeline;
    return {
      enabled: pipeline?.bloomEnabled ?? false,
      weight: pipeline?.bloomEnabled ? pipeline.bloomWeight : 0,
      glowMask: this.glowMask,
      patchedPasses: { ...glowMaskPatches },
    };
  }

  /**
   * Follow the camera target; an overhead view expands the map in stable steps.
   * The sun moves in whole-texel steps along its own axes; the static map is redrawn
   * only when a step is crossed.
   */
  follow(target: Vector3, viewWidth = 0): void {
    this.restorePendingProjection();
    this.viewWidth = viewWidth;
    this.target.copyFrom(target);
    const required = Math.max(0, Number.isFinite(viewWidth) ? viewWidth : 0) * 1.15;
    const desired = SHADOW_STEPS.find((step) => step >= required) ?? 720;
    // Grow immediately; shrinking needs 15% headroom to prevent wheel jitter at a boundary.
    if (
      desired > this.sun.shadowFrustumSize ||
      (desired < this.sun.shadowFrustumSize && required <= desired * 0.85)
    ) {
      this.sun.shadowFrustumSize = desired;
      this.sun.shadowMaxZ = SUN_DISTANCE * 2 * (desired / SHADOW_EXTENT);
      for (const shadow of [this.staticShadow, this.shadow]) {
        // Depth range and texel size grow together: normalized depth bias stays constant.
        shadow.bias = 0.0012;
        shadow.normalBias = 0.08 * (desired / SHADOW_EXTENT);
        shadow.resetProjection();
      }
      this.staticShadow.invalidate();
    }
    const extent = this.sun.shadowFrustumSize;
    const shadowSnap = (extent / SHADOW_MAP_SIZE) * 128;
    const forward = this.forward.copyFrom(this.sun.direction).normalize();
    // Те же оси, что у видовой матрицы направленного света Babylon.
    Vector3.CrossToRef(Vector3.UpReadOnly, forward, this.right);
    this.right.normalize();
    Vector3.CrossToRef(forward, this.right, this.up);
    const snap = (axis: Vector3) => Math.round(Vector3.Dot(target, axis) / shadowSnap) * shadowSnap;
    const position = this.position
      .copyFrom(this.right)
      .scaleInPlace(snap(this.right))
      .addInPlace(this.scratch.copyFrom(this.up).scaleInPlace(snap(this.up)))
      .addInPlace(
        this.scratch
          .copyFrom(forward)
          .scaleInPlace(snap(forward) - SUN_DISTANCE * (extent / SHADOW_EXTENT)),
      );
    if (position.equalsWithEpsilon(this.sun.position, 1e-6)) return;
    this.sun.position.copyFrom(position);
    this.staticShadow.invalidate();
  }

  /** Shadow maps and caster counts for the diagnostic report. */
  shadowDiagnostics() {
    return {
      staticCasters: this.staticShadow.getShadowMap()?.renderList?.length ?? 0,
      dynamicCasters: this.shadow.getShadowMap()?.renderList?.length ?? 0,
      staticRefreshes: this.staticShadow.refreshes,
      staticDiscarded: this.discardedRefreshes,
      staticFallbacks: this.fallbackRefreshes,
      extent: this.sun.shadowFrustumSize,
    };
  }

  dispose(): void {
    this.scene.getEngine().onContextRestoredObservable.remove(this.contextRestored);
    this.pipeline?.dispose();
    this.pipeline = undefined;
    this.shadow.dispose();
    this.staticShadow.dispose();
    this.heldDepth?.dispose();
    this.sun.dispose();
    this.fill.dispose();
  }
}
