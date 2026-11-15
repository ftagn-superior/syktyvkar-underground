import assert from 'node:assert/strict';
import { sampleTerrain, validateTerrainGrid, type TerrainGrid } from '@su/contracts';

type Point = readonly [number, number];
export interface RingTerrainExpressivenessConfig {
  formatVersion: 1;
  river: { inlandX: number; riverbankX: number; additionalDropMetres: number };
  bathHill: {
    center: Point;
    radiusX: number;
    radiusZ: number;
    additionalHeightMetres: number;
  };
  dimitrova: {
    start: Point;
    end: Point;
    additionalRiseMetres: number;
    lateralPlateauMetres: number;
    lateralBlendMetres: number;
  };
  gradePreservationPads?: {
    id: string;
    center: Point;
    reference: Point;
    plateauRadiusMetres: number;
    blendWidthMetres: number;
  }[];
}

/** First S-45 iteration. These are artistic macro forms over the approved surface,
 * not a new reconstruction of the source elevation measurements. */
export const RING_TERRAIN_EXPRESSIVENESS_CONFIG: RingTerrainExpressivenessConfig = {
  formatVersion: 1,
  river: { inlandX: 450, riverbankX: 1500, additionalDropMetres: 11 },
  bathHill: {
    center: [-50, -650],
    radiusX: 700,
    radiusZ: 500,
    additionalHeightMetres: 6.5,
  },
  dimitrova: {
    start: [125.01, 406],
    end: [-608.31, 827.86],
    additionalRiseMetres: 6.5,
    lateralPlateauMetres: 250,
    lateralBlendMetres: 500,
  },
  // Lift the old urban platform, ring and bath summit together. This contiguous
  // shoulder includes the long houses and wall enclosure; retaining its accepted
  // grades avoids growing ramps or cutting a collar through a neighboring house.
  // The broad western approach still climbs to this higher city platform.
  gradePreservationPads: [
    {
      id: 'legacy-bath-neighborhood',
      center: [100, -400],
      reference: [-50, -650],
      plateauRadiusMetres: 550,
      blendWidthMetres: 200,
    },
  ],
};

export const RING_TERRAIN_EXPRESSIVENESS_ROUTES: {
  id: string;
  label: string;
  points: Point[];
}[] = [
  {
    id: 'river',
    label: 'Спуск к Сысоле: контрольный профиль 2450 м',
    points: [
      [-500, -200],
      [1950, -200],
    ],
  },
  {
    id: 'oplesnina',
    label: 'Оплеснина / баня №4',
    points: [
      [-610.38, -525.11],
      [-436.06, -555.93],
      [-232.28, -591.67],
      [-103.3, -614.64],
      [65.91, -644.08],
      [202.64, -668.02],
      [304.79, -685.91],
    ],
  },
  {
    id: 'dimitrova',
    label: 'Димитрова от католического храма к Морозова',
    points: [
      [125.01, 406],
      [47.68, 450.47],
      [-24.12, 491.75],
      [-148.9, 563.47],
      [-264.7, 630.1],
      [-390.08, 702],
      [-492.24, 760.69],
      [-608.31, 827.86],
    ],
  },
];

