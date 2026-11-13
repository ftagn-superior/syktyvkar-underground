import { MaterialPluginBase } from '@babylonjs/core/Materials/materialPluginBase';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { MultiMaterial } from '@babylonjs/core/Materials/multiMaterial';
import type { Material } from '@babylonjs/core/Materials/material';
import type { UniformBuffer } from '@babylonjs/core/Materials/uniformBuffer';
import type { Scene } from '@babylonjs/core/scene';
import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine';
import type { SubMesh } from '@babylonjs/core/Meshes/subMesh';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import type { Vec3 } from '@su/contracts';

export type RadialState = {
  center: Vec3;
  radius: number;
  time: number;
  appearMs: number;
  dynamic?: boolean;
};
/** World-space fog preserves opaque rendering and composes with the existing occlusion alpha. */
export class RadialFog extends MaterialPluginBase {
  constructor(
    material: Material,
    private readonly state: RadialState,
  ) {
    super(material, 'WorldRadialFog', 210, {}, true, false);
    // The runtime view owns the center/time; cloned materials get their own plugin on retain.
    this.doNotSerialize = true;
    this.registerForExtraEvents = true;
    this._enable(true);
  }
  override getClassName() {
    return 'WorldRadialFog';
  }
  override getUniforms() {
    return {
      ubo: [
        { name: 'suRadial', size: 4, type: 'vec4' },
        { name: 'suAppearance', size: 1, type: 'float' },
        { name: 'suDynamic', size: 1, type: 'float' },
        { name: 'suFogColor', size: 3, type: 'vec3' },
      ],
      fragment:
        'uniform vec4 suRadial;\nuniform float suAppearance;\nuniform float suDynamic;\nuniform vec3 suFogColor;',
    };
  }
  override hardBindForSubMesh(
    buffer: UniformBuffer,
    _scene: Scene,
    _engine: AbstractEngine,
    subMesh: SubMesh,
  ) {
    const mesh = subMesh.getMesh();
    const born = mesh.metadata?.suStreamingBorn ?? -Infinity;
    buffer.updateFloat4(
      'suRadial',
      this.state.center.x,
      this.state.center.z,
      Math.min(1_000_000, this.state.radius),
      75,
    );
    buffer.updateFloat('suDynamic', this.state.dynamic ? 1 : 0);
    // Край города растворяется в пустоте вокруг него, какого бы цвета она ни была в этот час.
    const backdrop = this._material.getScene().clearColor;
    buffer.updateFloat3('suFogColor', backdrop.r, backdrop.g, backdrop.b);
    buffer.updateFloat(
      'suAppearance',
      Math.min(1, Math.max(0, (this.state.time - born) / this.state.appearMs)),
    );
  }
  override getCustomCode(shaderType: string) {
    if (shaderType !== 'fragment') return null;
    const output = this._material instanceof PBRMaterial ? 'finalColor' : 'color';
    // Dynamic AOI is narrower than the graphical circle: invisible avatars/items must not
    // paint opaque fog silhouettes over the prepared distant city. Coverage fading preserves
    // their existing material alpha (disconnect/occlusion) and depth behavior.
    return {
      CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR: `
        float suDistance = length(vPositionW.xz - suRadial.xy);
        #ifdef SU_INSTANCE_STATE
          float suAppear = vSuInstanceAppearance;
        #else
          float suAppear = suAppearance;
        #endif
        float suVisibility = (1.0 - smoothstep(max(0.0, suRadial.z - suRadial.w), max(0.001, suRadial.z), suDistance)) * suAppear;
        if (suDynamic > 0.5) {
          float suCoverage = fract(dot(floor(gl_FragCoord.xy), vec2(0.754877666, 0.569840296)));
          if (suVisibility <= suCoverage) discard;
        } else {
          ${output}.rgb = mix(suFogColor, ${output}.rgb, suVisibility);
        }
      `,
    };
  }
}
const plugins = new WeakMap<Material, RadialFog>();
export function applyRadialFog(mesh: AbstractMesh, state: RadialState, born: number): void {
  // Вызывается каждый кадр для динамических сущностей: не пересоздаём metadata без нужды.
  if (mesh.metadata?.suStreamingBorn === undefined)
    mesh.metadata = { ...mesh.metadata, suStreamingBorn: born };
  const apply = (material: Material | null) => {
    if (material instanceof MultiMaterial) {
      for (const child of material.subMaterials) apply(child);
      return;
    }
    if (!(material instanceof StandardMaterial) && !(material instanceof PBRMaterial)) return;
    if (!plugins.has(material)) plugins.set(material, new RadialFog(material, state));
  };
  apply(mesh.material);
}
export function radialOpacity(center: Vec3, position: Vec3, radius: number): number {
  if (radius <= 0) return 0;
  if (radius === Infinity) return 1;
  const inner = Math.max(0, radius - 75);
  const t = Math.max(
    0,
    Math.min(
      1,
      (Math.hypot(position.x - center.x, position.z - center.z) - inner) / (radius - inner),
    ),
  );
  return 1 - t * t * (3 - 2 * t);
}
