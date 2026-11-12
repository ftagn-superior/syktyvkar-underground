import { createGameServer } from './game-server.js';

if (!process.env.SU_TEST_DATABASE_URL)
  throw new Error(
    'SU_TEST_DATABASE_URL is required; the test server only uses disposable schemas.',
  );
const app = await createGameServer({
  port: Number(process.env.SU_TEST_SERVER_PORT ?? 2573),
  worldDirectory: `dist/worlds/${process.env.SU_WORLD ?? 'physics-lab'}`,
});
console.log(`Test world: ${app.url}`);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
