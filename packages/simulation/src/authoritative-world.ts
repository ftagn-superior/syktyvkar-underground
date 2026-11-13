import {
  NEUTRAL_INPUT,
  normalizeInput,
  type ItemState,
  type BuildingInstance,
  type BuildingPhysicsAsset,
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
  checkPlayerSpawnPosition(center: Vec3, excludeId?: string) {
    return this.world.checkPlayerSpawnPosition(center, excludeId);
  }
  findDefaultPlayerSpawn(excludeId?: string): Vec3 | undefined {
    return this.world.findDefaultPlayerSpawn(excludeId);
  }
  /** Preparation target only: creation still requires a successful safety check. */
  getDefaultPlayerSpawnPosition(): Vec3 {
    return this.world.spawnPosition(this.world.definition.spawnPoints[0]);
  }
  /** Saved positions already describe the body center and must not be raised again. */
  addPlayerAtPosition(entityId: string, center: Vec3) {
    if (this.world.characters.has(entityId)) return this.world.state(entityId);
    if (!this.world.checkPlayerSpawnPosition(center).ok) return undefined;
    this.world.createCharacter(entityId, center);
    return this.world.state(entityId);
  }
  removePlayer(id: string) {
    this.world.removeCharacter(id);
  }
  setInput(id: string, input: MoveInput) {
    const character = this.world.characters.get(id);
    if (character) character.input = normalizeInput(input) ?? { ...NEUTRAL_INPUT };
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
  getPlayerState(entityId: string) {
    return this.world.characters.has(entityId) ? this.world.state(entityId) : undefined;
  }
  /** Returns a source point; occupation is checked again when the plan is committed. */
  findSpawn(excludeId?: string, candidates = this.world.definition.spawnPoints): Vec3 | undefined {
    return candidates.find((point) => this.world.findSpawn(excludeId, point) !== undefined);
  }
  replaceItems(items: ItemState[]) {
    this.world.replaceItems(items);
  }
  reconcileItems(items: ItemState[]) {
    this.world.reconcileItems(items);
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
  checkStaticPlacement(instance: BuildingInstance, asset: BuildingPhysicsAsset) {
    return this.world.checkStaticPlacement(instance, asset);
  }
  addStatic(instance: BuildingInstance, definition: WorldDefinition) {
    this.world.addStatic(instance, definition.buildingAssets[instance.assetId]);
    Object.assign(this.world.definition, definition);
  }
  removeStatic(entityId: string, definition: WorldDefinition) {
    this.world.removeStatic(entityId);
    Object.assign(this.world.definition, definition);
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
  respawnPlayerAtPosition(id: string, center: Vec3): boolean {
    const character = this.world.characters.get(id);
    if (!character || !this.world.checkPlayerSpawnPosition(center, id).ok) return false;
    this.world.restoreCharacter({
      ...this.world.state(id),
      position: { ...center },
      revision: character.revision + 1,
      velocity: { x: 0, y: 0, z: 0 },
      grounded: false,
    });
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
  return new AuthoritativeWorld(await createPhysicsWorld({ ...definition }, wasmBinary, false));
}
