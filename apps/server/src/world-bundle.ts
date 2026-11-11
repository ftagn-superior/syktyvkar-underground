import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import {
  canonicalJson,
  loadWorldBundle,
  simulationProjection,
  validateWorldManifest,
  worldManifestIdentity,
} from '@su/contracts';

/** Resolve and verify the release before exposing readiness or creating physics bodies. */
export async function readWorldDirectory(directory: string) {
  const root = resolve(directory);
  const manifest = validateWorldManifest(
    JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8')),
  );
  const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
  if (hash(canonicalJson(worldManifestIdentity(manifest))) !== manifest.mapVersion)
    throw new Error('World manifest hash disagrees. Run pnpm world:build.');
  const verified = new Set<string>();
  const read = async (path: string, expectedHash: string): Promise<Uint8Array> => {
    const file = resolve(root, path);
    if (!file.startsWith(root + sep) || manifest.files[path] !== expectedHash)
      throw new Error(`Unlisted world resource: ${path}`);
    const bytes = await readFile(file);
    if (hash(bytes) !== expectedHash) throw new Error(`World resource hash disagrees: ${path}`);
    verified.add(path);
    return bytes;
  };
  const definition = await loadWorldBundle(manifest, read);
  if (hash(canonicalJson(simulationProjection(definition))) !== manifest.simulationConfigHash)
    throw new Error('World physics hash disagrees. Run pnpm world:build.');
  // Visual files are checked as bytes, never loaded into the server's physics scene.
  for (const [path, expectedHash] of Object.entries(manifest.files)) {
    if (!verified.has(path)) await read(path, expectedHash);
  }
  return { manifest, definition };
}
