import { writeFile } from 'node:fs/promises';
import { createGameServer } from './helpers/game-server.js';
import { runCheck } from './helpers/run-check.js';
const output = 'output/large-map/l5/regression';
const kernel = await runCheck(
  'legacy-kernel-netem',
  'bash',
  ['tests/browser-network-netem.sh'],
  output + '/legacy-netem.log',
);
const app = await createGameServer({ port: 0 });
try {
  const render = await runCheck(
    'render-profile',
    process.execPath,
    ['--import', 'tsx', 'tests/browser-render-profile.ts'],
    output + '/render-profile.log',
    { SU_TEST_URL: app.url, SU_PROFILE_OUTPUT: output + '/render-profile.json' },
  );
  await writeFile(
    output + '/supplementary.json',
    JSON.stringify(
      {
        date: new Date().toISOString(),
        result: 'passed',
        legacyKernelNetem: kernel,
        renderProfile: render,
        hardwareAcceptance: false,
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  await app.close();
}
