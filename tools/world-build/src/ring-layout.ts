import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GroundLayer } from './city.js';
import {
  roundaboutApproaches,
  roundaboutCrosswalks,
  roundaboutCurbPatches,
  roundaboutFillets,
  roundaboutIslands,
  roundaboutMarkings,
  roundaboutTracedLines,
  tracedGeometry,
  validateRoundabout,
  type RoundaboutConfig,
} from './roundabout.js';

type LayerStyle = Omit<GroundLayer, 'polygons'>;
export interface RingLayoutRecipe {
  formatVersion: 1;
  traceFile: string;
  smooth: boolean;
  roundabout: Omit<RoundaboutConfig, 'traced'>;
  layers: { road: LayerStyle; islands: LayerStyle; markings: LayerStyle };
}

/** Our manual geometry produces ordinary ground layers, without reading or placing world objects. */
export function generateRingLayers(
  recipe: RingLayoutRecipe,
  trace: Parameters<typeof tracedGeometry>[0],
): GroundLayer[] {
  if (recipe.formatVersion !== 1 || typeof recipe.smooth !== 'boolean')
    throw new Error('Invalid ring layout recipe');
  const config = recipe.roundabout;
  if (!config || 'trace' in config || 'traced' in config)
    throw new Error('Ring layout uses a separate traceFile');
  validateRoundabout(config);
  const styles = [recipe.layers.road, recipe.layers.islands, recipe.layers.markings];
  const ids = new Set<string>();
  for (const style of styles) {
    if (
      !/^[a-z0-9-]{1,40}$/.test(style.id) ||
      ids.has(style.id) ||
      !/^#[a-f0-9]{6}$/i.test(style.color) ||
      !(style.elevation > 0 && style.elevation < 0.05)
    )
      throw new Error('Invalid ring ground layer style');
    ids.add(style.id);
  }
  const traced = { ...config, traced: tracedGeometry(trace, { smooth: recipe.smooth }) };
  const polygons = [
    [
      ...roundaboutFillets(traced),
      ...roundaboutCurbPatches(traced),
      ...roundaboutApproaches(traced),
    ],
    roundaboutIslands(traced),
    [
      ...roundaboutMarkings(traced),
      ...roundaboutCrosswalks(traced),
      ...roundaboutTracedLines(traced),
    ],
  ];
  return styles.map((style, i) => ({ ...style, polygons: polygons[i].map((ring) => [ring]) }));
}

/** Export a proposal for the authored ground recipe; this command never rewrites the live map. */
export async function buildRingLayers(
  source = 'content/worlds/ring-block/ring-layout.json',
  output = 'dist/preview/ring-layers.json',
) {
  const recipe: RingLayoutRecipe = JSON.parse(await readFile(source, 'utf8'));
  if (
    typeof recipe.traceFile !== 'string' ||
    !recipe.traceFile
      .split('/')
      .every((part) => /^[a-zA-Z0-9_.-]+$/.test(part) && part !== '.' && part !== '..')
  )
    throw new Error('Ring traceFile must be relative to its recipe');
  const trace = JSON.parse(await readFile(resolve(dirname(source), recipe.traceFile), 'utf8'));
  const layers = generateRingLayers(recipe, trace);
  await mkdir(dirname(resolve(output)), { recursive: true });
  await writeFile(output, JSON.stringify({ formatVersion: 1, layers }, null, 2) + '\n');
  return layers;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const layers = await buildRingLayers();
  console.log(
    `Ring layers: ${layers.map((layer) => `${layer.id}=${layer.polygons.length}`).join(', ')} → dist/preview/ring-layers.json`,
  );
}
