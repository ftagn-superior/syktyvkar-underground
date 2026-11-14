import { AVATAR_SKINS } from '../packages/contracts/src/avatars.js';
import { validateAnimationDefinitions } from '../packages/contracts/src/animation-validation.js';
import type { AnimationDefinition } from '../packages/contracts/src/animations.js';
import { restingPose, type AvatarPose } from '../apps/client/src/rendering/avatars/locomotion.js';
import { arms, type AnimationClip } from '../apps/client/src/rendering/avatars/clips/types.js';

/** Authoring gate. Sampling probes are diagnostics, not proof for every real-valued time. */
export function validateAnimationClips(
  definitions: readonly AnimationDefinition[],
  clips: Readonly<Record<string, AnimationClip>>,
): string[] {
  const errors = validateAnimationDefinitions(definitions);
  const keys = Object.keys(restingPose()) as (keyof AvatarPose)[];
  const ids = new Set(definitions.map((entry) => entry.id));
  for (const id of Object.keys(clips))
    if (!ids.has(id)) errors.push(`animation ${id}: orphan clip without metadata`);
  for (const entry of definitions) {
    const fail = (reason: string) => errors.push(`animation ${entry.id}: ${reason}`);
    const clip = clips[entry.id];
    if (!clip) {
      fail('missing clip registration');
      continue;
    }
    if (clip.rig !== entry.rig) fail(`clip rig ${clip.rig} does not match metadata ${entry.rig}`);
    for (const skin of AVATAR_SKINS)
      if (skin.rig !== entry.rig) fail(`incompatible skin ${skin.id}: ${skin.rig}`);
    if (!Number.isFinite(clip.periodMs) || clip.periodMs < 100 || clip.periodMs > 60_000) {
      fail('periodMs must be finite and in 100..60000 milliseconds');
      continue;
    }
    if (
      !Array.isArray(clip.mask) ||
      clip.mask.length === 0 ||
      new Set(clip.mask).size !== clip.mask.length
    ) {
      fail('mask must be a nonempty array of unique channels');
      continue;
    }
    let invalid = false;
    for (const joint of clip.mask as readonly (keyof AvatarPose)[]) {
      if (!keys.includes(joint) || joint === 'facingOffset') {
        fail(`invalid mask channel ${joint}`);
        invalid = true;
      }
      if (entry.mode === 'upperBody' && !(arms as readonly string[]).includes(joint)) {
        fail(`upperBody mask cannot animate ${joint}`);
        invalid = true;
      }
    }
    if (invalid) continue;
    if (typeof clip.sample !== 'function' || clip.sample.constructor.name !== 'Function') {
      fail('sample must be a synchronous function');
      continue;
    }
    for (const reduced of [false, true]) {
      const first = restingPose(),
        repeated = restingPose();
      try {
        clip.sample(first, 137, reduced);
        clip.sample(repeated, 137 + clip.periodMs, reduced);
        if (
          (clip.mask as readonly (keyof AvatarPose)[]).some(
            (joint) => Math.abs(first[joint] - repeated[joint]) > 1e-7,
          )
        ) {
          fail(`sample does not repeat after periodMs=${clip.periodMs} (reduced=${reduced})`);
          invalid = true;
        }
      } catch (error) {
        fail(`sample threw while checking its period: ${String(error)}`);
        invalid = true;
      }
    }
    if (invalid) continue;
    for (const ms of [
      ...Array.from({ length: 33 }, (_, i) => (clip.periodMs * i) / 16),
      clip.periodMs * 1024 + 137,
    ]) {
      const normal = restingPose();
      for (const reduced of [false, true]) {
        const pose = restingPose();
        for (const joint of clip.mask as readonly (keyof AvatarPose)[]) pose[joint] = NaN;
        try {
          clip.sample(pose, ms, reduced);
        } catch (error) {
          fail(`sample threw at ${ms}ms (reduced=${reduced}): ${String(error)}`);
          continue;
        }
        for (const joint of [...new Set([...keys, ...Object.keys(pose)])] as (keyof AvatarPose)[]) {
          if (!keys.includes(joint)) fail(`sample added unknown channel ${joint}`);
          else if (
            !Number.isFinite(pose[joint]) ||
            Math.abs(pose[joint]) > (joint === 'lift' ? 0.1 : Math.PI)
          )
            fail(
              `${joint} is unwritten, non-finite or out of bounds at ${ms}ms (reduced=${reduced})`,
            );
          else if (!clip.mask.includes(joint) && pose[joint] !== restingPose()[joint])
            fail(`sample writes outside mask: ${joint}`);
        }
        if (!reduced) Object.assign(normal, pose);
        else
          for (const joint of ['lean', 'roll', 'lift'] as const)
            if (Math.abs(pose[joint]) > Math.abs(normal[joint]) + 1e-10)
              fail(`reduced motion increases ${joint} at ${ms}ms`);
      }
    }
  }
  return [...new Set(errors)];
}
