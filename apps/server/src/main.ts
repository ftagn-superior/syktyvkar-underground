import { createGameServer } from './index.js';

const port = Number(process.env.PORT ?? 2567);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('PORT must be an integer between 1 and 65535');
const app = await createGameServer({ port, host: process.env.HOST ?? '127.0.0.1' });
console.log(`Syktyvkar Underground — ${app.url}`);
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
