import { validateAnimationDefinitions } from '../packages/contracts/src/animation-validation.js';
import {
  isGroundAnimation,
  type AnimationDefinition,
} from '../packages/contracts/src/animations.js';
import { restingPose, type AvatarPose } from '../apps/client/src/rendering/avatars/locomotion.js';
import {
  arms,
  articulatedArms,
  articulatedBody,
  rootChannels,
  v2Channels,
  type AnimationClip,
  type AnimationSampler,
} from '../apps/client/src/rendering/avatars/clips/types.js';

type Channel = keyof AvatarPose;
const has = (channels: readonly string[], channel: string) => channels.includes(channel);
export function animationChannelBounds(channel: Channel): readonly [number, number] {
  if (channel === 'leftElbow' || channel === 'rightElbow') return [-2.7, 0];
  if (channel === 'leftKnee' || channel === 'rightKnee') return [0, 2.7];
  if (channel === 'rootX' || channel === 'rootZ') return [-0.15, 0.15];
  if (channel === 'rootY') return [0, 0.15];
  if (has(rootChannels, channel)) return [-2 * Math.PI, 2 * Math.PI];
  if (channel === 'lift') return [-0.1, 0.1];
  return [-Math.PI, Math.PI];
}

/** Sampling probes are diagnostics, not proof for every real-valued time. */
export function validateAnimationClips(
  definitions: readonly AnimationDefinition[],
  clips: Readonly<Record<string, AnimationClip>>,
): string[] {
  const errors = validateAnimationDefinitions(definitions);
  const neutral = restingPose();
  const keys = Object.keys(neutral) as Channel[];
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
    if (clip.prop) {
      const prop = clip.prop;
      const vector = (values: readonly number[] | undefined, limit: number, positive = false) =>
        Array.isArray(values) &&
        values.length === 3 &&
        values.every(
          (value) => Number.isFinite(value) && Math.abs(value) <= limit && (!positive || value > 0),
        );
      if (
        !['right-hand', 'body'].includes(prop.anchor) ||
        (prop.rotation !== undefined && !vector(prop.rotation, Math.PI)) ||
        !Array.isArray(prop.parts) ||
        prop.parts.length < 1 ||
        prop.parts.length > 16 ||
        prop.parts.some((part) => {
          return (
            !part ||
            !['box', 'cylinder'].includes(part.shape) ||
            !vector(part.size, 1, true) ||
            !vector(part.position, 1) ||
            (part.rotation !== undefined && !vector(part.rotation, Math.PI)) ||
            !/^#[a-f\d]{6}$/i.test(part.color) ||
            (part.shape === 'cylinder' && part.size[0] !== part.size[2])
          );
        })
      )
        fail(
          'prop must have a supported anchor and 1..16 bounded box/cylinder parts with hex colors',
        );
    }
    if (clip.rig !== entry.rig) fail(`clip rig ${clip.rig} does not match metadata ${entry.rig}`);
    if (!Number.isFinite(clip.periodMs) || clip.periodMs < 100 || clip.periodMs > 60_000) {
      fail('periodMs must be finite and in 100..60000 milliseconds');
      continue;
    }
    const needsVariant = entry.rig === 'humanoid-v2' && entry.seated === 'variant';
    if (needsVariant !== !!clip.seated)
      fail('seated variant must exist iff metadata says seated=variant');
    const variants: [string, AnimationSampler][] = [['standing', clip]];
    if (clip.seated) variants.push(['seated', clip.seated]);
    for (const [variant, sampler] of variants) {
      const problem = (reason: string) => fail(`${variant}: ${reason}`);
      if (
        !sampler ||
        !Array.isArray(sampler.mask) ||
        !sampler.mask.length ||
        new Set(sampler.mask).size !== sampler.mask.length
      ) {
        problem('mask must be a nonempty array of unique channels');
        continue;
      }
      const mask = sampler.mask as readonly Channel[];
      let invalid = false;
      for (const channel of mask) {
        if (!keys.includes(channel) || channel === 'facingOffset') {
          problem(`invalid mask channel ${channel}`);
          invalid = true;
        }
        if (entry.rig === 'humanoid-v1' && has(v2Channels, channel)) {
          problem(`v1 mask cannot animate ${channel}`);
          invalid = true;
        }
        if (
          (entry.mode === 'upperBody' ||
            variant === 'seated' ||
            entry.seated === 'preserve-seat') &&
          entry.rig === 'humanoid-v2' &&
          !has(articulatedArms, channel)
        ) {
          problem(`upperBody/preserve-seat mask cannot animate ${channel}`);
          invalid = true;
        }
        if (entry.rig === 'humanoid-v1' && entry.mode === 'upperBody' && !has(arms, channel)) {
          problem(`upperBody mask cannot animate ${channel}`);
          invalid = true;
        }
        if (has(rootChannels, channel) && !isGroundAnimation(entry)) {
          problem(`${channel} requires ground support`);
          invalid = true;
        }
      }
      if (
        variant === 'standing' &&
        isGroundAnimation(entry) &&
        articulatedBody.some((channel) => !mask.includes(channel))
      ) {
        problem('ground mask must cover articulatedBody to replace locomotion completely');
        invalid = true;
      }
      if (typeof sampler.sample !== 'function' || sampler.sample.constructor.name !== 'Function') {
        problem('sample must be a synchronous function');
        continue;
      }
      if (invalid) continue;
      for (const reduced of [false, true]) {
        const first = restingPose(),
          repeated = restingPose();
        try {
          sampler.sample(first, 137, reduced);
          sampler.sample(repeated, 137 + clip.periodMs, reduced);
          if (mask.some((channel) => Math.abs(first[channel] - repeated[channel]) > 1e-7))
            problem(`sample does not repeat after periodMs=${clip.periodMs} (reduced=${reduced})`);
        } catch (error) {
          problem(`sample threw while checking its period: ${String(error)}`);
        }
      }
      const reducedFirst = restingPose();
      for (const ms of [
        ...Array.from({ length: 65 }, (_, i) => (clip.periodMs * i) / 32),
        clip.periodMs * 1024 + 137,
      ]) {
        const normal = restingPose();
        for (const reduced of [false, true]) {
          const pose = restingPose();
          for (const channel of mask) pose[channel] = NaN;
          const tracked = new Proxy(pose, {
            set(target, key, value) {
              if (!mask.includes(key as Channel))
                problem(`sample writes outside mask: ${String(key)}`);
              return Reflect.set(target, key, value);
            },
            deleteProperty(target, key) {
              problem(`sample deletes channel ${String(key)}`);
              return Reflect.deleteProperty(target, key);
            },
          });
          try {
            sampler.sample(tracked, ms, reduced);
          } catch (error) {
            problem(`sample threw at ${ms}ms (reduced=${reduced}): ${String(error)}`);
            continue;
          }
          for (const channel of [...new Set([...keys, ...Object.keys(pose)])] as Channel[]) {
            const [min, max] = animationChannelBounds(channel);
            if (!keys.includes(channel)) problem(`sample added unknown channel ${channel}`);
            else if (
              !Number.isFinite(pose[channel]) ||
              pose[channel] < min - 1e-10 ||
              pose[channel] > max + 1e-10
            )
              problem(
                `${channel} is unwritten, non-finite or out of bounds [${min},${max}] at ${ms}ms (reduced=${reduced})`,
              );
            else if (!mask.includes(channel) && pose[channel] !== neutral[channel])
              problem(`sample writes outside mask: ${channel}`);
          }
          if (!reduced) Object.assign(normal, pose);
          else if (entry.rig === 'humanoid-v2' && entry.reducedMotion === 'static') {
            if (ms === 0) Object.assign(reducedFirst, pose);
            if (mask.some((channel) => Math.abs(pose[channel] - reducedFirst[channel]) > 1e-9))
              problem(`static reduced motion changes pose at ${ms}ms`);
          } else {
            for (const channel of ['lean', 'roll', 'lift', ...v2Channels] as const)
              if (Math.abs(pose[channel]) > Math.abs(normal[channel]) + 1e-10)
                problem(`reduced motion increases ${channel} at ${ms}ms`);
          }
        }
      }
    }
  }
  return [...new Set(errors)];
}
