import { abortablePreparation } from './preparation';
import {
  canonicalJson,
  graphicsGroupIdentity,
  distanceToBoundsXZ,
  loadWorldCell,
  groupMembers,
  type BuildingInstance,
  type GraphicsGroup,
  type GraphicsLevel,
  type WorldManifest,
  type Vec3,
} from '@su/contracts';
import type { CellGraphics } from './cells';
import type { VerifiedResources } from './resources';
import { graphicsLevel } from './graphics-plan';
type Context = { manifest: WorldManifest; resources: VerifiedResources };
export interface FarGroupView {
  activate(): void;
  dispose(): void;
}
type Prepared = {
  group: GraphicsGroup;
  level: GraphicsLevel;
  members: BuildingInstance[];
  release: () => void;
  far?: FarGroupView;
  manifest: WorldManifest;
};
type State = {
  group: GraphicsGroup;
  wanted?: GraphicsLevel;
  current?: Prepared;
  pending?: Prepared;
  controller?: AbortController;
  error?: string;
  releaseAt?: number;
};
/** Owned by CellStreamer. Shares its queue, preparation slots and publication boundary. */
export class GroupGraphics {
  private states = new Map<string, State>();
  private players: Vec3[] = [];
  private playerPins = new Set<string>();
  private coverage = new Map<string, string[]>();
  private coverageCells = new Set<string>();
  private visual?: { center: Vec3; radius: number };
  private generation = 0;
  private planVersion = 0;
  private scheduledPlan = -1;
  private staged?: { context: Context; states: Map<string, State>; controller: AbortController };
  private near = new Map<
    string,
    { signature: string; instance: BuildingInstance; version: string }
  >();
  preparing = 0;
  peakSwapMs = 0;
  peakPreparationMs = 0;
  constructor(
    private context: Context,
    private graphics: CellGraphics,
    private clock: () => number,
  ) {
    this.indexContext();
  }
  private indexContext() {
    this.coverage.clear();
    for (const g of this.context.manifest.graphics?.groups ?? [])
      for (const id of g.coverageCellIds) {
        let groups = this.coverage.get(id);
        if (!groups) this.coverage.set(id, (groups = []));
        groups.push(g.groupId);
      }
    this.setPlayers(this.players);
  }
  get enabled() {
    return !!this.context.manifest.graphics && !!this.graphics.prepareFarGroup;
  }
  setPlayers(players: Vec3[]) {
    this.players = players;
    this.playerPins = new Set(
      (this.context.manifest.graphics?.groups ?? [])
        .filter((g) => players.some((p) => distanceToBoundsXZ(p, g.bounds) <= 60))
        .map((g) => g.groupId),
    );
  }
  reservePreparationSlot() {
    if (this.preparing < 4) return;
    const candidates = [...this.states.values()]
      .filter((s) => s.controller && !s.controller.signal.aborted)
      .sort((a, b) => (a.wanted === 'far' ? -1 : 0) - (b.wanted === 'far' ? -1 : 0));
    candidates[0]?.controller?.abort();
  }
  get playerReady() {
    return (
      !this.enabled ||
      [...this.playerPins].every((id) => {
        const s = this.states.get(id);
        return s?.current?.level === 'near' && !s.error;
      })
    );
  }
  get playerProblem() {
    return [...this.playerPins].map((id) => this.states.get(id)?.error).find(Boolean);
  }
  plan(center: Vec3, radius: number, coverageCells: Iterable<string>) {
    this.coverageCells = new Set(coverageCells);
    this.visual = { center, radius };
    this.planVersion++;
    this.refresh();
  }
  private refresh() {
    if (!this.enabled || !this.visual || this.staged) return;
    const { center, radius } = this.visual;
    for (const group of this.context.manifest.graphics!.groups) {
      let s = this.states.get(group.groupId);
      const distance = distanceToBoundsXZ(center, group.bounds);
      const projection = this.graphics.projectGraphicsGroup?.(group.bounds, group.groupId) ?? {
        pixels: Infinity,
        visible: true,
        nearPlane: false,
      };
      const playerPinned = this.playerPins.has(group.groupId),
        pinned = projection.pinned || playerPinned;
      const covered = group.coverageCellIds.some((id) => this.coverageCells.has(id));
      if (!s && distance > radius + 125 && !pinned && !covered) continue;
      if (!s) {
        s = { group };
        this.states.set(group.groupId, s);
      }
      const wanted =
        covered ||
        distance <= radius + 125 ||
        pinned ||
        (s.wanted !== undefined && distance <= radius + 300);
      const level = wanted
        ? playerPinned
          ? 'near'
          : graphicsLevel(group.bounds, projection, [], s.wanted ?? s.current?.level)
        : undefined;
      if (level !== s.wanted) {
        s.wanted = level;
        s.controller?.abort();
        s.pending?.release();
        s.pending = undefined;
        s.error = undefined;
      }
      if (wanted) s.releaseAt = undefined;
      else s.releaseAt ??= this.clock() + 5000;
    }
  }
  schedule(available: number) {
    if (this.scheduledPlan === this.planVersion) this.refresh();
    this.scheduledPlan = this.planVersion;
    if (!this.enabled || this.staged) return;
    const pending = [...this.states.values()]
      .filter(
        (s) => s.wanted && s.current?.level !== s.wanted && !s.controller && !s.pending && !s.error,
      )
      .sort(
        (a, b) =>
          (a.wanted === 'near' ? -1e6 : 0) -
          (b.wanted === 'near' ? -1e6 : 0) +
          (this.visual
            ? distanceToBoundsXZ(this.visual.center, a.group.bounds) -
              distanceToBoundsXZ(this.visual.center, b.group.bounds)
            : 0),
      );
    for (const s of pending) {
      if (available-- <= 0) break;
      const controller = new AbortController();
      s.controller = controller;
      this.preparing++;
      const generation = this.generation,
        context = this.context,
        level = s.wanted!;
      const started = this.clock();
      void this.prepare(context, s.group, level, controller.signal)
        .then((p) => {
          if (controller.signal.aborted || generation !== this.generation || s.wanted !== level)
            p.release();
          else s.pending = p;
        })
        .catch((e) => {
          if (!controller.signal.aborted && generation === this.generation) s.error = String(e);
        })
        .finally(() => {
          if (s.controller === controller) s.controller = undefined;
          this.preparing--;
          this.peakPreparationMs = Math.max(this.peakPreparationMs, this.clock() - started);
        });
    }
  }
  private async prepare(
    context: Context,
    group: GraphicsGroup,
    level: GraphicsLevel,
    signal: AbortSignal,
  ): Promise<Prepared> {
    const read = (path: string, requestSignal?: AbortSignal) =>
      context.resources.read(
        path,
        requestSignal ? AbortSignal.any([signal, requestSignal]) : signal,
        level === 'near' ? -1e9 : 0,
      );
    if (level === 'far') {
      await context.resources.prefetchGroup(group.groupId, 'far', signal);
      const far = await abortablePreparation(
        this.graphics.prepareFarGroup!(group, read, signal),
        signal,
        (view) => view.dispose(),
      );
      this.graphics.recordGraphicsResidency?.();
      if (signal.aborted) {
        far.dispose();
        signal.throwIfAborted();
      }
      return {
        group,
        level,
        members: [],
        manifest: context.manifest,
        far,
        release: () => far.dispose(),
      };
    }
    const cell = await loadWorldCell(context.manifest, group.ownerCellId, (path) => read(path)),
      members = groupMembers(group, cell.buildings);
    const release = await abortablePreparation(
      this.graphics.prepareCellAssets(
        context.manifest,
        [...new Set(members.map((m) => m.assetId))],
        read,
        signal,
      ),
      signal,
      (release) => release(),
    );
    this.graphics.recordGraphicsResidency?.();
    if (signal.aborted) {
      release();
      signal.throwIfAborted();
    }
    return { group, level, members, release, manifest: context.manifest };
  }
  private reconcileNear(states: Iterable<State>) {
    const next = new Map<
      string,
      { signature: string; instance: BuildingInstance; version: string }
    >();
    for (const s of states)
      for (const i of s.current?.members ?? []) {
        const version = s.current!.manifest.assets[i.assetId].version;
        next.set(i.entityId, { signature: version + canonicalJson(i), instance: i, version });
      }
    for (const [id, old] of this.near)
      if (next.get(id)?.signature !== old.signature) this.graphics.releaseStatic(id);
    const acquired: string[] = [];
    try {
      for (const [id, n] of next)
        if (this.near.get(id)?.signature !== n.signature) {
          this.graphics.retainStatic(n.instance, n.version);
          acquired.push(id);
        }
    } catch (e) {
      for (const id of acquired) this.graphics.releaseStatic(id);
      this.near = new Map(
        [...this.near].filter(([id, o]) => next.get(id)?.signature === o.signature),
      );
      throw e;
    }
    this.near = next;
  }
  pump(deadline: number) {
    if (!this.enabled || this.staged) return;
    const now = this.clock();
    const work = [...this.states]
      .filter(([, s]) => s.pending || (!s.wanted && (s.releaseAt ?? Infinity) <= now))
      .sort(
        ([, a], [, b]) =>
          (a.pending?.level === 'near' ? -1 : 0) - (b.pending?.level === 'near' ? -1 : 0),
      );
    for (const [id, s] of work) {
      if (this.clock() >= deadline) break;
      const started = this.clock();
      if (s.pending) {
        const old = s.current,
          prepared = s.pending;
        s.pending = undefined;
        s.current = prepared;
        try {
          prepared.far?.activate();
          this.reconcileNear(this.states.values());
          this.graphics.recordGraphicsResidency?.();
          old?.release();
        } catch (e) {
          s.current = old;
          prepared.release();
          s.error = String(e);
          throw e;
        }
      }
      if (!s.wanted && (s.releaseAt ?? Infinity) <= this.clock()) {
        s.controller?.abort();
        const old = s.current;
        s.current = undefined;
        this.reconcileNear(this.states.values());
        old?.release();
        this.states.delete(id);
      }
      this.peakSwapMs = Math.max(this.peakSwapMs, this.clock() - started);
    }
  }
  async stage(context: Context, parentSignal: AbortSignal) {
    const controller = new AbortController(),
      signal = AbortSignal.any([parentSignal, controller.signal]);
    this.generation++;
    for (const s of this.states.values()) {
      s.controller?.abort();
      s.pending?.release();
      s.pending = undefined;
    }
    const states = new Map<string, State>(),
      stage = { context, states, controller };
    this.staged = stage;
    const groups = new Map(context.manifest.graphics?.groups.map((g) => [g.groupId, g]) ?? []);
    const work = [...groups.values()].flatMap((group) => {
      const old = this.states.get(group.groupId),
        visual = this.visual;
      const distance = visual ? distanceToBoundsXZ(visual.center, group.bounds) : Infinity;
      const projection = this.graphics.projectGraphicsGroup?.(group.bounds, group.groupId) ?? {
        pixels: Infinity,
        visible: true,
        nearPlane: false,
      };
      const pinned =
        projection.pinned || this.players.some((p) => distanceToBoundsXZ(p, group.bounds) <= 60);
      const wanted =
        group.coverageCellIds.some((id) => this.coverageCells.has(id)) ||
        pinned ||
        (visual &&
          (distance <= visual.radius + 125 || (old?.wanted && distance <= visual.radius + 300)));
      if (!wanted && !old?.current) return [];
      const level = wanted
        ? graphicsLevel(group.bounds, projection, this.players, old?.wanted ?? old?.current?.level)
        : undefined;
      const s: State = {
        ...old,
        group,
        wanted: level,
        pending: undefined,
        controller: undefined,
        error: undefined,
        current: undefined,
      };
      states.set(group.groupId, s);
      return [{ old, s }];
    });
    let cursor = 0;
    const prepare = async () => {
      while (cursor < work.length) {
        signal.throwIfAborted();
        const { old, s } = work[cursor++],
          group = s.group;
        if (
          old?.current &&
          old.current.level === (s.wanted ?? old.current.level) &&
          canonicalJson(graphicsGroupIdentity(old.current.manifest, old.current.group)) ===
            canonicalJson(graphicsGroupIdentity(context.manifest, group)) &&
          (old.current.level === 'far' ||
            old.current.members.every(
              (i) =>
                old.current!.manifest.assets[i.assetId].version ===
                context.manifest.assets[i.assetId].version,
            ))
        ) {
          s.current = old.current;
          continue;
        }
        const prepared = await this.prepare(
          context,
          group,
          s.wanted ?? old?.current?.level ?? 'far',
          signal,
        );
        if (signal.aborted || this.staged !== stage) {
          prepared.release();
          throw new DOMException('Cancelled', 'AbortError');
        }
        s.current = prepared;
      }
    };
    const worker = async () => {
      try {
        await prepare();
      } catch (error) {
        controller.abort();
        throw error;
      }
    };
    const results = await Promise.allSettled([worker(), worker(), worker()]);
    const failure = results.find((r) => r.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    signal.throwIfAborted();
  }
  adopt() {
    if (!this.staged) return;
    const { context, states } = this.staged;
    for (const s of states.values())
      if (s.current && s.current !== this.states.get(s.group.groupId)?.current)
        s.current.far?.activate();
    this.reconcileNear(states.values());
    this.graphics.recordGraphicsResidency?.();
    for (const [id, s] of this.states)
      if (s.current && s.current !== states.get(id)?.current) s.current.release();
    for (const s of states.values())
      if (s.current) {
        s.current.manifest = context.manifest;
        s.current.group = s.group;
      }
    this.states = states;
    this.context = context;
    this.indexContext();
    this.staged = undefined;
    this.refresh();
  }
  cancelStage() {
    if (!this.staged) return;
    this.staged.controller.abort();
    for (const [id, s] of this.staged.states)
      if (s.current && s.current !== this.states.get(id)?.current) s.current.release();
    this.staged = undefined;
  }
  readyCell(id: string) {
    return (
      !this.enabled ||
      (this.coverage.get(id) ?? []).every((groupId) => {
        const s = this.states.get(groupId);
        return !!s?.current && (s.wanted !== 'near' || s.current.level === 'near');
      })
    );
  }
  get ready() {
    return (
      !this.enabled ||
      [...this.states.values()].every(
        (s) => !s.wanted || (s.current?.level === s.wanted && !s.error),
      )
    );
  }
  get problem() {
    return [...this.states.values()].find((s) => s.error)?.error;
  }
  retry() {
    for (const s of this.states.values()) s.error = undefined;
  }
  *definitions(): Iterable<BuildingInstance> {
    for (const state of this.states.values()) {
      yield* state.current?.members ?? [];
      yield* state.pending?.members ?? [];
    }
  }
  diagnostics() {
    return [...this.states.values()].map((s) => ({
      id: s.group.groupId,
      version: s.group.version,
      wanted: s.wanted,
      current: s.current?.level,
      pending: s.pending?.level,
      preparing: !!s.controller,
      error: s.error,
      nearInstances: s.current?.members.length ?? 0,
      geometryBytes: s.current?.level === 'far' ? s.group.far.geometryBytes : 0,
    }));
  }
  dispose() {
    this.generation++;
    this.cancelStage();
    for (const s of this.states.values()) {
      s.controller?.abort();
      s.pending?.release();
    }
    for (const id of this.near.keys()) this.graphics.releaseStatic(id);
    this.near.clear();
    for (const s of this.states.values()) s.current?.release();
    this.states.clear();
  }
}
