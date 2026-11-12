import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { spawn } from 'node:child_process';

if (existsSync('.env')) loadEnvFile('.env');
const databaseUrl = process.env.SU_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl)
  throw new Error(
    'Set DATABASE_URL or SU_TEST_DATABASE_URL to run isolated PostgreSQL integration tests.',
  );
const items = process.argv.includes('--items');
const avatars = process.argv.includes('--avatars');
const giveme = process.argv.includes('--giveme');
const child = spawn(
  process.execPath,
  process.argv.includes('--browser')
    ? [
        '--import',
        'tsx',
        avatars
          ? 'tests/browser-avatars.ts'
          : giveme
            ? 'tests/browser-giveme.ts'
            : items
              ? 'tests/browser-items.ts'
              : 'tests/browser-accounts.ts',
      ]
    : [
        'node_modules/vitest/vitest.mjs',
        'run',
        ...(items
          ? [
              'tests/integration/items.test.ts',
              'tests/integration/items-network.test.ts',
              'tests/integration/giveme.test.ts',
              'tests/integration/world-migration.test.ts',
              'packages/simulation/src/items.test.ts',
            ]
          : ['tests/integration/accounts.test.ts']),
      ],
  { stdio: 'inherit', env: { ...process.env, SU_TEST_DATABASE_URL: databaseUrl } },
);
child.on('error', () => {
  console.error('Could not start database tests.');
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
