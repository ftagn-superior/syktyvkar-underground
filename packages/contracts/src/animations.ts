import { ANIMATIONS } from './animation-catalog.generated.js';
export { ANIMATIONS, ANIMATION_CATALOG_VERSION } from './animation-catalog.generated.js';

/** Engine-independent catalog. IDs also key the client's procedural clip registry. */
export interface AnimationDefinition {
  id: string;
  label: string;
  category: string;
  cooldownMs: number;
  mode: 'upperBody' | 'fullBody';
  rig: 'humanoid-v1';
  /** Keep hips and lift fixed on seated skins; the rig attenuates lean and roll. */
  seated: 'preserve-seat';
}

export type AnimationId = (typeof ANIMATIONS)[number]['id'];
const animationById = new Map<string, (typeof ANIMATIONS)[number]>(
  ANIMATIONS.map((entry) => [entry.id, entry]),
);
export function findAnimation(value: unknown) {
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
