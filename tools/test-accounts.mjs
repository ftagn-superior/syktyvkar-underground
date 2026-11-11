import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { spawn } from 'node:child_process';

if (existsSync('.env')) loadEnvFile('.env');
const databaseUrl = process.env.SU_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl)
  throw new Error(
    'Set DATABASE_URL or SU_TEST_DATABASE_URL to run isolated PostgreSQL account tests.',
  );
const child = spawn(
  process.execPath,
  process.argv.includes('--browser')
    ? ['--import', 'tsx', 'tests/browser-accounts.ts']
    : ['node_modules/vitest/vitest.mjs', 'run', 'tests/integration/accounts.test.ts'],
  { stdio: 'inherit', env: { ...process.env, SU_TEST_DATABASE_URL: databaseUrl } },
);
child.on('error', () => {
  console.error('Could not start account tests.');
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
