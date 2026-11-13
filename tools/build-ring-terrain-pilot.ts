/** Offline pilot authoring; defaults preserve the accepted pilot geometry and labels. */
import { buildRingTerrainCandidate } from './world-build/src/ring-terrain-build.js';

const result = await buildRingTerrainCandidate({
  gridFile: process.argv[2] ?? 'content/worlds/ring-block/terrain-candidate/pilot-grid-ready.json',
  output: process.argv[3] ?? 'output/ring-terrain-stage4',
  verifyPilotProvenance: !process.argv[2],
});
console.log(JSON.stringify(result, null, 2));
if (result.status === 'blocked') process.exitCode = 1;
