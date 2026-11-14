import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { hash, writeWorldPublication, type WorldPublication } from './index.js';

function fixture(): WorldPublication {
  const payloads = new Map(
    Array.from(
      { length: 32 },
      (_, index) => [`assets/${index}/content.bin`, new Uint8Array(4096).fill(index)] as const,
    ),
  );
  return {
    payloads,
    manifest: {
      formatVersion: 5,
      worldId: 'writer-test',
      mapVersion: 'a'.repeat(64),
      simulationConfigHash: 'b'.repeat(64),
      worldFile: 'assets/0/content.bin',
      bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
      grid: { origin: { x: 0, z: 0 }, cellSize: 1, columns: 1, rows: 1 },
      cells: [],
      assets: {},
      files: Object.fromEntries([...payloads].map(([path, bytes]) => [path, hash(bytes)])),
    },
  };
}
it('writes identical complete publication bytes with serial and bounded concurrent writers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'su-writer-'));
  try {
    const publication = fixture();
    const serial = join(directory, 'serial'),
      concurrent = join(directory, 'concurrent');
    await writeWorldPublication(publication, serial);
    await writeWorldPublication(publication, concurrent, 8);
    for (const [path, expected] of publication.payloads) {
      expect(await readFile(join(serial, path))).toEqual(Buffer.from(expected));
      expect(await readFile(join(concurrent, path))).toEqual(Buffer.from(expected));
    }
    expect(await readFile(join(concurrent, 'manifest.json'), 'utf8')).toBe(
      await readFile(join(serial, 'manifest.json'), 'utf8'),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
it('drains every outstanding writer before reporting failure and never exposes a partial manifest', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'su-writer-failed-'));
  try {
    await mkdir(join(directory, 'assets'), { recursive: true });
    await writeFile(join(directory, 'assets', '0'), 'a file blocks the first asset directory');
    await expect(writeWorldPublication(fixture(), directory, 8)).rejects.toThrow();
    await expect(access(join(directory, 'manifest.json'))).rejects.toThrow();
    // Failed staging can be removed immediately; no background writer can recreate it.
    await rm(directory, { recursive: true, force: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(access(directory)).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
