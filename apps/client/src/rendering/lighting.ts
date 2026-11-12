import type { Scene } from '@babylonjs/core/scene';
import type { Camera } from '@babylonjs/core/Cameras/camera';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import '@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent';
import { DefaultRenderingPipeline } from '@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline';
import { ImageProcessingConfiguration } from '@babylonjs/core/Materials/imageProcessingConfiguration';
import { ColorCurves } from '@babylonjs/core/Materials/colorCurves';
import { renderQualitySettings, type RenderQuality } from './render-quality';

/** Сторона квадрата теней в метрах и удаление солнца от цели камеры. */
const SHADOW_EXTENT = 90;
const SUN_DISTANCE = 150;

/** Owns the world's lights, shadow map and shared tone curve in both quality modes. */
export class WorldLighting {
  readonly shadow: ShadowGenerator;
  private readonly sky: HemisphericLight;
  private readonly sun: DirectionalLight;
  private pipeline?: DefaultRenderingPipeline;

  constructor(
    private readonly scene: Scene,
    private readonly camera: Camera,
  ) {
    // Economy applies this in the material shader; standard uses the HDR pipeline.
    // Changing quality must not change the art direction.
    const imageProcessing = scene.imageProcessingConfiguration;
    imageProcessing.toneMappingEnabled = true;
    imageProcessing.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
    imageProcessing.exposure = 1.5;
    imageProcessing.contrast = 1.05;
    imageProcessing.colorCurvesEnabled = true;
    imageProcessing.colorCurves = new ColorCurves();
    imageProcessing.colorCurves.globalSaturation = 8;
    imageProcessing.vignetteEnabled = false;
    scene.clearColor = Color4.FromHexString('#101820ff');
    scene.ambientColor = Color3.FromHexString('#8199ac');

    // Clear afternoon light: warm sun, neutral sky fill and a restrained ground bounce.
    const sky = (this.sky = new HemisphericLight('sky', new Vector3(0, 1, 0), scene));
    // PBR's hemispheric diffuse is stronger than its directional BRDF at the same
    // intensity; keep this fill low enough for the facade orientations to read.
    sky.intensity = 0.45;
    sky.diffuse = Color3.FromHexString('#d6e7f4');
    sky.groundColor = Color3.FromHexString('#888563');
    sky.specular = Color3.Black();
    // About 42 degrees above the horizon; direction stays fixed as the camera turns.
    const sun = (this.sun = new DirectionalLight('sun', new Vector3(-0.9, -1, -0.65), scene));
    sun.position.set(20, 35, 15);
    sun.intensity = 3;
    sun.diffuse = Color3.FromHexString('#ffe6bd');
    // Карта теней покрывает квадрат вокруг камеры, а не весь город: иначе тени размываются.
    sun.shadowFrustumSize = SHADOW_EXTENT;
    sun.shadowMinZ = 0;
    sun.shadowMaxZ = SUN_DISTANCE * 2;
    const shadow = (this.shadow = new ShadowGenerator(2048, sun));
    // PCF даёт чёткий край у основания и мягкий на расстоянии, в отличие от размытой ESM.
    shadow.usePercentageCloserFiltering = true;
    shadow.filteringQuality = ShadowGenerator.QUALITY_HIGH;
    shadow.bias = 0.0012;
    shadow.normalBias = 0.08;
    shadow.setDarkness(0.22);
  }

  /** Standard adds HDR and MSAA; economy retains the same tone curve in its materials. */
  setQuality(quality: RenderQuality): void {
    const settings = renderQualitySettings(quality);
    this.scene.shadowsEnabled = settings.shadows;
    if (!settings.postProcessing) {
      this.pipeline?.dispose();
      this.pipeline = undefined;
      return;
    }
    if (this.pipeline) return;
    const pipeline = new DefaultRenderingPipeline('lighting', true, this.scene, [this.camera]);
    pipeline.samples = 4;
    pipeline.fxaaEnabled = false;
    pipeline.bloomEnabled = false;
    this.pipeline = pipeline;
  }

  /** Follow the camera target without rotating the sun or expanding the shadow map. */
  follow(target: Vector3): void {
    this.sun.position
      .copyFrom(this.sun.direction)
      .normalize()
      .scaleInPlace(-SUN_DISTANCE)
      .addInPlace(target);
  }

  dispose(): void {
    this.pipeline?.dispose();
    this.pipeline = undefined;
    this.shadow.dispose();
    this.sun.dispose();
    this.sky.dispose();
  }
}
