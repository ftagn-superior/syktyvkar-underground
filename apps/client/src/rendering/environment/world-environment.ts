import type { Scene } from '@babylonjs/core/scene';
import type { Camera } from '@babylonjs/core/Cameras/camera';
import type { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { DEFAULT_DAY_CLOCK, dayClockHour, type DayClock } from '@su/contracts';
import type { RadialState } from '../radial-fog';
import { renderQualitySettings, type RenderQuality } from '../render-quality';
import { WorldLighting } from './lighting';
import { WorldClouds } from './clouds';

/** Owns the sky, lighting and clouds for one world scene, including their shared clock. */
export class WorldEnvironment {
  private readonly lighting: WorldLighting;
  private readonly clouds: WorldClouds;
  private readonly cloudTint = new Color3();
  private readonly lightDirection = new Vector3();
  private clock: DayClock = DEFAULT_DAY_CLOCK;
  private fixedHour?: number;
  private currentHour?: number;

  constructor(scene: Scene, camera: ArcRotateCamera, additionalCameras: Camera[] = []) {
    this.lighting = new WorldLighting(scene, camera, additionalCameras);
    // Construct before world materials: the cloud plugin attaches when they are created.
    this.clouds = new WorldClouds(scene, camera);
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
  }
  update(
    frame: { target: Vector3; zoom: number; visible: RadialState },
    epochMs = Date.now(),
  ): void {
    this.lighting.follow(frame.target);
    this.currentHour = this.fixedHour ?? dayClockHour(this.clock, epochMs);
    const sky = this.lighting.setTimeOfDay(this.currentHour);
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
  dispose(): void {
    this.clouds.dispose();
    this.lighting.dispose();
  }
}
