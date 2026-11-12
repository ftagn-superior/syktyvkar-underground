import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { WorldOwnership } from '../world-ownership.js';
import { createAuthoritativeWorld } from '@su/simulation/server';
import {
  canonicalJson,
  ITEM_GIVE_COOLDOWN_MS,
  initialItemState,
  itemPhysicsDefinition,
  validPose,
  validVector,
  type InventoryView,
  type InventoryItem,
  type ItemAction,
  type ItemCatalog,
  type ItemError,
  type ItemResult,
  type ItemState,
  type WorldDefinition,
  simulationProjection,
} from '@su/contracts';

interface Row {
  id: string;
  type_id: string;
  properties: Record<string, unknown>;
  world_id: string | null;
  slot_id: string | null;
  physical: ItemState | null;
  placement_version: number;
}
// Creation is a server-side mutation reached through chat, not a raw itemCommand action.
export type ItemMutation = ItemAction | { kind: 'give'; typeId: string };
export type ItemMutationResult = ItemResult & { itemId?: string };
export class ItemRejection extends Error {
  constructor(readonly code: ItemError) {
    super(code);
  }
}
const reject = (code: ItemError): never => {
  throw new ItemRejection(code);
};
const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
export function worldCompatibility(definition: WorldDefinition): string {
  // Initial population and stack limits may change without changing existing instances.
  return digest(
    simulationProjection({
      ...definition,
      initialItems: [],
      itemCatalog: { version: '', types: {} },
    }),
  );
}
function physicsCatalog(catalog: ItemCatalog) {
  return Object.fromEntries(
    Object.entries(catalog.types).map(([id, t]) => [id, itemPhysicsDefinition(t)]),
  );
}

