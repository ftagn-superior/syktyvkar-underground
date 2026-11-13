import { isTextInput } from '../input/keyboard';
import type { UiThemeController, UiThemeMode } from './ui-theme';
import type { GamepadNavigationItem } from './gamepad-navigation';
import { isChatCloseMode, type ChatSettings } from './chat-settings';

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
  private gamepad = false;
  private confirmingExit = false;
  private returnToExit = false;
  private readonly gamepadMenu = document.getElementById('gamepad-menu')!;
  private readonly gamepadActions = document.getElementById('gamepad-actions')!;
  private readonly gamepadConfirmation = document.getElementById('gamepad-exit-confirmation')!;
  private readonly resume = document.getElementById('gamepad-continue') as HTMLButtonElement;
  private readonly quality = document.getElementById('quality') as HTMLSelectElement;
  private readonly qualityButton = document.getElementById('gamepad-quality') as HTMLButtonElement;
  private readonly audio = document.getElementById('audio-toggle') as HTMLButtonElement;
  private readonly respawn = document.getElementById('respawn') as HTMLButtonElement;
  private readonly leave = document.getElementById('leave') as HTMLButtonElement;
  private readonly originalLocations: { element: HTMLElement; marker: Comment }[] = [];
  onGamepadClose?: () => void;
  onGamepadContinue?: () => void;

  constructor(
    private readonly focusWorld: () => void,
    private readonly onOpen?: () => void,
    theme?: UiThemeController,
    chat?: ChatSettings,
  ) {
    const options = { signal: this.controller.signal };
    for (const element of [this.audio, this.respawn, this.leave]) {
      const marker = document.createComment('desktop control position');
      element.before(marker);
      this.originalLocations.push({ element, marker });
    }
    this.resume.addEventListener(
      'click',
      () => {
        if (!this.gamepad || this.resume.disabled) return;
        this.onGamepadContinue?.();
        this.close(false);
      },
      options,
    );
    document.getElementById('gamepad-exit')!.addEventListener(
      'click',
      () => {
        this.confirmingExit = true;
        this.renderGamepad();
      },
      options,
    );
    document
      .getElementById('gamepad-stay')!
      .addEventListener('click', () => this.cancelExit(), options);
    this.respawn.addEventListener(
      'click',
      () => {
        if (this.gamepad && !this.respawn.disabled) this.close(false);
      },
      options,
    );
    this.quality.addEventListener('change', () => this.renderQuality(), options);
    if (chat) {
      const buttons = Array.from(
        this.panel.querySelectorAll<HTMLButtonElement>('[data-chat-close]'),
      );
      const render = () => {
        for (const button of buttons)
          button.setAttribute('aria-pressed', String(button.dataset.chatClose === chat.closeMode));
      };
      for (const button of buttons)
        button.addEventListener(
          'click',
          () => {
            const mode = button.dataset.chatClose;
            if (isChatCloseMode(mode)) chat.setCloseMode(mode);
          },
          options,
        );
      const unsubscribe = chat.onChange(render);
      this.controller.signal.addEventListener('abort', unsubscribe);
      render();
    }
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
        if (this.gamepad || !this.available || event.repeat || isTextInput(event.target)) return;
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
  get gamepadContext(): 'menu' | 'confirm-exit' {
    return this.confirmingExit ? 'confirm-exit' : 'menu';
  }
  /** The caller uses this once after cancelling the confirmation. */
  get gamepadPreferredId(): string | undefined {
    const id = this.returnToExit ? 'exit' : undefined;
    this.returnToExit = false;
    return id;
  }
  setGamepad(enabled: boolean): void {
    if (this.gamepad === enabled) return;
    this.gamepad = enabled;
    document.querySelector<HTMLDetailsElement>('.xbox-preparation')!.open = enabled;
    this.confirmingExit = false;
    this.returnToExit = false;
    if (enabled) {
      this.gamepadActions.insertBefore(this.audio, this.qualityButton);
      this.gamepadActions.insertBefore(
        this.respawn,
        document.getElementById('gamepad-respawn-reason'),
      );
      this.respawn.setAttribute('aria-describedby', 'gamepad-respawn-reason');
      this.gamepadConfirmation.append(this.leave);
      this.leave.textContent = 'A · Выйти';
      this.hideTip();
    } else {
      for (const { element, marker } of this.originalLocations) marker.after(element);
      this.respawn.removeAttribute('aria-describedby');
      this.leave.textContent = 'Выйти';
    }
    this.panel.classList.toggle('gamepad-help', enabled);
    this.gamepadMenu.hidden = !enabled;
    this.renderGamepad();
  }
  syncGamepad({
    resumeEnabled,
    respawnReason,
  }: {
    resumeEnabled: boolean;
    respawnReason?: string;
  }): void {
    if (!this.gamepad) return;
    this.resume.disabled = !resumeEnabled;
    document.getElementById('gamepad-continue-reason')!.textContent = resumeEnabled
      ? ''
      : 'Ожидаем готовности мира';
    this.respawn.hidden = false;
    this.leave.hidden = false;
    const reason = document.getElementById('gamepad-respawn-reason')!;
    reason.textContent = this.respawn.disabled
      ? (respawnReason ??
        (this.respawn.getAttribute('aria-busy') === 'true'
          ? 'Ожидаем ответ сервера'
          : this.respawn.textContent?.includes(' с')
            ? 'Повторный возврат доступен после отсчёта'
            : 'Ожидаем готовности мира'))
      : '';
    this.renderQuality();
  }
  gamepadItems(): GamepadNavigationItem[] {
    if (this.confirmingExit)
      return [
        { id: 'stay', element: document.getElementById('gamepad-stay')! },
        { id: 'confirm-exit', element: this.leave },
      ];
    return [
      { id: 'continue', element: this.resume },
      { id: 'audio', element: this.audio },
      {
        id: 'quality',
        element: this.qualityButton,
        activate: () => {},
        adjust: (direction) => {
          const value = direction < 0 ? 'economy' : 'standard';
          if (this.quality.value === value) return;
          this.quality.value = value;
          this.quality.dispatchEvent(new Event('change', { bubbles: true }));
        },
      },
      { id: 'respawn', element: this.respawn },
      { id: 'exit', element: document.getElementById('gamepad-exit')! },
    ];
  }
  handleGamepadBack(button: 'b' | 'y'): void {
    if (!this.gamepad || !this.isOpen) return;
    if (this.confirmingExit) {
      if (button === 'b') this.cancelExit();
    } else this.close(false);
  }
  /** Called when the player enters or leaves the world. */
  setAvailable(available: boolean): void {
    if (this.available === available) return;
    this.available = available;
    if (!available) {
      this.close(false);
      this.hideTip();
    } else if (!this.gamepad) this.showTipOnce();
  }
  open(open: boolean): void {
    if (open && !this.available) return;
    const wasOpen = this.isOpen;
    this.panel.hidden = !open;
    this.toggle.setAttribute('aria-expanded', String(open));
    if (open) {
      if (!wasOpen) {
        this.confirmingExit = false;
        this.returnToExit = false;
        this.renderGamepad();
      }
      this.hideTip();
      this.onOpen?.();
    }
    if (!open && wasOpen && this.gamepad) this.onGamepadClose?.();
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
  private cancelExit(): void {
    this.confirmingExit = false;
    this.returnToExit = true;
    this.renderGamepad();
  }
  private renderQuality(): void {
    this.qualityButton.textContent = `Качество графики · ← ${this.quality.value === 'economy' ? 'Экономное' : 'Обычное'} →`;
  }
  private renderGamepad(): void {
    this.gamepadActions.hidden = this.confirmingExit;
    this.gamepadConfirmation.hidden = !this.confirmingExit;
    document.getElementById('gamepad-menu-controls')!.textContent = this.confirmingExit
      ? '↑↓ Выбрать · A Подтвердить · B Остаться'
      : '↑↓ Выбрать · A Подтвердить · ←→ Качество · B / Y Закрыть';
    this.renderQuality();
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
