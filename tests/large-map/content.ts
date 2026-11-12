import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  canonicalJson,
  loadWorldBundle,
  validateWorldCell,
  type WorldCell,
  type WorldDefinition,
} from '../../packages/contracts/src/index.js';
import { buildWorld } from '../../tools/world-build/src/index.js';
import { inspectStaticGlb } from '../../tools/world-build/src/glb.js';
import { SCENE_SEED, CELL_SIZE, DENSE_CELL } from '../../tools/world-build/src/streaming-lab.js';
export {
  SCENE_SEED,
  CELL_SIZE,
  DENSE_CELL,
  generatePlacements,
} from '../../tools/world-build/src/streaming-lab.js';

export const hash = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex');

/** L0 regressions now exercise the same spatial release producer as the application. */
export async function prepareScene(directory: string) {
  const output = join(directory, 'release');
  const manifest = await buildWorld('content/worlds/streaming-lab/world.json', output);
  const readBytes = (path: string) => readFile(join(output, path));
  const definition = await loadWorldBundle(manifest, readBytes);
  const cells = await Promise.all(
    manifest.cells.map(async (entry) =>
      validateWorldCell(JSON.parse(new TextDecoder().decode(await readBytes(entry.file)))),
    ),
  );
  const models: {
    assetId: string;
    triangles: number;
    materials: number;
    colliders: number;
    bytes: number;
    gzipBytes: number;
  }[] = [];
  for (const asset of Object.values(manifest.assets)) {
    const bytes = await readBytes(asset.modelFile);
    const { document } = inspectStaticGlb(bytes, asset.assetId);
    const triangles = document.meshes.reduce(
      (sum: number, mesh: { primitives: { indices: number }[] }) =>
        sum +
        mesh.primitives.reduce(
          (n, primitive) => n + document.accessors[primitive.indices].count / 3,
          0,
        ),
      0,
    );
    models.push({
      assetId: asset.assetId,
      triangles,
      materials: document.materials.length,
      colliders: definition.buildingAssets[asset.assetId].colliders.length,
      bytes: bytes.byteLength,
      gzipBytes: gzipSync(bytes).byteLength,
    });
  }
  const allBytes = await Promise.all(Object.keys(manifest.files).map(readBytes));
  const profile = {
    seed: SCENE_SEED,
    generator: 'tools/world-build/src/streaming-lab.ts',
    cellSize: CELL_SIZE,
    cells: cells.length,
    placements: definition.buildings.length,
    tiles: definition.entities.filter((item) => item.entityId.startsWith('ground-')).length,
    denseCell: DENSE_CELL,
    densePlacements: cells.find((cell) => cell.cellId === DENSE_CELL)!.buildings.length,
    mapVersion: manifest.mapVersion,
    simulationConfigHash: manifest.simulationConfigHash,
    placementHash: hash(canonicalJson(cells)),
    models,
    placedTriangles: definition.buildings.reduce(
      (sum, building) =>
        sum + models.find((model) => model.assetId === building.assetId)!.triangles,
      0,
    ),
    placedColliderChildren: definition.buildings.reduce(
      (sum, building) => sum + definition.buildingAssets[building.assetId].colliders.length,
      0,
    ),
    releaseBytes: allBytes.reduce((sum, bytes) => sum + bytes.byteLength, 0),
    releaseGzipBytes: allBytes.reduce((sum, bytes) => sum + gzipSync(bytes).byteLength, 0),
    routes: definition.routes,
  };
  return { definition, manifest, cells, output, profile };
}

export function localDefinition(definition: WorldDefinition, cell: WorldCell) {
  const [x, z] = cell.cellId.split('_').map(Number);
  const entities = [...cell.statics];
  return {
    ...definition,
    entities,
    buildings: cell.buildings,
    spawnPoints: [
      {
        x: -1000 + x * CELL_SIZE + 4,
        y: 0,
        z: -1000 + z * CELL_SIZE + 4,
      },
    ],
  };
}
