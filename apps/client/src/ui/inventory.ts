import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector';
import {
  canonicalJson,
  type InventoryItem,
  type InventoryView,
  type ItemPose,
} from '@su/contracts';
import { isTextInput } from '../input/keyboard';
import type { GameSession } from '../network/session';
import type { WorldView } from '../rendering/world-view';
import { ICONS } from './icons';

/** Одна плитка рюкзака: все экземпляры одного типа с одинаковыми свойствами. */
export interface InventoryGroup {
  key: string;
  typeId: string;
  count: number;
  /** Any instance of the group; placing takes this one. */
  item: InventoryItem;
}

/**
 * Groups server slots into one entry per item type. Items with different properties stay apart,
 * so future per-item properties are never merged by the interface.
 */
export function groupInventory(inventory: InventoryView): InventoryGroup[] {
  const groups = new Map<string, InventoryGroup>();
  for (const slot of inventory.slots)
    for (const item of slot.items) {
      const key = `${item.typeId}|${canonicalJson(item.properties ?? {})}`;
      const group = groups.get(key);
      if (group) group.count++;
      else groups.set(key, { key, typeId: item.typeId, count: 1, item });
    }
  return [...groups.values()];
}
export const inventoryTotal = (inventory: InventoryView): number =>
  inventory.slots.reduce((total, slot) => total + slot.items.length, 0);

/**
 * Рюкзак: кнопка в доке со счётчиком и лоток с плиткой на каждый тип. Выбор плитки закрывает
 * лоток и включает размещение; подсказка размещения — плашка наверху. Стопок, ячеек, разделения
 * и объединения в интерфейсе нет: действия `split`, `merge`, `move` остаются только на сервере.
 * Предмет сдвигается только после подтверждения сервера.
 */
