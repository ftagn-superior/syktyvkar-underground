import type { Scene } from '@babylonjs/core/scene';
import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine';
import { Constants } from '@babylonjs/core/Engines/constants';
import type { Material } from '@babylonjs/core/Materials/material';
import type { MaterialDefines } from '@babylonjs/core/Materials/materialDefines';
import { MaterialPluginBase } from '@babylonjs/core/Materials/materialPluginBase';
import { RegisterMaterialPlugin } from '@babylonjs/core/Materials/materialPluginManager';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import type { UniformBuffer } from '@babylonjs/core/Materials/uniformBuffer';
import type { SubMesh } from '@babylonjs/core/Meshes/subMesh';

/**
 * Погода на поверхностях города: мокрый асфальт с лужами, снег на горизонтальных
 * поверхностях и туман вокруг игрока. Без новых мешей и вызовов отрисовки: всё
 * считается в шейдерах существующих материалов, как тени облаков и ночные огни.
 *
 * Пока погода ни разу не менялась, код в шейдеры не попадает. После первой смены
 * он остаётся и при ясной погоде с нулевыми величинами: каждое включение и выключение
 * пересобирало бы все материалы города.
 */

/** Насколько темнеет мокрая поверхность и насколько — лужа. */
const WET_DARKENING = 0.4;
const PUDDLE_DARKENING = 0.7;
/** Отражение неба в мокром асфальте и в луже. */
const WET_SHEEN = 0.03;
const PUDDLE_SHEEN = 0.1;
/** Расстояние в метрах, на котором туман закрывает ≈63 % между дымкой и полной стеной. */
const FOG_DISTANCE = 22;
/** Дымка у самого игрока: в густом тумане и вблизи всё немного размыто. */
const FOG_NEAR = 0.16;
/** Альбедо снега в линейном цвете: чуть холоднее белого. */
const SNOW_ALBEDO = '0.82, 0.85, 0.9';

type SurfaceState = {
  /** Код погоды в шейдерах; включается при первой непустой погоде и больше не выключается. */
  enabled: boolean;
  /** Мокрость, снежный покров, туман, 0. */
  amounts: Float32Array;
  /** Цвет тумана и расстояние тумана. */
  fog: Float32Array;
  /** Центр тумана: точка, за которой следит камера. */
  center: Float32Array;
  /** Цвет неба, отражённого в мокрых поверхностях. */
  sheen: Float32Array;
};
const states = new WeakMap<Scene, SurfaceState>();

