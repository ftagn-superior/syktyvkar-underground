import { mkdir, writeFile } from 'node:fs/promises';
import { createGameServer } from './helpers/game-server.js';
import { runCheck } from './helpers/run-check.js';
const output = 'output/large-map/l5/regression';
await mkdir(output, { recursive: true });
const results: unknown[] = [];
for (const [name, file] of [
  ['physics', 'tests/browser-physics.ts'],
  ['accounts', 'tests/browser-accounts.ts'],
  ['avatars', 'tests/browser-avatars.ts'],
  ['avatar-profile', 'tests/browser-avatar-profile.ts'],
  ['reactions', 'tests/browser-reactions.ts'],
  ['animations', 'tests/browser-animations.ts'],
  ['chat', 'tests/browser-chat.ts'],
  ['items', 'tests/browser-items.ts'],
  ['giveme', 'tests/browser-giveme.ts'],
  ['assets', 'tests/browser-assets.ts'],
  ['buildings', 'tests/browser-buildings.ts'],
  ['restart', 'tests/browser-restart.ts'],
  ['network', 'tests/browser-network.ts'],
]) {
  results.push(
    await runCheck(name, process.execPath, ['--import', 'tsx', file], `${output}/${name}.log`),
  );
}
for (const [name, file] of [
  ['smoke', 'tests/browser-smoke.ts'],
  ['polish', 'tests/browser-polish.ts'],
  ['small-soak', 'tests/browser-soak.ts'],
]) {
  const app = await createGameServer({ port: 0 });
  try {
    results.push(
      await runCheck(name, process.execPath, ['--import', 'tsx', file], `${output}/${name}.log`, {
        SU_TEST_URL: app.url,
        SU_SOAK_SECONDS: '30',
      }),
    );
  } finally {
    await app.close();
  }
}
results.push(
  await runCheck(
    'source-free-artifacts',
    process.execPath,
    ['--import', 'tsx', 'tests/large-map-l1.ts'],
    `${output}/artifact.log`,
    { SU_L1_OUTPUT: 'output/large-map/l5/artifact' },
  ),
);
await writeFile(
  `${output}/suite.json`,
  JSON.stringify({ date: new Date().toISOString(), result: 'passed', results }, null, 2) + '\n',
);
