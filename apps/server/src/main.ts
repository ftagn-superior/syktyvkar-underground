import { createGameServer } from './index.js';
import { loadEnvironment, readAccountConfig, readDatabaseUrl } from './config.js';
import { AccountStore } from './accounts/store.js';
import { createDatabasePool } from './database.js';

loadEnvironment();
const config = readAccountConfig();
const pool = createDatabasePool(readDatabaseUrl());
const port = Number(process.env.PORT ?? 2567);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('PORT must be an integer between 1 and 65535');
// Игра по умолчанию запускает городской участок; SU_WORLD=physics-lab — тестовую площадку.
const world = process.env.SU_WORLD ?? 'ring-block';
if (!/^[a-z0-9-]{1,64}$/.test(world)) throw new Error('SU_WORLD must be a world ID');
let app: Awaited<ReturnType<typeof createGameServer>>;
try {
  app = await createGameServer({
    port,
    pool,
    host: process.env.HOST ?? '127.0.0.1',
    worldDirectory: `dist/worlds/${world}`,
    ...(config && pool ? { accounts: { config, store: new AccountStore(pool) } } : {}),
  });
} catch {
  await pool?.end();
  console.error('Server startup failed. Check configuration, database migrations and world build.');
  process.exit(1);
}
console.log(`Syktyvkar Underground — ${app.url} (${world})`);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(maintenance);
  try {
    await app.close();
  } catch {
    console.error('Server stopped without a complete final world save.');
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
const maintenance = setInterval(
  () => {
    if (pool)
      void new AccountStore(pool)
        .pruneExpiredSessions()
        .catch(() => console.error('Session cleanup is temporarily unavailable.'));
  },
  60 * 60 * 1000,
);
maintenance.unref();
process.once('SIGINT', () => {
  void stop();
});
process.once('SIGTERM', () => {
  void stop();
});
