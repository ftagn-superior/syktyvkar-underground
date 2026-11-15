import type { StaticMeshPart } from '@su/terrain-build/mesh';
import { simplifyTerrainPart, visualTemplate } from '@su/visual-build';
import { generateFootprint, type FootprintRecipe } from './city.js';
import { generateKit, type KitRecipe } from './kit.js';
import type { StaticLightSource } from '@su/contracts';

/** Deliberate source policies. No unsupported input silently falls back to LOD0. */
export function silhouette(
  assetId: string,
  kind: string,
  recipe: any,
  original: StaticMeshPart[],
  lights: StaticLightSource[] = [],
) {
  let parts: StaticMeshPart[];
  if (kind === 'footprint') {
    const simple = (r: FootprintRecipe): FootprintRecipe => ({
      ...r,
      merge: false,
      windows: false,
      doors: undefined,
      windowLayout: undefined,
      details: r.details
        ? {
            hippedRoof: r.details.hippedRoof ? { ...r.details.hippedRoof, chimneys: 0 } : undefined,
            roofSlab: r.details.roofSlab,
            parapet: r.details.parapet,
            shopfront: r.details.shopfront?.depth ? r.details.shopfront : undefined,
            roofSign: r.details.roofSign ? { ...r.details.roofSign, text: undefined } : undefined,
            roofSigns: r.details.roofSigns?.map((s) => ({ ...s, text: undefined })),
          }
        : undefined,
      sections: r.sections?.map((s) => ({
        ...simple({ ...r, ...s, sections: undefined }),
        id: s.id,
      })),
    });
    parts = generateFootprint(assetId, simple(recipe)).parts;
    // Sparse original window planes preserve source glow classes and deterministic thresholds.
    for (const p of original.filter((p) => /(^|-)windows$/.test(p.partId))) {
      const reduced = {
        ...p,
        positions: [],
        normals: [],
        indices: [],
        glow: [],
        colors: undefined,
        surface: undefined,
      } as StaticMeshPart;
      for (let k = 0; k < p.indices.length; k += 48)
        for (const i of p.indices.slice(k, k + 3)) {
          reduced.indices.push(reduced.positions.length / 3);
          reduced.positions.push(...p.positions.slice(i * 3, i * 3 + 3));
          reduced.normals.push(...p.normals.slice(i * 3, i * 3 + 3));
          reduced.glow!.push(...(p.glow?.slice(i * 2, i * 2 + 2) ?? [0, 0]));
        }
      if (reduced.indices.length) parts.push(reduced);
    }
  } else if (kind === 'house')
    parts = original.filter((p) => p.role === 'wall' || p.role === 'roof');
  else if (kind === 'kit') {
    const kit = structuredClone(recipe) as KitRecipe;
    kit.merge = false;
    kit.foliage = undefined;
    if (/^fence-/.test(assetId)) {
      // Category policy: a thin solid panel replaces rails and individual pickets.
      const xyz = original.flatMap((p) => p.positions);
      const min = [0, 1, 2].map((a) => {
        let n = Infinity;
        for (let k = a; k < xyz.length; k += 3) n = Math.min(n, xyz[k]);
        return n;
      });
      const max = [0, 1, 2].map((a) => {
        let n = -Infinity;
        for (let k = a; k < xyz.length; k += 3) n = Math.max(n, xyz[k]);
        return n;
      });
      kit.parts = [
        {
          id: 'fence-silhouette',
          role: 'detail',
          fade: false,
          color: kit.parts[0].color,
          shapes: [
            {
              box: {
                center: min.map((n, a) => (n + max[a]) / 2) as [number, number, number],
                size: min.map((n, a) => max[a] - n) as [number, number, number],
              },
            },
          ],
        },
      ];
    }
    for (const part of kit.parts)
      for (let j = 0; j < part.shapes.length; j++) {
        const shape = part.shapes[j];
        if ('cone' in shape) shape.cone.sides = assetId.startsWith('tree-') ? 5 : 6;
        if ('cylinder' in shape) shape.cylinder.sides = 6;
        if ('foliage' in shape) {
          const f = shape.foliage;
          part.shapes[j] = {
            cone: {
              center: [f.center[0], f.center[1] - f.height / 2, f.center[2]],
              radiusBottom: f.radius,
              radiusTop: 0.1,
              height: f.height,
              sides: 6,
            },
          };
        }
      }
    parts = generateKit(assetId, kit).parts;
  } else if (kind === 'ground')
    return visualTemplate(
      'ground',
      original.map((p) => simplifyTerrainPart(p)).filter((p) => p.indices.length),
      lights,
    );
  else throw new Error(`Unsupported HLOD source: ${assetId}/${kind}`);
  return visualTemplate('silhouette', parts, lights);
}
