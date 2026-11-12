/** Optional transport envelope. Original asset files and their SHA-256 identities stay intact. */
export const GRAPHICS_PACK_LIMITS = {
  bytes: 8 * 1024 * 1024,
  headerBytes: 256 * 1024,
  entries: 1024,
} as const;
const magic = 0x31504753; // SGP1, little endian
const text = new TextEncoder();
const pathPattern = /^[a-zA-Z0-9_./-]{1,256}$/;
const validPath = (path: unknown): path is string =>
  typeof path === 'string' &&
  pathPattern.test(path) &&
  !path.startsWith('/') &&
  !path.split('/').some((part) => !part || part === '.' || part === '..');
function requirePack(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid graphics pack: ${message}`);
}

export function encodeGraphicsPack(
  entries: readonly (readonly [string, Uint8Array])[],
): Uint8Array {
  requirePack(entries.length > 0 && entries.length <= GRAPHICS_PACK_LIMITS.entries, 'entry count');
  const paths = new Set<string>();
  for (const [path] of entries) {
    requirePack(validPath(path) && !paths.has(path), 'entry path');
    paths.add(path);
  }
  const header = text.encode(JSON.stringify(entries.map(([path, bytes]) => [path, bytes.length])));
  requirePack(header.length <= GRAPHICS_PACK_LIMITS.headerBytes, 'header size');
  const length = 8 + header.length + entries.reduce((sum, [, bytes]) => sum + bytes.length, 0);
  requirePack(length <= GRAPHICS_PACK_LIMITS.bytes, 'byte limit');
  const result = new Uint8Array(length);
  const view = new DataView(result.buffer);
  view.setUint32(0, magic, true);
  view.setUint32(4, header.length, true);
  result.set(header, 8);
  let offset = 8 + header.length;
  for (const [, bytes] of entries) {
    result.set(bytes, offset);
    offset += bytes.length;
  }
  return result;
}

/** Returned views share the envelope buffer; cache owners must copy retained entries. */
export function decodeGraphicsPack(bytes: Uint8Array): Map<string, Uint8Array> {
  requirePack(bytes.length >= 8 && bytes.length <= GRAPHICS_PACK_LIMITS.bytes, 'byte limit');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  requirePack(view.getUint32(0, true) === magic, 'magic/version');
  const headerLength = view.getUint32(4, true);
  requirePack(
    headerLength <= GRAPHICS_PACK_LIMITS.headerBytes && 8 + headerLength <= bytes.length,
    'header size',
  );
  const header: unknown = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(8, 8 + headerLength)),
  );
  requirePack(
    Array.isArray(header) && header.length > 0 && header.length <= GRAPHICS_PACK_LIMITS.entries,
    'entry count',
  );
  const result = new Map<string, Uint8Array>();
  let offset = 8 + headerLength;
  for (const entry of header) {
    requirePack(Array.isArray(entry) && entry.length === 2, 'entry');
    const [path, length] = entry;
    requirePack(validPath(path) && !result.has(path), 'entry path');
    requirePack(
      Number.isSafeInteger(length) && length >= 0 && offset + length <= bytes.length,
      'entry size',
    );
    result.set(path, bytes.subarray(offset, offset + length));
    offset += length;
  }
  requirePack(offset === bytes.length, 'trailing bytes');
  return result;
}
