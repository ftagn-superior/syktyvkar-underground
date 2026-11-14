import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  cellsIntersectingBounds,
  canonicalJson,
  changedWorldPublicationCells,
  worldManifestIdentity,
  type WorldCell,
  type WorldManifest,
  type BuildingInstance,
  type StaticEntityDefinition,
} from '@su/contracts';
import { buildWorld } from '../../../../tools/world-build/src/index.js';
import { CellStreamer, cellNeighborhood, circularCells, type CellGraphics } from './cells';
import { VerifiedByteCache, VerifiedResources } from './resources';
let directory: string;
let manifest: WorldManifest;
let packedManifest: WorldManifest;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'su-dm-cells-'));
  manifest = await buildWorld(resolve('content/worlds/streaming-lab/world.json'), directory);
  packedManifest = await buildWorld(
    resolve('content/worlds/streaming-lab/world.json'),
    join(directory, 'packed'),
    { physicsPacks: true },
  );
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function until(stream: CellStreamer, predicate = () => stream.criticalReady) {
  const deadline = performance.now() + 10000;
  while (performance.now() < deadline) {
    stream.pump(1000);
    if (predicate()) return;
    await tick();
  }
  throw new Error(JSON.stringify(stream.diagnostics()));
}
function fixture(clockStep = 0, packed = false) {
  const selectedManifest = packed ? packedManifest : manifest;
  const selectedDirectory = packed ? join(directory, 'packed') : directory;
  let now = 0;
  const reads: string[] = [];
  const cache = new VerifiedByteCache();
  const resources = new VerifiedResources(selectedManifest, '/', {
    cache,
    fetch: async (url) => {
      const path = String(url).slice(1);
      reads.push(path);
      return new Response(await readFile(join(selectedDirectory, path)));
    },
  });
  const physicsEvents: string[] = [],
    graphicsEvents: string[] = [];
  const physics = new Map<string, number>(),
    graphical = new Map<string, number>();
  const add = (map: Map<string, number>, item: BuildingInstance | StaticEntityDefinition) =>
    map.set(item.entityId, (map.get(item.entityId) ?? 0) + 1);
  const remove = (map: Map<string, number>, id: string) => {
    const count = map.get(id);
    if (!count) throw new Error('Double release: ' + id);
    if (count === 1) map.delete(id);
    else map.set(id, count - 1);
  };
  let pins = 0;
  const graphics: CellGraphics = {
    prepareCellAssets: async () => {
      pins++;
      return () => {
        pins--;
      };
    },
    retainStatic: (item) => {
      graphicsEvents.push(`retain:${item.entityId}`);
      add(graphical, item);
    },
    releaseStatic: (id) => {
      graphicsEvents.push(`release:${id}`);
      remove(graphical, id);
    },
  };
  const stream = new CellStreamer(
    selectedManifest,
    resources,
    {
      retainStatic: (item) => {
        physicsEvents.push(`retain:${item.entityId}`);
        add(physics, item);
      },
      releaseStatic: (id) => {
        physicsEvents.push(`release:${id}`);
        remove(physics, id);
      },
    },
    graphics,
    () => {
      now += clockStep;
      return now;
    },
  );
  return {
    stream,
    reads,
    cache,
    resources,
    physicsEvents,
    graphicsEvents,
    physics,
    graphical,
    graphics,
    pins: () => pins,
    advance: (budgetMs = 1000) => {
      now += 5001;
      stream.pump(budgetMs);
    },
  };
}
const contentHash = (value: Uint8Array | string) =>
  createHash('sha256').update(value).digest('hex');
async function livePublication(
  base: WorldManifest,
  previous: Map<string, Uint8Array>,
  update: (cell: WorldCell) => void,
) {
  const next = structuredClone(base);
  const payloads = new Map(previous);
  for (const entry of next.cells) {
    const bytes = previous.get(entry.file) ?? (await readFile(join(directory, entry.file)));
    const cell: WorldCell = JSON.parse(new TextDecoder().decode(bytes));
    const before = JSON.stringify(cell);
    update(cell);
    const json = JSON.stringify(cell);
    const changed = json === before ? bytes : new TextEncoder().encode(json);
    payloads.set(entry.file, changed);
    next.files[entry.file] = contentHash(changed);
  }
  next.simulationConfigHash = contentHash(next.simulationConfigHash + 'live');
  next.mapVersion = contentHash(JSON.stringify(next.files));
  return { manifest: next, payloads };
}
function liveResources(
  publication: Awaited<ReturnType<typeof livePublication>>,
  cache: VerifiedByteCache,
  reads: string[],
) {
  return new VerifiedResources(publication.manifest, '/live/', {
    cache,
    fetch: async (url) => {
      const path = String(url).slice('/live/'.length);
      reads.push(path);
      return new Response(
        Uint8Array.from(publication.payloads.get(path) ?? (await readFile(join(directory, path))))
          .buffer,
      );
    },
  });
}

