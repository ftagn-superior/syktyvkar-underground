import type { Scene } from '@babylonjs/core/scene';
import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine';
import { Constants } from '@babylonjs/core/Engines/constants';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { SubMesh } from '@babylonjs/core/Meshes/subMesh';
import type { Material } from '@babylonjs/core/Materials/material';
import type { MaterialDefines } from '@babylonjs/core/Materials/materialDefines';
import { MaterialPluginBase } from '@babylonjs/core/Materials/materialPluginBase';
import { RegisterMaterialPlugin } from '@babylonjs/core/Materials/materialPluginManager';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import type { UniformBuffer } from '@babylonjs/core/Materials/uniformBuffer';
import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer';
import type { BuildingInstance, StaticLightSource } from '@su/contracts';
import { nightLevels, type GlowLevel, type NightLevels } from './night-schedule';

/**
 * Ночной свет города без настоящих источников Babylon и без новых мешей.
 *
 * Окна, витрины, вывески и плафоны светятся через `finalEmissive`: сборщик записал
 * в их вершины класс и случайное число (TEXCOORD_0 → атрибут `suGlow`), а шейдер
 * сравнивает его с долей из расписания. Пятна света фонарей добавляются к рассеянному
 * свету всех материалов: в униформы попадают только несколько фонарей рядом с камерой.
 */

/** Имя атрибута, в который переносится TEXCOORD_0 моделей со свечением. */
export const GLOW_ATTRIBUTE = 'suGlow';
/** Фонарей в униформе; экономичный режим перебирает меньше. */
const LAMP_SLOTS = 8;
const ECONOMY_LAMP_SLOTS = 4;
/** Яркость пятна света: множитель линейного цвета фонаря. */
const LAMP_POOL_INTENSITY = 2.2;
const GLOW_KINDS = ['window', 'shop', 'sign', 'lamp', 'office', 'neon'] as const;
/** Неоновая вывеска светит слабее фонаря, зато своим цветом. */
const NEON_POOL_INTENSITY = 1.0;
/**
 * Конус света под фонарём: свет, рассеянный в воздухе. Считается в шейдере материала
 * вдоль луча от камеры до поверхности, поэтому дома перед фонарём закрывают конус,
 * а новых мешей и вызовов отрисовки нет. Рассеяние на метр луча и тангенс полуугла;
 * подобрано по снимкам сверху и от первого лица.
 */
const CONE_SCATTER = 0.4;
const CONE_TAN = 0.6;
/** Отсчётов вдоль луча внутри конуса. */
const CONE_SAMPLES = 6;

/**
 * Переносит данные свечения из UV модели в собственный атрибут. Так шейдер не путает
 * их с текстурными координатами, а клоны и thin instances делят те же буферы.
 */
export function adoptGlowAttribute(mesh: Mesh): boolean {
  const data = mesh.getVerticesData(VertexBuffer.UVKind);
  if (!data) return false;
  mesh.setVerticesData(GLOW_ATTRIBUTE, data, false, 2);
  mesh.removeVerticesData(VertexBuffer.UVKind);
  return true;
}

type LampSource = {
  position: Vector3;
  /** Высота плафона над основанием; у неона 0 — конуса нет. */
  height: number;
  radius: number;
  color: [number, number, number];
  neon: boolean;
};
type NightState = {
  enabled: boolean;
  slots: number;
  /** Конусы под фонарями; в экономичном режиме выключены. */
  cones: boolean;
  /** Рассеяние на метр и тангенс полуугла конуса. */
  cone: Float32Array;
  /** Пять классов по vec4: вечер, держится, утро, яркость. */
  levels: Float32Array;
  /** Номер ночи (перемешивает окна), темнота, накал фонарей, метка для ореола (0/1). */
  clock: Float32Array;
  lampPositions: Float32Array;
  lampColors: Float32Array;
};
const states = new WeakMap<Scene, NightState>();

const linear = (hex: string): [number, number, number] =>
  [1, 3, 5].map((i) => (parseInt(hex.slice(i, i + 2), 16) / 255) ** 2.2) as [
    number,
    number,
    number,
  ];

