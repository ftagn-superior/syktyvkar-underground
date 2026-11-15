import {
  REACTION_COOLDOWN_MS,
  REACTIONS,
  findReaction,
  type ReactionDefinition,
} from '@su/contracts';
import { reactionAssetUrl } from '../presentation/reaction-release';
import { CatalogFilter, CatalogShortcuts } from './catalog-shortcuts';

export interface ReactionMenuStatus {
  pending: boolean;
  remainingMs: number;
  available: boolean;
}

const RECENT_KEY = 'su:recent-reactions:v1';
const RECENT_COUNT = 4;
const known = new Set(REACTIONS.map((reaction) => reaction.id));

export function normalizeReactionSearch(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('ru')
    .replaceAll('ё', 'е')
    .trim()
    .replace(/\s+/g, ' ');
}

export function reactionSearchText(reaction: ReactionDefinition): string {
  return normalizeReactionSearch(`${reaction.label} ${reaction.id} ${reaction.category}`);
}

export function matchesReactionSearch(text: string, query: string): boolean {
  return normalizeReactionSearch(query)
    .split(' ')
    .every((word) => text.includes(word));
}

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
  private readonly search: HTMLInputElement;
  private readonly clearSearch: HTMLButtonElement;
  private readonly empty: HTMLElement;
  private readonly searchIndex = new Map<string, string>();
  private readonly filter: CatalogFilter;
  private readonly shortcuts: CatalogShortcuts;
  private recent = loadRecent();
  private sent = false;
  private wasPending = false;
  private disabled = true;
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
    this.search = panel.querySelector('#reaction-search')!;
    this.clearSearch = panel.querySelector('#reaction-search-clear')!;
    this.empty = panel.querySelector('#reactions-empty')!;
    this.search.addEventListener('input', () => this.renderList(), options);
    this.search.addEventListener(
      'keydown',
      (event) => {
        if ((event.code === 'Enter' || event.code === 'ArrowDown') && !event.isComposing) {
          event.preventDefault();
          this.choices.find((button) => !button.hidden && !button.disabled)?.focus();
        }
      },
      options,
    );
    this.clearSearch.addEventListener(
      'click',
      () => {
        this.search.value = '';
        this.renderList();
        this.search.focus();
      },
      options,
    );
    this.cooldown = panel.querySelector<HTMLProgressElement>('.reaction-cooldown')!;
    this.cooldown.max = REACTION_COOLDOWN_MS;
    this.scroll = panel.querySelector('.catalog-scroll')!;
    this.recentBlock = panel.querySelector('.catalog-recent')!;
    this.recentGrid = panel.querySelector('.reaction-recents')!;
    const grid = panel.querySelector('.reaction-choices')!;
    for (const reaction of REACTIONS) {
      const button = this.tile(reaction);
      button.classList.add('reaction-choice');
      button.dataset.reactionId = reaction.id;
      button.dataset.category = reaction.category;
      grid.append(button);
      this.choices.push(button);
      this.searchIndex.set(reaction.id, reactionSearchText(reaction));
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
  private tile(reaction: ReactionDefinition): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ui-btn';
    button.disabled = this.disabled;
    const image = document.createElement('img');
    image.src = reactionAssetUrl(reaction);
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
    const focused = document.activeElement;
    let count = 0;
    const visible: HTMLButtonElement[] = [];
    for (const button of this.choices) {
      const show =
        this.filter.matches(button.dataset.category!) &&
        matchesReactionSearch(this.searchIndex.get(button.dataset.reactionId!)!, this.search.value);
      button.hidden = !show;
      if (show) {
        count++;
        visible.push(button);
      }
    }
    this.shown.textContent = String(count);
    this.clearSearch.hidden = this.search.value.length === 0;
    this.empty.hidden = count > 0;
    const showRecent =
      this.filter.value === CatalogFilter.ALL &&
      !this.search.value.trim() &&
      this.recent.length > 0;
    this.recentBlock.hidden = !showRecent;
    if (showRecent && this.recents.map((b) => b.dataset.recentId).join() !== this.recent.join()) {
      this.recents.length = 0;
      for (const id of this.recent) {
        const button = this.tile(findReaction(id)!);
        button.classList.add('reaction-recent');
        button.dataset.recentId = id;
        this.recents.push(button);
      }
      this.recentGrid.replaceChildren(...this.recents);
    }
    this.shortcuts.bind(visible);
    this.scroll.scrollTop = 0;
    if (
      !this.panel.hidden &&
      focused instanceof HTMLButtonElement &&
      focused.classList.contains('reaction-choice') &&
      focused.hidden
    )
      (visible.find((button) => !button.disabled) ?? this.search).focus({ preventScroll: true });
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
    (this.choices.find((button) => !button.hidden && !button.disabled) ?? this.search)?.focus({
      preventScroll: true,
    });
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
    // A flood-extended wait gets its own scale so the bar still drains from full.
    if (state.remainingMs <= 0) this.cooldown.max = REACTION_COOLDOWN_MS;
    else if (state.remainingMs > this.cooldown.max) this.cooldown.max = state.remainingMs;
    this.cooldown.value = Math.max(0, state.remainingMs);
    const slowed = this.cooldown.max > REACTION_COOLDOWN_MS;
    const message = state.pending
      ? 'Отправляем…'
      : state.remainingMs > 0
        ? `${slowed ? 'Слишком часто. ' : ''}Следующая реакция через ${Math.ceil(state.remainingMs / 1000)} с`
        : 'Стикер появится над персонажем';
    if (this.status.textContent !== message) this.status.textContent = message;
    const disabled = !state.available || state.pending || state.remainingMs > 0;
    if (this.disabled !== disabled) {
      this.disabled = disabled;
      for (const button of this.choices) button.disabled = disabled;
      for (const button of this.recents) button.disabled = disabled;
    }
  }
  dispose(): void {
    this.controller.abort();
  }
}
