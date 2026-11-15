import {
  GRAPHICS_POLICY_VERSION,
  GROUP_RENDER_LIMITS,
  graphicsMembership,
  transformWorldPoint,
  validateGraphicsCoverage,
  validateGroupRenderParts,
  type GraphicsGroup,
  type WorldDefinition,
  type WorldGrid,
  type WorldGraphics,
  type StaticLightSource,
  type GroupRenderParts,
} from '@su/contracts';
import { encodeStaticGlb } from '@su/terrain-build/glb';
import { meshPart, glowOf, surfaceOf, type StaticMeshPart } from '@su/terrain-build/mesh';
import { hash, jsonBytes } from '@su/world-release';
export { simplifyTerrainPart, terrainReplacementError } from './terrain.js';

export interface VisualTemplate {
  version: string;
  kind: 'silhouette' | 'ground' | 'support';
  parts: StaticMeshPart[];
  lights: StaticLightSource[];
}
export interface VisualSource {
  formatVersion: 1;
  policyVersion: typeof GRAPHICS_POLICY_VERSION;
  worldId: string;
  templates: Record<string, VisualTemplate>;
}
export function visualTemplate(
  kind: VisualTemplate['kind'],
  parts: StaticMeshPart[],
  lights: StaticLightSource[] = [],
): VisualTemplate {
  const normalized = parts.map((p) => ({
    ...p,
    ...(p.glow ? { glow: glowOf(p) } : {}),
    ...(p.surface ? { surface: surfaceOf(p) } : {}),
  }));
  const data = JSON.parse(JSON.stringify({ kind, parts: normalized, lights }));
  return { ...data, version: hash(jsonBytes(data)) };
}
export function validateVisualSource(value: unknown, worldId: string): VisualSource {
  const v = value as VisualSource;
  if (
    v?.formatVersion !== 1 ||
    v.policyVersion !== GRAPHICS_POLICY_VERSION ||
    v.worldId !== worldId ||
    !v.templates ||
    Object.keys(v.templates).length > 10_000
  )
    throw new Error('Invalid private visual source');
  for (const [id, t] of Object.entries(v.templates)) {
    if (
      !/^[a-z0-9][a-z0-9-]{0,79}$/.test(id) ||
      !['silhouette', 'ground', 'support'].includes(t.kind) ||
      !Array.isArray(t.parts) ||
      t.parts.length === 0 ||
      t.parts.length > 4096 ||
      !Array.isArray(t.lights)
    )
      throw new Error('Invalid visual template');
    // Templates read from the sealed JSON already contain normalized attributes.
    // Hash them directly instead of cloning the complete geometry through JSON again.
    if (t.version !== hash(jsonBytes({ kind: t.kind, parts: t.parts, lights: t.lights })))
      throw new Error(`Visual template hash mismatch: ${id}`);
    for (const p of t.parts) {
      if (
        !/^#[a-f0-9]{6}$/i.test(p.color) ||
        !Array.isArray(p.positions) ||
        p.positions.length === 0 ||
        p.positions.length > 3_000_000 ||
        p.positions.length % 3 ||
        p.normals.length !== p.positions.length ||
        p.indices.length === 0 ||
        p.indices.length % 3 ||
        !p.positions.every(Number.isFinite) ||
        !p.normals.every(Number.isFinite) ||
        !p.indices.every((i) => Number.isInteger(i) && i >= 0 && i < p.positions.length / 3)
      )
        throw new Error(`Invalid visual geometry: ${id}`);
      for (const [a, stride] of [
        [p.colors, 3],
        [p.glow, 2],
        [p.surface, 2],
      ] as const)
        if (a && (a.length !== (p.positions.length / 3) * stride || !a.every(Number.isFinite)))
          throw new Error('Visual attribute length/value');
    }
  }
  return v;
}
export type PreparedGraphics = { graphics: WorldGraphics; payloads: Map<string, Uint8Array> };
type CachedGroup = {
  dependencies?: string;
  group: GraphicsGroup;
  payloads: Map<string, Uint8Array>;
};
/** Only the latest publication's groups survive. Content dependencies omit global layout revisions. */
export class VisualGroupBuilder {
  private cache = new Map<string, CachedGroup>();
  private sourceVersion?: string;
  /** Seed only verified publication bytes. The encoded version binds the old bytes
   * to newly computed dependencies, so changed poses/templates cannot be reused. */
  seed(graphics: WorldGraphics, payloads: Map<string, Uint8Array>): void {
    if (graphics.policyVersion !== GRAPHICS_POLICY_VERSION) throw new Error('HLOD cache policy');
    this.sourceVersion = graphics.sourceVersion;
    this.cache.clear();
    for (const group of graphics.groups) {
      if (group.far.resources.length !== 1 || group.far.packs?.length) continue;
      const r = group.far.resources[0],
        model = payloads.get(r.modelFile),
        parts = payloads.get(r.partsFile);
      if (model && parts)
        this.cache.set(group.groupId, {
          group,
          payloads: new Map([
            [r.modelFile, model],
            [r.partsFile, parts],
          ]),
        });
    }
  }
  private statistics = { built: 0, reused: 0 };
  diagnostics() {
    return { ...this.statistics, cached: this.cache.size };
  }
  build(
    world: WorldDefinition,
    grid: WorldGrid,
    source: VisualSource,
    sourceVersion = hash(jsonBytes(source)),
    derived: Record<string, VisualTemplate> = {},
  ): PreparedGraphics {
    if (source.worldId !== world.worldId || source.policyVersion !== GRAPHICS_POLICY_VERSION)
      throw new Error('Visual source identity');
    if (this.sourceVersion !== sourceVersion) {
      this.cache.clear();
      this.sourceVersion = sourceVersion;
    }
    const instances = new Map(world.buildings.map((i) => [i.entityId, i])),
      templates = { ...source.templates, ...derived };
    const groups: GraphicsGroup[] = [],
      payloads = new Map<string, Uint8Array>(),
      next = new Map<string, CachedGroup>();
    this.statistics = { built: 0, reused: 0 };
    for (const membership of graphicsMembership(world, grid)) {
      const members = membership.memberIds.map((id) => instances.get(id)!);
      const dependencies = hash(
        jsonBytes({
          membership,
          policy: GRAPHICS_POLICY_VERSION,
          members: members.map((i) => ({
            instance: i,
            asset: world.buildingAssets[i.assetId].bounds,
            template: templates[i.assetId]?.version,
          })),
        }),
      );
      let cached = this.cache.get(membership.groupId);
      const reused =
        cached &&
        (cached.dependencies === dependencies ||
          (cached.dependencies === undefined &&
            cached.group.version ===
              hash(
                jsonBytes({
                  dependencies,
                  model: hash(cached.payloads.get(cached.group.far.resources[0].modelFile)!),
                  parts: hash(cached.payloads.get(cached.group.far.resources[0].partsFile)!),
                }),
              )));
      if (reused) {
        cached = { ...cached!, dependencies };
        this.statistics.reused++;
      } else {
        const merged = new Map<boolean, StaticMeshPart>();
        const lights: GroupRenderParts['lights'] = [];
        for (const i of members) {
          const template = templates[i.assetId];
          if (!template) throw new Error(`No HLOD policy/template for ${i.assetId}`);
          if (template.lights.length)
            lights.push({
              entityId: i.entityId,
              position: i.position,
              rotation: i.rotation,
              sources: template.lights,
            });
          for (const p of template.parts) {
            if (!p.indices.length) continue;
            const ground = template.kind === 'ground';
            let target = merged.get(ground);
            if (!target) {
              target = meshPart(ground ? 'ground' : 'silhouettes', 'detail', '#ffffff');
              target.occlusionGroup = null;
              target.colors = [];
              if (!ground) {
                target.glow = [];
                target.glowOrigin = [];
                target.surface = [];
              }
              merged.set(ground, target);
            }
            const offset = target.positions.length / 3,
              glow = glowOf(p),
              surface = surfaceOf(p);
            const color = [1, 3, 5].map((k) => {
              const c = parseInt(p.color.slice(k, k + 2), 16) / 255;
              return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
            });
            for (let k = 0; k < p.positions.length; k += 3) {
              const pos = transformWorldPoint(
                { x: p.positions[k], y: p.positions[k + 1], z: p.positions[k + 2] },
                i.position,
                i.rotation,
              );
              const normal = transformWorldPoint(
                { x: p.normals[k], y: p.normals[k + 1], z: p.normals[k + 2] },
                { x: 0, y: 0, z: 0 },
                i.rotation,
              );
              target.positions.push(pos.x, pos.y, pos.z);
              target.normals.push(normal.x, normal.y, normal.z);
              target.colors!.push(...color.map((c, j) => c * (p.colors?.[k + j] ?? 1)));
              target.glow?.push(glow?.[(k / 3) * 2] ?? 0, glow?.[(k / 3) * 2 + 1] ?? 0);
              target.surface?.push(surface?.[(k / 3) * 2] ?? 0, surface?.[(k / 3) * 2 + 1] ?? 0);
              target.glowOrigin?.push(i.position.x, i.position.z);
            }
            for (const index of p.indices) target.indices.push(index + offset);
          }
        }
        const parts = [...merged.values()],
          model = encodeStaticGlb(parts);
        if (
          !parts.length ||
          parts.length > GROUP_RENDER_LIMITS.drawUnits ||
          model.byteLength > GROUP_RENDER_LIMITS.modelBytes
        )
          throw new Error(
            `HLOD resource/draw-unit budget: ${membership.groupId} (${model.length})`,
          );
        const metadata = validateGroupRenderParts(
          {
            formatVersion: 1,
            groupId: membership.groupId,
            attributes: 'glow-origin-v1',
            parts: parts.map((p, nodeIndex) => ({ nodeIndex, ground: p.partId === 'ground' })),
            lights,
          },
          membership.groupId,
        );
        const bytes = jsonBytes(metadata);
        if (bytes.length > GROUP_RENDER_LIMITS.partsBytes) throw new Error('HLOD parts budget');
        const version = hash(jsonBytes({ dependencies, model: hash(model), parts: hash(bytes) })),
          prefix = `hlod/${version}`;
        const modelFile = `${prefix}/model.glb`,
          partsFile = `${prefix}/parts.json`;
        const geometryBytes = parts.reduce(
          (n, p) =>
            n +
            4 *
              (p.positions.length +
                p.normals.length +
                p.indices.length +
                (p.colors?.length ?? 0) +
                (p.glow?.length ?? 0) +
                (p.surface?.length ?? 0) +
                (p.glowOrigin?.length ?? 0)),
          0,
        );
        const group: GraphicsGroup = {
          ...membership,
          version,
          far: {
            resources: [{ modelFile, partsFile }],
            geometryBytes,
            triangles: parts.reduce((n, p) => n + p.indices.length / 3, 0),
            drawUnits: parts.length,
          },
        };
        cached = {
          dependencies,
          group,
          payloads: new Map([
            [modelFile, model],
            [partsFile, bytes],
          ]),
        };
        this.statistics.built++;
      }
      next.set(membership.groupId, cached);
      groups.push(cached.group);
      for (const [path, bytes] of cached.payloads) payloads.set(path, bytes);
    }
    validateGraphicsCoverage(world, grid, groups);
    this.cache = next;
    return {
      graphics: { sourceVersion, policyVersion: GRAPHICS_POLICY_VERSION, groups },
      payloads,
    };
  }
}
