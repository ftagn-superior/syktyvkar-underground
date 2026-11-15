import { it, expect } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import '@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer';
import { cityLodFixture } from '../../../../tests/fixtures/city-lod.js';
import { visualTemplate } from '../../../../packages/visual-build/src/index.js';
import { FarGroups } from './far-groups';
import { WorldNightLights, GLOW_ORIGIN_ATTRIBUTE } from './environment/night-lights';
import { registerWallSurface } from './environment/wall-surface';
import { WorldClouds } from './environment/clouds';
import { WorldWeatherSurface } from './environment/weather-surface';

it('prepares hidden HLOD with dynamic material plugins, preserves light ownership and releases GPU scene resources', async () => {
  const f = cityLodFixture();
  f.source.templates.house = visualTemplate('silhouette', f.source.templates.house.parts, [
    { position: { x: 0, y: 5, z: 0 }, radius: 12, color: '#ffd49a' },
  ]);
  const publication = f.publish(),
    group = publication.manifest.graphics!.groups[0];
  const engine = new NullEngine(),
    scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  const camera = new ArcRotateCamera('camera', 0, 1, 100, Vector3.Zero(), scene);
  const night = new WorldNightLights(scene),
    clouds = new WorldClouds(scene, camera),
    weather = new WorldWeatherSurface(scene);
  registerWallSurface(scene);
  const shadow = new ShadowGenerator(
    128,
    new DirectionalLight('sun', new Vector3(0, -1, 0), scene),
  );
  const far = new FarGroups(
    scene,
    shadow,
    { center: { x: 0, y: 0, z: 0 }, radius: 1000, time: 0, appearMs: 0 },
    night,
  );
  try {
    const view = await far.prepare(
      group,
      async (path) => publication.payloads.get(path)!,
      new AbortController().signal,
    );
    const meshes = far.residentMeshes().filter((m) => m.geometry);
    expect(meshes).toHaveLength(1);
    expect(meshes.every((m) => !m.isEnabled() && !scene.meshes.includes(m))).toBe(true);
    for (const mesh of meshes) {
      expect(mesh.isPickable).toBe(false);
      expect(Array.from(mesh.getVerticesData(GLOW_ORIGIN_ATTRIBUTE)!.slice(0, 2))).toEqual([
        -127, -30,
      ]);
      expect(mesh.isVerticesDataPresent(VertexBuffer.UV3Kind)).toBe(false);
      for (const plugin of [
        'WorldNightLights',
        'WorldWallSurface',
        'WorldCloudShadow',
        'WorldWeatherSurface',
        'WorldRadialFog',
      ])
        expect(mesh.material!.pluginManager!.getPlugin(plugin)).not.toBeNull();
    }
    view.activate();
    view.activate();
    expect(night.sourceCount).toBe(1);
    expect(meshes.every((m) => m.isEnabled() && scene.meshes.includes(m))).toBe(true);
    far.updateShadows({ x: -127, y: 0, z: -30 }, 1000);
    expect(shadow.getShadowMap()!.renderList).toHaveLength(1);
    night.retainSources(f.world.buildings[0], f.source.templates.house.lights);
    view.dispose();
    expect(night.sourceCount).toBe(1);
    night.releaseSources('west');
    expect(night.sourceCount).toBe(0);
    expect(far.residentMeshes()).toHaveLength(0);
    expect(meshes.every((m) => m.isDisposed() && !scene.meshes.includes(m))).toBe(true);
    expect(shadow.getShadowMap()!.renderList).toHaveLength(0);
  } finally {
    far.dispose();
    weather.dispose();
    clouds.dispose();
    night.dispose();
    scene.dispose();
    engine.dispose();
  }
});
