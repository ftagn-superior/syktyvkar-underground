import { describe, expect, it } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer';
import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import '@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent';
import {
  AVATAR_SKINS,
  GROUND_ANIMATION_SPACE,
  NEUTRAL_INPUT,
  type AnimationDefinition,
} from '../packages/contracts/src';
import { AvatarRig } from '../apps/client/src/rendering/avatars/avatar-rig';
import { SKIN_BUILDERS } from '../apps/client/src/rendering/avatars/skins';
import { restingPose } from '../apps/client/src/rendering/avatars/locomotion';
import {
  articulatedBody,
  neutralArticulatedPose,
  type AnimationClip,
} from '../apps/client/src/rendering/avatars/clips/types';
import { validateAnimationClips } from '../tools/animation-validation';
import { validateAnimationRigs } from '../tools/animation-rig-validation';
import { createAuthoritativeWorld } from '../packages/simulation/src/server';
import { physicsFixture } from '../packages/simulation/src/test-fixture';
import { rigDefinitions, rigClips } from './fixtures/animation-rig';

const definition: AnimationDefinition = {
  id: 'review-yaw',
  label: 'Ground yaw probe',
  category: 'Review',
  cooldownMs: 1000,
  mode: 'fullBody',
  rig: 'humanoid-v2',
  support: 'ground',
  seated: 'unavailable',
  seatedMessage: 'Not seated',
  reducedMotion: 'static',
  reducedMotionLabel: 'Static pose',
};
function probe(offset: number): AnimationClip {
  return {
    rig: 'humanoid-v2',
    periodMs: 4000,
    mask: articulatedBody,
    sample(pose) {
      neutralArticulatedPose(pose);
      pose.lift = 0.1;
      pose.rightArmRoll = 2.51;
      pose.rootRoll = -0.94;
      pose.rootYaw = -Math.PI / 4;
      pose.rootX = pose.rootZ = offset;
    },
  };
}
function fixture(skin: keyof typeof SKIN_BUILDERS, height: number) {
  const engine = new NullEngine(),
    scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  const shadow = new ShadowGenerator(64, new DirectionalLight('sun', new Vector3(0, -1, 0), scene));
  const root = new TransformNode('body', scene);
  root.position.y = height / 2;
  const rig = new AvatarRig(root, scene, shadow);
  SKIN_BUILDERS[skin](rig, {
    height,
    radius: (height * 0.35) / 1.8,
    speed: 4,
    sprintSpeed: 14,
    mass: 70,
  });
  return {
    root,
    rig,
    // Independent oracle: read rendered vertices rather than the cached rig envelope.
    points() {
      return scene.meshes.flatMap((mesh) => {
        if (!mesh.isDescendantOf(rig.posture)) return [];
        const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
        if (!positions) return [];
        const matrix = mesh.computeWorldMatrix(true),
          points: Vector3[] = [];
        for (let i = 0; i < positions.length; i += 3)
          points.push(Vector3.TransformCoordinates(Vector3.FromArray(positions, i), matrix));
        return points;
      });
    },
    close() {
      rig.dispose();
      root.dispose();
      scene.dispose();
      engine.dispose();
    },
  };
}

