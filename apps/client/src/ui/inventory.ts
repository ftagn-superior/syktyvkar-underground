import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { canonicalJson, type InventoryItem, type ItemPose } from '@su/contracts';
import type { GameSession } from '../network/session';
import type { WorldView } from '../rendering/world-view';

/** Private inventory and a local preview. Only server confirmation moves an instance. */
export class InventoryPanel {
  private enabled = true;
  private readonly controller = new AbortController();
  private readonly toggle = document.createElement('button');
  private readonly panel = document.createElement('section');
  private readonly grid = document.createElement('div');
  private readonly message = document.createElement('p');
  private readonly summary = document.createElement('span');
  private readonly details = document.createElement('section');
  private readonly toolbar = document.createElement('section');
  private readonly placementTitle = document.createElement('strong');
  private readonly placementStatus = document.createElement('p');
  private readonly confirm: HTMLButtonElement;
  private selected?: InventoryItem;
  private activeSlot?: string;
  private pendingFocusKey?: string;
  private pendingPickup?: string;
  private targetSlot?: string;
  private rotation = Quaternion.Identity();
  private pose?: ItemPose;
  private valid = false;
  private signature = '';
  constructor(
    private readonly session: GameSession,
    private readonly canvas: HTMLCanvasElement,
    private readonly onOpen?: () => void,
    private readonly onPlacementChange?: (active: boolean) => void,
    private readonly onPickedUp?: (name: string) => void,
  ) {
    this.toggle.type = 'button';
    this.toggle.className = 'su-row su-row-btn';
    this.toggle.id = 'inventory-toggle';
    this.toggle.append(
      Object.assign(document.createElement('span'), { textContent: 'Инвентарь' }),
      Object.assign(document.createElement('kbd'), { className: 'su-kbd', textContent: 'X' }),
    );
    this.toggle.setAttribute('aria-label', 'Инвентарь · X');
    this.toggle.hidden = true;
    this.toggle.setAttribute('aria-controls', 'inventory-panel');
    this.toggle.setAttribute('aria-expanded', 'false');
    this.toggle.setAttribute('aria-keyshortcuts', 'X');
    document.getElementById('help-menu-rows')!.append(this.toggle);
    this.panel.id = 'inventory-panel';
    this.panel.className = 'inventory-panel hud-panel';
    this.panel.hidden = true;
    this.panel.setAttribute('aria-label', 'Личный инвентарь');
    const heading = document.createElement('div');
    heading.className = 'catalog-heading';
    const titles = document.createElement('div');
    const eyebrow = document.createElement('span');
    eyebrow.className = 'catalog-eyebrow';
    eyebrow.textContent = 'Личные вещи';
    const title = document.createElement('h2');
    title.textContent = 'Инвентарь ';
    this.summary.className = 'catalog-count';
    title.append(this.summary);
    titles.append(eyebrow, title);
    const close = this.button('×', () => this.open(false));
    close.className = 'reaction-close catalog-close';
    close.setAttribute('aria-label', 'Закрыть инвентарь');
    close.title = 'Закрыть (Esc)';
    heading.append(titles, close);
    const description = document.createElement('p');
    description.className = 'catalog-description';
    description.textContent = 'Выберите стопку, затем действие.';
    this.message.className = 'catalog-status inventory-status';
    this.message.setAttribute('role', 'status');
    this.message.tabIndex = -1;
    this.grid.className = 'inventory-grid';
    this.grid.setAttribute('role', 'group');
    this.grid.setAttribute('aria-label', 'Предметы в инвентаре');
    this.details.className = 'inventory-details';
    this.details.setAttribute('aria-label', 'Действия с выбранной стопкой');
    const footer = document.createElement('div');
    footer.className = 'catalog-footer';
    for (const text of ['Подобрать — по подсказке (Z)', 'Закрыть — Esc']) {
      const hint = document.createElement('span');
      hint.textContent = text;
      footer.append(hint);
    }
    this.panel.append(heading, description, this.message, this.grid, this.details, footer);
    this.toolbar.id = 'item-placement';
    this.toolbar.className = 'placement-toolbar';
    this.toolbar.hidden = true;
    this.toolbar.setAttribute('aria-label', 'Размещение предмета');
    this.placementStatus.setAttribute('role', 'status');
    this.placementTitle.className = 'placement-title';
    this.placementStatus.className = 'catalog-status';
    this.toolbar.append(this.placementTitle, this.placementStatus);
    const hints = document.createElement('div');
    hints.className = 'placement-keys';
    hints.id = 'placement-keys';
    for (const [keys, label] of [
      ['W S', 'наклон'],
      ['A D', 'поворот'],
      ['Q E', 'крен'],
    ]) {
      const hint = document.createElement('span');
      for (const key of keys.split(' ')) {
        const keycap = document.createElement('kbd');
        keycap.textContent = key;
        hint.append(keycap);
      }
      hint.append(` — ${label}`);
      hints.append(hint);
    }
    const step = document.createElement('span');
    step.textContent = 'Шаг 15° · персонаж стоит на месте';
    hints.append(step);
    this.toolbar.setAttribute('aria-describedby', hints.id);
    this.confirm = this.button('Разместить', () => this.place());
    this.confirm.className = 'button inventory-primary';
    const placementActions = document.createElement('div');
    placementActions.className = 'inventory-actions';
    placementActions.append(
      this.confirm,
      this.button('Отмена · Esc', () => {
        this.cancel();
        this.canvas.focus({ preventScroll: true });
      }),
    );
    this.toolbar.append(hints, placementActions);
    document.body.append(this.panel, this.toolbar);
    const options = { signal: this.controller.signal };
    this.toggle.addEventListener('click', () => this.open(this.panel.hidden), options);
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
          event.repeat ||
          event.ctrlKey ||
          event.metaKey ||
          event.altKey ||
          (event.target instanceof HTMLElement &&
            (event.target.matches('input,textarea,select') || event.target.isContentEditable))
        )
          return;
        if (event.code === 'KeyX') {
          event.preventDefault();
          this.open(this.panel.hidden);
        }
        if (event.code === 'Escape' && (!this.panel.hidden || this.selected)) {
          event.preventDefault();
          this.cancel();
          this.open(false);
          this.canvas.focus({ preventScroll: true });
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
      if (result.ok && picked) this.onPickedUp?.(picked);
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
    button.dataset.focusKey = text;
    button.addEventListener(
      'click',
      () => {
        if (this.enabled) click();
      },
      { signal: this.controller.signal },
    );
    return button;
  }
  private open(open: boolean, restoreFocus = true) {
    if (
      open &&
      (!this.enabled ||
        !['playing', 'preparing', 'waiting'].includes(this.session.state) ||
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
      (
        this.panel.querySelector<HTMLButtonElement>(
          '.inventory-choice[aria-pressed="true"]:not(:disabled)',
        ) ?? this.panel.querySelector('button')
      )?.focus({ preventScroll: true });
    } else if (restoreFocus) this.canvas.focus({ preventScroll: true });
  }
  close(): void {
    this.panel.hidden = true;
    this.toggle.setAttribute('aria-expanded', 'false');
    this.pendingFocusKey = undefined;
    this.cancel();
  }
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) this.close();
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
  pickup(itemId: string, name = 'Предмет'): void {
    if (!this.canCollect) return;
    this.pendingPickup = name;
    this.session.itemAction({ kind: 'pickup', itemId });
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
    this.targetSlot = undefined;
    this.toolbar.hidden = true;
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
    const preparing = ['preparing', 'waiting'].includes(this.session.state);
    const available =
      this.enabled &&
      (this.session.state === 'playing' || preparing) &&
      !!this.session.accountId &&
      !!this.session.room;
    this.toggle.hidden = !available;
    if (!available) {
      this.panel.hidden = true;
      this.cancel();
      this.toggle.setAttribute('aria-expanded', 'false');
    }
    const busy = preparing || this.session.itemPending || this.session.worldPaused;
    this.toggle.disabled = false;
    const slots = this.session.inventory.slots;
    if (!slots.some((slot) => slot.slotId === this.activeSlot)) this.activeSlot = slots[0]?.slotId;
    if (!slots.some((slot) => slot.slotId === this.targetSlot)) this.targetSlot = undefined;
    const signature = canonicalJson({
      inventory: this.session.inventory,
      busy,
      target: this.targetSlot,
      active: this.activeSlot,
    });
    if (signature === this.signature) return;
    this.signature = signature;
    const focusKey = this.panel.contains(document.activeElement)
      ? (document.activeElement as HTMLElement).dataset.focusKey
      : undefined;
    const restorePendingFocus = document.activeElement === this.message && !!this.pendingFocusKey;
    const gridScroll = this.grid.scrollTop;
    this.panel.setAttribute('aria-busy', String(busy));
    const count = slots.reduce((total, slot) => total + slot.items.length, 0);
    this.summary.textContent = String(count);
    this.summary.setAttribute('aria-label', `Всего предметов: ${count}`);
    this.message.dataset.state = busy || this.targetSlot ? 'waiting' : 'ready';
    this.message.textContent = preparing
      ? 'Готовим окружение. Инвентарь доступен для просмотра.'
      : busy
        ? 'Ожидаем подтверждение сервера…'
        : this.targetSlot
          ? 'Выберите другую ячейку для обмена или объединения.'
          : 'Одинаковые вещи собираются в стопки.';
    this.message.hidden = !slots.length;
    this.grid.replaceChildren();
    this.details.replaceChildren();
    this.details.hidden = !slots.length;
    this.grid.classList.toggle('is-empty', !slots.length);
    if (!slots.length) {
      const empty = document.createElement('div');
      empty.className = 'inventory-empty';
      const icon = document.createElement('span');
      icon.className = 'inventory-empty-icon';
      icon.textContent = '📦';
      icon.setAttribute('aria-hidden', 'true');
      const title = document.createElement('strong');
      title.textContent = 'Здесь пока пусто';
      const hint = document.createElement('p');
      hint.textContent = 'Подойдите к предмету в мире и нажмите Z, чтобы забрать его с собой.';
      empty.append(icon, title, hint);
      this.grid.append(empty);
    }
    for (const [index, slot] of slots.entries()) {
      const item = slot.items[0],
        type = this.session.definition.itemCatalog.types[item.typeId];
      const cell = document.createElement('article');
      cell.className = 'inventory-slot';
      cell.dataset.slotId = slot.slotId;
      cell.dataset.source = String(this.targetSlot === slot.slotId);
      const choose = this.button(`${type.icon} ${type.name} × ${slot.items.length}`, () => {
        this.activeSlot = slot.slotId;
        this.update();
      });
      choose.className = 'inventory-choice';
      choose.dataset.focusKey = `slot:${slot.slotId}`;
      choose.setAttribute('aria-pressed', String(this.activeSlot === slot.slotId));
      choose.setAttribute('aria-label', choose.textContent!);
      const icon = document.createElement('span');
      icon.className = 'inventory-item-icon';
      icon.textContent = type.icon;
      icon.setAttribute('aria-hidden', 'true');
      const name = document.createElement('strong');
      name.textContent = type.name;
      const amount = document.createElement('span');
      amount.className = 'inventory-amount';
      amount.textContent = `×${slot.items.length}`;
      const number = document.createElement('span');
      number.className = 'inventory-slot-number';
      number.textContent =
        this.targetSlot === slot.slotId ? 'Откуда' : String(index + 1).padStart(2, '0');
      choose.replaceChildren(number, icon, name, amount);
      choose.disabled = busy;
      cell.append(choose);
      this.grid.append(cell);
    }
    const active = slots.find((slot) => slot.slotId === this.activeSlot);
    if (active) {
      const item = active.items[0];
      const type = this.session.definition.itemCatalog.types[item.typeId];
      const title = document.createElement('h3');
      title.textContent = type.name;
      const meta = document.createElement('p');
      meta.className = 'inventory-item-meta';
      meta.textContent = `В стопке: ${active.items.length} / ${type.maxStack} · Масса предмета: ${type.mass} кг`;
      const actions = document.createElement('div');
      actions.className = 'inventory-actions';
      this.details.append(title, meta, actions);
      if (!this.targetSlot) {
        const place = this.button('Разместить в мире', () => {
          this.selected = item;
          this.rotation = Quaternion.Identity();
          this.placementTitle.textContent = `${type.icon} ${type.name}`;
          this.open(false);
          this.toolbar.hidden = false;
          this.onPlacementChange?.(true);
        });
        place.className = 'button inventory-primary';
        actions.append(place);
        if (active.items.length > 1)
          actions.append(
            this.button('Разделить пополам', () =>
              this.session.itemAction({
                kind: 'split',
                slotId: active.slotId,
                count: Math.floor(active.items.length / 2),
              }),
            ),
          );
        const move = this.button('Переместить / объединить', () => {
          this.targetSlot = active.slotId;
          this.update();
        });
        move.disabled = slots.length < 2;
        if (move.disabled) move.title = 'Нужна ещё одна стопка в инвентаре';
        actions.append(move);
      } else {
        const source = slots.find((slot) => slot.slotId === this.targetSlot)!;
        meta.textContent =
          source === active
            ? 'Выберите ячейку назначения в сетке выше.'
            : `Из ячейки ${slots.indexOf(source) + 1} → в ячейку ${slots.indexOf(active) + 1}`;
        if (source !== active) {
          actions.append(
            this.button('Поменять местами', () => {
              const slotId = this.targetSlot!;
              this.targetSlot = undefined;
              this.session.itemAction({
                kind: 'move',
                slotId,
                targetSlotId: active.slotId,
              });
              this.update();
            }),
          );
          const merge = this.button('Объединить сюда', () => {
            const slotId = this.targetSlot!;
            this.targetSlot = undefined;
            this.session.itemAction({
              kind: 'merge',
              slotId,
              targetSlotId: active.slotId,
            });
            this.update();
          });
          const compatible = source.items.every(
            (entry) =>
              entry.typeId === item.typeId &&
              canonicalJson(entry.properties) === canonicalJson(item.properties),
          );
          merge.disabled = !compatible || active.items.length >= type.maxStack;
          merge.className = 'button inventory-primary';
          if (merge.disabled) {
            const reason = document.createElement('p');
            reason.className = 'inventory-item-meta';
            reason.textContent = compatible
              ? 'Эта стопка уже заполнена.'
              : 'Объединять можно только одинаковые предметы.';
            merge.title = reason.textContent;
            this.details.append(reason);
          }
          actions.append(merge);
        }
        actions.append(
          this.button('Отменить выбор', () => {
            this.targetSlot = undefined;
            this.update();
          }),
        );
      }
      if (busy) for (const button of actions.querySelectorAll('button')) button.disabled = true;
    }
    this.grid.scrollTop = gridScroll;
    if (!this.panel.hidden && (focusKey || restorePendingFocus)) {
      const key = focusKey ?? this.pendingFocusKey;
      const matching = Array.from(
        this.panel.querySelectorAll<HTMLButtonElement>('[data-focus-key]'),
      ).find((button) => button.dataset.focusKey === key && !button.disabled);
      if (matching) {
        this.pendingFocusKey = undefined;
        matching.focus({ preventScroll: true });
      } else if (busy) {
        this.pendingFocusKey = key;
        this.message.focus({ preventScroll: true });
      } else {
        this.pendingFocusKey = undefined;
        const choices = Array.from(this.grid.querySelectorAll<HTMLButtonElement>('button'));
        (
          choices.find(
            (button) => this.targetSlot && button.dataset.focusKey !== `slot:${this.targetSlot}`,
          ) ?? choices.find((button) => button.getAttribute('aria-pressed') === 'true')
        )?.focus({ preventScroll: true });
      }
    }
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
      ? 'Сохраняем размещение…'
      : this.valid
        ? 'Место доступно · щелчок или «Разместить»'
        : result.error === 'OUT_OF_REACH'
          ? 'Подойдите ближе · не более 3 метров'
          : 'Выберите свободную поверхность с опорой';
    if (this.placementStatus.textContent !== text) this.placementStatus.textContent = text;
    this.placementStatus.dataset.state =
      this.valid && !this.session.itemPending ? 'ready' : 'waiting';
    this.confirm.disabled = !this.valid || this.session.itemPending || this.session.worldPaused;
  }
  dispose() {
    this.cancel();
    this.controller.abort();
    this.panel.remove();
    this.toolbar.remove();
    this.toggle.remove();
  }
}
