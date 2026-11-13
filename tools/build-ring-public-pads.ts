/** Explicit small public-space pads, pinned to the inspected saved owners and model rules. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import {
  canonicalJson,
  validateTerrainGrid,
  type WorldLayoutSnapshot,
} from '../packages/contracts/src/index.js';
import { hash } from '../packages/world-release/src/index.js';
import { readRingTerrainPilotWithPads } from './world-build/src/ring-pads.js';
import { componentDistance } from './world-build/src/syktsu-pad.js';
import { readRingKitSupportDecisions } from './world-build/src/ring-kit-authoring.js';
import { smoothstep, ringTerrainGridStatistics } from './world-build/src/ring-terrain-candidate.js';

const directory = 'content/worlds/ring-block/terrain-candidate';
const base = await readRingTerrainPilotWithPads();
const kits = await readRingKitSupportDecisions();
const bytes = await readFile('data/map-layout.json');
assert.equal(hash(bytes), 'f4419053c7b40d2f6262a05a690ede725e4c879938e8806f8b85e918d4bad193');
const snapshot: WorldLayoutSnapshot = JSON.parse(bytes.toString());
const selections = [
  { id: 'ring-monument', owners: ['monument-trudovaya-slava'], level: 1.5, margin: 6, blend: 80 },
  {
    id: 'theatre-public-space',
    owners: ['monument-kuratov', 'theatre-fountain-west'],
    level: 2.25,
    margin: 6,
    blend: 80,
  },
];
const pads = selections.map((selection) => ({
  ...selection,
  placements: selection.owners.map((id) => {
    const owner = snapshot.instances.find((o) => o.entityId === id)!;
    const rule = kits.find((d) => d.assetId === owner.assetId)!.rule;
    return {
      owner,
      ruleSha256: hash(canonicalJson(rule)),
      components: rule.components.map((component) => {
        const yaw = 2 * Math.atan2(owner.rotation.y, owner.rotation.w),
          c = Math.cos(yaw),
          s = Math.sin(yaw);
        const transform = ([x, z]: readonly [number, number]): [number, number] => [
          owner.position.x + x * c + z * s,
          owner.position.z - x * s + z * c,
        ];
        return {
          outline: component.outline.map(transform),
          ...(component.holes ? { holes: component.holes.map((h) => h.map(transform)) } : {}),
        };
      }),
    };
  }),
}));
const heights = base.heights.map((height, index) => {
  const x = base.origin.x + (index % base.columns) * base.spacing,
    z = base.origin.z + Math.floor(index / base.columns) * base.spacing;
  let numerator = height,
    denominator = 1,
    level: number | undefined;
  for (const pad of pads) {
    const distance = Math.min(
      ...pad.placements.flatMap((p) => p.components.map((c) => componentDistance(x, z, c))),
    );
    const weight = 1 - smoothstep((distance - pad.margin) / pad.blend);
    if (weight === 1) {
      assert.ok(level === undefined || level === pad.level, 'Conflicting public pads');
      level = pad.level;
    } else {
      const q = weight / (1 - weight);
      numerator += q * pad.level;
      denominator += q;
    }
  }
  return level ?? numerator / denominator;
});
const grid = validateTerrainGrid({ ...base, heights });
const config = {
  formatVersion: 1,
  status: 'explicit-unapplied-public-space-pads',
  sourceGridSha256: hash(canonicalJson(base)),
  gridSha256: hash(canonicalJson(grid)),
  sourceExportSha256: hash(bytes),
  generatorSha256: hash(await readFile('tools/build-ring-public-pads.ts')),
  rationale:
    'Preserve original rigid monument plinths and fountain bases on level ground; their original stairs and surrounding road remain separate geometry. Keep a 6 m grid margin and a 80 m smooth transition. No source model or XZ/yaw is changed.',
  pads,
  statistics: ringTerrainGridStatistics(grid),
};
for (const [file, value] of [
  ['public-space-pads.json', config],
  ['pilot-grid-ready.json', grid],
] as const) {
  const encoded = JSON.stringify(value, null, 2) + '\n';
  if (process.argv.includes('--check'))
    assert.equal(await readFile(`${directory}/${file}`, 'utf8'), encoded, `Stale ${file}`);
  else await writeFile(`${directory}/${file}`, encoded);
}
console.log(JSON.stringify({ gridSha256: hash(canonicalJson(grid)), ...config.statistics }));
