import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { WORLD_RESOURCE_LIMITS, type BuildingInstance } from '@su/contracts';
import { buildWorld } from './index.js';
import { createGroundTerrain } from './ground-terrain.js';

/** Explicit offline candidate; ordinary world:build continues to publish the existing ground. */
export async function buildRingTerrainFlat(spacing: 2 | 4, output: string) {
  const source = 'content/worlds/ring-block/world.json';
  const groundPath = 'content/buildings/ring-block/ring-block-ground/source.json';
  const sourceBytes = await readFile(groundPath);
  const cell = JSON.parse(await readFile('content/worlds/ring-block/cells/0_0.json', 'utf8'));
  const placement = cell.buildings.find((b: BuildingInstance) => b.assetId === 'ring-block-ground');
  if (!placement) throw new Error('Ring source ground is missing');
  const converted = createGroundTerrain(JSON.parse(sourceBytes.toString()), placement, spacing);
  const started = performance.now(),
    cpu = process.cpuUsage();
  const manifest = await buildWorld(source, output, { groundTerrain: { spacing } });
  const buildMs = performance.now() - started,
    usedCpu = process.cpuUsage(cpu);
  const resources: { file: string; bytes: number }[] = [];
  const groundAssets = [];
  for (const [file] of Object.entries(manifest.files)) {
    const bytes = (await readFile(resolve(output, file))).byteLength;
    resources.push({ file, bytes });
  }
  for (const asset of Object.values(manifest.assets).filter((a) =>
    a.assetId.startsWith('ring-block-ground-'),
  )) {
    const model = await readFile(resolve(output, asset.modelFile!));
    const doc = JSON.parse(model.subarray(20, 20 + model.readUInt32LE(12)).toString());
    const physics = JSON.parse(await readFile(resolve(output, asset.collisionFile), 'utf8'));
    groundAssets.push({
      assetId: asset.assetId,
      bounds: asset.bounds,
      modelBytes: model.byteLength,
      collisionBytes: resources.find((r) => r.file === asset.collisionFile)!.bytes,
      meshes: doc.meshes.length,
      graphicTriangles: doc.meshes.reduce(
        (n: number, m: any) =>
          n + m.primitives.reduce((s: number, p: any) => s + doc.accessors[p.indices].count / 3, 0),
        0,
      ),
      collisionTriangles: physics.colliders.reduce(
        (n: number, c: any) => n + c.indices.length / 3,
        0,
      ),
    });
  }
  const largest = (predicate: (path: string) => boolean) =>
    resources.filter((r) => predicate(r.file)).sort((a, b) => b.bytes - a.bytes)[0];
  const report = {
    formatVersion: 1,
    worldId: manifest.worldId,
    variant: 'flat',
    spacing,
    output,
    sourceSha256: createHash('sha256').update(sourceBytes).digest('hex'),
    conversion: converted.conversionDiagnostics,
    grid: { columns: converted.grid.columns, rows: converted.grid.rows, spacing },
    mapVersion: manifest.mapVersion,
    simulationConfigHash: manifest.simulationConfigHash,
    buildMs,
    cpuMs: (usedCpu.user + usedCpu.system) / 1000,
    maxRssBytes: process.resourceUsage().maxRSS * 1024,
    maxRssScope:
      'Process lifetime high-water mark, including conversion, build and post-build resource inspection',
    cells: manifest.cells.length,
    assets: Object.keys(manifest.assets).length,
    publicFiles: resources.length,
    publicBytes: resources.reduce((s, r) => s + r.bytes, 0),
    limits: WORLD_RESOURCE_LIMITS,
    largestModel: largest((p) => p.endsWith('.glb')),
    largestCollision: largest((p) => p.endsWith('/colliders.json')),
    largestCell: largest((p) => p.startsWith('cells/')),
    groundAssets,
  };
  await writeFile(resolve(output, 'build-report.json'), JSON.stringify(report, null, 2) + '\n');
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const spacing = Number(process.argv[2] ?? 4);
  if (spacing !== 2 && spacing !== 4) throw new Error('Usage: pnpm world:ring:flat [2|4] [output]');
  const output = resolve(process.argv[3] ?? `output/ring-terrain-stage2/flat-${spacing}m`);
  const report = await buildRingTerrainFlat(spacing, output);
  console.log(
    JSON.stringify({
      spacing,
      output,
      mapVersion: report.mapVersion,
      buildMs: report.buildMs,
      groundAssets: report.groundAssets.length,
      publicBytes: report.publicBytes,
    }),
  );
}
