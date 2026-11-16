import type { Scene } from '@babylonjs/core/scene';
import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine';
import { Constants } from '@babylonjs/core/Engines/constants';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import type { SubMesh } from '@babylonjs/core/Meshes/subMesh';
import type { Material } from '@babylonjs/core/Materials/material';
import type { MaterialDefines } from '@babylonjs/core/Materials/materialDefines';
import { MaterialPluginBase } from '@babylonjs/core/Materials/materialPluginBase';
import { RegisterMaterialPlugin } from '@babylonjs/core/Materials/materialPluginManager';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial';
import type { UniformBuffer } from '@babylonjs/core/Materials/uniformBuffer';
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector';
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
/** Original mesh translation for merged buildings; keeps their night schedule unchanged. */
export const GLOW_ORIGIN_ATTRIBUTE = 'suGlowOrigin';
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
const CONE_SEGMENTS = 16;

const CONE_VERTEX = `
  precision highp float;
  attribute vec3 position;
  attribute vec3 normal;
  attribute vec4 suConeData;
  #include<instancesDeclaration>
  uniform mat4 viewProjection;
  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying vec3 vConeColor;
  varying float vAlong;
  void main(void) {
    #include<instancesVertex>
    float height = suConeData.w;
    float below = position.y * height;
    float radius = 0.25 + below * ${CONE_TAN.toFixed(4)};
    vec3 localPos = vec3(position.x * radius, -below, position.z * radius);
    vec4 worldPos = finalWorld * vec4(localPos, 1.0);
    vWorldPos = worldPos.xyz;
    vNormal = normalize(mat3(finalWorld) * vec3(normal.x, ${CONE_TAN.toFixed(4)}, normal.z));
    vConeColor = suConeData.rgb;
    vAlong = 1.0 - position.y;
    gl_Position = viewProjection * worldPos;
  }
`;

const CONE_FRAGMENT = `
  precision highp float;
  uniform vec3 eyePosition;
  uniform float scatter;
  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying vec3 vConeColor;
  varying float vAlong;
  void main(void) {
    vec3 viewDir = normalize(eyePosition - vWorldPos);
    float facing = abs(dot(normalize(vNormal), viewDir));
    float edge = pow(facing, 1.4);
    float along = clamp(vAlong, 0.0, 1.0);
    float intensity = along * along * edge * scatter;
    gl_FragColor = vec4(vConeColor * intensity, 0.0);
  }
`;

