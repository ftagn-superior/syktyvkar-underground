import type { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';

const muted = new WeakSet<ShadowGenerator>();

export const shadowUpdatesMuted = (shadow: ShadowGenerator): boolean => muted.has(shadow);

/** Regrouping identical silhouettes must not invalidate the static depth cache. */
export function withoutShadowInvalidation<T>(shadow: ShadowGenerator, update: () => T): T {
  if (muted.has(shadow)) return update();
  muted.add(shadow);
  try {
    return update();
  } finally {
    muted.delete(shadow);
  }
}
