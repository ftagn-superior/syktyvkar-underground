import { resolve } from 'node:path';
import { access, rm } from 'node:fs/promises';
import {
  STATIC_PLACEMENT_ASSET_ID,
  STATIC_PLACEMENT_GROUND_Y,
  STATIC_PLACEMENT_YAW_STEPS,
  placedStaticInstance,
  type PlaceStaticRequest,
  type PlaceStaticResult,
  type StaticPlacementError,
  type StaticPlacementEffect,
  type WorldPublicationInfo,
} from '@su/contracts';
import { writeWorldPublication } from '@su/world-release';
import { createAuthoritativeWorld, type AuthoritativeWorld } from '@su/simulation/server';
import type { ItemRuntime } from '../items/runtime.js';
import { worldCompatibility } from '../items/store.js';
import { createLayoutPublication } from './release.js';
import { StaticLayoutStore } from './store.js';
import type { prepareLayoutWorld } from './prepare.js';

type Prepared = Awaited<ReturnType<typeof prepareLayoutWorld>>;
type Publication = Pick<
  Prepared,
  'definition' | 'manifest' | 'directory' | 'snapshot' | 'layoutHash'
>;
/** Current and previous immutable publications share one pointer across HTTP and the room. */
export class LayoutPublications {
  current: Publication;
  previous?: Publication;
  private owned = new Set<string>();
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
  async write(
    candidate: Awaited<ReturnType<typeof createLayoutPublication>>,
    snapshot: Publication['snapshot'],
  ) {
    const directory = resolve(
      this.prepared.release.directory,
      'layouts',
      snapshot.assetReleaseVersion,
      candidate.hash,
    );
    const exists = await access(directory).then(
      () => true,
      () => false,
    );
    try {
      await writeWorldPublication(candidate.publication, directory);
    } catch (error) {
      if (!exists) await rm(directory, { recursive: true, force: true });
      throw error;
    }
    if (!exists) this.owned.add(directory);
    return {
      definition: candidate.world,
      manifest: candidate.publication.manifest,
      directory,
      snapshot,
      layoutHash: candidate.hash,
    };
  }
  activate(p: Publication) {
    this.previous = this.current;
    this.current = p;
  }
  async cleanup() {
    this.previous = undefined;
    for (const directory of [...this.owned])
      if (directory !== this.current.directory) {
        await rm(directory, { recursive: true, force: true });
        this.owned.delete(directory);
      }
  }
  async close() {
    for (const directory of [...this.owned]) await rm(directory, { recursive: true, force: true });
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
    fileCount: number;
    bytes: number;
    pauseStarted: number;
    pauseMs?: number;
    clients: Record<string, number>;
  };
  private inFlight?: {
    accountId: string;
    request: PlaceStaticRequest;
    promise: Promise<PlaceStaticResult>;
  };
  private layouts: StaticLayoutStore;
  constructor(
    readonly publications: LayoutPublications,
    private items: ItemRuntime,
    private world: AuthoritativeWorld,
    private epoch: string,
    private changed: () => void,
    private neutral: () => void,
  ) {
    this.layouts = new StaticLayoutStore(items.store.ownership, publications.prepared.release);
  }
  effect(): StaticPlacementEffect | undefined {
    const p = this.publications.current,
      asset = p.definition.buildingAssets[STATIC_PLACEMENT_ASSET_ID];
    // The adopted release must contain the city ground and the fixed one-box asset.
    const flat = (rotation: { x: number; y: number; z: number; w: number }) =>
      Math.abs(rotation.x) + Math.abs(rotation.y) + Math.abs(rotation.z) < 1e-8;
    const slabs = p.definition.buildings.flatMap((i) =>
      !flat(i.rotation)
        ? []
        : (p.definition.buildingAssets[i.assetId]?.colliders ?? []).flatMap((c) =>
            c.kind !== 'box' ||
            !flat(c.rotation) ||
            Math.abs(i.position.y + c.position.y + c.size.y / 2) > 1e-6
              ? []
              : [
                  {
                    x: i.position.x + c.position.x,
                    z: i.position.z + c.position.z,
                    sx: c.size.x,
                    sz: c.size.z,
                  },
                ],
          ),
    );
    for (const i of p.definition.entities)
      if (Math.abs(i.position.y + i.size.y / 2) < 1e-6)
        slabs.push({ x: i.position.x, z: i.position.z, sx: i.size.x, sz: i.size.z });
    const ground = p.manifest.cells.every(({ bounds: b }) =>
      slabs.some(
        (s) =>
          s.x - s.sx / 2 <= b.min.x + 1e-6 &&
          s.x + s.sx / 2 >= b.max.x - 1e-6 &&
          s.z - s.sz / 2 <= b.min.z + 1e-6 &&
          s.z + s.sz / 2 >= b.max.z - 1e-6,
      ),
    );
    if (!asset || asset.colliders.length !== 1 || asset.colliders[0].kind !== 'box' || !ground)
      return;
    return {
      kind: 'staticPlacement',
      assetId: STATIC_PLACEMENT_ASSET_ID,
      groundY: STATIC_PLACEMENT_GROUND_Y,
      yawSteps: STATIC_PLACEMENT_YAW_STEPS,
      publication: this.publications.info(this.epoch),
    };
  }
  place(
    accountId: string,
    request: PlaceStaticRequest,
    authorize: () => StaticPlacementError | undefined,
    validateNew: () => StaticPlacementError | undefined = () => undefined,
  ): Promise<PlaceStaticResult> {
    const fail = (code: StaticPlacementError): PlaceStaticResult => ({
      operationId: request.operationId,
      ok: false,
      code,
    });
    if (this.inFlight?.request.operationId === request.operationId) {
      if (
        this.inFlight.accountId !== accountId ||
        JSON.stringify(placedStaticInstance(this.inFlight.request)) !==
          JSON.stringify(placedStaticInstance(request))
      )
        return Promise.resolve(fail('OPERATION_CONFLICT'));
      const auth = authorize();
      return auth ? Promise.resolve(fail(auth)) : this.inFlight.promise;
    }
    const alreadyBusy = this.busy;
    this.busy = true;
    let candidate: Publication | undefined;
    let applied = false;
    let reserved = false;
    const promise = this.items.placeStatic(async (flush) => {
      const auth = authorize();
      if (auth && !reserved) return fail(auth);
      const prior = await this.layouts.replayGame(accountId, request);
      if (prior) {
        if (!prior.ok) return prior;
        if (this.fatal) return fail('STORAGE_UNAVAILABLE');
        if (
          this.publications.current.definition.buildings.some((i) => i.entityId === prior.entityId)
        )
          return auth ? fail(auth) : prior;
        // A lost COMMIT acknowledgement must finish the same prepared publication under pause.
        if (!candidate) {
          this.fatal = true;
          this.items.setLayoutPaused(true);
          return fail('STORAGE_UNAVAILABLE');
        }
        const result = activate(prior.layoutRevision);
        return auth ? fail(auth) : result;
      }
      if (auth) {
        if (reserved) this.items.setLayoutPaused(false);
        return fail(auth);
      }
      if (
        alreadyBusy ||
        ((this.items.layoutPaused || this.items.unavailable) && !reserved) ||
        this.items.closing ||
        this.fatal
      )
        return fail('WORLD_NOT_READY');
      const ready = validateNew();
      if (ready) return fail(ready);
      if (!this.effect()) return fail('COMMAND_DISABLED');
      const info = this.publications.info(this.epoch);
      if (request.worldEpoch !== this.epoch) return fail('STALE_WORLD');
      if (request.assetReleaseVersion !== info.assetReleaseVersion) return fail('VERSION_MISMATCH');
      if (request.expectedLayoutRevision !== info.layoutRevision) return fail('LAYOUT_CHANGED');
      if (await this.layouts.gameRateLimited(accountId)) return fail('RATE_LIMITED');
      reserved = true;
      const pauseStarted = performance.now();
      this.items.setLayoutPaused(true);
      this.neutral();
      await flush();
      const instance = placedStaticInstance(request);
      const before = await this.layouts.readCandidate();
      if (before.snapshot.revision !== request.expectedLayoutRevision) {
        this.items.setLayoutPaused(false);
        return fail('LAYOUT_CHANGED');
      }
      const current = this.publications.current.definition;
      if (current.buildings.length + current.entities.length >= 2048) {
        this.items.setLayoutPaused(false);
        return fail('CONTENT_LIMIT');
      }
      const error = this.world.checkStaticPlacement(
        instance,
        current.buildingAssets[instance.assetId],
      );
      if (error) {
        this.items.setLayoutPaused(false);
        return fail(error);
      }
      // Only the candidate geometry: existing dynamic contact and occupied spawns are unrelated.
      const probe = await createAuthoritativeWorld({
        ...current,
        entities: [],
        buildings: [instance],
        initialItems: [],
      });
      try {
        if (
          current.spawnPoints.some((p) => !probe.findSpawn(undefined, [p])) ||
          this.world.getSnapshot().items.some((i) => probe.checkSavedItem(i))
        ) {
          this.items.setLayoutPaused(false);
          return fail('BLOCKED');
        }
      } finally {
        probe.dispose();
      }
      const snapshot = {
        ...before.snapshot,
        revision: before.snapshot.revision + 1,
        instances: [...before.snapshot.instances, instance].sort((a, b) =>
          a.entityId.localeCompare(b.entityId),
        ),
      };
      // Preparation errors are definite, before any placement commit.
      try {
        const preparationStarted = performance.now();
        const publication = await createLayoutPublication(
          this.publications.prepared.release,
          snapshot,
        );
        candidate = await this.publications.write(publication, snapshot);
        this.metrics = {
          operationId: request.operationId,
          preparationMs: performance.now() - preparationStarted,
          fileCount: publication.publication.payloads.size + 1,
          bytes: [...publication.publication.payloads.values()].reduce(
            (n, b) => n + b.byteLength,
            Buffer.byteLength(JSON.stringify(publication.publication.manifest, null, 2) + '\n'),
          ),
          pauseStarted,
          clients: {},
        };
      } catch {
        this.items.setLayoutPaused(false);
        return fail('STORAGE_UNAVAILABLE');
      }
      const writeAuth = authorize();
      if (writeAuth) {
        this.items.setLayoutPaused(false);
        return fail(writeAuth);
      }
      const revision = await this.layouts.createGame(
        accountId,
        request,
        candidate.layoutHash,
        worldCompatibility(candidate.definition),
      );
      if (revision === undefined) {
        this.items.setLayoutPaused(false);
        return fail('LAYOUT_CHANGED');
      }
      return activate(revision);
    });
    const activate = (revision: number): PlaceStaticResult => {
      try {
        if (!applied) {
          const { instanceRevision: _r, enabled: _e, ...instance } = placedStaticInstance(request);
          this.world.addStatic(instance, candidate!.definition);
          applied = true;
        }
        this.items.store.definition = candidate!.definition;
        candidate!.snapshot.revision = revision;
        this.publications.activate(candidate!);
        this.changed();
        return {
          operationId: request.operationId,
          ok: true,
          entityId: placedStaticInstance(request).entityId,
          layoutRevision: revision,
        };
      } catch {
        this.fatal = true;
        this.items.setLayoutPaused(true);
        return fail('STORAGE_UNAVAILABLE');
      }
    };
    if (!alreadyBusy) this.inFlight = { accountId, request, promise };
    return promise.finally(() => {
      if (!alreadyBusy) {
        this.busy = false;
        this.inFlight = undefined;
      }
    });
  }
}
