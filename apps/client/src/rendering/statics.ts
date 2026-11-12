import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import type { Scene } from '@babylonjs/core/scene';
import type { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import { canonicalJson, type StaticEntityDefinition } from '@su/contracts';
import { obstacleAccent } from './world-decoration';

export class StaticViews {
  private readonly instances = new Map<
    string,
    { mesh: Mesh; signature: string; references: number; color: string }
  >();
  private readonly materials = new Map<string, { value: StandardMaterial; users: number }>();
  constructor(
    private readonly scene: Scene,
    private readonly shadow: ShadowGenerator,
  ) {}
  add(entity: StaticEntityDefinition, version: string) {
    const signature = version + canonicalJson(entity);
    const previous = this.instances.get(entity.entityId);
    if (previous) {
      if (previous.signature !== signature)
        throw new Error(`Conflicting primitive/version: ${entity.entityId}`);
      previous.references++;
      return;
    }
    const mesh = MeshBuilder.CreateBox(
      entity.entityId,
      { width: entity.size.x, height: entity.size.y, depth: entity.size.z },
      this.scene,
    );
    mesh.position.set(entity.position.x, entity.position.y, entity.position.z);
    let material = this.materials.get(entity.color);
    if (!material) {
      const value = new StandardMaterial(`static-${entity.color}`, this.scene);
      value.diffuseColor = Color3.FromHexString(entity.color);
      value.specularColor = new Color3(0.07, 0.09, 0.1);
      value.specularPower = 48;
      this.materials.set(entity.color, (material = { value, users: 0 }));
    }
    material.users++;
    mesh.material = material.value;
    mesh.receiveShadows = true;
    mesh.isPickable = false;
    mesh.freezeWorldMatrix();
    if (!entity.entityId.startsWith('ground-')) {
      this.shadow.addShadowCaster(mesh);
      mesh.enableEdgesRendering();
      mesh.edgesWidth = 0.6;
      const accent = obstacleAccent(entity);
      mesh.edgesColor = accent
        ? Color4.FromHexString(`${accent}66`)
        : new Color4(0.65, 0.77, 0.79, 0.18);
    }
    this.instances.set(entity.entityId, { mesh, signature, references: 1, color: entity.color });
  }
  remove(id: string) {
    const entry = this.instances.get(id);
    if (!entry || --entry.references > 0) return;
    this.instances.delete(id);
    this.shadow.removeShadowCaster(entry.mesh);
    entry.mesh.dispose();
    const material = this.materials.get(entry.color)!;
    if (!--material.users) {
      material.value.dispose();
      this.materials.delete(entry.color);
    }
  }
  dispose() {
    for (const [id, entry] of this.instances) {
      entry.references = 1;
      this.remove(id);
    }
  }
}
