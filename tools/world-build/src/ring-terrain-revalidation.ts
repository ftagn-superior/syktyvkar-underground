/** Revalidate historical support authoring against current generated contact geometry. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { canonicalJson, type WorldLayoutSnapshot } from '@su/contracts';
import { hash } from '@su/world-release';
import { validateFoundationSupportRule } from '@su/terrain-build/private-data';
import { readRingAnchorDecisions } from './ring-anchor-authoring.js';
import {
  inspectRingSupportModels,
  type RingModelSupportCatalog,
  type RingKitSupportCandidate,
} from './ring-support-authoring.js';
import type { RingKitSupportDecision } from './ring-kit-authoring.js';
import {
  inspectPilotSupportModel,
  PILOT_SUPPORT_ASSET_ID,
  PILOT_SUPPORT_FILE,
} from './pilot-support.js';
import { RING_TERRAIN_CANDIDATE_DIRECTORY as directory } from './ring-terrain-candidate.js';

type Observed = Awaited<ReturnType<typeof inspectRingSupportModels>>;

/** Source metadata/light changes are acceptable only after exact generated-contact comparison. */
export function assertRingSupportGeometryUnchanged(
  catalog: RingModelSupportCatalog & { catalogSha256: string },
  observed: Observed,
) {
  assert.equal(catalog.catalogSha256, observed.catalogSha256, 'Registered ring models changed');
  assert.equal(catalog.models.length, observed.models.length);
  const ids = new Set<string>();
  for (const model of catalog.models) {
    assert.ok(!ids.has(model.assetId), `Duplicate historical model: ${model.assetId}`);
    ids.add(model.assetId);
    const current = observed.models.find((m) => m.assetId === model.assetId);
    assert.ok(current, `Missing current model: ${model.assetId}`);
    for (const key of ['descriptorFile', 'recipeFile', 'kind'] as const)
      assert.equal(
        current.source[key],
        model.source[key],
        `Model source changed: ${model.assetId}`,
      );
    assert.equal(
      current.evidence.modelInputSha256,
      model.evidence.modelInputSha256,
      `Generated support geometry changed: ${model.assetId}`,
    );
  }
}

