import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { format, resolveConfig } from 'prettier';
import type { ReactionDefinition } from '../../packages/contracts/src/reactions.js';
import { validateReactionDefinitions } from '../../packages/contracts/src/reaction-validation.js';
import {
  ASSETS,
  REGISTRY,
  inspectReactionCatalog,
  readReactionRegistry,
  validateReactionSvg,
} from './catalog.js';

const xmlText = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (s) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[s]!,
  );

export function reactionTemplate(label: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none">
  <title>${xmlText(label)}</title>
  <path d="M12 10h40a6 6 0 0 1 6 6v25a6 6 0 0 1-6 6H31L17 57V47h-5a6 6 0 0 1-6-6V16a6 6 0 0 1 6-6Z" fill="#68C8ED" stroke="#254B60" stroke-width="2.5" stroke-linejoin="round"/>
  <path d="m32 17 3 8 9 1-7 6 2 9-7-5-7 5 2-9-7-6 9-1 3-8Z" fill="#F3B35A" stroke="#523821" stroke-width="2" stroke-linejoin="round"/>
</svg>
`;
}

export async function addReaction(
  root: string,
  input: { id: string; label: string; category: string; assetFile?: string; dryRun?: boolean },
) {
  const entry: ReactionDefinition = {
    id: input.id,
    label: input.label,
    category: input.category,
    asset: `${input.id}.svg`,
  };
  validateReactionDefinitions([entry]);
  const lockPath = join(root, '.reactions-add.lock');
  let lock;
  try {
    lock = await fs.open(lockPath, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
      throw new Error(`Реакции (${lockPath}): ${(error as Error).message}`);
    throw new Error(
      'Реакции: уже есть .reactions-add.lock; завершите другой запуск перед добавлением',
    );
  }
  const registryPath = join(root, REGISTRY),
    assetPath = join(root, ASSETS, entry.asset);
  const temporary = `${registryPath}.${randomUUID()}.tmp`;
  let original: string | undefined, updated: string | undefined;
  let createdAsset = false,
    committedRegistry = false;
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    const existing = await inspectReactionCatalog(root);
    if (existing.definitions.some(({ id }) => id === entry.id))
      throw new Error(`Реакция "${entry.id}": повторный id (${REGISTRY})`);
    try {
      await fs.lstat(assetPath);
      throw new Error(`Реакция "${entry.id}": файл уже существует (${assetPath})`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    let bytes: Buffer;
    try {
      bytes = input.assetFile
        ? await fs.readFile(input.assetFile)
        : Buffer.from(reactionTemplate(entry.label));
    } catch (error) {
      throw new Error(`Реакция "${entry.id}" (${input.assetFile}): ${(error as Error).message}`);
    }
    validateReactionSvg(bytes, entry.id, input.assetFile ?? assetPath);
    original = await fs.readFile(registryPath, 'utf8');
    const { array } = readReactionRegistry(original, registryPath);
    const end = array.end - 1;
    const comma = array.elements.length && !array.elements.hasTrailingComma ? ',' : '';
    const row = JSON.stringify(entry);
    updated = await format(`${original.slice(0, end)}${comma}\n  ${row},\n${original.slice(end)}`, {
      ...(await resolveConfig(registryPath)),
      parser: 'typescript',
    });
    const candidate = await inspectReactionCatalog(root, {
      registryText: updated,
      asset: entry.asset,
      bytes,
    });
    if (input.dryRun) return { entry, dryRun: true, version: candidate.version };
    // Все данные и коллизии проверены. Ассет создаётся исключительно нами, реестр меняется rename.
    await fs.writeFile(temporary, updated, { flag: 'wx' });
    if ((await fs.readFile(registryPath, 'utf8')) !== original)
      throw new Error(`${REGISTRY}: изменён другим процессом; повторите добавление`);
    const asset = await fs.open(assetPath, 'wx');
    createdAsset = true;
    try {
      await asset.writeFile(bytes);
    } finally {
      await asset.close();
    }
    await fs.rename(temporary, registryPath);
    committedRegistry = true;
    const checked = await inspectReactionCatalog(root);
    return { entry, dryRun: false, version: checked.version };
  } catch (error) {
    if (committedRegistry && (await fs.readFile(registryPath, 'utf8')) === updated)
      await fs.writeFile(registryPath, original!);
    if (createdAsset) await fs.unlink(assetPath);
    throw error;
  } finally {
    await fs.rm(temporary, { force: true });
    await lock.close();
    await fs.unlink(lockPath);
  }
}
