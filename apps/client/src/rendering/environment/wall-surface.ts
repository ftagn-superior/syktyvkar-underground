import type { Scene } from '@babylonjs/core/scene';
import { Constants } from '@babylonjs/core/Engines/constants';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { Material } from '@babylonjs/core/Materials/material';
import type { MaterialDefines } from '@babylonjs/core/Materials/materialDefines';
import { MaterialPluginBase } from '@babylonjs/core/Materials/materialPluginBase';
import { RegisterMaterialPlugin } from '@babylonjs/core/Materials/materialPluginManager';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer';
import { SURFACE_KIND } from '@su/contracts';

/**
 * Материал стен без текстур: кирпич, доска, панели, плитка, профлист, блоки и штукатурка
 * рисуются в шейдере по координатам фасада, которые сборщик записал в TEXCOORD_1
 * (`SURFACE_KIND` × 1000 + метры вдоль стены, метры по высоте). Меняется только цвет
 * поверхности до освещения; новых мешей, текстур и вызовов отрисовки нет. Вдали мелкий
 * рисунок плавно сменяется средним цветом, поэтому швы не рябят.
 */

/** Имя атрибута, в который переносится TEXCOORD_1 статичных моделей. */
export const SURFACE_ATTRIBUTE = 'suSurface';

/** Переносит материал стен из второй UV модели в собственный атрибут. */
export function adoptSurfaceAttribute(mesh: Mesh): boolean {
  const data = mesh.getVerticesData(VertexBuffer.UV2Kind);
  if (!data) return false;
  mesh.setVerticesData(SURFACE_ATTRIBUTE, data, false, 2);
  mesh.removeVerticesData(VertexBuffer.UV2Kind);
  return true;
}

const K = SURFACE_KIND;
/** GLSL: узор материала поверх цвета `albedo` (линейный RGB); `s` — класс, u, v. */
const PATTERN = `
  // Хеш без sin (Hoskins): на встроенных GPU sin в каждом пикселе заметно дороже.
  float suWallHash(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  float suWallNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(suWallHash(i), suWallHash(i + vec2(1.0, 0.0)), f.x),
               mix(suWallHash(i + vec2(0.0, 1.0)), suWallHash(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  // Доля шва ширины width с периодом period; fw — размер пикселя в тех же единицах.
  float suWallSeam(float x, float period, float width, float fw) {
    float d = abs(fract(x / period + 0.5) - 0.5) * period;
    return 1.0 - smoothstep(width * 0.5 - fw, width * 0.5 + fw, d);
  }
  vec3 suWallSurface(vec3 albedo, vec3 s) {
    float kind = s.x;
    vec2 p = s.yz;
  #ifdef WEBGL2
    vec2 fw = fwidth(p);
  #else
    vec2 fw = vec2(1.0);
  #endif
    float f = max(fw.x, fw.y);
    // Крупные пятна и грязь у земли видны с любого расстояния.
    float stain = 0.96 + 0.04 * sin(p.x * 0.9 + 2.0 * sin(p.y * 0.55 + p.x * 0.21));
    float grime = 0.88 + 0.12 * smoothstep(0.0, 1.4, p.y);
    vec3 base = albedo * stain * grime;
    if (kind == ${K.plaster}.0) {
      float fine = 0.97 + 0.06 * suWallNoise(p * 9.0);
      return base * mix(1.0, fine, 1.0 - smoothstep(0.02, 0.08, f));
    }
    if (kind == ${K.brick}.0 || kind == ${K.block}.0) {
      bool brick = kind == ${K.brick}.0;
      float h = brick ? 0.077 : 0.3;
      float w = brick ? 0.26 : 0.6;
      float joint = brick ? 0.012 : 0.014;
      vec3 mortarColor = mix(base, vec3(brick ? 0.42 : 0.3), 0.55);
      vec3 mean = mix(base * 1.03, mortarColor, brick ? 0.2 : 0.07);
      float fade = 1.0 - smoothstep(joint, h * 0.45, f);
      // Вдали кирпичи мельче пикселя: средний цвет без швов и хеша.
      if (fade <= 0.0) return mean;
      float row = floor(p.y / h);
      float x = p.x + mod(row, 2.0) * w * 0.5;
      float mortar = max(suWallSeam(p.y, h, joint, fw.y), suWallSeam(x, w, joint, fw.x));
      float tone = (brick ? 0.88 : 0.93) + (brick ? 0.24 : 0.14) * suWallHash(vec2(floor(x / w), row));
      vec3 detail = mix(base * tone * 1.03, mortarColor, mortar);
      return mix(mean, detail, fade);
    }
    if (kind == ${K.wood}.0 || kind == ${K.siding}.0) {
      bool wood = kind == ${K.wood}.0;
      float b = wood ? 0.17 : 0.2;
      vec3 mean = base * (wood ? 0.95 : 0.97);
      float fade = 1.0 - smoothstep(0.02, b * 0.45, f);
      if (fade <= 0.0) return mean;
      float board = floor(p.y / b);
      float t = fract(p.y / b);
      float groove = suWallSeam(p.y, b, wood ? 0.014 : 0.01, fw.y);
      float tone = wood ? 0.86 + 0.26 * suWallHash(vec2(board, floor(p.x / 4.5))) : 0.97 + 0.06 * suWallHash(vec2(board, 0.0));
      float lap = 0.9 + 0.14 * t;
      float grainFade = wood ? 1.0 - smoothstep(0.004, 0.02, f) : 0.0;
      float grain = grainFade > 0.0
        ? mix(1.0, 0.92 + 0.16 * suWallNoise(vec2(p.x * 2.5, p.y * 60.0)), grainFade)
        : 1.0;
      vec3 detail = base * tone * lap * grain * (1.0 - (wood ? 0.55 : 0.35) * groove);
      return mix(mean, detail, fade);
    }
    if (kind == ${K.panel}.0) {
      // Координаты панелей — в шагах окон и этажах: швы целые.
      float seam = max(suWallSeam(p.x, 1.0, 0.012, fw.x), suWallSeam(p.y, 1.0, 0.012, fw.y));
      float tone = 0.93 + 0.14 * suWallHash(floor(p) + 0.37);
      float seamFade = 1.0 - smoothstep(0.004, 0.02, f);
      return base * tone * (1.0 - 0.5 * seam * seamFade);
    }
    if (kind == ${K.tile}.0) {
      vec3 groutColor = mix(base, vec3(0.5), 0.5);
      vec3 mean = mix(base, groutColor, 0.1);
      float fade = 1.0 - smoothstep(0.008, 0.06, f);
      if (fade <= 0.0) return mean;
      float grout = max(suWallSeam(p.x, 0.15, 0.008, fw.x), suWallSeam(p.y, 0.15, 0.008, fw.y));
      float tone = 0.95 + 0.1 * suWallHash(floor(p / 0.15));
      vec3 detail = mix(base * tone, groutColor, grout);
      return mix(mean, detail, fade);
    }
    if (kind == ${K.metal}.0) {
      float wave = 0.88 + 0.24 * (0.5 + 0.5 * sin(p.x * 41.89));
      float sheet = suWallSeam(p.x, 1.05, 0.02, fw.x);
      vec3 detail = base * mix(wave, 1.0, 1.0 - smoothstep(0.01, 0.06, f)) * (1.0 - 0.35 * sheet);
      return detail;
    }
    return albedo;
  }
`;