/** All access uses the session holding the world lock, including after connection recovery. */
export class ItemStore {
  private started = false;
  readonly ownership: WorldOwnership;
  set onConnectionFailure(callback: (() => void) | undefined) {
    this.ownership.onConnectionFailure = callback;
  }
  constructor(
    readonly pool: Pool,
    readonly definition: WorldDefinition,
    readonly epoch: string,
    ownership?: WorldOwnership,
    private readonly initializeLayout?: () => Promise<void>,
  ) {
    this.ownership = ownership ?? new WorldOwnership(pool, definition.worldId, epoch);
  }
  async connect(): Promise<void> {
    await this.ownership.connect();
  }
  private get db(): PoolClient {
    return this.ownership.db;
  }
  async initialize(): Promise<ItemState[]> {
    await this.connect();
    await this.transaction(async () => {
      const found = await this.db.query('SELECT * FROM persistent_worlds WHERE id=$1 FOR UPDATE', [
        this.definition.worldId,
      ]);
      const hash = worldCompatibility(this.definition),
        catalog = physicsCatalog(this.definition.itemCatalog);
      if (found.rowCount && found.rows[0].compatibility_hash !== hash)
        throw new Error(
          'Saved world geometry is incompatible. Stop the server and run pnpm world:migrate after pnpm build.',
        );
      const used = new Set(
        (
          await this.db.query<{ type_id: string }>('SELECT DISTINCT type_id FROM item_instances')
        ).rows.map((row) => row.type_id),
      );
      for (const id of used)
        if (!Object.hasOwn(catalog, id)) throw new Error(`Saved item type is incompatible: ${id}`);
      for (const [id, type] of Object.entries(this.definition.itemCatalog.types)) {
        const existing = await this.db.query('SELECT physics FROM item_types WHERE id=$1', [id]);
        if (
          existing.rowCount &&
          canonicalJson(existing.rows[0].physics) !== canonicalJson(catalog[id]) &&
          used.has(id)
        )
          throw new Error(`Saved item type is incompatible: ${id}`);
        await this.db.query(
          'INSERT INTO item_types(id,max_stack,physics) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET max_stack=$2,physics=$3',
          [id, type.maxStack, catalog[id]],
        );
      }
      if (!found.rowCount) {
        await this.db.query(
          'INSERT INTO persistent_worlds(id,compatibility_hash,epoch) VALUES($1,$2,$3)',
          [this.definition.worldId, hash, this.epoch],
        );
        for (const seed of this.definition.initialItems) {
          const state = initialItemState(seed, randomUUID());
          await this.db.query(
            `INSERT INTO item_instances(id,type_id,world_id,physical,placement_version,snapshot_epoch,seed_world_id,seed_id)
            VALUES($1,$2,$3,$4,1,$5,$3,$6)`,
            [state.entityId, state.typeId, this.definition.worldId, state, this.epoch, seed.seedId],
          );
        }
      } else {
        await this.db.query('UPDATE persistent_worlds SET epoch=$2 WHERE id=$1', [
          this.definition.worldId,
          this.epoch,
        ]);
      }
      // Stack migrations cover offline owners too, preserving existing slot identity/order.
      const accounts = await this.db.query<{ account_id: string }>(
        'SELECT DISTINCT account_id FROM inventory_slots',
      );
      for (const { account_id } of accounts.rows) await this.normalizeStacks(account_id);
      await this.initializeLayout?.();
    });
    this.started = true;
    this.ownership.markStarted();
    return this.worldItems();
  }
  /** Explicit offline upgrade: preserve every item and accept only poses valid in the new map. */
  async migrateGeometry(afterValidation?: () => Promise<void>, dryRun = false) {
    if (this.started) throw new Error('Stop the world before migrating its geometry.');
    await this.connect();
    return this.transaction(async () => {
      const found = await this.db.query<{ compatibility_hash: string }>(
        'SELECT compatibility_hash FROM persistent_worlds WHERE id=$1 FOR UPDATE',
        [this.definition.worldId],
      );
      const to = worldCompatibility(this.definition);
      // A fresh database is populated once by initialize(), after all startup checks pass.
      if (!found.rowCount) return { from: null, to, changed: false };
      const from = found.rows[0].compatibility_hash;
      if (from === to) {
        if (!dryRun) await afterValidation?.();
        return { from, to, changed: false };
      }

      const catalog = physicsCatalog(this.definition.itemCatalog);
      const used = await this.db.query<{ id: string; physics: unknown }>(
        'SELECT id,physics FROM item_types WHERE id IN (SELECT type_id FROM item_instances)',
      );
      for (const type of used.rows)
        if (
          !Object.hasOwn(catalog, type.id) ||
          canonicalJson(type.physics) !== canonicalJson(catalog[type.id])
        )
          throw new Error(`Saved item type is incompatible: ${type.id}`);

      const items = await this.worldItems();
      const world = await createAuthoritativeWorld({ ...this.definition, initialItems: [] });
      try {
        // Validate against the new static geometry. Other saved dynamics can occupy
        // an earlier safePose, and normal contact snapshots may slightly overlap.
        // Neither changes whether the map itself is compatible with this snapshot.
        for (const item of items) {
          const error = world.checkSavedItem(item);
          if (error)
            throw new Error(`Saved item ${item.entityId} cannot stay in the new map: ${error}`);
        }
      } finally {
        world.dispose();
      }
      if (!dryRun) {
        await this.db.query('UPDATE persistent_worlds SET compatibility_hash=$2 WHERE id=$1', [
          this.definition.worldId,
          to,
        ]);
        await afterValidation?.();
      }
      return { from, to, changed: true };
    });
  }
  private async transaction<T>(run: () => Promise<T>): Promise<T> {
    const client = this.db;
    try {
      await client.query('BEGIN');
      const result = await run();
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  }
  async worldItems(): Promise<ItemState[]> {
    const rows = await this.db.query<Row>(
      'SELECT * FROM item_instances WHERE world_id=$1 ORDER BY id',
      [this.definition.worldId],
    );
    return rows.rows.map((row) => {
      const s = row.physical;
      if (
        !s ||
        !Object.hasOwn(this.definition.itemCatalog.types, row.type_id) ||
        !validPose(s) ||
        !validPose(s.safePose) ||
        !validVector(s.velocity) ||
        !validVector(s.angularVelocity)
      )
        throw new Error('Invalid saved item physics');
      return {
        ...s,
        entityId: row.id,
        kind: 'item',
        typeId: row.type_id,
        placementVersion: row.placement_version,
      };
    });
  }
  async inventory(accountId: string): Promise<InventoryView> {
    const slots = await this.db.query<{ id: string; position: string }>(
      'SELECT id,position FROM inventory_slots WHERE account_id=$1 ORDER BY position,id',
      [accountId],
    );
    const items = await this.db.query<Row>(
      'SELECT i.* FROM item_instances i JOIN inventory_slots s ON s.id=i.slot_id WHERE s.account_id=$1 ORDER BY i.id',
      [accountId],
    );
    const bySlot = new Map<string, InventoryItem[]>();
    for (const item of items.rows) {
      const members = bySlot.get(item.slot_id!) ?? [];
      members.push({ itemId: item.id, typeId: item.type_id, properties: item.properties });
      bySlot.set(item.slot_id!, members);
    }
    return {
      slots: slots.rows
        .map((s) => ({ slotId: s.id, position: Number(s.position), items: bySlot.get(s.id) ?? [] }))
        .filter((s) => s.items.length),
    };
  }
  private async newSlot(accountId: string): Promise<string> {
    const id = randomUUID();
    await this.db.query(
      'INSERT INTO inventory_slots(id,account_id,position) SELECT $1,$2,COALESCE(MAX(position)+1,0) FROM inventory_slots WHERE account_id=$2',
      [id, accountId],
    );
    return id;
  }
  private async receivingSlot(
    accountId: string,
    typeId: string,
    properties: Record<string, unknown>,
  ): Promise<string> {
    const inventory = await this.inventory(accountId);
    return (
      inventory.slots.find(
        (s) =>
          s.items.length < this.definition.itemCatalog.types[typeId].maxStack &&
          s.items.every(
            (i) => i.typeId === typeId && canonicalJson(i.properties) === canonicalJson(properties),
          ),
      )?.slotId ?? (await this.newSlot(accountId))
    );
  }
  private async normalizeStacks(accountId: string) {
    for (const slot of (await this.inventory(accountId)).slots) {
      const first = slot.items[0];
      const limit = this.definition.itemCatalog.types[first.typeId]?.maxStack;
      if (
        !limit ||
        slot.items.some(
          (i) =>
            i.typeId !== first.typeId ||
            canonicalJson(i.properties) !== canonicalJson(first.properties),
        )
      )
        throw new Error('Incompatible saved inventory stack');
      for (let index = limit; index < slot.items.length; index += limit) {
        const target = await this.newSlot(accountId);
        await this.db.query('UPDATE item_instances SET slot_id=$1 WHERE id=ANY($2::text[])', [
          target,
          slot.items.slice(index, index + limit).map((i) => i.itemId),
        ]);
      }
    }
  }
  async operation(
    accountId: string,
    operationId: string,
    action: ItemMutation,
    validate: (action: ItemMutation, typeId?: string) => ItemError | undefined,
  ): Promise<ItemMutationResult> {
    return this.transaction(async () => {
      const prior = await this.db.query(
        'SELECT request,result FROM item_operations WHERE account_id=$1 AND operation_id=$2',
        [accountId, operationId],
      );
      if (prior.rowCount)
        return canonicalJson(prior.rows[0].request) ===
          canonicalJson({ worldId: this.definition.worldId, action })
          ? prior.rows[0].result
          : { operationId, ok: false, code: 'OPERATION_CONFLICT' };
      // A savepoint allows a definite validation failure to be remembered atomically too.
      await this.db.query('SAVEPOINT item_action');
      let result: ItemMutationResult;
      try {
        const initialError = validate(action);
        if (initialError) reject(initialError);
        const itemId = await this.applyAction(accountId, action, validate);
        result = { operationId, ok: true, ...(itemId ? { itemId } : {}) };
      } catch (error) {
        if (!(error instanceof ItemRejection)) throw error;
        await this.db.query('ROLLBACK TO SAVEPOINT item_action');
        result = { operationId, ok: false, code: error.code };
      }
      await this.db.query(
        'INSERT INTO item_operations(account_id,operation_id,world_id,request,result) VALUES($1,$2,$3,$4,$5)',
        [
          accountId,
          operationId,
          this.definition.worldId,
          { worldId: this.definition.worldId, action },
          result,
        ],
      );
      return result;
    });
  }
  private async applyAction(
    accountId: string,
    action: ItemMutation,
    validate: (a: ItemMutation, typeId?: string) => ItemError | undefined,
  ) {
    if (action.kind === 'give') {
      if (!Object.hasOwn(this.definition.itemCatalog.types, action.typeId))
        return reject('INVALID_INPUT');
      const recent = await this.db.query(
        `SELECT 1 FROM item_operations WHERE account_id=$1
          AND request->'action'->>'kind'='give' AND result->>'ok'='true'
          AND created_at > clock_timestamp() - $2 * INTERVAL '1 millisecond' LIMIT 1`,
        [accountId, ITEM_GIVE_COOLDOWN_MS],
      );
      if (recent.rowCount) return reject('RATE_LIMITED');
      const slotId = await this.receivingSlot(accountId, action.typeId, {});
      const itemId = randomUUID();
      await this.db.query(
        'INSERT INTO item_instances(id,type_id,slot_id,placement_version) VALUES($1,$2,$3,1)',
        [itemId, action.typeId, slotId],
      );
      return itemId;
    }
    if (action.kind === 'pickup' || action.kind === 'place') {
      const row = (
        await this.db.query<Row>('SELECT * FROM item_instances WHERE id=$1 FOR UPDATE', [
          action.itemId,
        ])
      ).rows[0];
      if (!row) return reject('ITEM_UNAVAILABLE');
      if (action.kind === 'pickup') {
        if (row.world_id !== this.definition.worldId) return reject('ITEM_UNAVAILABLE');
        const error = validate(action, row.type_id);
        if (error) reject(error);
        const slotId = await this.receivingSlot(accountId, row.type_id, row.properties);
        await this.db.query(
          'UPDATE item_instances SET world_id=NULL,physical=NULL,slot_id=$2,placement_version=placement_version+1 WHERE id=$1',
          [row.id, slotId],
        );
      } else {
        if (
          !row.slot_id ||
          !(await this.inventory(accountId)).slots.some((s) => s.slotId === row.slot_id)
        )
          return reject('ITEM_UNAVAILABLE');
        const error = validate(action, row.type_id);
        if (error) reject(error);
        const state = {
          ...initialItemState({ ...action.pose, seedId: row.id, typeId: row.type_id }),
          placementVersion: row.placement_version + 1,
        };
        await this.db.query(
          'UPDATE item_instances SET world_id=$2,physical=$3,slot_id=NULL,placement_version=placement_version+1,snapshot_epoch=$4,snapshot_sequence=-1 WHERE id=$1',
          [row.id, this.definition.worldId, state, this.epoch],
        );
      }
    } else {
      const inventory = await this.inventory(accountId);
      const source = inventory.slots.find((s) => s.slotId === action.slotId);
      if (!source) return reject('ITEM_UNAVAILABLE');
      if (action.kind === 'split') {
        if (action.count >= source.items.length) return reject('INVALID_INPUT');
        const target = await this.newSlot(accountId);
        await this.db.query('UPDATE item_instances SET slot_id=$1 WHERE id=ANY($2::text[])', [
          target,
          source.items.slice(-action.count).map((i) => i.itemId),
        ]);
      } else {
        const target = inventory.slots.find((s) => s.slotId === action.targetSlotId);
        if (!target) return reject('ITEM_UNAVAILABLE');
        if (action.kind === 'move') {
          await this.db.query(
            'UPDATE inventory_slots SET position=CASE WHEN id=$1 THEN $3::bigint ELSE $4::bigint END WHERE id IN ($1,$2)',
            [source.slotId, target.slotId, target.position, source.position],
          );
        } else {
          const first = target.items[0];
          if (
            source.items.some(
              (i) =>
                i.typeId !== first.typeId ||
                canonicalJson(i.properties) !== canonicalJson(first.properties),
            )
          )
            return reject('INCOMPATIBLE_STACK');
          const count = Math.min(
            source.items.length,
            this.definition.itemCatalog.types[first.typeId].maxStack - target.items.length,
          );
          if (count <= 0) return reject('INCOMPATIBLE_STACK');
          await this.db.query('UPDATE item_instances SET slot_id=$1 WHERE id=ANY($2::text[])', [
            target.slotId,
            source.items.slice(0, count).map((i) => i.itemId),
          ]);
        }
      }
    }
    await this.db.query(
      'DELETE FROM inventory_slots s WHERE account_id=$1 AND NOT EXISTS(SELECT 1 FROM item_instances i WHERE i.slot_id=s.id)',
      [accountId],
    );
  }
  async save(items: ItemState[], sequence: number) {
    if (!items.length) {
      await this.db.query('SELECT 1');
      return;
    }
    await this.transaction(async () => {
      for (const item of items)
        await this.db.query(
          `UPDATE item_instances SET physical=$4,snapshot_epoch=$5,snapshot_sequence=$6
        WHERE id=$1 AND world_id=$2 AND placement_version=$3
        AND EXISTS(SELECT 1 FROM persistent_worlds WHERE id=$2 AND epoch=$5)
        AND (snapshot_epoch IS DISTINCT FROM $5::uuid OR snapshot_sequence<$6)`,
          [
            item.entityId,
            this.definition.worldId,
            item.placementVersion,
            item,
            this.epoch,
            sequence,
          ],
        );
    });
  }
  async close() {
    await this.ownership.close();
  }
}
