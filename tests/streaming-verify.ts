import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { runCheck } from './helpers/run-check.js';
const output = 'output/large-map/l5';
await mkdir(output, { recursive: true });
const selected = new Set(
  (process.env.SU_STREAMING_CHECKS ?? 'unit,browser,regression,matrix,netem,supplementary').split(
    ',',
  ),
);
const checks = [
  { name: 'unit', command: 'pnpm', args: ['test'], timeout: 5 * 60_000 },
  {
    name: 'browser',
    command: process.execPath,
    args: ['--import', 'tsx', 'tests/streaming-browser.ts'],
    timeout: 20 * 60_000,
  },
  {
    name: 'regression',
    command: process.execPath,
    args: ['--import', 'tsx', 'tests/streaming-regression.ts'],
    timeout: 30 * 60_000,
  },
  {
    name: 'matrix',
    command: process.execPath,
    args: ['--import', 'tsx', 'tests/streaming-matrix.ts'],
    timeout: 30 * 60_000,
  },
  { name: 'netem', command: 'bash', args: ['tests/streaming-netem.sh'], timeout: 10 * 60_000 },
  {
    name: 'soak',
    command: process.execPath,
    args: ['--import', 'tsx', 'tests/streaming-soak.ts'],
    timeout: 70 * 60_000,
  },
  {
    name: 'supplementary',
    command: process.execPath,
    args: ['--import', 'tsx', 'tests/streaming-supplementary.ts'],
    timeout: 15 * 60_000,
  },
];
for (const name of selected)
  if (!checks.some((check) => check.name === name)) throw new Error(`Unknown check ${name}`);
const results: unknown[] = [];
let result = 'running';
try {
  for (const check of checks)
    if (selected.has(check.name)) {
      results.push(
        await runCheck(
          check.name,
          check.command,
          check.args,
          `${output}/${check.name}.log`,
          {},
          check.timeout,
        ),
      );
      await writeFile(
        `${output}/automation.json`,
        JSON.stringify(
          { date: new Date().toISOString(), result, selected: [...selected], results },
          null,
          2,
        ) + '\n',
      );
    }
  result = 'passed';
} catch (error) {
  result = 'failed';
  throw error;
} finally {
  await writeFile(
    `${output}/automation.json`,
    JSON.stringify(
      {
        date: new Date().toISOString(),
        result,
        selected: [...selected],
        results,
        lockHash: createHash('sha256')
          .update(await readFile('pnpm-lock.yaml'))
          .digest('hex'),
        hardwareAcceptance: false,
      },
      null,
      2,
    ) + '\n',
  );
}
