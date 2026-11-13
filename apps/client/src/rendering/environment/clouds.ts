import type { Scene } from '@babylonjs/core/scene';
import type { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine';
import { Constants } from '@babylonjs/core/Engines/constants';
import { Vector3, Vector4 } from '@babylonjs/core/Maths/math.vector';
import type { Color3 } from '@babylonjs/core/Maths/math.color';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import type { SubMesh } from '@babylonjs/core/Meshes/subMesh';
import type { Material } from '@babylonjs/core/Materials/material';
import type { MaterialDefines } from '@babylonjs/core/Materials/materialDefines';
import { MaterialPluginBase } from '@babylonjs/core/Materials/materialPluginBase';
import { RegisterMaterialPlugin } from '@babylonjs/core/Materials/materialPluginManager';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial';
import { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import type { UniformBuffer } from '@babylonjs/core/Materials/uniformBuffer';
import {
  CLOUD_FIELD,
  cloudCoverage,
  cloudDrift,
  cloudLayerOpacity,
  cloudShadowShift,
} from './cloud-field';
import type { RadialState } from '../radial-fog';

/** How much direct light the middle of a cloud removes at full sun. */
const SHADOW_DEPTH = 0.42;
/** The layer never fully hides the city: the player must still find the streets. */
const LAYER_OPACITY = 0.88;

/** What the frame loop tells the clouds; everything else is derived from the field. */
export type CloudFrame = {
  /** Wall-clock time; shared by all clients. */
  epochMs: number;
  /** Direction the direct light travels. */
  lightDirection: Vector3;
  /** 0..1: how strongly the direct light casts cloud shadows right now. */
  lightStrength: number;
  /** Colour of the cloud tops under the current sky. */
  tint: Color3;
  /** Camera zoom: 1 is the play view, larger is farther out. */
  zoom: number;
  /** Streamed-in part of the world; clouds end where the city does. */
  visible: RadialState;
};

/** Values the shadow plugins of every material read when they bind. */
type CloudState = {
  enabled: boolean;
  texture: RawTexture;
  drift: { u: number; v: number };
  shift: { x: number; z: number };
  strength: number;
};
const states = new WeakMap<Scene, CloudState>();

/**
 * Darkens lit surfaces under a cloud. Attached by a factory to every Standard and PBR
 * material created in a scene that has clouds, so world code never registers materials.
 */
class CloudShadow extends MaterialPluginBase {
  constructor(
    material: Material,
    private readonly state: CloudState,
  ) {
    // Before the radial fog (210): fogged distance must stay the colour of the void.
    super(material, 'WorldCloudShadow', 205, { SU_CLOUD_SHADOW: false }, true, false);
    this.doNotSerialize = true;
    this._enable(true);
  }
  override getClassName() {
    return 'WorldCloudShadow';
  }
  override prepareDefines(defines: MaterialDefines) {
    const material = this._material as { disableLighting?: boolean; unlit?: boolean };
    // Unlit surfaces (labels, markers) glow on their own; a cloud does not dim them.
    (defines as MaterialDefines & { SU_CLOUD_SHADOW: boolean }).SU_CLOUD_SHADOW =
      this.state.enabled && !material.disableLighting && !material.unlit;
  }
  override getSamplers(samplers: string[]) {
    samplers.push('suCloudMap');
  }
  override getUniforms() {
    return {
      ubo: [
        { name: 'suCloud', size: 4, type: 'vec4' },
        { name: 'suCloudSun', size: 4, type: 'vec4' },
      ],
      fragment: 'uniform vec4 suCloud;\nuniform vec4 suCloudSun;',
    };
  }
  override bindForSubMesh(
    buffer: UniformBuffer,
    _scene: Scene,
    _engine: AbstractEngine,
    subMesh: SubMesh,
  ) {
    const { state } = this;
    if (!state.enabled) return;
    buffer.updateFloat4(
      'suCloud',
      state.drift.u,
      state.drift.v,
      1 / CLOUD_FIELD.tileMetres,
      state.strength * SHADOW_DEPTH,
    );
    buffer.updateFloat4('suCloudSun', state.shift.x, state.shift.z, CLOUD_FIELD.altitude, 0);
    subMesh.effect?.setTexture('suCloudMap', state.texture);
  }
  override getCustomCode(shaderType: string) {
    if (shaderType !== 'fragment') return null;
    const output = this._material instanceof PBRMaterial ? 'finalColor' : 'color';
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: `
        #ifdef SU_CLOUD_SHADOW
          uniform sampler2D suCloudMap;
        #endif
      `,
      // Follow the sun ray from the surface up to the cloud layer and read the cover there:
      // roofs and streets get the shadow of the same cloud, displaced by their height.
      CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR: `
        #ifdef SU_CLOUD_SHADOW
          vec2 suCloudAt = vPositionW.xz + suCloudSun.xy * max(0.0, suCloudSun.z - vPositionW.y);
          float suCloudCover = texture2D(suCloudMap, suCloudAt * suCloud.z + suCloud.xy).r;
          ${output}.rgb *= 1.0 - suCloud.w * suCloudCover;
        #endif
      `,
    };
  }
}

const LAYER_VERTEX = `
  precision highp float;
  attribute vec3 position;
  uniform mat4 world;
  uniform mat4 viewProjection;
  varying vec2 vField;
  void main() {
    vec4 point = world * vec4(position, 1.0);
    vField = point.xz;
    gl_Position = viewProjection * point;
  }
`;
const LAYER_FRAGMENT = `
  precision highp float;
  uniform sampler2D cloudMap;
  uniform vec4 cloud;
  uniform vec4 visible;
  uniform vec3 tint;
  varying vec2 vField;
  void main() {
    float cover = texture2D(cloudMap, vField * cloud.z + cloud.xy).r;
    float inside = 1.0 - smoothstep(max(0.0, visible.z - visible.w), max(0.001, visible.z), length(vField - visible.xy));
    // Thick middles read slightly darker than the lit rim: enough volume for a flat layer.
    gl_FragColor = vec4(tint * mix(1.0, 0.84, cover * cover), cover * cloud.w * inside);
  }
`;

/**
 * Drifting clouds over the city. Up close they exist only as moving shadows; as the
 * camera zooms out the same field fades in as a layer above the roofs.
 */
export class WorldClouds {
  private readonly state: CloudState;
  private readonly layer: Mesh;
  private readonly layerMaterial: ShaderMaterial;
  private readonly centre = new Vector3();
  private readonly forward = new Vector3();
  private readonly field = new Vector4();
  private readonly extent = new Vector4();

  constructor(
    private readonly scene: Scene,
    private readonly camera: ArcRotateCamera,
  ) {
    const size = CLOUD_FIELD.textureSize;
    const texture = RawTexture.CreateRTexture(
      cloudCoverage(size),
      size,
      size,
      scene,
      true,
      false,
      Texture.TRILINEAR_SAMPLINGMODE,
      Constants.TEXTURETYPE_UNSIGNED_BYTE,
    );
    texture.name = 'cloud-field';
    texture.wrapU = texture.wrapV = Texture.WRAP_ADDRESSMODE;
    this.state = {
      enabled: true,
      texture,
      drift: { u: 0, v: 0 },
      shift: { x: 0, z: 0 },
      strength: 1,
    };
    states.set(scene, this.state);
    // One factory for the page. Scenes without clouds (the character preview) get nothing.
    RegisterMaterialPlugin('WorldCloudShadow', (material) => {
      const state = states.get(material.getScene());
      return state && (material instanceof StandardMaterial || material instanceof PBRMaterial)
        ? new CloudShadow(material, state)
        : null;
    });

    const material = (this.layerMaterial = new ShaderMaterial(
      'cloud-layer',
      scene,
      { vertexSource: LAYER_VERTEX, fragmentSource: LAYER_FRAGMENT },
      {
        attributes: ['position'],
        uniforms: ['world', 'viewProjection', 'cloud', 'visible', 'tint'],
        samplers: ['cloudMap'],
        needAlphaBlending: true,
      },
    ));
    material.backFaceCulling = false;
    material.disableDepthWrite = true;
    material.setTexture('cloudMap', texture);
    const layer = (this.layer = MeshBuilder.CreateGround(
      'cloud-layer',
      { width: 1, height: 1 },
      scene,
    ));
    layer.material = material;
    layer.isPickable = false;
    layer.alwaysSelectAsActiveMesh = true;
    // After the whole city, including its translucent parts, and against its depth:
    // the layer is above every roof, but a taller landmark may still rise through it.
    layer.renderingGroupId = 1;
    scene.setRenderingAutoClearDepthStencil(1, false);
    layer.setEnabled(false);
  }

  /** Economy mode drops the feature entirely, including its texture lookups. */
  setEnabled(enabled: boolean): void {
    if (enabled === this.state.enabled) return;
    this.state.enabled = enabled;
    if (!enabled) this.layer.setEnabled(false);
    this.scene.markAllMaterialsAsDirty(Constants.MATERIAL_AllDirtyFlag);
  }

  update(frame: CloudFrame): void {
    const { state } = this;
    if (!state.enabled) return;
    state.drift = cloudDrift(frame.epochMs);
    state.shift = cloudShadowShift(frame.lightDirection);
    state.strength = frame.lightStrength;

    const opacity = cloudLayerOpacity(frame.zoom) * LAYER_OPACITY;
    this.layer.setEnabled(opacity > 0);
    if (opacity <= 0) return;
    // Centre the layer where the view axis crosses it and make it cover the frame at any
    // orbit angle. Its pattern is anchored to the world, not to this mesh.
    const camera = this.camera;
    const origin = camera.globalPosition;
    const forward = camera.target.subtractToRef(origin, this.forward).normalize();
    const distance = (CLOUD_FIELD.altitude - origin.y) / (forward.y || -1);
    this.centre.copyFrom(forward).scaleInPlace(distance).addInPlace(origin);
    const reach = Math.hypot(
      camera.orthoRight ?? 0,
      (camera.orthoTop ?? 0) / Math.max(0.1, Math.abs(forward.y)),
    );
    this.layer.position.copyFrom(this.centre);
    this.layer.scaling.set(2 * reach, 1, 2 * reach);
    const visible = frame.visible;
    this.layerMaterial
      .setVector4(
        'cloud',
        this.field.set(state.drift.u, state.drift.v, 1 / CLOUD_FIELD.tileMetres, opacity),
      )
      .setVector4(
        'visible',
        this.extent.set(
          visible.center.x,
          visible.center.z,
          Math.min(1_000_000, visible.radius),
          75,
        ),
      )
      .setColor3('tint', frame.tint);
  }

  dispose(): void {
    states.delete(this.scene);
    this.layer.dispose();
    this.layerMaterial.dispose();
    this.state.texture.dispose();
  }
}
