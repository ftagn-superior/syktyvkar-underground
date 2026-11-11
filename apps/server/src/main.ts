import { createGameServer } from './index.js';
import { loadEnvironment, readAccountConfig } from './config.js';
import { AccountStore, createAccountPool } from './accounts/store.js';

loadEnvironment();
const config = readAccountConfig();
const pool = config ? createAccountPool(config.databaseUrl) : undefined;
const port = Number(process.env.PORT ?? 2567);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('PORT must be an integer between 1 and 65535');
let app: Awaited<ReturnType<typeof createGameServer>>;
try {
  app = await createGameServer({
    port,
    host: process.env.HOST ?? '127.0.0.1',
    ...(config && pool ? { accounts: { config, store: new AccountStore(pool) } } : {}),
  });
} catch {
  await pool?.end();
  console.error('Server startup failed. Check configuration, database migrations and world build.');
  process.exit(1);
}
console.log(`Syktyvkar Underground — ${app.url}`);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await app.close();
  clearInterval(maintenance);
  await pool?.end();
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
