import HavokPhysics from '@babylonjs/havok';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { Scene } from '@babylonjs/core/scene.js';
import { Vector3, Quaternion } from '@babylonjs/core/Maths/math.vector.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { HavokPlugin } from '@babylonjs/core/Physics/v2/Plugins/havokPlugin.js';
import { PhysicsBody } from '@babylonjs/core/Physics/v2/physicsBody.js';
import {
  PhysicsShapeBox,
  PhysicsShapeCapsule,
  type PhysicsShape,
} from '@babylonjs/core/Physics/v2/physicsShape.js';
import {
  PhysicsMotionType,
  PhysicsPrestepType,
} from '@babylonjs/core/Physics/v2/IPhysicsEnginePlugin.js';
import {
  PhysicsCharacterController,
  CharacterSupportedState,
} from '@babylonjs/core/Physics/v2/characterController.js';
import { PhysicsEngine } from '@babylonjs/core/Physics/v2/physicsEngine.js';
import { ProximityCastResult } from '@babylonjs/core/Physics/proximityCastResult.js';
import '@babylonjs/core/Physics/v2/physicsEngineComponent.js';
import '@babylonjs/core/Physics/joinedPhysicsEngineComponent.js';
import { BuildingColliders } from './building-colliders.js';
import {
  canonicalJson,
  NEUTRAL_INPUT,
  normalizeInput,
  type EntityDefinition,
  type EntityState,
  type MoveInput,
  type PlayerState,
  type Quat,
  type SimulationSnapshot,
  type LocalSimulationSnapshot,
  type WorldHeader,
  type StaticEntityDefinition,
  type BuildingInstance,
  type BuildingPhysicsAsset,
  type Vec3,
  type WorldDefinition,
} from '@su/contracts';

export type WasmBinary = ArrayBuffer | Uint8Array;
// A module is shared; each world owns and releases its own Havok world and bodies.
let havokModule: ReturnType<typeof HavokPhysics> | undefined;
function loadHavok(wasmBinary?: WasmBinary) {
  return (havokModule ??= HavokPhysics(
    wasmBinary
      ? {
          wasmBinary:
            wasmBinary instanceof Uint8Array ? Uint8Array.from(wasmBinary).buffer : wasmBinary,
        }
      : {},
  ));
}
const vector = (v: Vec3) => new Vector3(v.x, v.y, v.z);
const plain = (v: Vec3): Vec3 => ({ x: v.x, y: v.y, z: v.z });
const rotation = (q: Quat): Quat => ({ x: q.x, y: q.y, z: q.z, w: q.w });
const zero = (): Vec3 => ({ x: 0, y: 0, z: 0 });
const identity = (): Quat => ({ x: 0, y: 0, z: 0, w: 1 });
const down = new Vector3(0, -1, 0);

interface BodyRecord {
  node: TransformNode;
  body: PhysicsBody;
  shape: PhysicsShape;
  definition: EntityDefinition;
  revision: number;
}
interface CharacterRecord {
  controller: PhysicsCharacterController;
  body: PhysicsBody;
  input: MoveInput;
  revision: number;
  yaw: number;
  grounded: boolean;
}

