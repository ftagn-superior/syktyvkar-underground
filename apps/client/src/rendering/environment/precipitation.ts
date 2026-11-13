import type { Scene } from '@babylonjs/core/scene';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial';
import { Vector3, Vector4 } from '@babylonjs/core/Maths/math.vector';
import { Color4 } from '@babylonjs/core/Maths/math.color';

/**
 * Дождь и снег: один меш из множества четырёхугольников, один вызов отрисовки на вид
 * осадков. Капли привязаны к миру, а не к камере: их сетка повторяется в объёме вокруг
 * точки обзора, и шейдер переносит каждую каплю на тот повтор, что попал в объём.
 * Поэтому камера движется сквозь дождь, а не тащит его за собой, и ЦП каждый кадр
 * передаёт только несколько униформ.
 */
export type PrecipitationKind = 'rain' | 'snow';

/** Капель в меше; экономичный режим рисует их часть. */
const DROPS = 12_000;
const ECONOMY_SHARE = 0.45;

type KindStyle = {
  /** Скорость падения, м/с. */
  fall: number;
  /** Ветер по X и Z мира, м/с. */
  wind: [number, number];
  /** Длина и ширина капли (для снега — сторона снежинки), м. */
  length: number;
  width: number;
  /** Непрозрачность капли при полной силе. */
  alpha: number;
  /** Длина и ширина от первого лица: вблизи капли крупнее, чем в виде сверху. */
  eyeLength: number;
  eyeWidth: number;
};
const STYLES: Record<PrecipitationKind, KindStyle> = {
  // Ветер того же направления, что несёт облака (см. `CLOUD_FIELD.wind`), только слабее.
  rain: {
    fall: 11,
    wind: [1.6, 0.7],
    length: 0.8,
    width: 0.04,
    alpha: 0.38,
    eyeLength: 0.5,
    eyeWidth: 0.012,
  },
  snow: {
    fall: 1.3,
    wind: [0.7, 0.3],
    length: 0.13,
    width: 0.13,
    alpha: 1,
    eyeLength: 0.05,
    eyeWidth: 0.05,
  },
};
/** Объём от первого лица: сторона и высота, м. */
const EYE_VOLUME = { size: 36, height: 24, below: 8 };
/** Высота объёма сверху при приближении 1; растёт вместе с отдалением камеры. */
const OVERHEAD_HEIGHT = 18;