/** Quintic easing: value, slope and curvature meet the adjoining plateau. */
function smootherstep(value: number): number {
  const t = Math.max(0, Math.min(1, value));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function validateConfig(config: RingTerrainExpressivenessConfig) {
  const { river, bathHill, dimitrova } = config;
  assert.equal(config.formatVersion, 1, 'Unsupported expressive terrain configuration');
  assert.ok(
    [
      river.inlandX,
      river.riverbankX,
      river.additionalDropMetres,
      ...bathHill.center,
      bathHill.radiusX,
      bathHill.radiusZ,
      bathHill.additionalHeightMetres,
      ...dimitrova.start,
      ...dimitrova.end,
      dimitrova.additionalRiseMetres,
      dimitrova.lateralPlateauMetres,
      dimitrova.lateralBlendMetres,
    ].every(Number.isFinite),
    'Expressive terrain parameters must be finite',
  );
  assert.ok(river.riverbankX > river.inlandX && river.additionalDropMetres >= 0);
  assert.ok(bathHill.radiusX > 0 && bathHill.radiusZ > 0 && bathHill.additionalHeightMetres >= 0);
  assert.ok(
    Math.hypot(dimitrova.end[0] - dimitrova.start[0], dimitrova.end[1] - dimitrova.start[1]) > 0,
  );
  assert.ok(
    dimitrova.additionalRiseMetres >= 0 &&
      dimitrova.lateralPlateauMetres >= 0 &&
      dimitrova.lateralBlendMetres > 0,
  );
  const pads = config.gradePreservationPads ?? [];
  assert.equal(new Set(pads.map((pad) => pad.id)).size, pads.length, 'Duplicate protected yard');
  for (const pad of pads) {
    assert.ok(typeof pad.id === 'string' && pad.id.trim().length > 0);
    assert.ok(
      [...pad.center, ...pad.reference, pad.plateauRadiusMetres, pad.blendWidthMetres].every(
        Number.isFinite,
      ) &&
        pad.plateauRadiusMetres > 0 &&
        pad.blendWidthMetres > 0,
      'Protected yard parameters must be finite and positive',
    );
    for (const other of pads) {
      if (
        Math.hypot(pad.center[0] - other.center[0], pad.center[1] - other.center[1]) <=
        pad.plateauRadiusMetres + other.plateauRadiusMetres
      )
        assert.ok(
          Math.abs(
            macroOffset(pad.reference[0], pad.reference[1], config) -
              macroOffset(other.reference[0], other.reference[1], config),
          ) < 1e-8,
          'Overlapping protected yards must use the same additional height',
        );
    }
  }
}

function macroOffset(x: number, z: number, config: RingTerrainExpressivenessConfig): number {
  const { river, bathHill, dimitrova } = config;
  // One broad cross-city descent; no Z mask or repeated slope at tile boundaries.
  const riverDrop =
    -river.additionalDropMetres *
    smootherstep((x - river.inlandX) / (river.riverbankX - river.inlandX));
  const bathRadius = Math.hypot(
    (x - bathHill.center[0]) / bathHill.radiusX,
    (z - bathHill.center[1]) / bathHill.radiusZ,
  );
  const bathRise = bathHill.additionalHeightMetres * (1 - smootherstep(bathRadius));
  const dx = dimitrova.end[0] - dimitrova.start[0],
    dz = dimitrova.end[1] - dimitrova.start[1],
    length = Math.hypot(dx, dz),
    px = x - dimitrova.start[0],
    pz = z - dimitrova.start[1];
  const along = (px * dx + pz * dz) / (length * length);
  const across = Math.abs((-px * dz + pz * dx) / length);
  // A wide hillside with a level cross-section, not a raised strip under the road.
  const dimitrovaRise =
    dimitrova.additionalRiseMetres *
    smootherstep(along) *
    (1 - smootherstep((across - dimitrova.lateralPlateauMetres) / dimitrova.lateralBlendMetres));
  return riverDrop + bathRise + dimitrovaRise;
}

function offset(x: number, z: number, config: RingTerrainExpressivenessConfig): number {
  let numerator = macroOffset(x, z, config),
    denominator = 1;
  for (const pad of config.gradePreservationPads ?? []) {
    const weight =
      1 -
      smootherstep(
        (Math.hypot(x - pad.center[0], z - pad.center[1]) - pad.plateauRadiusMetres) /
          pad.blendWidthMetres,
      );
    const additionalHeight = macroOffset(pad.reference[0], pad.reference[1], config);
    if (weight === 1) return additionalHeight;
    // Normalized odds preserve each protected core exactly even when the wide
    // transition collars overlap. For one pad this is ordinary smooth blending.
    const odds = weight / (1 - weight);
    numerator += odds * additionalHeight;
    denominator += odds;
  }
  return numerator / denominator;
}

export function expressiveRingTerrainOffset(
  x: number,
  z: number,
  config = RING_TERRAIN_EXPRESSIVENESS_CONFIG,
): number {
  validateConfig(config);
  assert.ok(Number.isFinite(x) && Number.isFinite(z), 'Terrain coordinates must be finite');
  return offset(x, z, config);
}

/** Pure authoring: preserve the grid and its microrelief, add only three broad forms.
 * Always pass the pinned pre-S-45 grid; applying this operation to its output would
 * add the artistic correction again. The delivery CLI verifies that input hash. */
export function generateExpressiveRingTerrain(
  base: TerrainGrid,
  config = RING_TERRAIN_EXPRESSIVENESS_CONFIG,
): TerrainGrid {
  validateTerrainGrid(base);
  validateConfig(config);
  return validateTerrainGrid({
    ...base,
    origin: { ...base.origin },
    heights: base.heights.map((height, index) => {
      const x = base.origin.x + (index % base.columns) * base.spacing,
        z = base.origin.z + Math.floor(index / base.columns) * base.spacing;
      return Math.round((height + offset(x, z, config)) * 100_000) / 100_000;
    }),
  });
}

/** Samples the actual a-c triangulated grid, including every polyline vertex. */
export function measureTerrainProfile(grid: TerrainGrid, points: readonly Point[], spacing = 10) {
  validateTerrainGrid(grid);
  assert.ok(points.length >= 2 && Number.isFinite(spacing) && spacing > 0);
  let distance = 0;
  const samples: { distance: number; x: number; z: number; height: number }[] = [];
  for (let segment = 0; segment < points.length - 1; segment++) {
    const a = points[segment],
      b = points[segment + 1],
      length = Math.hypot(b[0] - a[0], b[1] - a[1]),
      count = Math.max(1, Math.ceil(length / spacing));
    for (let step = segment === 0 ? 0 : 1; step <= count; step++) {
      const t = step / count,
        x = a[0] + (b[0] - a[0]) * t,
        z = a[1] + (b[1] - a[1]) * t,
        sample = sampleTerrain(grid, x, z);
      assert.ok(sample, 'Terrain control route is outside the grid');
      samples.push({ distance: distance + length * t, x, z, height: sample.height });
    }
    distance += length;
  }
  return {
    distance,
    rise: samples.at(-1)!.height - samples[0].height,
    relief: Math.max(...samples.map((p) => p.height)) - Math.min(...samples.map((p) => p.height)),
    samples,
  };
}
