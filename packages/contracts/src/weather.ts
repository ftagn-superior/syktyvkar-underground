/**
 * Погода комнаты. Пока это только облака; дождь, снег и туман добавятся сюда же.
 * Команда `/weather` меняет её для всей комнаты; состояние не сохраняется между запусками.
 */
export interface WorldWeather {
  /** Облачный слой над городом и тени облаков на земле. */
  clouds: boolean;
}
export const DEFAULT_WEATHER: WorldWeather = { clouds: true };

export type WeatherAction = { kind: 'clouds'; enabled: boolean } | { kind: 'reset' };

export function applyWeatherAction(weather: WorldWeather, action: WeatherAction): WorldWeather {
  return action.kind === 'reset' ? { ...DEFAULT_WEATHER } : { ...weather, clouds: action.enabled };
}

export function describeWeather(weather: WorldWeather): string {
  return `облака ${weather.clouds ? 'включены' : 'выключены'}`;
}
