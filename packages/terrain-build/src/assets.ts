import {
  WORLD_RESOURCE_LIMITS,
  canonicalJson,
  validateBuildingParts,
  validateBuildingPhysicsAsset,
  type BuildingParts,
  type BuildingPhysicsAsset,
} from '@su/contracts';
import { hash, jsonBytes, type CompiledWorldAsset } from '@su/world-release';
import { encodeStaticGlb, inspectStaticGlb } from './glb.js';
import type { GeneratedTerrainAsset } from './terrain.js';

/** Shared deterministic serialization; external glTF validation belongs to the importer. */
export function compileStaticAsset(
  assetId: string,
  model: Uint8Array | undefined,
  physics: BuildingPhysicsAsset,
  treeParts?: BuildingParts,
  renderMode?: BuildingParts['renderMode'],
): CompiledWorldAsset {
  let inspected: { parts: BuildingParts; bounds: BuildingPhysicsAsset['bounds'] };
  if (model !== undefined) {
    if (model.byteLength > WORLD_RESOURCE_LIMITS.modelBytes)
      throw new Error(`Model byte limit: ${assetId}`);
    inspected = inspectStaticGlb(model, assetId, renderMode);
  } else {
    if (!treeParts) throw new Error(`Missing tree representation: ${assetId}`);
    if (renderMode !== undefined)
      throw new Error(`GLB render mode cannot contain a tree recipe: ${assetId}`);
    inspected = { parts: treeParts, bounds: physics.bounds };
  }
  if (physics.assetId !== assetId || inspected.parts.assetId !== assetId)
    throw new Error(`Compiled asset ID mismatch: ${assetId}`);
  for (const axis of ['x', 'y', 'z'] as const) {
    if (
      Math.abs(physics.bounds.min[axis] - inspected.bounds.min[axis]) > 0.05 ||
      Math.abs(physics.bounds.max[axis] - inspected.bounds.max[axis]) > 0.05
    )
      throw new Error(`Visual/collision asset bounds disagree: ${assetId}.${axis}`);
  }
  physics = { ...physics, bounds: inspected.bounds };
  validateBuildingPhysicsAsset(physics);
  const collision = jsonBytes(physics),
    parts = jsonBytes(validateBuildingParts(inspected.parts));
  if (
    collision.byteLength > WORLD_RESOURCE_LIMITS.collisionBytes ||
    parts.byteLength > WORLD_RESOURCE_LIMITS.partsBytes
  )
    throw new Error(`Model metadata byte limit: ${assetId}`);
  const version = hash(
    canonicalJson({
      ...(model === undefined ? {} : { model: hash(model) }),
      collision: hash(collision),
      parts: hash(parts),
    }),
  );
  return { model, collision, parts, version, physics, bounds: inspected.bounds };
}

export function compileGeneratedAsset(assetId: string, asset: GeneratedTerrainAsset) {
  return compileStaticAsset(assetId, encodeStaticGlb(asset.parts), asset.physics);
}
