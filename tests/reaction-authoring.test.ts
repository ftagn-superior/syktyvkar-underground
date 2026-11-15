import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { addReaction, reactionTemplate } from '../tools/reactions/add.js';
import {
  ASSETS,
  REGISTRY,
  inspectReactionCatalog,
  readReactionRegistry,
  validateReactionSvg,
} from '../tools/reactions/catalog.js';
import { reactionReleaseVersion } from '../apps/server/src/reactions/version.js';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
let directory: string;
let originalRegistry: string;
const input = { id: 'bravo', label: 'Браво', category: 'Общение' };
beforeEach(async () => {
  directory = await fs.mkdtemp(join(tmpdir(), 'su-reactions-'));
  await fs.mkdir(join(directory, 'packages/contracts/src'), { recursive: true });
  await fs.mkdir(join(directory, 'apps/client/public'), { recursive: true });
  await fs.cp(resolve(ASSETS), join(directory, ASSETS), { recursive: true });
  originalRegistry = await fs.readFile(REGISTRY, 'utf8');
  const ids = new Set(readReactionRegistry(originalRegistry).definitions.map((r) => r.id));
  input.id = 'bravo';
  while (ids.has(input.id)) input.id += '-test';
  await fs.writeFile(join(directory, REGISTRY), originalRegistry);
  await fs.copyFile('.prettierrc.json', join(directory, '.prettierrc.json'));
});
afterEach(async () => {
  vi.clearAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});
async function unchanged() {
  expect(await fs.readFile(join(directory, REGISTRY), 'utf8')).toBe(originalRegistry);
  expect(await fs.readdir(join(directory, ASSETS))).not.toContain(`${input.id}.svg`);
  expect(await fs.readdir(directory)).not.toContain('.reactions-add.lock');
}

describe('reaction authoring pipeline', () => {
  it('adds an agreed entry and template, validates them and preserves every existing asset', async () => {
    const before = await inspectReactionCatalog(directory);
    await addReaction(directory, input);
    const after = await inspectReactionCatalog(directory);
    expect(after.definitions).toEqual([
      ...before.definitions,
      { ...input, asset: `${input.id}.svg` },
    ]);
    for (const [asset, bytes] of before.assets) expect(after.assets.get(asset)).toEqual(bytes);
    expect(after.version).not.toBe(before.version);
    expect(await fs.readdir(directory)).not.toContain('.reactions-add.lock');
  });
  it('accepts a supplied SVG and escapes labels in the generated template', async () => {
    const path = join(directory, 'approved.svg');
    const bytes = reactionTemplate('Браво & <ура>');
    await fs.writeFile(path, bytes);
    await addReaction(directory, { ...input, label: 'Браво & <ура>', assetFile: path });
    expect(await fs.readFile(join(directory, ASSETS, `${input.id}.svg`), 'utf8')).toBe(bytes);
    expect(bytes).toContain('Браво &amp; &lt;ура&gt;');
  });
  it('dry-runs without content changes', async () => {
    await addReaction(directory, { ...input, dryRun: true });
    await unchanged();
  });
  it('refuses duplicate ids before writing anything', async () => {
    await expect(addReaction(directory, { ...input, id: 'hello' })).rejects.toThrow(
      /hello.*повторный id/,
    );
    await unchanged();
  });
  it('refuses an asset collision without overwriting the unregistered file', async () => {
    await fs.writeFile(join(directory, ASSETS, `${input.id}.svg`), 'author work');
    await expect(addReaction(directory, input)).rejects.toThrow(`${input.id}.svg`);
    expect(await fs.readFile(join(directory, ASSETS, `${input.id}.svg`), 'utf8')).toBe(
      'author work',
    );
    expect(await fs.readFile(join(directory, REGISTRY), 'utf8')).toBe(originalRegistry);
  });
  it('refuses bad metadata, malformed input and a concurrent writer without partial files', async () => {
    await expect(addReaction(directory, { ...input, category: 'Все' })).rejects.toThrow('category');
    const bad = join(directory, 'bad.svg');
    await fs.writeFile(bad, '<svg>');
    await expect(addReaction(directory, { ...input, assetFile: bad })).rejects.toThrow(
      new RegExp(`${input.id}.*bad.svg`),
    );
    await fs.writeFile(join(directory, '.reactions-add.lock'), 'another writer');
    await expect(addReaction(directory, input)).rejects.toThrow('.reactions-add.lock');
    expect(await fs.readFile(join(directory, '.reactions-add.lock'), 'utf8')).toBe(
      'another writer',
    );
    await fs.unlink(join(directory, '.reactions-add.lock'));
    await unchanged();
  });
  it('rolls back the new asset if committing the registry fails', async () => {
    vi.mocked(fs.rename).mockRejectedValueOnce(new Error('simulated disk failure'));
    await expect(addReaction(directory, input)).rejects.toThrow('simulated disk failure');
    await unchanged();
  });
  it('reports missing assets and corrupt XML with id and full asset path', async () => {
    const path = join(directory, ASSETS, 'hello.svg');
    await fs.unlink(path);
    await expect(inspectReactionCatalog(directory)).rejects.toThrow(/hello.*hello.svg/);
    await fs.writeFile(
      path,
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path></svg>',
    );
    await expect(inspectReactionCatalog(directory)).rejects.toThrow(/hello.*hello.svg.*SVG\/XML/);
  });
  it('changes release identity for metadata, order and same-name SVG changes', async () => {
    const current = await inspectReactionCatalog(directory);
    const changed = new Map(current.assets);
    changed.set('hello.svg', Buffer.from(reactionTemplate('другой рисунок')));
    expect(reactionReleaseVersion(current.definitions, changed)).not.toBe(current.version);
    expect(reactionReleaseVersion([...current.definitions].reverse(), current.assets)).not.toBe(
      current.version,
    );
    expect(
      reactionReleaseVersion(
        current.definitions.map((r, i) => (i ? r : { ...r, label: 'Другая подпись' })),
        current.assets,
      ),
    ).not.toBe(current.version);
  });
  it('runs the documented CLI end to end and returns a readable nonzero duplicate error', async () => {
    const args = [
      '--import',
      import.meta.resolve('tsx'),
      resolve('tools/reactions/command.ts'),
      'add',
      '--id',
      input.id,
      '--label',
      'Браво',
      '--category',
      'Общение',
    ];
    const run = promisify(execFile);
    expect((await run(process.execPath, args, { cwd: directory })).stdout).toContain(
      `Добавлено: ${input.id}`,
    );
    await expect(run(process.execPath, args, { cwd: directory })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('повторный id'),
    });
    expect((await inspectReactionCatalog(directory)).definitions).toHaveLength(
      readReactionRegistry(originalRegistry).definitions.length + 1,
    );
  });
});

describe('standalone static SVG format', () => {
  it.each([
    '<svg/>',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"/>',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><script/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><image href="https://example.com/a.png"/></svg>',
    '<!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"/>',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path fill="url(https://example.com)"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path onload="bad()"/></svg>',
  ])('refuses unsupported SVG with its id and path', (text) => {
    expect(() => validateReactionSvg(Buffer.from(text), 'bravo', 'bravo.svg')).toThrow(
      /bravo.*bravo.svg/,
    );
  });
  it('refuses invalid UTF-8 and excessive bytes', () => {
    expect(() => validateReactionSvg(new Uint8Array([255]), 'bravo', 'bravo.svg')).toThrow('UTF-8');
    expect(() => validateReactionSvg(new Uint8Array(65537), 'bravo', 'bravo.svg')).toThrow('65536');
  });
});
