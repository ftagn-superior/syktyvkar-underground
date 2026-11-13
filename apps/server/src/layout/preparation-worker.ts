import { parentPort } from 'node:worker_threads';
import {
  createReleaseLayoutPublisher,
  readAuthoringRelease,
  type AuthoringRelease,
} from './release.js';
import { writeWorldPublication, WorldPublicationContentLimitError } from '@su/world-release';
import { worldCompatibility } from '../items/store.js';
import type { PreparationJob, PreparationReply } from './preparation-types.js';

let release: AuthoringRelease | undefined;
let publish: ReturnType<typeof createReleaseLayoutPublisher> | undefined;
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
    const candidate = await publish(job.snapshot);
    const compatibilityHash = worldCompatibility(candidate.world);
    const built = performance.now();
    await writeWorldPublication(candidate.publication, job.stagingDirectory, 8);
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
        error instanceof WorldPublicationContentLimitError
          ? 'CONTENT_LIMIT'
          : 'STORAGE_UNAVAILABLE',
      message: error instanceof Error ? error.message : String(error),
    };
  }
  parentPort!.postMessage(reply);
});
