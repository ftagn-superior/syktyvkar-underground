import { describe, expect, it } from 'vitest';
import { readAccountConfig, readDatabaseUrl } from './config.js';

describe('persistent world configuration independent of Telegram', () => {
  it('requires PostgreSQL while allowing all Telegram settings to be absent', () => {
    const env = { DATABASE_URL: 'postgresql://localhost/game' };
    expect(readDatabaseUrl(env)).toBe(env.DATABASE_URL);
    expect(readAccountConfig(env)).toBeUndefined();
    expect(() => readDatabaseUrl({})).toThrow('required');
    expect(() => readDatabaseUrl({ DATABASE_URL: 'https://example.com' })).toThrow('PostgreSQL');
    expect(() => readAccountConfig({ ...env, CLIENT_ID: 'partial' })).toThrow('incomplete');
  });
});
