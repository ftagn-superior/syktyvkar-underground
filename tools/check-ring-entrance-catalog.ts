/** Validate combined per-owner entrance rules, including all retained straight approaches. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { validateTerrainGrid, type WorldLayoutSnapshot } from '../packages/contracts/src/index.js';
import {
  generateSupportAssets,
  planSupportPlacement,
} from '../packages/terrain-build/src/supports.js';
import { compileGeneratedAsset } from '../packages/terrain-build/src/assets.js';
import {
  readRingEntranceCatalog,
  readRingEntranceSupportOverrides,
} from './world-build/src/ring-entrance-authoring.js';

const snapshot: WorldLayoutSnapshot = JSON.parse(
  await readFile('output/ring-terrain-stage5/intermediate/target-static-snapshot.json', 'utf8'),
);
const catalog = await readRingEntranceCatalog();
const grid = validateTerrainGrid(JSON.parse(await readFile(catalog.terrain.file, 'utf8')));
const rules = await readRingEntranceSupportOverrides(snapshot);
const results = [];
for (const rule of rules) {
  const owner = snapshot.instances.find((o) => o.entityId === rule.ownerId)!;
  const plan = planSupportPlacement(grid, rule, owner);
  assert.ok(
    plan.minimumY <= owner.position.y + 1e-8,
    `Combined entrance rule raises ${owner.entityId}`,
  );
  const generated = generateSupportAssets(grid, rule, owner, {
    foundation: `catalog-${owner.entityId}-foundation`,
    approaches: Object.fromEntries(
      rule.approaches!.map((a) => [a.id, `catalog-${owner.entityId}-${a.id}`]),
    ),
  });
  const compiled = generated.map((g) => compileGeneratedAsset(g.asset.physics.assetId, g.asset));
  results.push({
    entityId: owner.entityId,
    fixedOwnerY: owner.position.y,
    maximumVisibleFoundationMetres: owner.position.y + rule.jointY - plan.terrainMin,
    approaches: rule.approaches!.length,
    assets: compiled.length,
    modelBytes: compiled.reduce((total, c) => total + (c.model?.byteLength ?? 0), 0),
  });
}
await writeFile(
  'output/ring-terrain-stage5/entrance-approaches/combined-catalog-geometry.json',
  JSON.stringify(
    {
      formatVersion: 1,
      status: 'combined-owner-geometry-checked',
      terrainSha256: catalog.terrain.sha256,
      owners: results.length,
      results,
    },
    null,
    2,
  ) + '\n',
);
console.log(
  JSON.stringify({
    owners: results.length,
    approaches: results.reduce((total, r) => total + r.approaches, 0),
    maximumVisibleFoundationMetres: Math.max(
      ...results.map((r) => r.maximumVisibleFoundationMetres),
    ),
  }),
);
