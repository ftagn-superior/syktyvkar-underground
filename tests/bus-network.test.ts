import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BUS_ROUTES_IN_GAME } from '../packages/contracts/src/bus-network.js';
import { normName, parseT11, type BusNetwork } from '../tools/world-build/src/bus-network.js';

const network = JSON.parse(
  readFileSync('content/worlds/ring-block/bus-network/network.json', 'utf8'),
) as BusNetwork;
const terrain = JSON.parse(
  readFileSync('content/worlds/ring-block/terrain-expansion/source.json', 'utf8'),
) as { worldBoundsXZ: Record<'west' | 'east' | 'north' | 'south', number> };

describe('bus network', () => {
  const stops = new Map(network.stops.map((s) => [s.id, s]));
  const platforms = new Map(
    network.stops.flatMap((s) => s.platforms.map((p) => [p.id, { stop: s, platform: p }])),
  );
  const { west, east, north, south } = terrain.worldBoundsXZ;
  const inWorld = ([x, z]: [number, number], m = 0) =>
    x >= west - m && x <= east + m && z >= north - m && z <= south + m;

  it('has formatVersion 3 and unique stop, platform, and route ids', () => {
    expect(network.formatVersion).toBe(3);
    expect(stops.size).toBe(network.stops.length);
    const totalPlatforms = network.stops.reduce((n, s) => n + s.platforms.length, 0);
    expect(platforms.size).toBe(totalPlatforms);
    expect(new Set(network.routes.map((r) => r.id)).size).toBe(network.routes.length);
  });

  it('keeps every stop and platform inside the world', () => {
    for (const s of network.stops) {
      expect(inWorld(s.position), s.id).toBe(true);
      expect(s.platforms.length, s.id).toBeGreaterThan(0);
      for (const p of s.platforms) expect(inWorld(p.position), `${s.id}:${p.id}`).toBe(true);
    }
  });

  it('references only known stops and platforms and lists each route on its stops', () => {
    for (const r of network.routes) {
      expect(r.directions.length, r.id).toBeGreaterThan(0);
      for (const dir of r.directions) {
        const refs = dir.sequence.filter(
          (e): e is { stopId: string; platformId: string } => 'stopId' in e,
        );
        expect(refs.length, `${r.id}:${dir.towards}`).toBeGreaterThan(0);
        for (const ref of refs) {
          expect(stops.has(ref.stopId), `${r.id} → ${ref.stopId}`).toBe(true);
          expect(platforms.get(ref.platformId)?.stop.id, `${r.id} → ${ref.platformId}`).toBe(
            ref.stopId,
          );
          expect(stops.get(ref.stopId)!.routes, `${ref.stopId} lists ${r.ref}`).toContain(r.ref);
        }
      }
    }
  });

  it('has one road leg between each pair of neighbouring stops per direction, near the world', () => {
    for (const r of network.routes) {
      for (const dir of r.directions) {
        const refs = dir.sequence.filter((e) => 'stopId' in e);
        expect(dir.legs.length, `${r.id}:${dir.towards}`).toBe(refs.length - 1);
        for (const leg of dir.legs)
          for (const piece of leg) {
            expect(piece.length, r.id).toBeGreaterThan(1);
            for (const p of piece) expect(inWorld(p, 301), r.id).toBe(true);
          }
      }
    }
  });

  it('routes every in-game leg along roads and includes real OSM platforms at key hubs', () => {
    const legs = network.routes.flatMap((r) => r.directions.flatMap((d) => d.legs));
    expect(legs.filter((l) => l.length > 0).length / legs.length).toBeGreaterThan(0.9);

    const liveRefs = new Set<string>(BUS_ROUTES_IN_GAME);
    const liveLegs = network.routes
      .filter((r) => liveRefs.has(r.ref))
      .flatMap((r) => r.directions.flatMap((d) => d.legs));
    expect(liveLegs.every((l) => l.length > 0)).toBe(true);

    expect(
      stops
        .get('sgu')
        ?.platforms.map((p) => p.id)
        .sort(),
    ).toEqual(['osm-1391361123', 'osm-2165055372']);
    const tsum = stops.get('tsentralnyy-univermag');
    expect(tsum?.platforms.map((p) => p.id).sort()).toEqual(['osm-1316147446', 'osm-707556682']);
    expect(tsum?.platforms.every((p) => p.source === 'osm')).toBe(true);
    expect(
      stops
        .get('muzteatr')
        ?.platforms.map((p) => p.id)
        .sort(),
    ).toEqual(['osm-6533224862', 'osm-707553413']);
    expect(stops.has('shkola-35-oktyabrskiy')).toBe(true);
  });
});

describe('bus network parsing', () => {
  it('normalises stop names from both sources', () => {
    expect(normName('Улица Димитрова')).toBe('димитрова');
    expect(normName('Баня № 4')).toBe('баня №4');
    expect(normName('ЖК Атлантида, Конечная')).toBe('жк атлантида');
    expect(normName('Кинотеатр "Родина"')).toBe('кинотеатр родина');
  });

  it('reads route number, name and ordered stops from a route page', () => {
    const page = `<div data-uri="bus_174a" data-number="174" data-longname="Птицефабрика — Аэровокзал"></div>
      <a data-stop-id="1" href="#"><div class="trip-label trip-label-centered">
        Рынок                            </div></a>
      <a data-stop-id="2" href="#"><div class="trip-label">Улица &quot;Ленина&quot;</div></a>`;
    expect(parseT11(page)).toEqual({
      uri: 'bus_174a',
      ref: '174',
      name: 'Птицефабрика — Аэровокзал',
      stops: ['Рынок', 'Улица "Ленина"'],
    });
  });
});

describe('bus files in the world release', () => {
  it('copies the network and map next to the manifest and removes them when the source goes', async () => {
    const { mkdtemp, mkdir, copyFile, readFile, rm, access } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { writeBusFiles } = await import('../tools/world-build/src/index.js');
    const root = await mkdtemp(join(tmpdir(), 'su-bus-'));
    try {
      const source = join(root, 'source');
      const output = join(root, 'out');
      await mkdir(join(source, 'bus-network'), { recursive: true });
      await mkdir(output);
      for (const file of ['network.json', 'map.json'])
        await copyFile(
          `content/worlds/ring-block/bus-network/${file}`,
          join(source, 'bus-network', file),
        );
      await writeBusFiles(source, output);
      expect(await readFile(join(output, 'bus-network.json'), 'utf8')).toBe(
        await readFile('content/worlds/ring-block/bus-network/network.json', 'utf8'),
      );
      await access(join(output, 'bus-map.json'));
      await rm(join(source, 'bus-network'), { recursive: true });
      await writeBusFiles(source, output);
      await expect(access(join(output, 'bus-network.json'))).rejects.toThrow();
      await expect(access(join(output, 'bus-map.json'))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
