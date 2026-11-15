import type { BusNetwork, BusStop } from '@su/contracts';
import { INTERACTION_KINDS, type Interactable, type Vec3 } from './interactable';

/**
 * Остановки как места взаимодействия: у платформы появляется подсказка «Z · Автобусы»,
 * она открывает карту автобусов с этой остановкой как отправной. Один объект на остановку.
 */
export class BusStopSource {
  private readonly cache = new Map<string, Interactable>();
  private network?: BusNetwork;

  constructor(
    private readonly networkFor: () => BusNetwork | undefined,
    private readonly open: (stopId: string) => void,
  ) {}

  candidates(player: Vec3 | undefined): Iterable<Interactable> {
    const network = this.networkFor();
    if (network !== this.network) {
      this.network = network;
      this.cache.clear();
    }
    if (!network || !player) return [];
    const near: Interactable[] = [];
    // Грубый отбор до точного расстояния: остановок десятки, платформ у каждой одна–три.
    for (const stop of network.stops) {
      if (
        Math.abs(stop.position[0] - player.x) > 400 ||
        Math.abs(stop.position[1] - player.z) > 400
      )
        continue;
      let item = this.cache.get(stop.id);
      if (!item) this.cache.set(stop.id, (item = this.create(stop)));
      near.push(item);
    }
    return near;
  }

  private create(stop: BusStop): Interactable {
    const defaults = INTERACTION_KINDS.bus;
    const points = [stop.position, ...stop.platforms];
    let anchor: Vec3 = { x: stop.position[0], y: 0, z: stop.position[1] };
    return {
      id: `bus-stop:${stop.id}`,
      kind: 'bus',
      ...defaults,
      objectName: `Остановка «${stop.name}»`,
      getAnchor: () => anchor,
      getDistance: (player: Vec3) => {
        let best = Infinity;
        for (const [x, z] of points) {
          const d = Math.hypot(x - player.x, z - player.z);
          if (d < best) {
            best = d;
            // Высоты остановки в данных нет: подсказка над головой стоящего рядом игрока.
            anchor = { x, y: player.y + 1.4, z };
          }
        }
        return best;
      },
      onActivate: () => this.open(stop.id),
      setHighlighted: () => {},
    };
  }
}
