import { sunPosition } from '../rendering/environment/day-cycle';

/** Две темы интерфейса: «берёста» днём и «полночь» ночью. */
export type UiTheme = 'day' | 'night';
/** Настройка игрока: авто по игровым суткам или принудительная тема. */
export type UiThemeMode = 'auto' | UiTheme;

const STORAGE_KEY = 'su:ui-theme:v1';
/** Тема не мигает, пока солнце стоит у самого горизонта. */
export const THEME_HYSTERESIS = 0.02;

/** Pure rule: sun height (−1..1, 0 at the horizon) plus the current theme gives the next theme. */
export function autoTheme(sunHeight: number, current: UiTheme): UiTheme {
  const threshold = current === 'day' ? -THEME_HYSTERESIS : THEME_HYSTERESIS;
  return sunHeight > threshold ? 'day' : 'night';
}
export function resolveTheme(mode: UiThemeMode, sunHeight: number, current: UiTheme): UiTheme {
  return mode === 'auto' ? autoTheme(sunHeight, current) : mode;
}
export const isThemeMode = (value: unknown): value is UiThemeMode =>
  value === 'auto' || value === 'day' || value === 'night';

/**
 * Owns `data-ui-theme` on the root. The attribute is written only when the theme changes, so a
 * per-frame caller costs one comparison.
 */
export class UiThemeController {
  private current: UiTheme;
  private chosen: UiThemeMode = 'auto';
  private sunHeight = 1;
  private readonly listeners = new Set<() => void>();
  constructor(private readonly root: HTMLElement = document.documentElement) {
    this.current = root.dataset.uiTheme === 'night' ? 'night' : 'day';
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (isThemeMode(stored)) this.chosen = stored;
    } catch {
      /* Без хранилища настройка живёт до перезагрузки. */
    }
  }
  get theme(): UiTheme {
    return this.current;
  }
  get mode(): UiThemeMode {
    return this.chosen;
  }
  /** Sun height of the last applied hour: positive by day. */
  get daylight(): boolean {
    return this.sunHeight > 0;
  }
  setMode(mode: UiThemeMode): void {
    this.chosen = mode;
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      /* Настройка продолжает работать без хранилища. */
    }
    this.apply();
    for (const listener of this.listeners) listener();
  }
  /** Feed the world hour (0..24). */
  setHour(hour: number): void {
    if (!Number.isFinite(hour)) return;
    this.sunHeight = sunPosition(hour).y;
    this.apply();
  }
  onModeChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private apply(): void {
    const next = resolveTheme(this.chosen, this.sunHeight, this.current);
    if (next === this.current && this.root.dataset.uiTheme === next) return;
    this.current = next;
    this.root.dataset.uiTheme = next;
  }
}
