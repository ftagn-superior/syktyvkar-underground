import {
  canonicalJson,
  type StaticObjectInstance,
  type WorldDefinition,
  type WorldManifest,
} from '@su/contracts';
import { selectSupportRule } from '@su/terrain-build/supports';
import { terrainSupportId, type AuthoringRelease } from './release.js';
export function staticChangeIds(release: AuthoringRelease, owner: StaticObjectInstance) {
  const result = new Set([owner.entityId]);
  if (release.terrain?.formatVersion === 2) {
    const rule = selectSupportRule(release.terrain.supports, owner);
    if (rule) {
      result.add(terrainSupportId(release.definition.worldId, owner.entityId, 'foundation'));
      for (const approach of rule.approaches ?? [])
        result.add(
          terrainSupportId(release.definition.worldId, owner.entityId, `approach:${approach.id}`),
        );
    }
  }
  return result;
}
/** Only this owner and its declared derived geometry may differ in a live operation. */
export function expectedStaticChange(
  release: AuthoringRelease,
  before: { definition: WorldDefinition; manifest: WorldManifest },
  candidate: { world: WorldDefinition; publication: { manifest: WorldManifest } },
  owner: StaticObjectInstance,
) {
  const derived = new Set<string>();
  const terrain = release.terrain;
  const rule =
    terrain?.formatVersion === 2 ? selectSupportRule(terrain.supports, owner) : undefined;
  if (rule) {
    derived.add(terrainSupportId(candidate.world.worldId, owner.entityId, 'foundation'));
    for (const approach of rule.approaches ?? [])
      derived.add(
        terrainSupportId(candidate.world.worldId, owner.entityId, `approach:${approach.id}`),
      );
  }
  const allowed = new Set([owner.entityId, ...derived]);
  const protectedWorld = ({
    buildings,
    buildingAssets: _assets,
    ...header
  }: typeof candidate.world) => ({
    ...header,
    buildings: buildings
      .filter((b) => !allowed.has(b.entityId))
      .sort((a, b) => a.entityId.localeCompare(b.entityId)),
  });
  if (
    canonicalJson(protectedWorld(before.definition)) !==
    canonicalJson(protectedWorld(candidate.world))
  )
    return false;
  const next = candidate.publication.manifest;
  const priorSupports = before.manifest.generatedSupports ?? {};
  const nextSupports = next.generatedSupports ?? {};
  for (const id of new Set([...Object.keys(priorSupports), ...Object.keys(nextSupports)])) {
    if (
      !derived.has(id) &&
      canonicalJson(priorSupports[id] ?? null) !== canonicalJson(nextSupports[id] ?? null)
    )
      return false;
  }
  if (
    canonicalJson(before.manifest.grid) !== canonicalJson(next.grid) ||
    before.manifest.worldFile !== next.worldFile
  )
    return false;
  for (const id of new Set([...Object.keys(before.manifest.assets), ...Object.keys(next.assets)])) {
    if (derived.has(id)) continue;
    const prior = before.manifest.assets[id],
      after = next.assets[id];
    if (
      !prior ||
      !after ||
      canonicalJson(prior) !== canonicalJson(after) ||
      (before.definition.buildingAssets[id] !== candidate.world.buildingAssets[id] &&
        canonicalJson(before.definition.buildingAssets[id]) !==
          canonicalJson(candidate.world.buildingAssets[id]))
    )
      return false;
    for (const file of [prior.modelFile, prior.collisionFile, prior.partsFile])
      if (file && before.manifest.files[file] !== next.files[file]) return false;
  }
  return before.manifest.files[before.manifest.worldFile] === next.files[next.worldFile];
}
