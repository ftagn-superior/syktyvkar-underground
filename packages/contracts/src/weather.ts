/**
 * Погода комнаты: облака, осадки и туман. Команда `/weather` меняет её для всей комнаты;
 * состояние не сохраняется между запусками сервера. Переходы между погодами (дождь
 * начинается, асфальт намокает, снег ложится и тает) клиент рисует сам и плавно.
 */
export const PRECIPITATIONS = ['none', 'rain', 'snow'] as const;
export type Precipitation = (typeof PRECIPITATIONS)[number];

export interface WorldWeather {
  /** Облачный слой над городом и тени облаков на земле. */
  clouds: boolean;
  /** Что падает с неба: дождь и снег взаимоисключают друг друга. */
  precipitation: Precipitation;
  /** Густой туман вокруг игрока. */
  fog: boolean;
}
export const DEFAULT_WEATHER: WorldWeather = { clouds: true, precipitation: 'none', fog: false };

/** Части погоды, которые команда включает и выключает по отдельности. */
export type WeatherPart = 'clouds' | 'rain' | 'snow' | 'fog';
export type WeatherAction =
  | { kind: 'set'; part: WeatherPart; enabled: boolean }
  /** Ясно: ни облаков, ни осадков, ни тумана. */
  | { kind: 'clear' }
  | { kind: 'reset' };

export function applyWeatherAction(weather: WorldWeather, action: WeatherAction): WorldWeather {
  if (action.kind === 'reset') return { ...DEFAULT_WEATHER };
  if (action.kind === 'clear') return { clouds: false, precipitation: 'none', fog: false };
  const { part, enabled } = action;
  if (part === 'clouds' || part === 'fog') return { ...weather, [part]: enabled };
  if (enabled) return { ...weather, precipitation: part };
  // Выключение дождя не трогает идущий снег, и наоборот.
  return weather.precipitation === part ? { ...weather, precipitation: 'none' } : weather;
}

export function describeWeather(weather: WorldWeather): string {
  const parts = [
    weather.precipitation === 'rain' ? 'дождь' : weather.precipitation === 'snow' ? 'снег' : '',
    weather.fog ? 'туман' : '',
    weather.clouds ? 'облачно' : '',
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : 'ясно';
}

/** Осадки в реплицируемом поле: номер в `PRECIPITATIONS`; неизвестное значение — без осадков. */
export function precipitationCode(precipitation: Precipitation): number {
  return PRECIPITATIONS.indexOf(precipitation);
}
export function precipitationFromCode(code: number): Precipitation {
  return PRECIPITATIONS[code] ?? 'none';
}
