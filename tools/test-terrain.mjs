import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { spawn } from 'node:child_process';
if (existsSync('.env')) loadEnvFile('.env');
const databaseUrl = process.env.SU_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl)
  throw new Error('SU_TEST_DATABASE_URL is required for isolated terrain experiments.');
const child = spawn(process.execPath, ['--import', 'tsx', 'tests/terrain-lab-browser.ts'], {
  stdio: 'inherit',
  env: { ...process.env, SU_TEST_DATABASE_URL: databaseUrl },
});
child.on('error', () => {
  console.error('Could not start terrain experiment.');
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
