import {
  NEUTRAL_INPUT,
  type ItemState,
  type ItemPose,
  type MoveInput,
  type Vec3,
  type WorldDefinition,
} from '@su/contracts';
import { createPhysicsWorld, type PhysicsWorld, type WasmBinary } from './physics-world.js';
export class AuthoritativeWorld {
  constructor(private readonly world: PhysicsWorld) {}
  addPlayer(entityId: string, spawn?: Vec3) {
    if (this.world.characters.has(entityId)) return this.world.state(entityId);
    const position = this.world.findSpawn(undefined, spawn);
    if (!position) return undefined;
    this.world.createCharacter(entityId, position);
    return this.world.state(entityId);
  }
  removePlayer(id: string) {
    this.world.removeCharacter(id);
  }
  setInput(id: string, input: MoveInput) {
    const character = this.world.characters.get(id);
    if (character)
      character.input = { moveX: input.moveX, moveZ: input.moveZ, sprint: input.sprint ?? false };
  }
  step(dt = 1 / this.world.definition.simulation.tickRate) {
    this.world.advance(dt);
  }
  drainImpacts() {
    return this.world.drainImpacts();
  }
  suppressImpacts(entityId: string, seconds = 0.25) {
    this.world.suppressImpacts(entityId, seconds);
  }
  getSnapshot() {
    return this.world.snapshot();
  }
  /** Returns a source point; occupation is checked again when the plan is committed. */
  findSpawn(excludeId?: string, candidates = this.world.definition.spawnPoints): Vec3 | undefined {
    return candidates.find((point) => this.world.findSpawn(excludeId, point) !== undefined);
  }
  replaceItems(items: ItemState[]) {
    this.world.replaceItems(items);
  }
  reconcileItems(items: ItemState[]) {
    const current = new Map(this.world.snapshot().items.map((i) => [i.entityId, i]));
    const ids = new Set(items.map((i) => i.entityId));
    for (const id of current.keys()) if (!ids.has(id)) this.world.removeItem(id);
    for (const item of items)
      if (current.get(item.entityId)?.placementVersion !== item.placementVersion) {
        this.world.removeItem(item.entityId);
        this.world.addItem(item);
      }
  }
  checkPickup(playerId: string, itemId: string) {
    const item = this.world.objects.get(itemId);
    return item?.item
      ? this.world.canReach(playerId, item.node.position, itemId)
      : ('ITEM_UNAVAILABLE' as const);
  }
  checkPlacement(typeId: string, pose: ItemPose, playerId?: string, ignoreId?: string) {
    return this.world.checkPlacement(typeId, pose, playerId, ignoreId);
  }
  checkSavedItem(item: ItemState) {
    return this.world.checkSavedItem(item);
  }
  respawnPlayer(id: string, spawn?: Vec3): boolean {
    const character = this.world.characters.get(id);
    if (!character) return false;
    const position = this.world.findSpawn(id, spawn);
    if (!position) return false;
    const next = {
      ...this.world.state(id),
      position,
      revision: character.revision + 1,
      velocity: { x: 0, y: 0, z: 0 },
      grounded: false,
    };
    this.world.restoreCharacter(next);
    this.setInput(id, NEUTRAL_INPUT);
    return true;
  }
  diagnostics() {
    return {
      bodies: this.world.disposed ? 0 : this.world.physics.getBodies().length,
      players: this.world.characters.size,
    };
  }
  dispose() {
    this.world.dispose();
  }
}
export async function createAuthoritativeWorld(
  definition: WorldDefinition,
  wasmBinary?: WasmBinary,
): Promise<AuthoritativeWorld> {
  return new AuthoritativeWorld(await createPhysicsWorld(definition, wasmBinary, false));
}
