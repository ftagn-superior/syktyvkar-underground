/** Player colour drives every accent in the UI. Pure maths here, DOM only in applyAccent. */
export const DEFAULT_ACCENT = '#6EE0C4';

export interface Rgb {
  r: number;
  g: number;
  b: number;
}
export function parseHex(hex: string): Rgb {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const value = Number.parseInt(match ? match[1] : DEFAULT_ACCENT.slice(1), 16);
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}
/** Simple, non-gamma luminance in 0..1, matching the design prototype. */
export function luminance(hex: string): number {
  const { r, g, b } = parseHex(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}
const channel = (value: number) =>
  Math.round(Math.min(255, Math.max(0, value)))
    .toString(16)
    .padStart(2, '0');
export function mixHex(hex: string, toward: string, amount: number): string {
  const a = parseHex(hex);
  const b = parseHex(toward);
  const mix = (from: number, to: number) => channel(from + (to - from) * amount);
  return `#${mix(a.r, b.r)}${mix(a.g, b.g)}${mix(a.b, b.b)}`;
}
export const normalizeHex = (hex: string): string => {
  const { r, g, b } = parseHex(hex);
  return `#${channel(r)}${channel(g)}${channel(b)}`.toUpperCase();
};

export interface AccentVars {
  '--accent': string;
  '--accent-soft': string;
  '--accent-line': string;
  '--accent-ink': string;
  '--accent-text': string;
}
export function accentVars(hex: string): AccentVars {
  const color = normalizeHex(hex);
  const { r, g, b } = parseHex(color);
  const light = luminance(color);
  return {
    '--accent': color,
    '--accent-soft': `rgba(${r},${g},${b},.16)`,
    '--accent-line': `rgba(${r},${g},${b},.55)`,
    '--accent-ink': light > 0.5 ? '#0c1412' : '#f4f7f6',
    '--accent-text': light >= 0.5 ? color : mixHex(color, '#ffffff', 0.5),
  };
}
/** Sets all five accent variables on the UI root (document element by default). */
export function applyAccent(hex: string, root: HTMLElement = document.documentElement): void {
  const vars = accentVars(hex);
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
}
