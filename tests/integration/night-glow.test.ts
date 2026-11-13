import { describe, expect, it } from 'vitest';
import { GLOW_KIND, validateBuildingParts } from '../../packages/contracts/src/index.js';
import { generateFootprint } from '../../tools/world-build/src/city.js';
import { generateKit, type KitRecipe } from '../../tools/world-build/src/kit.js';
import { encodeStaticGlb, type StaticMeshPart } from '../../tools/world-build/src/glb.js';
import { glowRandom } from '../../tools/world-build/src/glow.js';
import { compileStaticAsset } from '../../packages/terrain-build/src/assets.js';
import { mergeParts } from '../../tools/world-build/src/merge.js';

const outline: [number, number][] = [
  [-10, -6],
  [10, -6],
  [10, 6],
  [-10, 6],
];
const house = {
  formatVersion: 1 as const,
  outline,
  height: 15,
  floors: 5,
  windows: true,
  wallColor: '#ddccaa',
  roofColor: '#555555',
  windowColor: '#29343c',
};

/** Классы и случайные числа по вершинам всех частей. */
function glowOf(parts: StaticMeshPart[]) {
  const kinds = new Map<number, number>();
  const seeds = new Set<number>();
  for (const part of parts) {
    const count = part.positions.length / 3;
    if (part.glow) expect(part.glow.length).toBe(count * 2);
    for (let i = 0; i < count; i++) {
      const kind = part.glow?.[i * 2] ?? 0;
      kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
      if (kind) seeds.add(part.glow![i * 2 + 1]);
    }
  }
  return { kinds, seeds };
}

/** Байты TEXCOORD_0 из собранного GLB. */
function texcoords(glb: Uint8Array): number[][] {
  const data = Buffer.from(glb);
  const jsonLength = data.readUInt32LE(12);
  const document = JSON.parse(data.subarray(20, 20 + jsonLength).toString('utf8'));
  const binary = 28 + jsonLength;
  return document.meshes.flatMap((mesh: any) =>
    mesh.primitives.flatMap((primitive: any) => {
      if (primitive.attributes.TEXCOORD_0 === undefined) return [];
      const accessor = document.accessors[primitive.attributes.TEXCOORD_0];
      expect(accessor.type).toBe('VEC2');
      expect(accessor.count).toBe(document.accessors[primitive.attributes.POSITION].count);
      const view = document.bufferViews[accessor.bufferView];
      const values: number[] = [];
      for (let i = 0; i < accessor.count * 2; i++)
        values.push(data.readFloatLE(binary + (view.byteOffset ?? 0) + i * 4));
      return [values];
    }),
  );
}

