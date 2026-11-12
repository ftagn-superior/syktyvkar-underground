import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import {
  buildRingLayers,
  generateRingLayers,
  type RingLayoutRecipe,
} from '../../tools/world-build/src/ring-layout.js';
import { generateGround, type GroundRecipe } from '../../tools/world-build/src/city.js';

const source = 'content/worlds/ring-block/ring-layout.json';
const tracePath = 'content/worlds/ring-block/ring-trace.json';
const groundPath = 'content/buildings/ring-block/ring-block-ground/source.json';
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

it('exports usable ground layers from our recipe and traces without rewriting the map', async () => {
  const watched = [source, tracePath, groundPath, 'content/worlds/ring-block/cells/0_0.json'];
  const before = await Promise.all(watched.map((path) => readFile(path)));
  const directory = await mkdtemp(join(tmpdir(), 'su-ring-layers-'));
  temporary.push(directory);
  const output = join(directory, 'layers.json');
  const recipe: RingLayoutRecipe = JSON.parse(before[0].toString());
  const trace = JSON.parse(before[1].toString());
  const layers = await buildRingLayers(source, output);
  expect(layers).toEqual(generateRingLayers(recipe, trace));
  expect(JSON.parse(await readFile(output, 'utf8'))).toEqual({ formatVersion: 1, layers });
  expect(layers.map((layer) => layer.id)).toEqual(['road', 'islands', 'markings']);
  expect(layers.every((layer) => layer.polygons.length > 0)).toBe(true);
  const ground: GroundRecipe = JSON.parse(before[2].toString());
  const generated = generateGround('own-ring', { ...ground, merge: false, layers });
  expect(generated.parts.map((part) => part.partId)).toEqual([
    'ground',
    'road',
    'islands',
    'markings',
  ]);
  expect(generated.parts.every((part) => part.positions.every(Number.isFinite))).toBe(true);
  expect(generated.physics.colliders).toHaveLength(1);
  const first = await readFile(output);
  await buildRingLayers(source, output);
  expect(await readFile(output)).toEqual(first);
  expect(await Promise.all(watched.map((path) => readFile(path)))).toEqual(before);
});

it('applies an edited manual trace to its layer and rejects non-finite geometry', async () => {
  const recipe: RingLayoutRecipe = JSON.parse(await readFile(source, 'utf8'));
  const trace = JSON.parse(await readFile(tracePath, 'utf8'));
  const before = generateRingLayers(recipe, trace);
  const edited = generateRingLayers(recipe, {
    traces: [
      ...trace.traces,
      {
        name: 'custom:lane-solid',
        points: [
          [80, 0],
          [100, 0],
        ],
      },
    ],
  });
  expect(edited.slice(0, 2)).toEqual(before.slice(0, 2));
  expect(edited[2].polygons).toHaveLength(before[2].polygons.length + 1);
  expect(() =>
    generateRingLayers({ ...recipe, roundabout: { ...recipe.roundabout, outer: Infinity } }, trace),
  ).toThrow(/radii/);
  expect(() =>
    generateRingLayers(recipe, {
      traces: [
        {
          name: 'custom:lane-solid',
          points: [
            [NaN, 0],
            [100, 0],
          ],
        },
      ],
    }),
  ).toThrow(/finite/);
});

it('rejects a trace reference outside the authored recipe directory before writing output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'su-ring-path-'));
  temporary.push(directory);
  const recipe = JSON.parse(await readFile(source, 'utf8'));
  await writeFile(
    join(directory, 'recipe.json'),
    JSON.stringify({ ...recipe, traceFile: '../trace.json' }),
  );
  await expect(
    buildRingLayers(join(directory, 'recipe.json'), join(directory, 'layers.json')),
  ).rejects.toThrow(/relative/);
  await expect(readFile(join(directory, 'layers.json'))).rejects.toThrow(/ENOENT/);
});
