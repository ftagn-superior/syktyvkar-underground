import type { Pool, PoolClient } from 'pg';

/** One advisory-lock session for placement, item persistence and the running world. */
export class WorldOwnership {
  private lease?: PoolClient;
  private failed = false;
  private started = false;
  onConnectionFailure?: () => void;
  constructor(
    readonly pool: Pool,
    readonly worldId: string,
    readonly epoch: string,
  ) {}
  async connect() {
    if (this.lease && !this.failed) {
      try {
        await this.lease.query('SELECT 1');
        return;
      } catch (error) {
        this.failed = true;
        throw error;
      }
    }
    this.lease?.release(true);
    this.lease = undefined;
    const client = await this.pool.connect();
    client.on('error', () => {
      this.failed = true;
      this.onConnectionFailure?.();
    });
    try {
      const result = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended(current_database() || ':' || current_schema() || ':' || $1, 193708)) AS locked",
        [this.worldId],
      );
      if (!result.rows[0].locked) throw new Error('Persistent world already has an owner');
      const current = await client.query<{ epoch: string }>(
        'SELECT epoch FROM persistent_worlds WHERE id=$1',
        [this.worldId],
      );
      if (current.rowCount && current.rows[0].epoch !== this.epoch && this.started)
        throw new Error('World ownership epoch changed; restart required');
      this.lease = client;
      this.failed = false;
    } catch (error) {
      client.release(true);
      throw error;
    }
  }
  get db(): PoolClient {
    if (!this.lease || this.failed) throw new Error('World database connection unavailable');
    return this.lease;
  }
  markStarted() {
    this.started = true;
  }
  async close() {
    const client = this.lease;
    this.lease = undefined;
    if (!client) return;
    try {
      if (!this.failed)
        await client.query(
          "SELECT pg_advisory_unlock(hashtextextended(current_database() || ':' || current_schema() || ':' || $1, 193708))",
          [this.worldId],
        );
    } finally {
      client.release(true);
    }
  }
}
