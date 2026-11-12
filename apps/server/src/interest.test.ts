import { describe, expect, it } from 'vitest';
import type { Client } from '@colyseus/core';
import { Decoder, Encoder } from '@colyseus/schema';
import { EntitySchema, PlayerSchema, WorldState, toLocalSimulationSnapshot } from '@su/protocol';
import { DynamicInterest } from './interest';
const grid = { origin: { x: -1000, z: -1000 }, cellSize: 125, columns: 16, rows: 16 };
function fixture() {
  const state = new WorldState();
  const own = new PlayerSchema();
  own.entityId = 'own';
  own.kind = 'player';
  const remote = new PlayerSchema();
  remote.entityId = 'remote';
  remote.kind = 'player';
  remote.x = 500;
  const crate = new EntitySchema();
  crate.entityId = 'crate-01';
  crate.kind = 'item';
  crate.typeId = 'wooden-crate';
  crate.x = 600;
  state.players.set('self', own);
  state.players.set('other', remote);
  state.items.set(crate.entityId, crate);
  const encoder = new Encoder(state);
  const interest = new DynamicInterest(grid);
  for (const entity of [own, remote, crate]) interest.upsert(entity);
  const client = { sessionId: 'self' } as Client;
  interest.reset(client, own.entityId);
  const decode = () => {
    const it = { offset: 0 };
    encoder.encodeAll(it);
    const decoder = new Decoder(new WorldState());
    decoder.decode(encoder.encodeAllView(client.view!, it.offset, { offset: it.offset }));
    return decoder.state;
  };
  return { state, own, remote, crate, client, interest, decode };
}
describe('authoritative dynamic interest', () => {
  it('uses exact inclusive 500/800m thresholds and fresh hysteresis after reconnect', () => {
    const f = fixture();
    try {
      expect(f.client.view!.has(f.own)).toBe(true);
      expect(f.client.view!.has(f.remote)).toBe(true);
      expect(f.client.view!.has(f.crate)).toBe(false);
      for (const x of [600, 800]) {
        f.remote.x = x;
        f.interest.upsert(f.remote);
        f.interest.refresh();
        expect(f.client.view!.has(f.remote)).toBe(true);
      }
      f.remote.x = 800.01;
      f.interest.upsert(f.remote);
      f.interest.refresh();
      expect(f.client.view!.has(f.remote)).toBe(false);
      f.remote.x = 600;
      f.interest.upsert(f.remote);
      f.interest.refresh();
      expect(f.client.view!.has(f.remote)).toBe(false);
      f.remote.x = 500;
      f.interest.upsert(f.remote);
      f.interest.refresh();
      expect(f.client.view!.has(f.remote)).toBe(true);
      f.remote.x = 600;
      f.interest.upsert(f.remote);
      f.interest.refresh();
      const old = f.client.view!;
      f.interest.reset(f.client, f.own.entityId);
      expect(old.id).toBe(-1);
      expect(f.client.view!.has(f.remote)).toBe(false);
      expect(f.client.view!.has(f.own)).toBe(true);
    } finally {
      f.interest.clear();
    }
  });
  it('selects grid candidates across cell/world edges, then checks X/Z distance rather than axes or Y', () => {
    const f = fixture();
    try {
      f.own.x = 124.9;
      f.own.z = 0;
      f.remote.x = 125.1;
      f.remote.y = 500;
      for (const entity of [f.own, f.remote]) f.interest.upsert(entity);
      f.interest.refresh();
      expect(f.client.view!.has(f.remote)).toBe(true);
      f.remote.x = f.own.x + 4000;
      f.remote.z = 4000;
      f.interest.upsert(f.remote);
      f.interest.refresh();
      expect(f.client.view!.has(f.remote)).toBe(false);
      f.remote.x = f.own.x + 400;
      f.remote.z = 400;
      f.interest.upsert(f.remote);
      f.interest.refresh();
      expect(f.client.view!.has(f.remote)).toBe(false);
      f.own.x = -1000;
      f.own.z = -1000;
      f.remote.x = -1000.1;
      f.remote.z = -1000.1;
      for (const entity of [f.own, f.remote]) f.interest.upsert(entity);
      f.interest.refresh();
      expect(f.client.view!.has(f.remote)).toBe(true);
    } finally {
      f.interest.clear();
    }
  });
  it('filters a complete first snapshot, returns fresh state and allows empty or multiple local items', () => {
    const f = fixture();
    try {
      f.state.occupancy = 8;
      f.state.serverTick = 123;
      let decoded = f.decode();
      expect(decoded.occupancy).toBe(8);
      expect(decoded.serverTick).toBe(123);
      expect(decoded.items.size).toBe(0);
      expect(toLocalSimulationSnapshot(decoded)).toMatchObject({ scope: 'local', items: [] });
      f.crate.x = 499;
      f.interest.upsert(f.crate);
      f.interest.refresh();
      expect(f.decode().items.get(f.crate.entityId)!.x).toBe(499);
      f.crate.x = 801;
      f.interest.upsert(f.crate);
      f.interest.refresh();
      expect(f.decode().items.size).toBe(0);
      f.crate.x = 498;
      f.crate.revision = 9;
      f.interest.upsert(f.crate);
      f.interest.refresh();
      decoded = f.decode();
      expect(toLocalSimulationSnapshot(decoded).items[0]).toMatchObject({
        revision: 9,
        position: { x: 498 },
      });
      f.interest.remove(f.remote.entityId);
      f.state.players.delete('other');
      expect(f.decode().players.has('other')).toBe(false);
      const second = new EntitySchema();
      second.entityId = 'other-crate';
      f.state.items.set(second.entityId, second);
      f.interest.upsert(second);
      f.interest.refresh();
      expect(toLocalSimulationSnapshot(f.decode()).items).toHaveLength(2);
      // Projection removes no authoritative state and never mutates persisted ownership.
      f.own.x = -1000;
      f.interest.upsert(f.own);
      f.interest.refresh();
      expect(f.decode().items.size).toBe(0);
      expect(f.state.items.size).toBe(2);
    } finally {
      f.interest.clear();
    }
    expect(f.interest.diagnostics()).toMatchObject({
      indexed: 0,
      buckets: 0,
      views: 0,
      memberships: 0,
    });
  });
  it('does not carry visibility through an empty initial view or accumulate view slots', () => {
    const f = fixture();
    try {
      for (let i = 0; i < 30; i++) {
        f.interest.reset(f.client, 'not-spawned');
        expect(f.decode().players.size).toBe(0);
        expect(f.decode().items.size).toBe(0);
        f.interest.reset(f.client, f.own.entityId);
        expect(f.decode().players.has('self')).toBe(true);
        expect(f.interest.diagnostics().views).toBe(1);
      }
    } finally {
      f.interest.clear();
    }
  });
});
