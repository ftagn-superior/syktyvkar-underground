import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { canonicalJson, type Bounds } from '@su/contracts';
import { hash } from '@su/world-release';
import {
  validateFoundationSupportRule,
  type FoundationSupportRuleV2,
} from '@su/terrain-build/private-data';
import { generateFootprint, type FootprintRecipe } from './city.js';
import { generateKit, type KitRecipe } from './kit.js';
import type { StaticMeshPart } from './glb.js';
import { readPilotSupportRule, PILOT_SUPPORT_ASSET_ID } from './pilot-support.js';
import { RING_TERRAIN_CANDIDATE_DIRECTORY } from './ring-terrain-candidate.js';

const catalogFile = 'content/buildings/ring-block/catalog.json';
type Point = [number, number];
type Triangle = [Point, Point, Point];
type Source = {
  descriptorFile: string;
  descriptorSha256: string;
  recipeFile: string;
  recipeSha256: string;
  kind: 'footprint' | 'kit' | 'ground';
};
export type RingModelPlacementPolicy =
  | { kind: 'foundation'; ruleAssetId: string; entrances: 'pilot-approach' | 'requires-review' }
  | {
      kind: 'ground-anchor';
      anchor: { x: number; y: number; z: number };
      vertical: true;
      contactRadius: number;
      maximumTerrainReliefMetres: number;
      interpretation: string;
    }
  | { kind: 'unsupported'; reason: string }
  | { kind: 'terrain-replacement'; reason: string };
export interface RingModelClassification {
  assetId: string;
  source: Source;
  policy: RingModelPlacementPolicy;
  evidence: {
    modelInputSha256: string;
    modelBounds?: Bounds;
    [key: string]: unknown;
  };
}
export interface RingModelSupportCatalog {
  formatVersion: 1;
  status: 'unapplied-authoring-inputs';
  models: RingModelClassification[];
  rules: FoundationSupportRuleV2[];
}
export interface RingKitSupportCandidate {
  assetId: string;
  status: 'requires-authoring-review';
  candidateRule?: FoundationSupportRuleV2;
  evidence?: Record<string, unknown>;
  limitations: string[];
}

function bottomTriangles(positions: number[], indices: number[], y: number): Triangle[] {
  const result: Triangle[] = [];
  for (let i = 0; i < indices.length; i += 3) {
    const ids = indices.slice(i, i + 3);
    if (!ids.every((index) => Math.abs(positions[index * 3 + 1] - y) < 1e-10)) continue;
    const triangle = ids.map((index) => [
      positions[index * 3],
      positions[index * 3 + 2],
    ]) as Triangle;
    const [a, b, c] = triangle;
    const area2 = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (Math.abs(area2) > 1e-14) result.push(triangle);
  }
  return result;
}

function visualGroundInputs(parts: StaticMeshPart[]) {
  return parts.flatMap((part) => {
    const triangles = bottomTriangles(part.positions, part.indices, 0);
    return triangles.length ? [{ partId: part.partId, triangles }] : [];
  });
}

function inspectFootprint(assetId: string, recipe: FootprintRecipe) {
  const model = generateFootprint(assetId, { ...recipe, merge: false });
  const bodies = model.physics.colliders.flatMap((collider) => {
    if (collider.kind !== 'mesh' || !(collider.id === 'body' || collider.id.endsWith('-body')))
      return [];
    assert.deepEqual(collider.position, { x: 0, y: 0, z: 0 });
    assert.deepEqual(collider.rotation, { x: 0, y: 0, z: 0, w: 1 });
    const ys = collider.vertices.filter((_, i) => i % 3 === 1);
    const minY = Math.min(...ys);
    return [
      {
        id: collider.id,
        minY,
        maxY: Math.max(...ys),
        triangles: bottomTriangles(collider.vertices, collider.indices, minY),
      },
    ];
  });
  const grounded = bodies.filter((body) => body.minY === 0);
  const elevated = bodies.filter((body) => body.minY > 0);
  assert.equal(
    grounded.length + elevated.length,
    bodies.length,
    `${assetId}: unsupported body plane`,
  );
  const effectiveSections = recipe.sections?.length
    ? recipe.sections.map((section) => ({ ...recipe, ...section, sections: undefined }))
    : [{ ...recipe, id: 'body' }];
  const entrances = effectiveSections.flatMap((section) => [
    ...(section.doors ?? []).map((point) => ({
      kind: 'authored-door-point',
      sectionId: section.id,
      point,
    })),
    ...(section.details?.porch
      ? [{ kind: 'authored-porch', sectionId: section.id, specification: section.details.porch }]
      : []),
  ]);
  const renderedBottoms = visualGroundInputs(model.parts);
  const structuralPorch = (partId: string) => /(^|-)porch(-steps)?$/.test(partId);
  const inputs = {
    bodyInputs: grounded,
    renderedGroundInputs: renderedBottoms.filter((part) => structuralPorch(part.partId)),
    decorativeGroundInputs: renderedBottoms.filter((part) => !structuralPorch(part.partId)),
    excludedElevatedBodies: elevated.map(({ triangles, ...body }) => ({
      ...body,
      bottomTriangleCount: triangles.length,
    })),
    entrances,
    modelBounds: model.physics.bounds,
  };
  return { ...inputs, modelInputSha256: hash(canonicalJson(inputs)) };
}

