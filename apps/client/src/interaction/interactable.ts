export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Extensible: a new interaction (door, ladder, sit) is a new kind entry plus a source. */
export type InteractionKind = 'pickup' | 'vault' | (string & {});

export interface Interactable {
  id: string;
  kind: InteractionKind;
  /** KeyboardEvent.code, e.g. 'KeyZ', 'Space'. */
  key: string;
  /** Text on the key cap, e.g. 'Z', 'Пробел'. */
  keyLabel: string;
  action: string;
  objectName: string;
  /** World units. */
  range: number;
  /** When two prompts overlap, the higher priority wins; ties go to the nearest. */
  priority: number;
  /** Where the prompt points (top of the object). */
  getAnchor(): Vec3;
  /** Point distance, or segment distance for linear objects such as fences. */
  getDistance(player: Vec3): number;
  onActivate(player: Vec3): void;
  setHighlighted(on: boolean): void;
}

/** Defaults shared by every interactable of a kind. */
export const INTERACTION_KINDS = {
  pickup: { key: 'KeyZ', keyLabel: 'Z', action: 'Подобрать', priority: 2, range: 3 },
  vault: { key: 'Space', keyLabel: 'Пробел', action: 'Перепрыгнуть', priority: 1, range: 3 },
} as const satisfies Record<
  string,
  Pick<Interactable, 'key' | 'keyLabel' | 'action' | 'priority' | 'range'>
>;

/** Nearest interactable in range; pickups beat vaults, then distance decides. Allocation-free. */
export function selectInteractable(
  candidates: Iterable<Interactable>,
  player: Vec3,
): Interactable | undefined {
  let best: Interactable | undefined;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const distance = candidate.getDistance(player);
    if (!(distance <= candidate.range)) continue;
    if (
      !best ||
      candidate.priority > best.priority ||
      (candidate.priority === best.priority && distance < bestDistance)
    ) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Closest point on segment ab to p in the XZ plane, clamped to 4–96% of its length so a prompt
 * never sits on a post at the very end. Used by linear interactables such as fences.
 */
export function closestPointOnSegment(a: Vec3, b: Vec3, p: Vec3): { point: Vec3; t: number } {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const lengthSquared = dx * dx + dz * dz;
  const raw = lengthSquared === 0 ? 0 : ((p.x - a.x) * dx + (p.z - a.z) * dz) / lengthSquared;
  const t = Math.min(0.96, Math.max(0.04, raw));
  return { point: { x: a.x + dx * t, y: a.y + (b.y - a.y) * t, z: a.z + dz * t }, t };
}
export function distanceToSegment(a: Vec3, b: Vec3, p: Vec3): number {
  const { point } = closestPointOnSegment(a, b, p);
  return Math.hypot(point.x - p.x, point.z - p.z);
}
