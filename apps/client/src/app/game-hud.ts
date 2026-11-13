import type { ConnectionState } from '../network/session';
import type { InputMode } from '../input/mode';
import type { ElementLookup } from './dom';

interface ConnectionPresentation {
  state: ConnectionState;
  graphicsLost: boolean;
  roomPresent: boolean;
  accountBusy: boolean;
  guestEntry: boolean;
  reloadRequired: boolean;
  worldAvailable?: boolean;
}

/** Renders the fixed HUD shell; input and session transitions belong to the application. */
export class GameHud {
  private disposed = false;
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly notice: HTMLElement;
  private readonly welcome: HTMLElement;
  private readonly join: HTMLButtonElement;
  private readonly joinLabel: HTMLElement;
  private readonly status: HTMLElement;
  private readonly statusDot: HTMLElement;
  private readonly respawn: HTMLButtonElement;
  private readonly respawnLabel: HTMLElement;
  private readonly leave: HTMLButtonElement;

  constructor(private readonly element: ElementLookup) {
    this.notice = element('notice');
    this.welcome = element('welcome');
    this.join = element('join');
    this.joinLabel = element('join-label');
    this.status = element('connection-status');
    this.statusDot = element('status-dot');
    this.respawn = element('respawn');
    this.respawnLabel = element('respawn-label');
    this.leave = element('leave');
  }

  renderConnection({
    state,
    graphicsLost,
    roomPresent,
    accountBusy,
    guestEntry,
    reloadRequired,
    worldAvailable,
  }: ConnectionPresentation): void {
    const playing = state === 'playing';
    const reconnecting = state === 'reconnecting';
    const preparing = state === 'preparing' || state === 'waiting';
    this.welcome.hidden = graphicsLost || playing || ((reconnecting || preparing) && roomPresent);
    document.body.dataset.scene = this.welcome.hidden ? 'world' : 'lobby';
    this.join.disabled =
      graphicsLost ||
      accountBusy ||
      state === 'loading' ||
      state === 'connecting' ||
      preparing ||
      reconnecting;
    this.joinLabel.textContent =
      state === 'loading'
        ? 'Загружаем мир…'
        : state === 'connecting'
          ? 'Входим на полигон…'
          : reconnecting
            ? 'Восстанавливаем связь…'
            : reloadRequired
              ? 'Перезагрузить страницу'
              : state === 'error'
                ? 'Повторить загрузку'
                : guestEntry
                  ? 'Войти гостем'
                  : 'Войти в мир';
    this.status.textContent = {
      loading: 'Загрузка',
      ready: reloadRequired
        ? 'Нужно обновление'
        : worldAvailable === false
          ? 'Мир заполнен'
          : 'Мир доступен',
      connecting: 'Подключение',
      playing: 'В сети',
      preparing: 'Подготовка окружения',
      waiting: 'Загрузка окружения',
      reconnecting: 'Восстановление',
      error: 'Нет соединения',
    }[state];
    if (graphicsLost) this.status.textContent = 'Графика недоступна';
    this.statusDot.dataset.online = String(!graphicsLost && (playing || state === 'ready'));
    document.body.classList.toggle('connection-lost', reconnecting);
    this.respawn.hidden = !playing;
    this.leave.hidden = !roomPresent && !reconnecting;
  }
  renderControls({
    placement,
    firstPerson,
    mode,
  }: {
    placement?: 'inventory' | 'static';
    firstPerson: boolean;
    mode: InputMode;
  }): void {
    const placing = !!placement;
    this.element('overview-camera-controls').hidden = firstPerson;
    this.element('first-person-camera-controls').hidden = !firstPerson;
    this.element('controls-title').textContent = placing
      ? placement === 'static'
        ? 'Размещение скамейки'
        : 'Поворот предмета'
      : firstPerson
        ? 'От первого лица'
        : 'Свободное движение';
    this.element('controls-description').textContent = placing
      ? placement === 'static'
        ? 'A / D — поворот на 15° · колесо — масштаб'
        : 'W / S — наклон · A / D — поворот · Q / E — крен'
      : firstPerson
        ? 'WASD / стрелки — ходьба и боковые шаги · мышь — взгляд · Shift — бег · T — чат · V — обзор'
        : mode === 'touch'
          ? 'Стик слева — ходьба · свайп справа — камера'
          : 'WASD / стрелки · Shift — быстрый бег · удерживайте Q / E или тяните ПКМ — камера';
  }
  renderFirstPerson({
    selected,
    pending,
    locked,
    eligible,
  }: {
    selected: boolean;
    pending: boolean;
    locked: boolean;
    eligible: boolean;
  }): void {
    this.element<HTMLButtonElement>('view-toggle').disabled = !selected && !pending && !eligible;
    this.element('view-toggle-label').textContent = selected
      ? 'Обзор'
      : pending
        ? 'Отменить вход'
        : 'От первого лица';
    this.element('first-person-hud').hidden = !selected && !pending;
    this.element('first-person-hint').hidden = locked;
    this.element('first-person-hint').textContent = pending
      ? 'Ожидаем захват мыши…'
      : 'Щёлкните по миру, чтобы продолжить · Esc — курсор';
    this.element('first-person-actions').hidden = !selected;
  }
  renderRespawn(
    { pending, remainingMs }: { pending: boolean; remainingMs: number },
    enabled: boolean,
  ): void {
    this.respawn.disabled = !enabled || pending || remainingMs > 0;
    this.respawn.setAttribute('aria-busy', String(pending));
    this.respawnLabel.textContent = pending
      ? 'Возвращаем…'
      : remainingMs > 0
        ? `На старт · ${Math.ceil(remainingMs / 1000)} с`
        : 'На старт';
  }
  readonly showNotice = (message: string, options: { toast?: { hint?: string } } = {}): void => {
    if (this.disposed) return;
    const text = document.createElement('span');
    text.textContent = message;
    const parts: Node[] = [];
    if (options.toast) {
      // Pickup feedback: hexagon icon + text + the key that opens the result.
      const icon = document.createElement('span');
      icon.className = 'ic';
      icon.setAttribute('aria-hidden', 'true');
      icon.innerHTML =
        '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3 20 7.5v9L12 21l-8-4.5v-9Z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9"/></svg>';
      parts.push(icon);
    }
    parts.push(text);
    if (options.toast?.hint) {
      const hint = document.createElement('span');
      hint.className = 'muted';
      const key = document.createElement('kbd');
      key.className = 'su-kbd';
      key.textContent = options.toast.hint;
      hint.append(key, 'открыть');
      parts.push(hint);
    }
    this.notice.replaceChildren(...parts);
    // Re-trigger the slide-up for each new message.
    this.notice.hidden = true;
    void this.notice.offsetWidth;
    this.notice.hidden = false;
    clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(
      () => {
        this.notice.hidden = true;
      },
      options.toast ? 2800 : 7000,
    );
  };
  dispose(): void {
    this.disposed = true;
    clearTimeout(this.noticeTimer);
  }
}