async function generatedSupportPublication(
  base: WorldManifest,
  previous: Map<string, Uint8Array>,
  phase: 0 | 1 | 2,
) {
  const ownerId = 'live-support-owner',
    role = 'foundation';
  const assetId = `support-${contentHash(canonicalJson({ worldId: manifest.worldId, ownerId, role }))}`;
  const source = Object.values(manifest.assets).find((asset) => asset.modelFile)!;
  const affected = new Set(cellsIntersectingBounds(manifest.bounds, manifest.grid, source.bounds));
  const instance: BuildingInstance = {
    entityId: assetId,
    assetId,
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
  };
  const publication = await livePublication(base, previous, (cell) => {
    if (!affected.has(cell.cellId)) return;
    if (!phase) cell.buildings = cell.buildings.filter((item) => item.entityId !== assetId);
    else if (!cell.buildings.some((item) => item.entityId === assetId))
      cell.buildings.push(instance);
  });
  if (phase) {
    const prefix = `derived/support-${phase}`;
    const parts = JSON.parse(await readFile(join(directory, source.partsFile), 'utf8'));
    const collision = JSON.parse(await readFile(join(directory, source.collisionFile), 'utf8'));
    parts.assetId = collision.assetId = assetId;
    if (phase === 2 && collision.colliders.length) collision.colliders[0].friction += 0.01;
    const descriptor = {
      ...source,
      assetId,
      version: contentHash(`${assetId}:${phase}`),
      modelFile: `${prefix}/model.glb`,
      partsFile: `${prefix}/parts.json`,
      collisionFile: `${prefix}/collision.json`,
    };
    const payloads: [string, Uint8Array][] = [
      [descriptor.modelFile, await readFile(join(directory, source.modelFile!))],
      [descriptor.partsFile, new TextEncoder().encode(JSON.stringify(parts))],
      [descriptor.collisionFile, new TextEncoder().encode(JSON.stringify(collision))],
    ];
    publication.manifest.assets[assetId] = descriptor;
    publication.manifest.generatedSupports = {
      ...(publication.manifest.generatedSupports ?? {}),
      [assetId]: { ownerId, role },
    };
    for (const [path, bytes] of payloads) {
      publication.payloads.set(path, bytes);
      publication.manifest.files[path] = contentHash(bytes);
    }
  } else {
    delete publication.manifest.assets[assetId];
    if (publication.manifest.generatedSupports)
      delete publication.manifest.generatedSupports[assetId];
  }
  for (const cell of publication.manifest.cells) {
    const value: WorldCell = JSON.parse(
      new TextDecoder().decode(publication.payloads.get(cell.file)!),
    );
    cell.assetIds = [...new Set(value.buildings.map((item) => item.assetId))].sort();
  }
  publication.manifest.mapVersion = contentHash(
    canonicalJson(worldManifestIdentity(publication.manifest)),
  );
  return { ...publication, assetId, affected };
}

