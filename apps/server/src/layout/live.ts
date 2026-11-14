import { resolve } from 'node:path';
import { access, rename, rm, mkdir } from 'node:fs/promises';
import {
  MAX_EDITABLE_STATIC_INSTANCES,
  LEGACY_PLACEMENT_CATALOG_VERSION,
  placedStaticInstance,
  type StaticObjectInstance,
  type BuildingPhysicsAsset,
  type PlaceStaticRequest,
  type PlaceStaticResult,
  type StaticPlacementError,
  type StaticPlacementEffect,
  type RemoveStaticRequest,
  type RemoveStaticResult,
  type StaticRemovalError,
  type StaticRemovalEffect,
  type WorldPublicationInfo,
} from '@su/contracts';
import { createAuthoritativeWorld, type AuthoritativeWorld } from '@su/simulation/server';
import type { ItemRuntime } from '../items/runtime.js';
import { StaticLayoutStore } from './store.js';
import type { prepareLayoutWorld } from './prepare.js';
import { applyPreparedLayoutDelta } from './release.js';
import { expectedStaticChange, staticChangeIds } from './static-change.js';
import { resolveStaticPlacement, StaticPlacementRejected } from './placement-pose.js';
import { LayoutPreparation, LayoutPreparationError } from './preparation.js';
import type { PreparedLayout } from './preparation-types.js';
import {
  hasPlacementGround,
  hasTerrainPlacementGround,
  type ServerPlacementCatalog,
} from './placement-catalog.js';

type Prepared = Awaited<ReturnType<typeof prepareLayoutWorld>>;
type Publication = Pick<
  Prepared,
  'definition' | 'manifest' | 'directory' | 'snapshot' | 'layoutHash'
>;
type StaticChange =
  { kind: 'place'; request: PlaceStaticRequest } | { kind: 'remove'; request: RemoveStaticRequest };
