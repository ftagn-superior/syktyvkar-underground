import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Client as SDK, type Room as SDKRoom } from '@colyseus/sdk';
import { Room, Server, matchMaker, type Client } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { Decoder, Encoder, StateView, schema, t } from '@colyseus/schema';
import { EntitySchema, MoveInputSchema, PlayerSchema } from '../../packages/protocol/src/index.js';

// Deliberately isolated from the production protocol until LM-02/LM-10.
class ProbeState extends schema({
  worldEpoch: t.string().default('L0'),
  occupancy: t.uint8().default(0),
  serverTick: t.uint32().default(0),
  players: t.map(PlayerSchema).view(),
  crates: t.map(EntitySchema).view(),
}) {}

class ProbeRoom extends Room<{ state: ProbeState; input: MoveInputSchema }> {
  state = new ProbeState();
  autoDispose = false;
  inputs = this.defineInput(MoveInputSchema, { bufferMaxSize: 32 });
  private readonly near = new Map<string, boolean>();

  onCreate(): void {
    const crate = new EntitySchema();
    crate.entityId = 'crate-01';
    this.state.crates.set(crate.entityId, crate);
    for (let i = 0; i < 6; i++) {
      const player = new PlayerSchema();
      player.entityId = `remote-${i}`;
      player.kind = 'player';
      player.sessionId = player.entityId;
      player.x = i * 200;
      this.state.players.set(player.entityId, player);
    }
    this.setPatchRate(50);
    this.setFixedTimestep(({ dt, tick }) => {
      for (const client of this.clients) {
        const input = this.inputs.get(client.sessionId).next();
        const player = this.state.players.get(client.sessionId);
        if (player && input) {
          player.x += input.moveX * dt * 4;
          player.z += input.moveZ * dt * 4;
        }
      }
      this.state.serverTick = tick;
    }, 60);
  }

  private setView(client: Client): void {
    client.view?.dispose();
    client.view = new StateView();
    client.view.add(this.state.players.get(client.sessionId)!);
    client.view.add(
      this.state.players.get(this.near.get(client.sessionId) ? 'remote-0' : 'remote-1')!,
    );
    if (this.near.get(client.sessionId)) client.view.add(this.state.crates.get('crate-01')!);
  }

  onJoin(client: Client, options: { near?: boolean }): void {
    this.near.set(client.sessionId, options.near === true);
    const player = new PlayerSchema();
    player.entityId = `own-${client.sessionId}`;
    player.kind = 'player';
    player.sessionId = client.sessionId;
    this.state.players.set(client.sessionId, player);
    this.state.occupancy = this.near.size;
    this.setView(client);
  }

  onDrop(client: Client): void {
    this.inputs.get(client.sessionId).clear();
    void this.allowReconnection(client, 2).catch(() => {});
  }

  onReconnect(client: Client): void {
    this.setView(client);
  }

  onLeave(client: Client): void {
    client.view?.dispose();
    this.state.players.delete(client.sessionId);
    this.near.delete(client.sessionId);
    this.state.occupancy = this.near.size;
  }

  setNearVisibility(visible: boolean): void {
    for (const client of this.clients) {
      if (!this.near.get(client.sessionId)) continue;
      for (const item of [
        this.state.crates.get('crate-01')!,
        this.state.players.get('remote-0')!,
      ]) {
        if (visible) client.view!.add(item);
        else client.view!.remove(item);
      }
    }
  }
}

