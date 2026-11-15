import type { Bounds, Vec3, Quat } from './simulation.js';
import type {
  BuildingInstance,
  WorldDefinition,
  WorldGrid,
  WorldManifest,
  StaticLightSource,
} from './world-types.js';
import { buildingBounds, cellsIntersectingBounds, worldCellAt } from './world-grid.js';
import { canonicalJson } from './world.js';

/** Version of grouping, silhouette/terrain generation and GLB attribute encoding.
 * Bump this immutable version whenever any of those policies change. */
export const GRAPHICS_POLICY_VERSION = 'city-hlod-1';
export const GROUP_RENDER_LIMITS = Object.freeze({
  modelBytes: 4 * 1024 * 1024,
  partsBytes: 256 * 1024,
  sourceBytes: 128 * 1024 * 1024,
  drawUnits: 4,
  members: 10_000,
});
export type GraphicsLevel = 'near' | 'far';
export interface GraphicsGroup {
  groupId: string;
  ownerCellId: string;
  coverageCellIds: string[];
  memberIds: string[];
  bounds: Bounds;
  version: string;
  far: {
    resources: { modelFile: string; partsFile: string }[];
    packs?: string[];
    geometryBytes: number;
    triangles: number;
    drawUnits: number;
  };
}
export interface WorldGraphics {
  sourceVersion: string;
  policyVersion: string;
  groups: GraphicsGroup[];
}
export interface GroupRenderParts {
  formatVersion: 1;
  groupId: string;
  /** UV3 is explicitly reserved for the original object's world X/Z glow seed. */
  attributes: 'glow-origin-v1';
  parts: { nodeIndex: number; ground: boolean }[];
  lights: { entityId: string; position: Vec3; rotation: Quat; sources: StaticLightSource[] }[];
}
export type GraphicsMembership = Pick<
  GraphicsGroup,
  'groupId' | 'ownerCellId' | 'coverageCellIds' | 'memberIds' | 'bounds'
