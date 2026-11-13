import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { canonicalJson, type StaticObjectInstance, type WorldLayoutSnapshot } from '@su/contracts';
import {
  staticAssetSourceHash,
  staticAssetLibraryHash,
  staticFenceSectionId,
  transformStaticAssets,
  validateStaticAssetRemapRules,
  type StaticAssetRemapRules,
} from './static-asset-remap.js';

function rules(length = 8): StaticAssetRemapRules {
  const r: StaticAssetRemapRules = {
    formatVersion: 1,
    algorithmVersion: 'static-library-v1',
    worldId: 'test',
    sourceAssetReleaseVersion: '1'.repeat(64),
    targetAssetReleaseVersion: '2'.repeat(64),
    sourceDescriptionHash: '',
    targetLibraryHash: '3'.repeat(64),
    assetMap: { 'tree-old': 'tree-small', 'bench-old': 'bench-standard' },
    unchangedAssetIds: ['wall-old'],
    fences: { 'fence-old': { length, center: { x: 0, y: 0.8, z: 0 } } },
    fenceCenterOffsets: {},
    vegetation: {},
    sections: {
      short: { assetId: 'fence-short', length: 0.5 },
      long: { assetId: 'fence-long', length: 4 },
    },
    tolerances: { vegetationRelative: 0.1, fenceEndpoint: 0.125 },
  };
  r.sourceDescriptionHash = staticAssetSourceHash(r);
  return r;
}
function instance(overrides: Partial<StaticObjectInstance> = {}): StaticObjectInstance {
  return {
    entityId: 'old-fence',
    assetId: 'fence-old',
    position: { x: 8, y: 2, z: -4 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    enabled: true,
    instanceRevision: 7,
    sourceRef: { provider: 'osm', type: 'way', id: '123' },
    ...overrides,
  };
}
function snapshot(instances = [instance()]): WorldLayoutSnapshot {
  return {
    formatVersion: 1,
    worldId: 'test',
    assetReleaseVersion: '1'.repeat(64),
    seedVersion: '4'.repeat(64),
    revision: 99,
    instances,
  };
}

describe('versioned static library remap', () => {
  it.each([0.362, 0.5, 3.749, 3.75, 3.999999, 4, 4.25, 4.5, 8, 94.957])(
    'covers a %.6fm source with contiguous centered sections',
    (length) => {
      const source = snapshot(),
        result = transformStaticAssets(source, rules(length));
      const fence = result.report.fences[0];
      expect(Math.abs(fence.endpointShift)).toBeLessThanOrEqual(0.125 + 1e-9);
      expect(fence.targetLength).toBe(Math.max(0.5, Math.round(length / 0.5) * 0.5));
      let cursor = 8 - fence.targetLength / 2;
      for (const section of fence.sections) {
        expect(section.position.x - section.length / 2).toBeCloseTo(cursor, 12);
        cursor = section.position.x + section.length / 2;
        expect(
          result.snapshot.instances.find((i) => i.entityId === section.entityId)?.sourceRef,
        ).toEqual(source.instances[0].sourceRef);
      }
      expect(cursor).toBeCloseTo(8 + fence.targetLength / 2, 12);
      expect(result.snapshot.instances.filter((i) => i.entityId === 'old-fence')).toHaveLength(1);
      expect(source.instances).toHaveLength(1);
    },
  );

  it('uses the full quaternion for offsets and preserves disabled state and source provenance', () => {
    const source = snapshot([
      instance({ rotation: { x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 }, enabled: false }),
    ]);
    const { snapshot: transformed, report } = transformStaticAssets(source, rules(8));
    expect(report.fences[0].sections.map((s) => s.position.x)).toEqual([8, 8]);
    expect(report.fences[0].sections[0].position.y).toBeCloseTo(0, 12);
    expect(report.fences[0].sections[1].position.y).toBeCloseTo(4, 12);
    expect(report.fences[0].sections[0].entityId).toBe('old-fence'); // lower ordinal wins an equal distance
    for (const next of transformed.instances) {
      expect(next.enabled).toBe(false);
      expect(next.rotation).toEqual(source.instances[0].rotation);
      expect(next.sourceRef).toEqual(source.instances[0].sourceRef);
    }
    expect(transformStaticAssets(transformed, rules(8)).snapshot).toEqual(transformed);
  });

  it('preserves every non-fence field and is deterministic across input order and retries', () => {
    const tree = instance({ entityId: 'tree', assetId: 'tree-old' });
    const wall = instance({ entityId: 'wall', assetId: 'wall-old' });
    const source = snapshot([instance(), tree, wall]);
    const result = transformStaticAssets(source, rules());
    expect(result.snapshot.instances.find((i) => i.entityId === 'tree')).toEqual({
      ...tree,
      assetId: 'tree-small',
    });
    expect(result.snapshot.instances.find((i) => i.entityId === 'wall')).toEqual(wall);
    expect(
      transformStaticAssets({ ...source, instances: [...source.instances].reverse() }, rules()),
    ).toEqual(result);
    const repeated = transformStaticAssets(result.snapshot, rules());
    expect(repeated.snapshot).toEqual(result.snapshot);
    expect(repeated.report.alreadyApplied).toBe(true);
    expect(repeated.report.changes).toHaveLength(0);
    expect(canonicalJson(source)).toBe(canonicalJson(snapshot([instance(), tree, wall])));
  });

  it('rejects all ID collisions including disabled existing rows', () => {
    const collision = instance({
      entityId: staticFenceSectionId('old-fence', 1),
      assetId: 'wall-old',
      enabled: false,
    });
    expect(() => transformStaticAssets(snapshot([instance(), collision]), rules())).toThrow(
      'ID conflict',
    );
    expect(staticFenceSectionId('x'.repeat(80), 100).length).toBeLessThanOrEqual(80);
  });
  it('rejects stale releases, invalid quaternion, missing rules and damaged source descriptions', () => {
    expect(() =>
      transformStaticAssets({ ...snapshot(), assetReleaseVersion: 'a'.repeat(64) }, rules()),
    ).toThrow('source release mismatch');
    expect(() =>
      transformStaticAssets(snapshot([instance({ assetId: 'unknown' })]), rules()),
    ).toThrow('unmapped source');
    expect(() =>
      transformStaticAssets(
        snapshot([instance({ rotation: { x: 0, y: 0, z: 0, w: 2 } })]),
        rules(),
      ),
    ).toThrow('unit quaternion');
    const damaged = rules();
    damaged.fences['fence-old'].length = 12;
    expect(() => validateStaticAssetRemapRules(damaged)).toThrow('checksum');
  });
  it.each([
    ['constructor', 'unmapped source asset'],
    ['toString', 'building assetId'],
    ['valueOf', 'building assetId'],
    ['__proto__', 'building assetId'],
  ])('rejects inherited dictionary names as source assets: %s', (assetId, error) => {
    expect(() => transformStaticAssets(snapshot([instance({ assetId })]), rules())).toThrow(error);
  });
  it('ignores inherited mappings and source fence descriptions', () => {
    const r = rules();
    r.assetMap = Object.assign(Object.create({ 'tree-inherited': 'tree-small' }), r.assetMap);
    r.fences = Object.assign(
      Object.create({ 'fence-inherited': { length: 8, center: { x: 0, y: 0.8, z: 0 } } }),
      r.fences,
    );
    r.sourceDescriptionHash = staticAssetSourceHash(r);
    for (const assetId of ['tree-inherited', 'fence-inherited'])
      expect(() => transformStaticAssets(snapshot([instance({ assetId })]), r)).toThrow(
        'unmapped source asset',
      );
  });
  it('does not apply inherited offsets to valid entity names', () => {
    const result = transformStaticAssets(
      snapshot([instance({ entityId: 'constructor' })]),
      rules(),
    );
    expect(result.report.fences[0].centerOffset).toBe(0);
  });
  it('requires own target manifest entries when hashing the library', () => {
    const r = rules();
    r.assetMap = { 'tree-old': 'constructor' };
    r.sourceDescriptionHash = staticAssetSourceHash(r);
    expect(() => staticAssetLibraryHash(r, {})).toThrow('Missing remap library asset constructor');
  });
  it('retains each original ID on the section nearest its old pivot', () => {
    const r = rules(8);
    r.fences['fence-old'].center.x = 3;
    r.sourceDescriptionHash = staticAssetSourceHash(r);
    const result = transformStaticAssets(snapshot(), r);
    expect(result.report.fences[0].sections[0].entityId).toBe('old-fence');
    expect(result.report.fences[0].sections[1].entityId).toBe(staticFenceSectionId('old-fence', 1));
  });
  it('preserves reviewed passage ends with explicit bounded local offsets', () => {
    const r = rules(4.403);
    r.fenceCenterOffsets['old-fence'] = -0.0485;
    r.sourceDescriptionHash = staticAssetSourceHash(r);
    const { report } = transformStaticAssets(snapshot(), r);
    expect(report.fences[0].endpointShifts[0]).toBeCloseTo(-0.097, 12);
    expect(report.fences[0].endpointShifts[1]).toBeCloseTo(0, 12);
    expect(report.fences[0].targetEndpoints[1]).toEqual(report.fences[0].sourceEndpoints[1]);
    r.fenceCenterOffsets['old-fence'] = -0.1;
    r.sourceDescriptionHash = staticAssetSourceHash(r);
    expect(() => transformStaticAssets(snapshot(), r)).toThrow('endpoint tolerance');
  });
  it('checks the generated library rules against independently saved legacy bounds', async () => {
    const r = JSON.parse(
      await readFile('content/migrations/ring-block/static-library-v1.json', 'utf8'),
    ) as StaticAssetRemapRules;
    validateStaticAssetRemapRules(r);
    expect(
      new Set([...Object.values(r.assetMap), r.sections.short.assetId, r.sections.long.assetId])
        .size,
    ).toBe(22);
    expect(Object.keys(r.vegetation)).toHaveLength(1106);
    expect(Object.keys(r.fences)).toHaveLength(329);
    const invalid = structuredClone(r);
    Object.values(invalid.vegetation)[0].targetBounds.max.y *= 2;
    invalid.sourceDescriptionHash = staticAssetSourceHash(invalid);
    expect(() => validateStaticAssetRemapRules(invalid)).toThrow('vegetation tolerance');
  });
});
