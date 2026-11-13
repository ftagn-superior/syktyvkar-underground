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
import { readWorldDirectory } from '../../apps/server/src/world-bundle.js';

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
    terrainGrid: candidate.terrain?.grid,
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

/**
 * Profile an already generated height migration. This is a separate mode from
 * the flat-only proof above: it permits audited Y changes, never a blind rebind.
 * The supplied public bytes must exactly match publishing the supplied saved
 * target snapshot with its immutable authoring release.
 */
export async function readPreparedRingProfilePublication(
  sourceDirectory: string,
  sourceSnapshot: WorldLayoutSnapshot,
  authoringDirectory: string,
  targetSnapshot: WorldLayoutSnapshot,
  publicationDirectory: string,
) {
  const before = canonicalJson({ sourceSnapshot, targetSnapshot });
  const source = await readAuthoringRelease(sourceDirectory);
  const original = await createLayoutPublication(source, sourceSnapshot);
  verifyPublishedInstances(original.world, source, sourceSnapshot);
  const target = await readAuthoringRelease(authoringDirectory);
  assert.ok(target.terrain?.formatVersion === 2, 'Prepared pilot requires private terrain v2');
  assert.equal(targetSnapshot.worldId, sourceSnapshot.worldId);
  assert.equal(
    targetSnapshot.seedVersion,
    sourceSnapshot.seedVersion,
    'Saved seed identity changed',
  );
  assert.equal(targetSnapshot.assetReleaseVersion, target.metadata.assetReleaseVersion);
  assert.deepEqual(target.manifest.grid, source.manifest.grid, 'Streaming grid changed');
  assert.deepEqual(
    target.definition.simulation,
    source.definition.simulation,
    'Simulation settings changed',
  );
  const protectedInstance = ({
    instanceRevision: _r,
    position,
    ...rest
  }: WorldLayoutSnapshot['instances'][number]) => ({
    ...rest,
    position: { x: position.x, z: position.z },
  });
  assert.deepEqual(
    sorted(targetSnapshot.instances).map(protectedInstance),
    sorted(sourceSnapshot.instances).map(protectedInstance),
    'Prepared profile changed more than saved owner Y/revision',
  );
  assert.deepEqual(
    editableStaticAssetIds(target),
    editableStaticAssetIds(source),
    'Editable asset catalog changed',
  );
  for (const id of editableStaticAssetIds(source)) {
    assert.equal(
      target.manifest.assets[id].version,
      source.manifest.assets[id].version,
      `Editable asset changed: ${id}`,
    );
    assert.deepEqual(
      target.definition.buildingAssets[id],
      source.definition.buildingAssets[id],
      `Editable physics changed: ${id}`,
    );
  }
  const expected = await createLayoutPublication(target, targetSnapshot);
  const published = await readWorldDirectory(publicationDirectory);
  assert.deepEqual(
    published.manifest,
    expected.publication.manifest,
    'Prepared publication differs from the accepted target snapshot',
  );
  assert.equal(
    canonicalJson({ sourceSnapshot, targetSnapshot }),
    before,
    'Profile snapshots were mutated',
  );
  return {
    ...expected,
    world: published.definition,
    terrainGrid: target.terrain.grid,
    profileFixture: {
      kind: 'terrain-pilot',
      source: {
        directory: source.directory,
        manifestSha256: hash(await readFile(join(source.directory, 'manifest.json'))),
        mapVersion: source.manifest.mapVersion,
        assetReleaseVersion: source.metadata.assetReleaseVersion,
        fixedInstanceIds: source.metadata.fixedInstanceIds,
      },
      candidate: {
        directory: target.directory,
        publicationDirectory,
        manifestSha256: hash(await readFile(join(publicationDirectory, 'manifest.json'))),
        mapVersion: published.manifest.mapVersion,
        assetReleaseVersion: target.metadata.assetReleaseVersion,
      },
      originalAssetReleaseVersion: sourceSnapshot.assetReleaseVersion,
      reboundAssetReleaseVersion: targetSnapshot.assetReleaseVersion,
      originalLayoutHash: original.hash,
      originalLayoutMapVersion: original.publication.manifest.mapVersion,
      enabledInstances: targetSnapshot.instances.filter((i) => i.enabled).length,
      disabledInstances: targetSnapshot.instances.filter((i) => !i.enabled).length,
      instancesSha256: hash(canonicalJson(targetSnapshot.instances)),
      originalInstancesSha256: hash(canonicalJson(sourceSnapshot.instances)),
      editableAssetIds: editableStaticAssetIds(source),
      unchangedAbsolutePoses: false,
      preservedOwnerIdentityXZRotationEnabled: true,
      unchangedEditableAssets: true,
      unchangedHeaderAndStreamingGrid: false,
      unchangedStreamingGridAndSimulation: true,
      exactPreparedPublication: true,
      databaseAccess: false,
      exportFileWritten: false,
      liveMigrationAssessed: false,
    },
  };
}
