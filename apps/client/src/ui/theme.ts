/**
 * Цвет игрока больше не красит интерфейс: он задаёт одну переменную `--me` для элементов
 * «про игрока» (персонаж, знак, имя). Вся остальная окраска идёт от темы (см. ui-theme.ts).
 */
export const DEFAULT_PLAYER_COLOR = '#6EE0C4';

export interface Rgb {
  r: number;
  g: number;
  b: number;
}
export function parseHex(hex: string): Rgb {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const value = Number.parseInt(match ? match[1] : DEFAULT_PLAYER_COLOR.slice(1), 16);
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}
const channel = (value: number) =>
  Math.round(Math.min(255, Math.max(0, value)))
    .toString(16)
    .padStart(2, '0');
export const normalizeHex = (hex: string): string => {
  const { r, g, b } = parseHex(hex);
  return `#${channel(r)}${channel(g)}${channel(b)}`.toUpperCase();
};

/** HSL (degrees, percent, percent) to `#RRGGBB`. */
export function hslToHex(hue: number, saturation: number, lightness: number): string {
  const s = saturation / 100;
  const l = lightness / 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + hue / 30) % 12;
    return channel(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return `#${f(0)}${f(8)}${f(4)}`.toUpperCase();
}
/** `#RRGGBB` to HSL: hue 0..359, saturation and lightness 0..100. */
export function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const { r, g, b } = parseHex(hex);
  const [red, green, blue] = [r / 255, g / 255, b / 255];
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l: l * 100 };
  const s = d / (1 - Math.abs(2 * l - 1));
  const h =
    max === red
      ? ((green - blue) / d + (green < blue ? 6 : 0)) * 60
      : max === green
        ? ((blue - red) / d + 2) * 60
        : ((red - green) / d + 4) * 60;
  return { h: Math.round(h) % 360, s: s * 100, l: l * 100 };
}

/**
 * «Свой цвет»: оттенок 0–359 и тон 0–100. Насыщенность 68%, светлота 38–74%, чтобы любой
 * выбор читался и на газоне, и на бумаге.
 */
export const CUSTOM_SATURATION = 68;
export const CUSTOM_LIGHTNESS = { min: 38, max: 74 } as const;
export function customColor(hue: number, tone: number): string {
  const t = Math.min(100, Math.max(0, tone)) / 100;
  return hslToHex(
    ((Math.round(hue) % 360) + 360) % 360,
    CUSTOM_SATURATION,
    CUSTOM_LIGHTNESS.min + t * (CUSTOM_LIGHTNESS.max - CUSTOM_LIGHTNESS.min),
  );
}
/** The closest hue/tone pair for an arbitrary saved colour. */
export function customControls(hex: string): { hue: number; tone: number } {
  const { h, l } = hexToHsl(hex);
  const tone = ((l - CUSTOM_LIGHTNESS.min) / (CUSTOM_LIGHTNESS.max - CUSTOM_LIGHTNESS.min)) * 100;
  return { hue: h, tone: Math.round(Math.min(100, Math.max(0, tone))) };
}

/** Sets `--me` on the UI root. */
export function applyPlayerColor(hex: string, root: HTMLElement = document.documentElement): void {
  root.style.setProperty('--me', normalizeHex(hex));
}
