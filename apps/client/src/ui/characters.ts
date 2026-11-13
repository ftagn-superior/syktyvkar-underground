import { AVATAR_SKINS, type AvatarSkinId } from '@su/contracts';

/** Data-driven lobby catalog: a new character is one entry here plus its model in the contracts. */
export interface CharacterEntry {
  id: string;
  name: string;
  description: string;
  skinId: AvatarSkinId;
}

export const CHARACTERS: readonly CharacterEntry[] = AVATAR_SKINS.map((skin) => ({
  id: skin.id,
  name: skin.label,
  description: skin.description,
  skinId: skin.id,
}));
/** Закрытые персонажи показываются одной строкой «ещё N появятся с обновлениями». */
export const UPCOMING_CHARACTERS = 4;
export const availableCharacters = (): readonly CharacterEntry[] => CHARACTERS;
