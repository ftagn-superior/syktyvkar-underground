import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REACTIONS } from '@su/contracts';
import { loadReactionRelease, verifyReactionClientBuild } from './release.js';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'su-reaction-release-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
it('requires the matching client manifest even if the old SVG bytes did not change', async () => {
  await expect(verifyReactionClientBuild(directory, 'new')).rejects.toThrow(
    'reaction-release.json',
  );
  await writeFile(
    join(directory, 'reaction-release.json'),
    JSON.stringify({ formatVersion: 1, version: 'old' }),
  );
  await expect(verifyReactionClientBuild(directory, 'new')).rejects.toThrow(
    'Выпустите клиент и сервер вместе',
  );
  await writeFile(
    join(directory, 'reaction-release.json'),
    JSON.stringify({ formatVersion: 1, version: 'new' }),
  );
  await expect(verifyReactionClientBuild(directory, 'new')).resolves.toBeUndefined();
});
it('keeps served bytes immutable for the lifetime of a release snapshot', async () => {
  const source = await readFile('apps/client/public/reactions/hello.svg');
  await writeFile(join(directory, 'hello.svg'), source);
  const original = await loadReactionRelease(directory, [REACTIONS[0]]);
  await writeFile(join(directory, 'hello.svg'), Buffer.concat([source, Buffer.from('\n')]));
  expect(original.assets.get('hello.svg')).toEqual(source);
  expect((await loadReactionRelease(directory, [REACTIONS[0]])).version).not.toBe(original.version);
});
