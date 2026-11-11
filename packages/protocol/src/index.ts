import { schema, t } from '@colyseus/schema';
import type { EntityState, PlayerState, SimulationSnapshot } from '@su/contracts';

/** Flat input is encoded and acknowledged by Colyseus, independently of actions. */
export class MoveInputSchema extends schema(
  {
    moveX: t.float32().default(0),
    moveZ: t.float32().default(0),
  },
  'MoveInput',
) {}

export class EntitySchema extends schema(
  {
    entityId: t.string().default(''),
    kind: t.string().default('crate'),
    revision: t.uint32().default(0),
    x: t.float32().default(0),
    y: t.float32().default(0),
    z: t.float32().default(0),
    qx: t.float32().default(0),
    qy: t.float32().default(0),
    qz: t.float32().default(0),
    qw: t.float32().default(1),
    vx: t.float32().default(0),
    vy: t.float32().default(0),
    vz: t.float32().default(0),
    avx: t.float32().default(0),
    avy: t.float32().default(0),
    avz: t.float32().default(0),
    grounded: t.boolean().default(false),
  },
  'Entity',
) {}
export class PlayerSchema extends EntitySchema.extend(
  {
    sessionId: t.string().default(''),
    name: t.string().default(''),
    color: t.string().default(''),
    connected: t.boolean().default(true),
  },
  'Player',
) {}
export class WorldState extends schema(
  {
    worldEpoch: t.string().default(''),
    serverTick: t.uint32().default(0),
    protocolVersion: t.uint16().default(1),
    mapVersion: t.string().default(''),
    simulationConfigHash: t.string().default(''),
    occupancy: t.uint8().default(0),
    stepMs: t.float32().default(0),
    players: t.map(PlayerSchema),
    crate: t.ref(EntitySchema),
  },
  'World',
) {}

export function applyEntityState(target: EntitySchema, source: EntityState): void {
  target.entityId = source.entityId;
  target.kind = source.kind;
  target.revision = source.revision;
  target.x = source.position.x;
  target.y = source.position.y;
  target.z = source.position.z;
  target.qx = source.rotation.x;
  target.qy = source.rotation.y;
  target.qz = source.rotation.z;
  target.qw = source.rotation.w;
  target.vx = source.velocity.x;
  target.vy = source.velocity.y;
  target.vz = source.velocity.z;
  target.avx = source.angularVelocity.x;
  target.avy = source.angularVelocity.y;
  target.avz = source.angularVelocity.z;
  if (source.kind === 'player') target.grounded = (source as PlayerState).grounded;
}
export function toEntityState(source: EntitySchema): EntityState {
  return {
    entityId: source.entityId,
    kind: source.kind === 'player' ? 'player' : 'crate',
    revision: source.revision,
    position: { x: source.x, y: source.y, z: source.z },
    rotation: { x: source.qx, y: source.qy, z: source.qz, w: source.qw },
    velocity: { x: source.vx, y: source.vy, z: source.vz },
    angularVelocity: { x: source.avx, y: source.avy, z: source.avz },
  };
}
export function toPlayerState(source: PlayerSchema): PlayerState {
  return { ...toEntityState(source), kind: 'player', grounded: source.grounded };
}
export function toSimulationSnapshot(source: WorldState): SimulationSnapshot {
  return {
    players: Array.from(source.players.values(), toPlayerState),
    crate: toEntityState(source.crate),
  };
}
