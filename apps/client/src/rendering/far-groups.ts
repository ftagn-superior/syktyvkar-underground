import { abortablePreparation } from '../streaming/preparation';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer';
import { distanceToBoundsXZ, type Vec3 } from '@su/contracts';
import { shadowCasterRadius } from './shadow-range';
import type { Scene } from '@babylonjs/core/scene';
import type { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import type { AssetContainer } from '@babylonjs/core/assetContainer';
import {
  GROUP_RENDER_LIMITS,
  validateGroupRenderParts,
  inspectGroupGlb,
  type GraphicsGroup,
} from '@su/contracts';
import type { FarGroupView } from '../streaming/groups';
import { loadBuildingContainer } from './building-container';
import { applyRadialFog, type RadialState } from './radial-fog';
import {
  adoptGlowAttribute,
  GLOW_ORIGIN_ATTRIBUTE,
  type WorldNightLights,
} from './environment/night-lights';
import { adoptSurfaceAttribute } from './environment/wall-surface';

export class FarGroups {
  private views = new Set<FarGroupView>();
  private resident = new Set<AssetContainer>();
  private casters = new Set<Mesh>();
  private shadowed = new Set<Mesh>();
  private disposed = false;
  constructor(
    private scene: Scene,
    private shadow: ShadowGenerator,
    private radial: RadialState,
    private lights: WorldNightLights,
  ) {}
  async prepare(
    group: GraphicsGroup,
    read: (path: string, signal?: AbortSignal) => Promise<Uint8Array>,
    signal: AbortSignal,
  ): Promise<FarGroupView> {
    const containers: AssetContainer[] = [],
      meshes: Mesh[] = [],
      lightIds: string[] = [],
      eligible = new Set<Mesh>();
    let active = false,
      disposed = false;
    const metadata = [] as ReturnType<typeof validateGroupRenderParts>[];
    const view: FarGroupView = {
      activate: () => {
        if (disposed || active) return;
        active = true;
        for (const c of containers) c.addAllToScene();
        for (const m of meshes) {
          m.setEnabled(true);
          if (eligible.has(m)) this.casters.add(m);
        }
        for (const p of metadata)
          for (const light of p.lights) {
            this.lights.retainSources(
              {
                entityId: light.entityId,
                assetId: 'hlod',
                position: light.position,
                rotation: light.rotation,
              },
              light.sources,
            );
            lightIds.push(light.entityId);
          }
      },
      dispose: () => {
        if (disposed) return;
        disposed = true;
        signal.removeEventListener('abort', view.dispose);
        for (const m of meshes) {
          this.shadow.removeShadowCaster(m);
          this.casters.delete(m);
          this.shadowed.delete(m);
        }
        for (const id of lightIds) this.lights.releaseSources(id);
        for (const c of containers) {
          this.resident.delete(c);
          c.dispose();
        }
        this.views.delete(view);
      },
    };
    signal.addEventListener('abort', view.dispose, { once: true });
    try {
      if (this.disposed) throw new Error('Far renderer disposed');
      let drawUnits = 0;
      const measured = { geometryBytes: 0, triangles: 0, drawUnits: 0 };
      const lightIdsSeen = new Set<string>();
      for (const resource of group.far.resources) {
        const bytes = await read(resource.partsFile, signal);
        if (bytes.length > GROUP_RENDER_LIMITS.partsBytes) throw new Error('Far parts byte limit');
        const parts = validateGroupRenderParts(
          JSON.parse(new TextDecoder().decode(bytes)),
          group.groupId,
        );
        if (parts.lights.some((l) => !group.memberIds.includes(l.entityId)))
          throw new Error('Far light owner mismatch');
        for (const light of parts.lights) {
          if (lightIdsSeen.has(light.entityId)) throw new Error('Duplicate far light owner');
          lightIdsSeen.add(light.entityId);
        }
        metadata.push(parts);
        const model = await read(resource.modelFile, signal);
        if (model.length > GROUP_RENDER_LIMITS.modelBytes) throw new Error('Far model byte limit');
        const stats = inspectGroupGlb(model, parts);
        for (const key of ['geometryBytes', 'triangles', 'drawUnits'] as const)
          measured[key] += stats[key];
        signal.throwIfAborted();
        const c = await loadBuildingContainer(model, this.scene, `${group.groupId}.glb`);
        if (disposed || signal.aborted || this.disposed) {
          c.dispose();
          signal.throwIfAborted();
          throw new Error('Far renderer disposed');
        }
        containers.push(c);
        this.resident.add(c);
        const renderMeshes = c.meshes.filter((m): m is Mesh => m instanceof Mesh && !!m.geometry);
        if (renderMeshes.length !== parts.parts.length) throw new Error('Far part/node mismatch');
        for (const m of renderMeshes) {
          if (!parts.parts[renderMeshes.indexOf(m)].ground) eligible.add(m);
          m.isPickable = false;
          m.receiveShadows = true;
          adoptGlowAttribute(m);
          adoptSurfaceAttribute(m);
          const origin = m.getVerticesData(VertexBuffer.UV3Kind);
          if (
            !parts.parts[renderMeshes.indexOf(m)].ground &&
            (!origin || origin.length !== m.getTotalVertices() * 2)
          )
            throw new Error('Missing HLOD glow origin attribute');
          if (origin) {
            m.setVerticesData(GLOW_ORIGIN_ATTRIBUTE, origin, false, 2);
            m.removeVerticesData(VertexBuffer.UV3Kind);
          }
          applyRadialFog(m, this.radial, performance.now());
          drawUnits += m.subMeshes?.length ?? 1;
          if (m.material)
            await abortablePreparation(m.material.forceCompilationAsync(m), signal, () => {});
          m.setEnabled(false);
          meshes.push(m);
        }
      }
      signal.throwIfAborted();
      for (const key of ['geometryBytes', 'triangles', 'drawUnits'] as const)
        if (measured[key] !== group.far[key]) throw new Error('Far statistics mismatch');
      if (drawUnits !== group.far.drawUnits || drawUnits > GROUP_RENDER_LIMITS.drawUnits)
        throw new Error('Far draw units mismatch');
      signal.removeEventListener('abort', view.dispose);
      this.views.add(view);
      return view;
    } catch (e) {
      view.dispose();
      throw e;
    }
  }
  residentMeshes() {
    return [...this.resident].flatMap((c) => c.meshes.filter((m): m is Mesh => m instanceof Mesh));
  }
  updateShadows(center: Vec3, visibleRadius: number) {
    const radius = Math.min(shadowCasterRadius(this.shadow), visibleRadius);
    for (const mesh of this.casters) {
      const b = mesh.getBoundingInfo().boundingBox;
      const wanted =
        distanceToBoundsXZ(center, { min: b.minimumWorld, max: b.maximumWorld }) <= radius;
      if (wanted && !this.shadowed.has(mesh)) {
        this.shadow.addShadowCaster(mesh);
        this.shadowed.add(mesh);
      } else if (!wanted && this.shadowed.delete(mesh)) this.shadow.removeShadowCaster(mesh);
    }
  }
  dispose() {
    this.disposed = true;
    for (const v of [...this.views]) v.dispose();
  }
}
