import { readFile, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import {
  GROUP_RENDER_LIMITS,
  canonicalJson,
  loadWorldBundle,
  simulationProjection,
  validateWorldManifest,
  worldManifestIdentity,
  type WorldManifest,
  type WorldLayoutSnapshot,
} from '@su/contracts';
import { hash } from '@su/world-release';
import { layoutHash, type AuthoringRelease } from './release.js';

/** Reuse the current, already published layout rather than baking it a second time
 * on the first edit. Only consumed physical metadata and far bytes are loaded. */
export async function readCachedPublication(
  release: AuthoringRelease,
  snapshot: WorldLayoutSnapshot,
  expected: WorldManifest,
) {
  const root = resolve(
    release.directory,
    'layouts',
    release.metadata.assetReleaseVersion,
    layoutHash(snapshot),
  );
  let bytes: Buffer;
  try {
    bytes = await readFile(resolve(root, 'manifest.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const manifest = validateWorldManifest(JSON.parse(bytes.toString()));
  if (
    manifest.mapVersion !== expected.mapVersion ||
    hash(canonicalJson(worldManifestIdentity(manifest))) !== expected.mapVersion
  )
    throw new Error('Cached publication identity mismatch');
  const read = async (path: string, sha: string) => {
    const file = resolve(root, path);
    if (!file.startsWith(root + sep) || manifest.files[path] !== sha)
      throw new Error('Cached resource path');
    const data = await readFile(file);
    if (hash(data) !== sha) throw new Error('Cached resource hash');
    return data;
  };
  const world = await loadWorldBundle(manifest, read);
  if (hash(canonicalJson(simulationProjection(world))) !== manifest.simulationConfigHash)
    throw new Error('Cached physics identity');
  const payloads = new Map<string, Uint8Array>(),
    paths =
      manifest.graphics?.groups.flatMap((g) =>
        g.far.resources.flatMap(
          (r) =>
            [
              [r.modelFile, GROUP_RENDER_LIMITS.modelBytes],
              [r.partsFile, GROUP_RENDER_LIMITS.partsBytes],
            ] as const,
        ),
      ) ?? [];
  let cursor = 0;
  const load = async () => {
    while (cursor < paths.length) {
      const [path, limit] = paths[cursor++];
      if ((await stat(resolve(root, path))).size > limit)
        throw new Error('Cached HLOD resource limit');
      payloads.set(path, await read(path, manifest.files[path]));
    }
  };
  await Promise.all(Array.from({ length: 8 }, load));
  return { world, publication: { manifest, payloads }, hash: layoutHash(snapshot) };
}
