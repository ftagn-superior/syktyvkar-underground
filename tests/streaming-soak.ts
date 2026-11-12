import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
const output = process.env.SU_STREAMING_OUTPUT ?? 'output/large-map/l5/soak';
await mkdir(output, { recursive: true });
const results: unknown[] = [];
for (const scenario of ['spread', 'crowd']) {
  const started = performance.now();
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'tests/streaming-load.ts'], {
      stdio: 'inherit',
      env: {
        ...process.env,
        SU_STREAMING_SCENARIO: scenario,
        SU_STREAMING_CLIENTS: '8',
        SU_STREAMING_WARMUP: process.env.SU_STREAMING_WARMUP ?? '60',
        SU_STREAMING_SECONDS: process.env.SU_STREAMING_SECONDS ?? '1800',
        SU_STREAMING_OUTPUT: output + '/' + scenario,
      },
    });
    child.once('error', reject);
    child.once('exit', resolve);
  });
  results.push({ scenario, code, seconds: (performance.now() - started) / 1000 });
  await writeFile(
    output + '/suite.json',
    JSON.stringify(
      { date: new Date().toISOString(), result: code === 0 ? 'running' : 'failed', results },
      null,
      2,
    ) + '\n',
  );
  if (code !== 0) throw new Error(`Streaming soak ${scenario} failed (${code})`);
}
await writeFile(
  output + '/suite.json',
  JSON.stringify({ date: new Date().toISOString(), result: 'passed', results }, null, 2) + '\n',
);
