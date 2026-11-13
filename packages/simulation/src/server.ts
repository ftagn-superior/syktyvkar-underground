import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { WorldDefinition } from '@su/contracts';
import { createAuthoritativeWorld as createWorld } from './authoritative-world.js';
import type { WasmBinary } from './physics-world.js';
export { AuthoritativeWorld } from './authoritative-world.js';
export type { ItemSupportHit, ItemSupportSweep } from './item-support-query.js';
export type { PlayerSpawnCheck, PlayerSpawnFailure } from './physics-world.js';
const require = createRequire(import.meta.url);
export async function loadServerWasm(): Promise<Uint8Array> {
  try {
    return await readFile(new URL('./HavokPhysics.wasm', import.meta.url));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return readFile(require.resolve('@babylonjs/havok/lib/esm/HavokPhysics.wasm'));
  }
}
export async function createAuthoritativeWorld(
  definition: WorldDefinition,
  wasmBinary?: WasmBinary,
) {
  return createWorld(definition, wasmBinary ?? (await loadServerWasm()));
}