>;
export function graphicsMembership(world: WorldDefinition, grid: WorldGrid): GraphicsMembership[] {
  const groups = new Map<string, GraphicsMembership>();
  const ids = new Set<string>();
  for (const instance of world.buildings) {
    if (ids.has(instance.entityId)) throw new Error('Duplicate graphics member');
    ids.add(instance.entityId);
    const bounds = buildingBounds(instance, world.buildingAssets[instance.assetId].bounds);
    const ownerCellId = worldCellAt(world.bounds, grid, {
      x: (bounds.min.x + bounds.max.x) / 2,
      z: (bounds.min.z + bounds.max.z) / 2,
    });
    if (!ownerCellId) throw new Error(`Graphics owner outside world: ${instance.entityId}`);
    let group = groups.get(ownerCellId);
    if (!group)
      groups.set(
        ownerCellId,
        (group = {
          groupId: `group-${ownerCellId}`,
          ownerCellId,
          memberIds: [],
          coverageCellIds: [],
          bounds: structuredClone(bounds),
        }),
      );
    group.memberIds.push(instance.entityId);
    group.coverageCellIds.push(...cellsIntersectingBounds(world.bounds, grid, bounds));
    for (const axis of ['x', 'y', 'z'] as const) {
      group.bounds.min[axis] = Math.min(group.bounds.min[axis], bounds.min[axis]);
      group.bounds.max[axis] = Math.max(group.bounds.max[axis], bounds.max[axis]);
    }
  }
  return [...groups.values()]
    .sort((a, b) => (a.groupId < b.groupId ? -1 : a.groupId > b.groupId ? 1 : 0))
    .map((g) => ({
      ...g,
      memberIds: g.memberIds.sort(),
      coverageCellIds: [...new Set(g.coverageCellIds)].sort(),
    }));
}
export function validateGraphicsCoverage(
  world: WorldDefinition,
  grid: WorldGrid,
  groups: GraphicsGroup[],
): void {
  const actual = groups
    .map(({ groupId, ownerCellId, coverageCellIds, memberIds, bounds }) => ({
      groupId,
      ownerCellId,
      coverageCellIds,
      memberIds,
      bounds,
    }))
    .sort((a, b) => (a.groupId < b.groupId ? -1 : a.groupId > b.groupId ? 1 : 0));
  if (canonicalJson(actual) !== canonicalJson(graphicsMembership(world, grid)))
    throw new Error('Incomplete or conflicting graphics coverage');
}
const check = (ok: unknown, message: string): void => {
  if (!ok) throw new Error(`Invalid graphics: ${message}`);
};
export function validateWorldGraphics(manifest: WorldManifest): void {
  const graphics = manifest.graphics;
  if (!graphics) {
    check(manifest.worldId !== 'ring-block', 'ring-block requires graphics coverage');
    return;
  } // Explicit detail-only laboratory publications.
  check(
    /^[a-f0-9]{64}$/.test(graphics.sourceVersion) &&
      graphics.policyVersion === GRAPHICS_POLICY_VERSION,
    'source/policy',
  );
  check(Array.isArray(graphics.groups) && graphics.groups.length <= 10_000, 'groups');
  const members = new Set<string>(),
    groups = new Set<string>();
  const cells = new Set(manifest.cells.map((c) => c.cellId));
  const ref = (path: string) =>
    check(typeof path === 'string' && Object.hasOwn(manifest.files, path), 'resource');
  for (const g of graphics.groups) {
    check(
      g.groupId === `group-${g.ownerCellId}` && cells.has(g.ownerCellId) && !groups.has(g.groupId),
      'owner',
    );
    groups.add(g.groupId);
    check(/^[a-f0-9]{64}$/.test(g.version), 'version');
    for (const a of ['x', 'y', 'z'] as const)
      check(
        Number.isFinite(g.bounds?.min[a]) &&
          Number.isFinite(g.bounds?.max[a]) &&
          g.bounds.min[a] <= g.bounds.max[a],
        'bounds',
      );
    check(
      Array.isArray(g.memberIds) &&
        g.memberIds.length > 0 &&
        g.memberIds.length <= GROUP_RENDER_LIMITS.members &&
        canonicalJson(g.memberIds) === canonicalJson([...new Set(g.memberIds)].sort()),
      'members',
    );
    for (const id of g.memberIds) {
      check(/^[a-zA-Z0-9_-]{1,80}$/.test(id) && !members.has(id), 'unique member');
      members.add(id);
    }
    check(
      Array.isArray(g.coverageCellIds) &&
        g.coverageCellIds.length > 0 &&
        g.coverageCellIds.every((id) => cells.has(id)) &&
        canonicalJson(g.coverageCellIds) === canonicalJson([...new Set(g.coverageCellIds)].sort()),
      'coverage',
    );
    check(
      g.far &&
        Array.isArray(g.far.resources) &&
        g.far.resources.length > 0 &&
        g.far.resources.length <= 4,
      'resources',
    );
    for (const r of g.far.resources) {
      check(
        r.modelFile.startsWith(`hlod/${g.version}/`) &&
          r.modelFile.endsWith('.glb') &&
          r.partsFile.startsWith(`hlod/${g.version}/`) &&
          r.partsFile.endsWith('.json'),
        'far resource namespace',
      );
      ref(r.modelFile);
      ref(r.partsFile);
    }
    for (const p of g.far.packs ?? []) ref(p);
    for (const n of [g.far.drawUnits, g.far.triangles, g.far.geometryBytes])
      check(Number.isSafeInteger(n) && n > 0, 'statistics');
    check(g.far.drawUnits <= GROUP_RENDER_LIMITS.drawUnits, 'draw units');
  }
}
export function validateGroupRenderParts(value: unknown, groupId: string): GroupRenderParts {
  const p = value as GroupRenderParts;
  check(
    p?.formatVersion === 1 && p.groupId === groupId && p.attributes === 'glow-origin-v1',
    'parts identity',
  );
  check(
    Array.isArray(p.parts) &&
      p.parts.length > 0 &&
      p.parts.length <= 4 &&
      p.parts.every((part, i) => part.nodeIndex === i && typeof part.ground === 'boolean'),
    'parts nodes',
  );
  check(
    Array.isArray(p.lights) &&
      p.lights.length <= GROUP_RENDER_LIMITS.members &&
      new Set(p.lights.map((l) => l.entityId)).size === p.lights.length,
    'lights',
  );
  for (const l of p.lights) {
    check(
      l.position &&
        ['x', 'y', 'z'].every((k) => Number.isFinite(l.position[k as keyof Vec3])) &&
        l.rotation &&
        Object.values(l.rotation).every(Number.isFinite) &&
        Math.abs(Math.hypot(l.rotation.x, l.rotation.y, l.rotation.z, l.rotation.w) - 1) < 1e-6,
      'light pose',
    );
    check(
      /^[a-zA-Z0-9_-]{1,80}$/.test(l.entityId) &&
        Array.isArray(l.sources) &&
        l.sources.length <= 128,
      'light owner',
    );
    for (const s of l.sources)
      check(
        s.position &&
          ['x', 'y', 'z'].every((k) => Number.isFinite(s.position[k as keyof Vec3])) &&
          Number.isFinite(s.radius) &&
          s.radius > 0 &&
          s.radius <= 100 &&
          /^#[a-f0-9]{6}$/i.test(s.color) &&
          (s.kind === undefined || s.kind === 'lamp' || s.kind === 'neon'),
        'light source',
      );
  }
  return p;
}
export function graphicsGroupIdentity(manifest: WorldManifest, group: GraphicsGroup) {
  return {
    group,
    files: group.far.resources
      .flatMap((r) => [r.modelFile, r.partsFile])
      .concat(group.far.packs ?? [])
      .map((path) => [path, manifest.files[path]]),
  };
}
export function changedWorldGraphicsGroups(previous: WorldManifest, next: WorldManifest): string[] {
  const before = new Map(previous.graphics?.groups.map((g) => [g.groupId, g]) ?? []),
    after = new Map(next.graphics?.groups.map((g) => [g.groupId, g]) ?? []);
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter(
      (id) =>
        canonicalJson(before.has(id) ? graphicsGroupIdentity(previous, before.get(id)!) : null) !==
        canonicalJson(after.has(id) ? graphicsGroupIdentity(next, after.get(id)!) : null),
    )
    .sort();
}
export function groupMembers(
  group: GraphicsGroup,
  buildings: BuildingInstance[],
): BuildingInstance[] {
  const ids = new Set(group.memberIds),
    selected = buildings.filter((b) => ids.has(b.entityId));
  if (selected.length !== ids.size)
    throw new Error(`Missing owner-cell definitions: ${group.groupId}`);
  return selected;
}

