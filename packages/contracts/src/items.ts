import type { EntityState, Quat, Vec3 } from './index.js';

export const ITEM_REACH = 3;
export const ITEM_SAVE_INTERVAL_MS = 1000;
export const ITEM_GIVE_COOLDOWN_MS = 2000;
export interface ItemType {
  typeId: string;
  name: string;
  icon: string;
  model: 'box';
  size: Vec3;
  mass: number;
  friction: number;
  restitution: number;
  color: string;
  maxStack: number;
}
export interface ItemCatalog {
  version: string;
  types: Record<string, ItemType>;
}
export interface ItemPose {
  position: Vec3;
  rotation: Quat;
}
export interface InitialItem extends ItemPose {
  seedId: string;
  typeId: string;
}
export interface ItemState extends EntityState {
  kind: 'item';
  typeId: string;
  placementVersion: number;
  safePose: ItemPose;
}
export interface InventoryItem {
  itemId: string;
  typeId: string;
  properties: Record<string, unknown>;
}
export interface InventorySlot {
  slotId: string;
  position: number;
  items: InventoryItem[];
}
export interface InventoryView {
  slots: InventorySlot[];
}
export type ItemAction =
  | { kind: 'pickup'; itemId: string }
  | { kind: 'place'; itemId: string; pose: ItemPose }
  | { kind: 'move'; slotId: string; targetSlotId: string }
  | { kind: 'split'; slotId: string; count: number }
  | { kind: 'merge'; slotId: string; targetSlotId: string };
export interface ItemCommand {
  operationId: string;
  worldEpoch: string;
  action: ItemAction;
}
export type ItemError =
  | 'AUTH_REQUIRED'
  | 'WORLD_NOT_READY'
  | 'STALE_WORLD'
  | 'INVALID_INPUT'
  | 'ITEM_UNAVAILABLE'
  | 'OUT_OF_REACH'
  | 'BLOCKED'
  | 'NO_SUPPORT'
  | 'OUT_OF_BOUNDS'
  | 'INCOMPATIBLE_STACK'
  | 'OPERATION_CONFLICT'
  | 'STORAGE_UNAVAILABLE'
  | 'RATE_LIMITED';
export interface ItemResult {
  operationId: string;
  ok: boolean;
  code?: ItemError;
}
const id = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(v);
export function validVector(v: unknown): v is Vec3 {
  return (
    !!v &&
    typeof v === 'object' &&
    ['x', 'y', 'z'].every(
      (a) =>
        typeof (v as Record<string, unknown>)[a] === 'number' &&
        Number.isFinite((v as Vec3)[a as keyof Vec3]) &&
        Math.abs((v as Vec3)[a as keyof Vec3]) <= 100_000,
    )
  );
}
export function validPose(v: unknown): v is ItemPose {
  if (!v || typeof v !== 'object') return false;
  const { position, rotation } = v as ItemPose;
  return (
    validVector(position) &&
    validVector(rotation) &&
    Number.isFinite(rotation.w) &&
    Math.abs(Math.hypot(rotation.x, rotation.y, rotation.z, rotation.w) - 1) < 0.001
  );
}
export function parseItemCommand(v: unknown): ItemCommand | undefined {
  if (!v || typeof v !== 'object') return;
  const c = v as ItemCommand;
  if (!id(c.operationId) || !id(c.worldEpoch) || !c.action || typeof c.action !== 'object') return;
  const a = c.action;
  if (
    (a.kind === 'pickup' && id(a.itemId)) ||
    (a.kind === 'place' && id(a.itemId) && validPose(a.pose)) ||
    ((a.kind === 'move' || a.kind === 'merge') &&
      id(a.slotId) &&
      id(a.targetSlotId) &&
      a.slotId !== a.targetSlotId) ||
    (a.kind === 'split' && id(a.slotId) && Number.isSafeInteger(a.count) && a.count > 0)
  )
    return c;
}
export function validateItemCatalog(value: ItemCatalog): void {
  if (
    !value ||
    !id(value.version) ||
    !value.types ||
    typeof value.types !== 'object' ||
    Array.isArray(value.types)
  )
    throw new Error('Invalid item catalog');
  for (const [key, t] of Object.entries(value.types)) {
    if (
      !t ||
      !id(key) ||
      t.typeId !== key ||
      typeof t.name !== 'string' ||
      !t.name.trim() ||
      t.name.length > 80 ||
      typeof t.icon !== 'string' ||
      t.icon.length > 32 ||
      t.model !== 'box' ||
      !validVector(t.size) ||
      Object.values(t.size).some((n) => n <= 0 || n > 100) ||
      !Number.isFinite(t.mass) ||
      t.mass <= 0 ||
      t.mass > 10000 ||
      !Number.isFinite(t.friction) ||
      t.friction < 0 ||
      t.friction > 10 ||
      !Number.isFinite(t.restitution) ||
      t.restitution < 0 ||
      t.restitution > 1 ||
      !/^#[a-f\d]{6}$/i.test(t.color) ||
      !Number.isSafeInteger(t.maxStack) ||
      t.maxStack < 1
    )
      throw new Error(`Invalid item type ${key}`);
  }
}
export function initialItemState(seed: InitialItem, itemId = seed.seedId): ItemState {
  return {
    entityId: itemId,
    kind: 'item',
    typeId: seed.typeId,
    revision: 0,
    placementVersion: 1,
    position: { ...seed.position },
    rotation: { ...seed.rotation },
    velocity: { x: 0, y: 0, z: 0 },
    angularVelocity: { x: 0, y: 0, z: 0 },
    safePose: { position: { ...seed.position }, rotation: { ...seed.rotation } },
  };
}