function inspectKit(assetId: string, recipe: KitRecipe) {
  const model = generateKit(assetId, { ...recipe, merge: false });
  const shapes = recipe.parts.flatMap((part) =>
    part.shapes.map((shape, index) => ({
      partId: part.id,
      shapeIndex: index,
      shape,
    })),
  );
  const inputs = {
    shapes,
    colliders: recipe.colliders,
    renderedGroundInputs: visualGroundInputs(model.parts),
    authoredBasePlanes: shapes.map(({ partId, shapeIndex, shape }) => ({
      partId,
      shapeIndex,
      kind: Object.keys(shape)[0],
      localY:
        'box' in shape
          ? shape.box.center[1] - shape.box.size[1] / 2
          : 'cylinder' in shape
            ? shape.cylinder.center[1] -
              (shape.cylinder.axis === 'y' ? shape.cylinder.length / 2 : shape.cylinder.radius)
            : 'cone' in shape
              ? shape.cone.center[1]
              : 'wedge' in shape
                ? shape.wedge.center[1]
                : shape.foliage.center[1],
      interpretation:
        'foliage' in shape ? 'authored-root-plane-not-rendered-minimum' : 'primitive-base-plane',
    })),
    modelBounds: model.physics.bounds,
  };
  return { ...inputs, modelInputSha256: hash(canonicalJson(inputs)) };
}

/** Inventory comes from the actual generators; it never infers a support from a model name. */
export async function inspectRingSupportModels() {
  const bytes = await readFile(catalogFile);
  const catalog: { assets: Record<string, string> } = JSON.parse(bytes.toString());
  const models = [];
  for (const [assetId, relative] of Object.entries(catalog.assets).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const descriptorFile = join(dirname(catalogFile), relative);
    const descriptorBytes = await readFile(descriptorFile);
    const descriptor = JSON.parse(descriptorBytes.toString());
    assert.equal(descriptor.assetId, assetId);
    const recipeFile = join(dirname(descriptorFile), descriptor.source.file);
    const recipeBytes = await readFile(recipeFile);
    const recipe = JSON.parse(recipeBytes.toString());
    const source: Source = {
      descriptorFile,
      descriptorSha256: hash(descriptorBytes),
      recipeFile,
      recipeSha256: hash(recipeBytes),
      kind: descriptor.source.kind,
    };
    assert.ok(
      ['footprint', 'kit', 'ground'].includes(source.kind),
      `Unsupported source ${assetId}`,
    );
    const evidence =
      source.kind === 'footprint'
        ? inspectFootprint(assetId, recipe)
        : source.kind === 'kit'
          ? inspectKit(assetId, recipe)
          : { modelInputSha256: hash(recipeBytes) };
    models.push({ assetId, source, evidence });
  }
  return { catalogFile, catalogSha256: hash(bytes), models };
}