/** Does not rewrite old pins or carry physical acceptance into a new publication. */
export async function readRevalidatedRingTerrainInputs() {
  const inputs: Record<string, string> = {};
  const read = async (file: string, expected?: string) => {
    const bytes = await readFile(file);
    inputs[file] = hash(bytes);
    if (expected !== undefined)
      assert.equal(inputs[file], expected, `Historical input changed: ${file}`);
    return JSON.parse(bytes.toString());
  };
  const provenance = await read(`${directory}/full-terrain-provenance.json`);
  const supports = await read(
    `${directory}/model-supports.json`,
    provenance.inputs[`${directory}/model-supports.json`],
  );
  const kitsDocument = await read(
    `${directory}/kit-support-decisions.json`,
    provenance.inputs[`${directory}/kit-support-decisions.json`],
  );
  const anchorDocument = await read(
    `${directory}/anchor-contact-decisions.json`,
    provenance.inputs[`${directory}/anchor-contact-decisions.json`],
  );
  assert.equal(kitsDocument.modelClassificationSha256, anchorDocument.modelClassificationSha256);
  const catalog = await read(
    `${directory}/model-classification.json`,
    kitsDocument.modelClassificationSha256,
  );
  assert.equal(catalog.supportsSha256, inputs[`${directory}/model-supports.json`]);
  const policies = await read(
    `${directory}/model-policies.json`,
    supports.generator.files[`${directory}/model-policies.json`],
  );
  const candidates = await read(
    `${directory}/kit-support-candidates.json`,
    kitsDocument.candidateRulesSha256,
  );
  assert.equal(catalog.formatVersion, 1);
  assert.equal(catalog.status, 'unapplied-authoring-inputs');
  assert.equal(supports.formatVersion, 1);
  assert.equal(kitsDocument.status, 'explicit-game-authoring-requires-world-validation');
  const observed = await inspectRingSupportModels();
  assertRingSupportGeometryUnchanged(catalog, observed);
  const pilotSource = observed.models.find((model) => model.assetId === PILOT_SUPPORT_ASSET_ID)!;
  const pilot = await inspectPilotSupportModel(pilotSource.source.recipeSha256);
  const pilotCompanion = await read(PILOT_SUPPORT_FILE);
  assert.equal(
    pilot.modelInputSha256,
    pilotCompanion.evidence.modelInputSha256,
    'Generated pilot floor/porch geometry changed',
  );
  for (const model of catalog.models as RingModelSupportCatalog['models']) {
    const authored = policies.models.find((m: { assetId: string }) => m.assetId === model.assetId);
    assert.ok(authored, `Missing historical policy: ${model.assetId}`);
    assert.equal(authored.recipeSha256, model.source.recipeSha256);
    assert.deepEqual(authored.policy, model.policy);
  }
  const rules = supports.rules.map(validateFoundationSupportRule);
  assert.deepEqual(
    rules.find((rule: { assetId: string }) => rule.assetId === PILOT_SUPPORT_ASSET_ID),
    validateFoundationSupportRule(pilotCompanion.rule),
  );
  assert.equal(new Set(rules.map((rule: { assetId: string }) => rule.assetId)).size, rules.length);
  for (const rule of rules) {
    assert.equal(rule.ownerId, undefined);
    assert.equal(
      catalog.models.find((m: { assetId: string }) => m.assetId === rule.assetId)?.policy.kind,
      'foundation',
    );
  }
  assert.equal(
    rules.length,
    catalog.models.filter((m: { policy: { kind: string } }) => m.policy.kind === 'foundation')
      .length,
  );
  const kits: RingKitSupportDecision[] = kitsDocument.decisions;
  const kitIds = new Set<string>();
  for (const decision of kits) {
    assert.ok(
      !kitIds.has(decision.assetId),
      `Duplicate historical kit decision: ${decision.assetId}`,
    );
    kitIds.add(decision.assetId);
    const model = catalog.models.find((m: { assetId: string }) => m.assetId === decision.assetId);
    const candidate = candidates.models.find(
      (m: { assetId: string }) => m.assetId === decision.assetId,
    );
    assert.ok(model && candidate);
    assert.equal(model.policy.kind, 'unsupported');
    assert.equal(model.source.kind, 'kit');
    assert.deepEqual(candidate.source, model.source);
    assert.equal(candidate.modelInputSha256, model.evidence.modelInputSha256);
    assert.equal(decision.sourceRecipeSha256, model.source.recipeSha256);
    assert.ok(decision.maximumVisibleHeight > 0 && decision.maximumVisibleHeight <= 0.6);
    decision.rule = validateFoundationSupportRule(decision.rule);
    assert.equal(decision.rule.assetId, decision.assetId);
    assert.equal(decision.rule.ownerId, undefined);
  }
  assert.equal(kitIds.size, candidates.models.length);
  assert.equal(
    kitIds.size,
    catalog.models.filter((m: { policy: { kind: string } }) => m.policy.kind === 'unsupported')
      .length,
  );
  const supportCatalog: RingModelSupportCatalog = {
    formatVersion: 1,
    status: 'unapplied-authoring-inputs',
    models: catalog.models,
    rules,
  };
  const anchors = await readRingAnchorDecisions(supportCatalog);
  const generators: Record<string, { historicalSha256: string; currentSha256: string }> = {};
  for (const [file, expected] of Object.entries(supports.generator.files)) {
    generators[file] = {
      historicalSha256: expected as string,
      currentSha256: hash(await readFile(file)),
    };
  }
  return {
    catalog: supportCatalog,
    candidates: candidates.models as RingKitSupportCandidate[],
    pilot,
    kits,
    anchors,
    evidence: {
      formatVersion: 1,
      status: 'generated-contact-geometry-revalidated',
      historicalInputs: inputs,
      generators,
      models: observed.models.map((current) => ({
        assetId: current.assetId,
        historicalSource: catalog.models.find(
          (m: { assetId: string }) => m.assetId === current.assetId,
        ).source,
        currentSource: current.source,
        modelInputSha256: current.evidence.modelInputSha256,
      })),
      physicalAcceptance: 'requires-new-release-verification',
    },
  };
}

/** Existing entrance rules can be carried forward only for unchanged building XZ/rotation. */
export async function readRevalidatedRingEntranceOverrides(snapshot: WorldLayoutSnapshot) {
  const catalog = JSON.parse(await readFile(`${directory}/full-entrance-catalog.json`, 'utf8'));
  const bytes = await readFile(catalog.overrideArtifact.file);
  assert.equal(
    hash(bytes),
    catalog.overrideArtifact.sha256,
    'Historical entrance overrides changed',
  );
  const overrides = JSON.parse(bytes.toString()).map(validateFoundationSupportRule);
  assert.equal(
    canonicalJson(overrides),
    canonicalJson(catalog.owners.map((o: { rule: unknown }) => o.rule)),
  );
  for (const entry of catalog.owners) {
    const owner = snapshot.instances.find((o) => o.entityId === entry.entityId);
    assert.ok(
      owner && owner.assetId === entry.assetId,
      `Missing entrance owner: ${entry.entityId}`,
    );
    for (const axis of ['x', 'z'] as const)
      assert.ok(
        Math.abs(owner.position[axis] - entry.placement.position[axis]) <= 1e-8,
        `Entrance owner moved: ${entry.entityId}`,
      );
    assert.deepEqual(
      owner.rotation,
      entry.placement.rotation,
      `Entrance owner rotated: ${entry.entityId}`,
    );
  }
  return overrides;
}