const VERTEX = `
  precision highp float;
  attribute vec3 position;
  attribute vec2 uv;
  uniform mat4 viewProjection;
  // Центр X, низ Y, центр Z, сторона объёма.
  uniform vec4 volume;
  // Время (с), скорость падения, высота объёма, доля видимых капель.
  uniform vec4 motion;
  // Ветер X, ветер Z, длина, ширина капли.
  uniform vec4 shape;
  // Положение глаза; w = 1 — ортографическая камера, тогда смотрим вдоль viewDirection.
  uniform vec4 eye;
  uniform vec3 viewDirection;
  varying vec2 vCorner;
  varying float vFade;

  float hash(vec3 seed) {
    return fract(sin(dot(seed, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
  }

  void main() {
    float r = hash(position);
    vCorner = uv;
    if (r >= motion.w) {
      // Вне отсечения: вершина отбрасывается до растеризации.
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      vFade = 0.0;
      return;
    }
    float t = motion.x;
    float speed = motion.y * (0.8 + 0.4 * fract(r * 7.13));
    float height = motion.z;
    float along = fract(position.y - t * speed / height);
    vec2 travel = shape.xy * t * (0.8 + 0.4 * fract(r * 3.7));
    #ifdef SNOW
      // Снежинки покачиваются, каждая в своём ритме.
      travel += vec2(sin(t * 0.9 + r * 40.0), cos(t * 0.7 + r * 31.0)) * 0.5 * motion.y / 1.3;
    #endif
    vec2 centre = volume.xz;
    vec2 cell = fract((position.xz * volume.w + travel - centre) / volume.w + 0.5);
    vec3 point = vec3(centre.x + (cell.x - 0.5) * volume.w, volume.y + along * height, centre.y + (cell.y - 0.5) * volume.w);
    // У границ объёма капли гаснут, чтобы перенос на другой повтор был незаметен.
    vec2 edge = min(cell, 1.0 - cell);
    vFade = smoothstep(0.0, 0.06, min(edge.x, edge.y)) * smoothstep(0.0, 0.08, along) * smoothstep(1.0, 0.85, along);

    vec3 toEye = eye.w > 0.5 ? -viewDirection : normalize(eye.xyz - point);
    // От первого лица капли у самого глаза закрыли бы кадр: они гаснут ближе 1,5 м.
    if (eye.w < 0.5) vFade *= smoothstep(0.6, 1.5, distance(point, eye.xyz));
    #ifdef SNOW
      vec3 right = normalize(cross(toEye, vec3(0.0, 1.0, 0.0)));
      vec3 up = cross(right, toEye);
      point += (right * uv.x + up * (uv.y * 2.0 - 1.0)) * shape.w * 0.5;
    #else
      // Черта вдоль скорости капли, развёрнутая к камере вокруг этой оси.
      vec3 axis = normalize(vec3(shape.x, -speed, shape.y));
      vec3 side = normalize(cross(axis, toEye));
      point += side * uv.x * shape.w * 0.5 - axis * uv.y * shape.z;
    #endif
    gl_Position = viewProjection * vec4(point, 1.0);
  }
`;
const FRAGMENT = `
  precision highp float;
  uniform vec4 tint;
  varying vec2 vCorner;
  varying float vFade;
  void main() {
    #ifdef SNOW
      float shape = smoothstep(1.0, 0.35, length(vec2(vCorner.x, vCorner.y * 2.0 - 1.0)));
    #else
      float shape = (1.0 - abs(vCorner.x)) * (1.0 - vCorner.y);
    #endif
    float alpha = tint.a * shape * vFade;
    if (alpha <= 0.002) discard;
    gl_FragColor = vec4(tint.rgb, alpha);
  }
`;

