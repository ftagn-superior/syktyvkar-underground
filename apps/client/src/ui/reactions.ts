import { REACTIONS, WORLD_ACTIVITY_MOVE_DURATION_MS } from '@su/contracts';
import { CatalogFilter, CatalogShortcuts } from './catalog-shortcuts';

export interface ReactionMenuStatus {
  pending: boolean;
  remainingMs: number;
  available: boolean;
}

const RECENT_KEY = 'su:recent-reactions:v1';
const RECENT_COUNT = 4;
const known = new Set(REACTIONS.map((reaction) => reaction.id));

/** Last used reactions, newest first; ids outside the catalog are dropped. */
export function rememberRecent(recent: readonly string[], id: string): string[] {
  return [id, ...recent.filter((other) => other !== id)]
    .filter((other) => known.has(other))
    .slice(0, RECENT_COUNT);
}
function loadRecent(): string[] {
  try {
    const stored = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    if (Array.isArray(stored))
      return stored
        .filter((id): id is string => typeof id === 'string' && known.has(id))
        .slice(0, RECENT_COUNT);
  } catch {
    /* Недавние — необязательное удобство. */
  }
  return [];
}

/**
 * Окно реакций над строкой чата: фильтр по категориям, прокручиваемая сетка и строка «Недавние».
 * Движение в мире при открытом окне не отключается.
 */
