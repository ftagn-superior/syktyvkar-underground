import { describe, expect, it } from 'vitest';
import { cp, mkdtemp, readFile, rm, writeFile, readdir, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import {
  animationCommand,
  checkAnimations,
  syncAnimations,
  animationContractFiles,
} from '../tools/animations.js';
import { v2Channels } from '../apps/client/src/rendering/avatars/clips/types.js';
import { validateAnimationClips } from '../tools/animation-validation.js';
import { ANIMATIONS, validateAnimationDefinitions } from '../packages/contracts/src/index.js';
import { ANIMATION_CLIPS } from '../apps/client/src/rendering/avatars/animation-clips.js';
import { restingPose, type AvatarPose } from '../apps/client/src/rendering/avatars/locomotion.js';
import baseline from './fixtures/animation-poses.json';

const manifest = 'content/animations/catalog.json';
const directory = 'apps/client/src/rendering/avatars/clips';
async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'su-animation-authoring-'));
  try {
    await cp('content/animations', join(root, 'content/animations'), { recursive: true });
    await cp(directory, join(root, directory), { recursive: true });
    for (const file of await animationContractFiles()) {
      await mkdir(dirname(join(root, file)), { recursive: true });
      await cp(file, join(root, file));
    }
    await syncAnimations(root);
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('animation content pipeline', () => {
  it('keeps every original sampled pose after splitting modules', () => {
    // Captured before the module split; additions need no baseline or count update.
    for (const [id, expected] of Object.entries(baseline.poseHashes)) {
      expect(ANIMATIONS.some((a) => a.id === id)).toBe(true);
      const samples = [];
      for (const reduced of [false, true])
        for (const ms of baseline.phasesMs) {
          const pose = restingPose();
          ANIMATION_CLIPS[id as keyof typeof ANIMATION_CLIPS].sample(pose, ms, reduced);
          const precision = 10 ** baseline.decimalPlaces;
          samples.push({
            ms,
            reduced,
            values: (
              Object.keys(pose)
                .filter((key) => !(v2Channels as readonly string[]).includes(key))
                .sort() as (keyof AvatarPose)[]
            ).map((key) => Math.round(pose[key] * precision) / precision),
          });
        }
      expect(createHash('sha256').update(JSON.stringify(samples)).digest('hex'), id).toBe(expected);
    }
  });
  it('validates the real registry, channel assignment and reduced motion', () => {
    expect(validateAnimationClips(ANIMATIONS, ANIMATION_CLIPS)).toEqual([]);
  });
  it('rejects malformed cosmetic geometry before publishing the catalog', () => {
    const valid = ANIMATION_CLIPS['smoke-cigarette'].prop!;
    for (const prop of [
      { ...valid, anchor: 'world' },
      { ...valid, rotation: [0, Infinity, 0] },
      { ...valid, parts: [] },
      { ...valid, parts: Array(17).fill(valid.parts[0]) },
      ...[
        { shape: 'item' },
        { color: 'red' },
        { size: [0, 0.1, 0.1] },
        { position: [0, NaN, 0] },
        { rotation: [0, 4, 0] },
        { size: [0.01, 0.1, 0.02] },
      ].map((patch) => ({ ...valid, parts: [{ ...valid.parts[0], ...patch }] })),
    ]) {
      expect(
        validateAnimationClips(ANIMATIONS, {
          ...ANIMATION_CLIPS,
          'smoke-cigarette': { ...ANIMATION_CLIPS['smoke-cigarette'], prop },
        } as typeof ANIMATION_CLIPS).join(),
      ).toContain('animation smoke-cigarette: prop');
    }
  });
  it.each([
    [{ id: '' }, 'id must'],
    [{ id: '../escape' }, 'id must'],
    [{ label: ' ' }, 'label must'],
    [{ category: 'Все' }, 'reserved'],
    [{ category: '' }, 'category must'],
    [{ cooldownMs: -1 }, 'cooldownMs'],
    [{ cooldownMs: NaN }, 'cooldownMs'],
    [{ rig: 'other' }, 'rig must'],
    [{ seated: 'standing' }, 'preserve-seat'],
  ])('rejects malformed metadata %j', (patch, message) => {
    expect(validateAnimationDefinitions([{ ...ANIMATIONS[0], ...patch }]).join('\n')).toContain(
      message,
    );
  });
  it('rejects duplicates, missing and orphaned registrations, rig mismatch and bad masks', () => {
    expect(
      validateAnimationClips(ANIMATIONS, {
        ...ANIMATION_CLIPS,
        wave: { ...ANIMATION_CLIPS.wave, periodMs: 1000 },
      }).join(),
    ).toContain('does not repeat after periodMs');
    expect(validateAnimationDefinitions([ANIMATIONS[0], ANIMATIONS[0]]).join()).toContain(
      'duplicate id',
    );
    expect(validateAnimationClips(ANIMATIONS, {}).join()).toContain('wave: missing clip');
    expect(
      validateAnimationClips(ANIMATIONS, {
        ...ANIMATION_CLIPS,
        orphan: ANIMATION_CLIPS.wave,
      }).join(),
    ).toContain('orphan');
    for (const patch of [
      { mask: ['leftLeg'] },
      { mask: ['rightArm', 'rightArm'] },
      { mask: ['facingOffset'] },
      { rig: 'other' },
    ])
      expect(
        validateAnimationClips(ANIMATIONS, {
          ...ANIMATION_CLIPS,
          wave: { ...ANIMATION_CLIPS.wave, ...patch },
        } as typeof ANIMATION_CLIPS).length,
      ).toBeGreaterThan(0);
  });
  it('reports unwritten, deleted, unmasked and increased reduced-motion channels with an ID', () => {
    for (const sample of [
      () => {},
      (pose: AvatarPose) => {
        delete (pose as Partial<AvatarPose>).rightArm;
      },
      (pose: AvatarPose) => {
        pose.leftLeg = 1;
      },
      (pose: AvatarPose, _ms: number, reduced: boolean) => {
        pose.lean = reduced ? 0.4 : 0.1;
      },
    ]) {
      const errors = validateAnimationClips(ANIMATIONS, {
        ...ANIMATION_CLIPS,
        wave: { ...ANIMATION_CLIPS.wave, sample },
      });
      expect(errors.some((e) => e.includes('animation wave:'))).toBe(true);
    }
  });
  it.each(['upperBody', 'fullBody'])(
    'adds a %s template, registrations and a changed fingerprint, then rejects a collision without writes',
    async (mode) => {
      await fixture(async (root) => {
        const original = await checkAnimations(root);
        const result = await animationCommand(root, [
          'add',
          '--id',
          'audit-salute',
          '--label',
          'Отдать честь',
          '--category',
          'Общение',
          '--mode',
          mode,
        ]);
        expect(result.definitions).toHaveLength(original.definitions.length + 1);
        expect(result.version).not.toBe(original.version);
        expect(await readFile(join(root, directory, 'audit-salute.ts'), 'utf8')).toContain(
          `mask: ${mode === 'upperBody' ? 'rightArm' : 'fullBody'}`,
        );
        const metadata = await readFile(join(root, manifest), 'utf8');
        await expect(
          animationCommand(root, [
            'add',
            '--id',
            'audit-salute',
            '--label',
            'Повтор',
            '--category',
            'Общение',
            '--mode',
            mode,
          ]),
        ).rejects.toThrow('duplicate id');
        expect(await readFile(join(root, manifest), 'utf8')).toBe(metadata);
        expect((await checkAnimations(root)).version).toBe(result.version);
        expect(await readdir(join(root, 'content/animations'))).not.toContain('.authoring.lock');
      });
    },
    // Each transaction revalidates the complete catalog's ground geometry on every skin.
    60_000,
  );
  it.each(['variant', 'unavailable'])(
    'generates a complete v2 ground clip with %s wheelchair policy and fingerprints rig sources',
    async (seated) => {
      await fixture(async (root) => {
        const result = await animationCommand(root, [
          'add',
          '--id',
          'audit-ground',
          '--label',
          'Проверка позы',
          '--category',
          'Проверка',
          '--mode',
          'fullBody',
          '--rig',
          'humanoid-v2',
          '--support',
          'ground',
          '--seated',
          seated,
          '--seated-message',
          'Явный вариант или недоступность для коляски.',
          '--reduced-motion',
          'static',
          '--reduced-motion-label',
          'Статичная поза.',
        ]);
        expect(result.definitions.at(-1)).toMatchObject({
          rig: 'humanoid-v2',
          support: 'ground',
          seated,
        });
        const file = await readFile(join(root, directory, 'audit-ground.ts'), 'utf8');
        expect(file).toContain('mask: articulatedBody');
        expect(file.includes('seated: {')).toBe(seated === 'variant');
        const rig = join(root, 'apps/client/src/rendering/avatars/avatar-rig.ts');
        await writeFile(rig, (await readFile(rig, 'utf8')) + '\n// Different rig semantics\n');
        await expect(checkAnimations(root)).rejects.toThrow('fingerprint');
        expect((await syncAnimations(root)).version).not.toBe(result.version);
        const before = await readFile(join(root, manifest), 'utf8');
        await expect(
          animationCommand(root, [
            'add',
            '--id',
            'bad-ground',
            '--label',
            'X',
            '--category',
            'X',
            '--mode',
            'upperBody',
            '--rig',
            'humanoid-v2',
            '--support',
            'ground',
          ]),
        ).rejects.toThrow('ground support');
        expect(await readFile(join(root, manifest), 'utf8')).toBe(before);
        const unsafe = file.replace(
          /sample\(pose\) \{[^}]+\}/,
          `sample(pose) {
            neutralArticulatedPose(pose);
            pose.lift = 0.1;
            pose.rightArmRoll = 2.51;
            pose.rootRoll = -0.94;
            pose.rootYaw = -Math.PI / 4;
            pose.rootX = pose.rootZ = 0.15;
          }`,
        );
        await writeFile(join(root, directory, 'audit-ground.ts'), unsafe);
        const index = join(root, 'packages/contracts/src/animation-catalog.generated.ts');
        const published = await readFile(index, 'utf8');
        await expect(checkAnimations(root)).rejects.toThrow('reserved ground space');
        await expect(syncAnimations(root)).rejects.toThrow('reserved ground space');
        expect(await readFile(index, 'utf8')).toBe(published);
      });
    },
    // Repeated full-catalog skin/vertex checks now include the four released ground clips.
    60_000,
  );
  it('rejects bad arguments without creating files; detects stale indexes and edited clip code', async () => {
    await fixture(async (root) => {
      const before = await readFile(join(root, manifest), 'utf8');
      await expect(
        animationCommand(root, [
          'add',
          '--id',
          'invalid',
          '--label',
          'X',
          '--category',
          'Все',
          '--mode',
          'upperBody',
        ]),
      ).rejects.toThrow('reserved');
      await expect(
        animationCommand(root, [
          'add',
          '--id',
          'invalid',
          '--label',
          'X',
          '--category',
          'C',
          '--mode',
          'upperBody',
          '--period-ms',
          'NaN',
        ]),
      ).rejects.toThrow('period-ms');
      expect(await readFile(join(root, manifest), 'utf8')).toBe(before);
      expect(await readdir(join(root, directory))).not.toContain('invalid.ts');
      const index = join(root, 'packages/contracts/src/animation-catalog.generated.ts');
      await writeFile(index, 'stale');
      await expect(checkAnimations(root)).rejects.toThrow('animations:sync');
      await syncAnimations(root);
      const old = (await checkAnimations(root)).version;
      const file = join(root, directory, 'wave.ts');
      await writeFile(file, (await readFile(file, 'utf8')) + '\n// A new implementation release\n');
      await expect(checkAnimations(root)).rejects.toThrow('fingerprint');
      expect((await syncAnimations(root)).version).not.toBe(old);
      await rm(file);
      await expect(checkAnimations(root)).rejects.toThrow('wave.ts: missing implementation');
    });
  });
});
