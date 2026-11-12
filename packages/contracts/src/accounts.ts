import { findAvatarSkin, type AvatarSkinId } from './avatars.js';

/** Preset palette. The first entry is the default accent for new profiles. */
export const PROFILE_COLORS = [
  { id: 'mint', hex: '#6EE0C4', label: 'Мятный' },
  { id: 'cyan', hex: '#4FC9E0', label: 'Бирюзовый' },
  { id: 'blue', hex: '#6AA8F5', label: 'Синий' },
  { id: 'indigo', hex: '#7D86F0', label: 'Индиго' },
  { id: 'violet', hex: '#A98BF5', label: 'Фиолетовый' },
  { id: 'rose', hex: '#F28AB8', label: 'Розовый' },
  { id: 'red', hex: '#EF6B6B', label: 'Красный' },
  { id: 'coral', hex: '#F59A7A', label: 'Коралловый' },
  { id: 'orange', hex: '#F2924B', label: 'Оранжевый' },
  { id: 'yellow', hex: '#F5C451', label: 'Жёлтый' },
  { id: 'lime', hex: '#A7D96A', label: 'Салатовый' },
  { id: 'sand', hex: '#E3C79A', label: 'Песочный' },
] as const;
/** Ids saved before the redesign keep their exact original colour. */
const LEGACY_PROFILE_COLORS = [
  { id: 'amber', hex: '#F3B35A', label: 'Янтарный' },
  { id: 'sky', hex: '#68C8ED', label: 'Голубой' },
  { id: 'lilac', hex: '#C7A0ED', label: 'Сиреневый' },
] as const;
export const CUSTOM_COLOR_LABEL = 'Свой цвет';
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** A preset/legacy id, or a custom `#RRGGBB` value. */
export type ProfileColorId = string;
export function resolveProfileColor(
  colorId: unknown,
): { id: string; hex: string; label: string; custom: boolean } | undefined {
  if (typeof colorId !== 'string') return;
  const preset =
    PROFILE_COLORS.find((color) => color.id === colorId) ??
    LEGACY_PROFILE_COLORS.find((color) => color.id === colorId);
  if (preset) return { ...preset, custom: false };
  if (HEX_COLOR.test(colorId)) {
    const hex = colorId.toUpperCase();
    const named = PROFILE_COLORS.find((color) => color.hex === hex);
    return named
      ? { ...named, custom: false }
      : { id: hex, hex, label: CUSTOM_COLOR_LABEL, custom: true };
  }
}
export const isProfileColorId = (value: unknown): value is ProfileColorId =>
  !!resolveProfileColor(value);

export interface PlayerProfile {
  displayName: string;
  colorId: ProfileColorId;
  skinId: AvatarSkinId;
  version: number;
}
export interface AccountView {
  accountId: string;
  profile: PlayerProfile;
}
export interface AccountResponse {
  enabled: boolean;
  account: AccountView | null;
  csrfToken?: string;
}
export interface ProfileUpdate {
  displayName: string;
  colorId: ProfileColorId;
  skinId: AvatarSkinId;
  version: number;
}

/** Normalize once on the server; the UI uses the same rules for feedback. */
export function parseProfileUpdate(value: unknown): ProfileUpdate | undefined {
  if (!value || typeof value !== 'object') return;
  const { displayName, colorId, skinId, version } = value as Record<string, unknown>;
  if (typeof displayName !== 'string' || displayName.length > 256) return;
  const name = displayName.normalize('NFC').trim();
  const length = Array.from(name).length;
  if (length < 2 || length > 24 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name)) return;
  const color = resolveProfileColor(colorId);
  if (!color) return;
  const skin = findAvatarSkin(skinId);
  if (!skin) return;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) return;
  return { displayName: name, colorId: color.custom ? color.hex : color.id, skinId: skin.id, version };
}
