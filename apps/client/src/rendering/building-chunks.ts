import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer';
import { Material } from '@babylonjs/core/Materials/material';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Scene } from '@babylonjs/core/scene';
import type { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import { applyRadialFog, type RadialState } from './radial-fog';
import { GLOW_ATTRIBUTE, GLOW_ORIGIN_ATTRIBUTE } from './environment/night-lights';
import { SURFACE_ATTRIBUTE } from './environment/wall-surface';

export type ChunkBuilding = {
  id: string;
  position: { x: number; z: number };
  meshes: Mesh[];
  /** The caller owns detail culling and occlusion; changes must call touch(). */
  eligible: () => boolean;
};
type Merged = { mesh: Mesh; originals: Mesh[]; bytes: number; shadow: boolean };
type Cell = {
  x: number;
  z: number;
  buildings: Map<string, ChunkBuilding>;
  age: number;
  attempted: boolean;
  merged: Merged[];
  pending: Merged[];
  pendingFrames: number;
  blockedOnBudget: boolean;
};
type Part = {
  mesh: Mesh;
  material: PBRMaterial;
  vertices: number;
  indices: number;
  shadow: boolean;
};

const CELL_SIZE = 125;
const ATTRIBUTES = new Set([
  VertexBuffer.PositionKind,
  VertexBuffer.NormalKind,
  VertexBuffer.ColorKind,
  VertexBuffer.UVKind,
  VertexBuffer.UV2Kind,
  GLOW_ATTRIBUTE,
  SURFACE_ATTRIBUTE,
]);
// Built-in PBR settings are part of the serialized material signature. Runtime plugins
// below depend on world coordinates or attributes explicitly preserved by this merger.
const PLUGINS = new Set([
  'PBRBRDF',
  'PBRClearCoat',
  'PBRIridescence',
  'PBRAnisotropic',
  'Sheen',
  'PBRSubSurface',
  'DetailMap',
  'WorldNightLights',
  'WorldWallSurface',
  'WorldCloudShadow',
  'WorldWeatherSurface',
  'WorldRadialFog',
]);
/** Position, normal, RGBA, glow, glow origin and wall surface: 16 floats per vertex. */
const VERTEX_BYTES = 16 * Float32Array.BYTES_PER_ELEMENT;

/**
 * Runtime draw-call reduction. Originals remain available for picking and immediate
 * restoration; only stable, distant cells receive a duplicate render-only geometry.
 */
export class BuildingChunks {
  private readonly cells = new Map<string, Cell>();
  private readonly owners = new Map<string, Cell>();
  private readonly hidden = new Set<Mesh>();
  private bytes = 0;
  private maxBuildMs = 0;
  private builds = 0;
  private readonly settleFrames: number;
  private readonly maxBytes: number;
  private readonly maxCellBytes: number;

  constructor(
    private readonly scene: Scene,
    private readonly shadows: ShadowGenerator,
    private readonly radial?: RadialState,
    options: { settleFrames?: number; maxBytes?: number; maxCellBytes?: number } = {},
  ) {
    this.settleFrames = options.settleFrames ?? 45;
    // These count buffer payloads, each of which also has a CPU copy in Babylon.
    this.maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
    this.maxCellBytes = options.maxCellBytes ?? 4 * 1024 * 1024;
  }

  add(building: ChunkBuilding): void {
    if (this.owners.has(building.id)) throw new Error(`Duplicate chunk building: ${building.id}`);
    const x = Math.floor(building.position.x / CELL_SIZE);
    const z = Math.floor(building.position.z / CELL_SIZE);
    const key = `${x},${z}`;
    let cell = this.cells.get(key);
    if (!cell) {
      cell = {
        x,
        z,
        buildings: new Map(),
        age: 0,
        attempted: false,
        merged: [],
        pending: [],
        pendingFrames: 0,
        blockedOnBudget: false,
      };
      this.cells.set(key, cell);
    }
    this.restore(cell);
    cell.buildings.set(building.id, building);
    this.owners.set(building.id, cell);
  }

  remove(id: string): void {
    const cell = this.owners.get(id);
    if (!cell) return;
    this.restore(cell);
    cell.buildings.delete(id);
    this.owners.delete(id);
    if (!cell.buildings.size) this.cells.delete(`${cell.x},${cell.z}`);
  }

  /** Restore before changing visibility, material, geometry or shadow membership. */
  touch(id: string): void {
    const cell = this.owners.get(id);
    if (cell) this.restore(cell);
  }

  isMerged(id: string): boolean {
    return (
      this.owners
        .get(id)
        ?.buildings.get(id)
        ?.meshes.some((mesh) => this.hidden.has(mesh)) ?? false
    );
  }

  isMeshMerged(mesh: Mesh): boolean {
    return this.hidden.has(mesh);
  }

  update(center?: Vector3, excluded: ReadonlySet<string> = new Set()): void {
    const excludedCells = new Set<Cell>();
    for (const id of excluded) {
      const cell = this.owners.get(id);
      if (cell) excludedCells.add(cell);
    }
    const x = center ? Math.floor(center.x / CELL_SIZE) : 0;
    const z = center ? Math.floor(center.z / CELL_SIZE) : 0;
    let candidate: Cell | undefined;
    for (const cell of this.cells.values()) {
      if (
        !center ||
        (Math.abs(cell.x - x) <= 1 && Math.abs(cell.z - z) <= 1) ||
        excludedCells.has(cell)
      ) {
        this.restore(cell);
        continue;
      }
      if (cell.pending.length) {
        if (cell.pending.every((group) => group.mesh.isReady(true))) this.activate(cell);
        else if (++cell.pendingFrames >= 120) {
          this.restore(cell);
          cell.attempted = true;
        }
        continue;
      }
      if (cell.merged.length || cell.attempted) continue;
      if (++cell.age >= this.settleFrames && !candidate) candidate = cell;
    }
    if (candidate) {
      candidate.attempted = true;
      const start = performance.now();
      this.build(candidate);
      this.maxBuildMs = Math.max(this.maxBuildMs, performance.now() - start);
    }
  }

  private restore(cell: Cell): void {
    const releasesMemory = cell.pending.length > 0 || cell.merged.length > 0;
    for (const group of cell.pending) {
      group.mesh.dispose(false, true);
      this.bytes -= group.bytes;
    }
    cell.pending.length = 0;
    cell.pendingFrames = 0;
    for (const group of cell.merged) {
      this.shadows.removeShadowCaster(group.mesh);
      group.mesh.dispose(false, true);
      this.bytes -= group.bytes;
      for (const mesh of group.originals) {
        this.hidden.delete(mesh);
        mesh.setEnabled(true);
        if (group.shadow) this.shadows.addShadowCaster(mesh);
      }
    }
    cell.merged.length = 0;
    cell.age = 0;
    cell.attempted = false;
    cell.blockedOnBudget = false;
    if (releasesMemory)
      for (const waiting of this.cells.values())
        if (waiting.blockedOnBudget) {
          waiting.blockedOnBudget = false;
          waiting.attempted = false;
        }
  }

  private materialKey(material: PBRMaterial): string | undefined {
    if (
      material.getClassName() !== 'PBRMaterial' ||
      material.alpha !== 1 ||
      material.anisotropy.isEnabled ||
      material.clearCoat.isEnabled ||
      material.iridescence.isEnabled ||
      material.sheen.isEnabled ||
      material.detailMap.isEnabled ||
      material.subSurface.isRefractionEnabled ||
      material.subSurface.isTranslucencyEnabled ||
      material.subSurface.isScatteringEnabled ||
      material.getActiveTextures().length ||
      material.animations?.length ||
      material.shadowDepthWrapper ||
      typeof material.customShaderNameResolve === 'function' ||
      material.onBindObservable.hasObservers() ||
      material.fillMode !== Material.TriangleFillMode ||
      material.pluginManager?._plugins.some((plugin) => !PLUGINS.has(plugin.name))
    )
      return;
    const serialized = material.serialize();
    for (const key of ['name', 'id', 'uniqueId', 'albedo', 'metadata', 'tags'])
      delete serialized[key];
    return JSON.stringify(serialized);
  }

  private build(cell: Cell): void {
    const casters = new Set(this.shadows.getShadowMap()?.renderList ?? []);
    const signatures = new Map<PBRMaterial, string | undefined>();
    const groups = new Map<string, Part[]>();
    let estimatedBytes = 0;
    for (const building of cell.buildings.values()) {
      if (!building.eligible()) continue;
      for (const mesh of building.meshes) {
        const material = mesh.material;
        if (
          !(material instanceof PBRMaterial) ||
          !mesh.isEnabled() ||
          !mesh.isVisible ||
          mesh.visibility !== 1 ||
          mesh.skeleton ||
          mesh.morphTargetManager ||
          mesh.animations.length ||
          mesh.hasThinInstances ||
          mesh.subMeshes.length !== 1 ||
          mesh.subMeshes[0].indexStart !== 0 ||
          mesh.subMeshes[0].indexCount !== mesh.getTotalIndices() ||
          material.needAlphaBlendingForMesh(mesh) ||
          material.needAlphaTestingForMesh(mesh) ||
          !mesh.isVerticesDataPresent(VertexBuffer.NormalKind) ||
          mesh.getVerticesDataKinds().some((kind) => !ATTRIBUTES.has(kind))
        )
          continue;
        const born = mesh.metadata?.suStreamingBorn;
        if (this.radial && born !== undefined && this.radial.time - born < this.radial.appearMs) {
          // Streaming appearance is per original mesh. Retry after it has fully appeared.
          cell.attempted = false;
          return;
        }
        if (!signatures.has(material)) signatures.set(material, this.materialKey(material));
        const signature = signatures.get(material);
        if (signature === undefined) continue;
        const vertices = mesh.getTotalVertices();
        const indices = mesh.getTotalIndices();
        const determinant = mesh.getWorldMatrix().determinant();
        if (
          !vertices ||
          !indices ||
          indices % 3 ||
          !Number.isFinite(determinant) ||
          Math.abs(determinant) < 1e-10
        )
          continue;
        estimatedBytes += vertices * VERTEX_BYTES + indices * Uint32Array.BYTES_PER_ELEMENT;
        if (estimatedBytes > this.maxCellBytes) return;
        if (this.bytes + estimatedBytes > this.maxBytes) {
          cell.blockedOnBudget = true;
          return;
        }
        const shadow = casters.has(mesh);
        const key = JSON.stringify([
          signature,
          mesh.sideOrientation,
          mesh.receiveShadows,
          mesh.renderingGroupId,
          mesh.layerMask,
          shadow,
        ]);
        let parts = groups.get(key);
        if (!parts) groups.set(key, (parts = []));
        parts.push({ mesh, material, vertices, indices, shadow });
      }
    }
    const built: Merged[] = [];
    try {
      for (const parts of groups.values()) {
        if (parts.length < 2) continue;
        built.push(this.merge(cell, parts));
      }
    } catch (error) {
      for (const group of built) group.mesh.dispose(false, true);
      throw error;
    }
    cell.pending = built;
    for (const group of built) this.bytes += group.bytes;
    // Compile before hiding originals: loading a new main-pass effect must not flash a hole.
    if (built.length && built.every((group) => group.mesh.isReady(true))) this.activate(cell);
  }

  private activate(cell: Cell): void {
    for (const group of cell.pending) {
      for (const mesh of group.originals) {
        mesh.setEnabled(false);
        this.hidden.add(mesh);
        if (group.shadow) this.shadows.removeShadowCaster(mesh);
      }
      group.mesh.setEnabled(true);
      if (group.shadow) this.shadows.addShadowCaster(group.mesh);
    }
    cell.merged = cell.pending;
    cell.pending = [];
    cell.pendingFrames = 0;
    this.builds++;
  }

  private merge(cell: Cell, parts: Part[]): Merged {
    const count = parts.reduce((n, part) => n + part.vertices, 0);
    const indexCount = parts.reduce((n, part) => n + part.indices, 0);
    const positions = new Float32Array(count * 3),
      normals = new Float32Array(count * 3);
    const colors = new Float32Array(count * 4),
      glow = new Float32Array(count * 2);
    const origins = new Float32Array(count * 2),
      surface = new Float32Array(count * 2);
    const indices = new Uint32Array(indexCount);
    let vertexOffset = 0,
      indexOffset = 0;
    const point = new Vector3();
    for (const { mesh, material, vertices } of parts) {
      const world = mesh.getWorldMatrix();
      const normalMatrix = Matrix.Transpose(Matrix.Invert(world));
      const sourcePositions = mesh.getVerticesData(VertexBuffer.PositionKind)!;
      const sourceNormals = mesh.getVerticesData(VertexBuffer.NormalKind)!;
      const sourceColors = mesh.useVertexColors
        ? mesh.getVerticesData(VertexBuffer.ColorKind)
        : null;
      const colorStride = sourceColors ? sourceColors.length / vertices : 0;
      const sourceGlow = mesh.getVerticesData(GLOW_ATTRIBUTE);
      const sourceSurface = mesh.getVerticesData(SURFACE_ATTRIBUTE);
      for (let i = 0; i < vertices; i++) {
        const target = vertexOffset + i;
        Vector3.FromArrayToRef(sourcePositions, i * 3, point);
        Vector3.TransformCoordinatesToRef(point, world, point);
        point.toArray(positions, target * 3);
        Vector3.FromArrayToRef(sourceNormals, i * 3, point);
        Vector3.TransformNormalToRef(point, normalMatrix, point);
        point.normalize().toArray(normals, target * 3);
        colors[target * 4] = material.albedoColor.r * (sourceColors?.[i * colorStride] ?? 1);
        colors[target * 4 + 1] =
          material.albedoColor.g * (sourceColors?.[i * colorStride + 1] ?? 1);
        colors[target * 4 + 2] =
          material.albedoColor.b * (sourceColors?.[i * colorStride + 2] ?? 1);
        colors[target * 4 + 3] =
          mesh.hasVertexAlpha && colorStride === 4 ? sourceColors![i * 4 + 3] : 1;
        glow[target * 2] = sourceGlow?.[i * 2] ?? 0;
        glow[target * 2 + 1] = sourceGlow?.[i * 2 + 1] ?? 0;
        surface[target * 2] = sourceSurface?.[i * 2] ?? 0;
        surface[target * 2 + 1] = sourceSurface?.[i * 2 + 1] ?? 0;
        origins[target * 2] = world.m[12];
        origins[target * 2 + 1] = world.m[14];
      }
      const sourceIndices = mesh.getIndices()!;
      const flipped = world.determinant() < 0;
      for (let i = 0; i < sourceIndices.length; i += 3) {
        indices[indexOffset++] = sourceIndices[i] + vertexOffset;
        indices[indexOffset++] = sourceIndices[i + (flipped ? 2 : 1)] + vertexOffset;
        indices[indexOffset++] = sourceIndices[i + (flipped ? 1 : 2)] + vertexOffset;
      }
      vertexOffset += vertices;
    }
    const first = parts[0];
    const mesh = new Mesh(`building-chunk:${cell.x},${cell.z}:${first.mesh.uniqueId}`, this.scene);
    mesh.setEnabled(false);
    try {
      const material = first.material.clone(`${mesh.name}:material`);
      mesh.material = material;
      material.albedoColor.set(1, 1, 1);
      mesh.sideOrientation = first.mesh.sideOrientation;
      mesh.receiveShadows = first.mesh.receiveShadows;
      mesh.renderingGroupId = first.mesh.renderingGroupId;
      mesh.layerMask = first.mesh.layerMask;
      mesh.isPickable = false;
      const data = new VertexData();
      Object.assign(data, { positions, normals, colors, indices });
      data.applyToMesh(mesh);
      mesh.setVerticesData(GLOW_ATTRIBUTE, glow, false, 2);
      mesh.setVerticesData(GLOW_ORIGIN_ATTRIBUTE, origins, false, 2);
      mesh.setVerticesData(SURFACE_ATTRIBUTE, surface, false, 2);
      if (this.radial) applyRadialFog(mesh, this.radial, -Infinity);
      mesh.freezeWorldMatrix();
      return {
        mesh,
        originals: parts.map((part) => part.mesh),
        bytes: count * VERTEX_BYTES + indexCount * 4,
        shadow: first.shadow,
      };
    } catch (error) {
      mesh.dispose(false, true);
      throw error;
    }
  }

  diagnostics() {
    return {
      buildingChunks: [...this.cells.values()].filter((cell) => cell.merged.length > 0).length,
      buildingChunkMeshes: [...this.cells.values()].reduce((n, cell) => n + cell.merged.length, 0),
      buildingChunkOriginalMeshes: this.hidden.size,
      buildingChunkGeometryBytes: this.bytes,
      buildingChunkBuilds: this.builds,
      buildingChunkMaxBuildMs: this.maxBuildMs,
    };
  }

  dispose(): void {
    for (const cell of this.cells.values()) this.restore(cell);
    this.cells.clear();
    this.owners.clear();
  }
}
