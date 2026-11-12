import { AVATAR_SKINS, type AvatarSkinId } from '@su/contracts';

/** Data-driven lobby catalog: a new character is one entry here plus its model in the contracts. */
export interface CharacterEntry {
  id: string;
  name: string;
  description: string;
  /** Present only for characters that can actually be played. */
  skinId?: AvatarSkinId;
  locked: boolean;
}

const placeholders: CharacterEntry[] = Array.from({ length: 10 }, (_, index) => ({
  id: `locked-${index + 3}`,
  name: `Персонаж ${String(index + 3).padStart(2, '0')}`,
  description: 'Появится с обновлениями',
  locked: true,
}));

export const CHARACTERS: readonly CharacterEntry[] = [
  ...AVATAR_SKINS.map((skin) => ({
    id: skin.id,
    name: skin.label,
    description: skin.description,
    skinId: skin.id,
    locked: false,
  })),
  ...placeholders,
];
export const availableCharacters = () => CHARACTERS.filter((character) => !character.locked);
