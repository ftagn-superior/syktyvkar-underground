import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
const output = process.env.SU_STREAMING_OUTPUT ?? 'output/large-map/l5/matrix';
await mkdir(output, { recursive: true });
const results: unknown[] = [];
for (const clients of [2, 4, 8])
  for (const scenario of ['spread', 'crowd']) {
    const started = performance.now();
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', 'tests/streaming-load.ts'], {
        stdio: 'inherit',
        env: {
          ...process.env,
          SU_STREAMING_CLIENTS: String(clients),
          SU_STREAMING_SCENARIO: scenario,
          SU_STREAMING_OUTPUT: `${output}/${scenario}-${clients}`,
        },
      });
      child.once('error', reject);
      child.once('exit', resolve);
    });
    results.push({ clients, scenario, code, seconds: (performance.now() - started) / 1000 });
    await writeFile(
      output + '/suite.json',
      JSON.stringify(
        { date: new Date().toISOString(), result: code === 0 ? 'running' : 'failed', results },
        null,
        2,
      ) + '\n',
    );
    if (code !== 0) throw new Error(`Streaming matrix ${scenario}/${clients} failed (${code})`);
  }
await writeFile(
  output + '/suite.json',
  JSON.stringify({ date: new Date().toISOString(), result: 'passed', results }, null, 2) + '\n',
);