type SurfaceState = { enabled: boolean };
const states = new WeakMap<Scene, SurfaceState>();
let registered = false;

class WallSurfacePlugin extends MaterialPluginBase {
  constructor(
    material: Material,
    private readonly state: SurfaceState,
  ) {
    // До ночного света (207): узор меняет цвет поверхности до освещения.
    super(material, 'WorldWallSurface', 204, { SU_SURFACE: false }, true, false);
    this.doNotSerialize = true;
    this._enable(true);
  }
  override getClassName() {
    return 'WorldWallSurface';
  }
  override prepareDefines(defines: MaterialDefines, _scene: Scene, mesh: AbstractMesh) {
    (defines as MaterialDefines & { SU_SURFACE: boolean }).SU_SURFACE =
      this.state.enabled && mesh.isVerticesDataPresent(SURFACE_ATTRIBUTE);
  }
  override getAttributes(attributes: string[], _scene: Scene, mesh: AbstractMesh) {
    if (
      this.state.enabled &&
      mesh.isVerticesDataPresent(SURFACE_ATTRIBUTE) &&
      !attributes.includes(SURFACE_ATTRIBUTE)
    )
      attributes.push(SURFACE_ATTRIBUTE);
  }
  override getCustomCode(shaderType: string): Record<string, string> | null {
    if (shaderType === 'vertex')
      return {
        CUSTOM_VERTEX_DEFINITIONS: `
          #ifdef SU_SURFACE
            attribute vec2 ${SURFACE_ATTRIBUTE};
            varying vec3 vSuSurface;
          #endif
        `,
        CUSTOM_VERTEX_MAIN_END: `
          #ifdef SU_SURFACE
            float suKind = floor(${SURFACE_ATTRIBUTE}.x / 1000.0 + 0.0005);
            vSuSurface = vec3(suKind, ${SURFACE_ATTRIBUTE}.x - suKind * 1000.0, ${SURFACE_ATTRIBUTE}.y);
          #endif
        `,
      };
    if (shaderType !== 'fragment') return null;
    const definitions = `
      #ifdef SU_SURFACE
        varying vec3 vSuSurface;
        ${PATTERN}
      #endif
    `;
    if (this._material instanceof PBRMaterial)
      return {
        CUSTOM_FRAGMENT_DEFINITIONS: definitions,
        CUSTOM_FRAGMENT_BEFORE_LIGHTS: `
          #ifdef SU_SURFACE
            surfaceAlbedo = suWallSurface(surfaceAlbedo, vSuSurface);
          #endif
        `,
      };
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: definitions,
      CUSTOM_FRAGMENT_UPDATE_DIFFUSE: `
        #ifdef SU_SURFACE
          baseColor.rgb = suWallSurface(baseColor.rgb, vSuSurface);
        #endif
      `,
    };
  }
}

/** Экономичный режим выключает рисунок стен: остаётся ровный цвет, шейдер без узора. */
export function setWallSurfaceEconomy(scene: Scene, economy: boolean): void {
  const state = states.get(scene);
  if (!state || state.enabled === !economy) return;
  state.enabled = !economy;
  scene.markAllMaterialsAsDirty(Constants.MATERIAL_AllDirtyFlag);
}

/**
 * Подключает материал стен к материалам сцены. Вызывается до загрузки зданий, как ночной
 * свет: плагин присоединяется к материалам при их создании.
 */
export function registerWallSurface(scene: Scene): SurfaceState {
  let state = states.get(scene);
  if (!state) {
    state = { enabled: true };
    states.set(scene, state);
  }
  if (!registered) {
    registered = true;
    RegisterMaterialPlugin('WorldWallSurface', (material) => {
      const target = states.get(material.getScene());
      return target && (material instanceof StandardMaterial || material instanceof PBRMaterial)
        ? new WallSurfacePlugin(material, target)
        : null;
    });
  }
  return state;
}
