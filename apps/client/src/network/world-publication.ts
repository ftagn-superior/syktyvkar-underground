import {
  WORLD_FORMAT_VERSION,
  canonicalJson,
  loadWorldHeader,
  trustWorldManifest,
  worldManifestIdentity,
  type WorldInfo,
  type WorldPublicationInfo,
} from '@su/contracts';
import { VerifiedResources, type VerifiedByteCache } from '../streaming/resources';

export class WorldVersionMismatch extends Error {
  constructor() {
    super('VERSION_MISMATCH');
  }
}

export async function getResponse(
  url: string,
  cache: RequestCache = 'no-cache',
  signal?: AbortSignal,
): Promise<Response> {
  const response = await fetch(url, {
    cache,
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(12_000)])
      : AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`WORLD_NOT_READY: ${response.status}`);
  return response;
}

/** Initial load and live layout changes use the same verified, immutable resource context. */
export async function loadWorldPublication(
  info: WorldInfo | WorldPublicationInfo,
  cache?: VerifiedByteCache,
) {
  const url = new URL(info.manifestUrl, location.href);
  const raw = await (await getResponse(url.href)).json();
  if (raw.formatVersion !== WORLD_FORMAT_VERSION) throw new WorldVersionMismatch();
  const manifest = trustWorldManifest(raw);
  const identity = new TextEncoder().encode(canonicalJson(worldManifestIdentity(manifest)));
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', identity))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  if (
    manifest.mapVersion !== info.mapVersion ||
    manifest.simulationConfigHash !== info.simulationConfigHash ||
    hash !== manifest.mapVersion
  )
    throw new WorldVersionMismatch();
  const resources = new VerifiedResources(manifest, new URL('.', url).href, { cache });
  try {
    const definition = await loadWorldHeader(manifest, (path) => resources.read(path));
    return { url, manifest, resources, definition };
  } catch (error) {
    resources.dispose();
    throw error;
  }
}
