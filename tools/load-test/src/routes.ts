import type { WorldHeader } from '@su/contracts';

export type Point = { x: number; z: number };
export function spreadRoute(header: WorldHeader, position: Point): Point[] {
  const routes = Object.entries(header.routes ?? {})
    .filter(([name]) => name.startsWith('spread-'))
    .map(([, points]) => points);
  if (!routes.length)
    throw new Error(
      'World has no spread-* routes; build the acceptance fixture or add map routes.',
    );
  return [...routes].sort(
    (a, b) =>
      Math.hypot(a[0].x - position.x, a[0].z - position.z) -
      Math.hypot(b[0].x - position.x, b[0].z - position.z),
  )[0];
}
export function crowdTarget(crate: Point, index: number, elapsed: number): Point {
  const angle = (index * Math.PI) / 4 + (Math.floor(elapsed / 8) * Math.PI) / 2;
  const radius = (Math.floor(elapsed / 6) + index) % 2 ? 5 : 0;
  return { x: crate.x + Math.cos(angle) * radius, z: crate.z + Math.sin(angle) * radius };
}
export function direction(position: Point, target: Point) {
  const dx = target.x - position.x,
    dz = target.z - position.z;
  const length = Math.max(1, Math.hypot(dx, dz));
  return { moveX: dx / length, moveZ: dz / length };
}

/** Independent of the server index/StateView implementation. */
export function expectedInterest(
  entities: { entityId: string; x: number; z: number }[],
  ownId: string,
  previous: Set<string>,
): Set<string> {
  const own = entities.find((entity) => entity.entityId === ownId);
  if (!own) return new Set();
  return new Set(
    entities
      .filter(
        (entity) =>
          entity.entityId === ownId ||
          Math.hypot(entity.x - own.x, entity.z - own.z) <=
            (previous.has(entity.entityId) ? 800 : 500),
      )
      .map((entity) => entity.entityId),
  );
}
