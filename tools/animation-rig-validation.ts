import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { Scene } from '@babylonjs/core/scene.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight.js';
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator.js';
import '@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent.js';
import { AVATAR_SKINS } from '../packages/contracts/src/avatars.js';
import {
  animationSkinSupport,
  GROUND_ANIMATION_SPACE,
  isGroundAnimation,
  type AnimationDefinition,
} from '../packages/contracts/src/animations.js';
import { AvatarRig } from '../apps/client/src/rendering/avatars/avatar-rig.js';
import { SKIN_BUILDERS } from '../apps/client/src/rendering/avatars/skins/index.js';
import { restingPose } from '../apps/client/src/rendering/avatars/locomotion.js';
import type { AnimationClip } from '../apps/client/src/rendering/avatars/clips/types.js';

/** v2 must fit the server's reserved space on actual skins, including entry/exit poses.
 * Uses neutral geometry, not an assumed human proportion or a renderer dependency in contracts.
 */
export function validateAnimationRigs(
  definitions: readonly AnimationDefinition[],
  clips: Readonly<Record<string, AnimationClip>>,
): string[] {
  const v2 = definitions.filter((a) => a.rig === 'humanoid-v2');
  if (!v2.length) return [];
  const errors = new Set<string>();
  const engine = new NullEngine();
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  const shadow = new ShadowGenerator(
    64,
    new DirectionalLight('validation', new Vector3(0, -1, 0), scene),
  );
  const config = { height: 1.8, radius: 0.35, speed: 4, sprintSpeed: 14, mass: 70 };
  try {
    for (const definition of v2)
      for (const skin of AVATAR_SKINS) {
        const capability = animationSkinSupport(definition, skin.id);
        if (capability === 'unavailable') continue;
        const clip = clips[definition.id];
        const sampler = capability === 'variant' ? clip?.seated : clip;
        if (!sampler) continue; // The channel validator reports missing/invalid samplers first.
        const root = new TransformNode(`${skin.id}-${definition.id}`, scene);
        root.position.y = config.height / 2;
        const rig = new AvatarRig(root, scene, shadow);
        SKIN_BUILDERS[skin.id](rig, config);
        try {
          for (const reduced of [false, true])
            for (let i = 0; i < 33; i++) {
              const target = restingPose();
              sampler.sample(target, (clip.periodMs * i) / 32, reduced);
              for (const weight of isGroundAnimation(definition) && capability !== 'variant'
                ? [0.25, 0.5, 0.75, 1]
                : [1]) {
                const pose = restingPose();
                for (const channel of sampler.mask)
                  pose[channel] += (target[channel] - pose[channel]) * weight;
                const ground = isGroundAnimation(definition) && capability !== 'variant';
                rig.applyPose(pose, config.height, 0, ground ? weight : 0, true);
                const bounds = rig.bounds();
                const fail = (reason: string) =>
                  errors.add(
                    `animation ${definition.id}: skin ${skin.id}, reduced=${reduced}, phase=${i}/32, blend=${weight}: ${reason}`,
                  );
                if (
                  ![
                    ...bounds.min.asArray(),
                    ...bounds.max.asArray(),
                    bounds.horizontalRadius,
                  ].every(Number.isFinite)
                )
                  fail('non-finite rig geometry');
                if (!ground) continue;
                const radius = config.height * GROUND_ANIMATION_SPACE.halfWidth;
                if (
                  // The server reserves a world-axis box. A disk fits that box at every
                  // entity yaw, including the animator's independent facing smoothing.
                  bounds.horizontalRadius > radius + 0.001 ||
                  bounds.max.y > config.height * GROUND_ANIMATION_SPACE.height + 0.001
                )
                  fail(
                    'pose leaves the reserved ground space at some facing; reduce horizontal reach (root offset or limb spread)',
                  );
                if (bounds.min.y < -0.001) fail('pose penetrates its support plane');
                if (weight === 1 && Math.abs(bounds.min.y - pose.rootY * config.height) > 0.001)
                  fail('pose does not meet its declared support clearance');
              }
            }
        } finally {
          rig.dispose();
          root.dispose();
        }
      }
  } finally {
    scene.dispose();
    engine.dispose();
  }
  return [...errors];
}
