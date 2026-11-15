import { describe, expect, it } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { Vector3, Quaternion } from '@babylonjs/core/Maths/math.vector';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import '@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent';
import {
  AVATAR_SKINS,
  ANIMATIONS,
  animationSkinSupport,
  findAnimation,
  validateAnimationDefinitions,
  type AnimationId,
} from '../packages/contracts/src/index';
import { ANIMATION_CLIPS } from '../apps/client/src/rendering/avatars/animation-clips';
import { AvatarRig } from '../apps/client/src/rendering/avatars/avatar-rig';
import { SKIN_BUILDERS } from '../apps/client/src/rendering/avatars/skins';
import {
  CharacterAnimator,
  type AvatarMotion,
} from '../apps/client/src/rendering/avatars/character-animator';
import { restingPose } from '../apps/client/src/rendering/avatars/locomotion';
import { type AnimationClip } from '../apps/client/src/rendering/avatars/clips/types';
import { rigDefinitions, rigClips, rigLibrary } from './fixtures/animation-rig';
import { validateAnimationClips } from '../tools/animation-validation';
import { validateAnimationRigs } from '../tools/animation-rig-validation';

function sceneFixture() {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  const shadow = new ShadowGenerator(64, new DirectionalLight('sun', new Vector3(0, -1, 0), scene));
  return {
    scene,
    shadow,
    close: () => {
      scene.dispose();
      engine.dispose();
    },
  };
}
const library = {
  find: (id: unknown) => rigLibrary.find(id) ?? findAnimation(id),
  clips: { ...ANIMATION_CLIPS, ...rigClips },
};
function frame(id = 'rig-sit'): AvatarMotion {
  return {
    entityId: 'p',
    skinId: 'minifigure',
    revision: 0,
    motionRevision: 0,
    motionEnabled: true,
    connected: true,
    position: { x: 0, y: 0.9, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    velocity: { x: 0, y: 0, z: 0 },
    grounded: true,
    animation: {
      animationId: id as AnimationId,
      sequence: 1,
      startedAtTick: 0,
      endsAtTick: 0,
      changedAtTick: 0,
      worldEpoch: 'test',
      displayTick: 60,
      displayTimeMs: 1000,
    },
  };
}

describe('humanoid-v2 contract and actual geometry', () => {
  it('validates four technical clips, all skins, support, transitions and both motion settings', () => {
    expect(validateAnimationClips(rigDefinitions, rigClips)).toEqual([]);
    expect(validateAnimationRigs(rigDefinitions, rigClips)).toEqual([]);
    expect(ANIMATIONS.some((a) => a.id.startsWith('rig-'))).toBe(false);
  });
  it.each(AVATAR_SKINS)(
    'keeps $id neutral geometry and physical root, articulates real child meshes, and releases resources',
    (skin) => {
      const fixture = sceneFixture();
      const { scene, shadow } = fixture;
      try {
        for (const height of [1.5, 1.8, 2.1]) {
          const config = {
            height,
            radius: (height * 0.35) / 1.8,
            speed: 4,
            sprintSpeed: 14,
            mass: 70,
          };
          const root = new TransformNode('rig', scene);
          root.position.set(2, height / 2, 3);
          root.rotationQuaternion = Quaternion.Identity();
          const rig = new AvatarRig(root, scene, shadow);
          SKIN_BUILDERS[skin.id](rig, config);
          const pose = restingPose();
          rig.applyPose(pose, height);
          const neutral = rig.bounds();
          rig.applyPose(pose, height, 0, 0, true);
          const articulated = rig.bounds();
          for (const bound of ['min', 'max'] as const)
            for (const axis of ['x', 'y', 'z'] as const)
              expect(articulated[bound][axis]).toBeCloseTo(neutral[bound][axis], 5);
          expect(rig.leftElbow.parent).toBe(rig.leftShoulder);
          expect(rig.leftKnee.parent).toBe(rig.leftHip);
          const upper = scene.meshes.find((mesh) => mesh.parent === rig.leftShoulder)!;
          const lower = scene.meshes.find((mesh) => mesh.parent === rig.leftElbow)!;
          const upperBefore = Array.from(upper.computeWorldMatrix(true).m);
          const lowerBefore = Array.from(lower.computeWorldMatrix(true).m);
          pose.leftElbow = -1.2;
          rig.applyPose(pose, height, 0, 0, true);
          expect(Array.from(upper.computeWorldMatrix(true).m)).toEqual(upperBefore);
          expect(Array.from(lower.computeWorldMatrix(true).m)).not.toEqual(lowerBefore);
          for (const definition of rigDefinitions) {
            const capability = animationSkinSupport(definition, skin.id);
            if (capability === 'unavailable') continue;
            const clip = rigClips[definition.id as keyof typeof rigClips];
            const sampler = capability === 'variant' ? clip.seated! : clip;
            for (const ms of [0, 750, 1500, 3000, 4500, 5999])
              for (const reduced of [false, true]) {
                const sampled = restingPose();
                sampler.sample(sampled, ms, reduced);
                rig.applyPose(sampled, height, 0, capability === 'variant' ? 0 : 1, true);
                expect(root.position.asArray()).toEqual([2, height / 2, 3]);
                expect(root.rotationQuaternion!.asArray()).toEqual([0, 0, 0, 1]);
                if (capability !== 'variant')
                  expect(rig.bounds().min.y).toBeCloseTo(sampled.rootY * height, 5);
                else {
                  expect(rig.posture.position.y).toBe(0);
                  expect(rig.leftHip.rotation.asArray()).toEqual([0, 0, 0]);
                  expect(rig.leftKnee.rotation.x).toBe(0);
                }
              }
          }
          rig.applyPose(restingPose(), height);
          expect(rig.posture.position.asArray()).toEqual([0, 0, 0]);
          expect(rig.posture.rotation.asArray()).toEqual([0, 0, 0]);
          expect(rig.leftElbow.rotation.x).toBe(0);
          rig.dispose();
          root.dispose();
          expect(scene.meshes).toHaveLength(0);
          expect(scene.transformNodes).toHaveLength(0);
          expect(shadow.getShadowMap()!.renderList).toHaveLength(0);
        }
      } finally {
        fixture.close();
      }
    },
  );
  it('rejects missing skin policies, mixed versions, missing variants, unsafe masks, bad hinges and moving reduced alternatives', () => {
    const definition = rigDefinitions[0];
    for (const patch of [
      { support: 'air' },
      { seated: 'preserve-seat' },
      { seatedMessage: '' },
      { reducedMotion: 'scaled' },
      { reducedMotionLabel: '' },
      { rig: 'humanoid-v3' },
    ])
      expect(validateAnimationDefinitions([{ ...definition, ...patch }]).length).toBeGreaterThan(0);
    const invalid: AnimationClip[] = [
      { ...rigClips['rig-sit'], seated: undefined },
      { ...rigClips['rig-sit'], mask: ['rootRoll'] },
      { ...rigClips['rig-sit'], rig: 'humanoid-v1' },
      {
        ...rigClips['rig-sit'],
        sample(pose) {
          rigClips['rig-sit'].sample(pose, 0, false);
          pose.leftElbow = 1;
        },
      },
      {
        ...rigClips['rig-sit'],
        sample(pose) {
          rigClips['rig-sit'].sample(pose, 0, false);
          pose.rootY = -0.1;
        },
      },
      {
        ...rigClips['rig-sit'],
        sample(pose, ms) {
          rigClips['rig-sit'].sample(pose, 0, false);
          pose.rootX = 0.1 * Math.sin((ms * Math.PI * 2) / 4000);
        },
      },
      {
        ...rigClips['rig-sit'],
        sample(pose) {
          rigClips['rig-sit'].sample(pose, 0, false);
          pose.rightKnee = NaN;
        },
      },
    ];
    for (const clip of invalid)
      expect(
        validateAnimationClips([definition], { [definition.id]: clip }).length,
      ).toBeGreaterThan(0);
    expect(
      validateAnimationClips([ANIMATIONS[0]], {
        wave: {
          ...ANIMATION_CLIPS.wave,
          mask: ['rightElbow'],
          sample(pose) {
            pose.rightElbow = -1;
          },
        },
      }).join(),
    ).toContain('v1 mask');
    expect(
      validateAnimationClips([ANIMATIONS[0]], {
        wave: {
          ...ANIMATION_CLIPS.wave,
          sample(pose, ms, reduced) {
            ANIMATION_CLIPS.wave.sample(pose, ms, reduced);
            pose.leftLeg = 0;
          },
        },
      }).join(),
    ).toContain('outside mask');
    const shifted = {
      ...rigClips['rig-sit'],
      sample(pose: ReturnType<typeof restingPose>) {
        rigClips['rig-sit'].sample(pose, 0, false);
        pose.rootX = 1;
      },
    };
    expect(validateAnimationRigs([definition], { [definition.id]: shifted }).join()).toContain(
      'reserved ground space',
    );
  });
});

describe('v2 animator on local, observer and skin/reduced transitions', () => {
  it('uses the same absolute phase, restores every new channel after a legacy replacement and cancels on motion', () => {
    const local = new CharacterAnimator(4, 14, library),
      observer = new CharacterAnimator(4, 14, library);
    const state = frame('rig-cartwheel');
    local.update(state, 1 / 60, true);
    observer.update(state, 1 / 37, false);
    expect(local.pose).toEqual(observer.pose);
    expect(local.supportWeight).toBe(1);
    expect(Math.abs(local.pose.rootRoll)).toBeGreaterThan(0.5);
    state.animation!.sequence++;
    state.animation!.animationId = 'wave';
    state.animation!.startedAtTick = 60;
    for (let i = 0; i <= 20; i++) {
      state.animation!.displayTick = 60 + i;
      state.animation!.displayTimeMs = 1000 + (i * 1000) / 60;
      local.update(state, 1 / 60, true);
    }
    expect(local.supportWeight).toBe(0);
    for (const channel of [
      'rootPitch',
      'rootYaw',
      'rootRoll',
      'rootX',
      'rootY',
      'rootZ',
      'leftElbow',
      'rightElbow',
      'leftKnee',
      'rightKnee',
    ] as const)
      expect(local.pose[channel]).toBeCloseTo(0, 10);
    const moving = frame();
    moving.velocity.x = 1;
    local.update(moving, 1 / 60, true);
    expect(local.diagnostics().animation.reason).toBe('moving');
    expect(local.supportWeight).toBe(0);
  });
  it('exposes wheelchair unavailability, uses its explicit sit variant and discards history on a skin change', () => {
    const animator = new CharacterAnimator(4, 14, library),
      state = frame('rig-lie');
    animator.update(state, 1 / 60, true);
    expect(animator.supportWeight).toBe(1);
    state.skinId = 'bear-wheelchair';
    animator.update(state, 1 / 60, true);
    expect(animator.diagnostics().animation.reason).toBe('unsupported-skin');
    expect(animator.supportWeight).toBe(0);
    expect(animator.pose.rootPitch).toBe(0);
    state.animation!.sequence++;
    state.animation!.animationId = 'rig-sit' as AnimationId;
    animator.update(state, 1 / 60, true);
    expect(animator.diagnostics().animation.reason).toBe('playing');
    expect(animator.pose.leftKnee).toBe(0);
    expect(animator.pose.leftElbow).toBe(-0.7);
    state.grounded = false;
    animator.update(state, 1 / 60, true);
    expect(animator.supportWeight).toBe(0);
    expect(animator.pose.leftElbow).toBe(0);
  });
  it('keeps the named reduced cartwheel alternative still while normal mode rotates', () => {
    const animator = new CharacterAnimator(4, 14, library),
      state = frame('rig-cartwheel');
    animator.update(state, 1 / 60, true, true);
    const initial = { ...animator.pose };
    state.animation!.displayTick = 210;
    state.animation!.displayTimeMs = 3500;
    animator.update(state, 1 / 60, true, true);
    expect(animator.pose).toEqual(initial);
    animator.update(state, 1 / 60, true, false);
    expect(animator.pose.rootRoll).not.toBe(initial.rootRoll);
  });
});
