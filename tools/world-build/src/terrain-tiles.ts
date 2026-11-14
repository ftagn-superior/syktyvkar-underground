import { WORLD_RESOURCE_LIMITS, type TerrainGrid } from '@su/contracts';
import {
  generateTerrainTile,
  type Point2,
  type TerrainBuildContext,
  type TerrainSurface,
} from '@su/terrain-build';
import { compileStaticAsset } from '@su/terrain-build/assets';
import { encodeStaticGlb } from '@su/terrain-build/glb';
import { jsonBytes, type CompiledWorldAsset } from '@su/world-release';
import { mergeParts } from './merge.js';
import { indexTerrainAsset } from './terrain-indexing.js';
export { indexTerrainAsset } from './terrain-indexing.js';

export interface TerrainTileBuildInput {
  assetId: string;
  grid: TerrainGrid;
  surfaces: TerrainSurface[];
  context: TerrainBuildContext;
  /** Axis-aligned publication rectangle, with vertices in perimeter order. */
  boundary: Point2[];
  color: string;
  merge: boolean;
  worldBounds?: { min: { x: number; z: number }; max: { x: number; z: number } };
}
export interface CompiledTerrainTile {
  /** Empty for an unsplit tile; append to both its asset and instance IDs. */
  suffix: string;
  asset: CompiledWorldAsset;
}

function rectangleBounds(boundary: Point2[]) {
  if (boundary.length !== 4 || boundary.some((p) => p.some((n) => !Number.isFinite(n))))
    throw new Error('Terrain tile boundary must be an axis-aligned rectangle');
  const min = [Math.min(...boundary.map((p) => p[0])), Math.min(...boundary.map((p) => p[1]))],
    max = [Math.max(...boundary.map((p) => p[0])), Math.max(...boundary.map((p) => p[1]))];
  if (
    min.some((n, i) => n >= max[i]) ||
    new Set(boundary.map((p) => `${p[0]},${p[1]}`)).size !== 4 ||
    boundary.some((p, i) => {
      const next = boundary[(i + 1) % boundary.length];
      return (
        !p.every((n, axis) => n === min[axis] || n === max[axis]) ||
        (p[0] !== next[0] && p[1] !== next[1])
      );
    })
  )
    throw new Error('Terrain tile boundary must be an axis-aligned rectangle');
  return { min, max };
}

/** Split only oversized resources, retaining publication cells and the same terrain surface. */
export function buildTerrainTiles(input: TerrainTileBuildInput): CompiledTerrainTile[] {
  const { grid, context, surfaces } = input;
  const snapshot = context.grid;
  if (!Number.isFinite(snapshot.spacing) || snapshot.spacing <= 0)
    throw new Error('Terrain tile grid requires positive spacing');
  const result: CompiledTerrainTile[] = [];
  const build = (boundary: Point2[], suffix: string): void => {
    const bounds = rectangleBounds(boundary),
      assetId = input.assetId + suffix;
    let generated = generateTerrainTile(assetId, grid, boundary, surfaces, context, {
      baseColor: input.color,
      worldBounds: input.worldBounds,
    });
    if (input.merge) generated.parts = mergeParts(generated.parts);
    generated = indexTerrainAsset(generated);
    const model = encodeStaticGlb(generated.parts),
      collisionBytes = jsonBytes(generated.physics).byteLength;
    let oversized =
      model.byteLength > WORLD_RESOURCE_LIMITS.modelBytes ||
      collisionBytes > WORLD_RESOURCE_LIMITS.collisionBytes ||
      generated.parts.length > 4096 ||
      generated.physics.colliders.some(
        (c) => c.kind === 'mesh' && (c.vertices.length > 600_000 || c.indices.length > 600_000),
      );
    if (!oversized) {
      try {
        result.push({ suffix, asset: compileStaticAsset(assetId, model, generated.physics) });
        return;
      } catch (error) {
        // The compiler measures final metadata after applying Float32 visual bounds.
        // Propagate topology/color/bounds errors; subdivision must not conceal them.
        if (!(error instanceof Error) || error.message !== `Model metadata byte limit: ${assetId}`)
          throw error;
        oversized = true;
      }
    }
    const spans = bounds.max.map((n, i) => n - bounds.min[i]);
    const candidates = ([0, 1] as const)
      .filter((axis) => spans[axis] >= 2 * snapshot.spacing)
      .sort((a, b) => spans[b] - spans[a] || a - b);
    const axis = candidates[0];
    if (!oversized || axis === undefined)
      throw new Error(
        `Terrain tile cannot fit resource limits at spacing ${snapshot.spacing}: ${assetId} ` +
          `(model ${model.byteLength} B, collision ${collisionBytes} B)`,
      );
    const middle = (bounds.min[axis] + bounds.max[axis]) / 2,
      origin = axis === 0 ? snapshot.origin.x : snapshot.origin.z;
    let split = origin + Math.round((middle - origin) / snapshot.spacing) * snapshot.spacing;
    if (split < bounds.min[axis] + snapshot.spacing || split > bounds.max[axis] - snapshot.spacing)
      split = middle;
    for (const half of [0, 1]) {
      const min = [...bounds.min],
        max = [...bounds.max];
      if (half === 0) max[axis] = split;
      else min[axis] = split;
      build(
        [
          [min[0], min[1]],
          [max[0], min[1]],
          [max[0], max[1]],
          [min[0], max[1]],
        ],
        `${suffix}-${axis === 0 ? 'x' : 'z'}${half}`,
      );
    }
  };
  build(input.boundary, '');
  return result;
}
