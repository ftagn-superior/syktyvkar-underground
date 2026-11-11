export const PROFILE_COLORS = [
  { id: 'mint', hex: '#65d6bc', label: 'Мятный' },
  { id: 'amber', hex: '#f3b35a', label: 'Янтарный' },
  { id: 'indigo', hex: '#8c9eff', label: 'Синий' },
  { id: 'rose', hex: '#ed88b7', label: 'Розовый' },
  { id: 'lime', hex: '#9bd06d', label: 'Зелёный' },
  { id: 'sky', hex: '#68c8ed', label: 'Голубой' },
  { id: 'lilac', hex: '#c7a0ed', label: 'Сиреневый' },
  { id: 'coral', hex: '#e98b69', label: 'Коралловый' },
] as const;

export type ProfileColorId = (typeof PROFILE_COLORS)[number]['id'];
export interface PlayerProfile {
  displayName: string;
  colorId: ProfileColorId;
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
  version: number;
}

/** Normalize once on the server; the UI uses the same rules for feedback. */
export function parseProfileUpdate(value: unknown): ProfileUpdate | undefined {
  if (!value || typeof value !== 'object') return;
  const { displayName, colorId, version } = value as Record<string, unknown>;
  if (typeof displayName !== 'string' || displayName.length > 256) return;
  const name = displayName.normalize('NFC').trim();
  const length = Array.from(name).length;
  if (length < 2 || length > 24 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name)) return;
  if (!PROFILE_COLORS.some((color) => color.id === colorId)) return;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) return;
  return { displayName: name, colorId: colorId as ProfileColorId, version };
}
