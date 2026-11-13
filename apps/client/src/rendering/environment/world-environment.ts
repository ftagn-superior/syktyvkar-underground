import type { Scene } from '@babylonjs/core/scene';
import type { Camera } from '@babylonjs/core/Cameras/camera';
import type { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { DAY_LENGTH_MS, DEFAULT_DAY_CLOCK, dayClockHour, type DayClock } from '@su/contracts';
import type { RadialState } from '../radial-fog';
import { renderQualitySettings, type RenderQuality } from '../render-quality';
import { WorldLighting } from './lighting';
import { WorldClouds } from './clouds';
import { WorldNightLights } from './night-lights';

/** Owns the sky, lighting, clouds and night lights for one world scene, including their shared clock. */
export class WorldEnvironment {
  private readonly lighting: WorldLighting;
  private readonly clouds: WorldClouds;
  /** Окна, вывески и фонари; статичные модели регистрируют в нём свои источники света. */
  readonly nightLights: WorldNightLights;
  private readonly cloudTint = new Color3();
  private readonly lightDirection = new Vector3();
  private clock: DayClock = DEFAULT_DAY_CLOCK;
  private fixedHour?: number;
  private currentHour?: number;

  constructor(scene: Scene, camera: ArcRotateCamera, additionalCameras: Camera[] = []) {
    this.lighting = new WorldLighting(scene, camera, additionalCameras);
    // Construct before world materials: the cloud plugin attaches when they are created.
    this.clouds = new WorldClouds(scene, camera);
    this.nightLights = new WorldNightLights(scene);
  }

  get shadow() {
    return this.lighting.shadow;
  }
  get staticShadow() {
    return this.lighting.staticShadow;
  }
  get hour(): number {
    return this.currentHour ?? this.fixedHour ?? dayClockHour(this.clock, Date.now());
  }
  setDayClock(clock: DayClock): void {
    this.clock = clock;
    this.currentHour = undefined;
  }
  /** Local visual override; clearing it resumes the replicated room clock. */
  setTimeOfDay(hour?: number): void {
    this.fixedHour = hour === undefined ? undefined : ((hour % 24) + 24) % 24;
    this.currentHour = undefined;
  }
  setQuality(quality: RenderQuality): void {
    this.lighting.setQuality(quality);
    this.clouds.setEnabled(renderQualitySettings(quality).clouds);
    this.nightLights.setEconomy(quality === 'economy');
  }
  update(
    frame: { target: Vector3; zoom: number; visible: RadialState },
    epochMs = Date.now(),
  ): void {
    this.lighting.follow(frame.target);
    this.currentHour = this.fixedHour ?? dayClockHour(this.clock, epochMs);
    const sky = this.lighting.setTimeOfDay(this.currentHour);
    // Окна перемешиваются раз в игровые сутки, в полдень, когда они погашены. Остановленные
    // часы не перемешивают их, иначе окна мигали бы каждые 24 минуты.
    const frozen = this.fixedHour !== undefined || this.clock.frozenHour >= 0;
    const night = frozen ? 0 : Math.floor((epochMs + this.clock.offsetMs) / DAY_LENGTH_MS - 0.5);
    this.nightLights.update(this.currentHour, night, frame.target);
    this.nightLights.setGlowMask(this.lighting.glowMask);
    this.clouds.update({
      epochMs,
      lightDirection: this.lightDirection.set(
        sky.lightDirection.x,
        sky.lightDirection.y,
        sky.lightDirection.z,
      ),
      lightStrength: sky.directLight,
      tint: this.cloudTint.set(...sky.cloudColor),
      zoom: frame.zoom,
      visible: frame.visible,
    });
  }
  shadowDiagnostics() {
    return this.lighting.shadowDiagnostics();
  }
  bloomDiagnostics() {
    return this.lighting.bloomDiagnostics();
  }
  dispose(): void {
    this.nightLights.dispose();
    this.clouds.dispose();
    this.lighting.dispose();
  }
}
