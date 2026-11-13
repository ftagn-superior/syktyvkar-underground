import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WorldLayoutSnapshot } from '../../packages/contracts/src/index.js';
import {
  jsonBytes,
  writeAuthoringMetadata,
  writeWorldPublication,
} from '../../packages/world-release/src/index.js';
import { buildWorld } from '../../tools/world-build/src/index.js';
import {
  readAuthoringRelease,
  createLayoutPublication,
  type AuthoringRelease,
} from '../../apps/server/src/layout/release.js';
import {
  prepareRingProfilePublication,
  verifyFlatProfileCandidate,
  readPreparedRingProfilePublication,
} from '../helpers/ring-terrain-profile.js';

describe('isolated ring terrain profile publication', () => {
  let temporary: string;
  let source: AuthoringRelease;
  let candidate: AuthoringRelease;
  let snapshot: WorldLayoutSnapshot;
  let pilot: AuthoringRelease, pilotSnapshot: WorldLayoutSnapshot, publicationDirectory: string;
  beforeAll(async () => {
    temporary = await mkdtemp(join(tmpdir(), 'su-terrain-profile-'));
    const sourcePath = join(temporary, 'old');
    const candidatePath = join(temporary, 'candidate');
    await buildWorld('content/worlds/physics-lab/world.json', sourcePath);
    source = await readAuthoringRelease(sourcePath);
    await cp(sourcePath, candidatePath, { recursive: true });
    // A small real release exercises the publication/rebinding path. Geometry acceptance is separate.
    await writeAuthoringMetadata(
      source.definition,
      source.manifest,
      source.metadata.fixedInstanceIds,
      candidatePath,
      jsonBytes({
        formatVersion: 1,
        generatorVersion: 'terrain-build/1',
        worldId: source.definition.worldId,
        grid: {
          formatVersion: 1,
          origin: { x: -20, z: -20 },
          spacing: 2,
          columns: 21,
          rows: 21,
          heights: Array(21 * 21).fill(0),
          bottom: -2,
        },
        supports: [],
      }),
    );
    candidate = await readAuthoringRelease(candidatePath);
    snapshot = {
      formatVersion: 1,
      worldId: source.definition.worldId,
      assetReleaseVersion: source.metadata.assetReleaseVersion,
      seedVersion: source.metadata.seedVersion,
      revision: 5214,
      instances: structuredClone(source.seed),
    };
    snapshot.instances[0].position.y += 0.25;
    snapshot.instances[0].sourceRef = { provider: 'manual', type: 'profile', id: 'saved-pose' };
    snapshot.instances[0].instanceRevision = 8;
    snapshot.instances[1].enabled = false;
    snapshot.instances.push({
      ...structuredClone(snapshot.instances[0]),
      entityId: 'placed_profile',
    });
    const pilotDirectory = join(temporary, 'pilot-authoring');
    await cp(candidatePath, pilotDirectory, { recursive: true });
    await writeAuthoringMetadata(
      source.definition,
      source.manifest,
      source.metadata.fixedInstanceIds,
      pilotDirectory,
      jsonBytes({ ...candidate.terrain, formatVersion: 2, generatorVersion: 'terrain-build/2' }),
    );
    pilot = await readAuthoringRelease(pilotDirectory);
    pilotSnapshot = structuredClone(snapshot);
    pilotSnapshot.assetReleaseVersion = pilot.metadata.assetReleaseVersion;
    pilotSnapshot.instances
      .filter((i) => i.enabled)
      .forEach((i) => {
        i.position.y += 1;
      });
    publicationDirectory = join(temporary, 'pilot-publication');
    await writeWorldPublication(
      (await createLayoutPublication(pilot, pilotSnapshot)).publication,
      publicationDirectory,
    );
  });
  afterAll(async () => {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  });

  it('preserves the actual enabled export poses and records the explicit in-memory release rebind', async () => {
    const before = structuredClone(snapshot);
    const result = await prepareRingProfilePublication(
      source.directory,
      snapshot,
      candidate.directory,
    );
    expect(snapshot).toEqual(before);
    expect(result.profileFixture.originalAssetReleaseVersion).toBe(
      source.metadata.assetReleaseVersion,
    );
    expect(result.profileFixture.reboundAssetReleaseVersion).toBe(
      candidate.metadata.assetReleaseVersion,
    );
    expect(candidate.metadata.assetReleaseVersion).not.toBe(source.metadata.assetReleaseVersion);
    expect(result.profileFixture.enabledInstances).toBe(2);
    expect(result.profileFixture.disabledInstances).toBe(1);
    expect(result.world.buildings.map((instance) => instance.entityId).sort()).toEqual(
      [snapshot.instances[0].entityId, 'placed_profile'].sort(),
    );
    expect(result.world.buildings[0].position).toEqual(snapshot.instances[0].position);
    expect(result.world.buildings[0].sourceRef).toEqual(snapshot.instances[0].sourceRef);
  });

  it('validates the original export against the old release before allowing a rebind', async () => {
    await expect(
      prepareRingProfilePublication(
        source.directory,
        { ...snapshot, assetReleaseVersion: candidate.metadata.assetReleaseVersion },
        candidate.directory,
      ),
    ).rejects.toThrow('different world or asset release');
  });

  it('retains the default legacy publication without changing release identity', async () => {
    const result = await prepareRingProfilePublication(source.directory, snapshot);
    expect(result.profileFixture.kind).toBe('legacy');
    expect(result.profileFixture.candidate).toBeNull();
    expect(result.profileFixture.originalLayoutHash).toBe(result.hash);
    expect(result.profileFixture.originalLayoutMapVersion).toBe(
      result.publication.manifest.mapVersion,
    );
  });

  it('profiles exact prepared migration bytes separately from flat-only rebinding', async () => {
    const result = await readPreparedRingProfilePublication(
      source.directory,
      snapshot,
      pilot.directory,
      pilotSnapshot,
      publicationDirectory,
    );
    expect(result.profileFixture.kind).toBe('terrain-pilot');
    expect(result.profileFixture.exactPreparedPublication).toBe(true);
    expect(result.profileFixture.unchangedAbsolutePoses).toBe(false);
    expect(result.profileFixture.preservedOwnerIdentityXZRotationEnabled).toBe(true);
    expect(
      result.world.buildings.find((i) => i.entityId === snapshot.instances[0].entityId)!.position.y,
    ).toBe(snapshot.instances[0].position.y + 1);
    expect(result.terrainGrid).toEqual(pilot.terrain!.grid);
    const flat = await prepareRingProfilePublication(source.directory, snapshot, pilot.directory);
    expect(
      flat.world.buildings.find((i) => i.entityId === snapshot.instances[0].entityId)!.position.y,
    ).toBe(snapshot.instances[0].position.y);
  });

  it('rejects a prepared target that changes XZ and a publication for another snapshot', async () => {
    const moved = structuredClone(pilotSnapshot);
    moved.instances[0].position.x += 1;
    await expect(
      readPreparedRingProfilePublication(
        source.directory,
        snapshot,
        pilot.directory,
        moved,
        publicationDirectory,
      ),
    ).rejects.toThrow('more than saved owner Y');
    const raised = structuredClone(pilotSnapshot);
    raised.instances[0].position.y += 0.1;
    await expect(
      readPreparedRingProfilePublication(
        source.directory,
        snapshot,
        pilot.directory,
        raised,
        publicationDirectory,
      ),
    ).rejects.toThrow('differs from the accepted target snapshot');
  });

  const rejected: [string, (release: AuthoringRelease) => void, RegExp][] = [
    [
      'spawn Y',
      (r) => {
        r.definition.spawnPoints[0].y++;
      },
      /world header/,
    ],
    [
      'world bounds',
      (r) => {
        r.definition.bounds.max.x++;
      },
      /world header/,
    ],
    [
      'streaming grid',
      (r) => {
        r.manifest.grid.cellSize++;
      },
      /Streaming grid/,
    ],
    [
      'boundary primitive',
      (r) => {
        r.definition.entities[0].size.x++;
      },
      /primitives/,
    ],
    [
      'editable seed Y',
      (r) => {
        r.seed[0].position.y++;
      },
      /source seed/,
    ],
    [
      'model bytes',
      (r) => {
        r.manifest.files[r.manifest.assets['house-a'].modelFile!] = 'a'.repeat(64);
      },
      /modelFile bytes/,
    ],
    [
      'collision bytes',
      (r) => {
        r.manifest.files[r.manifest.assets['house-a'].collisionFile] = 'a'.repeat(64);
      },
      /collisionFile bytes/,
    ],
    [
      'parts bytes',
      (r) => {
        r.manifest.files[r.manifest.assets['house-a'].partsFile] = 'a'.repeat(64);
      },
      /partsFile bytes/,
    ],
    [
      'asset bounds',
      (r) => {
        r.manifest.assets['house-a'].bounds.max.x++;
      },
      /asset bounds/,
    ],
    [
      'nonzero terrain',
      (r) => {
        r.terrain!.grid.heights[0] = 0.001;
      },
      /zero terrain/,
    ],
    [
      'different spacing',
      (r) => {
        r.terrain!.grid.spacing = 8;
      },
      /2 m or 4 m/,
    ],
    [
      'owner support',
      (r) => {
        const terrain = r.terrain!;
        if (terrain.formatVersion !== 1) throw new Error('Flat fixture must remain v1');
        terrain.supports.push({
          ownerId: 'building-a',
          assetId: 'house-a',
          kind: 'rectangle-v1',
          width: 2,
          depth: 2,
          clearance: 0.1,
          burial: 0.1,
        });
      },
      /owner supports/,
    ],
  ];
  it.each(rejected)('rejects changed %s', (_name, mutate, message) => {
    const changed = structuredClone(candidate);
    mutate(changed);
    expect(() => verifyFlatProfileCandidate(source, changed)).toThrow(message);
  });
});