async function until(predicate: () => boolean, timeout = 4000): Promise<void> {
  const start = performance.now();
  while (!predicate()) {
    if (performance.now() - start > timeout) throw new Error('StateView probe timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function encodingProfile(visiblePlayers: number) {
  const state = new ProbeState();
  const encoder = new Encoder(state);
  for (let i = 0; i < 8; i++) {
    const player = new PlayerSchema();
    player.entityId = `player-${i}`;
    player.kind = 'player';
    player.sessionId = player.entityId;
    state.players.set(player.entityId, player);
  }
  const crate = new EntitySchema();
  crate.entityId = 'crate-01';
  state.crates.set(crate.entityId, crate);
  const views = Array.from({ length: 8 }, (_, client) => {
    const view = new StateView();
    for (let i = 0; i < visiblePlayers; i++)
      view.add(state.players.get(`player-${(client + i) % 8}`)!);
    if (visiblePlayers === 8) view.add(state.crates.get('crate-01')!);
    return view;
  });
  const fullIterator = { offset: 0 };
  encoder.encodeAll(fullIterator);
  for (const view of views)
    encoder.encodeAllView(view, fullIterator.offset, { offset: fullIterator.offset });
  encoder.discardChanges();
  const samplesMs: number[] = [];
  let bytes = 0;
  for (let tick = 0; tick < 2200; tick++) {
    for (const player of state.players.values()) player.x += 0.2;
    state.crates.get('crate-01')!.x += 0.1;
    state.serverTick++;
    const start = performance.now();
    const iterator = { offset: 0 };
    encoder.encode(iterator);
    const sharedOffset = iterator.offset;
    let patchBytes = 0;
    for (const view of views) {
      patchBytes += encoder.encodeView(view, sharedOffset, iterator).byteLength;
    }
    encoder.discardChanges();
    if (tick >= 200) {
      samplesMs.push(performance.now() - start);
      bytes += patchBytes;
    }
  }
  for (const view of views) view.dispose();
  const sorted = [...samplesMs].sort((a, b) => a - b);
  return {
    clients: 8,
    visiblePlayers,
    visibleCrate: visiblePlayers === 8,
    iterations: samplesMs.length,
    meanBytesPerClientPerPatch: bytes / samplesMs.length / 8,
    encodingP95Ms: sorted[Math.floor(sorted.length * 0.95)],
    encodingP99Ms: sorted[Math.floor(sorted.length * 0.99)],
    samplesMs,
  };
}

function directReferenceProbe() {
  class RefState extends schema({
    crate: t.ref(EntitySchema).view().optional(),
    players: t.map(PlayerSchema).view(),
  }) {}
  const state = new RefState();
  state.crate = new EntitySchema();
  state.crate.entityId = 'crate-01';
  const encoder = new Encoder(state);
  const player = new PlayerSchema();
  player.kind = 'player';
  state.players.set('own', player);
  const view = new StateView();
  view.add(player);
  const iterator = { offset: 0 };
  encoder.encodeAll(iterator);
  const decoder = new Decoder(new RefState());
  decoder.decode(encoder.encodeAllView(view, iterator.offset, { offset: iterator.offset }));
  const result = {
    hiddenReferencePresent: decoder.state.crate !== undefined,
    hiddenEntityId: decoder.state.crate?.entityId ?? null,
    decoded: decoder.state.toJSON(),
  };
  view.dispose();
  return result;
}

export async function runStateViewProbe() {
  const http = createServer();
  const server = new Server({
    transport: new WebSocketTransport({ server: http }),
    greet: false,
    gracefullyShutdown: false,
  });
  server.define('large-map-l0', ProbeRoom);
  const clients = new Set<SDKRoom<ProbeState>>();
  const firstSnapshots: { players: string[]; crate?: string }[] = [];
  try {
    await server.serverless();
    const listing = await matchMaker.createRoom('large-map-l0', {});
    const authoritative = matchMaker.getLocalRoomById(listing.roomId) as ProbeRoom;
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject);
      http.listen(0, '127.0.0.1', resolve);
    });
    const address = http.address();
    assert.ok(address && typeof address !== 'string');
    const sdk = new SDK(`http://127.0.0.1:${address.port}`);
    const observe = async (room: SDKRoom<ProbeState>) => {
      room.reconnection.enabled = false;
      clients.add(room);
      room.onStateChange.once((state) =>
        firstSnapshots.push({
          players: [...state.players.keys()],
          crate: state.crates.get('crate-01')?.entityId,
        }),
      );
      await until(() => room.state?.serverTick > 0 && room.state.players.has(room.sessionId));
      return room;
    };
    const near = await observe(
      await sdk.joinById<ProbeState>(listing.roomId, { near: true }, ProbeState),
    );
    const far = await observe(
      await sdk.joinById<ProbeState>(listing.roomId, { near: false }, ProbeState),
    );
    assert.deepEqual([...near.state.players.keys()].sort(), [near.sessionId, 'remote-0'].sort());
    assert.deepEqual([...far.state.players.keys()].sort(), [far.sessionId, 'remote-1'].sort());
    assert.equal(near.state.crates.get('crate-01')?.entityId, 'crate-01');
    assert.equal(far.state.crates.get('crate-01'), undefined);
    assert.equal(firstSnapshots[0].crate, 'crate-01');
    assert.equal(firstSnapshots[1].crate, undefined);
    assert.equal(firstSnapshots[1].players.length, 2);
    await until(() => far.state.occupancy === 2);

    const input = far.input({ type: MoveInputSchema, mode: 'reliable' });
    input.data.moveX = 1;
    input.send();
    await until(() => input.lastProcessed > 0 && far.state.players.get(far.sessionId)!.x > 0);
    const ack = input.lastProcessed;

    authoritative.setNearVisibility(false);
    await until(() => !near.state.crates.has('crate-01') && !near.state.players.has('remote-0'));
    authoritative.state.crates.get('crate-01')!.x = 101;
    authoritative.state.players.get('remote-0')!.x = 42;
    authoritative.setNearVisibility(true);
    await until(
      () =>
        near.state.crates.get('crate-01')?.x === 101 &&
        near.state.players.get('remote-0')?.x === 42,
    );
    assert.equal(far.state.crates.get('crate-01'), undefined);
    const entityId = far.state.players.get(far.sessionId)!.entityId;
    const token = far.reconnectionToken;
    far.connection.close(1000);
    await until(() => authoritative.clients.length === 1);
    const recovered = await observe(await sdk.reconnect<ProbeState>(token, ProbeState));
    clients.delete(far);
    assert.equal(recovered.state.players.get(recovered.sessionId)!.entityId, entityId);
    assert.equal(recovered.state.crates.get('crate-01'), undefined);
    assert.deepEqual(
      [...recovered.state.players.keys()].sort(),
      [recovered.sessionId, 'remote-1'].sort(),
    );
    const recoveredInput = recovered.input({ type: MoveInputSchema, mode: 'reliable' });
    const previousZ = recovered.state.players.get(recovered.sessionId)!.z;
    recoveredInput.data.moveZ = 1;
    recoveredInput.send();
    await until(
      () =>
        recoveredInput.lastProcessed > 0 &&
        recovered.state.players.get(recovered.sessionId)!.z > previousZ,
    );
    return {
      result: 'passed',
      directReference: directReferenceProbe(),
      firstSnapshots,
      inputAck: ack,
      reconnectAck: recoveredInput.lastProcessed,
      checks: [
        'filtered first snapshot',
        'own player',
        'global occupancy',
        'crate absent',
        'view removal',
        'fresh state on return',
        'input/ack without crate',
        'filtered reconnect with same entity',
      ],
      encoding: [encodingProfile(1), encodingProfile(8)],
    };
  } finally {
    await Promise.allSettled([...clients].map((client) => client.leave()));
    await server.gracefullyShutdown(false);
    if (http.listening) await new Promise<void>((resolve) => http.close(() => resolve()));
  }
}