describe('live publication ownership', () => {
  it('adds and removes one seam instance while transferring every unchanged body, mesh and model pin', async () => {
    const v = fixture();
    const position = { x: 0, y: 0, z: 0 };
    const affected = new Set(
      cellsIntersectingBounds(manifest.bounds, manifest.grid, {
        min: { x: -1, y: 0, z: -1 },
        max: { x: 1, y: 1, z: 1 },
      }),
    );
    expect(affected.size).toBeGreaterThan(1);
    const item: StaticEntityDefinition = {
      entityId: 'live-seam-bench',
      kind: 'obstacle',
      position: { x: 0, y: 0.5, z: 0 },
      size: { x: 2, y: 1, z: 2 },
      mass: 0,
      friction: 0.5,
      restitution: 0,
      color: '#123456',
    };
    try {
      v.stream.setArea(position);
      await until(v.stream, () => v.stream.backgroundReady);
      const oldPhysics = new Map(v.physics),
        oldGraphics = new Map(v.graphical),
        pins = v.pins();
      v.physicsEvents.length = 0;
      v.graphicsEvents.length = 0;
      const added = await livePublication(manifest, new Map(), (cell) => {
        if (affected.has(cell.cellId)) cell.statics.push(item);
      });
      const reads: string[] = [];
      const applied = v.stream.transition(added.manifest, liveResources(added, v.cache, reads));
      expect(v.stream.criticalReady).toBe(false);
      expect(v.physics.has(item.entityId)).toBe(false);
      await until(v.stream, () => !v.stream.transitioning && v.stream.backgroundReady);
      await applied;
      expect(v.physics.get(item.entityId)).toBe(affected.size);
      expect(v.graphical.get(item.entityId)).toBe(affected.size);
      expect(v.physicsEvents).toEqual(Array(affected.size).fill(`retain:${item.entityId}`));
      expect(v.graphicsEvents).toEqual(Array(affected.size).fill(`retain:${item.entityId}`));
      expect(v.pins()).toBe(pins);
      for (const [id, count] of oldPhysics) expect(v.physics.get(id)).toBe(count);
      for (const [id, count] of oldGraphics) expect(v.graphical.get(id)).toBe(count);
      expect(
        reads.every((path) =>
          affected.has(added.manifest.cells.find((cell) => cell.file === path)?.cellId ?? ''),
        ),
      ).toBe(true);
      v.physicsEvents.length = 0;
      v.graphicsEvents.length = 0;
      const removed = await livePublication(added.manifest, added.payloads, (cell) => {
        cell.statics = cell.statics.filter((entry) => entry.entityId !== item.entityId);
      });
      const removedApplied = v.stream.transition(
        removed.manifest,
        liveResources(removed, v.cache, []),
      );
      await until(v.stream, () => !v.stream.transitioning && v.stream.backgroundReady);
      await removedApplied;
      expect(v.physics).toEqual(oldPhysics);
      expect(v.graphical).toEqual(oldGraphics);
      expect(v.physicsEvents).toEqual(Array(affected.size).fill(`release:${item.entityId}`));
      expect(v.graphicsEvents).toEqual(Array(affected.size).fill(`release:${item.entityId}`));
      expect(v.pins()).toBe(pins);
    } finally {
      v.stream.dispose();
    }
    expect(v.physics.size).toBe(0);
    expect(v.graphical.size).toBe(0);
    expect(v.pins()).toBe(0);
  });

  it('isolates late old model results while the next context prepares the same cell', async () => {
    const v = fixture();
    let finish!: () => void,
      stalled = false;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const prepare = v.graphics.prepareCellAssets;
    v.graphics.prepareCellAssets = async (...args) => {
      if (!stalled) {
        stalled = true;
        await gate;
      }
      return prepare(...args);
    };
    try {
      v.stream.setArea({ x: 0, y: 0, z: 0 });
      while (!stalled) await tick();
      const publication = {
        manifest: structuredClone(manifest),
        payloads: new Map<string, Uint8Array>(),
      };
      publication.manifest.mapVersion = contentHash('same-layout-new-publication');
      const applied = v.stream.transition(
        publication.manifest,
        liveResources(publication, v.cache, []),
      );
      await until(v.stream, () => !v.stream.transitioning && v.stream.backgroundReady);
      await applied;
      const graphical = new Map(v.graphical),
        physics = new Map(v.physics),
        pins = v.pins();
      finish();
      await tick();
      await tick();
      v.stream.pump(1000);
      expect(v.graphical).toEqual(graphical);
      expect(v.physics).toEqual(physics);
      expect(v.pins()).toBe(pins);
    } finally {
      finish();
      v.stream.dispose();
    }
    expect(v.pins()).toBe(0);
  });

  it('rejects corrupt replacement bytes without changing the current ownership and permits retry', async () => {
    const v = fixture();
    try {
      v.stream.setArea({ x: 0, y: 0, z: 0 });
      await until(v.stream, () => v.stream.backgroundReady);
      const critical = new Set(v.stream.diagnostics().required);
      const publication = await livePublication(manifest, new Map(), (cell) => {
        if (critical.has(cell.cellId)) cell.statics = [...cell.statics].reverse();
      });
      // Empty/repeated cell lists can be byte-identical; explicitly change one critical
      // JSON hash while leaving every ownership record untouched.
      const entry = publication.manifest.cells.find((cell) => critical.has(cell.cellId))!;
      const oldBytes = publication.payloads.get(entry.file)!;
      const padded = new TextEncoder().encode(new TextDecoder().decode(oldBytes) + '\n');
      publication.payloads.set(entry.file, padded);
      publication.manifest.files[entry.file] = contentHash(padded);
      const physics = new Map(v.physics),
        graphics = new Map(v.graphical),
        pins = v.pins();
      const corrupt = new VerifiedResources(publication.manifest, '/corrupt/', {
        cache: v.cache,
        fetch: async () => new Response(new Uint8Array([0])),
      });
      await expect(v.stream.transition(publication.manifest, corrupt)).rejects.toThrow('SHA-256');
      expect(v.stream.manifest).toBe(manifest);
      expect(v.stream.criticalReady).toBe(true);
      expect(v.physics).toEqual(physics);
      expect(v.graphical).toEqual(graphics);
      expect(v.pins()).toBe(pins);
      const applied = v.stream.transition(
        publication.manifest,
        liveResources(publication, v.cache, []),
      );
      await until(v.stream, () => !v.stream.transitioning);
      await applied;
      expect(v.physics).toEqual(physics);
      expect(v.graphical).toEqual(graphics);
      expect(v.pins()).toBe(pins);
    } finally {
      v.stream.dispose();
    }
  });

  it('cancels a transition without waiting for a late model loader and releases its eventual pin', async () => {
    const v = fixture();
    let finish!: () => void,
      stalled = false;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    try {
      v.stream.setArea({ x: 0, y: 0, z: 0 });
      await until(v.stream, () => v.stream.backgroundReady);
      const critical = new Set(v.stream.diagnostics().required);
      const publication = await livePublication(manifest, new Map(), (cell) => {
        if (critical.has(cell.cellId)) cell.statics = [...cell.statics].reverse();
      });
      const entry = publication.manifest.cells.find((cell) => critical.has(cell.cellId))!;
      const padded = new TextEncoder().encode(
        new TextDecoder().decode(publication.payloads.get(entry.file)!) + '\n',
      );
      publication.payloads.set(entry.file, padded);
      publication.manifest.files[entry.file] = contentHash(padded);
      const prepare = v.graphics.prepareCellAssets;
      v.graphics.prepareCellAssets = async (...args) => {
        stalled = true;
        await gate;
        return prepare(...args);
      };
      const completion = v.stream
        .transition(publication.manifest, liveResources(publication, v.cache, []))
        .catch((error: Error) => error.name);
      while (!stalled) await tick();
      v.stream.dispose();
      expect(await completion).toBe('AbortError');
      expect(v.pins()).toBe(0);
      finish();
      await tick();
      await tick();
      expect(v.pins()).toBe(0);
      expect(v.physics.size).toBe(0);
      expect(v.graphical.size).toBe(0);
    } finally {
      finish();
      v.stream.dispose();
    }
  });

  it.each(['modelFile', 'collisionFile', 'partsFile'] as const)(
    'rejects a changed static dependency hash even when its descriptor is unchanged (%s)',
    async (field) => {
      const v = fixture();
      const next = structuredClone(manifest);
      const descriptor = Object.values(next.assets).find((asset) => asset[field])!;
      next.files[descriptor[field]!] = 'a'.repeat(64);
      const resources = new VerifiedResources(next, '/', {
        cache: v.cache,
        fetch: async () => {
          throw new Error('must not fetch');
        },
      });
      try {
        await expect(v.stream.transition(next, resources)).rejects.toThrow('Incompatible');
        expect(v.stream.manifest).toBe(manifest);
        expect(v.stream.failed).toBe(false);
      } finally {
        resources.dispose();
        v.stream.dispose();
      }
    },
  );

  it('cancels staged preparation while preserving the old preview and ignores its late model result', async () => {
    const v = fixture();
    let finish!: () => void,
      stalled = false;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    try {
      v.stream.setArea({ x: 0, y: 0, z: 0 });
      await until(v.stream, () => v.stream.backgroundReady);
      const entry = manifest.cells.find((cell) =>
        v.stream.diagnostics().required.includes(cell.cellId),
      )!;
      const payloads = new Map<string, Uint8Array>();
      const padded = new TextEncoder().encode(
        (await readFile(join(directory, entry.file), 'utf8')) + '\n',
      );
      payloads.set(entry.file, padded);
      const next = structuredClone(manifest);
      next.files[entry.file] = contentHash(padded);
      const original = v.graphics.prepareCellAssets;
      v.graphics.prepareCellAssets = async (...args) => {
        stalled = true;
        await gate;
        return original(...args);
      };
      const physics = new Map(v.physics),
        graphics = new Map(v.graphical),
        pins = v.pins();
      const completion = v.stream
        .transition(next, liveResources({ manifest: next, payloads }, v.cache, []))
        .catch((error: Error) => error.name);
      while (!stalled) await tick();
      v.stream.cancelTransition();
      expect(await completion).toBe('AbortError');
      expect(v.stream.manifest).toBe(manifest);
      expect(v.stream.transitioning).toBe(false);
      expect(v.physics).toEqual(physics);
      expect(v.graphical).toEqual(graphics);
      expect(v.pins()).toBe(pins);
      finish();
      await tick();
      await tick();
      v.stream.pump(1000);
      expect(v.stream.manifest).toBe(manifest);
      expect(v.physics).toEqual(physics);
      expect(v.graphical).toEqual(graphics);
      expect(v.pins()).toBe(pins);
    } finally {
      finish();
      v.stream.dispose();
    }
    expect(v.pins()).toBe(0);
  });

  it('rejects a partially applied scene swap once and releases successful mutations without repeating the delta', async () => {
    const v = fixture();
    const item: StaticEntityDefinition = {
      entityId: 'live-failed-swap',
      kind: 'obstacle',
      position: { x: 0, y: 0.5, z: 0 },
      size: { x: 2, y: 1, z: 2 },
      mass: 0,
      friction: 0.5,
      restitution: 0,
      color: '#123456',
    };
    const affected = new Set(
      cellsIntersectingBounds(manifest.bounds, manifest.grid, {
        min: { x: -1, y: 0, z: -1 },
        max: { x: 1, y: 1, z: 1 },
      }),
    );
    try {
      v.stream.setArea({ x: 0, y: 0, z: 0 });
      await until(v.stream, () => v.stream.backgroundReady);
      const publication = await livePublication(manifest, new Map(), (cell) => {
        if (affected.has(cell.cellId)) cell.statics.push(item);
      });
      const retain = v.graphics.retainStatic;
      v.graphics.retainStatic = (value, version) => {
        if (value.entityId === item.entityId) throw new Error('injected scene mutation failure');
        retain(value, version);
      };
      const rejected = expect(
        v.stream.transition(publication.manifest, liveResources(publication, v.cache, [])),
      ).rejects.toThrow('injected scene mutation failure');
      await until(v.stream, () => v.stream.failed);
      await rejected;
      expect(v.stream.transitioning).toBe(false);
      expect(v.stream.diagnostics().cleanupErrors).toBe(0);
      expect(v.physicsEvents.filter((event) => event === `retain:${item.entityId}`)).toHaveLength(
        affected.size,
      );
      expect(v.physicsEvents.filter((event) => event === `release:${item.entityId}`)).toHaveLength(
        affected.size,
      );
      expect(v.physics.size).toBe(0);
      expect(v.graphical.size).toBe(0);
      expect(v.pins()).toBe(0);
      const operations = [v.physicsEvents.length, v.graphicsEvents.length];
      v.stream.pump(1000);
      v.stream.pump(1000);
      v.stream.dispose();
      expect([v.physicsEvents.length, v.graphicsEvents.length]).toEqual(operations);
    } finally {
      v.stream.dispose();
    }
  });

  it('prepares a newly entered unchanged critical area while distant replacement graphics are stalled', async () => {
    const v = fixture();
    let finish!: () => void,
      stalled = false;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    try {
      v.stream.setArea({ x: 0, y: 0, z: 0 });
      await until(v.stream, () => v.stream.backgroundReady);
      const initial = v.stream.diagnostics();
      const entry = manifest.cells.find(
        (cell) =>
          initial.graphicsRequired.includes(cell.cellId) &&
          !initial.required.includes(cell.cellId) &&
          cell.bounds.max.x <= 0 &&
          cell.bounds.max.z <= 0,
      )!;
      expect(entry).toBeDefined();
      const padded = new TextEncoder().encode(
        (await readFile(join(directory, entry.file), 'utf8')) + '\n',
      );
      const next = structuredClone(manifest);
      next.files[entry.file] = contentHash(padded);
      const original = v.graphics.prepareCellAssets;
      v.graphics.prepareCellAssets = async (...args) => {
        if (args[0] === next) {
          stalled = true;
          await gate;
        }
        return original(...args);
      };
      const applied = v.stream.transition(
        next,
        liveResources({ manifest: next, payloads: new Map([[entry.file, padded]]) }, v.cache, []),
      );
      while (!stalled) await tick();
      v.stream.setArea({ x: 900, y: 0, z: 900 });
      expect(v.stream.criticalReady).toBe(false);
      await until(v.stream);
      expect(v.stream.transitioning).toBe(true);
      const ready = v.stream.diagnostics();
      expect(ready.required.some((id) => !initial.physicsActive.includes(id))).toBe(true);
      const physicsIds = new Set(v.physics.keys()),
        graphicsIds = new Set(v.graphical.keys());
      v.physicsEvents.length = 0;
      v.graphicsEvents.length = 0;
      finish();
      await until(v.stream, () => !v.stream.transitioning);
      await applied;
      expect(v.stream.criticalReady).toBe(true);
      expect(
        v.physicsEvents.filter(
          (event) => event.startsWith('release:') && physicsIds.has(event.slice('release:'.length)),
        ),
      ).toHaveLength(0);
      expect(
        v.graphicsEvents.filter(
          (event) =>
            event.startsWith('release:') && graphicsIds.has(event.slice('release:'.length)),
        ),
      ).toHaveLength(0);
    } finally {
      finish();
      v.stream.dispose();
    }
    expect(v.physics.size).toBe(0);
    expect(v.graphical.size).toBe(0);
    expect(v.pins()).toBe(0);
  });

  it('keeps a shared model request alive when an ordinary consumer joins a cancelled stage', async () => {
    const v = fixture();
    let finish!: () => void,
      staged = false;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let oldPin: (() => void) | undefined;
    try {
      v.stream.setArea({ x: 0, y: 0, z: 0 });
      await until(v.stream, () => v.stream.backgroundReady);
      const cellId = v.stream.diagnostics().required[0];
      const entry = manifest.cells.find((cell) => cell.cellId === cellId)!;
      const model = Object.values(manifest.assets).find((asset) => asset.modelFile)!;
      v.resources.invalidate(model.modelFile!);
      const previousRead = v.resources.read.bind(v.resources);
      let oldContextModelReads = 0;
      v.resources.read = async (path, signal, priority) => {
        if (path === model.modelFile) {
          oldContextModelReads++;
          await gate;
        }
        return previousRead(path, signal, priority);
      };
      const padded = new TextEncoder().encode(
        (await readFile(join(directory, entry.file), 'utf8')) + '\n',
      );
      const next = structuredClone(manifest);
      next.files[entry.file] = contentHash(padded);
      const resources = new VerifiedResources(next, '/next/', {
        cache: v.cache,
        fetch: async (url) => {
          const path = String(url).slice('/next/'.length);
          if (path === model.modelFile) await gate;
          return new Response(
            Uint8Array.from(path === entry.file ? padded : await readFile(join(directory, path)))
              .buffer,
          );
        },
      });
      const original = v.graphics.prepareCellAssets;
      let shared:
        { users: number; controller: AbortController; pending: Promise<Uint8Array> } | undefined;
      v.graphics.prepareCellAssets = async (context, ids, read, signal) => {
        if (context === next) staged = true;
        if (!shared) {
          const controller = new AbortController();
          shared = {
            users: 0,
            controller,
            pending: read(model.modelFile!, controller.signal),
          };
        }
        const reservation = shared;
        reservation.users++;
        let released = false,
          releaseBase: (() => void) | undefined;
        const release = () => {
          if (released) return;
          released = true;
          signal?.removeEventListener('abort', release);
          if (!--reservation.users) reservation.controller.abort();
          releaseBase?.();
        };
        signal?.addEventListener('abort', release, { once: true });
        try {
          await reservation.pending;
          if (released || signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
          releaseBase = await original(context, ids, read, signal);
          signal?.removeEventListener('abort', release);
          return release;
        } catch (error) {
          release();
          throw error;
        }
      };
      const completion = v.stream.transition(next, resources).catch((error: Error) => error.name);
      while (!staged) await tick();
      const retained = v.graphics.prepareCellAssets(manifest, [model.assetId], (path, signal) =>
        v.resources.read(path, signal),
      );
      // This consumer owns the same pending model; cancelling only the stage must
      // neither abort its request nor reject this remaining consumer.
      const retainedResult = retained.then(
        (pin) => {
          oldPin = pin;
          return true;
        },
        () => false,
      );
      v.stream.cancelTransition();
      expect(await completion).toBe('AbortError');
      finish();
      expect(await retainedResult).toBe(true);
      expect(oldContextModelReads).toBe(1);
      oldPin!();
      oldPin = undefined;
    } finally {
      finish();
      oldPin?.();
      v.stream.dispose();
    }
    expect(v.pins()).toBe(0);
  });

  it('replaces a stable generated support descriptor without rebuilding unchanged instances or requiring changed cell JSON', async () => {
    const v = fixture();
    const originalPrepare = v.graphics.prepareCellAssets;
    v.graphics.prepareCellAssets = async (context, ids, read, signal) => {
      for (const id of ids)
        if (context.generatedSupports?.[id]) {
          const descriptor = context.assets[id];
          await read(descriptor.partsFile, signal);
          if (descriptor.modelFile) await read(descriptor.modelFile, signal);
        }
      return originalPrepare(context, ids, read, signal);
    };
    try {
      v.stream.setArea({ x: 0, y: 0, z: 0 });
      await until(v.stream, () => v.stream.backgroundReady);
      const initialPhysics = new Map(v.physics),
        initialGraphics = new Map(v.graphical),
        pins = v.pins();
      const added = await generatedSupportPublication(manifest, new Map(), 1);
      let applied = v.stream.transition(added.manifest, liveResources(added, v.cache, []));
      await until(v.stream, () => !v.stream.transitioning && v.stream.backgroundReady);
      await applied;
      expect(v.physics.get(added.assetId)).toBe(added.affected.size);
      v.physicsEvents.length = 0;
      v.graphicsEvents.length = 0;
      const updated = await generatedSupportPublication(added.manifest, added.payloads, 2);
      for (const cell of updated.manifest.cells)
        expect(updated.manifest.files[cell.file]).toBe(added.manifest.files[cell.file]);
      expect(changedWorldPublicationCells(added.manifest, updated.manifest)).toEqual(
        [...added.affected].sort(),
      );
      applied = v.stream.transition(updated.manifest, liveResources(updated, v.cache, []));
      expect(v.stream.criticalReady).toBe(false);
      await until(v.stream, () => !v.stream.transitioning && v.stream.backgroundReady);
      await applied;
      for (const events of [v.physicsEvents, v.graphicsEvents]) {
        expect(events.filter((event) => event.startsWith('release:'))).toEqual(
          Array(added.affected.size).fill(`release:${added.assetId}`),
        );
        expect(events.filter((event) => event.startsWith('retain:'))).toEqual(
          Array(added.affected.size).fill(`retain:${added.assetId}`),
        );
      }
      expect(v.physics.get(added.assetId)).toBe(added.affected.size);
      expect(v.graphical.get(added.assetId)).toBe(added.affected.size);
      expect(v.pins()).toBe(pins);
      const removed = await generatedSupportPublication(updated.manifest, updated.payloads, 0);
      applied = v.stream.transition(removed.manifest, liveResources(removed, v.cache, []));
      await until(v.stream, () => !v.stream.transitioning && v.stream.backgroundReady);
      await applied;
      expect(v.physics).toEqual(initialPhysics);
      expect(v.graphical).toEqual(initialGraphics);
      expect(v.pins()).toBe(pins);
    } finally {
      v.stream.dispose();
    }
    expect(v.physics.size).toBe(0);
    expect(v.graphical.size).toBe(0);
    expect(v.pins()).toBe(0);
  });

  it('rejects an unregistered support dependency instead of silently relaxing the immutable base', async () => {
    const v = fixture();
    const publication = await generatedSupportPublication(manifest, new Map(), 1);
    delete publication.manifest.generatedSupports;
    const resources = liveResources(publication, v.cache, []);
    try {
      await expect(v.stream.transition(publication.manifest, resources)).rejects.toThrow(
        'Incompatible',
      );
      expect(v.stream.manifest).toBe(manifest);
      expect(v.physics.size).toBe(0);
      expect(v.graphical.size).toBe(0);
    } finally {
      resources.dispose();
      v.stream.dispose();
    }
  });

  it('updates an unloaded far cell without allocating it or stopping a ready local character', async () => {
    const v = fixture();
    try {
      v.stream.setArea({ x: 0, y: 0, z: 0 });
      await until(v.stream, () => v.stream.backgroundReady);
      const far = manifest.cells[0];
      expect(v.stream.diagnostics().physicsRequired).not.toContain(far.cellId);
      const publication = await livePublication(manifest, new Map(), (cell) => {
        if (cell.cellId === far.cellId && cell.statics.length) cell.statics[0].color = '#abcdef';
      });
      const reads: string[] = [];
      v.physicsEvents.length = 0;
      v.graphicsEvents.length = 0;
      const applied = v.stream.transition(
        publication.manifest,
        liveResources(publication, v.cache, reads),
      );
      expect(v.stream.criticalReady).toBe(true);
      await until(v.stream, () => !v.stream.transitioning);
      await applied;
      expect(reads).toHaveLength(0);
      expect(v.physicsEvents).toHaveLength(0);
      expect(v.graphicsEvents).toHaveLength(0);
      expect(v.stream.manifest).toBe(publication.manifest);
    } finally {
      v.stream.dispose();
    }
  });
});

describe('segmented world ownership', () => {
  it('limits a close preview to the camera area while gameplay keeps the full physics circle', async () => {
    const v = fixture();
    const center = { x: 0, y: 0, z: 0 };
    try {
      v.stream.setPreview(center, 125);
      await until(v.stream, () => v.stream.backgroundReady);
      const preview = v.stream.diagnostics();
      expect(preview.graphicsRequired).toEqual(circularCells(manifest, center, 250));
      expect(preview.physicsRequired).toHaveLength(0);
      expect(preview.graphicsRequired.length).toBeLessThan(
        circularCells(manifest, center, 625).length,
      );
      v.stream.setArea(center);
      await until(v.stream, () => v.stream.backgroundReady);
      const playing = v.stream.diagnostics();
      expect(playing.physicsRequired.sort()).toEqual(circularCells(manifest, center, 500).sort());
      expect(playing.graphicsRequired.length).toBeLessThan(playing.physicsRequired.length);
      expect(playing.criticalReady).toBe(true);
      // Far preview models are released after zooming back in; collider ownership survives.
      v.stream.setVisualArea(center, 3000);
      await until(v.stream, () => v.stream.backgroundReady);
      v.stream.setVisualArea(center, 125);
      v.advance();
      await until(v.stream, () => v.stream.backgroundReady);
      expect(v.stream.diagnostics().graphicsRequired.length).toBeLessThan(256);
      expect(v.stream.diagnostics().physicsRequired.sort()).toEqual(playing.physicsRequired);
    } finally {
      v.stream.dispose();
    }
  });
  it('makes more preparation progress on slow preview frames with a bounded pump budget', async () => {
    const usual = fixture(0.1);
    const preparing = fixture(0.1);
    try {
      for (const v of [usual, preparing]) v.stream.setPreview({ x: 0, y: 0, z: 0 }, 3000);
      const deadline = performance.now() + 10000;
      while (
        (usual.stream.diagnostics().requested.length ||
          preparing.stream.diagnostics().requested.length) &&
        performance.now() < deadline
      )
        await tick();
      expect(preparing.stream.diagnostics().requested).toHaveLength(0);
      usual.stream.pump(2);
      preparing.stream.pumpFrame(1 / 20);
      expect(preparing.graphical.size).toBeGreaterThan(usual.graphical.size);
      // The simulated clock also charges for the identical whole-grid maintenance pass.
      expect(
        preparing.stream.diagnostics().peakPumpMs - usual.stream.diagnostics().peakPumpMs,
      ).toBeLessThan(5);
      expect(preparing.physics.size).toBe(0);
    } finally {
      usual.stream.dispose();
      preparing.stream.dispose();
    }
  });
  it('selects a clipped circle, permits all 256 graphical cells without attaching distant physics', async () => {
    expect(cellNeighborhood(manifest, { x: 1000, y: 0, z: 1000 })).toHaveLength(4);
    const selected = circularCells(manifest, { x: 0, y: 0, z: 0 }, 500);
    expect(selected.length).toBeGreaterThan(64);
    expect(selected).not.toContain('0_0');
    const v = fixture();
    try {
      v.stream.setArea({ x: 0, y: 0, z: 0 });
      v.stream.setVisualArea({ x: 0, y: 0, z: 0 }, 3000);
      await until(v.stream, () => v.stream.backgroundReady);
      expect(v.stream.diagnostics().graphicsRequired).toHaveLength(256);
      expect(v.stream.diagnostics().physicsRequired.length).toBeLessThan(256);
      expect(v.graphical.size).toBeGreaterThan(v.physics.size);
      expect(v.stream.graphicsReadyRadius({ x: 0, y: 0, z: 0 }, 3000)).toBe(3000);
      expect(v.stream.diagnostics().resources.httpPeak).toBeLessThanOrEqual(4);
    } finally {
      v.stream.dispose();
    }
    expect(v.physics.size).toBe(0);
    expect(v.graphical.size).toBe(0);
    expect(v.pins()).toBe(0);
  });
  it('connects distant prepared cells under a real finite frame budget without re-scanning completed neighbors', async () => {
    const v = fixture(0.1);
    try {
      v.stream.setPreview({ x: 0, y: 0, z: 0 }, 3000);
      const deadline = performance.now() + 10000;
      while (!v.stream.backgroundReady && performance.now() < deadline) {
        v.stream.pump(2);
        await tick();
      }
      expect(v.stream.backgroundReady).toBe(true);
      expect(v.stream.graphicsReadyRadius({ x: 0, y: 0, z: 0 }, 3000)).toBe(3000);
    } finally {
      v.stream.dispose();
    }
  });
  it('preempts a graphical-only preview when joining needs physics in the same loading cell', async () => {
    const v = fixture();
    const prepare = v.graphics.prepareCellAssets;
    let stalled = false;
    v.graphics.prepareCellAssets = async (m, ids, read, signal) => {
      if (!stalled) {
        stalled = true;
        await new Promise<void>((_resolve, reject) => {
          signal!.addEventListener(
            'abort',
            () => reject(new DOMException('Preempted', 'AbortError')),
            { once: true },
          );
        });
      }
      return prepare(m, ids, read, signal);
    };
    try {
      v.stream.setPreview({ x: 0, y: 0, z: 0 });
      const deadline = performance.now() + 5000;
      while (!stalled && performance.now() < deadline) {
        v.stream.pump(2);
        await tick();
      }
      expect(stalled).toBe(true);
      expect(v.physics.size).toBe(0);
      v.stream.setArea({ x: 0, y: 0, z: 0 });
      await until(v.stream);
      expect(v.physics.size).toBeGreaterThan(0);
      expect(v.stream.problem).toBeUndefined();
    } finally {
      v.stream.dispose();
    }
    expect(v.pins()).toBe(0);
  });
  it('defers distant scene allocations while a critical cell is still preparing', async () => {
    const v = fixture();
    const prepare = v.graphics.prepareCellAssets;
    let first = true,
      release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    v.graphics.prepareCellAssets = async (m, ids, read, signal) => {
      if (first) {
        first = false;
        await gate;
      }
      return prepare(m, ids, read, signal);
    };
    try {
      v.stream.setArea({ x: 0, y: 0, z: 0 });
      v.stream.setVisualArea({ x: 0, y: 0, z: 0 }, 3000);
      for (let n = 0; n < 300; n++) {
        v.stream.pump(2);
        await tick();
      }
      expect(v.stream.criticalReady).toBe(false);
      const d = v.stream.diagnostics();
      expect(
        d.cells
          .filter((cell) => !d.required.includes(cell.id))
          .every((cell) => cell.references === 0),
      ).toBe(true);
      release();
      await until(v.stream, () => v.stream.backgroundReady);
    } finally {
      release();
      v.stream.dispose();
    }
  });
  it('critical preparation succeeds despite a stalled distant model and ready circle hides its holes', async () => {
    const v = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prepare = v.graphics.prepareCellAssets;
    v.graphics.prepareCellAssets = async (m, ids, read, signal) => {
      if (ids.includes('house-remote-a')) await gate;
      return prepare(m, ids, read, signal);
    };
    try {
      v.stream.setArea({ x: 0, y: 0, z: 0 });
      v.stream.setVisualArea({ x: 0, y: 0, z: 0 }, 3000);
      await until(v.stream);
      expect(v.stream.criticalReady).toBe(true);
      expect(v.stream.backgroundReady).toBe(false);
      expect(v.stream.graphicsReadyRadius({ x: 0, y: 0, z: 0 }, 3000)).toBeLessThan(3000);
      release();
      await until(v.stream, () => v.stream.backgroundReady);
    } finally {
      release();
      v.stream.dispose();
    }
  });
  it.each([false, true])(
    'holds shared seam instances and prediction history with physics packs=%s',
    async (packed) => {
      const v = fixture(0, packed);
      const start = { x: -125, y: 0, z: -312.5 },
        far = { x: 950, y: 0, z: 950 };
      try {
        v.stream.setArea(start);
        await until(v.stream, () => v.stream.backgroundReady);
        expect(v.reads.some((path) => path.startsWith('physics/'))).toBe(packed);
        if (packed) expect(v.reads.some((path) => path.endsWith('/colliders.json'))).toBe(false);
        expect(v.physics.get('house-6-5-0')).toBe(2);
        v.stream.setArea(far, far, ['6_5']);
        await until(v.stream, () => v.stream.backgroundReady);
        v.advance();
        expect(v.physics.get('house-6-5-0')).toBe(1);
        v.stream.setArea(far);
        v.advance();
        expect(v.physics.has('house-6-5-0')).toBe(false);
        expect(v.graphical.has('house-6-5-0')).toBe(false);
      } finally {
        v.stream.dispose();
      }
    },
  );
  it('keeps static preview without colliders or game readiness and reuses it on join/leave', async () => {
    const v = fixture();
    const p = { x: 0, y: 0, z: 0 };
    try {
      v.stream.setPreview(p);
      await until(v.stream, () => v.stream.backgroundReady);
      expect(v.physics.size).toBe(0);
      expect(v.graphical.size).toBeGreaterThan(0);
      expect(v.stream.criticalReady).toBe(false);
      expect(v.reads.some((path) => path.endsWith('/colliders.json'))).toBe(false);
      expect(v.stream.diagnostics().parsedCollisionBytes).toBe(0);
      const models = v.graphical.size;
      const reads = v.reads.length;
      v.stream.setArea(p);
      await until(v.stream, () => v.stream.backgroundReady);
      expect(v.physics.size).toBeGreaterThan(0);
      expect(v.graphical.size).toBe(models);
      expect(v.reads.slice(reads).length).toBeGreaterThan(0);
      expect(v.reads.slice(reads).every((path) => path.endsWith('/colliders.json'))).toBe(true);
      v.stream.setPreview(p);
      v.advance();
      await until(v.stream, () => v.stream.diagnostics().parsedCollisionBytes === 0);
      expect(v.physics.size).toBe(0);
      expect(v.graphical.size).toBe(models);
    } finally {
      v.stream.dispose();
    }
  });
  it('releases abandoned gameplay physics ahead of a large preview graphics queue', async () => {
    const v = fixture(0.1);
    const far = { x: 950, y: 0, z: 950 };
    try {
      v.stream.setArea(far);
      await until(v.stream, () => v.stream.backgroundReady);
      expect(v.physics.size).toBeGreaterThan(0);
      v.stream.setPreview({ x: -950, y: 0, z: -950 }, 3000);
      // Prepare the whole graphics queue without pumping connections. In production this is
      // a late GLB completing after leave while the preview keeps the same cell alive.
      const deadline = performance.now() + 10000;
      while (v.stream.diagnostics().requested.length && performance.now() < deadline) await tick();
      expect(v.stream.diagnostics().requested).toHaveLength(0);
      expect(v.stream.backgroundReady).toBe(false);
      v.advance(2);
      for (let frame = 0; frame < 50 && v.physics.size; frame++) v.stream.pump(2);
      expect(v.physics.size).toBe(0);
      expect(v.stream.diagnostics().physicsActive).toHaveLength(0);
      expect(v.stream.backgroundReady).toBe(false);
      expect(v.stream.diagnostics().graphicsRequired).toHaveLength(256);
      await until(v.stream, () => v.stream.backgroundReady);
      expect(v.graphical.size).toBeGreaterThan(0);
      expect(v.physics.size).toBe(0);
    } finally {
      v.stream.dispose();
    }
  });
  it('aborts late preparations without activating old models and exposes retryable critical errors', async () => {
    const v = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prepare = v.graphics.prepareCellAssets;
    v.graphics.prepareCellAssets = async (...args) => {
      await gate;
      return prepare(...args);
    };
    v.stream.setArea({ x: -950, y: 0, z: -950 });
    await tick();
    v.stream.dispose();
    release();
    await tick();
    expect(v.physics.size).toBe(0);
    expect(v.graphical.size).toBe(0);
    const failed = fixture();
    failed.graphics.retainStatic = () => {
      throw new Error('GPU allocation failed');
    };
    try {
      failed.stream.setArea({ x: -950, y: 0, z: -950 });
      await until(failed.stream, () => !!failed.stream.problem);
      expect(failed.stream.criticalReady).toBe(false);
      failed.graphics.retainStatic = () => {};
      failed.graphics.releaseStatic = () => {};
      failed.stream.retry();
      await until(failed.stream);
    } finally {
      failed.stream.dispose();
    }
    expect(failed.physics.size).toBe(0);
  });
  it('prepares a replacement area after a corrupt saved cell without reusing unverified bytes', async () => {
    const saved = { x: -950, y: 0.92, z: -950 };
    const start = { x: 950, y: 0.92, z: 950 };
    const savedCells = new Set(cellNeighborhood(manifest, saved));
    const unavailable = new Set(
      manifest.cells.filter((cell) => savedCells.has(cell.cellId)).map((cell) => cell.file),
    );
    const requests: { path: string; cache?: RequestCache }[] = [];
    const resources = new VerifiedResources(manifest, '/', {
      fetch: async (url, options) => {
        const path = String(url).slice(1);
        requests.push({ path, cache: options?.cache });
        return new Response(
          unavailable.has(path) ? new Uint8Array([0]) : await readFile(join(directory, path)),
        );
      },
    });
    const stream = new CellStreamer(
      manifest,
      resources,
      { retainStatic: () => {}, releaseStatic: () => {} },
      { prepareCellAssets: async () => () => {}, retainStatic: () => {}, releaseStatic: () => {} },
    );
    try {
      stream.setPreparationArea(saved);
      await until(stream, () => !!stream.problem);
      expect(stream.problem).toMatch(/SHA-256/);
      expect(stream.criticalReady).toBe(false);
      const corruptPath = requests.find(({ path }) => unavailable.has(path))!.path;
      expect(requests.filter(({ path }) => path === corruptPath).map(({ cache }) => cache)).toEqual(
        ['default', 'reload'],
      );
      stream.setPreparationArea(start);
      await until(stream);
      expect(stream.problem).toBeUndefined();
      expect(stream.diagnostics().required.sort()).toEqual(
        cellNeighborhood(manifest, start).sort(),
      );
      expect(stream.diagnostics().required.every((id) => !savedCells.has(id))).toBe(true);
    } finally {
      stream.dispose();
    }
    expect(resources.diagnostics().pending).toBe(0);
  });
});
