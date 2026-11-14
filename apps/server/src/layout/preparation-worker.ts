import { canonicalJson } from '@su/contracts';
import { expectedStaticChange, staticChangeIds } from './static-change.js';
import type { StaticLayoutGeometryDelta } from './release.js';
import { parentPort } from 'node:worker_threads';
import {
  createReleaseLayoutPublisher,
  applyPreparedLayoutDelta,
  layoutHash,
  readAuthoringRelease,
  type AuthoringRelease,
} from './release.js';
import { writeWorldPublication, WorldPublicationContentLimitError } from '@su/world-release';
import { worldCompatibility } from '../items/store.js';
import type { PreparationJob, PreparationReply } from './preparation-types.js';

let release: AuthoringRelease | undefined;
let publish: ReturnType<typeof createReleaseLayoutPublisher> | undefined;
let previous: Awaited<ReturnType<ReturnType<typeof createReleaseLayoutPublisher>>> | undefined;
// One operation at a time is enforced by the owning room. This worker has no DB connection.
parentPort!.on('message', async (job: PreparationJob) => {
  let reply: PreparationReply;
  try {
    const started = performance.now();
    release ??= await readAuthoringRelease(job.releaseDirectory);
    if (
      release.directory !== job.releaseDirectory ||
      release.metadata.assetReleaseVersion !== job.assetReleaseVersion
    )
      throw new Error('Preparation worker asset release changed');
    publish ??= createReleaseLayoutPublisher(release);
    const before = job.change
      ? previous?.hash === layoutHash(job.change.beforeSnapshot)
        ? previous
        : await publish(job.change.beforeSnapshot)
      : undefined;
    const candidate = await publish(job.snapshot);
    let geometryDelta: StaticLayoutGeometryDelta | undefined;
    if (job.change && before) {
      if (
        !expectedStaticChange(
          release,
          { definition: before.world, manifest: job.change.beforeManifest },
          candidate,
          job.change.owner,
        )
      ) {
        const error = new Error('Unexpected live static publication change');
        error.name = 'UnexpectedStaticChange';
        throw error;
      }
      const allowed = staticChangeIds(release, job.change.owner);
      const buildings = candidate.world.buildings.filter((i) => allowed.has(i.entityId));
      geometryDelta = {
        removedIds: [...allowed],
        buildings,
        assets: Object.fromEntries(
          buildings
            .filter((i) => !release!.definition.buildingAssets[i.assetId])
            .map((i) => [i.assetId, candidate.world.buildingAssets[i.assetId]]),
        ),
      };
      if (
        canonicalJson(
          applyPreparedLayoutDelta(release, job.snapshot, before.world, geometryDelta),
        ) !== canonicalJson(candidate.world)
      )
        throw new Error('Prepared layout delta differs from the validated publication');
    }
    const compatibilityHash = worldCompatibility(candidate.world);
    const built = performance.now();
    await writeWorldPublication(candidate.publication, job.stagingDirectory, 8);
    previous = candidate;
    reply = {
      ok: true,
      value: {
        id: job.id,
        operationId: job.operationId,
        worldEpoch: job.worldEpoch,
        assetReleaseVersion: job.assetReleaseVersion,
        manifest: candidate.publication.manifest,
        layoutHash: candidate.hash,
        compatibilityHash,
        geometryDelta,
        stagingDirectory: job.stagingDirectory,
        buildMs: built - started,
        writeMs: performance.now() - built,
        completedAt: performance.timeOrigin + performance.now(),
        fileCount: candidate.publication.payloads.size + 1,
        bytes: [...candidate.publication.payloads.values()].reduce(
          (n, b) => n + b.byteLength,
          Buffer.byteLength(JSON.stringify(candidate.publication.manifest, null, 2) + '\n'),
        ),
      },
    };
  } catch (error) {
    reply = {
      ok: false,
      id: job.id,
      code:
        error instanceof Error && error.name === 'UnexpectedStaticChange'
          ? 'COMMAND_DISABLED'
          : error instanceof WorldPublicationContentLimitError
            ? 'CONTENT_LIMIT'
            : 'STORAGE_UNAVAILABLE',
      message: error instanceof Error ? error.message : String(error),
    };
  }
  parentPort!.postMessage(reply);
});
