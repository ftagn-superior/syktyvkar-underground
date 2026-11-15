import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normName, parseT11, type BusNetwork } from '../tools/world-build/src/bus-network.js';

const network = JSON.parse(
  readFileSync('content/worlds/ring-block/bus-network/network.json', 'utf8'),
) as BusNetwork;
const terrain = JSON.parse(
  readFileSync('content/worlds/ring-block/terrain-expansion/source.json', 'utf8'),
) as { worldBoundsXZ: Record<'west' | 'east' | 'north' | 'south', number> };

describe('bus network', () => {
  const stops = new Map(network.stops.map((s) => [s.id, s]));
  const { west, east, north, south } = terrain.worldBoundsXZ;
  const inWorld = ([x, z]: [number, number], m = 0) =>
    x >= west - m && x <= east + m && z >= north - m && z <= south + m;

  it('has unique stop and route ids', () => {
    expect(stops.size).toBe(network.stops.length);
    expect(new Set(network.routes.map((r) => r.id)).size).toBe(network.routes.length);
  });

  it('keeps every stop inside the world', () => {
    for (const s of network.stops) expect(inWorld(s.position), s.id).toBe(true);
  });

  it('references only known stops and lists each route on its stops', () => {
    for (const r of network.routes) {
      const ids = r.sequence.filter((e): e is string => typeof e === 'string');
      expect(ids.length, r.id).toBeGreaterThan(0);
      for (const id of ids) {
        expect(stops.has(id), `${r.id} → ${id}`).toBe(true);
        expect(stops.get(id)!.routes, `${id} lists ${r.ref}`).toContain(r.ref);
      }
    }
  });

  it('has one road leg between each pair of neighbouring stops, near the world', () => {
    for (const r of network.routes) {
      const ids = r.sequence.filter((e) => typeof e === 'string');
      expect(r.legs.length, r.id).toBe(ids.length - 1);
      for (const leg of r.legs)
        for (const piece of leg) {
          expect(piece.length, r.id).toBeGreaterThan(1);
          for (const p of piece) expect(inWorld(p, 301), r.id).toBe(true);
        }
    }
  });

  it('routes most legs along roads', () => {
    const legs = network.routes.flatMap((r) => r.legs);
    expect(legs.filter((l) => l.length > 0).length / legs.length).toBeGreaterThan(0.9);
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
