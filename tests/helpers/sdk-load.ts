import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { startLoad, LoadOptions } from '../../tools/load-test/src/runner.js';
type ActiveLoad = Awaited<ReturnType<typeof startLoad>>;

/** Browser diagnostics must not share the 60 Hz sender's event loop. */
export async function startSdkLoad(options: LoadOptions) {
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      fileURLToPath(new URL('../../tools/load-test/src/worker.ts', import.meta.url)),
      JSON.stringify(options),
    ],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
  );
  // Paths from tests/helpers need to reach the repository root.
  let sequence = 0;
  let stopped = false;
  const pending = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const logs: string[] = [];
  child.stdout!.on('data', (bytes) => {
    if (logs.length < 20) logs.push(String(bytes));
  });
  child.stderr!.on('data', (bytes) => {
    if (logs.length < 20) logs.push(String(bytes));
  });
  let readyResolve!: () => void, readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const startup = setTimeout(() => readyReject(new Error('SDK worker startup timed out')), 25000);
  const rejectAll = (error: Error) => {
    readyReject(error);
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    pending.clear();
  };
  child.on('error', rejectAll);
  child.on('exit', (code) => {
    clearTimeout(startup);
    if (!stopped) rejectAll(new Error(`SDK worker exited ${code}: ${logs.join('').slice(-3000)}`));
  });
  child.on('message', (message: any) => {
    if (message.ready) {
      clearTimeout(startup);
      readyResolve();
      return;
    }
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    clearTimeout(item.timer);
    if (message.error) item.reject(new Error(message.error));
    else item.resolve(message.value);
  });
  async function request<T>(method: 'sample' | 'report' | 'stop'): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`SDK worker ${method} timed out`));
      }, 15000);
      pending.set(id, { resolve, reject, timer });
      child.send({ id, method }, (error) => {
        if (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        }
      });
    });
  }
  try {
    await ready;
  } catch (error) {
    child.kill('SIGKILL');
    throw error;
  }
  return {
    pid: child.pid!,
    sample: () => request<Awaited<ReturnType<ActiveLoad['sample']>>>('sample'),
    report: () => request<ReturnType<ActiveLoad['report']>>('report'),
    async stop() {
      if (stopped) return;
      stopped = true;
      try {
        if (child.connected) await request('stop');
      } catch {
        child.kill('SIGTERM');
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
          await new Promise<void>((resolve) =>
            child.once('exit', () => {
              clearTimeout(timer);
              resolve();
            }),
          );
        }
      }
    },
  };
}
