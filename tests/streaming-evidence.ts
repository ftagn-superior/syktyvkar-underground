import { PROTOCOL_VERSION, WORLD_FORMAT_VERSION } from '../packages/contracts/src/index.js';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const base = 'output/large-map/l5';
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const evidence: { path: string; sha256: string; date?: string }[] = [];
async function read(path: string) {
  const bytes = await readFile(path);
  const data = JSON.parse(bytes.toString());
  assert.equal(
    typeof data.result === 'object' ? data.result.status : (data.result ?? data.status),
    'passed',
    path,
  );
  for (const [source, expected] of Object.entries(data.sourceHashes ?? {}))
    assert.equal(digest(await readFile(source)), expected, `Stale evidence: ${path}: ${source}`);
  evidence.push({ path, sha256: digest(bytes), date: data.date });
  return data;
}
const browser = await read(base + '/browser-suite.json');
assert.equal(browser.results.length, 4);
assert.ok(browser.results.every((row: any) => row.code === 0));
for (const stage of ['l2', 'l3', 'l4']) await read(base + '/' + stage + '/browser.json');
await read(base + '/failures/result.json');
const regression = await read(base + '/regression/suite.json');
assert.equal(regression.results.length, 20);
assert.ok(regression.results.every((row: any) => row.code === 0 && !row.timedOut));
const artifact = await read(base + '/artifact/artifact.json');
await read(base + '/regression/supplementary.json');
const legacy = JSON.parse(await readFile('output/playwright/network/netem-results.json', 'utf8'));
assert.ok(
  legacy.profiles.length === 1 &&
    legacy.profiles[0].result === 'passed' &&
    legacy.profiles[0].profile.rttMs === 200,
);
assert.ok(
  Number(
    /dropped (\d+)/.exec(
      await readFile('output/playwright/network/netem-counters.txt', 'utf8'),
    )?.[1],
  ) > 0,
);
assert.equal(artifact.worlds.length, 3);
assert.ok(artifact.worlds.every((world: any) => world.protocolVersion === PROTOCOL_VERSION));
const matrix = await read(base + '/matrix/suite.json');
assert.equal(matrix.results.length, 6);
const profiles: any[] = [];
for (const clients of [2, 4, 8])
  for (const scenario of ['spread', 'crowd']) {
    const profile = await read(`${base}/matrix/${scenario}-${clients}/result.json`);
    assert.equal(profile.clients, clients);
    assert.equal(profile.scenario, scenario);
    assert.ok(profile.measuredSeconds >= 60 && profile.warmupSeconds >= 60);
    profiles.push(profile);
  }
