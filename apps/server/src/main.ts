import { createGameServer } from './index.js';

const port = Number(process.env.PORT ?? 2567);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('PORT must be an integer between 1 and 65535');
// Игра по умолчанию запускает городской участок; SU_WORLD=physics-lab — тестовую площадку.
const world = process.env.SU_WORLD ?? 'ring-block';
if (!/^[a-z0-9-]{1,64}$/.test(world)) throw new Error('SU_WORLD must be a world ID');
const app = await createGameServer({
  port,
  host: process.env.HOST ?? '127.0.0.1',
  worldDirectory: `dist/worlds/${world}`,
});
console.log(`Syktyvkar Underground — ${app.url} (${world})`);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await app.close();
}
process.once('SIGINT', () => {
  void stop();
});
process.once('SIGTERM', () => {
  void stop();
});
