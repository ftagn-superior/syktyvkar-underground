import type { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import type { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';

/** Conservative caster footprint, scaled with the world's orthographic shadow projection. */
export function shadowCasterRadius(shadow: ShadowGenerator): number {
  const extent = (shadow.getLight() as DirectionalLight).shadowFrustumSize;
  return extent > 0 ? (80 * extent) / 90 : 80;
}