describe('night glow baked into static models', () => {
  it('gives every footprint window its own lit threshold, after merging too', () => {
    const plain = generateFootprint('glow-house', house);
    const merged = generateFootprint('glow-house', { ...house, merge: true });
    const separate = glowOf(plain.parts);
    const together = glowOf(merged.parts);
    // 2 длинных фасада × 6 окон + 2 коротких × 3 окна, 5 этажей, 4 вершины на окно.
    const windows = (2 * 6 + 2 * 3) * 5;
    expect(separate.kinds.get(GLOW_KIND.window)).toBe(windows * 4);
    // Совпадения порогов возможны, но редки: окна не включаются пачками.
    expect(separate.seeds.size).toBeGreaterThanOrEqual(windows - 2);
    expect(together.kinds).toEqual(separate.kinds);
    expect(together.seeds).toEqual(separate.seeds);
    for (const seed of separate.seeds) expect(seed > 0 && seed < 1).toBe(true);
    // Повторная сборка детерминирована.
    expect(glowOf(generateFootprint('glow-house', house).parts).seeds).toEqual(separate.seeds);
  });

  it('keeps shop glass, signs and offices in their own classes and lets windows go dark', () => {
    const shop = generateFootprint('glow-shop', {
      ...house,
      merge: true,
      details: {
        shopfront: {
          facing: ['S'],
          height: 3.6,
          glassColor: '#273b46',
          signColor: '#c23a2f',
        },
        roofSign: {
          facing: 'S',
          width: 10,
          height: 1.6,
          color: '#e42d2d',
          text: 'МАГНИТ',
          glow: true,
        },
      },
    });
    const { kinds } = glowOf(shop.parts);
    expect(kinds.get(GLOW_KIND.shop)).toBeGreaterThan(0);
    expect(kinds.get(GLOW_KIND.sign)).toBeGreaterThan(0);
    expect(kinds.get(GLOW_KIND.neon)).toBeGreaterThan(0);
    // Неоновая вывеска на южном фасаде светится только гранями, обращёнными на юг (+Z).
    const unmerged = generateFootprint('glow-shop', {
      ...house,
      details: {
        roofSign: {
          facing: 'S',
          width: 10,
          height: 1.6,
          color: '#e42d2d',
          text: 'МАГНИТ',
          glow: true,
        },
      },
    });
    const letters = unmerged.parts.find((part) => part.partId === 'sign')!;
    for (let i = 0; i < letters.positions.length / 3; i++)
      expect(letters.glow![i * 2] === GLOW_KIND.neon).toBe(letters.normals[i * 3 + 2] > 0.7);
    expect(unmerged.lights).toHaveLength(1);
    const [light] = unmerged.lights!;
    expect(light.kind).toBe('neon');
    expect(light.color).toBe('#e42d2d');
    expect(light.position.z).toBeGreaterThan(6);
    expect(light.position.y).toBeGreaterThan(house.height);
    expect(generateFootprint('glow-house', house).lights).toBeUndefined();
    expect(kinds.get(GLOW_KIND.window)).toBeGreaterThan(0);

    const office = glowOf(
      generateFootprint('glow-office', { ...house, windowGlow: 'office' }).parts,
    );
    expect(office.kinds.get(GLOW_KIND.office)).toBeGreaterThan(0);
    expect(office.kinds.has(GLOW_KIND.window)).toBe(false);

    const dark = generateFootprint('glow-dark', { ...house, windowGlow: 'none' });
    expect(dark.parts.some((part) => part.glow)).toBe(false);
    expect(texcoords(encodeStaticGlb(dark.parts))).toEqual([]);
  });

  it('writes the glow channel into TEXCOORD_0 and leaves models without lights unchanged', () => {
    const { parts } = generateFootprint('glow-house', { ...house, merge: true });
    const [values] = texcoords(encodeStaticGlb(parts));
    const kinds = new Set(values.filter((_, i) => i % 2 === 0));
    expect(kinds).toEqual(new Set([0, GLOW_KIND.window]));

    const bench: KitRecipe = {
      formatVersion: 1,
      parts: [
        {
          id: 'seat',
          role: 'detail',
          fade: false,
          color: '#80664d',
          shapes: [{ box: { center: [0, 0.45, 0], size: [1.6, 0.1, 0.4] } }],
        },
      ],
      colliders: [{ id: 'seat', center: [0, 0.45, 0], size: [1.6, 0.1, 0.4] }],
      merge: true,
    };
    const generated = generateKit('glow-bench', bench);
    expect(texcoords(encodeStaticGlb(generated.parts))).toEqual([]);
    expect(generated.lights).toBeUndefined();
  });

  it('lights a lamp head and publishes its light source in the parts metadata', () => {
    const lamp: KitRecipe = {
      formatVersion: 1,
      parts: [
        {
          id: 'pole',
          role: 'detail',
          fade: false,
          color: '#3a3d40',
          shapes: [{ box: { center: [0, 3, 0], size: [0.16, 6, 0.16] } }],
        },
        {
          id: 'light',
          role: 'detail',
          fade: false,
          color: '#f4f1e6',
          glow: 'lamp',
          shapes: [{ box: { center: [1, 6, 0], size: [0.5, 0.15, 0.3] } }],
        },
      ],
      colliders: [{ id: 'pole', center: [0, 3, 0], size: [0.16, 6, 0.16] }],
      lights: [{ position: [1, 5.9, 0], radius: 14, color: '#ffd49a' }],
      merge: true,
    };
    const generated = generateKit('glow-lamp', lamp);
    const { kinds } = glowOf(generated.parts);
    expect(kinds.get(GLOW_KIND.lamp)).toBe(24);
    expect(generated.lights).toEqual([
      { position: { x: 1, y: 5.9, z: 0 }, radius: 14, color: '#ffd49a' },
    ]);
    expect(() =>
      generateKit('glow-lamp', {
        ...lamp,
        lights: [{ position: [0, 0, 0], radius: 0, color: '#fff' }],
      }),
    ).toThrow(/light/);
    expect(() =>
      generateKit('glow-lamp', {
        ...lamp,
        parts: [{ ...lamp.parts[1], glow: 'disco' as never }],
      }),
    ).toThrow(/glow/);
  });

  it('validates lights and the glow flag in the parts contract', () => {
    const parts = {
      formatVersion: 1,
      assetId: 'glow-lamp',
      parts: [{ partId: 'static', role: 'detail', occlusionGroup: null, nodeIndex: 0 }],
    };
    const light = { position: { x: 1, y: 6, z: 0 }, radius: 14, color: '#ffd49a' };
    expect(validateBuildingParts({ ...parts, glow: true, lights: [light] }).lights).toHaveLength(1);
    expect(() => validateBuildingParts({ ...parts, lights: [] })).toThrow(/lights/);
    expect(() => validateBuildingParts({ ...parts, lights: [{ ...light, radius: 90 }] })).toThrow(
      /radius/,
    );
    expect(() => validateBuildingParts({ ...parts, lights: [{ ...light, color: 'red' }] })).toThrow(
      /color/,
    );
    expect(() => validateBuildingParts({ ...parts, glow: false })).toThrow(/glow/);
    expect(
      validateBuildingParts({ ...parts, lights: [{ ...light, kind: 'neon' }] }).lights,
    ).toHaveLength(1);
    expect(() =>
      validateBuildingParts({ ...parts, lights: [{ ...light, kind: 'disco' }] }),
    ).toThrow(/kind/);
  });

  it('preserves night metadata through the shared compiler and large mesh merging', () => {
    const generated = generateFootprint('glow-compiled', { ...house, merge: true });
    const model = encodeStaticGlb(generated.parts);
    const light = { position: { x: 1, y: 6, z: 0 }, radius: 14, color: '#ffd49a' };
    const compiled = compileStaticAsset(
      'glow-compiled',
      model,
      generated.physics,
      undefined,
      undefined,
      {
        glow: true,
        lights: [light],
      },
    );
    expect(JSON.parse(Buffer.from(compiled.parts).toString())).toMatchObject({
      glow: true,
      lights: [light],
    });
    expect(texcoords(compiled.model!)).toEqual(texcoords(model));
    const vertices = 150_000;
    const large: StaticMeshPart = {
      partId: 'large-glow',
      role: 'detail',
      occlusionGroup: null,
      color: '#ffffff',
      positions: Array(vertices * 3).fill(0),
      normals: Array(vertices * 3).fill(1),
      indices: [],
      glow: Array(vertices * 2).fill(0.5),
    };
    expect(mergeParts([large])[0].glow).toEqual(large.glow);
  });

  it('draws deterministic thresholds strictly inside 0..1', () => {
    const a = glowRandom('osm-way-1');
    const b = glowRandom('osm-way-1');
    const values = Array.from({ length: 2000 }, () => a());
    expect(values).toEqual(Array.from({ length: 2000 }, () => b()));
    expect(Math.min(...values)).toBeGreaterThan(0);
    expect(Math.max(...values)).toBeLessThan(1);
    // Пороги распределены равномерно: доля горящих окон совпадает с расписанием.
    expect(values.filter((value) => value < 0.25).length / values.length).toBeCloseTo(0.25, 1);
  });
});
