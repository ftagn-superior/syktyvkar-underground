import {
  applyWeatherAction,
  describeWeather,
  precipitationCode,
  precipitationFromCode,
  type ActionResult,
  type WeatherAction,
  type WorldWeather,
} from '@su/contracts';

const WEATHER_COMMAND_COOLDOWN_MS = 1000;

interface ReplicatedWeather {
  weatherClouds: boolean;
  weatherPrecipitation: number;
  weatherFog: boolean;
}

/** Погода одной комнаты. Источник истины — реплицируемое состояние; после перезапуска — по умолчанию. */
export class WorldWeatherControl {
  private changeAvailableAt = 0;

  constructor(private readonly state: ReplicatedWeather) {}

  get weather(): WorldWeather {
    return {
      clouds: this.state.weatherClouds,
      precipitation: precipitationFromCode(this.state.weatherPrecipitation),
      fog: this.state.weatherFog,
    };
  }

  /** Несколько изменений одной команды применяются вместе; пустой список — только запрос. */
  command(changes: readonly WeatherAction[], now: number): Omit<ActionResult, 'requestId'> {
    const changed = changes.length > 0;
    if (changed) {
      // Смену погоды видят все, поэтому cooldown общий для комнаты, как у `/time`.
      if (now < this.changeAvailableAt)
        return {
          ok: false,
          code: 'RATE_LIMITED',
          message: 'Погоду меняли только что. Повторите через секунду.',
          retryAfterMs: this.changeAvailableAt - now,
        };
      this.changeAvailableAt = now + WEATHER_COMMAND_COOLDOWN_MS;
      const weather = changes.reduce(applyWeatherAction, this.weather);
      this.state.weatherClouds = weather.clouds;
      this.state.weatherPrecipitation = precipitationCode(weather.precipitation);
      this.state.weatherFog = weather.fog;
    }
    return {
      ok: true,
      retryAfterMs: changed ? WEATHER_COMMAND_COOLDOWN_MS : 0,
      message: `Погода: ${describeWeather(this.weather)}.`,
    };
  }
}
