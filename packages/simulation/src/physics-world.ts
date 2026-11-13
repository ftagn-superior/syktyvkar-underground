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
import { PhysicsRaycastResult } from '@babylonjs/core/Physics/physicsRaycastResult.js';
import { ShapeCastResult } from '@babylonjs/core/Physics/shapeCastResult.js';
import { ProximityCastResult } from '@babylonjs/core/Physics/proximityCastResult.js';
import '@babylonjs/core/Physics/v2/physicsEngineComponent.js';
import '@babylonjs/core/Physics/joinedPhysicsEngineComponent.js';
import { BuildingColliders } from './building-colliders.js';
import { createItemShape } from './item-shapes.js';
import { ImpactCollector } from './impacts.js';
import {
  canonicalJson,
  buildingBounds,
  NEUTRAL_INPUT,
  ITEM_REACH,
  initialItemState,
  itemShapeParts,
  itemSupportDistance,
  type ItemType,
  type ItemState,
  type ItemPose,
  type ItemError,
  type StaticPlacementError,
  normalizeInput,
  validPose,
  type EntityDefinition,
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
const MAX_PLAYER_SLOPE_COSINE = 0.5;
const PLAYER_SPAWN_PENETRATION = 0.005;

export type PlayerSpawnFailure =
  | 'INVALID_POSITION'
  | 'OUT_OF_BOUNDS'
  | 'BLOCKED'
  | 'NO_SUPPORT'
  | 'UNSTABLE_SUPPORT'
  | 'STEEP_SUPPORT';
export type PlayerSpawnCheck = { ok: true } | { ok: false; reason: PlayerSpawnFailure };

interface BodyRecord {
  node: TransformNode;
  body: PhysicsBody;
  shape: PhysicsShape;
  definition: Omit<EntityDefinition, 'kind'> & { kind: 'obstacle' | 'item' };
  revision: number;
  item?: ItemState;
  recovering?: boolean;
}
type ItemBodyRecord = BodyRecord & { item: ItemState };
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
  /** The same records indexed for dynamic work; static city geometry never enters these loops. */
  private readonly items = new Map<string, ItemBodyRecord>();
  readonly remotePlayers = new Map<
    string,
    { node: TransformNode; body: PhysicsBody; shape: PhysicsShape }
  >();
  readonly spawnShape: PhysicsShapeCapsule;
  readonly gravity: Vector3;
  private readonly buildings: BuildingColliders;
  private readonly staticReferences = new Map<
    string,
    { version: string; signature: string; references: number; building: boolean }
  >();
  disposed = false;
  private readonly impacts = new ImpactCollector();
  private readonly impactBodyIds = new WeakMap<PhysicsBody, number>();
  private nextImpactBodyId = 0;
  private readonly impactMotion = new Map<
    PhysicsBody,
    { velocity: Vector3; angular: Vector3; center: Vector3 }
  >();
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
    if (!prediction)
      this.plugin.onCollisionObservable.add((event) => {
        if (!event.point || !event.normal) return;
        const a = this.objects.get(event.collider.transformNode.name);
        const b = this.objects.get(event.collidedAgainst.transformNode.name);
        const item = a?.item ? a : b?.item ? b : undefined;
        if (!item?.item) return;
        const relative = this.impactVelocity(event.collider, event.point).subtract(
          this.impactVelocity(event.collidedAgainst, event.point),
        );
        this.impacts.record(
          this.impactPair(event.collider, event.collidedAgainst),
          {
            entityId: item.definition.entityId,
            typeId: item.item.typeId,
            position: plain(event.point),
          },
          event.impulse,
          Math.max(0, Vector3.Dot(relative, event.normal)),
        );
      });
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
        for (const item of definition.entities) this.retainStatic(item, 'initial');
        if (!prediction)
          for (const seed of definition.initialItems) this.addItem(initialItemState(seed));
        for (const instance of definition.buildings) {
          const asset = definition.buildingAssets[instance.assetId];
          if (!asset) throw new Error(`Unknown building asset: ${instance.assetId}`);
          this.retainStatic(instance, 'initial', asset);
        }
      } else {
        if (!prediction) throw new Error('Authoritative physics requires the complete world');
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
      this.objects.has(item.entityId) ||
      this.characters.has(item.entityId) ||
      this.remotePlayers.has(item.entityId)
    )
      throw new Error(`Occupied entity ID: ${item.entityId}`);
    if ('assetId' in item) {
      if (!asset) throw new Error(`Missing collider: ${item.assetId}`);
      if (asset.colliders.length) this.buildings.add(item, asset);
    } else this.objects.set(item.entityId, this.createBody(item));
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
      items: this.items.size,
      remotePlayers: this.remotePlayers.size,
    };
  }
  private createBody(
    definition: Omit<EntityDefinition, 'kind'> & { kind: 'obstacle' | 'item' },
    itemType?: ItemType,
  ): BodyRecord {
    const node = new TransformNode(definition.entityId, this.scene);
    node.position.copyFrom(vector(definition.position));
    node.rotationQuaternion = Quaternion.Identity();
    const dynamic = definition.kind === 'item';
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
    const shape = itemType
      ? createItemShape(itemType, this.scene)
      : new PhysicsShapeBox(
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
      body.setCollisionCallbackEnabled(true);
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
    controller.maxCharacterSpeedForSolver = config.sprintSpeed;
    controller.keepDistance = 0.015;
    controller.keepContactTolerance = 0.05;
    controller.maxStepHeight = 0;
    controller.maxSlopeCosine = MAX_PLAYER_SLOPE_COSINE;
    controller.setVelocity(vector(state?.velocity ?? zero()));
    // The public registry identifies the controller's engine-owned proxy without accessing private fields.
    const body = this.physics
      .getBodies()
      .find((candidate) => candidate.shape === controller.shape)!;
    body.transformNode.name = id;
    if (!this.prediction)
      controller.onTriggerCollisionObservable.add((event) => {
        const item = this.objects.get(event.collider.transformNode.name);
        if (!item?.item) return;
        const impulse = event.impulse.length();
        if (impulse <= 0) return;
        const direction = event.impulse.scale(1 / impulse);
        const relative = this.impactVelocity(body, event.impulsePosition).subtract(
          this.impactVelocity(event.collider, event.impulsePosition),
        );
        this.impacts.record(
          this.impactPair(body, event.collider),
          {
            entityId: item.definition.entityId,
            typeId: item.item.typeId,
            position: plain(event.impulsePosition),
            actorId: id,
          },
          impulse,
          Math.max(0, Vector3.Dot(relative, direction)),
          true,
        );
      });
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
    this.impacts.clear(true);
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
  private itemState(record: ItemBodyRecord): ItemState {
    return {
      ...record.item,
      entityId: record.definition.entityId,
      kind: 'item',
      revision: record.revision,
      position: plain(record.node.position),
      rotation: rotation(record.node.rotationQuaternion ?? Quaternion.Identity()),
      velocity: plain(record.body.getLinearVelocity()),
      angularVelocity: plain(record.body.getAngularVelocity()),
    };
  }
  snapshot(): SimulationSnapshot {
    if (this.prediction) throw new Error('Authoritative snapshot requires the full server world');
    return {
      scope: 'authoritative',
      players: [...this.characters.keys()].map((id) => this.state(id)),
      items: [...this.items.values()].map((record) => this.itemState(record)),
    };
  }
  /** Restoring through public controller construction drops stale contact manifolds. */
  restoreCharacter(state: PlayerState) {
    this.removeCharacter(state.entityId);
    this.createCharacter(state.entityId, state.position, state);
  }
  teleport(body: PhysicsBody, node: TransformNode, position: Vec3, q: Quat = identity()) {
    this.impacts.clear(true);
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
  setRemoteSnapshot(snapshot: LocalSimulationSnapshot | SimulationSnapshot, ownId: string) {
    if (!this.prediction) throw new Error('Remote proxies belong to prediction');
    const ids = new Set(snapshot.items.map((i) => i.entityId));
    for (const id of this.items.keys()) if (!ids.has(id)) this.removeItem(id);
    for (const item of snapshot.items) {
      let record = this.objects.get(item.entityId);
      if (!record) {
        this.addItem(item);
        record = this.objects.get(item.entityId)!;
      }
      this.teleport(record.body, record.node, item.position, item.rotation);
      record.revision = item.revision;
      record.item = item;
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
    return this.proximity(shape, position, 0.005, ignoreBody).hasHit;
  }
  private proximity(
    shape: PhysicsShape,
    position: Vec3,
    maxDistance: number,
    ignoreBody?: PhysicsBody,
  ): ProximityCastResult {
    const inputResult = new ProximityCastResult();
    const hitResult = new ProximityCastResult();
    this.plugin.shapeProximity(
      {
        shape,
        position: vector(position),
        rotation: Quaternion.Identity(),
        maxDistance,
        shouldHitTriggers: false,
        ignoreBody,
      },
      inputResult,
      hitResult,
    );
    return hitResult;
  }
  /** Read-only queries at the exact body center; authoring spawn points use spawnPosition(). */
  checkPlayerSpawnPosition(center: Vec3, excludeId?: string): PlayerSpawnCheck {
    if (!center || ![center.x, center.y, center.z].every(Number.isFinite))
      return { ok: false, reason: 'INVALID_POSITION' };
    const { height, radius } = this.definition.simulation.character;
    for (const axis of ['x', 'y', 'z'] as const) {
      const extent = axis === 'y' ? height / 2 : radius;
      if (
        center[axis] - extent < this.definition.bounds.min[axis] ||
        center[axis] + extent > this.definition.bounds.max[axis]
      )
        return { ok: false, reason: 'OUT_OF_BOUNDS' };
    }
    // Mesh queries see surfaces only, so also reject a capsule enclosed by a solid.
    if (this.buildings.contains(center)) return { ok: false, reason: 'BLOCKED' };
    const ignoreBody = this.characters.get(excludeId ?? '')?.body;
    const overlap = this.proximity(this.spawnShape, center, 0, ignoreBody);
    if (overlap.hasHit && overlap.hitDistance < -PLAYER_SPAWN_PENETRATION)
      return { ok: false, reason: 'BLOCKED' };
    const position = vector(center);
    const support = new ShapeCastResult();
    this.plugin.shapeCast(
      {
        shape: this.spawnShape,
        rotation: Quaternion.Identity(),
        startPosition: position.add(new Vector3(0, 0.02, 0)),
        endPosition: position.add(new Vector3(0, -0.06, 0)),
        shouldHitTriggers: false,
        ignoreBody,
      },
      new ShapeCastResult(),
      support,
    );
    if (!support.hasHit) return { ok: false, reason: 'NO_SUPPORT' };
    // Only retained world geometry is stable: sleeping items and players remain dynamic.
    if (!support.body || !this.staticReferences.has(support.body.transformNode.name))
      return { ok: false, reason: 'UNSTABLE_SUPPORT' };
    if (support.hitNormal.y < MAX_PLAYER_SLOPE_COSINE)
      return { ok: false, reason: 'STEEP_SUPPORT' };
    return { ok: true };
  }
  findDefaultPlayerSpawn(excludeId?: string): Vec3 | undefined {
    for (const point of this.definition.spawnPoints) {
      const center = this.spawnPosition(point);
      if (this.checkPlayerSpawnPosition(center, excludeId).ok) return center;
    }
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
    if (!this.prediction) {
      this.impacts.beginStep(dt);
      this.impactMotion.clear();
      for (const record of this.items.values())
        this.impactMotion.set(record.body, {
          velocity: record.body.getLinearVelocity(),
          angular: record.body.getAngularVelocity(),
          center: record.node.position.clone(),
        });
    }
    for (const record of this.characters.values()) {
      const input = normalizeInput(record.input) ?? NEUTRAL_INPUT;
      const config = this.definition.simulation.character;
      const speed = input.sprint ? config.sprintSpeed : config.speed;
      const support = record.controller.checkSupport(dt, down);
      record.grounded = support.supportedState === CharacterSupportedState.SUPPORTED;
      const vertical = record.grounded
        ? Math.min(0, support.averageSurfaceVelocity.y)
        : record.controller.getVelocity().y + this.gravity.y * dt;
      record.controller.setVelocity(
        new Vector3(input.moveX * speed, vertical, input.moveZ * speed),
      );
      if (!this.prediction)
        this.impactMotion.set(record.body, {
          velocity: record.controller.getVelocity().clone(),
          angular: Vector3.Zero(),
          center: record.controller.getPosition().clone(),
        });
      if (input.facingYaw !== undefined) record.yaw = input.facingYaw;
      else if (Math.hypot(input.moveX, input.moveZ) > 0.001)
        record.yaw = Math.atan2(input.moveX, input.moveZ);
      record.controller.integrate(dt, support, this.gravity);
    }
    this.plugin.executeStep(dt, this.physics.getBodies());
    if (!this.prediction) this.returnLostItems();
    if (!this.prediction) this.impacts.endStep();
  }
  private impactPair(a: PhysicsBody, b: PhysicsBody): string {
    for (const body of [a, b])
      if (!this.impactBodyIds.has(body)) this.impactBodyIds.set(body, ++this.nextImpactBodyId);
    const aa = this.impactBodyIds.get(a)!,
      bb = this.impactBodyIds.get(b)!;
    return aa < bb ? `${aa}/${bb}` : `${bb}/${aa}`;
  }
  private impactVelocity(body: PhysicsBody, point: Vector3): Vector3 {
    const motion = this.impactMotion.get(body);
    return motion
      ? motion.velocity.add(Vector3.Cross(motion.angular, point.subtract(motion.center)))
      : Vector3.Zero();
  }
  drainImpacts() {
    return this.impacts.drain();
  }
  suppressImpacts(entityId: string, seconds = 0.25) {
    this.impacts.suppress(entityId, seconds);
  }
  addItem(state: ItemState) {
    if (this.objects.has(state.entityId)) throw new Error('Duplicate physical item');
    const type = this.definition.itemCatalog.types[state.typeId];
    if (!type) throw new Error(`Unknown item type ${state.typeId}`);
    const record: ItemBodyRecord = {
      ...this.createBody(
        {
          ...type,
          entityId: state.entityId,
          kind: 'item',
          position: state.position,
        },
        type,
      ),
      item: structuredClone(state),
      revision: state.revision,
    };
    this.teleport(record.body, record.node, state.position, state.rotation);
    if (!this.prediction) {
      record.body.setLinearVelocity(vector(state.velocity));
      record.body.setAngularVelocity(vector(state.angularVelocity));
    }
    this.objects.set(state.entityId, record);
    this.items.set(state.entityId, record);
  }
  removeItem(id: string) {
    const record = this.objects.get(id);
    if (!record?.item) return;
    this.impacts.clear(true);
    record.body.dispose();
    record.shape.dispose();
    record.node.dispose();
    this.objects.delete(id);
    this.items.delete(id);
  }
  /** Preserve live position and velocity unless persistence describes a new placement. */
  reconcileItems(items: ItemState[]) {
    const ids = new Set(items.map((item) => item.entityId));
    for (const id of this.items.keys()) if (!ids.has(id)) this.removeItem(id);
    for (const item of items)
      if (this.items.get(item.entityId)?.item.placementVersion !== item.placementVersion) {
        this.removeItem(item.entityId);
        this.addItem(item);
      }
  }
  replaceItems(items: ItemState[]) {
    this.impacts.clear();
    for (const id of this.items.keys()) this.removeItem(id);
    for (const item of items) this.addItem(item);
  }
  surfaceRay(from: Vec3, to: Vec3, ignorePlayer?: string) {
    const hit = new PhysicsRaycastResult();
    this.plugin.raycast(vector(from), vector(to), hit, {
      ignoreBody: this.characters.get(ignorePlayer ?? '')?.body,
      shouldHitTriggers: false,
    });
    return hit.hasHit
      ? {
          point: plain(hit.hitPointWorld),
          normal: plain(hit.hitNormalWorld),
          entityId: hit.body?.transformNode.name,
        }
      : undefined;
  }
  canReach(playerId: string, position: Vec3, targetId?: string): ItemError | undefined {
    const player = this.characters.get(playerId);
    if (!player) return 'WORLD_NOT_READY';
    const from = player.controller.getPosition();
    if (Vector3.Distance(from, vector(position)) > ITEM_REACH) return 'OUT_OF_REACH';
    const hit = new PhysicsRaycastResult();
    this.plugin.raycast(from, vector(position), hit, {
      ignoreBody: player.body,
      shouldHitTriggers: false,
    });
    if (
      hit.hasHit &&
      hit.body !== this.objects.get(targetId ?? '')?.body &&
      hit.hitDistance < Vector3.Distance(from, vector(position)) - 0.02
    )
      return 'BLOCKED';
  }
  checkPlacement(
    typeId: string,
    pose: ItemPose,
    playerId?: string,
    ignoreId?: string,
    requireSupport = true,
  ): ItemError | undefined {
    const type = this.definition.itemCatalog.types[typeId];
    if (!type || !validPose(pose)) return 'INVALID_INPUT';
    const p = vector(pose.position),
      q = new Quaternion(
        pose.rotation.x,
        pose.rotation.y,
        pose.rotation.z,
        pose.rotation.w,
      ).normalize();
    for (const axis of ['x', 'y', 'z'] as const) {
      const direction = { x: 0, y: 0, z: 0 };
      direction[axis] = 1;
      if (
        p[axis] + itemSupportDistance(type, rotation(q), direction) >
        this.definition.bounds.max[axis]
      )
        return 'OUT_OF_BOUNDS';
      direction[axis] = -1;
      if (
        p[axis] - itemSupportDistance(type, rotation(q), direction) <
        this.definition.bounds.min[axis]
      )
        return 'OUT_OF_BOUNDS';
    }
    // Triangle queries do not detect a shape wholly enclosed by a solid mesh.
    for (const part of itemShapeParts(type)) {
      const center = vector(part.center).applyRotationQuaternion(q).add(p);
      if (this.buildings.contains(center)) return 'BLOCKED';
      if (part.kind === 'box')
        for (const x of [-0.5, 0.5])
          for (const y of [-0.5, 0.5])
            for (const z of [-0.5, 0.5]) {
              const corner = new Vector3(x * part.size.x, y * part.size.y, z * part.size.z)
                .add(vector(part.center))
                .applyRotationQuaternion(q)
                .add(p);
              if (this.buildings.contains(corner)) return 'BLOCKED';
            }
    }
    if (this.buildings.contains(p)) return 'BLOCKED';
    if (playerId) {
      const error = this.canReach(playerId, pose.position, ignoreId);
      if (error) return error;
    }
    const shape = createItemShape(type, this.scene);
    try {
      const input = new ProximityCastResult(),
        hit = new ProximityCastResult();
      const ignoreBody = this.objects.get(ignoreId ?? '')?.body;
      this.plugin.shapeProximity(
        { shape, position: p, rotation: q, maxDistance: 0, shouldHitTriggers: false, ignoreBody },
        input,
        hit,
      );
      if (hit.hasHit && hit.hitDistance < -0.01) return 'BLOCKED';
      if (!requireSupport) return;
      const support = new ShapeCastResult();
      this.plugin.shapeCast(
        {
          shape,
          rotation: q,
          startPosition: p.add(new Vector3(0, 0.02, 0)),
          endPosition: p.add(new Vector3(0, -0.06, 0)),
          shouldHitTriggers: false,
          ignoreBody,
        },
        new ShapeCastResult(),
        support,
      );
      if (
        !support.hasHit ||
        support.hitNormal.y < 0.4 ||
        [...this.characters.values()].some((c) => c.body === support.body) ||
        [...this.remotePlayers.values()].some((c) => c.body === support.body)
      )
        return 'NO_SUPPORT';
    } finally {
      shape.dispose();
    }
  }
  /** The live editor accepts exactly one box asset. Queries use Havok's actual shapes. */
  checkStaticPlacement(
    instance: BuildingInstance,
    asset: BuildingPhysicsAsset,
  ): StaticPlacementError | undefined {
    const collider = asset.colliders[0];
    if (asset.colliders.length !== 1 || collider?.kind !== 'box') return 'INVALID_INPUT';
    const q = new Quaternion(
      instance.rotation.x,
      instance.rotation.y,
      instance.rotation.z,
      instance.rotation.w,
    );
    const localQ = new Quaternion(
      collider.rotation.x,
      collider.rotation.y,
      collider.rotation.z,
      collider.rotation.w,
    );
    const center = vector(collider.position)
      .applyRotationQuaternion(q)
      .add(vector(instance.position));
    const orientation = q.multiply(localQ).normalize();
    const physical = buildingBounds(
      { ...instance, position: plain(center), rotation: rotation(orientation) },
      {
        min: { x: -collider.size.x / 2, y: -collider.size.y / 2, z: -collider.size.z / 2 },
        max: { x: collider.size.x / 2, y: collider.size.y / 2, z: collider.size.z / 2 },
      },
    );
    for (const b of [physical, buildingBounds(instance, asset.bounds)])
      for (const axis of ['x', 'y', 'z'] as const)
        if (
          b.min[axis] < this.definition.bounds.min[axis] - 1e-8 ||
          b.max[axis] > this.definition.bounds.max[axis] + 1e-8
        )
          return 'OUT_OF_BOUNDS';
    for (const x of [-0.5, 0, 0.5])
      for (const y of [-0.5, 0, 0.5])
        for (const z of [-0.5, 0, 0.5]) {
          const point = new Vector3(x * collider.size.x, y * collider.size.y, z * collider.size.z)
            .applyRotationQuaternion(orientation)
            .add(center);
          if (this.buildings.contains(point)) return 'BLOCKED';
        }
    const shape = new PhysicsShapeBox(
      Vector3.Zero(),
      Quaternion.Identity(),
      vector(collider.size),
      this.scene,
    );
    try {
      const hit = new ProximityCastResult();
      this.plugin.shapeProximity(
        {
          shape,
          position: center,
          rotation: orientation,
          maxDistance: 0,
          shouldHitTriggers: false,
        },
        new ProximityCastResult(),
        hit,
      );
      if (hit.hasHit && hit.hitDistance < -0.005) return 'BLOCKED';
    } finally {
      shape.dispose();
    }
  }
  addStatic(instance: BuildingInstance, asset: BuildingPhysicsAsset) {
    this.retainStatic(instance, 'initial', asset);
  }
  /** Authoritative worlds retain a single initial reference for each complete instance. */
  removeStatic(entityId: string) {
    this.releaseStatic(entityId);
    this.impacts.clear(true);
  }
  /** Stored dynamic poses can be airborne; new placement still requires support. */
  checkSavedItem(item: ItemState): ItemError | undefined {
    if (!validPose(item) || !validPose(item.safePose)) return 'INVALID_INPUT';
    for (const vector of [item.velocity, item.angularVelocity]) {
      if (!vector || ![vector.x, vector.y, vector.z].every(Number.isFinite)) return 'INVALID_INPUT';
    }
    return (
      this.checkPlacement(item.typeId, item, undefined, item.entityId, false) ??
      this.checkPlacement(item.typeId, item.safePose, undefined, item.entityId, false)
    );
  }
  returnLostItems() {
    const { min, max } = this.definition.bounds;
    for (const item of this.items.values()) {
      const p = item.node.position;
      if (
        p.y >= min.y &&
        p.y <= max.y &&
        p.x >= min.x &&
        p.x <= max.x &&
        p.z >= min.z &&
        p.z <= max.z
      )
        continue;
      const safe = item.item.safePose;
      const candidates: ItemPose[] = [safe];
      for (let radius = 1; radius <= 4; radius++)
        for (const [x, z] of [
          [radius, 0],
          [-radius, 0],
          [0, radius],
          [0, -radius],
        ])
          candidates.push({
            position: {
              x: safe.position.x + x * (item.definition.size.x + 0.2),
              y: safe.position.y,
              z: safe.position.z + z * (item.definition.size.z + 0.2),
            },
            rotation: safe.rotation,
          });
      for (const spawn of this.definition.spawnPoints)
        candidates.push({
          position: { ...spawn, y: spawn.y + item.definition.size.y / 2 + 0.02 },
          rotation: identity(),
        });
      const next = candidates.find(
        (pose) => !this.checkPlacement(item.item.typeId, pose, undefined, item.definition.entityId),
      );
      if (!next) {
        item.body.setLinearVelocity(Vector3.Zero());
        item.body.setAngularVelocity(Vector3.Zero());
        item.body.setMotionType(PhysicsMotionType.ANIMATED);
        item.recovering = true;
        continue;
      }
      if (item.recovering) {
        item.body.setMotionType(PhysicsMotionType.DYNAMIC);
        item.recovering = false;
      }
      this.teleport(item.body, item.node, next.position, next.rotation);
      item.item.safePose = structuredClone(next);
      item.revision++;
    }
  }
  dispose() {
    this.impacts.clear();
    this.impactMotion.clear();
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
    this.items.clear();
    this.staticReferences.clear();
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
