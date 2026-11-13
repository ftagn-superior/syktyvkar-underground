import type { WorldWeather } from '@su/contracts';

/**
 * Насколько сильна каждая часть погоды прямо сейчас, 0..1. Комната переключает погоду
 * мгновенно, а картинка догоняет её плавно: дождь усиливается за секунды, асфальт
 * намокает и высыхает за минуты, снег ложится и тает ещё дольше.
 *
 * Здесь только расчёт без графики; значения применяет `WorldEnvironment`.
 */
export type WeatherAmounts = {
  rain: number;
  snow: number;
  fog: number;
  /** Пасмурность: тусклое рассеянное небо вместо солнца. */
  overcast: number;
  /** Мокрые поверхности: темнее и с бликом неба. */
  wetness: number;
  /** Снег на горизонтальных поверхностях. */
  snowCover: number;
};

/** Секунды, за которые величина проходит весь путь 0 → 1 (рост) и 1 → 0 (спад). */
const RATES: Record<keyof WeatherAmounts, { rise: number; fall: number }> = {
  rain: { rise: 6, fall: 8 },
  snow: { rise: 8, fall: 10 },
  fog: { rise: 12, fall: 12 },
  overcast: { rise: 10, fall: 14 },
  wetness: { rise: 40, fall: 150 },
  snowCover: { rise: 120, fall: 180 },
};
/** Дождь смывает снег быстрее, чем он тает сам. */
const RAIN_MELT = 3;
/** Насколько пасмурно в тумане без осадков. */
const FOG_OVERCAST = 0.6;

export const CLEAR_AMOUNTS: WeatherAmounts = Object.freeze({
  rain: 0,
  snow: 0,
  fog: 0,
  overcast: 0,
  wetness: 0,
  snowCover: 0,
});

/** Значения, к которым погода приходит, если держится долго. */
export function settledAmounts(weather: WorldWeather): WeatherAmounts {
  const rain = weather.precipitation === 'rain' ? 1 : 0;
  const snow = weather.precipitation === 'snow' ? 1 : 0;
  const fog = weather.fog ? 1 : 0;
  return {
    rain,
    snow,
    fog,
    overcast: Math.max(rain, snow, fog * FOG_OVERCAST),
    wetness: rain,
    snowCover: snow,
  };
}

export class WeatherMix {
  private target = settledAmounts({ clouds: true, precipitation: 'none', fog: false });
  readonly current: WeatherAmounts = { ...CLEAR_AMOUNTS };

  /** `snap` сразу показывает установившуюся погоду: при входе в мир и для снимков. */
  set(weather: WorldWeather, snap = false): void {
    this.target = settledAmounts(weather);
    if (snap) Object.assign(this.current, this.target);
  }

  /** Продвигает переходы на `seconds`; возвращает, изменилось ли что-нибудь. */
  step(seconds: number): boolean {
    const dt = Math.max(0, Math.min(seconds, 1));
    let changed = false;
    for (const key of Object.keys(RATES) as (keyof WeatherAmounts)[]) {
      const from = this.current[key];
      const to = this.target[key];
      if (from === to) continue;
      const rate = RATES[key];
      let speed = 1 / (to > from ? rate.rise : rate.fall);
      if (key === 'snowCover' && to < from) speed *= 1 + RAIN_MELT * this.current.rain;
      const next = to > from ? Math.min(to, from + speed * dt) : Math.max(to, from - speed * dt);
      this.current[key] = next;
      changed = true;
    }
    return changed;
  }
}

/**
 * Локальная погода из адреса (`?weather=rain,fog`) для снимков и визуальных проверок:
 * перечисленные части включены, остальные выключены; `clear` — ясно. Неизвестные слова
 * пропускаются; если не осталось ни одного известного, переопределения нет.
 */
export function parseWeatherOverride(text: string | null): WorldWeather | undefined {
  if (!text) return;
  const weather: WorldWeather = { clouds: false, precipitation: 'none', fog: false };
  let known = false;
  for (const word of text.split(',').map((part) => part.trim())) {
    if (word === 'clear') known = true;
    else if (word === 'clouds' || word === 'fog') weather[word] = known = true;
    else if (word === 'rain' || word === 'snow') {
      weather.precipitation = word;
      known = true;
    }
  }
  return known ? weather : undefined;
}
