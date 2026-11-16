import { describe, expect, it } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { Vector3, Quaternion } from '@babylonjs/core/Maths/math.vector';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import '@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent';
import { ANIMATIONS, AVATAR_SKINS, animationSkinSupport } from '@su/contracts';
import { AvatarView } from './avatar-view';
import type { DisplayPlayer } from '../../presentation/display-state';

describe('all catalog clips on actual skin rigs', () => {
  it.each(AVATAR_SKINS)('keeps $id finite, cosmetic, reduced and correctly seated', (skin) => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const shadow = new ShadowGenerator(
      128,
      new DirectionalLight('sun', new Vector3(0, -1, 0), scene),
    );
    try {
      for (const definition of ANIMATIONS) {
        const root = new TransformNode('matrix', scene);
        root.position.set(3, 0.9, 4);
        root.rotationQuaternion = Quaternion.Identity();
        const avatar = new AvatarView(
          root,
          scene,
          shadow,
          { height: 1.8, radius: 0.35, speed: 4, sprintSpeed: 14, mass: 70 },
          skin.id,
        );
        const player: DisplayPlayer = {
          kind: 'player',
          entityId: 'matrix',
          skinId: skin.id,
          revision: 0,
          motionRevision: 0,
          motionEnabled: true,
          connected: true,
          grounded: true,
          position: { x: 3, y: 0.9, z: 4 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
          velocity: { x: 0, y: 0, z: 0 },
          angularVelocity: { x: 0, y: 0, z: 0 },
          animation: {
            animationId: definition.id,
            worldEpoch: 'matrix',
            sequence: 1,
            startedAtTick: 0,
            endsAtTick: 0,
            changedAtTick: 0,
            displayTick: 60,
          },
        };
        try {
          for (const ms of [825, 1800]) {
            const amplitudes: number[][] = [];
            for (const reduced of [false, true]) {
              player.animation!.displayTick = ms * 0.06;
              player.animation!.displayTimeMs = ms;
              avatar.update(player, 1 / 60, true, reduced);
              expect(avatar.diagnostics().animation.reason).toBe(
                animationSkinSupport(definition, skin.id) === 'unavailable'
                  ? 'unsupported-skin'
                  : 'playing',
              );
              expect(root.position.asArray()).toEqual([3, 0.9, 4]);
              for (const node of scene.transformNodes)
                expect(Array.from(node.computeWorldMatrix(true).m).every(Number.isFinite)).toBe(
                  true,
                );
              const body = scene.getTransformNodeByName('pose-matrix')!;
              amplitudes.push([body.rotation.x, body.rotation.z, body.position.y].map(Math.abs));
              if (skin.id === 'bear-wheelchair') {
                expect(body.position.y).toBeCloseTo(0, 12);
                for (const hip of ['leftHip', 'rightHip'])
                  expect(
                    scene
                      .getTransformNodeByName(`${hip}-matrix`)!
                      .rotation.asArray()
                      .every((value) => value === 0),
                  ).toBe(true);
              }
            }
            amplitudes[1].forEach((value, i) =>
              expect(value).toBeLessThanOrEqual(amplitudes[0][i] + 1e-10),
            );
          }
        } finally {
          avatar.dispose();
          root.dispose();
        }
        expect(scene.meshes).toHaveLength(0);
        expect(scene.transformNodes).toHaveLength(0);
        expect(shadow.getShadowMap()!.renderList).toHaveLength(0);
      }
    } finally {
      scene.dispose();
      engine.dispose();
    }
  });
});