export class InventoryPanel {
  private enabled = true;
  private placementAllowed = true;
  private readonly controller = new AbortController();
  private readonly toggle = document.getElementById('inventory-toggle') as HTMLButtonElement;
  private readonly badge = document.getElementById('inventory-count')!;
  private readonly panel = document.getElementById('inventory-panel')!;
  private readonly tiles: HTMLElement;
  private readonly note = document.getElementById('inventory-note')!;
  private readonly summary = document.getElementById('inventory-summary')!;
  private readonly pill = document.createElement('section');
  private readonly pillIcon = document.createElement('span');
  private readonly pillName = document.createElement('b');
  private readonly placementStatus = document.createElement('p');
  private readonly confirm = document.createElement('button');
  private groups: InventoryGroup[] = [];
  private selected?: InventoryItem;
  private pendingPickup?: { name: string; icon: string };
  private rotation = Quaternion.Identity();
  private pose?: ItemPose;
  private valid = false;
  private signature = '';
  constructor(
    private readonly session: GameSession,
    private readonly canvas: HTMLCanvasElement,
    private readonly onOpen?: () => void,
    private readonly onPlacementChange?: (active: boolean) => void,
    private readonly onPickedUp?: (name: string, icon: string) => void,
  ) {
    this.tiles = this.panel.querySelector('.tiles')!;
    this.pill.id = 'item-placement';
    this.pill.className = 'place-pill ui-panel';
    this.pill.hidden = true;
    this.pill.setAttribute('aria-label', 'Размещение предмета');
    this.pillIcon.className = 'ic';
    this.pillIcon.setAttribute('aria-hidden', 'true');
    const copy = document.createElement('span');
    copy.className = 'place-copy';
    const line = document.createElement('span');
    const optional = document.createElement('span');
    optional.className = 'opt';
    optional.textContent = ' · Esc — отмена';
    line.append(this.pillName, ' · щёлкните по миру', optional);
    this.placementStatus.className = 'place-status';
    this.placementStatus.setAttribute('role', 'status');
    copy.append(line, this.placementStatus);
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'ui-btn ui-icon-btn';
    cancel.setAttribute('aria-label', 'Отменить размещение (Esc)');
    cancel.innerHTML = ICONS.close;
    this.confirm.type = 'button';
    this.confirm.className = 'ui-btn ui-pri';
    this.confirm.textContent = 'Поставить';
    this.confirm.disabled = true;
    this.pill.append(this.pillIcon, copy, this.confirm, cancel);
    document.getElementById('hud-top')!.append(this.pill);

    const options = { signal: this.controller.signal };
    cancel.addEventListener(
      'click',
      () => {
        this.cancel();
        this.canvas.focus({ preventScroll: true });
      },
      options,
    );
    this.confirm.addEventListener('click', () => this.place(), options);
    this.toggle.addEventListener('click', () => this.open(this.panel.hidden), options);
    this.tiles.addEventListener(
      'click',
      (event) => {
        const tile = (event.target as Element).closest<HTMLButtonElement>('[data-group]');
        if (tile && !tile.disabled) this.choose(tile.dataset.group!);
      },
      options,
    );
    canvas.addEventListener(
      'click',
      () => {
        if (this.enabled && this.selected) this.place();
      },
      options,
    );
    window.addEventListener(
      'keydown',
      (event) => {
        if (
          !this.enabled ||
          !this.placementAllowed ||
          event.repeat ||
          event.ctrlKey ||
          event.metaKey ||
          event.altKey ||
          isTextInput(event.target)
        )
          return;
        if (event.code === 'KeyX') {
          event.preventDefault();
          this.open(this.panel.hidden);
          return;
        }
        if (event.code === 'Escape' && (!this.panel.hidden || this.selected)) {
          event.preventDefault();
          this.cancel();
          this.open(false);
          return;
        }
        const digit = /^(?:Digit|Numpad)([1-9])$/.exec(event.code);
        if (digit && !this.panel.hidden) {
          const tile =
            this.tiles.querySelectorAll<HTMLButtonElement>('[data-group]')[Number(digit[1]) - 1];
          if (tile && !tile.disabled) {
            event.preventDefault();
            this.choose(tile.dataset.group!);
          }
        }
      },
      options,
    );
    window.addEventListener(
      'pointerdown',
      (event) => {
        if (
          !this.panel.hidden &&
          event.target instanceof Node &&
          !this.panel.contains(event.target) &&
          !this.toggle.contains(event.target)
        )
          this.open(false, false);
      },
      options,
    );
    session.onInventoryChange = () => this.update();
    session.onItemResult = (result) => {
      const picked = this.pendingPickup;
      this.pendingPickup = undefined;
      if (result.ok && picked) this.onPickedUp?.(picked.name, picked.icon);
      if (result.ok) this.cancel();
      this.update();
    };
    this.update();
  }
  private get inWorld(): boolean {
    return ['playing', 'preparing', 'waiting'].includes(this.session.state) && !!this.session.room;
  }
  private open(open: boolean, restoreFocus = true) {
    if (open && (!this.enabled || !this.inWorld)) return;
    const wasOpen = !this.panel.hidden;
    if (open) {
      this.onOpen?.();
      this.cancel();
    }
    this.panel.hidden = !open;
    this.toggle.setAttribute('aria-expanded', String(open));
    if (open) {
      this.signature = '';
      this.update();
      this.tiles.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({
        preventScroll: true,
      });
    } else if (wasOpen && restoreFocus) this.canvas.focus({ preventScroll: true });
  }
  close(): void {
    this.panel.hidden = true;
    this.toggle.setAttribute('aria-expanded', 'false');
    this.cancel();
  }
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) this.close();
    this.update();
  }
  /**
   * Placing aims with the mouse and turns with keys; in touch mode the backpack opens by tap only
   * and its tiles are for viewing. Hotkeys stay inert there, as do all other HUD hotkeys.
   */
  setTouch(touch: boolean): void {
    if (this.placementAllowed === !touch) return;
    this.placementAllowed = !touch;
    if (touch) this.cancel();
    this.signature = '';
    this.update();
  }
  /** True when a contextual pickup prompt may be shown and activated. */
  get canCollect(): boolean {
    return (
      this.enabled &&
      !this.selected &&
      this.session.state === 'playing' &&
      !!this.session.accountId &&
      !this.session.itemPending &&
      !this.session.worldPaused
    );
  }
  /** Picks up a specific item; called by the interaction prompt. */
  pickup(itemId: string, name = 'Предмет', typeId?: string): void {
    if (!this.canCollect) return;
    const icon = (typeId && this.session.definition.itemCatalog.types[typeId]?.icon) || '📦';
    this.pendingPickup = { name, icon };
    this.session.itemAction({ kind: 'pickup', itemId });
  }
  private choose(key: string): void {
    const group = this.groups.find((entry) => entry.key === key);
    if (!group || !this.placementAllowed || !this.enabled) return;
    const type = this.session.definition.itemCatalog.types[group.typeId];
    this.open(false, false);
    this.selected = group.item;
    this.rotation = Quaternion.Identity();
    this.pillIcon.textContent = type.icon;
    this.pillName.textContent = type.name;
    this.placementStatus.textContent = '';
    this.pill.hidden = false;
    this.onPlacementChange?.(true);
    this.canvas.focus({ preventScroll: true });
  }
  private place() {
    if (this.enabled && this.selected && this.pose && this.valid)
      this.session.itemAction({ kind: 'place', itemId: this.selected.itemId, pose: this.pose });
  }
  private cancel() {
    const wasPlacing = !!this.selected;
    this.selected = undefined;
    this.pose = undefined;
    this.valid = false;
    this.pill.hidden = true;
    if (wasPlacing) this.onPlacementChange?.(false);
  }
  rotatePlacement(axis: 'x' | 'y' | 'z', direction: -1 | 1): void {
    if (!this.enabled || !this.selected || this.session.itemPending || this.session.worldPaused)
      return;
    const vector = axis === 'x' ? Vector3.Right() : axis === 'y' ? Vector3.Up() : Vector3.Forward();
    this.rotation = Quaternion.RotationAxis(vector, (direction * Math.PI) / 12)
      .multiply(this.rotation)
      .normalize();
  }
  update() {
    const available = this.enabled && this.inWorld;
    this.toggle.hidden = !available;
    if (!available) {
      this.panel.hidden = true;
      this.cancel();
      this.toggle.setAttribute('aria-expanded', 'false');
    }
    // A selected item that left the inventory (placed elsewhere, world reset) ends placement.
    if (
      this.selected &&
      !this.session.inventory.slots.some((slot) =>
        slot.items.some((item) => item.itemId === this.selected!.itemId),
      )
    )
      this.cancel();
    const preparing = ['preparing', 'waiting'].includes(this.session.state);
    const busy = preparing || this.session.itemPending || this.session.worldPaused;
    const guest = !this.session.accountId;
    const total = inventoryTotal(this.session.inventory);
    this.badge.textContent = String(total);
    this.badge.hidden = total === 0;
    this.toggle.setAttribute('aria-label', total ? `Рюкзак: ${total} шт.` : 'Рюкзак');
    const signature = canonicalJson({
      inventory: this.session.inventory,
      busy,
      guest,
      place: this.placementAllowed,
    });
    if (signature === this.signature) return;
    this.signature = signature;
    this.groups = guest ? [] : groupInventory(this.session.inventory);
    const focused = this.panel.contains(document.activeElement)
      ? (document.activeElement as HTMLElement).dataset.group
      : undefined;
    this.panel.setAttribute('aria-busy', String(busy));
    this.summary.textContent = guest ? '' : `${total} шт.`;
    this.note.textContent = guest
      ? 'Войдите через Telegram, чтобы носить вещи.'
      : preparing
        ? 'Готовим окружение…'
        : busy
          ? 'Ожидаем подтверждение сервера…'
          : !this.groups.length
            ? this.placementAllowed
              ? 'Пусто. Подойдите к предмету и нажмите Z.'
              : 'Пусто. Подойдите к предмету и коснитесь подсказки.'
            : this.placementAllowed
              ? ''
              : 'Ставить предметы можно мышью и клавиатурой.';
    // The constructor renders before the world definition has loaded.
    const types =
      (this.session.definition as typeof this.session.definition | undefined)?.itemCatalog.types ??
      {};
    this.tiles.replaceChildren(
      ...this.groups.map((group, index) => {
        const type = types[group.typeId];
        const tile = document.createElement('button');
        tile.type = 'button';
        tile.className = 'ui-btn tile inventory-choice';
        tile.dataset.group = group.key;
        tile.dataset.typeId = group.typeId;
        tile.setAttribute('aria-label', `${type?.name ?? group.typeId}, ${group.count} шт.`);
        tile.title = type?.name ?? group.typeId;
        tile.disabled = busy || !this.placementAllowed;
        const icon = document.createElement('span');
        icon.className = 'ic';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = type?.icon ?? '📦';
        const count = document.createElement('span');
        count.className = 'n';
        count.setAttribute('aria-hidden', 'true');
        count.textContent = String(group.count);
        tile.append(icon, count);
        if (index < 9) {
          const key = document.createElement('span');
          key.className = 'catalog-choice-key';
          key.setAttribute('aria-hidden', 'true');
          key.textContent = String(index + 1);
          tile.setAttribute('aria-keyshortcuts', String(index + 1));
          tile.append(key);
        }
        return tile;
      }),
    );
    if (focused && !this.panel.hidden)
      (
        this.tiles.querySelector<HTMLButtonElement>(
          `[data-group="${CSS.escape(focused)}"]:not(:disabled)`,
        ) ?? this.tiles.querySelector<HTMLButtonElement>('button:not(:disabled)')
      )?.focus({ preventScroll: true });
  }
  frame(view: WorldView) {
    if (!this.enabled || !this.selected || this.session.state !== 'playing') {
      this.confirm.disabled = true;
      view.showPlacement();
      return;
    }
    const ray = view.pointerRay();
    const result = this.session.placement(this.selected.typeId, ray.from, ray.to, {
      x: this.rotation.x,
      y: this.rotation.y,
      z: this.rotation.z,
      w: this.rotation.w,
    });
    this.pose = result.pose;
    this.valid = !!result.pose && !result.error;
    view.showPlacement(this.selected.typeId, this.pose, this.valid);
    const text = this.session.itemPending
      ? 'Сохраняем…'
      : this.valid
        ? 'Место подходит · щелчок или «Поставить»'
        : result.error === 'OUT_OF_REACH'
          ? 'Подойдите ближе · не дальше 3 метров'
          : 'Выберите свободную поверхность с опорой';
    if (this.placementStatus.textContent !== text) this.placementStatus.textContent = text;
    this.placementStatus.dataset.state =
      this.valid && !this.session.itemPending ? 'ready' : 'waiting';
    this.confirm.disabled = !this.valid || this.session.itemPending || this.session.worldPaused;
  }
  dispose() {
    this.cancel();
    this.controller.abort();
    this.pill.remove();
  }
}
