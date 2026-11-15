import { ANIMATIONS } from './animation-catalog.generated.js';
import { findAvatarSkin } from './avatars.js';
export { ANIMATIONS, ANIMATION_CATALOG_VERSION } from './animation-catalog.generated.js';

/** Engine-independent catalog. IDs also key the client's procedural clip registry. */
export type AnimationRig = 'humanoid-v1' | 'humanoid-v2';
interface AnimationMetadata {
  id: string;
  label: string;
  category: string;
  cooldownMs: number;
  mode: 'upperBody' | 'fullBody';
}
/** v1 poses retain their original channels, masks, pivots and seated attenuation. */
export type AnimationDefinition = AnimationMetadata &
  (
    | { rig: 'humanoid-v1'; seated: 'preserve-seat' }
    | {
        rig: 'humanoid-v2';
        support: 'capsule' | 'ground';
        seated: 'preserve-seat' | 'variant' | 'unavailable';
        /** Required for an adaptation or unavailability; shown in the menu and preview. */
        seatedMessage?: string;
        reducedMotion: 'scaled' | 'static';
        /** Names a static alternative, e.g. preparation rather than a rotating cartwheel. */
        reducedMotionLabel?: string;
      }
  );

/** Ground body vertices must fit a horizontal disk of radius halfWidth * character height.
 * The server reserves its enclosing world-axis box, independent of facing and smoothing.
 * Height/floorGap are vertical fractions/metres respectively; the capsule stays upright.
 */
export const GROUND_ANIMATION_SPACE = { halfWidth: 0.8, height: 1.3, floorGap: 0.025 } as const;
export function isGroundAnimation(animation: AnimationDefinition | undefined): boolean {
  return animation?.rig === 'humanoid-v2' && animation.support === 'ground';
}
export function animationSkinSupport(
  animation: AnimationDefinition,
  skinId: unknown,
): 'supported' | 'variant' | 'unavailable' {
  if (!findAvatarSkin(skinId)) return 'unavailable';
  if (skinId !== 'bear-wheelchair' || animation.rig === 'humanoid-v1') return 'supported';
  return animation.seated === 'preserve-seat' ? 'supported' : animation.seated;
}

export type AnimationId = (typeof ANIMATIONS)[number]['id'];
const animationById = new Map<string, (typeof ANIMATIONS)[number]>(
  ANIMATIONS.map((entry) => [entry.id, entry]),
);
export function findAnimation(
  value: unknown,
): (AnimationDefinition & { id: AnimationId }) | undefined {
  return typeof value === 'string' ? animationById.get(value) : undefined;
}
export interface AnimationRequest {
  requestId: number;
  worldEpoch: string;
  animationId: AnimationId;
}
export interface AnimationPlayback {
  animationId: AnimationId | null;
  sequence: number;
  startedAtTick: number;
  /** Zero until the author's first movement; the pose keeps cycling meanwhile. */
  endsAtTick: number;
  changedAtTick: number;
}