class WeatherSurfacePlugin extends MaterialPluginBase {
  constructor(
    material: Material,
    private readonly state: SurfaceState,
  ) {
    // После ночных огней (207): туман закрывает и их; до радиального тумана края (210).
    super(material, 'WorldWeatherSurface', 208, { SU_WEATHER: false }, true, false);
    this.doNotSerialize = true;
    this._enable(true);
  }
  override getClassName() {
    return 'WorldWeatherSurface';
  }
  override prepareDefines(defines: MaterialDefines) {
    const material = this._material as { disableLighting?: boolean; unlit?: boolean };
    (defines as MaterialDefines & { SU_WEATHER: boolean }).SU_WEATHER =
      this.state.enabled && !material.disableLighting && !material.unlit;
  }
  override getUniforms() {
    return {
      ubo: [
        { name: 'suWeather', size: 4, type: 'vec4' },
        { name: 'suWeatherFog', size: 4, type: 'vec4' },
        { name: 'suWeatherCenter', size: 4, type: 'vec4' },
        { name: 'suWeatherSheen', size: 4, type: 'vec4' },
      ],
      fragment: `uniform vec4 suWeather;
uniform vec4 suWeatherFog;
uniform vec4 suWeatherCenter;
uniform vec4 suWeatherSheen;`,
    };
  }
  override bindForSubMesh(
    buffer: UniformBuffer,
    _scene: Scene,
    _engine: AbstractEngine,
    _subMesh: SubMesh,
  ) {
    const { state } = this;
    if (!state.enabled) return;
    const v = (name: string, value: Float32Array) =>
      buffer.updateFloat4(name, value[0]!, value[1]!, value[2]!, value[3]!);
    v('suWeather', state.amounts);
    v('suWeatherFog', state.fog);
    v('suWeatherCenter', state.center);
    v('suWeatherSheen', state.sheen);
  }
  override getCustomCode(shaderType: string): Record<string, string> | null {
    if (shaderType !== 'fragment') return null;
    const pbr = this._material instanceof PBRMaterial;
    const definitions = `
      #ifdef SU_WEATHER
        float suWeatherHash(vec2 cell) {
          return fract(sin(dot(cell, vec2(127.1, 311.7))) * 43758.5453);
        }
        float suWeatherNoise(vec2 point) {
          vec2 cell = floor(point);
          vec2 t = fract(point);
          t = t * t * (3.0 - 2.0 * t);
          return mix(
            mix(suWeatherHash(cell), suWeatherHash(cell + vec2(1.0, 0.0)), t.x),
            mix(suWeatherHash(cell + vec2(0.0, 1.0)), suWeatherHash(cell + vec2(1.0, 1.0)), t.x),
            t.y);
        }
        // Снег лежит на том, что смотрит вверх. Сначала он ложится пятнами, потом сплошь.
        float suSnowAmount(vec3 normal, vec3 position) {
          if (suWeather.y <= 0.0) return 0.0;
          float up = smoothstep(0.45, 0.85, normal.y);
          float patches = suWeatherNoise(position.xz * 0.35) * 0.65 + suWeatherNoise(position.xz * 1.9) * 0.35;
          return up * smoothstep(patches - 0.12, patches + 0.12, suWeather.y * 1.35 - 0.2);
        }
        // Лужи стоят в низинах шума на горизонтальных поверхностях, но не на газоне:
        // трава (зелёное альбедо) вода впитывает.
        float suPuddle(vec3 normal, vec3 position, vec3 albedo) {
          float level = smoothstep(0.9, 0.98, normal.y);
          float green = smoothstep(1.05, 1.25, albedo.g / max(max(albedo.r, albedo.b), 0.001));
          float noise = suWeatherNoise(position.xz * 0.16) * 0.7 + suWeatherNoise(position.xz * 0.7) * 0.3;
          return level * (1.0 - green) * smoothstep(0.62, 0.7, noise) * smoothstep(0.35, 1.0, suWeather.x);
        }
        float suWetAmount(vec3 normal) {
          return suWeather.x * mix(0.5, 1.0, smoothstep(0.3, 0.9, normal.y));
        }
        float suFogAmount(vec3 position) {
          if (suWeather.z <= 0.0) return 0.0;
          float distance = length(position.xz - suWeatherCenter.xz);
          float haze = mix(${FOG_NEAR}, 1.0, 1.0 - exp(-distance / suWeatherFog.w));
          // Над крышами туман реже: он лежит в улицах.
          float low = 1.0 - 0.35 * smoothstep(3.0, 30.0, position.y - suWeatherCenter.y);
          return suWeather.z * haze * low;
        }
        float suWeatherSnow = 0.0;
        float suWeatherWet = 0.0;
        float suWeatherPuddle = 0.0;
      #endif
    `;
    const surface = (albedo: string) => `
      #ifdef SU_WEATHER
        suWeatherSnow = suSnowAmount(normalW, vPositionW);
        suWeatherWet = suWetAmount(normalW) * (1.0 - suWeatherSnow);
        suWeatherPuddle = suPuddle(normalW, vPositionW, ${albedo}) * (1.0 - suWeatherSnow);
        ${albedo} *= 1.0 - ${WET_DARKENING} * suWeatherWet - ${PUDDLE_DARKENING - WET_DARKENING} * suWeatherPuddle;
        ${albedo} = mix(${albedo}, vec3(${SNOW_ALBEDO}), suWeatherSnow);
      #endif
    `;
    const sheen = `(suWeatherSheen.rgb * (${WET_SHEEN} * suWeatherWet * smoothstep(0.3, 0.9, normalW.y) + ${PUDDLE_SHEEN} * suWeatherPuddle))`;
    const fog = (output: string) => `
      #ifdef SU_WEATHER
        ${output}.rgb = mix(${output}.rgb, suWeatherFog.rgb, suFogAmount(vPositionW));
      #endif
    `;
    if (pbr)
      return {
        CUSTOM_FRAGMENT_DEFINITIONS: definitions,
        // До отражательной способности: металлический процесс выводит из альбедо базовый цвет.
        CUSTOM_FRAGMENT_BEFORE_LIGHTS: surface('surfaceAlbedo'),
        CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: `
          #ifdef SU_WEATHER
            finalEmissive += ${sheen};
          #endif
        `,
        CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR: fog('finalColor'),
      };
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: definitions,
      CUSTOM_FRAGMENT_UPDATE_DIFFUSE: `
        #ifdef SU_WEATHER
          ${surface('baseColor.rgb')}
          diffuseColor = mix(diffuseColor, vec3(1.0), suWeatherSnow);
        #endif
      `,
      CUSTOM_FRAGMENT_BEFORE_FOG: `
        #ifdef SU_WEATHER
          color.rgb += ${sheen};
        #endif
      `,
      CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR: fog('color'),
    };
  }
}

let registered = false;

/** Погода на поверхностях одной сцены. Создаётся до материалов мира, как облака. */
export class WorldWeatherSurface {
  private readonly state: SurfaceState = {
    enabled: false,
    amounts: new Float32Array(4),
    fog: new Float32Array([0, 0, 0, FOG_DISTANCE]),
    center: new Float32Array(4),
    sheen: new Float32Array(4),
  };

  constructor(private readonly scene: Scene) {
    states.set(scene, this.state);
    if (registered) return;
    registered = true;
    RegisterMaterialPlugin('WorldWeatherSurface', (material) => {
      const state = states.get(material.getScene());
      return state && (material instanceof StandardMaterial || material instanceof PBRMaterial)
        ? new WeatherSurfacePlugin(material, state)
        : null;
    });
  }

  get enabled(): boolean {
    return this.state.enabled;
  }

  update(frame: {
    wetness: number;
    snowCover: number;
    fog: number;
    fogColor: readonly [number, number, number];
    sheen: readonly [number, number, number];
    center: { x: number; y: number; z: number };
  }): void {
    const { state } = this;
    if (!state.enabled) {
      if (frame.wetness <= 0 && frame.snowCover <= 0 && frame.fog <= 0) return;
      state.enabled = true;
      this.scene.markAllMaterialsAsDirty(Constants.MATERIAL_AllDirtyFlag);
    }
    state.amounts.set([frame.wetness, frame.snowCover, frame.fog, 0]);
    state.fog.set(frame.fogColor);
    state.center.set([frame.center.x, frame.center.y, frame.center.z, 0]);
    state.sheen.set(frame.sheen);
  }

  dispose(): void {
    states.delete(this.scene);
  }
}
