import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import type { AccountView, PlayerProfile, ProfileUpdate } from '@su/contracts';

export const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
export interface Identity {
  issuer: string;
  subject: string;
}
export interface AuthenticatedAccount extends AccountView {
  authSessionId: string;
  expiresAt: number;
}
interface AccountRow {
  account_id: string;
  display_name: string;
  color_id: PlayerProfile['colorId'];
  version: number;
  session_id: string;
  expires_at: Date;
}
const projection = (row: AccountRow): AuthenticatedAccount => ({
  accountId: row.account_id,
  authSessionId: row.session_id,
  expiresAt: row.expires_at.getTime(),
  profile: { displayName: row.display_name, colorId: row.color_id, version: row.version },
});

export class AccountStore {
  constructor(readonly pool: pg.Pool) {}

  async login(
    identity: Identity,
    token: string,
    previousToken?: string,
  ): Promise<{ account: AuthenticatedAccount; previousSessionId?: string }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Serializes first registration of the same verified identity, including the initial profile.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        JSON.stringify([identity.issuer, identity.subject]),
      ]);
      const existing = await client.query<{ account_id: string }>(
        'SELECT account_id FROM account_identities WHERE issuer=$1 AND subject=$2',
        [identity.issuer, identity.subject],
      );
      const accountId = existing.rows[0]?.account_id ?? randomUUID();
      if (!existing.rowCount) {
        await client.query('INSERT INTO accounts(id) VALUES($1)', [accountId]);
        await client.query(
          'INSERT INTO account_identities(issuer,subject,account_id) VALUES($1,$2,$3)',
          [identity.issuer, identity.subject, accountId],
        );
        await client.query(
          "INSERT INTO player_profiles(account_id,display_name,color_id) VALUES($1,'Игрок','mint')",
          [accountId],
        );
      }
      let previousSessionId: string | undefined;
      if (previousToken) {
        const previous = await client.query<{ id: string }>(
          'UPDATE auth_sessions SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL RETURNING id',
          [hashToken(previousToken)],
        );
        previousSessionId = previous.rows[0]?.id;
      }
      const sessionId = randomUUID();
      await client.query(
        'INSERT INTO auth_sessions(id,account_id,token_hash,expires_at) VALUES($1,$2,$3,$4)',
        [sessionId, accountId, hashToken(token), new Date(Date.now() + SESSION_LIFETIME_MS)],
      );
      const result = await client.query<AccountRow>(
        `SELECT p.*,s.id AS session_id,s.expires_at FROM player_profiles p
        JOIN auth_sessions s ON s.account_id=p.account_id WHERE s.id=$1`,
        [sessionId],
      );
      await client.query('COMMIT');
      return { account: projection(result.rows[0]), previousSessionId };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async authenticate(token: string): Promise<AuthenticatedAccount | undefined> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return;
    return this.findSession('s.token_hash', hashToken(token));
  }
  async sessionById(id: string): Promise<AuthenticatedAccount | undefined> {
    return this.findSession('s.id', id);
  }
  private async findSession(column: 's.id' | 's.token_hash', value: string) {
    const result = await this.pool.query<AccountRow>(
      `SELECT p.*,s.id AS session_id,s.expires_at FROM auth_sessions s
      JOIN player_profiles p ON p.account_id=s.account_id
      WHERE ${column}=$1 AND s.revoked_at IS NULL AND s.expires_at>now()`,
      [value],
    );
    return result.rows[0] ? projection(result.rows[0]) : undefined;
  }
  async revokeSession(id: string): Promise<void> {
    await this.pool.query(
      'UPDATE auth_sessions SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL',
      [id],
    );
  }
  async updateProfile(
    accountId: string,
    update: ProfileUpdate,
  ): Promise<PlayerProfile | undefined> {
    const result = await this.pool.query<AccountRow>(
      `UPDATE player_profiles SET display_name=$2,color_id=$3,version=version+1,updated_at=now()
      WHERE account_id=$1 AND version=$4 RETURNING *`,
      [accountId, update.displayName, update.colorId, update.version],
    );
    const row = result.rows[0];
    return row
      ? { displayName: row.display_name, colorId: row.color_id, version: row.version }
      : undefined;
  }
  async pruneExpiredSessions(): Promise<void> {
    await this.pool.query(
      "DELETE FROM auth_sessions WHERE expires_at < now() - interval '1 day' OR revoked_at < now() - interval '1 day'",
    );
  }
}
