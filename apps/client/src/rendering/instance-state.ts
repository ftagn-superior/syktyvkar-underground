import { MaterialPluginBase } from '@babylonjs/core/Materials/materialPluginBase';
import type { Material } from '@babylonjs/core/Materials/material';
import type { UniformBuffer } from '@babylonjs/core/Materials/uniformBuffer';
import type { RadialState } from './radial-fog';

export const INSTANCE_STATE_ATTRIBUTE = 'suInstanceState';

/** Per-instance streaming state; radial fog reads the same varying for GLBs and trees. */
export class InstanceStateMaterial extends MaterialPluginBase {
  constructor(
    material: Material,
    private readonly radial?: RadialState,
  ) {
    super(material, 'StaticInstanceState', 200, { SU_INSTANCE_STATE: true }, true, false);
    this.doNotSerialize = true;
    this.registerForExtraEvents = true;
    this._enable(true);
  }
  override getAttributes(attributes: string[]) {
    attributes.push(INSTANCE_STATE_ATTRIBUTE);
  }
  override getUniforms() {
    return {
      ubo: [{ name: 'suInstanceClock', size: 2, type: 'vec2' }],
      vertex: 'uniform vec2 suInstanceClock;',
    };
  }
  override hardBindForSubMesh(buffer: UniformBuffer) {
    buffer.updateFloat2('suInstanceClock', this.radial?.time ?? 1, this.radial?.appearMs ?? 1);
  }
  override getCustomCode(shaderType: string): Record<string, string> | null {
    if (shaderType === 'vertex')
      return {
        CUSTOM_VERTEX_DEFINITIONS: `attribute vec4 ${INSTANCE_STATE_ATTRIBUTE};\nvarying float vSuInstanceAppearance;`,
        CUSTOM_VERTEX_UPDATE_POSITION: `vSuInstanceAppearance = clamp((suInstanceClock.x - ${INSTANCE_STATE_ATTRIBUTE}.x) / max(1.0, suInstanceClock.y), 0.0, 1.0);`,
      };
    if (shaderType === 'fragment')
      return {
        CUSTOM_FRAGMENT_DEFINITIONS: 'varying float vSuInstanceAppearance;',
      };
    return null;
  }
}