function coneGeometry(): VertexData {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (let ring = 0; ring <= 1; ring++) {
    for (let i = 0; i <= CONE_SEGMENTS; i++) {
      const angle = (i / CONE_SEGMENTS) * Math.PI * 2;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      positions.push(cos, ring, sin);
      normals.push(cos, 0, sin);
    }
  }
  const row = CONE_SEGMENTS + 1;
  for (let i = 0; i < CONE_SEGMENTS; i++) {
    const a = i;
    const b = i + 1;
    const c = row + i;
    const d = row + i + 1;
    indices.push(a, c, b, b, c, d);
  }
  const data = new VertexData();
  data.positions = positions;
  data.normals = normals;
  data.indices = indices;
  return data;
}

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
  version: number;
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
  private boundVersion = -1;
  private boundBuffer?: UniformBuffer;
  private boundGpuBuffer: unknown;

  constructor(
    material: Material,
    private readonly state: NightState,
  ) {
    // После теней облаков (205) и до радиального тумана (210).
    super(
      material,
      'WorldNightLights',
      207,
      {
        SU_NIGHT: false,
        SU_GLOW: false,
        SU_GLOW_ORIGIN: false,
        SU_LAMP_SLOTS: 0,
      },
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
      SU_GLOW_ORIGIN: boolean;
      SU_LAMP_SLOTS: number;
    };
    target.SU_NIGHT = this.state.enabled && !material.disableLighting && !material.unlit;
    target.SU_GLOW =
      this.state.enabled &&
      this._material instanceof PBRMaterial &&
      mesh.isVerticesDataPresent(GLOW_ATTRIBUTE);
    target.SU_GLOW_ORIGIN = target.SU_GLOW && mesh.isVerticesDataPresent(GLOW_ORIGIN_ATTRIBUTE);
    target.SU_LAMP_SLOTS = target.SU_NIGHT ? this.state.slots : 0;
  }
  override getAttributes(attributes: string[], _scene: Scene, mesh: AbstractMesh) {
    if (
      this.state.enabled &&
      mesh.isVerticesDataPresent(GLOW_ATTRIBUTE) &&
      !attributes.includes(GLOW_ATTRIBUTE)
    )
      attributes.push(GLOW_ATTRIBUTE);
    if (
      this.state.enabled &&
      mesh.isVerticesDataPresent(GLOW_ORIGIN_ATTRIBUTE) &&
      !attributes.includes(GLOW_ORIGIN_ATTRIBUTE)
    )
      attributes.push(GLOW_ORIGIN_ATTRIBUTE);
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
    const gpuBuffer = buffer.getBuffer();
    if (
      gpuBuffer &&
      this.boundVersion === state.version &&
      this.boundBuffer === buffer &&
      this.boundGpuBuffer === gpuBuffer
    )
      return;
    this.boundVersion = state.version;
    this.boundBuffer = buffer;
    this.boundGpuBuffer = gpuBuffer;
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
            #ifdef SU_GLOW_ORIGIN
              attribute vec2 ${GLOW_ORIGIN_ATTRIBUTE};
            #endif
          #endif
        `,
        // Число экземпляра из его положения: одинаковые дома и фонари не мигают в такт.
        CUSTOM_VERTEX_MAIN_END: `
          #ifdef SU_GLOW
            #ifdef SU_GLOW_ORIGIN
              vec2 suOrigin = ${GLOW_ORIGIN_ATTRIBUTE};
            #else
              vec2 suOrigin = finalWorld[3].xz;
            #endif
            float suInstance = fract(sin(dot(floor(suOrigin * 2.0), vec2(12.9898, 78.233))) * 43758.5453);
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
          if (level.w <= 0.0) return vec3(0.0);
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
  private readonly coneMatrices = new Float32Array(LAMP_SLOTS * 16);
  private readonly coneData = new Float32Array(LAMP_SLOTS * 4);
  private readonly coneScratch = new Matrix();
  private coneMesh?: Mesh;
  private coneMaterial?: ShaderMaterial;
  levels: NightLevels = nightLevels(12);

  constructor(private readonly scene: Scene) {
    this.state = {
      enabled: true,
      version: 0,
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
   * смена числа слотов пересобирает шейдеры материалов.
   */
  setEconomy(economy: boolean): void {
    const slots = economy ? ECONOMY_LAMP_SLOTS : LAMP_SLOTS;
    if (slots === this.state.slots && this.state.cones === !economy) return;
    const slotsChanged = slots !== this.state.slots;
    this.state.slots = slots;
    this.state.cones = !economy;
    if (!this.state.cones && this.coneMesh?.isEnabled()) this.coneMesh.setEnabled(false);
    if (slotsChanged) this.scene.markAllMaterialsAsDirty(Constants.MATERIAL_AllDirtyFlag);
  }

  private sourceOwners = new Map<string, number>();
  retainSources(instance: BuildingInstance, lights: readonly StaticLightSource[]): void {
    this.sourceOwners.set(instance.entityId, (this.sourceOwners.get(instance.entityId) ?? 0) + 1);
    this.addSources(instance, lights);
  }
  releaseSources(id: string): void {
    const count = (this.sourceOwners.get(id) ?? 1) - 1;
    if (count > 0) this.sourceOwners.set(id, count);
    else {
      this.sourceOwners.delete(id);
      this.removeSources(id);
    }
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
    this.updateCones(focus);
    this.state.version++;
  }

  private ensureConeResources(): void {
    if (this.coneMesh && this.coneMaterial) return;
    const mesh = (this.coneMesh = new Mesh('night-lamp-cones', this.scene));
    mesh.isPickable = false;
    mesh.alwaysSelectAsActiveMesh = true;
    coneGeometry().applyToMesh(mesh, false);
    mesh.doNotSyncBoundingInfo = true;
    const material = (this.coneMaterial = new ShaderMaterial(
      'night-lamp-cones',
      this.scene,
      { vertexSource: CONE_VERTEX, fragmentSource: CONE_FRAGMENT },
      {
        attributes: ['position', 'normal', 'world0', 'world1', 'world2', 'world3', 'suConeData'],
        uniforms: ['viewProjection', 'eyePosition', 'scatter'],
        needAlphaBlending: true,
      },
    ));
    material.backFaceCulling = false;
    material.disableDepthWrite = true;
    material.alphaMode = Constants.ALPHA_ONEONE;
    material.setFloat('scatter', CONE_SCATTER * 0.65);
    mesh.material = material;
    mesh.thinInstanceSetBuffer('matrix', this.coneMatrices, 16, false);
    mesh.thinInstanceSetBuffer('suConeData', this.coneData, 4, false);
    mesh.thinInstanceCount = 0;
    mesh.setEnabled(false);
  }

  private updateCones(focus: Vector3): void {
    if (!this.state.enabled || !this.state.cones || this.state.clock[2] <= 0) {
      if (this.coneMesh?.isEnabled()) this.coneMesh.setEnabled(false);
      return;
    }
    const positions = this.state.lampPositions;
    const colors = this.state.lampColors;
    let count = 0;
    for (let i = 0; i < this.state.slots; i++) {
      const height = colors[i * 4 + 3];
      if (height <= 0) continue;
      Matrix.TranslationToRef(
        positions[i * 4],
        positions[i * 4 + 1],
        positions[i * 4 + 2],
        this.coneScratch,
      );
      this.coneScratch.copyToArray(this.coneMatrices, count * 16);
      this.coneData.set(
        [colors[i * 4], colors[i * 4 + 1], colors[i * 4 + 2], height],
        count * 4,
      );
      count++;
    }
    if (count === 0) {
      if (this.coneMesh?.isEnabled()) this.coneMesh.setEnabled(false);
      return;
    }
    this.ensureConeResources();
    const mesh = this.coneMesh!;
    mesh.thinInstanceCount = count;
    mesh.thinInstanceBufferUpdated('matrix');
    mesh.thinInstanceBufferUpdated('suConeData');
    this.coneMaterial!.setVector3('eyePosition', this.scene.activeCamera?.globalPosition ?? focus);
    if (!mesh.isEnabled()) mesh.setEnabled(true);
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
    const next = on ? 1 : 0;
    if (this.state.clock[3] === next) return;
    this.state.clock[3] = next;
    this.state.version++;
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.state.enabled) return;
    this.state.enabled = enabled;
    if (!enabled && this.coneMesh?.isEnabled()) this.coneMesh.setEnabled(false);
    this.scene.markAllMaterialsAsDirty(Constants.MATERIAL_AllDirtyFlag);
  }

  dispose(): void {
    states.delete(this.scene);
    this.sources.clear();
    this.sourceOwners.clear();
    this.coneMesh?.dispose();
    this.coneMesh = undefined;
    this.coneMaterial?.dispose();
    this.coneMaterial = undefined;
  }
}
