import { describe, expect, it } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import '@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent';
import { AVATAR_SKINS, type AnimationId } from '@su/contracts';
import type { DisplayPlayer } from '../../presentation/display-state';
import { AvatarView } from './avatar-view';

describe('cosmetic animation props', () => {
  it.each(AVATAR_SKINS)('owns, replaces and releases props on $id', ({ id: skinId }) => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const shadow = new ShadowGenerator(128, new DirectionalLight('sun', Vector3.Down(), scene));
    const root = new TransformNode('props', scene);
    const avatar = new AvatarView(
      root,
      scene,
      shadow,
      {
        height: 1.8,
        radius: 0.35,
        speed: 4,
        sprintSpeed: 14,
        mass: 70,
      },
      skinId,
    );
    const player: DisplayPlayer = {
      entityId: 'props',
      kind: 'player',
      skinId,
      revision: 0,
      motionRevision: 0,
      motionEnabled: true,
      grounded: true,
      connected: true,
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      velocity: { x: 0, y: 0, z: 0 },
      angularVelocity: { x: 0, y: 0, z: 0 },
    };
    const baseMeshes = scene.meshes.length;
    const baseMaterials = scene.materials.length;
    let sequence = 0;
    const play = (id?: AnimationId) => {
      player.animation = id
        ? {
            animationId: id,
            worldEpoch: 'test',
            sequence: ++sequence,
            startedAtTick: 0,
            endsAtTick: 0,
            changedAtTick: 0,
            displayTick: 180,
            displayTimeMs: sequence * 4000,
          }
        : undefined;
      avatar.update(player, 1 / 60, false, false);
    };
    try {
      for (const id of ['smoke-cigarette', 'drink-beer', 'use-laptop'] as const) {
        play(id);
        const mesh = scene.getMeshByName('animation-prop-props')!;
        expect(mesh).toBeTruthy();
        expect(mesh.isPickable).toBe(false);
        expect(mesh.parent?.name).toBe(id === 'use-laptop' ? 'pose-props' : 'rightHand-props');
        expect(scene.meshes).toHaveLength(baseMeshes + 1);
        expect(scene.materials).toHaveLength(baseMaterials + 1);
        for (let frame = 0; frame < 120; frame++) {
          player.animation!.displayTick += 1;
          avatar.update(player, 1 / 60, false, frame % 2 === 0);
          expect(scene.getMeshByName('animation-prop-props')).toBe(mesh);
          expect(Array.from(mesh.computeWorldMatrix(true).m).every(Number.isFinite)).toBe(true);
        }
        player.connected = false;
        avatar.update(player, 1 / 60, false, false);
        expect(mesh.material!.alpha).toBeCloseTo(0.45);
        player.connected = true;
        play('wave');
        expect(mesh.isDisposed()).toBe(true);
        expect(scene.meshes).toHaveLength(baseMeshes);
        expect(scene.materials).toHaveLength(baseMaterials);
        play(id);
        player.grounded = false;
        avatar.update(player, 1 / 60, false, false);
        expect(avatar.diagnostics().prop).toBeUndefined();
        player.grounded = true;
        play(id);
        player.animation!.endsAtTick = player.animation!.displayTick;
        avatar.update(player, 1 / 60, false, false);
        expect(avatar.diagnostics().prop).toBeUndefined();
      }
      // A v2 pose lazily splits the limbs. Returning to a prop clip must retain its grip.
      play('drink-beer');
      for (let i = 0; i < 20; i++) {
        player.animation!.displayTimeMs! += 20;
        avatar.update(player, 1 / 60, false, true);
      }
      scene.getMeshByName('animation-prop-props')!.computeWorldMatrix(true);
      const gripBefore = scene.getMeshByName('animation-prop-props')!.getAbsolutePosition().clone();
      play('sit');
      expect(avatar.diagnostics().prop).toBeUndefined();
      play('drink-beer');
      for (let i = 0; i < 20; i++) {
        player.animation!.displayTimeMs! += 20;
        avatar.update(player, 1 / 60, false, true);
      }
      scene.getMeshByName('animation-prop-props')!.computeWorldMatrix(true);
      const gripAfter = scene.getMeshByName('animation-prop-props')!.getAbsolutePosition();
      // Extra joint matrices use Float32 coordinates; tolerate less than 0.1 mm.
      expect(Vector3.Distance(gripBefore, gripAfter)).toBeLessThan(0.0001);
      play('use-laptop');
      const oldProp = scene.getMeshByName('animation-prop-props')!;
      player.skinId = skinId === 'bear-wheelchair' ? 'guy' : 'bear-wheelchair';
      avatar.update(player, 1 / 60, false, false);
      expect(oldProp.isDisposed()).toBe(true);
      expect(avatar.diagnostics().prop?.anchor).toBe('body');
      play();
      expect(avatar.diagnostics().prop).toBeUndefined();
    } finally {
      avatar.dispose();
      root.dispose();
      expect(scene.meshes).toHaveLength(0);
      expect(shadow.getShadowMap()!.renderList).toHaveLength(0);
      scene.dispose();
      engine.dispose();
    }
  });
});
