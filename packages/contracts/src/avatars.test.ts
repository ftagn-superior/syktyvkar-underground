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
