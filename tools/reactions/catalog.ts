import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import ts from 'typescript';
import { SaxesParser } from 'saxes';
import {
  REACTION_SVG_MAX_BYTES,
  validateReactionDefinitions,
} from '../../packages/contracts/src/reaction-validation.js';
import type { ReactionDefinition } from '../../packages/contracts/src/reactions.js';
import { reactionReleaseVersion } from '../../apps/server/src/reactions/version.js';

export const REGISTRY = 'packages/contracts/src/reactions.ts';
export const ASSETS = 'apps/client/public/reactions';

/** Читаем только литералы данных, не исполняем изменённый автором модуль. */
export function readReactionRegistry(text: string, path = REGISTRY) {
  const errors = ts
    .transpileModule(text, { fileName: path, reportDiagnostics: true })
    .diagnostics?.filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (errors?.length)
    throw new Error(`${path}: ${ts.flattenDiagnosticMessageText(errors[0].messageText, '\n')}`);
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  let array: ts.ArrayLiteralExpression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'REACTIONS') {
      let value = node.initializer;
      while (value && (ts.isAsExpression(value) || ts.isSatisfiesExpression(value)))
        value = value.expression;
      if (value && ts.isArrayLiteralExpression(value)) array = value;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!array) throw new Error(`${path}: нужен массив REACTIONS из объектов с литералами строк`);
  const definitions = array.elements.map((element, index) => {
    if (!ts.isObjectLiteralExpression(element))
      throw new Error(`${path}: запись #${index + 1} должна быть объектом`);
    const entry: Record<string, string> = {};
    for (const property of element.properties) {
      if (!ts.isPropertyAssignment(property) || !ts.isStringLiteral(property.initializer))
        throw new Error(`${path}: запись #${index + 1}: поля должны быть строковыми литералами`);
      const key = ts.isStringLiteral(property.name)
        ? property.name.text
        : property.name.getText(source);
      if (Object.hasOwn(entry, key))
        throw new Error(`${path}: запись #${index + 1}: повторное поле ${key}`);
      entry[key] = property.initializer.text;
    }
    return entry;
  });
  try {
    validateReactionDefinitions(definitions);
  } catch (error) {
    throw new Error(`${path}: ${(error as Error).message}`);
  }
  return { definitions, array, text };
}

const svgNamespace = 'http://www.w3.org/2000/svg';
const elements = new Set([
  'svg',
  'g',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'defs',
  'linearGradient',
  'radialGradient',
  'stop',
  'clipPath',
  'mask',
  'use',
  'title',
  'desc',
]);

/** Небольшой самостоятельный статичный SVG; XML проверяет настоящий XML-парсер. */
export function validateReactionSvg(bytes: Uint8Array, id: string, path: string): void {
  const fail = (message: string): never => {
    throw new Error(`Реакция "${id}" (${path}): ${message}`);
  };
  if (!bytes.length || bytes.length > REACTION_SVG_MAX_BYTES)
    fail(`SVG: размер 1–${REACTION_SVG_MAX_BYTES} байт`);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('SVG: нужен UTF-8');
  }
  const parser = new SaxesParser({ xmlns: true });
  let root = false;
  let drawing = false;
  parser.on('error', (error) => fail(`SVG/XML: ${error.message}`));
  parser.on('doctype', () => fail('SVG: DOCTYPE/ENTITY не поддерживаются'));
  parser.on('processinginstruction', () => fail('SVG: внешние инструкции не поддерживаются'));
  parser.on('opentag', (tag) => {
    if (
      ['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'use'].includes(
        tag.local,
      )
    )
      drawing = true;
    if (!elements.has(tag.local) || tag.uri !== svgNamespace)
      fail(`SVG: недопустимый элемент ${tag.name}`);
    if (!root) {
      root = true;
      if (tag.local !== 'svg') fail('SVG: корневой элемент должен быть svg');
      const box = tag.attributes.viewBox?.value
        .trim()
        .split(/[\s,]+/)
        .map(Number);
      if (!box || box.length !== 4 || box.some((n, i) => n !== [0, 0, 64, 64][i]))
        fail('SVG: ожидается viewBox="0 0 64 64"');
    }
    for (const { name, local, value } of Object.values(tag.attributes)) {
      if (/^on/i.test(local) || local === 'style') fail(`SVG: атрибут ${name} не поддерживается`);
      if (local === 'href' && !/^#[A-Za-z][\w.-]*$/.test(value))
        fail('SVG: href должен ссылаться на локальный #id');
      if (/url\s*\(/i.test(value) && !/^url\(#[A-Za-z][\w.-]*\)$/.test(value))
        fail('SVG: разрешены только локальные url(#id)');
    }
  });
  parser.write(text!).close();
  if (!root) fail('SVG: отсутствует корневой элемент');
  if (!drawing) fail('SVG: нужен хотя бы один векторный элемент рисунка');
}

export async function inspectReactionCatalog(
  root: string,
  candidate?: { registryText: string; asset: string; bytes: Uint8Array },
) {
  const registryPath = join(root, REGISTRY);
  const { definitions } = readReactionRegistry(
    candidate?.registryText ?? (await fs.readFile(registryPath, 'utf8')),
    registryPath,
  );
  const directory = join(root, ASSETS);
  const files = await fs.readdir(directory);
  const known = new Set(definitions.map((entry) => entry.asset));
  for (const file of files) {
    if (/\.(?:svg|png|jpe?g|webp|gif)$/i.test(file) && !known.has(file))
      throw new Error(`Реакции (${join(directory, file)}): файл не зарегистрирован в ${REGISTRY}`);
  }
  const assets = new Map<string, Uint8Array>();
  for (const { id, asset } of definitions) {
    const path = join(directory, asset);
    let bytes: Uint8Array;
    if (candidate?.asset === asset) bytes = candidate.bytes;
    else {
      try {
        const stat = await fs.lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink())
          throw new Error('нужен обычный файл, не ссылка');
        if (stat.size > REACTION_SVG_MAX_BYTES)
          throw new Error(`превышен лимит ${REACTION_SVG_MAX_BYTES} байт`);
        bytes = await fs.readFile(path);
      } catch (error) {
        throw new Error(`Реакция "${id}" (${path}): ${(error as Error).message}`);
      }
    }
    validateReactionSvg(bytes, id, path);
    assets.set(asset, bytes);
  }
  return {
    definitions: definitions as ReactionDefinition[],
    assets,
    version: reactionReleaseVersion(definitions, assets),
  };
}
