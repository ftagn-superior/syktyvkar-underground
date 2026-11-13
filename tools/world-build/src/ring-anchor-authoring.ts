import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { hash } from '@su/world-release';
import { RING_TERRAIN_CANDIDATE_DIRECTORY as directory } from './ring-terrain-candidate.js';
import type { RingModelSupportCatalog } from './ring-support-authoring.js';

export async function readRingAnchorDecisions(catalog: RingModelSupportCatalog) {
  const document = JSON.parse(await readFile(`${directory}/anchor-contact-decisions.json`, 'utf8'));
  assert.equal(document.formatVersion, 1);
  assert.equal(document.status, 'explicit-unapplied-root-and-post-contact-decisions');
  assert.equal(
    document.modelClassificationSha256,
    hash(await readFile(`${directory}/model-classification.json`)),
  );
  const decisions: {
    assetId: string;
    sourceRecipeSha256: string;
    policy: {
      kind: 'ground-anchor';
      anchor: { x: number; y: number; z: number };
      contactRadius: number;
      maximumTerrainReliefMetres: number;
      contactDatum: 'minimum';
    };
  }[] = document.decisions;
  const ids = new Set<string>();
  for (const decision of decisions) {
    assert.ok(!ids.has(decision.assetId));
    ids.add(decision.assetId);
    const model = catalog.models.find((m) => m.assetId === decision.assetId)!;
    assert.ok(model && model.policy.kind === 'ground-anchor');
    assert.equal(decision.sourceRecipeSha256, model.source.recipeSha256);
    assert.equal(decision.policy.kind, 'ground-anchor');
    assert.equal(decision.policy.contactDatum, 'minimum');
    assert.deepEqual(decision.policy.anchor, model.policy.anchor);
    assert.equal(decision.policy.contactRadius, model.policy.contactRadius);
    assert.ok(
      decision.policy.maximumTerrainReliefMetres > 0 &&
        decision.policy.maximumTerrainReliefMetres <= 0.3,
    );
  }
  assert.equal(ids.size, catalog.models.filter((m) => m.policy.kind === 'ground-anchor').length);
  return decisions;
}
