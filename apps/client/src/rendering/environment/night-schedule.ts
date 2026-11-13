/**
 * Расписание ночного света без графики: какая доля окон каждого класса горит в данный
 * игровой час и включены ли фонари. Значения применяет `WorldNightLights`.
 *
 * Окно горит, если его случайное число меньше доли «вечер» и второе случайное число
 * меньше доли «держится», либо третье меньше доли «утро». Вечером окна зажигаются по
 * одному, ночью гаснут в другом, независимом порядке, поэтому к утру остаются случайные.
 */
import { sunPosition } from './day-cycle';

export type GlowLevel = {
  /** Доля элементов, зажёгшихся к этому часу вечером. */
  evening: number;
  /** Доля зажёгшихся, которые ещё не погасли к этому часу ночью. */
  keep: number;
  /** Доля элементов, горящих ранним утром независимо от вечера. */
  morning: number;
  /** Множитель яркости: днём свет почти не виден. */
  brightness: number;
};
export type NightLevels = {
  window: GlowLevel;
  office: GlowLevel;
  shop: GlowLevel;
  sign: GlowLevel;
  lamp: GlowLevel;
  /** 0..1: насколько горят фонари, включая разогрев ламп. */
  lamps: number;
  /** 0 днём, 1 в темноте. */
  dark: number;
};

/** Ключевые точки [час, доля]; между ними — плавный переход, сутки замкнуты. */
type Curve = readonly (readonly [number, number])[];

/** Фонари работают по расписанию города, а не по датчику света. */
export const LAMP_SCHEDULE = { on: 18.6, off: 7.3, warmUp: 0.15, coolDown: 0.05 };

const CURVES = {
  window: {
    // Сумерки: сначала немного, к темноте больше; пик около 22 часов.
    evening: [
      [16.5, 0],
      [18, 0.04],
      [19, 0.15],
      [20, 0.36],
      [21, 0.55],
      [22, 0.62],
      [6.5, 0.62],
      [8.5, 0],
    ],
    // После 22 часов дом засыпает; к трём часам горят единичные окна.
    keep: [
      [22, 1],
      [23, 0.8],
      [0, 0.45],
      [1, 0.22],
      [2, 0.11],
      [3, 0.07],
      [11, 0.07],
      [12, 1],
    ],
    morning: [
      [5.2, 0],
      [6, 0.12],
      [7, 0.22],
      [8, 0.1],
      [9, 0],
    ],
  },
  office: {
    evening: [
      [16, 0],
      [17.5, 0.5],
      [18.5, 0.75],
      [8, 0.75],
      [9, 0],
    ],
    // Школы, вуз и театр пустеют к десяти вечера; остаётся дежурный свет.
    keep: [
      [19.5, 1],
      [21, 0.35],
      [22.5, 0.05],
      [11, 0.05],
      [12, 1],
    ],
    morning: [
      [6.5, 0],
      [7.5, 0.35],
      [8.5, 0.5],
      [9.5, 0],
    ],
  },
  shop: {
    evening: [
      [16, 0],
      [17.5, 1],
      [8, 1],
      [10, 0],
    ],
    // Большинство магазинов закрывается к 22–23 часам, круглосуточные горят всю ночь.
    keep: [
      [21, 1],
      [22, 0.6],
      [23, 0.35],
      [11, 0.35],
      [12, 1],
    ],
    morning: [
      [7, 0],
      [8, 1],
      [10, 0],
    ],
  },
  sign: {
    evening: [
      [17, 0],
      [18, 1],
      [9, 1],
      [10, 0],
    ],
    // Вывески гаснут позже витрин; вывески круглосуточных магазинов горят до утра.
    keep: [
      [23, 1],
      [1, 0.55],
      [11, 0.55],
      [12, 1],
    ],
    morning: [[0, 0]],
  },
} satisfies Record<string, Record<'evening' | 'keep' | 'morning', Curve>>;

const wrap = (hour: number) => ((hour % 24) + 24) % 24;
const smooth = (t: number) => t * t * (3 - 2 * t);
const smoothstep = (from: number, to: number, value: number) =>
  smooth(Math.min(1, Math.max(0, (value - from) / (to - from))));

/** Значение замкнутой кривой в час `hour`. */
export function curveAt(curve: Curve, hour: number): number {
  const h = wrap(hour);
  if (curve.length === 1) return curve[0][1];
  for (let i = 0; i < curve.length; i++) {
    const [from, a] = curve[i];
    const [to, b] = curve[(i + 1) % curve.length];
    const span = wrap(to - from) || 24;
    const offset = wrap(h - from);
    if (offset <= span) return a + (b - a) * smooth(offset / span);
  }
  return curve[curve.length - 1][1];
}

/** 0..1 — накал фонарей: включаются и выключаются все вместе, с разогревом ламп. */
export function lampLevel(hour: number): number {
  const { on, off, warmUp, coolDown } = LAMP_SCHEDULE;
  const sinceOn = wrap(hour - on);
  const length = wrap(off - on);
  if (sinceOn > length) return 0;
  return smoothstep(0, warmUp, sinceOn) * (1 - smoothstep(length - coolDown, length, sinceOn));
}

/** 0 днём, 1 в темноте; совпадает с моментами смены неба в `skyAt`. */
export function darkness(hour: number): number {
  return 1 - smoothstep(-0.12, 0.22, sunPosition(hour).y);
}

export function nightLevels(hour: number): NightLevels {
  const dark = darkness(hour);
  // Днём свет есть, но на фоне солнца почти незаметен.
  const brightness = 0.12 + 0.88 * dark;
  const level = (curves: (typeof CURVES)[keyof typeof CURVES]): GlowLevel => ({
    evening: curveAt(curves.evening, hour),
    keep: curveAt(curves.keep, hour),
    morning: curveAt(curves.morning, hour),
    brightness,
  });
  const lamps = lampLevel(hour);
  return {
    window: level(CURVES.window),
    office: level(CURVES.office),
    shop: level(CURVES.shop),
    sign: level(CURVES.sign),
    lamp: { evening: 1, keep: 1, morning: 0, brightness: lamps * (0.35 + 0.65 * dark) },
    lamps,
    dark,
  };
}

/** Ожидаемая доля горящих элементов класса; для тестов и диагностики. */
export function litShare(level: GlowLevel): number {
  const evening = level.evening * level.keep;
  return evening + level.morning - evening * level.morning;
}