/** Renderer-free physics adapter. Only advance() can advance the common world. */
export class PhysicsWorld {
  readonly engine: NullEngine;
  readonly scene: Scene;
  readonly plugin: HavokPlugin;
  readonly physics: PhysicsEngine;
  readonly characters = new Map<string, CharacterRecord>();
  readonly objects = new Map<string, BodyRecord>();
  readonly remotePlayers = new Map<
    string,
    { node: TransformNode; body: PhysicsBody; shape: PhysicsShape }
  >();
  readonly spawnShape: PhysicsShapeCapsule;
  readonly gravity: Vector3;
  private readonly buildings: BuildingColliders;
  private crate?: BodyRecord;
  private readonly staticReferences = new Map<
    string,
    { version: string; signature: string; references: number; building: boolean }
  >();
  private readonly crateDefinition: EntityDefinition;
  disposed = false;
  constructor(
    readonly definition: WorldDefinition | WorldHeader,
    havok: Awaited<ReturnType<typeof HavokPhysics>>,
    readonly prediction: boolean,
  ) {
    this.engine = new NullEngine({
      renderWidth: 1,
      renderHeight: 1,
      textureSize: 1,
      deterministicLockstep: false,
      lockstepMaxSteps: 1,
    });
    this.scene = new Scene(this.engine);
    this.scene.useRightHandedSystem = true;
    this.gravity = vector(definition.simulation.gravity);
    this.plugin = new HavokPlugin(true, havok);
    this.scene.enablePhysics(this.gravity, this.plugin);
    this.physics = this.scene.getPhysicsEngine() as PhysicsEngine;
    const { height, radius } = definition.simulation.character;
    this.spawnShape = new PhysicsShapeCapsule(
      new Vector3(0, height / 2 - radius, 0),
      new Vector3(0, -height / 2 + radius, 0),
      radius,
      this.scene,
    );
    this.buildings = new BuildingColliders(this.scene);
    try {
      if ('entities' in definition) {
        const crate = definition.entities.find((item) => item.kind === 'crate');
        if (!crate) throw new Error('World requires a crate');
        this.crateDefinition = crate;
        this.crate = this.createBox(crate);
        this.objects.set(crate.entityId, this.crate);
        for (const item of definition.entities) {
          if (item.kind === 'obstacle')
            this.retainStatic(item as StaticEntityDefinition, 'initial');
        }
        for (const instance of definition.buildings) {
          const asset = definition.buildingAssets[instance.assetId];
          if (!asset) throw new Error(`Unknown building asset: ${instance.assetId}`);
          this.retainStatic(instance, 'initial', asset);
        }
      } else {
        if (!prediction) throw new Error('Authoritative physics requires the complete world');
        this.crateDefinition = definition.crate;
      }
    } catch (error) {
      this.dispose();
      throw error;
    }
  }
  /** Call between fixed steps. A reference is held by each connected cell. */
  retainStatic(
    item: StaticEntityDefinition | BuildingInstance,
    version: string,
    asset?: BuildingPhysicsAsset,
  ): void {
    if (this.disposed) throw new Error('Physics world is disposed');
    const signature = canonicalJson(item);
    const existing = this.staticReferences.get(item.entityId);
    if (existing) {
      if (existing.version !== version || existing.signature !== signature)
        throw new Error(`Conflicting static entity/version: ${item.entityId}`);
      existing.references++;
      return;
    }
    if (
      item.entityId === this.crateDefinition.entityId ||
      this.objects.has(item.entityId) ||
      this.characters.has(item.entityId) ||
      this.remotePlayers.has(item.entityId)
    )
      throw new Error(`Occupied entity ID: ${item.entityId}`);
    if ('assetId' in item) {
      if (!asset) throw new Error(`Missing collider: ${item.assetId}`);
      this.buildings.add(item, asset);
    } else this.objects.set(item.entityId, this.createBox(item));
    this.staticReferences.set(item.entityId, {
      version,
      signature,
      references: 1,
      building: 'assetId' in item,
    });
  }
  releaseStatic(entityId: string): void {
    const entry = this.staticReferences.get(entityId);
    if (!entry || --entry.references > 0) return;
    this.staticReferences.delete(entityId);
    if (entry.building) this.buildings.remove(entityId);
    else {
      const record = this.objects.get(entityId)!;
      record.body.dispose();
      record.shape.dispose();
      record.node.dispose();
      this.objects.delete(entityId);
    }
  }
  staticDiagnostics() {
    return {
      entities: this.staticReferences.size,
      references: [...this.staticReferences.values()].reduce(
        (sum, entry) => sum + entry.references,
        0,
      ),
      buildings: this.buildings.diagnostics(),
      bodies: this.physics.getBodies().length,
      crate: !!this.crate,
      remotePlayers: this.remotePlayers.size,
    };
  }
  createBox(definition: EntityDefinition): BodyRecord {
    const node = new TransformNode(definition.entityId, this.scene);
    node.position.copyFrom(vector(definition.position));
    node.rotationQuaternion = Quaternion.Identity();
    const dynamic = definition.kind === 'crate';
    const body = new PhysicsBody(
      node,
      dynamic
        ? this.prediction
          ? PhysicsMotionType.ANIMATED
          : PhysicsMotionType.DYNAMIC
        : PhysicsMotionType.STATIC,
      false,
      this.scene,
    );
    const shape = new PhysicsShapeBox(
      Vector3.Zero(),
      Quaternion.Identity(),
      vector(definition.size),
      this.scene,
    );
    shape.material = { friction: definition.friction, restitution: definition.restitution };
    body.shape = shape;
    if (dynamic && !this.prediction) {
      body.setMassProperties({ mass: definition.mass });
      body.setLinearDamping(0.15);
      body.setAngularDamping(0.3);
    }
    return { node, body, shape, definition, revision: 0 };
  }
  createCharacter(id: string, position: Vec3, state?: PlayerState): CharacterRecord {
    const config = this.definition.simulation.character;
    const controller = new PhysicsCharacterController(
      vector(position),
      { capsuleHeight: config.height, capsuleRadius: config.radius },
      this.scene,
    );
    controller.characterMass = config.mass;
    controller.characterStrength = 500;
    controller.maxCharacterSpeedForSolver = config.speed;
    controller.keepDistance = 0.015;
    controller.keepContactTolerance = 0.05;
    controller.maxStepHeight = 0;
    controller.setVelocity(vector(state?.velocity ?? zero()));
    // The public registry identifies the controller's engine-owned proxy without accessing private fields.
    const body = this.physics
      .getBodies()
      .find((candidate) => candidate.shape === controller.shape)!;
    body.transformNode.name = id;
    const q = state?.rotation;
    const yaw = q ? Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.z * q.z)) : 0;
    const record = {
      controller,
      body,
      input: { ...NEUTRAL_INPUT },
      revision: state?.revision ?? 0,
      yaw,
      grounded: state?.grounded ?? false,
    };
    this.characters.set(id, record);
    return record;
  }
  removeCharacter(id: string) {
    this.characters.get(id)?.controller.dispose();
    this.characters.delete(id);
  }
  state(id: string): PlayerState {
    const player = this.characters.get(id);
    if (!player) throw new Error(`Unknown character: ${id}`);
    return {
      entityId: id,
      kind: 'player',
      revision: player.revision,
      position: plain(player.controller.getPosition()),
      rotation: rotation(Quaternion.RotationAxis(Vector3.UpReadOnly, player.yaw)),
      velocity: plain(player.controller.getVelocity()),
      angularVelocity: zero(),
      grounded: player.grounded,
    };
  }
  boxState(box: BodyRecord): EntityState {
    return {
      entityId: box.definition.entityId,
      kind: 'crate',
      revision: box.revision,
      position: plain(box.node.position),
      rotation: rotation(box.node.rotationQuaternion ?? Quaternion.Identity()),
      velocity: plain(box.body.getLinearVelocity()),
      angularVelocity: plain(box.body.getAngularVelocity()),
    };
  }
  snapshot(): SimulationSnapshot {
    if (!this.crate) throw new Error('Authoritative snapshot requires a crate');
    return {
      players: [...this.characters.keys()].map((id) => this.state(id)),
      crate: this.boxState(this.crate),
    };
  }
  /** Restoring through public controller construction drops stale contact manifolds. */
  restoreCharacter(state: PlayerState) {
    this.removeCharacter(state.entityId);
    this.createCharacter(state.entityId, state.position, state);
  }
  teleport(body: PhysicsBody, node: TransformNode, position: Vec3, q: Quat = identity()) {
    node.position.copyFrom(vector(position));
    node.rotationQuaternion = new Quaternion(q.x, q.y, q.z, q.w);
    node.computeWorldMatrix(true);
    const prestep = body.getPrestepType();
    body.setPrestepType(PhysicsPrestepType.TELEPORT);
    this.plugin.setPhysicsBodyTransformation(body, node);
    body.setPrestepType(prestep);
    body.setLinearVelocity(Vector3.Zero());
    body.setAngularVelocity(Vector3.Zero());
  }
  setRemoteSnapshot(snapshot: LocalSimulationSnapshot, ownId: string) {
    if (!this.prediction) throw new Error('Remote proxies belong to prediction');
    if (snapshot.crate && snapshot.crate.entityId !== this.crateDefinition.entityId)
      throw new Error('Unexpected crate ID');
    if (!snapshot.crate && this.crate) {
      this.crate.body.dispose();
      this.crate.shape.dispose();
      this.crate.node.dispose();
      this.objects.delete(this.crateDefinition.entityId);
      this.crate = undefined;
    }
    if (snapshot.crate && !this.crate) {
      this.crate = this.createBox(this.crateDefinition);
      this.objects.set(this.crateDefinition.entityId, this.crate);
    }
    const crate = this.crate;
    if (crate && snapshot.crate) {
      this.teleport(crate.body, crate.node, snapshot.crate.position, snapshot.crate.rotation);
      crate.revision = snapshot.crate.revision;
    }
    const active = new Set(
      snapshot.players.filter((p) => p.entityId !== ownId).map((p) => p.entityId),
    );
    for (const [id, remote] of this.remotePlayers)
      if (!active.has(id)) {
        remote.body.dispose();
        remote.shape.dispose();
        remote.node.dispose();
        this.remotePlayers.delete(id);
      }
    const { height, radius } = this.definition.simulation.character;
    for (const player of snapshot.players) {
      if (player.entityId === ownId) continue;
      let remote = this.remotePlayers.get(player.entityId);
      if (!remote) {
        const node = new TransformNode(player.entityId, this.scene);
        node.position.copyFrom(vector(player.position));
        const body = new PhysicsBody(node, PhysicsMotionType.ANIMATED, false, this.scene);
        const shape = new PhysicsShapeCapsule(
          new Vector3(0, height / 2 - radius, 0),
          new Vector3(0, -height / 2 + radius, 0),
          radius,
          this.scene,
        );
        body.shape = shape;
        remote = { node, body, shape };
        this.remotePlayers.set(player.entityId, remote);
      }
      this.teleport(remote.body, remote.node, player.position, player.rotation);
    }
  }
  spawnPosition(point: Vec3): Vec3 {
    return {
      x: point.x,
      y: point.y + this.definition.simulation.character.height / 2 + 0.02,
      z: point.z,
    };
  }
  overlaps(shape: PhysicsShape, position: Vec3, ignoreBody?: PhysicsBody): boolean {
    if (this.buildings.contains(position)) return true;
    const inputResult = new ProximityCastResult();
    const hitResult = new ProximityCastResult();
    this.plugin.shapeProximity(
      {
        shape,
        position: vector(position),
        rotation: Quaternion.Identity(),
        maxDistance: 0.005,
        shouldHitTriggers: false,
        ignoreBody,
      },
      inputResult,
      hitResult,
    );
    return hitResult.hasHit;
  }
  findSpawn(excludeId?: string, requested?: Vec3): Vec3 | undefined {
    const points = requested ? [requested] : this.definition.spawnPoints;
    const selfBody = excludeId ? this.characters.get(excludeId)?.body : undefined;
    for (const point of points) {
      const position = this.spawnPosition(point);
      if (!this.overlaps(this.spawnShape, position, selfBody)) return position;
    }
  }
  advance(dt: number) {
    if (this.disposed) throw new Error('Physics world is disposed');
    if (!Number.isFinite(dt) || dt <= 0 || dt > 0.1) throw new Error('Invalid physics timestep');
    for (const record of this.characters.values()) {
      const input = normalizeInput(record.input) ?? NEUTRAL_INPUT;
      const support = record.controller.checkSupport(dt, down);
      record.grounded = support.supportedState === CharacterSupportedState.SUPPORTED;
      const vertical = record.grounded
        ? Math.min(0, support.averageSurfaceVelocity.y)
        : record.controller.getVelocity().y + this.gravity.y * dt;
      record.controller.setVelocity(
        new Vector3(
          input.moveX * this.definition.simulation.character.speed,
          vertical,
          input.moveZ * this.definition.simulation.character.speed,
        ),
      );
      if (Math.hypot(input.moveX, input.moveZ) > 0.001)
        record.yaw = Math.atan2(input.moveX, input.moveZ);
      record.controller.integrate(dt, support, this.gravity);
    }
    this.plugin.executeStep(dt, this.physics.getBodies());
    if (!this.prediction) this.returnLostCrate();
  }
  returnLostCrate() {
    const { min, max } = this.definition.bounds;
    const crate = this.crate;
    if (!crate) throw new Error('Authoritative world requires a crate');
    const p = crate.node.position;
    if (p.y >= -5 && p.x >= min.x && p.x <= max.x && p.z >= min.z && p.z <= max.z) return;
    if (this.overlaps(crate.shape, crate.definition.position, crate.body)) return;
    this.teleport(crate.body, crate.node, crate.definition.position);
    crate.revision++;
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const id of [...this.characters.keys()]) this.removeCharacter(id);
    this.buildings.dispose();
    for (const item of [...this.objects.values(), ...this.remotePlayers.values()]) {
      item.body.dispose();
      item.shape.dispose();
      item.node.dispose();
    }
    this.objects.clear();
    this.staticReferences.clear();
    this.crate = undefined;
    this.remotePlayers.clear();
    this.spawnShape.dispose();
    this.scene.dispose();
    this.engine.dispose();
  }
}
export async function createPhysicsWorld(
  definition: WorldDefinition | WorldHeader,
  wasmBinary: WasmBinary | undefined,
  prediction: boolean,
) {
  return new PhysicsWorld(definition, await loadHavok(wasmBinary), prediction);
}