class NightLightsPlugin extends MaterialPluginBase {
  constructor(
    material: Material,
    private readonly state: NightState,
  ) {
    // После теней облаков (205) и до радиального тумана (210).
    super(
      material,
      'WorldNightLights',
      207,
      { SU_NIGHT: false, SU_GLOW: false, SU_LAMP_SLOTS: 0, SU_LAMP_CONES: false },
      true,
      false,
    );
    this.doNotSerialize = true;
    this._enable(true);
  }
  override getClassName() {
    return 'WorldNightLights';
  }
  override prepareDefines(defines: MaterialDefines, _scene: Scene, mesh: AbstractMesh) {
    const material = this._material as { disableLighting?: boolean; unlit?: boolean };
    const target = defines as MaterialDefines & {
      SU_NIGHT: boolean;
      SU_GLOW: boolean;
      SU_LAMP_SLOTS: number;
      SU_LAMP_CONES: boolean;
    };
    target.SU_NIGHT = this.state.enabled && !material.disableLighting && !material.unlit;
    target.SU_GLOW =
      this.state.enabled &&
      this._material instanceof PBRMaterial &&
      mesh.isVerticesDataPresent(GLOW_ATTRIBUTE);
    target.SU_LAMP_SLOTS = target.SU_NIGHT ? this.state.slots : 0;
    target.SU_LAMP_CONES = target.SU_NIGHT && this.state.cones;
  }
  override getAttributes(attributes: string[], _scene: Scene, mesh: AbstractMesh) {
    if (
      this.state.enabled &&
      mesh.isVerticesDataPresent(GLOW_ATTRIBUTE) &&
      !attributes.includes(GLOW_ATTRIBUTE)
    )
      attributes.push(GLOW_ATTRIBUTE);
  }
  override getUniforms() {
    return {
      ubo: [
        { name: 'suNightLevels', size: 4, type: 'vec4', arraySize: GLOW_KINDS.length },
        { name: 'suNightClock', size: 4, type: 'vec4' },
        { name: 'suLampPositions', size: 4, type: 'vec4', arraySize: LAMP_SLOTS },
        { name: 'suLampColors', size: 4, type: 'vec4', arraySize: LAMP_SLOTS },
        { name: 'suLampCone', size: 4, type: 'vec4' },
      ],
      fragment: `uniform vec4 suNightLevels[${GLOW_KINDS.length}];
uniform vec4 suNightClock;
uniform vec4 suLampPositions[${LAMP_SLOTS}];
uniform vec4 suLampColors[${LAMP_SLOTS}];
uniform vec4 suLampCone;`,
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
    buffer.updateFloatArray('suNightLevels', state.levels);
    buffer.updateFloat4(
      'suNightClock',
      state.clock[0],
      state.clock[1],
      state.clock[2],
      state.clock[3],
    );
    buffer.updateFloatArray('suLampPositions', state.lampPositions);
    buffer.updateFloatArray('suLampColors', state.lampColors);
    buffer.updateFloat4('suLampCone', state.cone[0], state.cone[1], 0, 0);
  }
  override getCustomCode(shaderType: string): Record<string, string> | null {
    const pbr = this._material instanceof PBRMaterial;
    if (shaderType === 'vertex')
      return {
        CUSTOM_VERTEX_DEFINITIONS: `
          #ifdef SU_GLOW
            attribute vec2 ${GLOW_ATTRIBUTE};
            varying vec3 vSuGlow;
          #endif
        `,
        // Число экземпляра из его положения: одинаковые дома и фонари не мигают в такт.
        CUSTOM_VERTEX_MAIN_END: `
          #ifdef SU_GLOW
            float suInstance = fract(sin(dot(floor(finalWorld[3].xz * 2.0), vec2(12.9898, 78.233))) * 43758.5453);
            vSuGlow = vec3(${GLOW_ATTRIBUTE}.x, ${GLOW_ATTRIBUTE}.y, suInstance);
          #endif
        `,
      };
    if (shaderType !== 'fragment') return null;
    const definitions = `
      #ifdef SU_GLOW
        varying vec3 vSuGlow;
      #endif
      #ifdef SU_NIGHT
        float suNightHash(float value) {
          return fract(sin(value * 91.3458 + 17.17) * 47453.5453);
        }
        vec3 suNightLampLight(vec3 position, vec3 normal) {
          vec3 light = vec3(0.0);
          #if SU_LAMP_SLOTS > 0
            if (suNightClock.z > 0.0) {
              for (int i = 0; i < SU_LAMP_SLOTS; i++) {
                vec4 lamp = suLampPositions[i];
                vec3 toLamp = lamp.xyz - position;
                float distance2 = dot(toLamp, toLamp);
                float reach = lamp.w * lamp.w;
                if (distance2 < reach) {
                  float falloff = 1.0 - distance2 / reach;
                  float facing = max(dot(normal, toLamp * inversesqrt(max(distance2, 0.0001))), 0.0);
                  light += suLampColors[i].rgb * falloff * falloff * (0.3 + 0.7 * facing);
                }
              }
            }
          #endif
          return light;
        }
      #endif
      #ifdef SU_LAMP_CONES
        // Свет, рассеянный в воздухе под фонарями, вдоль луча от глаза до этой точки.
        // Луч обрезается по описанному цилиндру конуса, внутри — несколько отсчётов.
        vec3 suLampCones(vec3 position) {
          vec3 light = vec3(0.0);
          #if SU_LAMP_SLOTS > 0
            if (suNightClock.z > 0.0) {
              vec3 eye = vEyePosition.xyz;
              vec3 ray = position - eye;
              float rayLength = length(ray);
              for (int i = 0; i < SU_LAMP_SLOTS; i++) {
                float height = suLampColors[i].w;
                if (height <= 0.0) continue;
                vec3 lamp = suLampPositions[i].xyz;
                float reach = 0.25 + height * suLampCone.y;
                float s0 = 0.0;
                float s1 = 1.0;
                // Слой высот от плафона до земли.
                if (abs(ray.y) > 0.0001) {
                  float top = (lamp.y - eye.y) / ray.y;
                  float bottom = (lamp.y - height - eye.y) / ray.y;
                  s0 = max(s0, min(top, bottom));
                  s1 = min(s1, max(top, bottom));
                } else if (eye.y > lamp.y || eye.y < lamp.y - height) continue;
                // Вертикальный цилиндр вокруг конуса.
                vec2 offset = eye.xz - lamp.xz;
                float a = dot(ray.xz, ray.xz);
                float c = dot(offset, offset) - reach * reach;
                if (a > 0.000001) {
                  float b = dot(offset, ray.xz);
                  float disc = b * b - a * c;
                  if (disc <= 0.0) continue;
                  float root = sqrt(disc);
                  s0 = max(s0, (-b - root) / a);
                  s1 = min(s1, (-b + root) / a);
                } else if (c > 0.0) continue;
                if (s1 <= s0) continue;
                float stride = (s1 - s0) / ${CONE_SAMPLES}.0;
                float density = 0.0;
                for (int k = 0; k < ${CONE_SAMPLES}; k++) {
                  vec3 point = eye + ray * (s0 + stride * (float(k) + 0.5));
                  float below = lamp.y - point.y;
                  float radius = 0.25 + below * suLampCone.y;
                  float along = clamp(1.0 - below / height, 0.0, 1.0);
                  density += (1.0 - smoothstep(0.45 * radius, radius, length(point.xz - lamp.xz))) * along * along;
                }
                light += suLampColors[i].rgb * density * stride * rayLength;
              }
            }
          #endif
          return light * suLampCone.x;
        }
      #endif
      #ifdef SU_GLOW
        // Свечение этого пикселя: из него ставится метка для ореола (см. glow-mask.ts).
        vec3 suGlowLight = vec3(0.0);
        vec3 suNightGlow(vec3 albedo) {
          float kind = floor(vSuGlow.x + 0.5);
          if (kind < 0.5) return vec3(0.0);
          vec4 level = kind < 1.5 ? suNightLevels[0]
            : kind < 2.5 ? suNightLevels[1]
            : kind < 3.5 ? suNightLevels[2]
            : kind < 4.5 ? suNightLevels[3]
            : kind < 5.5 ? suNightLevels[4]
            : suNightLevels[5];
          float seed = vSuGlow.y + vSuGlow.z * 3.1 + suNightClock.x * 0.618;
          float evening = suNightHash(seed);
          float keep = suNightHash(seed + 41.7);
          float morning = suNightHash(seed + 83.3);
          float lit = max(step(evening, level.x) * step(keep, level.y), step(morning, level.z));
          if (lit * level.w <= 0.0) return vec3(0.0);
          float tone = suNightHash(seed + 11.9);
          vec3 color;
          if (kind < 1.5) {
            // Жилые окна: тёплые лампы, нейтральный свет, голубой отсвет телевизора
            // и розово-фиолетовые фитолампы над рассадой на подоконниках.
            vec3 grow = mix(vec3(1.0, 0.2, 0.7), vec3(0.72, 0.22, 1.0), suNightHash(seed + 23.1));
            color = tone < 0.6 ? vec3(1.0, 0.5, 0.16)
              : tone < 0.87 ? vec3(1.0, 0.72, 0.4)
              : tone < 0.96 ? vec3(0.45, 0.6, 1.0)
              : grow;
            color *= 0.38 + 0.3 * suNightHash(seed + 5.3);
          } else if (kind < 2.5) {
            color = vec3(1.0, 0.86, 0.62) * 1.1;
          } else if (kind < 3.5 || kind > 5.5) {
            // Вывеска светится своим цветом, насыщенно, как неон.
            color = albedo / max(max(albedo.r, max(albedo.g, albedo.b)), 0.02) * 1.4;
          } else if (kind < 4.5) {
            color = vec3(1.0, 0.8, 0.5) * 2.4;
          } else {
            color = vec3(0.8, 0.88, 1.0) * 0.55;
          }
          return color * level.w;
        }
      #endif
    `;
    if (pbr)
      return {
        CUSTOM_FRAGMENT_DEFINITIONS: definitions,
        CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: `
          #ifdef SU_NIGHT
            #ifndef UNLIT
              finalDiffuse += suNightLampLight(vPositionW, normalW) * surfaceAlbedo.rgb;
            #endif
          #endif
          #ifdef SU_LAMP_CONES
            finalEmissive += suLampCones(vPositionW);
          #endif
          #ifdef SU_GLOW
            suGlowLight = suNightGlow(surfaceAlbedo.rgb);
            finalEmissive += suGlowLight;
          #endif
        `,
        // Отрицательная альфа помечает огонь для ореола; непрозрачная сцена так не пишет.
        CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR: `
          #if defined(SU_GLOW) && !defined(ALPHABLEND)
            if (suNightClock.w > 0.0) {
              float suGlowMark = clamp(max(suGlowLight.r, max(suGlowLight.g, suGlowLight.b)) * 4.0, 0.0, 1.0);
              if (suGlowMark > 0.0) finalColor.a = -suGlowMark;
            }
          #endif
        `,
      };
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: definitions,
      CUSTOM_FRAGMENT_BEFORE_FOG: `
        #ifdef SU_NIGHT
          color.rgb += suNightLampLight(vPositionW, normalW) * diffuseColor * baseColor.rgb;
        #endif
        #ifdef SU_LAMP_CONES
          color.rgb += suLampCones(vPositionW);
        #endif
      `,
    };
  }
}

