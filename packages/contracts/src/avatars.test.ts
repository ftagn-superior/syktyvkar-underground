import { describe, expect, it } from 'vitest';
import { AVATAR_SKINS, DEFAULT_AVATAR_SKIN, findAvatarSkin, resolveAvatarSkinId } from './avatars';
import { parseProfileUpdate } from './accounts';

describe('avatar catalog and saved profile', () => {
  it.each(AVATAR_SKINS)('accepts the stable catalog ID $id in a profile', (skin) => {
    expect(
      parseProfileUpdate({
        displayName: '  Игрок  ',
        colorId: 'mint',
        skinId: skin.id,
        version: 2,
      }),
    ).toEqual({ displayName: 'Игрок', colorId: 'mint', skinId: skin.id, version: 2 });
    expect(skin.rig).toBe('humanoid-v1');
  });
  it.each([
    undefined,
    null,
    'unknown',
    '__proto__',
    'https://example.com/model.glb',
    { id: 'standard' },
  ])('rejects an unknown selection but supplies a safe rendering fallback for %j', (value) => {
    expect(findAvatarSkin(value)).toBeUndefined();
    expect(
      parseProfileUpdate({ displayName: 'Игрок', colorId: 'mint', skinId: value, version: 1 }),
    ).toBeUndefined();
    expect(resolveAvatarSkinId(value)).toBe(DEFAULT_AVATAR_SKIN);
  });
});

describe('profile colours', () => {
  const base = { displayName: 'Игрок', skinId: 'minifigure', version: 1 };
  it('accepts presets, legacy ids and custom hex, normalising hex', async () => {
    const { parseProfileUpdate, resolveProfileColor } = await import('./accounts.js');
    expect(parseProfileUpdate({ ...base, colorId: 'cyan' })?.colorId).toBe('cyan');
    expect(parseProfileUpdate({ ...base, colorId: 'sky' })?.colorId).toBe('sky');
    expect(parseProfileUpdate({ ...base, colorId: '#1b2a6b' })?.colorId).toBe('#1B2A6B');
    expect(parseProfileUpdate({ ...base, colorId: '#6ee0c4' })?.colorId).toBe('mint');
    expect(parseProfileUpdate({ ...base, colorId: 'nope' })).toBeUndefined();
    expect(parseProfileUpdate({ ...base, colorId: '#12345' })).toBeUndefined();
    expect(resolveProfileColor('sky')?.hex).toBe('#68C8ED');
    expect(resolveProfileColor('#1B2A6B')).toMatchObject({ custom: true, label: 'Свой цвет' });
  });
});
