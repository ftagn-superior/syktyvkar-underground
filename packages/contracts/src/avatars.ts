/** Stable cosmetic IDs. Rendering factories and previews live in the client. */
export const AVATAR_SKINS = [
  {
    id: 'minifigure',
    label: 'Минифигурка',
    description: 'Улыбка и шарнирные детали',
    rig: 'humanoid-v1',
  },
  { id: 'standard', label: 'Стандартный', description: 'Мягкие формы и визор', rig: 'humanoid-v1' },
] as const;

export type AvatarSkinId = (typeof AVATAR_SKINS)[number]['id'];
export const DEFAULT_AVATAR_SKIN: AvatarSkinId = 'minifigure';
export function findAvatarSkin(value: unknown) {
  return typeof value === 'string' ? AVATAR_SKINS.find((skin) => skin.id === value) : undefined;
}
/** A missing/retired cosmetic must never prevent displaying a player. */
export function resolveAvatarSkinId(value: unknown): AvatarSkinId {
  return findAvatarSkin(value)?.id ?? DEFAULT_AVATAR_SKIN;
}