let registered = false;

/**
 * Ночные огни одной сцены: расписание окон, фонари рядом с камерой и их пятна света.
 * Создаётся до материалов мира, как и облака: плагин подключается к ним при создании.
 */
export class WorldNightLights {
  private readonly state: NightState;
  private readonly sources = new Map<string, LampSource[]>();
  private readonly nearest: { lamp: LampSource; distance: number }[] = [];
  private readonly rotation = new Quaternion();
  levels: NightLevels = nightLevels(12);

  constructor(private readonly scene: Scene) {
    this.state = {
      enabled: true,
      slots: LAMP_SLOTS,
      cones: true,
      cone: new Float32Array([CONE_SCATTER, CONE_TAN, 0, 0]),
      levels: new Float32Array(GLOW_KINDS.length * 4),
      clock: new Float32Array(4),
      lampPositions: new Float32Array(LAMP_SLOTS * 4),
      lampColors: new Float32Array(LAMP_SLOTS * 4),
    };
    states.set(scene, this.state);
    if (!registered) {
      registered = true;
      RegisterMaterialPlugin('WorldNightLights', (material) => {
        const state = states.get(material.getScene());
        return state && (material instanceof StandardMaterial || material instanceof PBRMaterial)
          ? new NightLightsPlugin(material, state)
          : null;
      });
    }
  }

