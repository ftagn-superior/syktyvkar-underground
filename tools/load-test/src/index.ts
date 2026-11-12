import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { startLoad } from './runner.js';
const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const index = args.indexOf(`--${name}`);
  return index < 0 ? fallback : args[index + 1];
};
const seconds = Number(option('seconds', '60'));
const scenario = option('scenario', 'crowd');
if (!Number.isFinite(seconds) || seconds < 1 || !['spread', 'crowd'].includes(scenario))
  throw new Error('Use --seconds N --scenario spread|crowd');
const load = await startLoad({
  url: option('url', 'http://127.0.0.1:2567'),
  clients: Number(option('clients', '6')),
  scenario: scenario as 'spread' | 'crowd',
});
let stopping = false;
const requestStop = () => {
  stopping = true;
};
process.once('SIGINT', requestStop);
process.once('SIGTERM', requestStop);
try {
  const started = performance.now();
  console.log(
    `Started ${load.rooms.length} SDK clients: ${scenario}, ${seconds}s; browser clients are separate.`,
  );
  while (!stopping && performance.now() - started < seconds * 1000) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await load.sample();
  }
  const report = load.report();
  const path = option('report', '');
  if (path) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(report, null, 2) + '\n');
  }
  console.log(
    JSON.stringify(
      { ...report, samples: `${report.samples.length} samples (full data in --report)` },
      null,
      2,
    ),
  );
  if (report.result !== 'passed') process.exitCode = 1;
} finally {
  await load.stop();
}
