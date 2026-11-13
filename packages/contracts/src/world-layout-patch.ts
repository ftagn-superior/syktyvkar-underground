import { MAX_EDITABLE_STATIC_INSTANCES } from './static-placement.js';
import type { StaticObjectInstance, WorldLayoutSnapshot } from './world-types.js';
import { validateBuildingInstances } from './world-bundle.js';
import { canonicalJson } from './world.js';

export type StaticObjectPlacement = Omit<StaticObjectInstance, 'instanceRevision'>;
export type WorldLayoutPatchOperation =
  | { op: 'add'; instance: StaticObjectPlacement }
  | { op: 'update'; expectedRevision: number; instance: StaticObjectPlacement }
  | { op: 'delete'; entityId: string; expectedRevision: number };
export interface WorldLayoutPatch {
  formatVersion: 1;
  worldId: string;
  assetReleaseVersion: string;
  seedVersion: string;
  baseRevision: number;
  operations: WorldLayoutPatchOperation[];
}

const maxRevision = 2147483647;
const idPattern = /^[a-zA-Z0-9_-]{1,80}$/;
const hashPattern = /^[a-f0-9]{64}$/;
function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid layout file: ${message}`);
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function keys(value: unknown, allowed: string[]): asserts value is Record<string, unknown> {
  requireValue(record(value), 'expected an object');
  for (const key of Object.keys(value)) requireValue(allowed.includes(key), `unknown field ${key}`);
}
function revision(value: unknown): asserts value is number {
  requireValue(
    Number.isInteger(value) && Number(value) > 0 && Number(value) <= maxRevision,
    'revision must be an integer between 1 and 2147483647',
  );
}
function header(value: Record<string, unknown>) {
  requireValue(value.formatVersion === 1, 'unsupported formatVersion');
  requireValue(
    typeof value.worldId === 'string' && /^[a-z0-9-]{1,64}$/.test(value.worldId),
    'worldId',
  );
  for (const key of ['assetReleaseVersion', 'seedVersion'])
    requireValue(typeof value[key] === 'string' && hashPattern.test(value[key]), key);
}
function placement(value: unknown, withRevision: boolean) {
  keys(value, [
    'entityId',
    'assetId',
    'position',
    'rotation',
    'sourceRef',
    'enabled',
    ...(withRevision ? ['instanceRevision'] : []),
  ]);
  keys(value.position, ['x', 'y', 'z']);
  keys(value.rotation, ['x', 'y', 'z', 'w']);
  if (value.sourceRef !== undefined) keys(value.sourceRef, ['provider', 'type', 'id']);
  validateBuildingInstances([value]);
  const q = value.rotation as StaticObjectPlacement['rotation'];
  requireValue(
    Math.abs(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w - 1) < 0.000001,
    'rotation must be a unit quaternion',
  );
  requireValue(typeof value.enabled === 'boolean', 'enabled must be boolean');
  if (withRevision) revision(value.instanceRevision);
}

export function validateWorldLayoutSnapshot(value: unknown): asserts value is WorldLayoutSnapshot {
  keys(value, [
    'formatVersion',
    'worldId',
    'assetReleaseVersion',
    'seedVersion',
    'revision',
    'instances',
  ]);
  header(value);
  revision(value.revision);
  requireValue(
    Array.isArray(value.instances) && value.instances.length <= MAX_EDITABLE_STATIC_INSTANCES,
    'instances',
  );
  const ids = new Set<string>();
  for (const instance of value.instances) {
    placement(instance, true);
    requireValue(!ids.has(instance.entityId), `duplicate instance ${instance.entityId}`);
    ids.add(instance.entityId);
  }
}

export function validateWorldLayoutPatch(value: unknown): asserts value is WorldLayoutPatch {
  keys(value, [
    'formatVersion',
    'worldId',
    'assetReleaseVersion',
    'seedVersion',
    'baseRevision',
    'operations',
  ]);
  header(value);
  revision(value.baseRevision);
  requireValue(Array.isArray(value.operations) && value.operations.length <= 20_000, 'operations');
  const ids = new Set<string>();
  for (const operation of value.operations) {
    requireValue(record(operation), 'operation');
    let id: string;
    if (operation.op === 'add' || operation.op === 'update') {
      keys(operation, [
        'op',
        'instance',
        ...(operation.op === 'update' ? ['expectedRevision'] : []),
      ]);
      placement(operation.instance, false);
      id = (operation.instance as StaticObjectPlacement).entityId;
      if (operation.op === 'update') revision(operation.expectedRevision);
    } else {
      requireValue(operation.op === 'delete', 'unknown operation');
      keys(operation, ['op', 'entityId', 'expectedRevision']);
      requireValue(
        typeof operation.entityId === 'string' && idPattern.test(operation.entityId),
        'entityId',
      );
      id = operation.entityId;
      revision(operation.expectedRevision);
    }
    requireValue(!ids.has(id), `multiple operations for ${id}`);
    ids.add(id);
  }
}

function editable(instance: StaticObjectInstance): StaticObjectPlacement {
  const { instanceRevision: _revision, ...value } = instance;
  return structuredClone(value);
}
function same(a: unknown, b: unknown) {
  return canonicalJson(a) === canonicalJson(b);
}

/** Offline diff: metadata and existing revisions remain exactly as exported. */
export function createWorldLayoutPatch(base: unknown, edited: unknown): WorldLayoutPatch {
  validateWorldLayoutSnapshot(base);
  validateWorldLayoutSnapshot(edited);
  for (const field of ['worldId', 'assetReleaseVersion', 'seedVersion', 'revision'] as const)
    requireValue(base[field] === edited[field], `do not edit ${field}`);
  const before = new Map(base.instances.map((i) => [i.entityId, i]));
  const after = new Map(edited.instances.map((i) => [i.entityId, i]));
  const operations: WorldLayoutPatchOperation[] = [];
  for (const id of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const old = before.get(id),
      next = after.get(id);
    if (!next)
      operations.push({ op: 'delete', entityId: id, expectedRevision: old!.instanceRevision });
    else if (!old) {
      requireValue(next.instanceRevision === 1, `new instance ${id} must have instanceRevision 1`);
      operations.push({ op: 'add', instance: editable(next) });
    } else {
      requireValue(
        old.instanceRevision === next.instanceRevision,
        `do not edit instanceRevision of ${id}`,
      );
      if (!same(editable(old), editable(next)))
        operations.push({
          op: 'update',
          expectedRevision: old.instanceRevision,
          instance: editable(next),
        });
    }
  }
  return {
    formatVersion: 1,
    worldId: base.worldId,
    assetReleaseVersion: base.assetReleaseVersion,
    seedVersion: base.seedVersion,
    baseRevision: base.revision,
    operations,
  };
}

/** Pure preview. The server additionally checks the catalog, bounds, spawns and saved items. */
export function applyWorldLayoutPatch(base: unknown, patch: unknown): WorldLayoutSnapshot {
  validateWorldLayoutSnapshot(base);
  validateWorldLayoutPatch(patch);
  for (const field of ['worldId', 'assetReleaseVersion', 'seedVersion'] as const)
    requireValue(base[field] === patch[field], `patch ${field} differs from current world`);
  requireValue(
    base.revision === patch.baseRevision,
    `stale patch: expected layout revision ${patch.baseRevision}, current ${base.revision}; export again`,
  );
  const instances = new Map(base.instances.map((i) => [i.entityId, structuredClone(i)]));
  for (const operation of patch.operations) {
    const id = operation.op === 'delete' ? operation.entityId : operation.instance.entityId;
    const old = instances.get(id);
    if (operation.op === 'add') {
      requireValue(!old, `instance ${id} already exists`);
      instances.set(id, { ...structuredClone(operation.instance), instanceRevision: 1 });
    } else {
      requireValue(old, `instance ${id} does not exist`);
      requireValue(
        old.instanceRevision === operation.expectedRevision,
        `stale instance ${id}: expected revision ${operation.expectedRevision}, current ${old.instanceRevision}`,
      );
      if (operation.op === 'delete') instances.delete(id);
      else {
        requireValue(!same(editable(old), operation.instance), `update ${id} makes no changes`);
        revision(old.instanceRevision + 1);
        instances.set(id, {
          ...structuredClone(operation.instance),
          instanceRevision: old.instanceRevision + 1,
        });
      }
    }
  }
  const result: WorldLayoutSnapshot = {
    ...base,
    revision: base.revision + patch.operations.length,
    instances: [...instances.values()].sort((a, b) =>
      a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0,
    ),
  };
  validateWorldLayoutSnapshot(result);
  return result;
}
