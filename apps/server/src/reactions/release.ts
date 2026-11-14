import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REACTIONS, REACTION_SVG_MAX_BYTES, validateReactionDefinitions } from '@su/contracts';
import { reactionReleaseVersion } from './version.js';

declare const __SU_REACTION_CATALOG_VERSION__: string;

export class ReactionReleaseError extends Error {}

/** Снимок ассетов неизменен до перезапуска, как и определения серверного каталога. */
export async function loadReactionRelease(directory: string, definitions = REACTIONS) {
  validateReactionDefinitions(definitions);
  const assets = new Map<string, Buffer>();
  for (const { id, asset } of definitions) {
    const path = join(directory, asset);
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > REACTION_SVG_MAX_BYTES)
        throw new Error(`нужен обычный SVG-файл не больше ${REACTION_SVG_MAX_BYTES} байт`);
      assets.set(asset, await readFile(path));
    } catch (error) {
      throw new ReactionReleaseError(`Реакция "${id}" (${path}): ${(error as Error).message}`);
    }
  }
  return { version: reactionReleaseVersion(definitions, assets), assets };
}

export const bundledReactionVersion =
  typeof __SU_REACTION_CATALOG_VERSION__ === 'string' ? __SU_REACTION_CATALOG_VERSION__ : undefined;

export async function verifyReactionClientBuild(
  clientDirectory: string,
  expected: string,
): Promise<void> {
  const path = join(clientDirectory, 'reaction-release.json');
  try {
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    if (manifest.formatVersion !== 1 || manifest.version !== expected)
      throw new Error('версия клиентского каталога не совпадает со сборкой сервера');
  } catch (error) {
    throw new ReactionReleaseError(
      `Реакции (${path}): ${(error as Error).message}. Выпустите клиент и сервер вместе.`,
    );
  }
}
