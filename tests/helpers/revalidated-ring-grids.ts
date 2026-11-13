import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateWorldLayoutSnapshot } from '../../packages/contracts/src/index.js';
import { hash } from '../../packages/world-release/src/index.js';
import {
  readRingTerrainCandidate,
  RING_TERRAIN_CANDIDATE_DIRECTORY as directory,
} from '../../tools/world-build/src/ring-terrain-candidate.js';
import { readRevalidatedRingTerrainInputs } from '../../tools/world-build/src/ring-terrain-revalidation.js';
import type { readFullRingTerrainInputs } from '../../tools/world-build/src/ring-full-terrain.js';
import type { readRingTerrainPadInputs } from '../../tools/world-build/src/ring-pads.js';

// Historical readers deliberately keep their original source hashes. Tests of
// the same grids after a visual refresh use independently revalidated contacts,
// while retaining every original grid/config/export pin.
async function pinned(file: string, expected: string) {
  const bytes = await readFile(file);
  assert.equal(hash(bytes), expected, `Historical grid input changed: ${file}`);
  return JSON.parse(bytes.toString());
}

export async function readRevalidatedPadFixture(): Promise<
  Awaited<ReturnType<typeof readRingTerrainPadInputs>>
> {
  const config = JSON.parse(await readFile(`${directory}/ring-pads.json`, 'utf8'));
  assert.equal(config.sourceGrid, 'pilot-grid-4m.json');
  await pinned(`${directory}/${config.sourceGrid}`, config.sourceGridSha256);
  await pinned(`${directory}/model-supports.json`, config.supportRulesSha256);
  const { catalog } = await readRevalidatedRingTerrainInputs();
  return { base: await readRingTerrainCandidate('pilot'), rules: catalog.rules, config };
}

export async function readRevalidatedFullGridFixture(): Promise<
  Awaited<ReturnType<typeof readFullRingTerrainInputs>>
> {
  const config = JSON.parse(await readFile(`${directory}/full-terrain-pads.json`, 'utf8'));
  assert.equal(config.sourceGrid, 'full-grid-4m.json');
  const [, snapshot, inheritedBuildings, inheritedPublic] = await Promise.all([
    pinned(`${directory}/${config.sourceGrid}`, config.sourceGridSha256),
    pinned('data/map-layout.json', config.sourceExportSha256),
    pinned(`${directory}/${config.buildingPads.file}`, config.buildingPads.sha256),
    pinned(`${directory}/${config.publicPads.file}`, config.publicPads.sha256),
  ]);
  validateWorldLayoutSnapshot(snapshot);
  const { catalog, kits, anchors } = await readRevalidatedRingTerrainInputs();
  return {
    base: await readRingTerrainCandidate('full'),
    snapshot,
    inheritedBuildings,
    inheritedPublic,
    config,
    catalog,
    kits,
    anchors,
  };
}
