import type { Scene } from '@babylonjs/core/scene';
import type { Camera } from '@babylonjs/core/Cameras/camera';
import type { TargetCamera } from '@babylonjs/core/Cameras/targetCamera';
import type { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import {
  DAY_LENGTH_MS,
  DEFAULT_DAY_CLOCK,
  DEFAULT_WEATHER,
  dayClockHour,
  type DayClock,
  type WorldWeather,
} from '@su/contracts';
import type { RadialState } from '../radial-fog';
import { renderQualitySettings, type RenderQuality } from '../render-quality';
import { WorldLighting } from './lighting';
import { WorldClouds } from './clouds';
import { WorldNightLights } from './night-lights';
import { WeatherMix, type WeatherAmounts } from './weather-mix';
import { WorldWeatherSurface } from './weather-surface';
import { PrecipitationLayer, type PrecipitationFrame } from './precipitation';
import type { Sky } from './day-cycle';

/** Wall-clock seconds for falling drops wrap after an hour; float32 stays precise. */
const PRECIPITATION_PERIOD_S = 3600;

export type EnvironmentFrame = {
  target: Vector3;
  zoom: number;
  visible: RadialState;
  /** Camera that renders this frame; without it there is no precipitation (unit tests). */
  camera?: TargetCamera;
  /** First-person view: precipitation surrounds the eye instead of the overhead frame. */
  firstPerson?: boolean;
};

/**
 * Owns the sky, lighting, clouds, weather and night lights for one world scene,
 * including their shared clock.
 */
export class WorldEnvironment {
  private readonly lighting: WorldLighting;
  private readonly clouds: WorldClouds;
  /** Окна, вывески и фонари; статичные модели регистрируют в нём свои источники света. */
  readonly nightLights: WorldNightLights;
  private readonly surface: WorldWeatherSurface;
  private readonly precipitation: Record<'rain' | 'snow', PrecipitationLayer>;
  private readonly weatherMix = new WeatherMix();
  private readonly cloudTint = new Color3();
  private readonly lightDirection = new Vector3();
  private readonly forward = new Vector3();
  private clock: DayClock = DEFAULT_DAY_CLOCK;
  private fixedHour?: number;
  private currentHour?: number;
  private weather: WorldWeather = DEFAULT_WEATHER;
  /** Локальная погода из адреса страницы; важнее погоды комнаты. */
  private weatherOverride?: WorldWeather;
  /** Первая погода после создания мира показывается сразу, без перехода. */
  private weatherSettled = false;
  private qualityClouds = true;
  private lastEpochMs?: number;

  constructor(
    scene: Scene,
    private readonly camera: ArcRotateCamera,
    additionalCameras: Camera[] = [],
  ) {
    this.lighting = new WorldLighting(scene, camera, additionalCameras);
    // Construct before world materials: the cloud, night and weather plugins attach
    // when those materials are created.
    this.clouds = new WorldClouds(scene, camera);
    this.nightLights = new WorldNightLights(scene);
    this.surface = new WorldWeatherSurface(scene);
    this.precipitation = {
      rain: new PrecipitationLayer(scene, 'rain'),
      snow: new PrecipitationLayer(scene, 'snow'),
    };
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
  /** Текущая сила каждой части погоды; для диагностики и тестов. */
  get weatherAmounts(): Readonly<WeatherAmounts> {
    return this.weatherMix.current;
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
  /** Погода комнаты, которой управляет `/weather`. */
  setWeather(weather: WorldWeather): void {
    this.weather = weather;
    this.applyWeather();
  }
  /** Локальная погода для снимков (`?weather=`); `undefined` возвращает погоду комнаты. */
  setWeatherOverride(weather?: WorldWeather): void {
    this.weatherOverride = weather;
    this.weatherSettled = false;
    this.applyWeather();
  }
  private applyWeather(): void {
    const weather = this.weatherOverride ?? this.weather;
    this.weatherMix.set(weather, !this.weatherSettled);
    this.weatherSettled = true;
    // Облака видны, только если их разрешают и качество графики, и погода.
    this.clouds.setEnabled(this.qualityClouds && weather.clouds);
  }
  setQuality(quality: RenderQuality): void {
    this.lighting.setQuality(quality);
    this.qualityClouds = renderQualitySettings(quality).clouds;
    this.clouds.setEnabled(this.qualityClouds && (this.weatherOverride ?? this.weather).clouds);
    this.nightLights.setEconomy(quality === 'economy');
    for (const layer of Object.values(this.precipitation)) layer.setEconomy(quality === 'economy');
  }
  update(frame: EnvironmentFrame, epochMs = Date.now()): void {
    const elapsed = this.lastEpochMs === undefined ? 0 : (epochMs - this.lastEpochMs) / 1000;
    this.lastEpochMs = epochMs;
    this.weatherMix.step(elapsed);
    const weather = this.weatherMix.current;

    this.lighting.follow(frame.target);
    this.currentHour = this.fixedHour ?? dayClockHour(this.clock, epochMs);
    const sky = this.lighting.setTimeOfDay(this.currentHour, weather);
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
      overcast: weather.overcast,
    });
    this.surface.update({
      wetness: weather.wetness,
      snowCover: weather.snowCover,
      fog: weather.fog,
      fogColor: sky.fog,
      sheen: skyLight(sky, 1),
      center: frame.target,
    });
    this.updatePrecipitation(frame, epochMs, sky, weather);
  }

  private updatePrecipitation(
    frame: EnvironmentFrame,
    epochMs: number,
    sky: Sky,
    weather: WeatherAmounts,
  ): void {
    const camera = frame.camera;
    const overhead = !frame.firstPerson;
    // Издалека осадков не видно: их заменяет слой облаков.
    const distance = overhead ? 1 - smoothstep(2.5, 6, frame.zoom) : 1;
    for (const layer of Object.values(this.precipitation)) {
      const amount = camera ? weather[layer.kind] * distance : 0;
      if (amount <= 0.001) {
        layer.update({ amount: 0 } as PrecipitationFrame);
        continue;
      }
      const eye = camera!.globalPosition;
      const forward = camera!.getTarget().subtractToRef(eye, this.forward).normalize();
      layer.update({
        amount,
        seconds: (epochMs / 1000) % PRECIPITATION_PERIOD_S,
        overhead,
        eye,
        forward,
        target: frame.target,
        halfWidth: this.camera.orthoRight ?? 20,
        halfHeight: this.camera.orthoTop ?? 15,
        zoom: frame.zoom,
        // Снег белее дождя: он отражает рассеянный свет, а капли почти прозрачны.
        color: skyLight(sky, layer.kind === 'snow' ? 1.6 : 1.1),
        fog: weather.fog,
      });
    }
  }

  shadowDiagnostics() {
    return this.lighting.shadowDiagnostics();
  }
  bloomDiagnostics() {
    return this.lighting.bloomDiagnostics();
  }
  dispose(): void {
    for (const layer of Object.values(this.precipitation)) layer.dispose();
    this.surface.dispose();
    this.nightLights.dispose();
    this.clouds.dispose();
    this.lighting.dispose();
  }
}

const smoothstep = (from: number, to: number, value: number) => {
  const t = Math.min(1, Math.max(0, (value - from) / (to - from)));
  return t * t * (3 - 2 * t);
};

/** Цвет рассеянного света неба с долей прямого: им светятся капли и мокрый асфальт. */
function skyLight(sky: Sky, gain: number): [number, number, number] {
  const light = (i: 0 | 1 | 2) =>
    Math.min(
      1,
      gain *
        (sky.skyColor[i] * sky.skyIntensity * 1.4 + sky.lightColor[i] * sky.lightIntensity * 0.06),
    );
  return [light(0), light(1), light(2)];
}
