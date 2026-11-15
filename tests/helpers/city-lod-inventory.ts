import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, sep, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  canonicalJson,
  mergeWorldCells,
  validateGraphicsCoverage,
  validateGroupRenderParts,
  inspectGroupGlb,
  worldManifestIdentity,
  type WorldManifest,
  type WorldDefinition,
} from '../../packages/contracts/src/index.js';
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
/** Inventory accepts the frozen v5 baseline and v6 candidate, verifying their original hashes. */
export async function cityLodInventory(directory: string) {
  const root = resolve(directory),
    manifest: WorldManifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
  if (hash(canonicalJson(worldManifestIdentity(manifest))) !== manifest.mapVersion)
    throw new Error('Inventory manifest identity');
  const read = async (path: string) => {
    const file = resolve(root, path);
    if (!file.startsWith(root + sep) || !Object.hasOwn(manifest.files, path))
      throw new Error('Inventory resource path');
    const bytes = await readFile(file);
    if (hash(bytes) !== manifest.files[path]) throw new Error(`Inventory resource hash: ${path}`);
    return bytes;
  };
  const header = JSON.parse(new TextDecoder().decode(await read(manifest.worldFile)));
  const cells = [];
  for (const cell of manifest.cells)
    cells.push(JSON.parse(new TextDecoder().decode(await read(cell.file))));
  const merged = mergeWorldCells(cells);
  let modelBytes = 0,
    geometryBytes = 0,
    triangles = 0;
  const models = new Set<string>();
  for (const asset of Object.values(manifest.assets)) {
    // Verify collision bytes without retaining a second copy of the whole terrain.
    await read(asset.collisionFile);
    await read(asset.partsFile);
    if (!asset.modelFile || models.has(asset.modelFile)) continue;
    models.add(asset.modelFile);
    const bytes = await read(asset.modelFile),
      v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      length = v.getUint32(12, true),
      doc = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + length)));
    modelBytes += bytes.byteLength;
    geometryBytes += doc.bufferViews.reduce(
      (n: number, b: { byteLength: number }) => n + b.byteLength,
      0,
    );
    const indices = new Set<number>();
    for (const mesh of doc.meshes) for (const p of mesh.primitives) indices.add(p.indices);
    for (const index of indices) triangles += doc.accessors[index].count / 3;
  }
  let farBytes = 0;
  const coverage = [];
  if (manifest.graphics) {
    const world = {
      ...header,
      entities: merged.statics,
      buildings: merged.buildings,
      buildingAssets: Object.fromEntries(
        Object.entries(manifest.assets).map(([id, a]) => [
          id,
          { assetId: id, bounds: a.bounds, colliders: [] },
        ]),
      ),
    } as WorldDefinition;
    validateGraphicsCoverage(world, manifest.grid, manifest.graphics.groups);
    for (const g of manifest.graphics.groups) {
      for (const r of g.far.resources) {
        const model = await read(r.modelFile),
          parts = validateGroupRenderParts(
            JSON.parse(new TextDecoder().decode(await read(r.partsFile))),
            g.groupId,
          );
        const stats = inspectGroupGlb(model, parts);
        if (stats.drawUnits > 4) throw new Error('Inventory draw budget');
        farBytes += model.length + (await read(r.partsFile)).length;
      }
      coverage.push({
        groupId: g.groupId,
        ownerCellId: g.ownerCellId,
        coverageCellIds: g.coverageCellIds,
        memberIds: g.memberIds,
        bounds: g.bounds,
        ...g.far,
      });
    }
  }
  const { formatVersion: _format, ...headerIdentity } = header;
  return {
    worldId: manifest.worldId,
    mapVersion: manifest.mapVersion,
    simulationConfigHash: manifest.simulationConfigHash,
    formatVersion: manifest.formatVersion,
    headerIdentityHash: hash(canonicalJson(headerIdentity)),
    cellHashes: Object.fromEntries(manifest.cells.map((c) => [c.cellId, manifest.files[c.file]])),
    assetsIdentityHash: hash(
      canonicalJson({
        assets: manifest.assets,
        files: Object.fromEntries(
          Object.values(manifest.assets)
            .flatMap((a) =>
              [a.modelFile, a.partsFile, a.collisionFile].filter((p): p is string => !!p),
            )
            .map((p) => [p, manifest.files[p]]),
        ),
      }),
    ),
    buildings: merged.buildings.length,
    protectedPrimitives: merged.statics.length,
    cells: manifest.cells.length,
    lod0: {
      models: models.size,
      modelBytes,
      geometryBytes,
      triangles,
      treeProfiles: Object.values(manifest.assets).filter((a) => !a.modelFile).length,
    },
    far: manifest.graphics
      ? {
          groups: coverage.length,
          sourceVersion: manifest.graphics.sourceVersion,
          policyVersion: manifest.graphics.policyVersion,
          modelAndPartsBytes: farBytes,
          geometryBytes: manifest.graphics.groups.reduce((n, g) => n + g.far.geometryBytes, 0),
          triangles: manifest.graphics.groups.reduce((n, g) => n + g.far.triangles, 0),
          drawUnits: manifest.graphics.groups.reduce((n, g) => n + g.far.drawUnits, 0),
          maxDrawUnits: Math.max(...manifest.graphics.groups.map((g) => g.far.drawUnits)),
        }
      : null,
    coverage,
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const baseline = await cityLodInventory(
      process.argv[2] ?? 'output/city-lod/baseline/worlds/ring-block',
    ),
    candidate = await cityLodInventory(process.argv[3] ?? 'dist/worlds/ring-block');
  const invariant = {
    simulation: baseline.simulationConfigHash === candidate.simulationConfigHash,
    header: baseline.headerIdentityHash === candidate.headerIdentityHash,
    cells: canonicalJson(baseline.cellHashes) === canonicalJson(candidate.cellHashes),
    lod0: baseline.assetsIdentityHash === candidate.assetsIdentityHash,
  };
  if (Object.values(invariant).some((v) => !v))
    throw new Error('LOD changed physical or detailed authoring inputs');
  const output = resolve(process.argv[4] ?? 'output/city-lod/final/inventory.json');
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify({ invariant, baseline, candidate }, null, 2) + '\n');
  console.log(
    JSON.stringify({ invariant, baseline: baseline.lod0, candidate: candidate.far, output }),
  );
}
