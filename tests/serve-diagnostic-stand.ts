/**
 * Local S-60 test stand: the game server from source against a dedicated test database
 * (DATABASE_URL), with the artifact identity injected as the bundler would and an optional
 * longer spawn preparation limit for slow reference laptops. Never point it at production.
 *   DATABASE_URL=... SU_PREPARE_TIMEOUT_MS=60000 node --import tsx tests/serve-diagnostic-stand.ts
 */
import { buildIdentity } from '../tools/build-identity';

(globalThis as { __SU_BUILD_INFO__?: unknown }).__SU_BUILD_INFO__ = buildIdentity();
const { createGameServer } = await import('../apps/server/src/index.js');
const { createDatabasePool } = await import('../apps/server/src/database.js');
const pool = createDatabasePool(process.env.DATABASE_URL!);
const app = await createGameServer({
  port: Number(process.env.PORT ?? 2599),
  pool,
  worldDirectory: `dist/worlds/${process.env.SU_WORLD ?? 'ring-block'}`,
  prepareTimeoutMs: Number(process.env.SU_PREPARE_TIMEOUT_MS ?? 15_000),
});
console.log(`Diagnostic stand ${app.url}`);