function changeIdentity(change: StaticChange) {
  return JSON.stringify(
    change.kind === 'place'
      ? { kind: change.kind, instance: placedStaticInstance(change.request) }
      : { kind: change.kind, entityId: change.request.entityId },
  );
}
/** Current and previous immutable publications share one pointer across HTTP and the room. */
export class LayoutPublications {
  current: Publication;
  previous?: Publication;
  private owned = new Set<string>();
  private redundantStaging = new Map<Publication, string>();
  constructor(readonly prepared: Prepared) {
    this.current = prepared;
  }
  info(epoch: string): WorldPublicationInfo {
    const p = this.current;
    return {
      worldEpoch: epoch,
      assetReleaseVersion: p.snapshot.assetReleaseVersion,
      layoutRevision: p.snapshot.revision,
      layoutHash: p.layoutHash,
      mapVersion: p.manifest.mapVersion,
      simulationConfigHash: p.manifest.simulationConfigHash,
      manifestUrl: this.url(p) + '/manifest.json',
    };
  }
  url(p: Publication) {
    return `/worlds/${p.manifest.worldId}/layouts/${p.snapshot.assetReleaseVersion}/${p.layoutHash}`;
  }
  find(path: string) {
    for (const p of [this.current, this.previous]) {
      if (!p) continue;
      const prefix = this.url(p) + '/';
      if (!path.startsWith(prefix)) continue;
      const file = path.slice(prefix.length);
      if (file === 'manifest.json' || Object.hasOwn(p.manifest.files, file)) return { p, file };
    }
  }
  async adopt(
    result: PreparedLayout,
    snapshot: Publication['snapshot'],
    definition: Publication['definition'],
  ): Promise<Publication> {
    const directory = resolve(
      this.prepared.release.directory,
      'layouts',
      snapshot.assetReleaseVersion,
      result.layoutHash,
    );
    const exists = await access(directory).then(
      () => true,
      () => false,
    );
    if (!exists) {
      await mkdir(resolve(directory, '..'), { recursive: true });
      await rename(result.stagingDirectory, directory);
      this.owned.add(directory);
    }
    const publication = {
      definition,
      manifest: result.manifest,
      directory,
      snapshot,
      layoutHash: result.layoutHash,
    };
    // A duplicate immutable directory is already ready. Reclaim its redundant copy
    // after the clients have applied the publication, outside the save/ready path.
    if (exists) this.redundantStaging.set(publication, result.stagingDirectory);
    return publication;
  }
  private async discardStaging(p: Publication) {
    const directory = this.redundantStaging.get(p);
    if (directory) {
      await rm(directory, { recursive: true, force: true });
      this.redundantStaging.delete(p);
    }
  }
  async discard(p: Publication) {
    await this.discardStaging(p);
    if (p !== this.current && p !== this.previous && this.owned.has(p.directory)) {
      await rm(p.directory, { recursive: true, force: true });
      this.owned.delete(p.directory);
    }
  }
  activate(p: Publication) {
    this.previous = this.current;
    this.current = p;
  }
  async cleanup() {
    this.previous = undefined;
    for (const publication of [...this.redundantStaging.keys()])
      await this.discardStaging(publication);
    for (const directory of [...this.owned])
      if (directory !== this.current.directory) {
        await rm(directory, { recursive: true, force: true });
        this.owned.delete(directory);
      }
  }
  async close() {
    for (const publication of [...this.redundantStaging.keys()])
      await this.discardStaging(publication);
    // Current and previous pointers were confirmed by SQL. Shutdown only discards
    // unactivated runtime candidates; committed immutable files survive restart.
    const confirmed = new Set([this.current.directory, this.previous?.directory]);
    for (const directory of [...this.owned])
      if (!confirmed.has(directory)) await rm(directory, { recursive: true, force: true });
    this.owned.clear();
    this.previous = undefined;
  }
}
export class LiveStaticPlacement {
  busy = false;
  fatal = false;
  metrics?: {
    operationId: string;
    preparationMs: number;
    writerWaitMs: number;
    workerBuildMs: number;
    workerWriteMs: number;
    workerReturnMs: number;
    adoptMs: number;
    cleanupMs?: number;
    validationMs: number;
    flushMs: number;
    commitMs: number;
    applyMs: number;
    previousPublicationMs?: number;
    fileCount: number;
    bytes: number;
    pauseStarted: number;
    pauseMs?: number;
    clients: Record<string, number>;
  };
  private inFlight?: {
    accountId: string;
    operation: StaticChange;
    promise: Promise<RemoveStaticResult>;
  };
  private layouts: StaticLayoutStore;
  private preparation: LayoutPreparation;
  private closing = false;
  private preparationSettled?: Promise<void>;
  private transitionOperationId?: string;
  private transitionStartedAt = 0;
  constructor(
    readonly publications: LayoutPublications,
    private items: ItemRuntime,
    private world: AuthoritativeWorld,
    private epoch: string,
    private changed: (operationId: string) => void,
    private neutral: () => void,
    readonly catalog?: ServerPlacementCatalog,
  ) {
    this.layouts = new StaticLayoutStore(items.store.ownership, publications.prepared.release);
    this.preparation = new LayoutPreparation(
      publications.prepared.release.directory,
      publications.prepared.release.metadata.assetReleaseVersion,
    );
  }
  effect(): StaticPlacementEffect | undefined {
    if (
      !this.catalog ||
      !(
        hasTerrainPlacementGround(this.publications.prepared.release) ||
        hasPlacementGround(this.publications.current.definition, this.publications.current.manifest)
      )
    )
      return;
    return {
      kind: 'staticPlacement',
      catalog: this.catalog.reference,
      publication: this.publications.info(this.epoch),
    };
  }

