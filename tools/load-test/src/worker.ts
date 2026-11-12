import { startLoad, type LoadOptions } from './runner.js';

if (!process.send) throw new Error('Load worker requires an IPC parent');
const options = JSON.parse(process.argv[2]) as LoadOptions;
const load = await startLoad(options);
let stopping = false;
const send = (message: unknown) => {
  if (process.connected) process.send!(message);
};
process.on('message', async (message: { id: number; method: 'sample' | 'report' | 'stop' }) => {
  try {
    if (message.method === 'stop') {
      stopping = true;
      await load.stop();
      process.send!({ id: message.id, value: null }, undefined, undefined, () => {
        process.disconnect();
        process.exit(0);
      });
      return;
    }
    const value = message.method === 'sample' ? await load.sample() : load.report();
    send({ id: message.id, value });
  } catch (error) {
    send({ id: message.id, error: String(error) });
  }
});
process.on('disconnect', () => {
  if (!stopping) void load.stop().finally(() => process.exit(0));
});
send({ ready: true, pid: process.pid });
