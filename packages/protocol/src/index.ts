import { schema, t } from '@colyseus/schema';
import {
  PROTOCOL_VERSION,
  normalizeInput,
  NEUTRAL_INPUT,
  type MoveInput,
  DEFAULT_AVATAR_SKIN,
  type EntityState,
  type ItemState,
  type PlayerState,
  type LocalSimulationSnapshot,
} from '@su/contracts';

/** Flat input is encoded and acknowledged by Colyseus, independently of actions. */
export class MoveInputSchema extends schema(
  {
    moveX: t.float32().default(0),
    moveZ: t.float32().default(0),
    sprint: t.boolean().default(false),
    hasFacing: t.boolean().default(false),
    facingYaw: t.float64().default(0),
  },
  'MoveInput',
) {}

export type WireMoveInput = Pick<
  MoveInputSchema,
  'moveX' | 'moveZ' | 'sprint' | 'hasFacing' | 'facingYaw'
>;

export function readMoveInput(input: WireMoveInput): MoveInput {
  return (
    normalizeInput({
      moveX: input.moveX,
      moveZ: input.moveZ,
      sprint: input.sprint,
      facingYaw: input.hasFacing ? input.facingYaw : undefined,
    }) ?? { ...NEUTRAL_INPUT }
  );
}

/** Every send, including neutral, replaces both orientation fields in the delta encoder. */
export function writeMoveInput(target: MoveInputSchema, command: MoveInput): void {
  const input = normalizeInput(command) ?? NEUTRAL_INPUT;
  target.moveX = input.moveX;
  target.moveZ = input.moveZ;
  target.sprint = input.sprint ?? false;
  target.hasFacing = input.facingYaw !== undefined;
  target.facingYaw = input.facingYaw ?? 0;
}

export class EntitySchema extends schema(
  {
    entityId: t.string().default(''),
    kind: t.string().default('item'),
    typeId: t.string().default(''),
    placementVersion: t.uint32().default(0),
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
    skinId: t.string().default(DEFAULT_AVATAR_SKIN),
    connected: t.boolean().default(true),
    reactionId: t.string().default(''),
    reactionSequence: t.uint32().default(0),
    // Zero with an active ID means the author has not moved yet.
    reactionExpiresAtTick: t.uint32().default(0),
    animationId: t.string().default(''),
    animationSequence: t.uint32().default(0),
    animationStartedAtTick: t.uint32().default(0),
    // Zero with an active ID means the animation keeps cycling until movement.
    animationEndsAtTick: t.uint32().default(0),
    animationChangedAtTick: t.uint32().default(0),
    chatText: t.string().default(''),
    chatSequence: t.uint32().default(0),
    // Zero with nonempty text means the author has not moved yet.
    chatExpiresAtTick: t.uint32().default(0),
  },
  'Player',
) {}
export class WorldState extends schema(
  {
    worldEpoch: t.string().default(''),
    serverTick: t.uint32().default(0),
    protocolVersion: t.uint16().default(PROTOCOL_VERSION),
    mapVersion: t.string().default(''),
    simulationConfigHash: t.string().default(''),
    occupancy: t.uint8().default(0),
    stepMs: t.float32().default(0),
    players: t.map(PlayerSchema).view(),
    items: t.map(EntitySchema).view(),
    paused: t.boolean().default(false),
    pauseReason: t.string().default(''),
  },
  'World',
) {}

export function applyEntityState(target: EntitySchema, source: EntityState): void {
  target.entityId = source.entityId;
  target.kind = source.kind;
  if (source.kind === 'item') {
    target.typeId = (source as ItemState).typeId;
    target.placementVersion = (source as ItemState).placementVersion;
  }
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
    kind: source.kind === 'player' ? 'player' : 'item',
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
export function toLocalSimulationSnapshot(source: WorldState): LocalSimulationSnapshot {
  return {
    scope: 'local',
    players: Array.from(source.players.values(), toPlayerState),
    items: Array.from(source.items.values(), toItemState),
  };
}

export function toItemState(source: EntitySchema): ItemState {
  const entity = toEntityState(source);
  return {
    ...entity,
    kind: 'item',
    typeId: source.typeId,
    placementVersion: source.placementVersion,
    safePose: { position: entity.position, rotation: entity.rotation },
  };
}

export type { PrepareArea, AreaReady, AreaResult } from '@su/contracts';