  removalEffect(): StaticRemovalEffect {
    return {
      kind: 'staticRemoval',
      publication: this.publications.info(this.epoch),
      protectedEntityIds: [
        ...this.publications.prepared.release.metadata.fixedInstanceIds,
        ...this.publications.current.definition.entities.map((i) => i.entityId),
      ],
      modelNames: this.catalog?.modelNames,
    };
  }

  place(
    accountId: string,
    request: PlaceStaticRequest,
    authorize: () => StaticPlacementError | undefined,
    validateNew: () => StaticPlacementError | undefined = () => undefined,
  ): Promise<PlaceStaticResult> {
    return this.change(
      { kind: 'place', request },
      accountId,
      authorize,
      validateNew,
    ) as Promise<PlaceStaticResult>;
  }

  remove(
    accountId: string,
    request: RemoveStaticRequest,
    authorize: () => StaticRemovalError | undefined,
    validateNew: () => StaticRemovalError | undefined = () => undefined,
  ): Promise<RemoveStaticResult> {
    return this.change({ kind: 'remove', request }, accountId, authorize, validateNew);
  }

  private change(
    operation: StaticChange,
    accountId: string,
    authorize: () => StaticRemovalError | undefined,
    validateNew: () => StaticRemovalError | undefined,
  ): Promise<RemoveStaticResult> {
    const { request } = operation;
    const fail = (code: StaticRemovalError): RemoveStaticResult => ({
      operationId: request.operationId,
      ok: false,
      code,
    });
    if (this.inFlight?.operation.request.operationId === request.operationId) {
      if (
        this.inFlight.accountId !== accountId ||
        changeIdentity(this.inFlight.operation) !== changeIdentity(operation)
      )
        return Promise.resolve(fail('OPERATION_CONFLICT'));
      const auth = authorize();
      return auth ? Promise.resolve(fail(auth)) : this.inFlight.promise;
    }
    const ownsSlot = !this.busy;
    if (ownsSlot) this.busy = true;
    let candidate: Publication | undefined;
    let applied = false;
    let probe: AuthoritativeWorld | undefined;
    let acceptedInstance: StaticObjectInstance | undefined;
    let physicsChange: ReturnType<AuthoritativeWorld['prepareStaticReplacement']> | undefined;
    let changedIds = new Set<string>();
    let compatibilityHash: string;
    let committed = false;
    const replay = () =>
      operation.kind === 'place'
        ? this.layouts.replayGame(accountId, operation.request)
        : this.layouts.replayRemoval(accountId, operation.request);
    const prerequisites = (reserved = false): StaticRemovalError | undefined => {
      const auth = authorize();
      if (auth) return auth;
      if (this.closing || this.items.closing || this.fatal || (this.items.unavailable && !reserved))
        return 'WORLD_NOT_READY';
      const ready = validateNew();
      if (ready) return ready;
      if (
        operation.kind === 'place' &&
        operation.request.placementCatalogVersion === LEGACY_PLACEMENT_CATALOG_VERSION
      )
        return 'CATALOG_CHANGED';
      if (operation.kind === 'place' && !this.effect()) return 'COMMAND_DISABLED';
      const info = this.publications.info(this.epoch);
      if (request.worldEpoch !== this.epoch) return 'STALE_WORLD';
      if (request.assetReleaseVersion !== info.assetReleaseVersion) return 'VERSION_MISMATCH';
      if (operation.kind === 'place') {
        if (
          operation.request.placementCatalogVersion !==
          this.catalog!.reference.placementCatalogVersion
        )
          return 'CATALOG_CHANGED';
      } else {
        const error = this.removalError(operation.request.entityId);
        if (error) return error;
      }
      if (request.expectedLayoutRevision !== info.layoutRevision) return 'LAYOUT_CHANGED';
      if (operation.kind === 'place' && !this.catalog!.assetIds.has(operation.request.assetId))
        return 'ASSET_NOT_ALLOWED';
    };
    const activate = (revision: number): RemoveStaticResult => {
      try {
        const started = performance.now();
        if (!applied) {
          physicsChange!.commit();
          applied = true;
        }
        this.items.store.definition = candidate!.definition;
        // The candidate is not exposed until SQL has confirmed this exact revision.
        candidate!.snapshot.revision = revision;
        this.publications.activate(candidate!);
        committed = true;
        this.transitionOperationId = request.operationId;
        this.transitionStartedAt = performance.now();
        if (this.metrics) this.metrics.applyMs = performance.now() - started;
        this.changed(request.operationId);
        this.items.setLayoutPaused(false);
        if (this.metrics) this.metrics.pauseMs = performance.now() - this.metrics.pauseStarted;
        return {
          operationId: request.operationId,
          ok: true,
          entityId:
            operation.kind === 'place'
              ? placedStaticInstance(operation.request).entityId
              : operation.request.entityId,
          layoutRevision: revision,
        };
      } catch {
        this.fatal = true;
        this.items.setLayoutPaused(true);
        return fail('STORAGE_UNAVAILABLE');
      }
    };
    const run = async (): Promise<RemoveStaticResult> => {
      // All ownership-session access is short and serialized. Building is outside the writer.
      const initial = await this.items.placeStatic(async () => {
        const auth = authorize();
        if (auth) return fail(auth);
        const prior = await replay();
        if (prior) {
          if (!prior.ok) return prior;
          const current = this.publications.current.snapshot.instances.find(
            (i) => i.entityId === prior.entityId,
          );
          if (this.fatal || !current || (operation.kind === 'remove' && current.enabled)) {
            this.fatal = true;
            this.items.setLayoutPaused(true);
            return fail('STORAGE_UNAVAILABLE');
          }
          return prior;
        }
        if (!ownsSlot || this.items.layoutPaused) return fail('WORLD_NOT_READY');
        const error = prerequisites();
        if (error) return fail(error);
        if (await this.layouts.gameRateLimited(accountId)) return fail('RATE_LIMITED');
        return undefined;
      });
      if (initial) return initial;
      if (this.closing || this.items.closing) return fail('WORLD_NOT_READY');
      const current = this.publications.current;
      const before = current.snapshot;
      if (operation.kind === 'place' && before.instances.length >= MAX_EDITABLE_STATIC_INSTANCES)
        return fail('CONTENT_LIMIT');
      try {
        if (operation.kind === 'place')
          acceptedInstance = resolveStaticPlacement(
            this.publications.prepared.release,
            operation.request,
          );
      } catch (error) {
        return fail(error instanceof StaticPlacementRejected ? error.code : 'INVALID_INPUT');
      }
      const owner =
        acceptedInstance ??
        before.instances.find(
          (i) => operation.kind === 'remove' && i.entityId === operation.request.entityId,
        )!;
      changedIds = staticChangeIds(this.publications.prepared.release, owner);
      const snapshot = {
        ...before,
        revision: before.revision + 1,
        instances: (operation.kind === 'place'
          ? [...before.instances, acceptedInstance!]
          : before.instances.map((i) =>
              i.entityId === operation.request.entityId
                ? { ...i, enabled: false, instanceRevision: i.instanceRevision + 1 }
                : i,
            )
        ).sort((a, b) => a.entityId.localeCompare(b.entityId)),
      };
      const preparationStarted = performance.now();
      let preparedResult: PreparedLayout | undefined;
      let preparationFinished!: () => void;
      this.preparationSettled = new Promise<void>((resolve) => {
        preparationFinished = resolve;
      });
      try {
        const publication = await this.preparation.prepare(
          snapshot,
          request.operationId,
          this.epoch,
          {
            beforeSnapshot: before,
            beforeManifest: current.manifest,
            owner,
          },
        );
        preparedResult = publication;
        if (!publication.geometryDelta) throw new Error('Missing prepared static geometry');
        const definition = applyPreparedLayoutDelta(
          this.publications.prepared.release,
          snapshot,
          current.definition,
          publication.geometryDelta,
        );
        if (
          !expectedStaticChange(
            this.publications.prepared.release,
            current,
            { world: definition, publication: { manifest: publication.manifest } },
            owner,
          )
        ) {
          await rm(publication.stagingDirectory, { recursive: true, force: true });
          return fail('COMMAND_DISABLED');
        }
        if (operation.kind === 'place') {
          probe = await createAuthoritativeWorld({
            ...definition,
            entities: [],
            buildings: publication.geometryDelta.buildings,
            initialItems: [],
          });
        }
        if (this.closing || this.items.closing || this.publications.current !== current) {
          await rm(publication.stagingDirectory, { recursive: true, force: true });
          return fail('WORLD_NOT_READY');
        }
        const adoptionStarted = performance.now();
        candidate = await this.publications.adopt(publication, snapshot, definition);
        const adoptMs = performance.now() - adoptionStarted;
        compatibilityHash = publication.compatibilityHash;
        this.metrics = {
          operationId: request.operationId,
          preparationMs: performance.now() - preparationStarted,
          workerBuildMs: publication.buildMs,
          workerWriteMs: publication.writeMs,
          workerReturnMs: publication.workerReturnMs,
          adoptMs,
          writerWaitMs: 0,
          validationMs: 0,
          flushMs: 0,
          commitMs: 0,
          applyMs: 0,
          fileCount: publication.fileCount,
          bytes: publication.bytes,
          pauseStarted: 0,
          clients: {},
        };
      } catch (error) {
        if (preparedResult)
          await rm(preparedResult.stagingDirectory, { recursive: true, force: true });
        return fail(error instanceof LayoutPreparationError ? error.code : 'STORAGE_UNAVAILABLE');
      } finally {
        preparationFinished();
      }
      const queuedAt = performance.now();
      let began = false;
      return this.items.placeStatic(async (flush) => {
        if (!began) {
          began = true;
          this.metrics!.writerWaitMs = performance.now() - queuedAt;
          this.metrics!.pauseStarted = performance.now();
          this.items.setLayoutPaused(true);
          this.neutral();
        }
        // On uncertain COMMIT the writer retries this same closure under the safe pause.
        const prior = await replay();
        if (prior) {
          if (!prior.ok) {
            this.items.setLayoutPaused(false);
            return prior;
          }
          const result = activate(prior.layoutRevision);
          const auth = authorize();
          return auth ? fail(auth) : result;
        }
        physicsChange?.dispose();
        physicsChange = undefined;
        const error = prerequisites(true);
        if (error) {
          this.items.setLayoutPaused(false);
          return fail(error);
        }
        const validationStarted = performance.now();
        if (operation.kind === 'place') {
          const groundIds = new Set(
            this.publications.prepared.release.terrain?.formatVersion === 2
              ? (this.publications.prepared.release.terrain.placementGroundIds ?? [])
              : [],
          );
          const error = this.world.checkStaticPlacement(
            acceptedInstance!,
            current.definition.buildingAssets[acceptedInstance!.assetId],
            groundIds,
          );
          if (error) {
            this.items.setLayoutPaused(false);
            return fail(error);
          }
          for (const derived of candidate!.definition.buildings) {
            if (
              !changedIds.has(derived.entityId) ||
              derived.entityId === acceptedInstance!.entityId
            )
              continue;
            const asset = candidate!.definition.buildingAssets[derived.assetId];
            const { min, max } = asset.bounds;
            const box: BuildingPhysicsAsset = {
              ...asset,
              colliders: [
                {
                  id: 'placement-bound',
                  kind: 'box',
                  position: {
                    x: (min.x + max.x) / 2,
                    y: (min.y + max.y) / 2,
                    z: (min.z + max.z) / 2,
                  },
                  size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
                  rotation: { x: 0, y: 0, z: 0, w: 1 },
                  friction: 0.6,
                  restitution: 0,
                },
              ],
            };
            const blocked = this.world.checkStaticPlacement(derived, box, groundIds);
            if (blocked) {
              this.items.setLayoutPaused(false);
              return fail(blocked);
            }
          }
          const snapshot = this.world.getSnapshot();
          if (
            current.definition.spawnPoints.some((p) =>
              probe!.overlapsPlayer(this.world.getPlayerSpawnPosition(p)),
            ) ||
            snapshot.items.some((i) => probe!.checkSavedItem(i)) ||
            snapshot.players.some((p) => probe!.overlapsPlayer(p.position))
          ) {
            this.items.setLayoutPaused(false);
            return fail('BLOCKED');
          }
        }
        this.metrics!.validationMs = performance.now() - validationStarted;
        const flushStarted = performance.now();
        await flush();
        this.metrics!.flushMs = performance.now() - flushStarted;
        const writeAuth = authorize();
        if (writeAuth || this.closing || this.items.closing) {
          this.items.setLayoutPaused(false);
          return fail(writeAuth ?? 'WORLD_NOT_READY');
        }
        physicsChange = this.world.prepareStaticReplacement(candidate!.definition, changedIds);
        const commitStarted = performance.now();
        const revision =
          operation.kind === 'place'
            ? await this.layouts.createGame(
                accountId,
                operation.request,
                candidate!.layoutHash,
                compatibilityHash,
                acceptedInstance!,
              )
            : await this.layouts.removeGame(
                accountId,
                operation.request,
                candidate!.layoutHash,
                compatibilityHash,
              );
        this.metrics!.commitMs = performance.now() - commitStarted;
        if (revision === undefined) {
          this.items.setLayoutPaused(false);
          return fail('LAYOUT_CHANGED');
        }
        return activate(revision);
      });
    };
    const promise = run().finally(async () => {
      physicsChange?.dispose();
      probe?.dispose();
      if (candidate && !committed && !this.fatal)
        await this.publications
          .discard(candidate)
          .catch((error) => console.error('Unused layout cleanup failed', error));
      if (
        ownsSlot &&
        this.metrics?.operationId === request.operationId &&
        this.metrics.pauseStarted &&
        this.metrics.pauseMs === undefined &&
        !this.items.layoutPaused
      )
        this.metrics.pauseMs = performance.now() - this.metrics.pauseStarted;
      if (ownsSlot && !committed) {
        this.busy = false;
        this.inFlight = undefined;
      }
    });
    if (ownsSlot) this.inFlight = { accountId, operation, promise };
    return promise;
  }

  async finishTransition(): Promise<void> {
    const operationId = this.transitionOperationId;
    if (!operationId) return;
    if (this.metrics?.operationId === operationId)
      this.metrics.previousPublicationMs = performance.now() - this.transitionStartedAt;
    const cleanupStarted = performance.now();
    try {
      await this.publications.cleanup();
    } finally {
      if (this.metrics?.operationId === operationId)
        this.metrics.cleanupMs = performance.now() - cleanupStarted;
      // Cleanup stops serving the previous publication before touching disk. A failed
      // unlink can be retried by the next cleanup/close without locking the editor.
      if (this.transitionOperationId === operationId) {
        this.transitionOperationId = undefined;
        this.busy = false;
        this.inFlight = undefined;
      }
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.preparation.close();
    await this.preparationSettled;
  }

  private removalError(entityId: string): StaticRemovalError | undefined {
    if (this.removalEffect().protectedEntityIds.includes(entityId)) return 'OBJECT_PROTECTED';
    const instance = this.publications.current.snapshot.instances.find(
      (i) => i.entityId === entityId,
    );
    if (!instance) return 'OBJECT_NOT_FOUND';
    if (!instance.enabled) return 'ALREADY_REMOVED';
  }
}