/** Engine-free validation of the versioned, untextured HLOD GLB profile. */
export function inspectGroupGlb(bytes: Uint8Array, parts: GroupRenderParts) {
  check(bytes.length >= 28 && bytes.length <= GROUP_RENDER_LIMITS.modelBytes, 'GLB size');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  check(
    view.getUint32(0, true) === 0x46546c67 &&
      view.getUint32(4, true) === 2 &&
      view.getUint32(8, true) === bytes.length,
    'GLB header',
  );
  const length = view.getUint32(12, true),
    binary = 28 + length;
  check(
    view.getUint32(16, true) === 0x4e4f534a &&
      binary <= bytes.length &&
      view.getUint32(24 + length, true) === 0x004e4942 &&
      binary + view.getUint32(20 + length, true) === bytes.length,
    'GLB chunks',
  );
  const d = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + length)));
  check(
    d.asset?.version === '2.0' &&
      d.buffers?.length === 1 &&
      d.buffers[0].uri === undefined &&
      !d.images?.length &&
      !d.textures?.length &&
      !d.skins?.length &&
      !d.animations?.length &&
      !d.extensionsRequired?.length &&
      !d.extensionsUsed?.length &&
      !d.extensions,
    'self-contained static GLB',
  );
  check(
    d.nodes?.length === parts.parts.length &&
      d.meshes?.length === parts.parts.length &&
      d.scenes?.length === 1 &&
      (d.scene ?? 0) === 0 &&
      canonicalJson(d.scenes[0].nodes) === canonicalJson(parts.parts.map((p) => p.nodeIndex)),
    'GLB node layout',
  );
  let geometryBytes = 0,
    triangles = 0,
    drawUnits = 0;
  const ranges: [number, number][] = [];
  for (const b of d.bufferViews ?? []) {
    check(
      b.buffer === 0 &&
        Number.isSafeInteger(b.byteOffset) &&
        Number.isSafeInteger(b.byteLength) &&
        b.byteOffset >= 0 &&
        b.byteLength > 0 &&
        binary + b.byteOffset + b.byteLength <= bytes.length &&
        b.byteStride === undefined,
      'GLB buffer range',
    );
    ranges.push([b.byteOffset, b.byteOffset + b.byteLength]);
    geometryBytes += b.byteLength;
  }
  ranges.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < ranges.length; i++)
    check(ranges[i][0] >= ranges[i - 1][1], 'overlapping GLB buffers');
  const accessor = (id: number, type: string, components: number, componentType: number) => {
    const a = d.accessors?.[id],
      b = d.bufferViews?.[a?.bufferView];
    check(
      a &&
        b &&
        a.type === type &&
        a.componentType === componentType &&
        Number.isSafeInteger(a.count) &&
        a.count > 0 &&
        !a.sparse &&
        !a.normalized &&
        (a.byteOffset ?? 0) === 0 &&
        a.count * components * 4 === b.byteLength,
      'GLB accessor',
    );
    return { a, b };
  };
  for (let i = 0; i < parts.parts.length; i++) {
    const node = d.nodes[i];
    check(
      node.mesh === i &&
        !node.children?.length &&
        !node.matrix &&
        !node.translation &&
        !node.rotation &&
        !node.scale &&
        !node.extensions,
      'GLB transforms',
    );
    const primitives = d.meshes[i].primitives;
    check(primitives?.length === 1, 'GLB primitive count');
    for (const p of primitives) {
      check((p.mode ?? 4) === 4 && !p.targets, 'GLB triangles');
      drawUnits++;
      const position = accessor(p.attributes.POSITION, 'VEC3', 3, 5126);
      for (const attr of ['NORMAL', 'COLOR_0'])
        check(
          accessor(p.attributes[attr], 'VEC3', 3, 5126).a.count === position.a.count,
          'GLB vertex count',
        );
      if (!parts.parts[i].ground)
        for (const attr of ['TEXCOORD_0', 'TEXCOORD_1', 'TEXCOORD_2'])
          check(
            accessor(p.attributes[attr], 'VEC2', 2, 5126).a.count === position.a.count,
            'GLB glow attributes',
          );
      for (const id of Object.values(p.attributes) as number[]) {
        const a = d.accessors[id],
          b = d.bufferViews[a.bufferView];
        for (let k = 0; k < b.byteLength; k += 4)
          check(
            Number.isFinite(view.getFloat32(binary + b.byteOffset + k, true)),
            'nonfinite GLB vertex',
          );
      }
      const index = accessor(p.indices, 'SCALAR', 1, 5125);
      check(index.a.count % 3 === 0, 'GLB index count');
      triangles += index.a.count / 3;
      for (let k = 0; k < index.b.byteLength; k += 4)
        check(
          view.getUint32(binary + index.b.byteOffset + k, true) < position.a.count,
          'GLB index bounds',
        );
      const material = d.materials?.[p.material];
      check(
        material &&
          (material.alphaMode ?? 'OPAQUE') === 'OPAQUE' &&
          !material.extensions &&
          !material.pbrMetallicRoughness?.baseColorTexture &&
          material.pbrMetallicRoughness?.baseColorFactor?.[3] === 1,
        'GLB opaque material',
      );
    }
  }
  check(drawUnits <= GROUP_RENDER_LIMITS.drawUnits, 'GLB draw budget');
  return { geometryBytes, triangles, drawUnits };
}
