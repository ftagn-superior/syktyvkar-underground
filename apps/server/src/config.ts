import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';

export interface AccountConfig {
  publicOrigin: string;
  clientId: string;
  clientSecret: string;
  databaseUrl: string;
}

export function loadEnvironment(): void {
  if (existsSync('.env')) loadEnvFile('.env');
}

export function readAccountConfig(env = process.env): AccountConfig | undefined {
  const keys = ['PUBLIC_ORIGIN', 'CLIENT_ID', 'CLIENT_SECRET', 'DATABASE_URL'] as const;
  if (keys.every((key) => !env[key])) return;
  const missing = keys.filter((key) => !env[key]);
  if (missing.length) throw new Error(`Account configuration is incomplete: ${missing.join(', ')}`);
  let origin: URL;
  try {
    origin = new URL(env.PUBLIC_ORIGIN!);
  } catch {
    throw new Error('PUBLIC_ORIGIN must be a valid origin URL.');
  }
  if (
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== '/' ||
    (origin.protocol !== 'https:' &&
      !(origin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(origin.hostname)))
  )
    throw new Error('PUBLIC_ORIGIN must be an HTTPS origin (HTTP is allowed for localhost).');
  let database: URL;
  try {
    database = new URL(env.DATABASE_URL!);
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL connection URL.');
  }
  if (!['postgres:', 'postgresql:'].includes(database.protocol))
    throw new Error('DATABASE_URL must be a PostgreSQL connection URL.');
  return {
    publicOrigin: origin.origin,
    clientId: env.CLIENT_ID!,
    clientSecret: env.CLIENT_SECRET!,
    databaseUrl: env.DATABASE_URL!,
  };
}