  /**
   * Экономичный режим перебирает меньше фонарей и не рисует конусы под ними;
   * переключение пересобирает шейдеры.
   */
  setEconomy(economy: boolean): void {
    const slots = economy ? ECONOMY_LAMP_SLOTS : LAMP_SLOTS;
    if (slots === this.state.slots && this.state.cones === !economy) return;
    this.state.slots = slots;
    this.state.cones = !economy;
    this.scene.markAllMaterialsAsDirty(Constants.MATERIAL_AllDirtyFlag);
  }

  /** Регистрирует фонари экземпляра в мировых координатах. */
  addSources(instance: BuildingInstance, lights: readonly StaticLightSource[]): void {
    const { position, rotation } = instance;
    this.rotation.set(rotation.x, rotation.y, rotation.z, rotation.w);
    this.sources.set(
      instance.entityId,
      lights.map((light) => {
        const local = new Vector3(light.position.x, light.position.y, light.position.z);
        const world = local.rotateByQuaternionToRef(this.rotation, new Vector3());
        world.addInPlaceFromFloats(position.x, position.y, position.z);
        return {
          position: world,
          height: light.kind === 'neon' ? 0 : Math.max(0, light.position.y),
          radius: light.radius,
          color: linear(light.color),
          neon: light.kind === 'neon',
        };
      }),
    );
  }
  removeSources(entityId: string): void {
    this.sources.delete(entityId);
  }
  get sourceCount(): number {
    return this.sources.size;
  }

