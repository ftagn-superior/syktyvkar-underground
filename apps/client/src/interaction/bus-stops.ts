import type { BusNetwork, BusPlatform, BusStop } from '@su/contracts';
import { INTERACTION_KINDS, type Interactable, type Vec3 } from './interactable';

/**
 * Платформы остановок как места взаимодействия: у каждой платформы появляется подсказка
 * «Пробел · Автобусы» с направлением движения на этой стороне улицы.
 */
export class BusStopSource {
  private readonly cache = new Map<string, Interactable>();
  private network?: BusNetwork;

  constructor(
    private readonly networkFor: () => BusNetwork | undefined,
    private readonly open: (platformId: string) => void,
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
      for (const platform of stop.platforms) {
        let item = this.cache.get(platform.id);
        if (!item) this.cache.set(platform.id, (item = this.create(stop, platform)));
        near.push(item);
      }
    }
    return near;
  }

  private create(stop: BusStop, platform: BusPlatform): Interactable {
    const defaults = INTERACTION_KINDS.bus;
    const [x, z] = platform.position;
    let anchor: Vec3 = { x, y: 0, z };
    const hint = platform.sideHint ? ` (${platform.sideHint})` : '';
    return {
      id: `bus-stop:${platform.id}`,
      kind: 'bus',
      ...defaults,
      objectName: `Остановка «${stop.name}»${hint}`,
      getAnchor: () => anchor,
      getDistance: (player: Vec3) => {
        const d = Math.hypot(x - player.x, z - player.z);
        // Высоты остановки в данных нет: подсказка над головой стоящего рядом игрока.
        anchor = { x, y: player.y + 1.4, z };
        return d;
      },
      onActivate: () => this.open(platform.id),
      setHighlighted: () => {},
    };
  }
}
