import type { Sky } from './day-cycle';
import type { WeatherAmounts } from './weather-mix';

/**
 * Небо часа с поправкой на погоду. Пасмурность гасит прямой свет (и с ним тени
 * облаков), делает рассеянный свет ровнее и серее, снимает тёплые блики заката
 * и насыщенность. Туман перекрашивает пустоту вокруг города в свой цвет, чтобы
 * край мира и туман вокруг игрока сливались.
 *
 * Только расчёт: значения применяет `WorldLighting`, как и для ясного неба.
 */
type Rgb = readonly [number, number, number];

/**
 * Сколько прямого света остаётся при сплошной облачности: днём от солнца, ночью от луны.
 * Ночью облака подсвечены городом, а луна — единственный свет на аватарах и предметах:
 * без неё они превратились бы в чёрные силуэты.
 */
const OVERCAST_SUN = 0.22;
const OVERCAST_MOON = 0.75;
/** Тени облаков почти исчезают: облаком затянуто всё небо. */
const OVERCAST_SHADOWS = 0.1;
/** Рассеянный свет немного сильнее: небо светит ровно со всех сторон. */
const OVERCAST_FILL = 1.5;
const OVERCAST_DESATURATION = 18;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [
  lerp(a[0], b[0], t),
  lerp(a[1], b[1], t),
  lerp(a[2], b[2], t),
];
const grey = (color: Rgb): Rgb => {
  const luma = color[0] * 0.2126 + color[1] * 0.7152 + color[2] * 0.0722;
  return [luma, luma, luma];
};
const scale = (color: Rgb, factor: number): Rgb => [
  color[0] * factor,
  color[1] * factor,
  color[2] * factor,
];

export function weatherSky(sky: Sky, weather: WeatherAmounts): Sky {
  const o = weather.overcast;
  const f = weather.fog;
  if (o <= 0 && f <= 0) return sky;
  // Под дождём туман и низкое небо темнее.
  const fog = scale(sky.fog, 1 - 0.15 * weather.rain);
  const backdrop = mix(mix(sky.backdrop, scale(fog, 0.6), 0.5 * o), fog, f);
  return {
    ...sky,
    lightColor: mix(sky.lightColor, grey(sky.lightColor), 0.6 * o),
    lightIntensity:
      sky.lightIntensity * lerp(1, lerp(OVERCAST_MOON, OVERCAST_SUN, sky.sunlight), o),
    skyColor: mix(sky.skyColor, grey(sky.skyColor), 0.7 * o),
    groundColor: mix(sky.groundColor, grey(sky.groundColor), 0.5 * o),
    skyIntensity: sky.skyIntensity * lerp(1, OVERCAST_FILL, o),
    directLight: sky.directLight * lerp(1, OVERCAST_SHADOWS, o),
    cloudColor: mix(sky.cloudColor, scale(fog, 0.85), 0.7 * o),
    backdrop,
    fog,
    grade: {
      shadows: sky.grade.shadows * lerp(1, 0.6, o),
      highlights: sky.grade.highlights * lerp(1, 0.3, o),
      saturation: sky.grade.saturation - OVERCAST_DESATURATION * o,
      vignette: sky.grade.vignette,
    },
  };
}