  /**
   * Обновляет униформы на кадр: доли окон по часу и ближайшие к `focus` фонари.
   * `night` меняется раз в игровые сутки в полдень, когда окна погашены.
   */
  update(hour: number, night: number, focus: Vector3): void {
    const levels = (this.levels = nightLevels(hour));
    const target = this.state.levels;
    GLOW_KINDS.forEach((kind, index) => {
      const level: GlowLevel = levels[kind];
      target.set([level.evening, level.keep, level.morning, level.brightness], index * 4);
    });
    this.state.clock.set([
      night % 997,
      levels.dark,
      Math.max(levels.lamps, levels.neonLight),
      this.state.clock[3],
    ]);
    this.selectLamps(focus, levels.lamps, levels.neonLight);
  }

  private selectLamps(focus: Vector3, lamps: number, neon: number): void {
    const positions = this.state.lampPositions.fill(0);
    const colors = this.state.lampColors.fill(0);
    if (lamps <= 0 && neon <= 0) {
      this.state.clock[2] = 0;
      return;
    }
    const slots = this.state.slots;
    const nearest = this.nearest;
    nearest.length = 0;
    for (const sources of this.sources.values())
      for (const lamp of sources) {
        if ((lamp.neon ? neon : lamps) <= 0) continue;
        const distance = Vector3.Distance(lamp.position, focus) - lamp.radius;
        if (nearest.length < slots + 1) nearest.push({ lamp, distance });
        else if (distance < nearest[slots].distance) nearest[slots] = { lamp, distance };
        else continue;
        nearest.sort((a, b) => a.distance - b.distance);
      }
    // Фонарь у края выборки гаснет плавно: смена набора при движении камеры незаметна.
    const edge = nearest.length > slots ? nearest[slots].distance : Infinity;
    for (let i = 0; i < Math.min(slots, nearest.length); i++) {
      const { lamp, distance } = nearest[i];
      const fade = edge === Infinity ? 1 : Math.min(1, Math.max(0, (edge - distance) / 12));
      const strength = lamp.neon
        ? neon * fade * NEON_POOL_INTENSITY
        : lamps * fade * LAMP_POOL_INTENSITY;
      positions.set([lamp.position.x, lamp.position.y, lamp.position.z, lamp.radius], i * 4);
      colors.set(
        [lamp.color[0] * strength, lamp.color[1] * strength, lamp.color[2] * strength, lamp.height],
        i * 4,
      );
    }
  }

  /**
   * Помечать ли огни для ореола. Включать только вместе с ореолом: без его прохода
   * слияния отрицательная альфа дошла бы до холста. Униформа, без пересборки шейдеров.
   */
  setGlowMask(on: boolean): void {
    this.state.clock[3] = on ? 1 : 0;
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.state.enabled) return;
    this.state.enabled = enabled;
    this.scene.markAllMaterialsAsDirty(Constants.MATERIAL_AllDirtyFlag);
  }

  dispose(): void {
    states.delete(this.scene);
    this.sources.clear();
  }
}
