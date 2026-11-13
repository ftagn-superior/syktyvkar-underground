import type { StaticPlacementError, WorldPublicationInfo } from './static-placement.js';

/** A whole-instance deletion, confirmed against the layout the player selected. */
export interface RemoveStaticRequest {
  operationId: string;
  worldEpoch: string;
  assetReleaseVersion: string;
  expectedLayoutRevision: number;
  entityId: string;
}
export type StaticRemovalError =
  StaticPlacementError | 'OBJECT_NOT_FOUND' | 'OBJECT_PROTECTED' | 'ALREADY_REMOVED';
export type RemoveStaticResult =
  | { operationId: string; ok: true; entityId: string; layoutRevision: number }
  | { operationId: string; ok: false; code: StaticRemovalError; message?: string };
export interface StaticRemovalEffect {
  kind: 'staticRemoval';
  publication: WorldPublicationInfo;
  protectedEntityIds: string[];
  modelNames?: Record<string, string>;
}

export function parseRemoveStaticRequest(value: unknown): RemoveStaticRequest | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).sort().join(',') !==
      'assetReleaseVersion,entityId,expectedLayoutRevision,operationId,worldEpoch' ||
    typeof v.operationId !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v.operationId) ||
    typeof v.worldEpoch !== 'string' ||
    !v.worldEpoch ||
    v.worldEpoch.length > 80 ||
    typeof v.assetReleaseVersion !== 'string' ||
    !/^[a-f0-9]{64}$/.test(v.assetReleaseVersion) ||
    !Number.isSafeInteger(v.expectedLayoutRevision) ||
    (v.expectedLayoutRevision as number) < 1 ||
    (v.expectedLayoutRevision as number) > 2147483647 ||
    typeof v.entityId !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,80}$/.test(v.entityId)
  )
    return;
  return v as unknown as RemoveStaticRequest;
}