/** Квадраты капель: семя капли в `position`, угол квада в `uv` (x −1..1, y 0..1). */
function dropGeometry(count: number, seed = 0x5eed): VertexData {
  let state = seed >>> 0;
  const random = () => {
    // Mulberry32: одинаковые капли у всех клиентов и в тестах.
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const positions = new Float32Array(count * 12);
  const uvs = new Float32Array(count * 8);
  const indices = new Uint32Array(count * 6);
  const corners = [-1, 0, 1, 0, 1, 1, -1, 1];
  for (let i = 0; i < count; i++) {
    const seedX = random();
    const seedY = random();
    const seedZ = random();
    for (let corner = 0; corner < 4; corner++) {
      positions.set([seedX, seedY, seedZ], i * 12 + corner * 3);
      uvs[i * 8 + corner * 2] = corners[corner * 2]!;
      uvs[i * 8 + corner * 2 + 1] = corners[corner * 2 + 1]!;
    }
    const base = i * 4;
    indices.set([base, base + 1, base + 2, base, base + 2, base + 3], i * 6);
  }
  const data = new VertexData();
  data.positions = positions;
  data.uvs = uvs;
  data.indices = indices;
  return data;
}

export type PrecipitationFrame = {
  /** Сила осадков 0..1: доля видимых капель. */
  amount: number;
  /** Секунды настенного времени; одинаковые у всех клиентов. */
  seconds: number;
  /** Ортографический вид сверху или глаза от первого лица. */
  overhead: boolean;
  /** Положение глаза и направление взгляда активной камеры. */
  eye: Vector3;
  forward: Vector3;
  /** Точка, за которой следит камера сверху. */
  target: Vector3;
  /** Половина ширины и высоты кадра сверху, м. */
  halfWidth: number;
  halfHeight: number;
  /** Отдаление камеры сверху: 1 — обычный вид. */
  zoom: number;
  /** Цвет капель при текущем свете и доля тумана, гасящего их. */
  color: readonly [number, number, number];
  fog: number;
};

/** Один вид осадков. Пока он не идёт, меш выключен и не стоит ничего. */
export class PrecipitationLayer {
  private readonly mesh: Mesh;
  private readonly material: ShaderMaterial;
  private readonly style: KindStyle;
  private share = 1;
  private readonly volume = new Vector4();
  private readonly motion = new Vector4();
  private readonly shape = new Vector4();
  private readonly eye = new Vector4();
  private readonly tint = new Color4();

  constructor(
    scene: Scene,
    readonly kind: PrecipitationKind,
  ) {
    this.style = STYLES[kind];
    const mesh = (this.mesh = new Mesh(`precipitation-${kind}`, scene));
    dropGeometry(DROPS, kind === 'rain' ? 0x5eed : 0x5a0f).applyToMesh(mesh, false);
    const material = (this.material = new ShaderMaterial(
      `precipitation-${kind}`,
      scene,
      { vertexSource: VERTEX, fragmentSource: FRAGMENT },
      {
        attributes: ['position', 'uv'],
        uniforms: ['viewProjection', 'volume', 'motion', 'shape', 'eye', 'viewDirection', 'tint'],
        defines: kind === 'snow' ? ['#define SNOW'] : [],
        needAlphaBlending: true,
      },
    ));
    material.backFaceCulling = false;
    material.disableDepthWrite = true;
    mesh.material = material;
    mesh.isPickable = false;
    // Капли расставляет шейдер; границы меша ничего не значат.
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.doNotSyncBoundingInfo = true;
    mesh.setEnabled(false);
  }

  setEconomy(economy: boolean): void {
    this.share = economy ? ECONOMY_SHARE : 1;
  }

  update(frame: PrecipitationFrame): void {
    const visible = frame.amount > 0.001;
    if (this.mesh.isEnabled() !== visible) this.mesh.setEnabled(visible);
    if (!visible) return;
    const style = this.style;
    let scale = 1;
    if (frame.overhead) {
      // Сверху размеры и скорость растут с отдалением: на экране дождь выглядит одинаково,
      // а капель в кадре столько же.
      scale = Math.max(0.6, frame.zoom);
      const height = OVERHEAD_HEIGHT * scale;
      const tilt = Math.max(0.3, Math.abs(frame.forward.y));
      const reach = Math.max(frame.halfWidth, frame.halfHeight / tilt);
      // Луч взгляда проходит слой высотой `height` наискосок: объём сдвинут к камере.
      const back = (height * Math.sqrt(1 - tilt * tilt)) / tilt;
      const flat = Math.hypot(frame.forward.x, frame.forward.z) || 1;
      this.volume.set(
        frame.target.x - (frame.forward.x / flat) * back * 0.5,
        frame.target.y - 1,
        frame.target.z - (frame.forward.z / flat) * back * 0.5,
        2 * reach + back,
      );
      this.motion.set(frame.seconds, style.fall * scale, height, frame.amount * this.share);
      this.eye.set(0, 0, 0, 1);
    } else {
      this.volume.set(frame.eye.x, frame.eye.y - EYE_VOLUME.below, frame.eye.z, EYE_VOLUME.size);
      this.motion.set(frame.seconds, style.fall, EYE_VOLUME.height, frame.amount * this.share);
      this.eye.set(frame.eye.x, frame.eye.y, frame.eye.z, 0);
    }
    this.shape.set(
      style.wind[0] * scale,
      style.wind[1] * scale,
      frame.overhead ? style.length * scale : style.eyeLength,
      frame.overhead ? style.width * scale : style.eyeWidth,
    );
    const [r, g, b] = frame.color;
    this.tint.set(r, g, b, style.alpha * (1 - 0.7 * frame.fog));
    this.material
      .setVector4('volume', this.volume)
      .setVector4('motion', this.motion)
      .setVector4('shape', this.shape)
      .setVector4('eye', this.eye)
      .setVector3('viewDirection', frame.forward)
      .setColor4('tint', this.tint);
  }

  dispose(): void {
    this.mesh.dispose();
    this.material.dispose();
  }
}

export { dropGeometry as precipitationGeometry, DROPS as PRECIPITATION_DROPS };
