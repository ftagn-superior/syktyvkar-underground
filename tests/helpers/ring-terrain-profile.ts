import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  canonicalJson,
  type BuildingInstance,
  type WorldDefinition,
  type WorldLayoutSnapshot,
} from '../../packages/contracts/src/index.js';
import { hash } from '../../packages/world-release/src/index.js';
import {
  createLayoutPublication,
  editableStaticAssetIds,
  readAuthoringRelease,
  type AuthoringRelease,
} from '../../apps/server/src/layout/release.js';

const sorted = <T extends { entityId: string }>(instances: T[]) =>
  instances.slice().sort((a, b) => a.entityId.localeCompare(b.entityId, 'en'));
const header = ({ entities: _e, buildings: _b, buildingAssets: _a, ...rest }: WorldDefinition) =>
  rest;

/** A benchmark-only compatibility proof, not authorization to migrate a live layout. */
export function verifyFlatProfileCandidate(source: AuthoringRelease, candidate: AuthoringRelease) {
  assert.equal(
    canonicalJson(header(candidate.definition)),
    canonicalJson(header(source.definition)),
    'Flat profile must preserve the complete world header, including bounds and spawns',
  );
  assert.deepEqual(candidate.manifest.grid, source.manifest.grid, 'Streaming grid changed');
  assert.deepEqual(
    sorted(candidate.definition.entities),
    sorted(source.definition.entities),
    'Boundary/static primitives changed',
  );
  assert.deepEqual(sorted(candidate.seed), sorted(source.seed), 'Editable source seed changed');
  assert.deepEqual(
    editableStaticAssetIds(candidate),
    editableStaticAssetIds(source),
    'Editable asset catalog changed',
  );
  for (const id of editableStaticAssetIds(source)) {
    const original = source.manifest.assets[id];
    const actual = candidate.manifest.assets[id];
    assert.deepEqual(actual.bounds, original.bounds, `Editable asset bounds changed: ${id}`);
    assert.equal(actual.version, original.version, `Editable asset version changed: ${id}`);
    assert.deepEqual(
      candidate.definition.buildingAssets[id],
      source.definition.buildingAssets[id],
      `Editable asset physics changed: ${id}`,
    );
    for (const key of ['modelFile', 'collisionFile', 'partsFile'] as const) {
      const originalPath = original[key];
      const actualPath = actual[key];
      assert.equal(
        actualPath === undefined,
        originalPath === undefined,
        `${id}: ${key} presence changed`,
      );
      assert.equal(
        actualPath && candidate.manifest.files[actualPath],
        originalPath && source.manifest.files[originalPath],
        `${id}: ${key} bytes changed`,
      );
    }
  }
  assert.ok(candidate.terrain, 'Flat profile requires verified private terrain data');
  assert.ok(
    [2, 4].includes(candidate.terrain.grid.spacing),
    'Expected a 2 m or 4 m flat candidate',
  );
  assert.ok(
    candidate.terrain.grid.heights.every((height) => height === 0),
    'Flat profile requires zero terrain elevations',
  );
  assert.deepEqual(candidate.terrain.supports, [], 'Stage 2 must not generate owner supports');
}

function verifyPublishedInstances(
  world: WorldDefinition,
  release: AuthoringRelease,
  snapshot: WorldLayoutSnapshot,
) {
  const fixed = new Set(release.metadata.fixedInstanceIds);
  const expected: BuildingInstance[] = snapshot.instances
    .filter((instance) => instance.enabled)
    .map(({ enabled: _e, instanceRevision: _r, ...instance }) => instance);
  assert.deepEqual(
    sorted(world.buildings.filter((instance) => !fixed.has(instance.entityId))),
    sorted(expected),
    'Publication must preserve every enabled export instance and its absolute pose',
  );
}

export async function prepareRingProfilePublication(
  sourceDirectory: string,
  snapshot: WorldLayoutSnapshot,
  candidateDirectory?: string,
) {
  const snapshotBefore = canonicalJson(snapshot);
  const source = await readAuthoringRelease(sourceDirectory);
  // Prove that the unmodified export belongs to the old release before considering a candidate.
  const original = await createLayoutPublication(source, snapshot);
  verifyPublishedInstances(original.world, source, snapshot);
  const candidate = candidateDirectory ? await readAuthoringRelease(candidateDirectory) : source;
  if (candidateDirectory) verifyFlatProfileCandidate(source, candidate);
  // Explicit, in-memory benchmark fixture only. No export file, database or accepted release changes.
  const rebound = { ...snapshot, assetReleaseVersion: candidate.metadata.assetReleaseVersion };
  const prepared = candidateDirectory
    ? await createLayoutPublication(candidate, rebound)
    : original;
  verifyPublishedInstances(prepared.world, candidate, snapshot);
  assert.equal(canonicalJson(snapshot), snapshotBefore, 'Original export snapshot was mutated');
  const provenance = async (release: AuthoringRelease) => ({
    directory: release.directory,
    manifestSha256: hash(await readFile(join(release.directory, 'manifest.json'))),
    mapVersion: release.manifest.mapVersion,
    assetReleaseVersion: release.metadata.assetReleaseVersion,
    fixedInstanceIds: release.metadata.fixedInstanceIds,
  });
  return {
    ...prepared,
    profileFixture: {
      kind: candidateDirectory ? `flat-${candidate.terrain!.grid.spacing}m` : 'legacy',
      source: await provenance(source),
      candidate: candidateDirectory ? await provenance(candidate) : null,
      originalAssetReleaseVersion: snapshot.assetReleaseVersion,
      reboundAssetReleaseVersion: rebound.assetReleaseVersion,
      originalLayoutHash: original.hash,
      originalLayoutMapVersion: original.publication.manifest.mapVersion,
      enabledInstances: snapshot.instances.filter((i) => i.enabled).length,
      disabledInstances: snapshot.instances.filter((i) => !i.enabled).length,
      instancesSha256: hash(canonicalJson(snapshot.instances)),
      editableAssetIds: editableStaticAssetIds(source),
      unchangedAbsolutePoses: true,
      unchangedEditableAssets: true,
      unchangedHeaderAndStreamingGrid: true,
      databaseAccess: false,
      exportFileWritten: false,
      liveMigrationAssessed: false,
    },
  };
}
