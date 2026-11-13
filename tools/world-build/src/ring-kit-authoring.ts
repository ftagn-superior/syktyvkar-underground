import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { hash } from '@su/world-release';
import {
  validateFoundationSupportRule,
  type FoundationSupportRuleV2,
} from '@su/terrain-build/private-data';
import {
  readRingKitSupportCandidates,
  readRingModelSupportCatalog,
  type RingModelSupportCatalog,
} from './ring-support-authoring.js';
import { RING_TERRAIN_CANDIDATE_DIRECTORY } from './ring-terrain-candidate.js';

export interface RingKitSupportDecision {
  assetId: string;
  sourceRecipeSha256: string;
  treatment: 'individual-grounded-feet-or-existing-plinth' | 'shelter-wall-strips-and-sign-foot';
  maximumVisibleHeight: number;
  rule: FoundationSupportRuleV2;
  rationale: string[];
}

/** Explicit authored footings are distinct from the raw candidates and require world validation. */
export async function readRingKitSupportDecisions(
  inputCatalog?: RingModelSupportCatalog,
): Promise<RingKitSupportDecision[]> {
  const catalog = inputCatalog ?? (await readRingModelSupportCatalog());
  const candidates = await readRingKitSupportCandidates(catalog);
  const directory = RING_TERRAIN_CANDIDATE_DIRECTORY;
  const document = JSON.parse(await readFile(`${directory}/kit-support-decisions.json`, 'utf8'));
  assert.equal(document.formatVersion, 1);
  assert.equal(document.status, 'explicit-game-authoring-requires-world-validation');
  assert.equal(document.generator.file, 'tools/build-ring-kit-decisions.py');
  assert.equal(document.generator.sha256, hash(await readFile(document.generator.file)));
  assert.equal(
    document.modelClassificationSha256,
    hash(await readFile(`${directory}/model-classification.json`)),
  );
  assert.equal(
    document.candidateRulesSha256,
    hash(await readFile(`${directory}/kit-support-candidates.json`)),
  );
  const ids = new Set<string>();
  const decisions: RingKitSupportDecision[] = document.decisions;
  for (const decision of decisions) {
    assert.ok(!ids.has(decision.assetId), `Duplicate kit decision: ${decision.assetId}`);
    ids.add(decision.assetId);
    const model = catalog.models.find((m) => m.assetId === decision.assetId);
    assert.ok(model && candidates.some((c) => c.assetId === decision.assetId));
    assert.equal(model.source.kind, 'kit');
    assert.equal(model.source.recipeSha256, decision.sourceRecipeSha256);
    assert.ok(
      ['individual-grounded-feet-or-existing-plinth', 'shelter-wall-strips-and-sign-foot'].includes(
        decision.treatment,
      ),
    );
    assert.ok(
      Number.isFinite(decision.maximumVisibleHeight) &&
        decision.maximumVisibleHeight > 0 &&
        decision.maximumVisibleHeight <= 0.6,
    );
    assert.ok(
      Array.isArray(decision.rationale) &&
        decision.rationale.length > 0 &&
        decision.rationale.every((r) => typeof r === 'string' && r.trim()),
    );
    decision.rule = validateFoundationSupportRule(decision.rule);
    assert.equal(decision.rule.assetId, decision.assetId);
    assert.equal(decision.rule.ownerId, undefined);
  }
  assert.equal(ids.size, candidates.length, 'Every inspected rigid kit needs an explicit decision');
  return decisions;
}
