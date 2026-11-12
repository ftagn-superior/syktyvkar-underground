import type { GameSession } from '../network/session';
import type { WorldView } from '../rendering/world-view';
import { INTERACTION_KINDS, type Interactable, type Vec3 } from './interactable';

interface LiveItem {
  entityId: string;
  typeId: string;
  x: number;
  y: number;
  z: number;
}

/** Turns replicated items into pickup interactables, reusing one object per item. */
export class PickupSource {
  private readonly cache = new Map<string, { interactable: Interactable; seen: number }>();
  private scan = 0;
  constructor(
    private readonly session: GameSession,
    private readonly view: () => WorldView | undefined,
    private readonly accent: () => string,
    private readonly pickup: (itemId: string, name: string) => void,
  ) {}

  candidates(): Iterable<Interactable> {
    const room = this.session.room;
    if (!room) {
      this.cache.clear();
      return [];
    }
    const scan = ++this.scan;
    room.state.items.forEach((item: LiveItem) => {
      const known = this.cache.get(item.entityId);
      if (known) known.seen = scan;
      else this.cache.set(item.entityId, { interactable: this.create(item), seen: scan });
    });
    for (const [id, entry] of this.cache) if (entry.seen !== scan) this.cache.delete(id);
    return Array.from(this.cache.values(), (entry) => entry.interactable);
  }

  private create(item: LiveItem): Interactable {
    const defaults = INTERACTION_KINDS.pickup;
    const name = () => this.session.definition.itemCatalog.types[item.typeId]?.name ?? 'Предмет';
    return {
      id: item.entityId,
      kind: 'pickup',
      ...defaults,
      get objectName() {
        return name();
      },
      getAnchor: (): Vec3 => {
        const bounds = this.view()?.itemBounds(item.entityId);
        return { x: item.x, y: (bounds?.top ?? item.y + 0.5) + 0.3, z: item.z };
      },
      getDistance: (player: Vec3) =>
        Math.hypot(item.x - player.x, item.y - player.y, item.z - player.z),
      onActivate: () => this.pickup(item.entityId, name()),
      setHighlighted: (on: boolean) =>
        this.view()?.setItemRing(on ? item.entityId : undefined, this.accent()),
    };
  }
}
