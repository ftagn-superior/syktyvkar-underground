import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { canonicalJson } from '@su/contracts';
import { hash } from '@su/world-release';
import {
  validateFoundationSupportRule,
  type FoundationSupportRuleV2,
} from '@su/terrain-build/private-data';
import { triangulate } from '@su/terrain-build/triangulate';
import { generateFootprint, type FootprintRecipe } from './city.js';
import { edgesOf, faces } from './facade.js';

export const PILOT_SUPPORT_ASSET_ID = 'osm-way-1258973447';
export const PILOT_SUPPORT_SOURCE_SHA256 =
  'a150b4178482bc236c3c8649cff5e6308ff17823d4f8143ba4041cf0caca766e';
const directory = `content/buildings/ring-block/${PILOT_SUPPORT_ASSET_ID}`;
export const PILOT_SUPPORT_FILE = `${directory}/terrain-support.json`;
export const PILOT_GROUNDED_SECTIONS = [
  'admissions',
  'spine-north',
  'spine-recess',
  'spine-middle',
  'tower-north',
  'entrance',
  'tower-south',
  'spine-south',
  'wing-north',
  'bump',
  'wing-middle',
  'wing-gym',
  'wing-south',
  'wing-south-end',
] as const;

/** Authoring evidence from the real model generator, also used by the reproducible union script. */
export async function inspectPilotSupportModel() {
  const bytes = await readFile(`${directory}/source.json`);
  assert.equal(
    hash(bytes),
    PILOT_SUPPORT_SOURCE_SHA256,
    'Pilot model source changed; review and regenerate its support rule',
  );
  const recipe: FootprintRecipe = JSON.parse(bytes.toString());
  assert.deepEqual(
    recipe.sections!.map((s) => s.id).sort(),
    [...PILOT_GROUNDED_SECTIONS, 'entrance-attic'].sort(),
  );
  const model = generateFootprint(PILOT_SUPPORT_ASSET_ID, { ...recipe, merge: false });
  const bodyFloorTriangles: { colliderId: string; triangles: number[][][] }[] = [];
  const bodyPlanes = model.physics.colliders.flatMap((collider) => {
    if (collider.kind !== 'mesh' || !collider.id.endsWith('-body')) return [];
    const ys = collider.vertices.filter((_, index) => index % 3 === 1);
    const minY = Math.min(...ys),
      maxY = Math.max(...ys),
      triangles: number[][][] = [];
    for (let i = 0; i < collider.indices.length; i += 3) {
      const ids = collider.indices.slice(i, i + 3);
      if (ids.every((index) => collider.vertices[index * 3 + 1] === minY))
        triangles.push(ids.map((index) => collider.vertices.slice(index * 3, index * 3 + 3)));
    }
    if (PILOT_GROUNDED_SECTIONS.some((id) => collider.id === `${id}-body`)) {
      assert.equal(minY, 0, `${collider.id}: observed foundation joint plane changed`);
      assert.equal(triangles.length, 2);
      bodyFloorTriangles.push({ colliderId: collider.id, triangles });
    } else assert.ok(Math.abs(minY - 16.8) < 1e-12, 'Elevated attic plane changed');
    return [{ id: collider.id, minY, maxY, bottomTriangles: triangles.length }];
  });
  assert.equal(bodyFloorTriangles.length, PILOT_GROUNDED_SECTIONS.length);
  const porchFloorTriangles = [
    'admissions-porch',
    'admissions-porch-steps',
    'entrance-porch',
    'entrance-porch-steps',
  ].map((partId) => {
    const part = model.parts.find((p) => p.partId === partId);
    assert.ok(part, `Missing observed porch part: ${partId}`);
    const triangles: number[][][] = [];
    for (let i = 0; i < part.indices.length; i += 3) {
      const ids = part.indices.slice(i, i + 3);
      if (ids.every((index) => part.positions[index * 3 + 1] === 0))
        triangles.push(
          ids.map((index) => [part.positions[index * 3], part.positions[index * 3 + 2]]),
        );
    }
    assert.equal(triangles.length, partId.endsWith('-steps') ? 2 : 6);
    return { partId, triangles };
  });
  const entrance = recipe.sections!.find((section) => section.id === 'entrance')!;
  const spec = entrance.details!.porch!;
  const edge = edgesOf(triangulate(entrance.outline).points)
    .filter((edge) => faces(edge, [spec.facing]))
    .reduce((a, b) => (b.length > a.length ? b : a));
  const center = edge.length * (1 - (spec.at ?? 0.5));
  const at = (along: number, out: number) => [
    edge.p[0] + edge.d[0] * (center + along) + edge.n[0] * out,
    edge.p[1] + edge.d[1] * (center + along) + edge.n[1] * out,
  ];
  const stepOuter = spec.depth * 0.75 + 1.6;
  const approach = { edge: [at(-1.2, stepOuter), at(1.2, stepOuter)], outward: edge.n };
  return {
    bodyPlanes,
    porchFloorTriangles,
    modelBounds: model.physics.bounds,
    approach,
    modelInputSha256: hash(canonicalJson({ bodyFloorTriangles, porchFloorTriangles, approach })),
    entrance: {
      sectionId: 'entrance',
      doorCenter: at(0, spec.depth * 0.75 + 0.02),
      doorWidth: 1.8,
      doorBaseY: 0,
      decorativeStepTopY: 0.24,
      stepOuterOffset: stepOuter,
      capsuleStopLocalXZ: at(0, stepOuter + 0.7),
      capsuleStopOffsetMetres: 0.7,
      scope:
        'Approach to the outer step boundary; stop outside the decorative steps. No interior passage or stair walkability claim.',
    },
  };
}

/** Read only explicit private authoring inputs; no model, pose, publication or database changes. */
export async function readPilotSupportRule(
  path = PILOT_SUPPORT_FILE,
): Promise<FoundationSupportRuleV2> {
  const companion = JSON.parse(await readFile(resolve(path), 'utf8'));
  assert.equal(companion?.formatVersion, 1, 'Unsupported pilot support companion');
  assert.equal(companion.source?.assetId, PILOT_SUPPORT_ASSET_ID, 'Wrong pilot support asset');
  assert.equal(companion.source?.recipeFile, 'source.json');
  assert.equal(
    companion.source?.recipeSha256,
    PILOT_SUPPORT_SOURCE_SHA256,
    'Unreviewed pilot source revision',
  );
  assert.equal(
    companion.source?.descriptorSha256,
    hash(await readFile(`${directory}/asset.json`)),
    'Pilot descriptor changed',
  );
  assert.equal(companion.generator?.script, 'tools/build-ring-pilot-support.py');
  assert.equal(
    companion.generator?.scriptSha256,
    hash(await readFile('tools/build-ring-pilot-support.py')),
    'Pilot support generator changed; regenerate companion',
  );
  assert.equal(companion.generator?.shapelyVersion, '2.2.0');
  const observed = await inspectPilotSupportModel();
  assert.equal(
    companion.evidence?.modelInputSha256,
    observed.modelInputSha256,
    'Generated model floor/porch geometry changed; review and regenerate the support rule',
  );
  const rule = validateFoundationSupportRule(companion.rule);
  assert.equal(rule.assetId, PILOT_SUPPORT_ASSET_ID);
  assert.equal(rule.jointY, 0, 'Pilot foundation must meet the observed underside at local Y=0');
  return rule;
}
