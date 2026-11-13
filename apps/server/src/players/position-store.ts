import type { Pool, PoolClient } from 'pg';
import type { Vec3 } from '@su/contracts';

export interface PlayerPositionSnapshot {
  accountId: string;
  worldId: string;
  /** World-space centre of the physical capsule. */
  position: Vec3;
  writeEpoch: string;
  writeSequence: number;
}

export type PositionLoadResult =
  | { status: 'found'; snapshot: PlayerPositionSnapshot }
  | { status: 'missing' }
  | { status: 'unavailable'; reason: 'timeout' | 'storage' | 'invalid' };

export type PositionWriteResult = 'saved' | 'superseded' | 'ownership-lost';

interface PositionRow {
  account_id: string;
  world_id: string;
  x: number;
  y: number;
  z: number;
  write_epoch: string;
  write_sequence: string;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validPositionSnapshot(snapshot: PlayerPositionSnapshot): boolean {
  return (
    uuid.test(snapshot.accountId) &&
    typeof snapshot.worldId === 'string' &&
    snapshot.worldId.length > 0 &&
    uuid.test(snapshot.writeEpoch) &&
    Number.isSafeInteger(snapshot.writeSequence) &&
    snapshot.writeSequence >= 0 &&
    [snapshot.position.x, snapshot.position.y, snapshot.position.z].every(Number.isFinite)
  );
}

/** Short pool transactions, independent of the item owner's advisory-lock connection. */
export class PlayerPositionStore {
  private aborted = false;
  private leases = new Map<PoolClient, { destroyed: boolean; onError: () => void }>();
  private acquisitions = new Set<() => void>();

  constructor(readonly pool: Pool) {}

  private acquire(): Promise<PoolClient> {
    if (this.aborted) return Promise.reject(new Error('Player position store closed'));
    return new Promise((resolve, reject) => {
      let settled = false;
      const cancel = () => {
        settled = true;
        reject(new Error('Player position store closed'));
      };
      this.acquisitions.add(cancel);
      this.pool.connect((error, client) => {
        this.acquisitions.delete(cancel);
        if (settled || this.aborted) {
          client?.release(true);
          return;
        }
        settled = true;
        if (error || !client) {
          reject(error ?? new Error('Player position connection unavailable'));
          return;
        }
        const lease = {
          destroyed: false,
          onError: () => {
            lease.destroyed = true;
          },
        };
        client.on('error', lease.onError);
        this.leases.set(client, lease);
        resolve(client);
      });
    });
  }

  private async transaction<T>(timeout: number, operation: (client: PoolClient) => Promise<T>) {
    const client = await this.acquire();
    const lease = this.leases.get(client);
    if (!lease || this.aborted) throw new Error('Player position store closed');
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL statement_timeout = ${timeout}`);
      await client.query('SET LOCAL lock_timeout = 500');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      if (!this.aborted && !lease.destroyed) {
        try {
          await client.query('ROLLBACK');
        } catch {
          lease.destroyed = true;
        }
      }
      throw error;
    } finally {
      client.removeListener('error', lease.onError);
      if (this.leases.delete(client)) client.release(lease.destroyed || this.aborted);
    }
  }

  async load(accountId: string, worldId: string): Promise<PositionLoadResult> {
    return this.transaction(1000, async (client) => {
      const result = await client.query<PositionRow>(
        'SELECT account_id,world_id,x,y,z,write_epoch,write_sequence FROM player_positions WHERE account_id=$1 AND world_id=$2',
        [accountId, worldId],
      );
      const row = result.rows[0];
      if (!row) return { status: 'missing' };
      const snapshot: PlayerPositionSnapshot = {
        accountId: row.account_id,
        worldId: row.world_id,
        position: { x: row.x, y: row.y, z: row.z },
        writeEpoch: row.write_epoch,
        writeSequence: Number(row.write_sequence),
      };
      if (!validPositionSnapshot(snapshot)) return { status: 'unavailable', reason: 'invalid' };
      return { status: 'found', snapshot };
    });
  }

  async save(snapshot: PlayerPositionSnapshot): Promise<PositionWriteResult> {
    if (!validPositionSnapshot(snapshot)) throw new Error('Invalid player position snapshot');
    return this.transaction(2000, async (client) => {
      // FOR SHARE serializes this write with the next owner's epoch UPDATE until COMMIT.
      const owner = await client.query<{ epoch: string }>(
        'SELECT epoch FROM persistent_worlds WHERE id=$1 FOR SHARE',
        [snapshot.worldId],
      );
      if (owner.rows[0]?.epoch !== snapshot.writeEpoch) return 'ownership-lost';
      const { position } = snapshot;
      const result = await client.query(
        `INSERT INTO player_positions(account_id,world_id,x,y,z,write_epoch,write_sequence)
         VALUES($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT(account_id,world_id) DO UPDATE SET
           x=EXCLUDED.x,y=EXCLUDED.y,z=EXCLUDED.z,write_epoch=EXCLUDED.write_epoch,
           write_sequence=EXCLUDED.write_sequence,updated_at=now()
         WHERE player_positions.write_epoch IS DISTINCT FROM EXCLUDED.write_epoch
           OR player_positions.write_sequence < EXCLUDED.write_sequence`,
        [
          snapshot.accountId,
          snapshot.worldId,
          position.x,
          position.y,
          position.z,
          snapshot.writeEpoch,
          snapshot.writeSequence,
        ],
      );
      return result.rowCount ? 'saved' : 'superseded';
    });
  }

  /** Cancels pending checkouts and destroys active transactions rather than returning them open. */
  abort() {
    this.aborted = true;
    for (const cancel of this.acquisitions) cancel();
    this.acquisitions.clear();
    for (const [client, lease] of this.leases) {
      lease.destroyed = true;
      client.release(true);
    }
    this.leases.clear();
  }
}
