import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { canonicalJson, type InventoryItem, type ItemPose } from '@su/contracts';
import type { GameSession } from '../network/session';
import type { WorldView } from '../rendering/world-view';

/** Private inventory and a local preview. Only server confirmation moves an instance. */
export class InventoryPanel {
  private readonly controller = new AbortController();
  private readonly toggle = document.createElement('button');
  private readonly pickup = document.createElement('button');
  private readonly panel = document.createElement('section');
  private readonly grid = document.createElement('div');
  private readonly message = document.createElement('p');
  private readonly toolbar = document.createElement('section');
  private readonly placementStatus = document.createElement('p');
  private readonly confirm: HTMLButtonElement;
  private selected?: InventoryItem;
  private targetSlot?: string;
  private rotation = Quaternion.Identity();
  private pose?: ItemPose;
  private valid = false;
  private signature = '';
  constructor(
    private readonly session: GameSession,
    private readonly canvas: HTMLCanvasElement,
    private readonly onOpen?: () => void,
  ) {
    this.toggle.className = this.pickup.className = 'button quiet';
    this.toggle.textContent = 'Инвентарь · I';
    this.toggle.hidden = true;
    this.toggle.setAttribute('aria-controls', 'inventory-panel');
    this.toggle.setAttribute('aria-expanded', 'false');
    this.pickup.textContent = 'Подобрать · F';
    this.pickup.hidden = true;
    document.querySelector('.actions')!.prepend(this.pickup, this.toggle);
    this.panel.id = 'inventory-panel';
    this.panel.className = 'inventory-panel';
    this.panel.hidden = true;
    this.panel.setAttribute('aria-label', 'Личный инвентарь');
    const title = document.createElement('h2');
    title.textContent = 'Личный инвентарь';
    const close = this.button('Закрыть', () => this.open(false));
    close.setAttribute('aria-label', 'Закрыть инвентарь');
    this.message.setAttribute('role', 'status');
    this.grid.className = 'inventory-grid';
    this.panel.append(title, close, this.message, this.grid);
    this.toolbar.className = 'placement-toolbar';
    this.toolbar.hidden = true;
    this.toolbar.setAttribute('aria-label', 'Размещение предмета');
    this.placementStatus.setAttribute('role', 'status');
    this.toolbar.append(this.placementStatus);
    for (const [name, axis] of [
      ['X', Vector3.Right()],
      ['Y', Vector3.Up()],
      ['Z', Vector3.Forward()],
    ] as const) {
      for (const sign of [-1, 1])
        this.toolbar.append(
          this.button(`${name} ${sign > 0 ? '+' : '−'}15°`, () => {
            this.rotation = Quaternion.RotationAxis(axis, (sign * Math.PI) / 12)
              .multiply(this.rotation)
              .normalize();
            this.canvas.focus({ preventScroll: true });
          }),
        );
    }
    this.confirm = this.button('Разместить', () => this.place());
    this.toolbar.append(
      this.confirm,
      this.button('Отмена · Esc', () => this.cancel()),
    );
    document.body.append(this.panel, this.toolbar);
    const options = { signal: this.controller.signal };
    this.toggle.addEventListener('click', () => this.open(this.panel.hidden), options);
    this.pickup.addEventListener('click', () => this.collect(), options);
    canvas.addEventListener(
      'click',
      () => {
        if (this.selected) this.place();
      },
      options,
    );
    window.addEventListener(
      'keydown',
      (event) => {
        if (
          event.repeat ||
          event.ctrlKey ||
          event.metaKey ||
          event.altKey ||
          (event.target instanceof HTMLElement &&
            (event.target.matches('input,textarea,select') || event.target.isContentEditable))
        )
          return;
        if (event.code === 'KeyI') {
          event.preventDefault();
          this.open(this.panel.hidden);
        }
        if (event.code === 'KeyF') {
          event.preventDefault();
          this.collect();
        }
        if (event.code === 'Escape') {
          this.cancel();
          this.open(false);
        }
      },
      options,
    );
    session.onInventoryChange = () => this.update();
    session.onItemResult = (result) => {
      if (result.ok) this.cancel();
      this.update();
    };
    this.update();
  }
  private button(text: string, click: () => void) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button quiet';
    button.textContent = text;
    button.addEventListener('click', click, { signal: this.controller.signal });
    return button;
  }
  private open(open: boolean) {
    if (
      open &&
      (!['playing', 'preparing', 'waiting'].includes(this.session.state) ||
        !this.session.accountId ||
        !this.session.room)
    )
      return;
    if (open) this.onOpen?.();
    this.panel.hidden = !open;
    this.toggle.setAttribute('aria-expanded', String(open));
    if (open) {
      this.cancel();
      this.update();
      this.panel.querySelector('button')?.focus();
    } else this.canvas.focus({ preventScroll: true });
  }
  close(): void {
    this.panel.hidden = true;
    this.toggle.setAttribute('aria-expanded', 'false');
    this.cancel();
  }
  private collect() {
    const id = this.session.nearestItem();
    if (id && !this.selected) this.session.itemAction({ kind: 'pickup', itemId: id });
  }
  private place() {
    if (this.selected && this.pose && this.valid)
      this.session.itemAction({ kind: 'place', itemId: this.selected.itemId, pose: this.pose });
  }
  private cancel() {
    this.selected = undefined;
    this.pose = undefined;
    this.targetSlot = undefined;
    this.toolbar.hidden = true;
  }
  update() {
    const preparing = ['preparing', 'waiting'].includes(this.session.state);
    const available =
      (this.session.state === 'playing' || preparing) &&
      !!this.session.accountId &&
      !!this.session.room;
    this.toggle.hidden = this.pickup.hidden = !available;
    if (!available) {
      this.panel.hidden = true;
      this.cancel();
      this.toggle.setAttribute('aria-expanded', 'false');
    }
    const busy = preparing || this.session.itemPending || this.session.worldPaused;
    this.pickup.disabled = busy || !this.session.nearestItem() || !!this.selected;
    this.toggle.disabled = false;
    const signature = canonicalJson({
      inventory: this.session.inventory,
      busy,
      target: this.targetSlot,
    });
    if (signature === this.signature) return;
    this.signature = signature;
    this.panel.setAttribute('aria-busy', String(busy));
    this.message.textContent = preparing
      ? 'Готовим окружение. Инвентарь доступен для просмотра.'
      : busy
        ? 'Ожидаем подтверждение сервера…'
        : this.targetSlot
          ? 'Выберите ячейку для обмена местами или объединения.'
          : this.session.inventory.slots.length
            ? 'Выберите предмет для размещения. Подбор дополняет стопки автоматически.'
            : 'Здесь пока пусто. Подойдите к предмету и нажмите F.';
    this.grid.replaceChildren();
    for (const slot of this.session.inventory.slots) {
      const item = slot.items[0],
        type = this.session.definition.itemCatalog.types[item.typeId];
      const cell = document.createElement('article');
      cell.className = 'inventory-slot';
      cell.dataset.slotId = slot.slotId;
      const choose = this.button(`${type.icon} ${type.name} × ${slot.items.length}`, () => {
        this.selected = item;
        this.rotation = Quaternion.Identity();
        this.open(false);
        this.toolbar.hidden = false;
      });
      choose.disabled = busy;
      cell.append(choose);
      if (slot.items.length > 1)
        cell.append(
          this.button('Разделить пополам', () =>
            this.session.itemAction({
              kind: 'split',
              slotId: slot.slotId,
              count: Math.floor(slot.items.length / 2),
            }),
          ),
        );
      if (!this.targetSlot)
        cell.append(
          this.button('Переместить / объединить', () => {
            this.targetSlot = slot.slotId;
            this.update();
          }),
        );
      else if (this.targetSlot !== slot.slotId) {
        cell.append(
          this.button('Поменять местами', () => {
            this.session.itemAction({
              kind: 'move',
              slotId: this.targetSlot!,
              targetSlotId: slot.slotId,
            });
            this.targetSlot = undefined;
          }),
        );
        cell.append(
          this.button('Объединить сюда', () => {
            this.session.itemAction({
              kind: 'merge',
              slotId: this.targetSlot!,
              targetSlotId: slot.slotId,
            });
            this.targetSlot = undefined;
          }),
        );
      } else
        cell.append(
          this.button('Отменить выбор', () => {
            this.targetSlot = undefined;
            this.update();
          }),
        );
      for (const button of cell.querySelectorAll('button')) button.disabled = busy;
      this.grid.append(cell);
    }
  }
  frame(view: WorldView) {
    if (!this.selected || this.session.state !== 'playing') {
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
      ? 'Сохраняем размещение…'
      : this.valid
        ? 'Место доступно · щелчок или «Разместить»'
        : result.error === 'OUT_OF_REACH'
          ? 'Подойдите ближе · не более 3 метров'
          : 'Выберите свободную поверхность с опорой';
    if (this.placementStatus.textContent !== text) this.placementStatus.textContent = text;
    this.confirm.disabled = !this.valid || this.session.itemPending || this.session.worldPaused;
  }
  dispose() {
    this.controller.abort();
    this.panel.remove();
    this.toolbar.remove();
    this.toggle.remove();
    this.pickup.remove();
  }
}
