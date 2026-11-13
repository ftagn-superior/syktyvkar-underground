/**
 * Stable cosmetic IDs. Rendering factories and previews live in the client.
 * The array order is the order of the lobby cards.
 */
export const AVATAR_SKINS = [
  { id: 'standard', label: 'Робот', description: 'Мягкие формы и визор', rig: 'humanoid-v1' },
  { id: 'guy', label: 'Парень', description: 'Футболка, джинсы и кеды', rig: 'humanoid-v1' },
  { id: 'girl', label: 'Девушка', description: 'Футболка, юбка и каре', rig: 'humanoid-v1' },
  {
    id: 'komi-guy',
    label: 'Коми-зон',
    description: 'Вышитая рубаха, пояс, шляпа и пимы',
    rig: 'humanoid-v1',
  },
  {
    id: 'komi-girl',
    label: 'Коми-нывка',
    description: 'Дубас, вышитая рубаха и пимы',
    rig: 'humanoid-v1',
  },
  {
    id: 'minifigure',
    label: 'Минифигурка',
    description: 'Улыбка и шарнирные детали',
    rig: 'humanoid-v1',
  },
  { id: 'bear', label: 'Мишка', description: 'Плюшевый мех и вязаный свитер', rig: 'humanoid-v1' },
  {
    id: 'bear-wheelchair',
    label: 'Мишка в коляске',
    description: 'Свитер и коляска с крутящимися колёсами',
    rig: 'humanoid-v1',
  },
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
