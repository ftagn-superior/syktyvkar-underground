import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  type WorldManifest,
  type BuildingInstance,
  type StaticEntityDefinition,
} from '@su/contracts';
import { buildWorld } from '../../../../tools/world-build/src/index.js';
import { CellStreamer, cellNeighborhood, type CellGraphics } from './cells';
import { VerifiedResources } from './resources';
let directory: string;
let manifest: WorldManifest;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'su-l2-cells-'));
  manifest = await buildWorld(resolve('content/worlds/streaming-lab/world.json'), directory);
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function ready(stream: CellStreamer) {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    stream.pump(1000);
    if (stream.ready) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(JSON.stringify(stream.diagnostics()));
}
function fixture(fetcher?: typeof fetch) {
  let now = 0;
  const reads: string[] = [];
  const resources = new VerifiedResources(manifest, '/', {
    fetch:
      fetcher ??
      (async (url) => {
        const path = String(url).slice(1);
        reads.push(path);
        return new Response(await readFile(join(directory, path)));
      }),
  });
  const connected = new Map<string, number>();
  let pins = 0;
  const add = (item: BuildingInstance | StaticEntityDefinition) =>
    connected.set(item.entityId, (connected.get(item.entityId) ?? 0) + 1);
  const graphics: CellGraphics = {
    prepareCellAssets: async () => {
      pins++;
      return () => {
        pins--;
      };
    },
    retainStatic: () => {},
    releaseStatic: () => {},
  };
  const stream = new CellStreamer(
    manifest,
    resources,
    {
      retainStatic: add,
      releaseStatic: (id) => {
        const count = connected.get(id)! - 1;
        if (count) connected.set(id, count);
        else connected.delete(id);
      },
    },
    graphics,
    () => now,
  );
  return {
    stream,
    reads,
    connected,
    resources,
    graphics,
    pins: () => pins,
    advance: (budgetMs = 1000) => {
      now += 5001;
      stream.pump(budgetMs);
    },
  };
}
describe('local cell lifecycle', () => {
  it('clips neighborhoods, loads no remote dependencies, deduplicates seams, pins history and releases after five seconds', async () => {
    expect(cellNeighborhood(manifest, { x: 1000, y: 0, z: 1000 })).toHaveLength(4);
    const view = fixture();
    const initial = { x: -125, y: 0, z: -312.5 };
    try {
      view.stream.setArea(initial);
      await ready(view.stream);
      expect(view.stream.diagnostics().required).toHaveLength(9);
      expect(view.reads.filter((path) => path.startsWith('cells/')).length).toBe(9);
      const remoteFiles = ['house-remote-a', 'house-remote-b'].map(
        (id) => manifest.assets[id].collisionFile,
      );
      expect(view.reads.some((path) => remoteFiles.includes(path))).toBe(false);
      expect(view.connected.get('house-6-5-0')).toBe(2);
      view.stream.setArea({ x: 500, y: 0, z: 500 }, undefined, ['6_5']);
      await ready(view.stream);
      view.advance();
      expect(view.connected.get('house-6-5-0')).toBe(1);
      view.stream.setArea({ x: 500, y: 0, z: 500 });
      view.advance();
      expect(view.connected.has('house-6-5-0')).toBe(false);
      for (let cycle = 0; cycle < 3; cycle++) {
        view.stream.setArea(initial);
        await ready(view.stream);
        view.advance();
        expect(view.pins()).toBe(9);
        view.stream.setArea({ x: 500, y: 0, z: 500 });
        await ready(view.stream);
        view.advance();
        expect(view.pins()).toBe(9);
      }
    } finally {
      view.stream.dispose();
    }
    expect(view.connected.size).toBe(0);
    expect(view.pins()).toBe(0);
  });
  it('rejects late preparation after changing targets or leaving, and permits explicit retry', async () => {
    const view = fixture();
    const completions: ((release: () => void) => void)[] = [];
    let released = 0;
    view.graphics.prepareCellAssets = async () =>
      new Promise((resolve) => completions.push(resolve));
    view.stream.setArea({ x: -1000, y: 0, z: -1000 });
    const deadline = performance.now() + 5000;
    while (!completions.length && performance.now() < deadline) await tick();
    expect(completions.length).toBeGreaterThan(0);
    view.stream.setArea({ x: 900, y: 0, z: 900 });
    const obsolete = completions.splice(0);
    for (const complete of obsolete)
      complete(() => {
        released++;
      });
    await tick();
    view.stream.pump(1000);
    expect(view.connected.size).toBe(0);
    expect(released).toBe(obsolete.length);
    view.stream.dispose();
    for (const complete of completions.splice(0))
      complete(() => {
        released++;
      });
    await tick();
    let fail = true;
    const failure = fixture(async (url) =>
      fail
        ? new Response('', { status: 503 })
        : new Response(await readFile(join(directory, String(url).slice(1)))),
    );
    failure.stream.setArea({ x: -1000, y: 0, z: -1000 });
    for (let i = 0; i < 20; i++) await tick();
    expect(failure.stream.ready).toBe(false);
    expect(failure.stream.diagnostics().cells.some((cell) => cell.state === 'error')).toBe(true);
    fail = false;
    failure.stream.retry();
    await ready(failure.stream);
    failure.stream.dispose();
    expect(failure.connected.size).toBe(0);
  });
  it('disposes a partially released set without dropping shared references twice', async () => {
    const view = fixture();
    view.stream.setArea({ x: -125, y: 0, z: -312.5 });
    await ready(view.stream);
    view.stream.setArea({ x: 500, y: 0, z: 500 });
    await ready(view.stream);
    view.advance(0);
    expect(view.stream.diagnostics().cells.some((cell) => cell.state === 'releasing')).toBe(true);
    view.stream.dispose();
    expect(view.connected.size).toBe(0);
    expect(view.pins()).toBe(0);
    expect(view.stream.diagnostics().entities).toBe(0);
  });
  it('rolls back physics when graphics rejects an object, and retains a retryable error', async () => {
    const view = fixture();
    view.graphics.retainStatic = () => {
      throw new Error('GPU allocation failed');
    };
    view.stream.setArea({ x: -1000, y: 0, z: -1000 });
    const deadline = performance.now() + 5000;
    while (performance.now() < deadline && !view.stream.diagnostics().error) {
      view.stream.pump(1000);
      await tick();
    }
    expect(view.stream.diagnostics().error).toContain('GPU allocation failed');
    expect(view.connected.size).toBe(0);
    view.graphics.retainStatic = () => {};
    view.stream.retry();
    await ready(view.stream);
    view.stream.dispose();
    expect(view.connected.size).toBe(0);
    expect(view.pins()).toBe(0);
  });
});
