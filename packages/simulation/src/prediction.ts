import {
  normalizeInput,
  NEUTRAL_INPUT,
  type MoveInput,
  type ItemPose,
  type Vec3,
  type PlayerState,
  type LocalSimulationSnapshot,
  type SimulationSnapshot,
  type WorldHeader,
  type StaticEntityDefinition,
  type BuildingInstance,
  type BuildingPhysicsAsset,
  type WorldDefinition,
} from '@su/contracts';
import { createPhysicsWorld, type PhysicsWorld, type WasmBinary } from './physics-world.js';
export class PredictionWorld {
  private ownId: string | undefined;
  constructor(private readonly world: PhysicsWorld) {}
  reconcile(player: PlayerState, snapshot: LocalSimulationSnapshot | SimulationSnapshot): void {
    if (this.ownId && this.ownId !== player.entityId) this.world.removeCharacter(this.ownId);
    this.ownId = player.entityId;
    this.world.setRemoteSnapshot(snapshot, player.entityId);
    this.world.restoreCharacter(player);
  }
  /** Refresh visibility/proxies without restoring or advancing the own controller. */
  syncRemote(snapshot: LocalSimulationSnapshot | SimulationSnapshot, ownId: string): void {
    this.world.setRemoteSnapshot(snapshot, ownId);
  }
  step(input: MoveInput, dt = 1 / this.world.definition.simulation.tickRate): PlayerState {
    if (!this.ownId) throw new Error('Prediction needs an authoritative state before stepping');
    this.world.characters.get(this.ownId)!.input = normalizeInput(input) ?? { ...NEUTRAL_INPUT };
    this.world.advance(dt);
    return this.getState();
  }
  getState(): PlayerState {
    if (!this.ownId) throw new Error('Prediction needs an authoritative state');
    return this.world.state(this.ownId);
  }
  retainStatic(
    item: StaticEntityDefinition | BuildingInstance,
    version: string,
    asset?: BuildingPhysicsAsset,
  ) {
    this.world.retainStatic(item, version, asset);
  }
  releaseStatic(entityId: string) {
    this.world.releaseStatic(entityId);
  }
  staticDiagnostics() {
    return this.world.staticDiagnostics();
  }
  clear() {
    if (this.ownId) this.world.removeCharacter(this.ownId);
    this.world.setRemoteSnapshot({ scope: 'local', players: [], items: [] }, this.ownId ?? '');
    this.ownId = undefined;
  }
  surfaceRay(from: Vec3, to: Vec3) {
    return this.world.surfaceRay(from, to, this.ownId);
  }
  checkPlacement(typeId: string, pose: ItemPose) {
    return this.world.checkPlacement(typeId, pose, this.ownId);
  }
  dispose() {
    this.world.dispose();
  }
}
export async function createPredictionWorld(
  definition: WorldDefinition,
  wasmBinary?: WasmBinary,
): Promise<PredictionWorld> {
  return new PredictionWorld(await createPhysicsWorld(definition, wasmBinary, true));
}

/** A header is sufficient: only connected cells contribute static physics. */
export async function createLocalPredictionWorld(
  header: WorldHeader,
  wasmBinary?: WasmBinary,
): Promise<PredictionWorld> {
  return new PredictionWorld(await createPhysicsWorld(header, wasmBinary, true));
}
