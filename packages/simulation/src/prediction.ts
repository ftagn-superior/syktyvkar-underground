import {
  type MoveInput,
  type PlayerState,
  type SimulationSnapshot,
  type WorldDefinition,
} from '@su/contracts';
import { createPhysicsWorld, type PhysicsWorld, type WasmBinary } from './physics-world.js';
export class PredictionWorld {
  private ownId: string | undefined;
  constructor(private readonly world: PhysicsWorld) {}
  reconcile(player: PlayerState, snapshot: SimulationSnapshot): void {
    if (this.ownId && this.ownId !== player.entityId) this.world.removeCharacter(this.ownId);
    this.ownId = player.entityId;
    this.world.setRemoteSnapshot(snapshot, player.entityId);
    this.world.restoreCharacter(player);
  }
  step(input: MoveInput, dt = 1 / this.world.definition.simulation.tickRate): PlayerState {
    if (!this.ownId) throw new Error('Prediction needs an authoritative state before stepping');
    this.world.characters.get(this.ownId)!.input = { moveX: input.moveX, moveZ: input.moveZ };
    this.world.advance(dt);
    return this.getState();
  }
  getState(): PlayerState {
    if (!this.ownId) throw new Error('Prediction needs an authoritative state');
    return this.world.state(this.ownId);
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
