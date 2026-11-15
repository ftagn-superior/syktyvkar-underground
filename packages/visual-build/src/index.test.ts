import { describe, it, expect } from 'vitest';
import { cityLodFixture } from '../../../tests/fixtures/city-lod.js';
import {
  changedWorldGraphicsGroups,
  changedWorldPublicationCells,
  graphicsMembership,
  validateGraphicsCoverage,
  validateWorldManifest,
  worldPublicationBaseIdentity,
  inspectGroupGlb,
  validateGroupRenderParts,
} from '@su/contracts';
import { validateVisualSource, VisualGroupBuilder } from './index.js';
import { hash, jsonBytes, createWorldPublication } from '@su/world-release';
describe('deterministic visual publications', () => {
  it('reuses a verified publication by rebinding encoded versions to current dependencies', () => {
    const f = cityLodFixture(),
      builder = new VisualGroupBuilder();
    builder.seed(f.publication.manifest.graphics!, f.publication.payloads);
    expect(builder.build(f.world, f.grid, f.source).graphics).toEqual(
      f.publication.manifest.graphics,
    );
    expect(builder.diagnostics()).toMatchObject({ built: 0, reused: 2 });
    f.world.buildings[0].position.x -= 1;
    builder.build(f.world, f.grid, f.source);
    expect(builder.diagnostics()).toMatchObject({ built: 1, reused: 1 });
  });
  it('assigns rotated border members once using the AABB center and nonzero grid origin', () => {
    const f = cityLodFixture(),
      groups = graphicsMembership(f.world, f.grid);
    const west = groups.find((g) => g.memberIds.includes('west'))!;
    expect(west.ownerCellId).toBe('0_1');
    expect(west.coverageCellIds).toEqual(['0_1', '1_1']);
    expect(groups.flatMap((g) => g.memberIds).sort()).toEqual(['east', 'west']);
    const bad = structuredClone(f.publication.manifest.graphics!.groups);
    bad[0].memberIds.push('east');
    expect(() => validateGraphicsCoverage(f.world, f.grid, bad)).toThrow();
  });
  it('uses world-space ground bounds rather than its zero pivot, including the clipped final cell', () => {
    const f = cityLodFixture();
    f.world.buildingAssets['world-ground'] = {
      assetId: 'world-ground',
      bounds: { min: { x: 240, y: -1, z: 240 }, max: { x: 270, y: 0, z: 270 } },
      colliders: [],
    };
    f.world.buildings.push({
      entityId: 'ground',
      assetId: 'world-ground',
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
    });
    const g = graphicsMembership(f.world, f.grid).find((g) => g.memberIds.includes('ground'))!;
    expect(g.ownerCellId).toBe('4_4');
    expect(g.coverageCellIds).toEqual(['3_3', '3_4', '4_3', '4_4']);
  });
  it('round-trips the GLB profile and detects corrupt buffers and resource-only changes', () => {
    const f = cityLodFixture(),
      g = f.publication.manifest.graphics!.groups[0],
      r = g.far.resources[0];
    const parts = validateGroupRenderParts(
        JSON.parse(new TextDecoder().decode(f.publication.payloads.get(r.partsFile))),
        g.groupId,
      ),
      model = f.publication.payloads.get(r.modelFile)!;
    expect(inspectGroupGlb(model, parts)).toEqual({
      geometryBytes: g.far.geometryBytes,
      triangles: g.far.triangles,
      drawUnits: g.far.drawUnits,
    });
    const bad = Uint8Array.from(model);
    new DataView(bad.buffer).setUint32(0, 0, true);
    expect(() => inspectGroupGlb(bad, parts)).toThrow();
    const next = structuredClone(f.publication.manifest);
    next.files[r.modelFile] = hash('tampered');
    expect(changedWorldGraphicsGroups(f.publication.manifest, next)).toEqual([g.groupId]);
    expect(changedWorldPublicationCells(f.publication.manifest, next)).toEqual([]);
  });
  it('publishes identical bytes and keeps graphics outside physics and immutable catalog assets', () => {
    const f = cityLodFixture(),
      again = f.publish(),
      detail = createWorldPublication(f.world, f.grid, { house: f.asset });
    expect(again.manifest).toEqual(f.publication.manifest);
    expect([...again.payloads]).toEqual([...f.publication.payloads]);
    expect(f.builder.diagnostics().built).toBe(0);
    expect(f.builder.diagnostics().reused).toBe(2);
    expect(again.manifest.simulationConfigHash).toBe(detail.manifest.simulationConfigHash);
    expect(changedWorldPublicationCells(detail.manifest, again.manifest)).toEqual([]);
    expect(Object.keys(again.manifest.assets)).toEqual(['house']);
    for (const path of Object.keys(again.manifest.files))
      expect(path.startsWith('private/')).toBe(false);
    expect(again.manifest.mapVersion).not.toBe(detail.manifest.mapVersion);
  });
  it('changes only affected owner groups, not global revisions or unrelated resources', () => {
    const f = cityLodFixture(),
      before = f.publication.manifest;
    f.world.buildings[0].position.x -= 1;
    const after = f.publish().manifest;
    expect(changedWorldGraphicsGroups(before, after)).toEqual(['group-0_1']);
    expect(f.builder.diagnostics()).toEqual({ built: 1, reused: 1, cached: 2 });
    expect(worldPublicationBaseIdentity(before)).toEqual(worldPublicationBaseIdentity(after));
    f.world.buildings.shift();
    const removed = f.publish().manifest;
    expect(removed.graphics!.groups).toHaveLength(1);
    expect(f.builder.diagnostics().cached).toBe(1);
  });
  it('rejects tampered private sources, duplicate membership and over-budget draw units', () => {
    const f = cityLodFixture();
    expect(
      validateVisualSource(
        JSON.parse(new TextDecoder().decode(jsonBytes(f.source))),
        f.world.worldId,
      ),
    ).toEqual(f.source);
    const source = structuredClone(f.source);
    source.templates.house.parts[0].positions[0]++;
    expect(() => validateVisualSource(source, f.world.worldId)).toThrow(/hash/);
    const m = structuredClone(f.publication.manifest);
    m.graphics!.groups[0].far.drawUnits = 5;
    expect(() => validateWorldManifest(m)).toThrow(/draw units/);
    delete source.templates.house;
    expect(() => new VisualGroupBuilder().build(f.world, f.grid, source)).toThrow(/template/);
    expect(hash(jsonBytes(f.source))).toBe(f.publication.manifest.graphics!.sourceVersion);
  });
});
