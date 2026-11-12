import { MaterialPluginBase } from '@babylonjs/core/Materials/materialPluginBase';
import type { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import type { UniformBuffer } from '@babylonjs/core/Materials/uniformBuffer';
import type { RadialState } from './radial-fog';

export const TREE_ATTRIBUTES = [
  'suTreeCrown0',
  'suTreeCrown1',
  'suTreeTrunk',
  'suTreeState',
] as const;

/** Shared by the color and ShadowDepthWrapper shaders: silhouettes and normals stay identical. */
export class TreeMaterial extends MaterialPluginBase {
  constructor(
    material: PBRMaterial,
    private readonly radial?: RadialState,
    foliage?: 'broadleaf',
  ) {
    super(
      material,
      'TreeInstances',
      200,
      { SU_TREE_INSTANCES: true, SU_TREE_BROADLEAF: !!foliage },
      true,
      false,
    );
    this.doNotSerialize = true;
    this.registerForExtraEvents = true;
    this._enable(true);
  }
  override getAttributes(attributes: string[]) {
    attributes.push('suTreePart', ...TREE_ATTRIBUTES);
  }
  override getUniforms() {
    return {
      ubo: [{ name: 'suTreeClock', size: 2, type: 'vec2' }],
      vertex: 'uniform vec2 suTreeClock;',
    };
  }
  override hardBindForSubMesh(buffer: UniformBuffer) {
    buffer.updateFloat2('suTreeClock', this.radial?.time ?? 1, this.radial?.appearMs ?? 1);
  }
  override getCustomCode(shaderType: string): Record<string, string> | null {
    if (shaderType === 'vertex')
      return {
        CUSTOM_VERTEX_DEFINITIONS: `
        attribute float suTreePart;
        attribute vec4 suTreeCrown0;
        attribute vec4 suTreeCrown1;
        attribute vec4 suTreeTrunk;
        attribute vec4 suTreeState;
        varying float vSuTreeAppearance;
        varying float vSuTreeOpacity;
      `,
        CUSTOM_VERTEX_UPDATE_POSITION: `
        if (suTreePart < 1.5) {
          #ifdef SU_TREE_BROADLEAF
          float radius = max(max(suTreeCrown0.x, suTreeCrown0.y), max(suTreeCrown1.x, suTreeCrown1.y));
          float height = suTreeCrown1.z + suTreeCrown1.w - suTreeCrown0.z;
          positionUpdated *= vec3(radius, height, radius);
          positionUpdated.y += suTreeCrown0.z;
          normalUpdated = normalize(normalUpdated / vec3(radius, height, radius));
          #else
          vec4 shape = suTreePart < 0.5 ? suTreeCrown0 : suTreeCrown1;
          positionUpdated.xz *= mix(shape.x, shape.y, positionUpdated.y);
          positionUpdated.y = shape.z + positionUpdated.y * shape.w;
          if (abs(normalUpdated.y) < 0.5) {
            normalUpdated.y = (shape.x - shape.y) * ${Math.cos(Math.PI / 7).toPrecision(16)} / shape.w;
            normalUpdated = normalize(normalUpdated);
          }
          #endif
        } else {
          positionUpdated *= suTreeTrunk.xyz;
          float c = cos(suTreeTrunk.w), s = sin(suTreeTrunk.w);
          positionUpdated.xz = mat2(c, -s, s, c) * positionUpdated.xz;
          positionUpdated.y += suTreeState.z;
          normalUpdated.xz = mat2(c, -s, s, c) * normalUpdated.xz;
        }
        vSuTreeAppearance = clamp((suTreeClock.x - suTreeState.x) / max(1.0, suTreeClock.y), 0.0, 1.0);
        vSuTreeOpacity = suTreeState.y;
      `,
      };
    if (shaderType === 'fragment')
      return {
        CUSTOM_FRAGMENT_DEFINITIONS:
          'varying float vSuTreeAppearance;\nvarying float vSuTreeOpacity;',
        CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR: 'finalColor.a *= vSuTreeOpacity;',
      };
    return null;
  }
}