export class ReactionMenu {
  private available = false;
  private readonly choices: HTMLButtonElement[] = [];
  private readonly recents: HTMLButtonElement[] = [];
  private readonly controller = new AbortController();
  private readonly cooldown: HTMLProgressElement;
  private readonly scroll: HTMLElement;
  private readonly recentBlock: HTMLElement;
  private readonly recentGrid: HTMLElement;
  private readonly shown: HTMLElement;
  private readonly filter: CatalogFilter;
  private readonly shortcuts: CatalogShortcuts;
  private recent = loadRecent();
  private sent = false;
  private wasPending = false;
  constructor(
    private readonly toggle: HTMLButtonElement,
    private readonly panel: HTMLElement,
    private readonly status: HTMLElement,
    private readonly canvas: HTMLCanvasElement,
    private readonly choose: (id: string) => void,
    private readonly onOpen?: () => void,
  ) {
    const options = { signal: this.controller.signal };
    panel.querySelector('[data-catalog-count]')!.textContent = String(REACTIONS.length);
    this.shown = panel.querySelector('[data-catalog-shown]')!;
    this.cooldown = panel.querySelector<HTMLProgressElement>('.reaction-cooldown')!;
    this.cooldown.max = WORLD_ACTIVITY_MOVE_DURATION_MS;
    this.scroll = panel.querySelector('.catalog-scroll')!;
    this.recentBlock = panel.querySelector('.catalog-recent')!;
    this.recentGrid = panel.querySelector('.reaction-recents')!;
    const grid = panel.querySelector('.reaction-choices')!;
    for (const reaction of REACTIONS) {
      const button = this.tile(reaction.id);
      button.classList.add('reaction-choice');
      button.dataset.reactionId = reaction.id;
      button.dataset.category = reaction.category;
      grid.append(button);
      this.choices.push(button);
    }
    this.shortcuts = new CatalogShortcuts(() => !panel.hidden, this.controller.signal);
    this.filter = new CatalogFilter(
      panel.querySelector('.filters')!,
      REACTIONS.map((reaction) => reaction.category),
      () => this.renderList(),
      this.controller.signal,
    );
    toggle.addEventListener('click', () => this.toggleOpen(), options);
    window.addEventListener(
      'keydown',
      (event) => {
        if (event.code === 'Escape' && !panel.hidden) {
          event.preventDefault();
          this.close();
        }
      },
      options,
    );
    window.addEventListener(
      'pointerdown',
      (event) => {
        if (
          !panel.hidden &&
          event.target instanceof Node &&
          !panel.contains(event.target) &&
          !toggle.contains(event.target)
        )
          this.close(false);
      },
      options,
    );
    this.renderList();
  }
  private tile(id: string): HTMLButtonElement {
    const reaction = REACTIONS.find((entry) => entry.id === id)!;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ui-btn';
    const image = document.createElement('img');
    image.src = `/reactions/${reaction.asset}`;
    image.alt = '';
    image.width = image.height = 32;
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = reaction.label;
    button.append(image, label);
    button.addEventListener(
      'click',
      () => {
        if (!this.available || button.disabled) return;
        this.sent = true;
        this.recent = rememberRecent(this.recent, reaction.id);
        try {
          localStorage.setItem(RECENT_KEY, JSON.stringify(this.recent));
        } catch {
          /* Недавние живут до перезагрузки. */
        }
        this.choose(reaction.id);
      },
      { signal: this.controller.signal },
    );
    return button;
  }
  private renderList(): void {
    let count = 0;
    const visible: HTMLButtonElement[] = [];
    for (const button of this.choices) {
      const show = this.filter.matches(button.dataset.category!);
      button.hidden = !show;
      if (show) {
        count++;
        visible.push(button);
      }
    }
    this.shown.textContent = String(count);
    const showRecent = this.filter.value === CatalogFilter.ALL && this.recent.length > 0;
    this.recentBlock.hidden = !showRecent;
    if (showRecent && this.recents.map((b) => b.dataset.recentId).join() !== this.recent.join()) {
      this.recents.length = 0;
      for (const id of this.recent) {
        const button = this.tile(id);
        button.classList.add('reaction-recent');
        button.dataset.recentId = id;
        button.disabled = this.choices[0]?.disabled ?? false;
        this.recents.push(button);
      }
      this.recentGrid.replaceChildren(...this.recents);
    }
    this.shortcuts.bind(visible);
    this.scroll.scrollTop = 0;
  }
  toggleOpen(): void {
    if (this.toggle.hidden || this.toggle.disabled) return;
    if (!this.panel.hidden) return this.close();
    this.onOpen?.();
    this.renderList();
    this.panel.hidden = false;
    // A hidden element cannot scroll: reset once the list is laid out.
    this.scroll.scrollTop = 0;
    this.toggle.setAttribute('aria-expanded', 'true');
    (
      this.choices.find((button) => !button.hidden && !button.disabled) ??
      this.panel.querySelector<HTMLButtonElement>('.filters button')
    )?.focus({ preventScroll: true });
  }
  close(restoreFocus = true): void {
    const wasOpen = !this.panel.hidden;
    this.panel.hidden = true;
    this.toggle.setAttribute('aria-expanded', 'false');
    if (wasOpen && restoreFocus) this.canvas.focus({ preventScroll: true });
  }
  update(state: ReactionMenuStatus): void {
    this.available = state.available;
    this.toggle.hidden = !state.available;
    if (!state.available) this.close(false);
    // Confirmation is reflected by the server cooldown. A rejected request leaves the picker open.
    if (this.sent && this.wasPending && !state.pending) {
      if (state.remainingMs > 0) this.close();
      this.sent = false;
    }
    this.wasPending = state.pending;
    this.toggle.setAttribute('aria-busy', String(state.pending));
    this.panel.setAttribute('aria-busy', String(state.pending));
    this.status.dataset.state = state.pending || state.remainingMs > 0 ? 'waiting' : 'ready';
    this.cooldown.hidden = state.remainingMs <= 0;
    this.cooldown.value = Math.max(0, state.remainingMs);
    const message = state.pending
      ? 'Отправляем…'
      : state.remainingMs > 0
        ? `Следующая реакция через ${Math.ceil(state.remainingMs / 1000)} с`
        : 'Стикер появится над персонажем';
    if (this.status.textContent !== message) this.status.textContent = message;
    const disabled = !state.available || state.pending || state.remainingMs > 0;
    for (const button of [...this.choices, ...this.recents]) button.disabled = disabled;
  }
  dispose(): void {
    this.controller.abort();
  }
}
