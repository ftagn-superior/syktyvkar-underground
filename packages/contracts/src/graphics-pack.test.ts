import { describe, expect, it } from 'vitest';
import { decodeGraphicsPack, encodeGraphicsPack, GRAPHICS_PACK_LIMITS } from './graphics-pack.js';

const body = new Uint8Array([0, 255, 4]);
function rawPack(header: unknown, data = body) {
  const encoded = new TextEncoder().encode(JSON.stringify(header));
  const bytes = new Uint8Array(8 + encoded.length + data.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x31504753, true);
  view.setUint32(4, encoded.length, true);
  bytes.set(encoded, 8);
  bytes.set(data, 8 + encoded.length);
  return bytes;
}

describe('bounded graphics transport packs', () => {
  it('round trips exact binary assets deterministically, including empty files', () => {
    const entries = [
      ['assets/a/model.glb', body],
      ['assets/a/parts.json', new Uint8Array()],
    ] as const;
    const encoded = encodeGraphicsPack(entries);
    expect(encodeGraphicsPack(entries)).toEqual(encoded);
    expect([...decodeGraphicsPack(encoded)]).toEqual(entries);
    // A slice from a larger input buffer must not change offsets.
    const padded = new Uint8Array(encoded.length + 7);
    padded.set(encoded, 7);
    expect([...decodeGraphicsPack(padded.subarray(7))]).toEqual(entries);
  });

  it('rejects truncated, overlapping/ambiguous, oversized and path-escaping envelopes', () => {
    const good = encodeGraphicsPack([['model.glb', body]]);
    expect(() => decodeGraphicsPack(good.subarray(0, good.length - 1))).toThrow('entry size');
    expect(() => decodeGraphicsPack(rawPack([['model.glb', 2]]))).toThrow('trailing bytes');
    expect(() => decodeGraphicsPack(rawPack([['model.glb', -1]]))).toThrow('entry size');
    expect(() => decodeGraphicsPack(rawPack([['model.glb', 1.5]]))).toThrow('entry size');
    expect(() =>
      decodeGraphicsPack(
        rawPack([
          ['model.glb', 1],
          ['model.glb', 2],
        ]),
      ),
    ).toThrow('entry path');
    for (const path of ['../model.glb', '/model.glb', 'a//b', 'a/./b', '__proto__/../b'])
      expect(() => decodeGraphicsPack(rawPack([[path, 3]]))).toThrow('entry path');
    expect(() => decodeGraphicsPack(new Uint8Array(GRAPHICS_PACK_LIMITS.bytes + 1))).toThrow(
      'byte limit',
    );
    expect(() =>
      encodeGraphicsPack([['large.glb', new Uint8Array(GRAPHICS_PACK_LIMITS.bytes)]]),
    ).toThrow('byte limit');
    expect(() =>
      encodeGraphicsPack(
        Array.from(
          { length: GRAPHICS_PACK_LIMITS.entries + 1 },
          (_, i) => [`${i}.glb`, body] as const,
        ),
      ),
    ).toThrow('entry count');
  });
});
