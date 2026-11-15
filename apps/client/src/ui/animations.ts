import {
  ANIMATIONS,
  AVATAR_SKINS,
  type AnimationId,
  type AvatarSkinId,
  type AnimationDefinition,
  type SimulationConfig,
} from '@su/contracts';
import type { GameSession } from '../network/session';
import { CatalogFilter, CatalogShortcuts } from './catalog-shortcuts';
import { CharacterPreview } from './character-preview';
import { matchesAnimationSearch } from './animation-search';
type Status = ReturnType<GameSession['animationStatus']>;

/** Окно анимаций над строкой чата: фильтр по категориям и прокручиваемый список названий. */
export class AnimationMenu {
  private available = false;
  private readonly controller = new AbortController();
  private readonly choices: {
    button: HTMLButtonElement;
    hint: HTMLElement;
    fullBody: boolean;
    category: string;
    definition: AnimationDefinition;
  }[] = [];
  private readonly scroll: HTMLElement;
  private readonly shown: HTMLElement;
  private readonly filter: CatalogFilter;
  private readonly shortcuts: CatalogShortcuts;
  private accepted = 0;
  private current?: Status;
  private preview?: CharacterPreview;
  private readonly search: HTMLInputElement;
  private readonly previewDetails: HTMLDetailsElement;
  private readonly previewClip: HTMLSelectElement;
  private readonly previewSkin: HTMLSelectElement;
  private readonly previewReduced: HTMLInputElement;
  constructor(
    private readonly toggle: HTMLButtonElement,
    private readonly panel: HTMLElement,
    private readonly status: HTMLElement,
    private readonly canvas: HTMLCanvasElement,
    choose: (id: AnimationId) => void,
    private readonly onOpen: () => void,
    private readonly previewConfig: () =>
      { character: SimulationConfig['character']; skinId: AvatarSkinId; color: string } | undefined,
  ) {
    const options = { signal: this.controller.signal };
    this.search = panel.querySelector('#animation-search')!;
    this.previewDetails = panel.querySelector('#animation-preview')!;
    this.previewClip = panel.querySelector('#animation-preview-clip')!;
    this.previewSkin = panel.querySelector('#animation-preview-skin')!;
    this.previewReduced = panel.querySelector('#animation-preview-reduced')!;
    this.previewReduced.checked = matchMedia('(prefers-reduced-motion: reduce)').matches;
    for (const skin of AVATAR_SKINS) this.previewSkin.add(new Option(skin.label, skin.id));
    for (const animation of ANIMATIONS)
      this.previewClip.add(new Option(animation.label, animation.id));
    this.search.addEventListener('input', () => this.renderList(), options);
    this.search.addEventListener(
      'keydown',
      (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          this.choices.find(({ button }) => !button.hidden && !button.disabled)?.button.focus();
        }
      },
      options,
    );
    this.previewDetails.addEventListener('toggle', () => this.syncPreview(), options);
    this.previewClip.addEventListener(
      'change',
      () => {
        this.preview?.setAnimation(this.previewClip.value as AnimationId);
      },
      options,
    );
    this.previewSkin.addEventListener(
      'change',
      () => {
        this.preview?.setSkin(this.previewSkin.value as AvatarSkinId);
        this.previewNote();
      },
      options,
    );
    this.previewReduced.addEventListener(
      'change',
      () => this.preview?.setReducedMotion(this.previewReduced.checked),
      options,
    );
    panel.querySelector('[data-catalog-count]')!.textContent = String(ANIMATIONS.length);
    this.shown = panel.querySelector('[data-catalog-shown]')!;
    this.scroll = panel.querySelector('.catalog-scroll')!;
    const list = panel.querySelector('.animation-choices')!;
    for (const animation of ANIMATIONS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ui-btn animation-choice';
      button.dataset.animationId = animation.id;
      const title = document.createElement('span');
      title.textContent = animation.label;
      const description = document.createElement('span');
      description.className = 'animation-description';
      description.textContent =
        animation.mode === 'upperBody' ? 'Жест · можно на ходу' : 'Всё тело · старт в покое';
      const hint = document.createElement('span');
      hint.className = 'animation-hint';
      hint.id = `animation-hint-${animation.id}`;
      button.setAttribute('aria-describedby', hint.id);
      button.append(title, description, hint);
      button.addEventListener(
        'focus',
        () => {
          this.previewClip.value = animation.id;
          this.preview?.setAnimation(animation.id);
        },
        options,
      );
      button.addEventListener(
        'click',
        () => {
          if (this.available && !button.disabled) choose(animation.id);
        },
        options,
      );
      list.append(button);
      this.choices.push({
        button,
        hint,
        fullBody: animation.mode === 'fullBody',
        category: animation.category,
        definition: animation,
      });
    }
    this.shortcuts = new CatalogShortcuts(() => !panel.hidden, this.controller.signal);
    this.filter = new CatalogFilter(
      panel.querySelector('.filters')!,
      ANIMATIONS.map((animation) => animation.category),
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
  private renderList(): void {
    const visible: HTMLButtonElement[] = [];
    for (const { button, category, definition } of this.choices) {
      button.hidden =
        !this.filter.matches(category) || !matchesAnimationSearch(definition, this.search.value);
      if (!button.hidden) visible.push(button);
    }
    this.shown.textContent = String(visible.length);
    this.panel.querySelector<HTMLElement>('#animation-empty')!.hidden = visible.length > 0;
    this.shortcuts.bind(visible);
    this.scroll.scrollTop = 0;
    this.panel.scrollTop = 0;
    if (this.current && !this.panel.hidden) this.renderStatus(this.current);
  }
  toggleOpen(): void {
    if (this.toggle.hidden || this.toggle.disabled) return;
    if (!this.panel.hidden) return this.close();
    this.onOpen();
    this.renderList();
    this.panel.hidden = false;
    this.panel.scrollTop = 0;
    if (this.current) this.renderStatus(this.current);
    // A hidden element cannot scroll: reset once the list is laid out.
    this.scroll.scrollTop = 0;
    this.toggle.setAttribute('aria-expanded', 'true');
    (
      this.choices.find(({ button }) => !button.hidden && !button.disabled)?.button ??
      this.panel.querySelector<HTMLButtonElement>('.filters button')
    )?.focus({ preventScroll: true });
    if (!this.previewSkin.dataset.initialized) {
      this.previewSkin.value = this.previewConfig()?.skinId ?? 'minifigure';
      this.previewSkin.dataset.initialized = 'true';
    }
    this.syncPreview();
  }
  close(restoreFocus = true): void {
    const open = !this.panel.hidden;
    this.panel.hidden = true;
    this.preview?.dispose();
    this.preview = undefined;
    this.toggle.setAttribute('aria-expanded', 'false');
    if (open && restoreFocus) this.canvas.focus({ preventScroll: true });
  }
  /** Prediction resync can disable network actions while the local preview remains usable. */
  update(state: Status, canBrowse = state.available): void {
    this.current = state;
    this.available = state.available;
    this.toggle.hidden = !canBrowse;
    if (!canBrowse) this.close(false);
    if (state.accepted !== this.accepted) {
      this.accepted = state.accepted;
      this.close();
    }
    this.toggle.setAttribute('aria-busy', String(state.pending));
    this.panel.setAttribute('aria-busy', String(state.pending));
    if (this.panel.hidden) return;
    this.renderStatus(state);
  }
  private renderStatus(state: Status): void {
    this.status.dataset.state =
      state.pending || state.paused || state.busy || !state.grounded || state.message
        ? 'waiting'
        : 'ready';
    const message =
      state.message ||
      (!state.available
        ? 'Ждём готовности персонажа. Предпросмотр доступен.'
        : state.pending
          ? 'Ожидаем подтверждение сервера…'
          : state.paused
            ? 'Мир приостановлен.'
            : state.busy
              ? 'Дождитесь, прежде чем выбрать другую анимацию.'
              : !state.grounded
                ? 'Дождитесь опоры'
                : 'Выберите анимацию');
    if (this.status.textContent !== message) this.status.textContent = message;
    for (const { button, hint, fullBody } of this.choices) {
      if (button.hidden) continue;
      const reason = !state.grounded
        ? 'Дождитесь опоры'
        : fullBody && state.moving
          ? 'Остановитесь, чтобы начать'
          : '';
      if (hint.textContent !== reason) hint.textContent = reason;
      button.disabled = !state.available || state.pending || state.busy || state.paused || !!reason;
    }
  }
  private previewNote(): void {
    this.panel.querySelector('#animation-preview-note')!.textContent =
      this.previewSkin.value === 'bear-wheelchair'
        ? 'Сидячий вариант: ноги и высота посадки неподвижны, наклоны корпуса уменьшены.'
        : 'В покое клип повторяется; в мире первое движение запускает завершение через 5 секунд.';
  }
  private syncPreview(): void {
    if (this.panel.hidden || !this.previewDetails.open) {
      this.preview?.dispose();
      this.preview = undefined;
      return;
    }
    const config = this.previewConfig();
    if (!config) return;
    try {
      this.preview ??= new CharacterPreview(
        this.panel.querySelector('#animation-preview-canvas')!,
        config.character,
        this.previewSkin.value as AvatarSkinId,
        config.color,
      );
      this.preview.setAnimation(this.previewClip.value as AnimationId);
      this.preview.setReducedMotion(this.previewReduced.checked);
      this.preview.resize();
      this.previewNote();
    } catch {
      this.preview?.dispose();
      this.preview = undefined;
      this.panel.querySelector('#animation-preview-note')!.textContent =
        'Предпросмотр недоступен. Выбор анимации в мире продолжает работать.';
    }
  }
  dispose(): void {
    this.preview?.dispose();
    this.controller.abort();
  }
}