const netem = await read(base + '/netem/result.json');
assert.ok(netem.network.packetLoss && netem.clients === 8 && netem.measuredSeconds >= 60);
assert.equal(
  netem.network.forwardedBytes,
  0,
  'Kernel impairment must use a direct connection, not two impaired TCP legs',
);
const counters = await readFile(base + '/netem/netem-counters.txt', 'utf8');
assert.ok(Number(/dropped (\d+)/.exec(counters)?.[1]) > 0);
await read(base + '/soak/suite.json');
const soaks = [];
for (const scenario of ['spread', 'crowd']) {
  const profile = await read(`${base}/soak/${scenario}/result.json`);
  assert.equal(profile.scenario, scenario);
  assert.ok(profile.soak && profile.measuredSeconds >= 1800 && profile.warmupSeconds >= 60);
  assert.equal(profile.sdkClients, 6);
  assert.equal(profile.browserClients, 2);
  assert.ok(profile.memoryWindows.length >= 6);
  soaks.push(profile);
}
const unitLog = await readFile(base + '/unit.log', 'utf8');
assert.match(await readFile(base + '/check.log', 'utf8'), /Package boundaries OK\./);
assert.match(
  await readFile(base + '/build.log', 'utf8'),
  /Built client, server and versioned world/,
);
assert.match(
  await readFile(base + '/format.log', 'utf8'),
  /All matched files use Prettier code style/,
);
execFileSync('git', ['diff', '--check']);
execFileSync('bash', ['-n', 'tests/browser-network-netem.sh', 'tests/streaming-netem.sh']);
const unitTests = Number(/Tests\s+(\d+) passed/.exec(unitLog)?.[1]);
assert.ok(unitTests >= 281 && !/Tests\s+\d+ failed/.test(unitLog));
assert.ok(!/\d+ skipped/.test(unitLog), 'Persistent-world evidence must include database tests');
const all = [...profiles, ...soaks];
for (const profile of [...all, netem]) {
  if (profile.clients > 2)
    assert.ok(
      profile.environment.sdkProcessId &&
        profile.environment.sdkProcessId !== profile.environment.serverProcessId,
      'SDK generator shares the server/diagnostic event loop',
    );
  for (const peer of profile.browsers) {
    assert.equal(
      peer.diagnostics.environment.visibility,
      'visible',
      'A measured browser was hidden',
    );
    assert.equal(
      peer.diagnostics.environment.graphics,
      'ready',
      'A measured browser lost graphics',
    );
    assert.ok(peer.diagnostics.metrics.frameSampleCount > 0, 'No frames after warmup');
  }
}
const eight = all.filter((profile) => profile.clients === 8);
const maxStateKiBPerSecond = Math.max(
  ...eight.flatMap((profile) =>
    [...profile.browsers, ...(profile.sdkMeasuredRates ?? [])].map(
      (peer: any) => peer.stateKiBPerSecond,
    ),
  ),
);
assert.ok(maxStateKiBPerSecond <= 30, 'State bandwidth budget exceeded');
const report = {
  date: new Date().toISOString(),
  stage: 'L5 / LM-12–14',
  result: 'passed',
  functionalCriteria: [
    'LM-AC01',
    'LM-AC02',
    'LM-AC03',
    'LM-AC04',
    'LM-AC05',
    'LM-AC06',
    'LM-AC07',
    'LM-AC08',
    'LM-AC10',
  ],
  unitTests,
  staticChecks: {
    build: 'passed',
    typesAndBoundaries: 'passed',
    format: 'passed',
    diffWhitespace: 'passed',
    shellSyntax: 'passed',
  },
  protocolVersion: PROTOCOL_VERSION,
  worldFormatVersion: WORLD_FORMAT_VERSION,
  lockHash: digest(await readFile('pnpm-lock.yaml')),
  sourceHashesVerified: true,
  runtimeHelpers: {
    'tests/helpers/tcp-delay.ts': digest(await readFile('tests/helpers/tcp-delay.ts')),
  },
  evidence,
  loadMatrix: profiles.map((profile) => ({
    scenario: profile.scenario,
    clients: profile.clients,
    measuredSeconds: profile.measuredSeconds,
    browserCells: profile.browsers.map((peer: any) => peer.cells.length),
    sdkInputHz: profile.sdkMeasuredRates?.map((peer: any) => peer.inputHz),
  })),
  network: {
    profile: 'kernel RTT200 jitter20 loss1%',
    result: 'passed',
    packetCounters: base + '/netem/netem-counters.txt',
  },
  soaks: soaks.map((profile) => ({
    scenario: profile.scenario,
    measuredSeconds: profile.measuredSeconds,
    browserRoutes: profile.browsers.map((peer: any) => peer.completedRoutes),
    browserResourceRecurrences: profile.browsers.map((peer: any) => peer.resourceRecurrences),
    memoryWindows: profile.memoryWindows,
  })),
  observed: {
    maxStateKiBPerSecond,
    maxColdHttpBytes: Math.max(
      ...all.flatMap((profile) => profile.coldHttp.map((cold: any) => cold.bytes)),
    ),
    serverCycleP95Ms: Math.max(
      ...all.map((profile) => profile.samples.at(-1).server.cpu.cycle.p95Ms),
    ),
    serverCycleP99Ms: Math.max(
      ...all.map((profile) => profile.samples.at(-1).server.cpu.cycle.p99Ms),
    ),
    spreadCorrectionP95: Math.max(
      ...all
        .filter((profile) => profile.scenario === 'spread')
        .flatMap((profile) => profile.browsers.map((peer: any) => peer.corrections.p95)),
    ),
    crowdCorrectionP95: Math.max(
      ...all
        .filter((profile) => profile.scenario === 'crowd')
        .flatMap((profile) => profile.browsers.map((peer: any) => peer.corrections.p95)),
    ),
  },
  hardwareAcceptance: false,
  remaining: [
    'User acceptance: target GPU 1920x1080 and server 2vCPU/4GB budgets',
    'User acceptance: integrated city visuals and content profiles',
  ],
  note: 'Software rendering and a shared host/process verify functionality, cleanup and sustained operation. They do not certify target hardware or separately measured native Havok memory.',
};
const observedBudgetChecks = {
  stateBandwidth: report.observed.maxStateKiBPerSecond <= 30,
  coldHttp: report.observed.maxColdHttpBytes <= 8 * 1024 * 1024,
  spreadCorrections: report.observed.spreadCorrectionP95 <= 0.2,
  crowdCorrections: report.observed.crowdCorrectionP95 <= 0.5,
  currentServerCycleP95: report.observed.serverCycleP95Ms <= 8,
  currentServerCycleP99: report.observed.serverCycleP99Ms < 16.7,
  targetHardware: 'pending GPU and 2vCPU/4GB measurements',
};
assert.ok(
  observedBudgetChecks.coldHttp &&
    observedBudgetChecks.spreadCorrections &&
    observedBudgetChecks.crowdCorrections,
  'HTTP or correction budget exceeded',
);
await writeFile(
  base + '/verification.json',
  JSON.stringify({ ...report, observedBudgetChecks }, null, 2) + '\n',
);
console.log(
  JSON.stringify(
    {
      ...report,
      observedBudgetChecks,
      evidence: `${evidence.length} verified JSON artifacts`,
      soaks: report.soaks.map(({ memoryWindows, ...summary }) => ({
        ...summary,
        memoryWindows: memoryWindows.length,
      })),
    },
    null,
    2,
  ),
);
