export type { AnimationClip } from './clips/types';
export { ANIMATION_CLIPS } from './animation-clips.generated';

export const ANIMATION_BLEND_MS = 150;
export const smoothWeight = (value: number) => {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
};
export function animationWeight(elapsedMs: number, durationMs: number): number {
  return (
    smoothWeight(elapsedMs / ANIMATION_BLEND_MS) *
    smoothWeight((durationMs - elapsedMs) / ANIMATION_BLEND_MS)
  );
}
