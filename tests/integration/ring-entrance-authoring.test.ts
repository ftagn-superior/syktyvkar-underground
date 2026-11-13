import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { WorldLayoutSnapshot } from '../../packages/contracts/src/index.js';
import {
  assertRingEntranceReleaseMatchesEvidence,
  readRingEntranceSupportOverrides,
  ringEntrancePopulationPoseDigest,
  type RingEntranceCatalog,
} from '../../tools/world-build/src/ring-entrance-authoring.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const physicalMapVersion = hash('physical-release');
let directory: string;
let catalogFile: string;
let catalog: RingEntranceCatalog;
let snapshot: WorldLayoutSnapshot;
const writeJson = async (file: string, value: unknown) => writeFile(file, JSON.stringify(value));
async function updatePhysicalReport(index: number, mutate: (report: any) => void) {
  const pin = catalog.physicalEvidence[index];
  const report = JSON.parse(await readFile(pin.file, 'utf8'));
  mutate(report);
  await writeJson(pin.file, report);
  pin.sha256 = hash(await readFile(pin.file, 'utf8'));
  await writeJson(catalogFile, catalog);
}

beforeEach(async () => {
  await mkdir('output', { recursive: true });
  directory = await mkdtemp(join(process.cwd(), 'output/entrance-authoring-test-'));
  catalogFile = join(directory, 'catalog.json');
  const localFile = (name: string) => relative(process.cwd(), join(directory, name));
  const terrainFile = localFile('terrain.json');
  await writeJson(terrainFile, { fixture: 'terrain-source' });
  const terrain = { file: terrainFile, sha256: hash(await readFile(terrainFile, 'utf8')) };
  const position = { x: 0, y: 10, z: 0 };
  const rotation = { x: 0, y: 0, z: 0, w: 1 };
  snapshot = {
    formatVersion: 1,
    worldId: 'ring-block',
    assetReleaseVersion: hash('assets'),
    seedVersion: hash('seed'),
    revision: 1,
    instances: [
      {
        entityId: 'fixture-house-owner',
        assetId: 'fixture-house',
        position,
        rotation,
        enabled: true,
        instanceRevision: 1,
      },
      {
        entityId: 'fixture-kit-owner',
        assetId: 'fixture-tree',
        position: { x: 4, y: 0, z: 4 },
        rotation,
        enabled: true,
        instanceRevision: 1,
      },
    ],
  };
  catalog = {
    formatVersion: 1,
    worldId: 'ring-block',
    status: 'physics-checked-authoring-candidate',
    terrain,
    sourcePins: [terrain],
    sourceWorldMapVersion: hash('source-release'),
    sourcePlacementSnapshotSha256: hash('source-snapshot'),
    populationPoseSha256: ringEntrancePopulationPoseDigest(snapshot),
    overrideArtifact: { file: localFile('overrides.json'), sha256: '' },
    evidence: [],
    physicalEvidence: [],
    physicalRuntimePins: [],
    physicalMapVersion,
    gates: {
      allHighThresholdDoorsHaveGeneratedRules: true,
      kitProjectionClear: true,
      proposedStructureConflictsClear: true,
      fullCityRepresentativePhysics: 'passed',
      directTerrainDoorVolumes: 'passed',
    },
    summary: {
      owners: 1,
      highThresholdDoors: 1,
      coveredHighThresholdDoors: 1,
      podiumOwners: 0,
      directTerrainDoors: 1,
      modelsWithoutAuthoredDoors: 0,
      unresolvedHighThresholdDoors: 0,
    },
    owners: [
      {
        entityId: 'fixture-house-owner',
        assetId: 'fixture-house',
        placement: { position, rotation },
        kind: 'straight-approaches',
        maximumAllowedSlopeDegrees: 8,
        rule: {
          kind: 'foundation-v2',
          assetId: 'fixture-house',
          ownerId: 'fixture-house-owner',
          jointY: 0,
          clearance: 0.08,
          burial: 0.1,
          color: '#aaaaaa',
          components: [
            {
              outline: [
                [0, 0],
                [2, 0],
                [2, 2],
                [0, 2],
              ],
            },
          ],
          approaches: [
            {
              id: 'front',
              edge: [
                [0, 0],
                [2, 0],
              ],
              outward: [0, -1],
              length: 3,
              targetY: 0,
              color: '#aaaaaa',
            },
          ],
        },
        doors: [
          {
            partId: 'doors',
            index: 0,
            thresholdHeightMetres: 0.3,
            approachId: 'front',
            maximumEmittedSlopeDegrees: 6,
          },
        ],
      },
    ],
    directTerrainDoors: [
      {
        entityId: 'fixture-house-owner',
        assetId: 'fixture-house',
        partId: 'doors',
        index: 1,
        thresholdHeightMetres: 0.1,
        status: 'full-city-volume-walk-sprint-checked',
      },
    ],
    modelsWithoutAuthoredDoors: [],
    unresolved: [],
  };
  await writeJson(
    catalog.overrideArtifact.file,
    catalog.owners.map((owner) => owner.rule),
  );
  catalog.overrideArtifact.sha256 = hash(await readFile(catalog.overrideArtifact.file, 'utf8'));
  const geometryFile = localFile('geometry.json');
  await writeJson(geometryFile, { status: 'checked' });
  catalog.evidence.push({ file: geometryFile, sha256: hash(await readFile(geometryFile, 'utf8')) });
  const runtimeFile = localFile('physics-runtime.ts');
  await writeFile(runtimeFile, 'export const physics = "checked";\n');
  catalog.physicalRuntimePins!.push({
    file: runtimeFile,
    sha256: hash(await readFile(runtimeFile, 'utf8')),
  });
  for (const [index, kind] of [
    'full-city-authored-entrances',
    'full-city-low-door-volumes',
  ].entries()) {
    const file = localFile(`physical-${index}.json`);
    await writeJson(file, {
      formatVersion: 1,
      kind,
      status: 'passed',
      failures: 0,
      routes: 1,
      runs: 2,
      mapVersion: physicalMapVersion,
      terrainSha256: terrain.sha256,
      overridesSha256: catalog.overrideArtifact.sha256,
      physicalRuntimePins: catalog.physicalRuntimePins,
      results: [false, true].map((sprint) => ({
        routeId: `fixture-house-owner/doors/${index}`,
        sprint,
        status: 'passed',
      })),
    });
    catalog.physicalEvidence.push({ file, sha256: hash(await readFile(file, 'utf8')) });
  }
  await writeJson(catalogFile, catalog);
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('terrain-bound entrance acceptance', () => {
  it('accepts complete pinned execution evidence and final-build ulp roundoff', async () => {
    const final = structuredClone(snapshot);
    final.instances[0].position.y += 3.55e-15;
    expect(
      await readRingEntranceSupportOverrides(final, {
        file: catalogFile,
        requirePhysicalAcceptance: true,
      }),
    ).toHaveLength(1);
    expect(() =>
      assertRingEntranceReleaseMatchesEvidence(catalog, physicalMapVersion),
    ).not.toThrow();
    expect(() =>
      assertRingEntranceReleaseMatchesEvidence(catalog, hash('another-generated-release')),
    ).toThrow(/differs/);
  });

  it('invalidates acceptance when an unrelated kit moves', async () => {
    const moved = structuredClone(snapshot);
    moved.instances[1].position.x += 0.001;
    await expect(
      readRingEntranceSupportOverrides(moved, {
        file: catalogFile,
        requirePhysicalAcceptance: true,
      }),
    ).rejects.toThrow(/population poses/);
  });

  it('rejects changed physics runtime without blocking diagnostic geometry builds', async () => {
    await writeFile(catalog.physicalRuntimePins![0].file, 'export const physics = "changed";\n');
    await expect(
      readRingEntranceSupportOverrides(snapshot, {
        file: catalogFile,
        requirePhysicalAcceptance: true,
      }),
    ).rejects.toThrow(/Stale entrance evidence/);
    expect(await readRingEntranceSupportOverrides(snapshot, { file: catalogFile })).toHaveLength(1);
  });

  it('cannot refresh catalog runtime pins independently of execution reports', async () => {
    const pin = catalog.physicalRuntimePins![0];
    await writeFile(pin.file, 'export const physics = "changed";\n');
    pin.sha256 = hash(await readFile(pin.file, 'utf8'));
    await writeJson(catalogFile, catalog);
    await expect(
      readRingEntranceSupportOverrides(snapshot, {
        file: catalogFile,
        requirePhysicalAcceptance: true,
      }),
    ).rejects.toThrow(/another runtime baseline/);
  });

  it('does not trust passed flags when evidence bytes changed', async () => {
    await writeJson(catalog.physicalEvidence[0].file, { status: 'passed' });
    await expect(
      readRingEntranceSupportOverrides(snapshot, {
        file: catalogFile,
        requirePhysicalAcceptance: true,
      }),
    ).rejects.toThrow(/Stale entrance evidence/);
  });

  it('rejects a rehashed report for another world release', async () => {
    await updatePhysicalReport(0, (report) => {
      report.mapVersion = hash('unrelated-world');
    });
    await expect(
      readRingEntranceSupportOverrides(snapshot, {
        file: catalogFile,
        requirePhysicalAcceptance: true,
      }),
    ).rejects.toThrow(/another release/);
  });

  it('requires both walk and sprint for every named door', async () => {
    await updatePhysicalReport(0, (report) => {
      report.results[1].sprint = false;
    });
    await expect(
      readRingEntranceSupportOverrides(snapshot, {
        file: catalogFile,
        requirePhysicalAcceptance: true,
      }),
    ).rejects.toThrow(/Duplicate physical route mode/);
  });

  it('rejects changed rules and source data while allowing diagnostic builds without physical reports', async () => {
    catalog.owners[0].rule.approaches![0].length += 1;
    await writeJson(catalogFile, catalog);
    await expect(readRingEntranceSupportOverrides(snapshot, { file: catalogFile })).rejects.toThrow(
      /override artifact/,
    );
    catalog.owners[0].rule.approaches![0].length -= 1;
    catalog.status = 'geometry-checked-authoring-candidate';
    catalog.gates.fullCityRepresentativePhysics = 'pending';
    catalog.gates.directTerrainDoorVolumes = 'pending';
    catalog.physicalEvidence = [];
    await writeJson(catalogFile, catalog);
    expect(await readRingEntranceSupportOverrides(snapshot, { file: catalogFile })).toHaveLength(1);
    await writeFile(catalog.terrain.file, 'changed source');
    await expect(readRingEntranceSupportOverrides(snapshot, { file: catalogFile })).rejects.toThrow(
      /Stale entrance source/,
    );
  });
});
