import { Encoder } from '@colyseus/schema';
import type { Client } from '@colyseus/core';
import { EntitySchema, PlayerSchema, WorldState } from '../../packages/protocol/src/index.js';
import { DynamicInterest } from '../../apps/server/src/interest.js';

/** Production schema/index, selection + encoding only; no claim about total server CPU or WS overhead. */
export function interestProfile(crowd: boolean) {
  const state = new WorldState();
  state.occupancy = 8;
  const encoder = new Encoder(state);
  const interest = new DynamicInterest({
    origin: { x: -1000, z: -1000 },
    cellSize: 125,
    columns: 16,
    rows: 16,
  });
  const clients = Array.from(
    { length: 8 },
    (_, index) => ({ sessionId: `profile-${index}` }) as Client,
  );
  for (const [index, client] of clients.entries()) {
    const player = new PlayerSchema();
    player.entityId = client.sessionId;
    player.kind = 'player';
    player.x = crowd ? index * 2 : -750 + (index % 4) * 500;
    player.z = crowd ? 0 : index < 4 ? -500 : 500;
    state.players.set(client.sessionId, player);
    interest.upsert(player);
  }
  const crate = new EntitySchema();
  crate.entityId = 'crate-01';
  state.crates.set(crate.entityId, crate);
  interest.upsert(crate);
  for (const client of clients) interest.reset(client, client.sessionId);
  const first = { offset: 0 };
  encoder.encodeAll(first);
  const fullSizes = clients.map(
    (client) =>
      encoder.encodeAllView(client.view!, first.offset, { offset: first.offset }).byteLength,
  );
  encoder.discardChanges();
  const selectMs: number[] = [],
    encodeMs: number[] = [];
  let bytes = 0;
  for (let iteration = 0; iteration < 1100; iteration++) {
    for (const player of state.players.values()) {
      player.x += 0.02;
      interest.upsert(player);
    }
    crate.x += 0.02;
    interest.upsert(crate);
    state.serverTick++;
    const start = performance.now();
    interest.refresh();
    const afterSelection = performance.now();
    const it = { offset: 0 };
    encoder.encode(it);
    const sharedOffset = it.offset;
    let frameBytes = 0;
    for (const client of clients)
      frameBytes += encoder.encodeView(client.view!, sharedOffset, it).byteLength;
    const afterEncoding = performance.now();
    encoder.discardChanges();
    if (iteration >= 100) {
      selectMs.push(afterSelection - start);
      encodeMs.push(afterEncoding - afterSelection);
      bytes += frameBytes;
    }
  }
  const stats = (samples: number[]) => {
    const sorted = [...samples].sort((a, b) => a - b);
    return {
      p95: sorted[Math.floor(sorted.length * 0.95)],
      p99: sorted[Math.floor(sorted.length * 0.99)],
      max: sorted.at(-1),
    };
  };
  const result = {
    profile: crowd ? 'crowd' : 'spread',
    clients: 8,
    measuredPatches: selectMs.length,
    fullSizes,
    meanStateBytesPerClientPatch: bytes / selectMs.length / 8,
    selectionMs: stats(selectMs),
    encodingMs: stats(encodeMs),
    selectionSamples: selectMs,
    encodingSamples: encodeMs,
    interest: interest.diagnostics(),
  };
  interest.clear();
  return result;
}
