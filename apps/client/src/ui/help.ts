import { isTextInput } from '../input/keyboard';
import type { UiThemeController, UiThemeMode } from './ui-theme';

const TIP_KEY = 'su:help-tip:v1';
const TIP_MS = 9000;

/** Кнопка «?» без цвета: вход в управление и настройки, включая тему интерфейса. */
export class HelpMenu {
  private readonly toggle = document.getElementById('help-toggle') as HTMLButtonElement;
  private readonly panel = document.getElementById('help-panel')!;
  private readonly tip = document.getElementById('help-tip')!;
  private readonly controller = new AbortController();
  private tipTimer?: ReturnType<typeof setTimeout>;
  private available = false;

  constructor(
    private readonly focusWorld: () => void,
    private readonly onOpen?: () => void,
    theme?: UiThemeController,
  ) {
    const options = { signal: this.controller.signal };
    if (theme) {
      const buttons = Array.from(
        this.panel.querySelectorAll<HTMLButtonElement>('[data-theme-mode]'),
      );
      const render = () => {
        for (const button of buttons)
          button.setAttribute('aria-pressed', String(button.dataset.themeMode === theme.mode));
      };
      for (const button of buttons)
        button.addEventListener(
          'click',
          () => theme.setMode(button.dataset.themeMode as UiThemeMode),
          options,
        );
      const unsubscribe = theme.onModeChange(render);
      this.controller.signal.addEventListener('abort', unsubscribe);
      render();
    }
    this.toggle.addEventListener('click', () => this.open(this.panel.hidden), options);
    document
      .getElementById('help-close')!
      .addEventListener('click', () => this.close(true), options);
    document
      .getElementById('help-tip-ok')!
      .addEventListener('click', () => this.hideTip(), options);
    window.addEventListener(
      'keydown',
      (event) => {
        if (!this.available || event.repeat || isTextInput(event.target)) return;
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        if (event.code === 'KeyH') {
          event.preventDefault();
          this.open(this.panel.hidden);
        } else if (event.code === 'Escape' && !this.panel.hidden) {
          event.preventDefault();
          this.close(true);
        }
      },
      options,
    );
  }
  get isOpen(): boolean {
    return !this.panel.hidden;
  }
  /** Called when the player enters or leaves the world. */
  setAvailable(available: boolean): void {
    if (this.available === available) return;
    this.available = available;
    if (!available) {
      this.close(false);
      this.hideTip();
    } else this.showTipOnce();
  }
  open(open: boolean): void {
    if (open && !this.available) return;
    this.panel.hidden = !open;
    this.toggle.setAttribute('aria-expanded', String(open));
    if (open) {
      this.hideTip();
      this.onOpen?.();
    }
  }
  close(restoreFocus: boolean): void {
    const hadFocus = this.panel.contains(document.activeElement);
    this.open(false);
    if (restoreFocus) hadFocus ? this.toggle.focus({ preventScroll: true }) : this.focusWorld();
  }
  /** Movement means the player has found their way around: dismiss the first-time tip. */
  noteMovement(): void {
    if (!this.tip.hidden) this.hideTip();
  }
  private showTipOnce(): void {
    try {
      if (localStorage.getItem(TIP_KEY)) return;
      localStorage.setItem(TIP_KEY, '1');
    } catch {
      /* Without storage the tip simply shows on every entry. */
    }
    this.tip.hidden = false;
    clearTimeout(this.tipTimer);
    this.tipTimer = setTimeout(() => this.hideTip(), TIP_MS);
  }
  private hideTip(): void {
    clearTimeout(this.tipTimer);
    this.tip.hidden = true;
  }
  dispose(): void {
    clearTimeout(this.tipTimer);
    this.controller.abort();
  }
}
