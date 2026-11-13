import type { WorldLayoutSnapshot, WorldManifest } from '@su/contracts';

export interface PreparationJob {
  id: string;
  operationId: string;
  worldEpoch: string;
  releaseDirectory: string;
  assetReleaseVersion: string;
  snapshot: WorldLayoutSnapshot;
  stagingDirectory: string;
}
export interface WorkerPreparedLayout {
  id: string;
  operationId: string;
  worldEpoch: string;
  assetReleaseVersion: string;
  manifest: WorldManifest;
  layoutHash: string;
  compatibilityHash: string;
  stagingDirectory: string;
  buildMs: number;
  writeMs: number;
  completedAt: number;
  fileCount: number;
  bytes: number;
}
export interface PreparedLayout extends WorkerPreparedLayout {
  /** Main-thread message arrival, excluding probe, adoption and directory cleanup. */
  workerReturnMs: number;
}
export type PreparationReply =
  | { ok: true; value: WorkerPreparedLayout }
  | { ok: false; id: string; code: 'CONTENT_LIMIT' | 'STORAGE_UNAVAILABLE'; message: string };