describe('ground pose space in every facing direction', () => {
  it('rejects the review counterexample whose diagonal vertices intersect an unreserved wall', async () => {
    const clip = probe(0.15),
      radius = 1.8 * GROUND_ANIMATION_SPACE.halfWidth;
    expect(validateAnimationClips([definition], { [definition.id]: clip })).toEqual([]);
    const body = fixture('minifigure', 1.8);
    const worldDefinition = physicsFixture();
    worldDefinition.initialItems = [];
    worldDefinition.entities = [
      worldDefinition.entities[0],
      {
        entityId: 'review-wall',
        kind: 'obstacle',
        position: { x: 1.5, y: 1, z: 0 },
        size: { x: 0.04, y: 2, z: 6 },
        mass: 0,
        friction: 0.6,
        restitution: 0,
        color: '#fff',
      },
    ];
    const world = await createAuthoritativeWorld(worldDefinition);
    try {
      const pose = restingPose();
      clip.sample(pose, 1000, false);
      body.rig.applyPose(pose, 1.8, 0, 1, true);
      const initial = body.rig.bounds();
      expect(Math.max(initial.max.x, initial.max.z)).toBeLessThan(radius);
      body.root.rotationQuaternion = Quaternion.RotationAxis(Vector3.Up(), Math.PI / 4);
      body.rig.applyPose(pose, 1.8, 0, 1, true);
      expect(body.rig.bounds().max.x).toBeCloseTo(1.581143, 5);
      expect(
        body
          .points()
          .filter((p) => p.x > 1.48 && p.x < 1.52 && p.y > 0 && p.y < 2 && Math.abs(p.z) < 3)
          .length,
      ).toBeGreaterThan(0);
      world.addPlayer('p');
      world.setInput('p', { ...NEUTRAL_INPUT, facingYaw: Math.PI / 4 });
      for (let i = 0; i < 90; i++) world.step();
      // The wall is beyond the promised area. Such a clip must fail publication.
      expect(world.checkAnimationSpace('p')).toBe(true);
      expect(validateAnimationRigs([definition], { [definition.id]: clip }).join()).toContain(
        'reserved ground space',
      );

      // A valid pose remains usable in the very same place and direction.
      const safe = probe(0.09);
      expect(validateAnimationRigs([definition], { [definition.id]: safe })).toEqual([]);
      safe.sample(pose, 1000, false);
      body.rig.applyPose(pose, 1.8, 0, 1, true);
      expect(body.rig.bounds().max.x).toBeLessThan(radius);
      expect(body.points().some((p) => p.x > 1.48 && p.x < 1.52)).toBe(false);
      body.root.rotationQuaternion = Quaternion.Identity();
      body.rig.applyPose(pose, 1.8, 0, 1, true);
      const valid = body.rig.bounds();
      // An empty AABB corner is outside the disk, but all real vertices fit.
      // Rejecting hypot(maxAbsX,maxAbsZ) would incorrectly remove this legal pose.
      expect(Math.hypot(valid.max.x, valid.max.z)).toBeGreaterThan(radius);
      expect(valid.horizontalRadius).toBeLessThan(radius);
    } finally {
      world.dispose();
      body.close();
    }
  });

  for (const skin of AVATAR_SKINS.filter((s) => s.id !== 'bear-wheelchair'))
    it.each([1.5, 1.8, 2.1])(
      `contains ${skin.id} at height %s, including boundary offsets and facing smoothing`,
      (height) => {
        const body = fixture(skin.id, height),
          radius = height * GROUND_ANIMATION_SPACE.halfWidth;
        body.root.position.set(3, height / 2, -2);
        try {
          const clips = [
            probe(0.09),
            ...rigDefinitions.map((a) => rigClips[a.id as keyof typeof rigClips]),
          ];
          for (const clip of clips)
            for (const reduced of [false, true])
              for (const yaw of [
                0,
                Math.PI / 4,
                Math.PI / 2,
                (3 * Math.PI) / 4,
                Math.PI,
                -Math.PI / 4,
              ])
                for (const weight of [0.25, 0.5, 0.75, 1]) {
                  const target = restingPose(),
                    pose = restingPose();
                  clip.sample(target, clip.periodMs / 2, reduced);
                  for (const channel of clip.mask)
                    pose[channel] += (target[channel] - pose[channel]) * weight;
                  pose.facingOffset = 0.37; // The independent local smoothing can add any yaw.
                  body.root.rotationQuaternion = Quaternion.RotationAxis(Vector3.Up(), yaw);
                  body.rig.applyPose(pose, height, 0, weight, true);
                  const points = body.points();
                  const reach = Math.max(...points.map((p) => Math.hypot(p.x - 3, p.z + 2)));
                  expect(reach, `${clip.periodMs}/${reduced}/${yaw}/${weight}`).toBeLessThanOrEqual(
                    radius + 0.001,
                  );
                  expect(body.rig.bounds().horizontalRadius).toBeCloseTo(reach, 5);
                  expect(
                    Math.max(...points.map((p) => Math.max(Math.abs(p.x - 3), Math.abs(p.z + 2)))),
                  ).toBeLessThanOrEqual(radius + 0.001);
                }
        } finally {
          body.close();
        }
      },
    );
});
