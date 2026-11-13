/**
 * Облачное поле: одна бесшовная карта покрытия на высоте `altitude`, которую ветер несёт
 * над городом. Из неё получаются и тени на земле, и сами облака при отдалении камеры,
 * поэтому тень всегда лежит под своим облаком.
 *
 * Здесь только расчёты без графики: их одинаково используют шейдер теней и слой облаков.
 */
export const CLOUD_FIELD = {
  /** Сторона одного повтора карты в метрах: больше самого дальнего кадра по ширине. */
  tileMetres: 2048,
  /** Сторона текстуры в текселях (4 м на тексель: облака мягкие, деталь не нужна). */
  textureSize: 512,
  /** Высота слоя над землёй, выше любого здания. */
  altitude: 90,
  /** Ветер в м/с по осям X и Z мира. */
  wind: { x: 3.2, z: 1.4 },
  /** Нижняя граница шума, с которой начинается облако, и ширина его мягкого края. */
  threshold: 0.54,
  softness: 0.1,
  /**
   * Тень смещается от облака вдоль лучей солнца. У горизонта смещение уходит
   * в бесконечность, поэтому высота солнца для этого расчёта ограничена снизу.
   */
  minSunHeight: 0.26,
} as const;

/** Small deterministic integer hash: every client must build the same sky. */
function hash(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 1274126177) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** Value noise whose lattice wraps after `period` cells, so the result tiles. */
function tileableNoise(u: number, v: number, period: number, seed: number): number {
  const x = u * period;
  const y = v * period;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const at = (ix: number, iy: number) =>
    hash(((ix % period) + period) % period, ((iy % period) + period) % period, seed);
  const top = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx;
  const bottom = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx;
  return top + (bottom - top) * sy;
}

/**
 * Coverage in 0..255 per texel, row by row: 0 is clear sky, 255 the middle of a cloud.
 * The soft edge is baked in, so shadows and the visible layer agree without sharing
 * shader code.
 */
export function cloudCoverage(size: number = CLOUD_FIELD.textureSize, seed = 7): Uint8Array {
  const data = new Uint8Array(size * size);
  const { threshold, softness } = CLOUD_FIELD;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      // Крупные массивы задают форму, мелкие октавы только рвут край.
      const noise =
        tileableNoise(u, v, 6, seed) * 0.5 +
        tileableNoise(u, v, 12, seed + 1) * 0.27 +
        tileableNoise(u, v, 24, seed + 2) * 0.15 +
        tileableNoise(u, v, 48, seed + 3) * 0.08;
      const t = Math.min(1, Math.max(0, (noise - threshold) / softness));
      data[y * size + x] = Math.round(t * t * (3 - 2 * t) * 255);
    }
  return data;
}

/**
 * Texture offset of the field at a moment of wall-clock time, in tiles, wrapped to 0..1.
 * Wall-clock time keeps every client under the same clouds without any network traffic.
 */
export function cloudDrift(epochMs: number): { u: number; v: number } {
  const seconds = epochMs / 1000;
  const wrap = (value: number) => value - Math.floor(value);
  // A point of the field moves with the wind, so the lookup moves against it.
  return {
    u: wrap((-seconds * CLOUD_FIELD.wind.x) / CLOUD_FIELD.tileMetres),
    v: wrap((-seconds * CLOUD_FIELD.wind.z) / CLOUD_FIELD.tileMetres),
  };
}

/**
 * Horizontal distance, per metre below the cloud layer, from a lit point to the part of
 * the layer its sunlight passed through. `direction` is the direction light travels.
 */
export function cloudShadowShift(direction: { x: number; y: number; z: number }): {
  x: number;
  z: number;
} {
  const length = Math.hypot(direction.x, direction.y, direction.z) || 1;
  const height = Math.max(CLOUD_FIELD.minSunHeight, -direction.y / length);
  return { x: -direction.x / length / height, z: -direction.z / length / height };
}

/** How much of the visible layer shows at a camera zoom: none up close, all from afar. */
export function cloudLayerOpacity(zoom: number): number {
  const t = Math.min(1, Math.max(0, (zoom - 2.5) / (9 - 2.5)));
  return t * t * (3 - 2 * t);
}
