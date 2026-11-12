import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const makefile = fileURLToPath(new URL('../Makefile', import.meta.url));
const steps = ['build', 'db:migrate:built', 'world:migrate:built', 'start'];
const hasMake = spawnSync('make', ['--version']).status === 0;

describe.skipIf(!hasMake)('make run startup preparation', () => {
  let directory: string;
  let runner: string;
  let log: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'su-make-run-'));
    runner = join(directory, 'pnpm.mjs');
    log = join(directory, 'steps.log');
    await writeFile(
      runner,
      `import { appendFileSync } from 'node:fs';
const step = process.argv[2];
appendFileSync(process.env.SU_MAKE_RUN_LOG, step + '\\n');
if (step === process.env.SU_MAKE_RUN_FAIL) process.exit(42);
`,
    );
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  function run(target: 'run' | 'default', fail = '') {
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    return spawnSync(
      'make',
      [
        '--no-print-directory',
        '-j4',
        '-f',
        makefile,
        `PNPM=${quote(process.execPath)} ${quote(runner)}`,
        ...(target === 'run' ? ['run'] : []),
      ],
      {
        cwd: directory,
        encoding: 'utf8',
        env: {
          ...process.env,
          MAKEFLAGS: '',
          MFLAGS: '',
          SU_MAKE_RUN_LOG: log,
          SU_MAKE_RUN_FAIL: fail,
        },
      },
    );
  }
  async function executed() {
    return (await readFile(log, 'utf8')).trim().split('\n');
  }

  it.each(['run', 'default'] as const)(
    'prepares the schema and world before starting (%s)',
    async (target) => {
      const result = run(target);
      expect(result.status, result.stderr).toBe(0);
      expect(await executed()).toEqual(steps);
    },
  );

  it.each(steps.slice(0, -1))('does not start the server when %s fails', async (step) => {
    const result = run('run', step);
    expect(result.status).not.toBe(0);
    expect(await executed()).toEqual(steps.slice(0, steps.indexOf(step) + 1));
  });
});
