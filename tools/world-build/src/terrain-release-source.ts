import { readFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { validateTerrainGrid } from '@su/contracts';
import { hash } from '@su/world-release';
import type { BuildWorldOptions } from './index.js';

export interface TerrainReleaseIdentity {
  assetReleaseVersion: string;
  seedVersion: string;
  mapVersion: string;
}
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: object, allowed: string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));
const digest = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function localFile(directory: string, file: unknown) {
  if (
    typeof file !== 'string' ||
    file.includes('\\') ||
    !file.split('/').every((part) => part && part !== '.' && part !== '..')
  )
    throw new Error('Terrain release paths must be relative authoring files');
  const path = resolve(directory, file);
  if (!path.startsWith(resolve(directory) + sep))
    throw new Error('Terrain release path escapes its directory');
  return path;
}

/** Canonical authoring depends only on committed files, never a database or a saved layout export. */
export async function readTerrainReleaseSource(
  worldFile: string,
  worldId: string,
  reference: unknown,
) {
  const file = localFile(dirname(resolve(worldFile)), reference);
  const source: unknown = JSON.parse(await readFile(file, 'utf8'));
  if (
    !record(source) ||
    !keys(source, ['formatVersion', 'worldId', 'physicsPacks', 'groundTerrain', 'expected']) ||
    source.formatVersion !== 1 ||
    source.worldId !== worldId ||
    typeof source.physicsPacks !== 'boolean' ||
    !record(source.groundTerrain) ||
    !record(source.expected) ||
    !keys(source.expected, ['assetReleaseVersion', 'seedVersion', 'mapVersion']) ||
    !['assetReleaseVersion', 'seedVersion', 'mapVersion'].every((key) =>
      digest((source.expected as Record<string, unknown>)[key]),
    )
  )
    throw new Error('Invalid canonical terrain release source');
  const ground = source.groundTerrain;
  if (
    !keys(ground, [
      'spacing',
      'grid',
      'extendToWorldBounds',
      'supports',
      'header',
      'statics',
      'seedY',
      'placementModels',
    ]) ||
    (ground.spacing !== 2 && ground.spacing !== 4) ||
    (ground.extendToWorldBounds !== undefined && ground.extendToWorldBounds !== true) ||
    !record(ground.grid) ||
    !keys(ground.grid, ['file', 'sha256']) ||
    !digest(ground.grid.sha256) ||
    !Array.isArray(ground.supports) ||
    !record(ground.header) ||
    !Array.isArray(ground.statics) ||
    !record(ground.seedY) ||
    !Array.isArray(ground.placementModels)
  )
    throw new Error('Invalid canonical terrain authoring options');
  const gridBytes = await readFile(localFile(dirname(file), ground.grid.file));
  if (hash(gridBytes) !== ground.grid.sha256)
    throw new Error('Canonical terrain grid hash mismatch');
  const grid = validateTerrainGrid(JSON.parse(gridBytes.toString()));
  if (grid.spacing !== ground.spacing) throw new Error('Canonical terrain grid spacing mismatch');
  return {
    file,
    expected: source.expected as unknown as TerrainReleaseIdentity,
    options: {
      physicsPacks: source.physicsPacks,
      groundTerrain: { ...ground, grid },
    } as Pick<BuildWorldOptions, 'physicsPacks' | 'groundTerrain'>,
  };
}

export function assertTerrainReleaseIdentity(
  actual: TerrainReleaseIdentity,
  expected: TerrainReleaseIdentity,
) {
  for (const key of ['assetReleaseVersion', 'seedVersion', 'mapVersion'] as const)
    if (actual[key] !== expected[key])
      throw new Error(
        `Canonical terrain ${key} changed; review and update the accepted authoring release`,
      );
}
