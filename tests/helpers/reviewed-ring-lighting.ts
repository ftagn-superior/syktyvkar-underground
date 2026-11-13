import assert from 'node:assert/strict';

// Separately pinned production-lighting output. Historical migration rules and
// extraction fixtures remain immutable and must not authorize this release.
export const reviewedLightingFlatRelease = {
  assetReleaseVersion: '8ecdd508c14ad05dfdc62cdddcc68b78b8762e355c069b5e15821cdbe64455bf',
  libraryHash: '7aee0e939804743e7c2fb9187ba793028693efbedbe426297387313b5019123b',
};

const additions: Record<string, Record<string, unknown>> = {
  'osm-way-1258973447': { windowGlow: 'office' },
  'osm-way-146724915': { windowGlow: 'office' },
  'osm-way-117389706': { windowGlow: 'office' },
  'osm-way-111538131': { windowGlow: 'office' },
  'osm-way-92104661': {
    'sections.0.details.roofSigns.0.glow': true,
    'sections.0.details.roofSigns.1.glow': true,
    'sections.0.details.roofSigns.2.glow': true,
  },
  'osm-way-1292842070': { 'details.roofSign.glow': true },
  'objects/lamp-five-globe': {
    lights: [{ position: [0, 4.3, 0], radius: 11, color: '#ffe0b0' }],
    'parts.1.glow': 'lamp',
  },
  'objects/lamp-street': {
    lights: [{ position: [1.2, 6.1, 0], radius: 14, color: '#ffd49a' }],
    'parts.0.glow': 'lamp',
  },
};

/** Remove only the reviewed exact additions before comparing old geometry. */
export function withoutReviewedRingLighting(recipe: any, path: string): any {
  const copy = structuredClone(recipe);
  const id = path.replace(/^content\/buildings\/ring-block\//, '').replace(/\/source\.json$/, '');
  for (const [key, expected] of Object.entries(additions[id] ?? {})) {
    const segments = key.split('.');
    const field = segments.pop()!;
    const parent = segments.reduce((value, segment) => value[segment], copy);
    assert.deepEqual(parent[field], expected, `Reviewed lighting changed: ${path}/${key}`);
    delete parent[field];
  }
  return copy;
}
