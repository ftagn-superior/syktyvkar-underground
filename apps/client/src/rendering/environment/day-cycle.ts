/**
 * Суточный цикл: по времени суток возвращает, откуда и каким светом освещён город.
 * Здесь только расчёт без графики; значения применяет `WorldLighting`.
 *
 * Солнце идёт по настоящим сторонам света карты (восток — +X, север — −Z): встаёт
 * на востоке, в полдень стоит на юге, садится на западе. Ночью тем же путём идёт луна.
 * Цикл проходит ровно через эталонный свет арт-направления в `REFERENCE_HOUR`.
 */

type Rgb = readonly [number, number, number];
export type Sky = {
  /** Direction the direct light (sun by day, moon by night) travels; unit length. */
  lightDirection: { x: number; y: number; z: number };
  lightColor: Rgb;
  lightIntensity: number;
  /** Hemispheric fill: colour from above, colour bounced from the ground, strength. */
  skyColor: Rgb;
  groundColor: Rgb;
  skyIntensity: number;
  /** 0..1: how sharply the direct light is felt; drives cloud shadows. */
  directLight: number;
  /** Colour of cloud tops under this sky. */
  cloudColor: Rgb;
};

/** Длина суток и ход часов общие с сервером; часы ниже — игровые, 0..24. */
export { DAY_LENGTH_MS, hourAt } from '@su/contracts';
const NOON_HOUR = 13;

const rgb = (hex: string): Rgb => [
  parseInt(hex.slice(1, 3), 16) / 255,
  parseInt(hex.slice(3, 5), 16) / 255,
  parseInt(hex.slice(5, 7), 16) / 255,
];
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smoothstep = (from: number, to: number, value: number) => {
  const t = Math.min(1, Math.max(0, (value - from) / (to - from)));
  return t * t * (3 - 2 * t);
};

// Эталон арт-направления: тёплое солнце на юго-востоке, около 42° над горизонтом.
const REFERENCE = (() => {
  const length = Math.hypot(0.9, 1, 0.65);
  return { east: 0.9 / length, up: 1 / length, south: 0.65 / length };
})();
/** Hour angle of the reference sun, and the height the sun reaches at noon. */
const REFERENCE_ANGLE = -Math.asin(REFERENCE.east);
const NOON_HEIGHT = REFERENCE.up / Math.cos(REFERENCE_ANGLE);
const NOON_SOUTH = Math.sqrt(1 - NOON_HEIGHT * NOON_HEIGHT);
/** Game hour at which the cycle shows the reference look (mid-morning). */
export const REFERENCE_HOUR = NOON_HOUR + (REFERENCE_ANGLE / Math.PI) * 12;

/** The direct light never grazes the ground: shadows stay finite and inside their map. */
const MIN_LIGHT_HEIGHT = 0.2;

const DAY = {
  light: rgb('#ffe6bd'),
  sky: rgb('#d6e7f4'),
  ground: rgb('#888563'),
  cloud: rgb('#f4f1ea'),
};
const HORIZON = {
  light: rgb('#ffa866'),
  sky: rgb('#c2a3b6'),
  ground: rgb('#5f5660'),
  cloud: rgb('#f2b48c'),
};
const NIGHT = {
  light: rgb('#a9c0ff'),
  sky: rgb('#3c4a7c'),
  ground: rgb('#212737'),
  cloud: rgb('#59648a'),
};
const SUN_INTENSITY = 3;
// Ночь заметно темнее дня: окна, вывески и фонари должны читаться на её фоне.
const MOON_INTENSITY = 0.5;
const NIGHT_FILL = 0.26;

/** Unit vector towards the sun. Below the horizon at night. */
export function sunPosition(hour: number): { x: number; y: number; z: number } {
  const angle = ((hour - NOON_HOUR) / 12) * Math.PI;
  return {
    x: -Math.sin(angle),
    y: Math.cos(angle) * NOON_HEIGHT,
    z: Math.cos(angle) * NOON_SOUTH,
  };
}

export function skyAt(hour: number): Sky {
  const sun = sunPosition(hour);
  // Высота солнца над горизонтом задаёт всё остальное: −1 в полночь, 0 на горизонте.
  const height = sun.y;
  // The moon follows the same path half a day apart, so one of the two is always up.
  const body = height >= 0 ? sun : { x: -sun.x, y: -sun.y, z: -sun.z };
  const flat = Math.hypot(body.x, body.z) || 1;
  const lifted = Math.max(MIN_LIGHT_HEIGHT, body.y);
  const reach = Math.sqrt(1 - lifted * lifted) / flat;
  // Each light fades out as it touches the horizon; the swap happens in the dark.
  const sunlight = smoothstep(0, 0.14, height);
  const moonlight = smoothstep(0, 0.14, -height);
  // Colours: night below the horizon, a warm band around it, full day above.
  const fromNight = smoothstep(-0.18, 0, height);
  const toDay = smoothstep(0.04, 0.34, height);
  const blend = (key: keyof typeof DAY) =>
    mix(mix(NIGHT[key], HORIZON[key], fromNight), DAY[key], toDay);
  return {
    lightDirection: { x: -body.x * reach, y: -lifted, z: -body.z * reach },
    lightColor: height >= 0 ? mix(HORIZON.light, DAY.light, toDay) : NIGHT.light,
    lightIntensity: SUN_INTENSITY * sunlight + MOON_INTENSITY * moonlight,
    skyColor: blend('sky'),
    groundColor: blend('ground'),
    skyIntensity: lerp(NIGHT_FILL, lerp(0.42, 0.45, toDay), fromNight),
    directLight: sunlight + 0.5 * moonlight,
    cloudColor: blend('cloud'),
  };
}