/** Validate every model and source pin before yielding authoring inputs to a placement planner. */
export async function readRingModelSupportCatalog(): Promise<RingModelSupportCatalog> {
  const observed = await inspectRingSupportModels();
  const catalog = JSON.parse(
    await readFile(`${RING_TERRAIN_CANDIDATE_DIRECTORY}/model-classification.json`, 'utf8'),
  );
  const supports = JSON.parse(
    await readFile(`${RING_TERRAIN_CANDIDATE_DIRECTORY}/model-supports.json`, 'utf8'),
  );
  const policies = JSON.parse(
    await readFile(`${RING_TERRAIN_CANDIDATE_DIRECTORY}/model-policies.json`, 'utf8'),
  );
  assert.equal(catalog.formatVersion, 1);
  assert.equal(supports.formatVersion, 1);
  assert.equal(catalog.status, 'unapplied-authoring-inputs');
  assert.equal(catalog.catalogSha256, observed.catalogSha256, 'Model catalog changed');
  assert.equal(catalog.models.length, observed.models.length);
  const ids = new Set<string>();
  for (const model of catalog.models as RingModelClassification[]) {
    assert.ok(!ids.has(model.assetId), `Duplicate model classification ${model.assetId}`);
    ids.add(model.assetId);
    const current = observed.models.find((item) => item.assetId === model.assetId);
    assert.ok(current, `Unknown model classification ${model.assetId}`);
    assert.deepEqual(model.source, current.source, `Source changed: ${model.assetId}`);
    const authored = policies.models.find(
      (item: { assetId: string }) => item.assetId === model.assetId,
    );
    assert.ok(authored, `Missing explicit authoring policy: ${model.assetId}`);
    assert.equal(authored.recipeSha256, current.source.recipeSha256);
    assert.deepEqual(model.policy, authored.policy, `Placement policy is stale: ${model.assetId}`);
    assert.equal(
      model.evidence.modelInputSha256,
      current.evidence.modelInputSha256,
      `Generated support input changed: ${model.assetId}`,
    );
    assert.ok(
      ['foundation', 'ground-anchor', 'unsupported', 'terrain-replacement'].includes(
        model.policy.kind,
      ),
    );
  }
  const rules = (supports.rules as unknown[]).map(validateFoundationSupportRule);
  assert.equal(
    new Set(rules.map((rule) => rule.assetId)).size,
    rules.length,
    'Duplicate foundation rule',
  );
  for (const model of catalog.models as RingModelClassification[]) {
    if (model.policy.kind === 'foundation')
      assert.ok(
        rules.some((rule) => rule.assetId === model.assetId),
        `Missing foundation rule: ${model.assetId}`,
      );
  }
  for (const rule of rules) {
    assert.ok(ids.has(rule.assetId), `Unknown foundation model: ${rule.assetId}`);
    assert.equal(rule.ownerId, undefined, 'Catalog rules must not contain instance overrides');
    assert.equal(
      catalog.models.find((item: RingModelClassification) => item.assetId === rule.assetId).policy
        .kind,
      'foundation',
    );
  }
  assert.deepEqual(
    rules.find((rule) => rule.assetId === PILOT_SUPPORT_ASSET_ID),
    await readPilotSupportRule(),
  );
  for (const [path, expected] of Object.entries(supports.generator.files))
    assert.equal(
      hash(await readFile(path)),
      expected,
      `Support authoring generator changed: ${path}`,
    );
  assert.equal(
    catalog.supportsSha256,
    hash(await readFile(`${RING_TERRAIN_CANDIDATE_DIRECTORY}/model-supports.json`)),
  );
  return { formatVersion: 1, status: 'unapplied-authoring-inputs', models: catalog.models, rules };
}

/** Candidates are deliberately not merged into the accepted foundation rules above. */
export async function readRingKitSupportCandidates(
  inputCatalog?: RingModelSupportCatalog,
): Promise<RingKitSupportCandidate[]> {
  const catalog = inputCatalog ?? (await readRingModelSupportCatalog());
  const candidates = JSON.parse(
    await readFile(`${RING_TERRAIN_CANDIDATE_DIRECTORY}/kit-support-candidates.json`, 'utf8'),
  );
  assert.equal(candidates.formatVersion, 1);
  assert.equal(candidates.status, 'requires-authoring-review');
  for (const [path, expected] of Object.entries(candidates.generator.files))
    assert.equal(
      hash(await readFile(path)),
      expected,
      `Kit support authoring generator changed: ${path}`,
    );
  const ids = new Set<string>();
  for (const candidate of candidates.models) {
    assert.equal(candidate.status, 'requires-authoring-review');
    assert.ok(!ids.has(candidate.assetId), `Duplicate kit support candidate: ${candidate.assetId}`);
    ids.add(candidate.assetId);
    const model = catalog.models.find((item) => item.assetId === candidate.assetId);
    assert.ok(model, `Unknown kit support candidate: ${candidate.assetId}`);
    assert.equal(model.source.kind, 'kit');
    assert.equal(
      model.policy.kind,
      'unsupported',
      'A candidate must not override an accepted model policy',
    );
    assert.deepEqual(candidate.source, model.source);
    assert.equal(candidate.modelInputSha256, model.evidence.modelInputSha256);
    assert.ok(Array.isArray(candidate.limitations) && candidate.limitations.length > 0);
    if (candidate.candidateRule) {
      const rule = validateFoundationSupportRule(candidate.candidateRule);
      assert.equal(rule.assetId, candidate.assetId);
      assert.equal(rule.ownerId, undefined);
    }
  }
  assert.equal(
    ids.size,
    catalog.models.filter(
      (model) => model.source.kind === 'kit' && model.policy.kind === 'unsupported',
    ).length,
  );
  return candidates.models;
}
