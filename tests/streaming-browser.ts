import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
const output = 'output/large-map/l5';
await mkdir(output, { recursive: true });
const checks = [
  {
    name: 'cells-and-resources',
    file: 'tests/large-map-l2.ts',
    env: { SU_L2_OUTPUT: output + '/l2' },
  },
  {
    name: 'movement-and-preparation',
    file: 'tests/large-map-l3.ts',
    env: { SU_L3_OUTPUT: output + '/l3' },
  },
  {
    name: 'interest-and-reentry',
    file: 'tests/large-map-l4.ts',
    env: { SU_L4_OUTPUT: output + '/l4' },
  },
  {
    name: 'failures-and-cleanup',
    file: 'tests/streaming-failures.ts',
    env: { SU_STREAMING_OUTPUT: output + '/failures' },
  },
];
const results: unknown[] = [];
for (const check of checks) {
  console.log(`Streaming browser: ${check.name}`);
  const started = performance.now();
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', check.file], {
      stdio: 'inherit',
      env: { ...process.env, ...check.env },
    });
    child.once('error', reject);
    child.once('exit', resolve);
  });
  results.push({ name: check.name, code, seconds: (performance.now() - started) / 1000 });
  await writeFile(
    output + '/browser-suite.json',
    JSON.stringify(
      { date: new Date().toISOString(), result: code === 0 ? 'running' : 'failed', results },
      null,
      2,
    ) + '\n',
  );
  if (code !== 0) throw new Error(`Streaming browser check ${check.name} failed (${code})`);
}
await writeFile(
  output + '/browser-suite.json',
  JSON.stringify({ date: new Date().toISOString(), result: 'passed', results }, null, 2) + '\n',
);
