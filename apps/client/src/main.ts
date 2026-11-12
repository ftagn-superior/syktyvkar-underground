import './style.css';
import './ui/theme.css';
import './ui/lobby.css';
import './ui/hud.css';
import { HelpMenu } from './ui/help';
import { InteractionSystem } from './interaction/prompt';
import { PickupSource } from './interaction/pickups';
import { applyAccent } from './ui/theme';
import { CharacterPreview } from './ui/character-preview';
import { Engine } from '@babylonjs/core/Engines/engine';
import { KeyboardInput } from './input/keyboard';
import { CameraPointerInput } from './input/camera-pointer';
import { GameInputMode } from './input/mode';
import { TouchInput } from './input/touch';
import { GameSession, readableError, type ConnectionState } from './network/session';
import { WorldView } from './rendering/world-view';
import type { RenderQuality } from './rendering/render-quality';
import { diagnosticReport, downloadDiagnosticReport } from './ui/diagnostic-report';
import { ReactionMenu } from './ui/reactions';
import { AnimationMenu } from './ui/animations';
import { ChatConsole } from './ui/chat';
import { InventoryPanel } from './ui/inventory';
import { AccountPanel } from './ui/account-panel';
import { bindTouchButtons } from './ui/touch-buttons';

function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing UI: ${id}`);
  return node as T;
}
const canvas = element<HTMLCanvasElement>('world');
const stick = element('touch-stick');
const welcome = element('welcome');
const join = element<HTMLButtonElement>('join');
const joinLabel = element('join-label');
const respawn = element<HTMLButtonElement>('respawn');
const respawnLabel = element('respawn-label');
const leave = element<HTMLButtonElement>('leave');
const notice = element('notice');
const status = element('connection-status');
const statusDot = element('status-dot');
const diagnostics = element('diagnostics');
const metrics = element('metrics');
const diagnosticsToggle = element<HTMLButtonElement>('diagnostics-toggle');
const qualitySelect = element<HTMLSelectElement>('quality');
const graphicsRecovery = element('graphics-recovery');
const graphicsReload = element<HTMLButtonElement>('graphics-reload');
const unbindTouchButtons = bindTouchButtons([
  join,
  respawn,
  leave,
  graphicsReload,
  diagnosticsToggle,
  element<HTMLButtonElement>('area-retry'),
  element<HTMLButtonElement>('download-report'),
]);
const qualityStorageKey = 'su:render-quality:v1';
let quality: RenderQuality = 'standard';
try {
  if (localStorage.getItem(qualityStorageKey) === 'economy') quality = 'economy';
} catch {
  /* Graphics preferences are optional when storage is disabled. */
}
qualitySelect.value = quality;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
let view: WorldView | undefined;
let loaded = false;
let starting = false;
let keyboard: KeyboardInput;
let cameraPointer: CameraPointerInput | undefined;
let graphicsLost = false;
let previousConnection: ConnectionState = 'loading';
let pageActive = !document.hidden;
let touch: TouchInput | undefined;
let reactions: ReactionMenu | undefined;
let animations: AnimationMenu | undefined;
let chat: ChatConsole | undefined;
let inventory: InventoryPanel | undefined;
let preview: CharacterPreview | undefined;
let help: HelpMenu | undefined;
let interactions: InteractionSystem | undefined;
let appliedAccent = '';
const previewCanvas = element<HTMLCanvasElement>('preview-canvas');
const previewFallback = element<HTMLImageElement>('preview-fallback');

function setAccent(hex: string): void {
  if (hex === appliedAccent) return;
  appliedAccent = hex;
  applyAccent(hex);
}
/** The lobby shows the real model in a private scene; it is released as soon as play starts. */
function syncPreview(): void {
  const lobby = !welcome.hidden;
  if (!lobby) {
    preview?.dispose();
    preview = undefined;
    previewCanvas.hidden = true;
    previewFallback.hidden = false;
    return;
  }
  setAccent(accounts.previewColor);
  if (!preview && loaded && !graphicsLost) {
    try {
      previewCanvas.hidden = false;
      preview = new CharacterPreview(
        previewCanvas,
        session.definition.simulation.character,
        accounts.selectedSkinId,
        accounts.previewColor,
      );
      previewFallback.hidden = true;
    } catch (error) {
      console.warn('Character preview unavailable', error);
      previewCanvas.hidden = true;
      previewFallback.hidden = false;
    }
  }
  preview?.setSkin(accounts.selectedSkinId);
  preview?.setColor(accounts.previewColor);
}

function resetCameraInput(): void {
  cameraPointer?.cancel();
  view?.stopCamera();
}

function resetGameInput(): void {
  keyboard?.clear();
  touch?.reset();
  resetCameraInput();
  session.neutral();
}
function closeGamePanels(): void {
  reactions?.close(false);
  animations?.close(false);
  chat?.close(false);
  inventory?.close();
  view?.showPlacement();
  diagnostics.hidden = true;
  diagnosticsToggle.setAttribute('aria-expanded', 'false');
}
const inputMode = new GameInputMode(canvas, stick, (mode) => {
  resetGameInput();
  closeGamePanels();
  view?.setTouchMode(mode === 'touch');
  renderInputMode();
  renderGamePanels();
  showNotice(
    mode === 'touch'
      ? 'Сенсорное управление включено. Стик слева — ходьба, свайп справа — камера.'
      : 'Управление переключено на мышь и клавиатуру. Нажмите клавишу движения ещё раз.',
  );
});
function renderControls(placing = false): void {
  element('controls-title').textContent = placing ? 'Поворот предмета' : 'Свободное движение';
  element('controls-description').textContent = placing
    ? 'W / S — наклон · A / D — поворот · Q / E — крен'
    : inputMode.value === 'touch'
      ? 'Стик слева — ходьба · свайп справа — камера'
      : 'WASD / стрелки · Shift — быстрый бег · удерживайте Q / E или тяните ПКМ — камера';
}
function canTouch(): boolean {
  return (
    inputMode.value === 'touch' &&
    loaded &&
    !graphicsLost &&
    pageActive &&
    !document.hidden &&
    session.gameplayInputEnabled
  );
}
function renderInputMode(): void {
  const isTouch = inputMode.value === 'touch';
  document.body.dataset.inputMode = inputMode.value;
  stick.hidden = !isTouch || session.state !== 'playing' || graphicsLost;
  keyboard?.setEnabled(!isTouch && !graphicsLost && element('chat-console').hidden);
  inventory?.setEnabled(!isTouch && !graphicsLost);
  renderControls();
  syncTouchInput();
}
function syncTouchInput(): void {
  touch?.setEnabled(canTouch());
}
function renderGamePanels(): void {
  const available = inputMode.value === 'desktop' && !graphicsLost;
  const reaction = session.reactionStatus();
  const animation = session.animationStatus();
  reactions?.update({ ...reaction, available: available && reaction.available });
  animations?.update({ ...animation, available: available && animation.available });
  renderChat();
  inventory?.update();
}
function continuationHint(): string {
  return inputMode.value === 'touch'
    ? 'Коснитесь стика заново, чтобы продолжить.'
    : 'Нажмите клавишу движения, чтобы продолжить.';
}

function showNotice(message: string, options: { toast?: { hint?: string } } = {}): void {
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
  notice.replaceChildren(...parts);
  // Re-trigger the slide-up for each new message.
  notice.hidden = true;
  void notice.offsetWidth;
  notice.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(
    () => {
      notice.hidden = true;
    },
    options.toast ? 2800 : 7000,
  );
}
function updateState(state: ConnectionState, message?: string): void {
  const playing = state === 'playing';
  const reconnecting = state === 'reconnecting';
  const preparing = state === 'preparing' || state === 'waiting';
  welcome.hidden = graphicsLost || playing || ((reconnecting || preparing) && !!session.room);
  document.body.dataset.scene = welcome.hidden ? 'world' : 'lobby';
  join.disabled =
    graphicsLost ||
    accounts.busy ||
    state === 'loading' ||
    state === 'connecting' ||
    preparing ||
    reconnecting;
  joinLabel.textContent =
    state === 'loading'
      ? 'Загружаем мир…'
      : state === 'connecting'
        ? 'Входим на полигон…'
        : reconnecting
          ? 'Восстанавливаем связь…'
          : state === 'error'
            ? session.reloadRequired
              ? 'Перезагрузить страницу'
              : 'Повторить загрузку'
            : session.reloadRequired
              ? 'Перезагрузить страницу'
              : accounts.enabled && !accounts.account
                ? 'Войти гостем'
                : 'Войти в мир';
  status.textContent = {
    loading: 'Загрузка',
    ready: session.reloadRequired
      ? 'Нужно обновление'
      : session.info?.available === false
        ? 'Мир заполнен'
        : 'Мир доступен',
    connecting: 'Подключение',
    playing: 'В сети',
    preparing: 'Подготовка окружения',
    waiting: 'Загрузка окружения',
    reconnecting: 'Восстановление',
    error: 'Нет соединения',
  }[state];
  if (graphicsLost) status.textContent = 'Графика недоступна';
  statusDot.dataset.online = String(!graphicsLost && (playing || state === 'ready'));
  document.body.classList.toggle('connection-lost', reconnecting);
  respawn.hidden = !playing;
  leave.hidden = !session.room && !reconnecting;
  if (
    inputMode.value === 'touch' ||
    (state !== 'waiting' && !(playing && previousConnection === 'waiting'))
  )
    resetGameInput();
  previousConnection = state;
  stick.hidden = inputMode.value !== 'touch' || !playing || graphicsLost;
  syncTouchInput();
  if (
    playing &&
    !graphicsLost &&
    !document.querySelector('.inventory-panel:not([hidden]), .chat-console:not([hidden])')
  ) {
    canvas.focus({ preventScroll: true });
  }
  if (message) showNotice(message);
  renderRespawn();
  renderGamePanels();
  if (playing) {
    const own = session.room?.state.players.get(session.room.sessionId);
    if (own?.color) setAccent(own.color);
  }
  help?.setAvailable(welcome.hidden && !graphicsLost && !!session.room);
  syncPreview();
}
const session = new GameSession(updateState, showNotice);
const storageStatus = document.createElement('div');
storageStatus.className = 'storage-status';
storageStatus.setAttribute('role', 'status');
storageStatus.hidden = true;
storageStatus.textContent =
  'Мир приостановлен: сохранение недоступно. Игра продолжится после восстановления связи.';
document.body.append(storageStatus);
const accounts = new AccountPanel(
  () => {
    session.accountId = accounts.account?.accountId;
    session.guestSkinId = accounts.selectedSkinId;
    updateState(session.state);
  },
  () => session.leave(),
);
inventory = new InventoryPanel(
  session,
  canvas,
  () => {
    chat?.close(false);
    reactions?.close(false);
    animations?.close(false);
    diagnostics.hidden = true;
    diagnosticsToggle.setAttribute('aria-expanded', 'false');
  },
  (placing) => {
    keyboard?.setPlacementMode(placing);
    resetGameInput();
    renderControls(placing);
  },
  (name) => showNotice(`${name} добавлена в инвентарь`, { toast: { hint: 'X' } }),
);
help = new HelpMenu(() => canvas.focus({ preventScroll: true }));
const pickups = new PickupSource(
  session,
  () => view,
  () => appliedAccent || '#6EE0C4',
  (itemId, name) => inventory?.pickup(itemId, name),
);
interactions = new InteractionSystem({
  player: () => {
    const room = session.room;
    const self = room?.state.players.get(room.sessionId);
    return self ? { x: self.x, y: self.y, z: self.z } : undefined;
  },
  candidates: () => pickups.candidates(),
  project: (anchor, out) => (view ? view.project(anchor, out) : (out.visible = false)),
  enabled: () =>
    loaded && !graphicsLost && inputMode.value === 'desktop' && !!inventory?.canCollect,
});
const accountPreparation = accounts.load();
function setCameraRotation(direction: -1 | 0 | 1): void {
  if (!loaded || graphicsLost) return;
  view?.setCameraRotation(direction);
}
reactions = new ReactionMenu(
  element<HTMLButtonElement>('reactions-toggle'),
  element('reactions-panel'),
  element('reactions-status'),
  canvas,
  (id) => {
    if (inputMode.value !== 'desktop' || graphicsLost) return;
    session.react(id);
    renderGamePanels();
  },
  () => {
    animations?.close(false);
    inventory?.close();
    chat?.close(false);
    diagnostics.hidden = true;
    diagnosticsToggle.setAttribute('aria-expanded', 'false');
  },
);
animations = new AnimationMenu(
  element<HTMLButtonElement>('animations-toggle'),
  element('animations-panel'),
  element('animations-status'),
  canvas,
  (id) => {
    if (inputMode.value !== 'desktop' || graphicsLost) return;
    session.animate(id);
    renderGamePanels();
  },
  () => {
    reactions?.close(false);
    inventory?.close();
    chat?.close(false);
    diagnostics.hidden = true;
    diagnosticsToggle.setAttribute('aria-expanded', 'false');
  },
);
chat = new ChatConsole(
  element<HTMLButtonElement>('chat-toggle'),
  element<HTMLFormElement>('chat-console'),
  element<HTMLInputElement>('chat-input'),
  element('chat-status'),
  element('chat-counter'),
  element<HTMLButtonElement>('chat-send'),
  canvas,
  (text) => {
    if (inputMode.value !== 'desktop' || graphicsLost) return;
    session.sendChat(text);
    renderChat();
  },
  (open) => {
    keyboard?.setEnabled(!open && !graphicsLost && inputMode.value === 'desktop');
    resetGameInput();
    if (open) {
      reactions?.close(false);
      animations?.close(false);
      inventory?.close();
      diagnostics.hidden = true;
      diagnosticsToggle.setAttribute('aria-expanded', 'false');
    }
  },
);
session.onChatResult = (result) => {
  chat?.complete(result.ok);
  renderChat();
};
function renderChat(): void {
  const state = session.chatStatus();
  chat?.update({
    ...state,
    available: state.available && !graphicsLost && inputMode.value === 'desktop',
  });
}
keyboard = new KeyboardInput(
  resetGameInput,
  setCameraRotation,
  () => reactions!.toggleOpen(),
  (initialText) => chat!.open(initialText),
  () => animations!.toggleOpen(),
  (axis, direction) => inventory?.rotatePlacement(axis, direction),
);
cameraPointer = new CameraPointerInput(
  canvas,
  () => inputMode.value === 'desktop' && loaded && !graphicsLost && keyboard.cameraEnabled,
  (radians) => view?.rotateCameraBy(radians),
  () => view?.stopCamera(),
);
touch = new TouchInput(
  canvas,
  stick,
  element('touch-thumb'),
  canTouch,
  (radians) => view?.rotateCameraBy(radians),
  () => session.neutral(),
  resetGameInput,
);
renderInputMode();
window.addEventListener('blur', () => {
  pageActive = false;
  resetGameInput();
  syncTouchInput();
});
window.addEventListener('focus', () => {
  pageActive = true;
  syncTouchInput();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) resetGameInput();
  syncTouchInput();
});
const resetTouchScreen = () => {
  if (inputMode.value === 'touch') resetGameInput();
};
window.addEventListener('resize', resetTouchScreen);
window.addEventListener('orientationchange', resetTouchScreen);
screen.orientation?.addEventListener('change', resetTouchScreen);
function renderRespawn(): void {
  const { pending, remainingMs } = session.respawnStatus();
  respawn.disabled = graphicsLost || session.state !== 'playing' || pending || remainingMs > 0;
  respawn.setAttribute('aria-busy', String(pending));
  respawnLabel.textContent = pending
    ? 'Возвращаем…'
    : remainingMs > 0
      ? `На старт · ${Math.ceil(remainingMs / 1000)} с`
      : 'На старт';
}
function renderMetrics(): void {
  element('player-count').textContent = `${session.occupancy} / 8`;
  element('help-online').textContent = `${session.occupancy} / 8 в сети`;
  if (diagnostics.hidden) return;
  const data = session.diagnostics();
  const rendering = view?.renderingDiagnostics();
  const rows = [
    ['RTT', `${data.rttMs.toFixed(0)} мс`],
    [
      'Кадр · p95',
      data.warmingUp
        ? 'Прогрев'
        : data.frameP95Ms === null
          ? '—'
          : `${data.frameP95Ms.toFixed(1)} мс`,
    ],
    ['Шаг сервера', `${data.serverStepMs.toFixed(2)} мс`],
    ['Tick', String(data.serverTick)],
    ['Коррекция · p95', `${data.correctionP95.toFixed(3)} м`],
    ['Коррекция · максимум', `${data.correctionMax.toFixed(3)} м`],
    ['Ожидают подтверждения', String(data.pendingInputs)],
    [
      'Предсказание',
      data.areaWaiting ? 'Ожидание окружения' : data.stalled ? 'Ожидание сервера' : 'Активно',
    ],
    ['Карта', data.mapVersion?.slice(0, 12) ?? '—'],
    ['Симуляция', data.simulationConfigHash?.slice(0, 12) ?? '—'],
    [
      'Разрешение рендера',
      rendering ? `${rendering.renderSize.width} × ${rendering.renderSize.height}` : '—',
    ],
    ['Вызовов отрисовки', rendering ? String(rendering.drawCalls) : '—'],
  ];
  metrics.replaceChildren(
    ...rows.flatMap(([title, value]) => {
      const dt = document.createElement('dt');
      dt.textContent = title;
      const dd = document.createElement('dd');
      dd.textContent = value;
      return [dt, dd];
    }),
  );
}
async function start(): Promise<void> {
  if (starting) return;
  starting = true;
  loaded = false;
  try {
    if (!Engine.isSupported()) {
      session.markPreparationFailed(
        'Для полигона нужен браузер с WebGL2. Включите аппаратное ускорение и откройте страницу в браузере с WebGL2.',
      );
      return;
    }
    resetGameInput();
    view?.dispose();
    view = undefined;
    await session.load();
    view = new WorldView(canvas, element('labels'), session.definition, quality);
    view.setTouchMode(inputMode.value === 'touch');
    view.engine.onContextRestoredObservable.add(() => {
      if (!graphicsLost) return;
      graphicsLost = false;
      graphicsRecovery.hidden = true;
      document.body.classList.remove('graphics-unavailable');
      qualitySelect.disabled = false;
      resetGameInput();
      session.setInputEnabled(true);
      renderInputMode();
      session.resetFrameMeasurements();
      updateState(session.state);
      showNotice(
        session.state === 'playing'
          ? `Графика восстановлена. ${continuationHint()}`
          : 'Графика восстановлена.',
      );
    });
    if (view.engine.webGLVersion < 2) {
      view.dispose();
      view = undefined;
      session.markPreparationFailed(
        'Браузер не поддерживает WebGL2. Используйте браузер с WebGL2 и аппаратным ускорением.',
      );
      return;
    }
    session.connectGraphics(view);
    view.onFrame((now, delta) => {
      try {
        const area = view!.graphicalArea();
        view!.setStreamingRadius(session.updateVisualArea(area.center, area.drawRadius));
        syncTouchInput();
        const command =
          inputMode.value === 'touch'
            ? touch!.read(view!.cameraAngle)
            : keyboard.read(view!.cameraAngle);
        if (command.moveX || command.moveZ) help?.noteMovement();
        interactions?.tick(now);
        const frame = session.frame(now, delta, command);
        syncTouchInput();
        view!.follow(frame.ownId);
        view!.update(frame.entities, frame.ownId, delta);
        inventory?.frame(view!);
      } catch (error) {
        loaded = false;
        starting = true;
        resetGameInput();
        view?.onFrame(() => {});
        console.error('Game loop failed', error);
        updateState('loading');
        joinLabel.textContent = 'Восстанавливаем интерфейс…';
        void session.leave().finally(() => {
          view?.dispose();
          view = undefined;
          starting = false;
          session.markPreparationFailed(readableError(error));
        });
      }
    });
    loaded = true;
    await accountPreparation;
    session.markPrepared();
    await session.restore();
  } catch (error) {
    loaded = false;
    session.markPreparationFailed(readableError(error));
    view?.dispose();
    view = undefined;
    console.error('World preparation failed', error);
  } finally {
    starting = false;
  }
}
element('area-retry').addEventListener('click', () => {
  if (session.reloadRequired) location.reload();
  else session.retryArea();
});
join.addEventListener('click', () => {
  if (session.reloadRequired) location.reload();
  else if (loaded)
    void accounts.prepareJoin().then((ready) => {
      if (ready) void session.join();
    });
  else void start();
});
respawn.addEventListener('click', () => {
  resetGameInput();
  session.respawn();
  renderRespawn();
  canvas.focus({ preventScroll: true });
});
leave.addEventListener('click', () => {
  resetGameInput();
  void session.leave();
});
diagnosticsToggle.addEventListener('click', () => {
  chat?.close(false);
  reactions?.close(false);
  animations?.close(false);
  inventory?.close();
  diagnostics.hidden = !diagnostics.hidden;
  diagnosticsToggle.setAttribute('aria-expanded', String(!diagnostics.hidden));
  renderMetrics();
});
qualitySelect.addEventListener('change', () => {
  quality = qualitySelect.value === 'economy' ? 'economy' : 'standard';
  view?.setQuality(quality);
  session.resetFrameMeasurements();
  try {
    localStorage.setItem(qualityStorageKey, quality);
  } catch {
    /* A live preference still works without browser storage. */
  }
  renderMetrics();
});
element('download-report').addEventListener('click', () => {
  downloadDiagnosticReport(diagnosticReport(session, view, graphicsLost));
});
graphicsReload.addEventListener('click', () => location.reload());
canvas.addEventListener('webglcontextlost', (event) => {
  event.preventDefault();
  graphicsLost = true;
  keyboard.setEnabled(false);
  resetGameInput();
  session.setInputEnabled(false);
  renderInputMode();
  graphicsRecovery.hidden = false;
  qualitySelect.disabled = true;
  document.body.classList.add('graphics-unavailable');
  updateState(session.state);
  graphicsReload.focus({ preventScroll: true });
});
// Feedback remains alive even when WebGL has stopped producing frames.
const uiTimer = setInterval(() => {
  syncTouchInput();
  storageStatus.hidden = !session.storageUnavailable;
  renderRespawn();
  renderMetrics();
  const loading = session.state === 'preparing' || session.state === 'waiting';
  const problem = session.areaProblem;
  element('area-status').hidden = (!loading && !problem) || graphicsLost;
  element('area-message').textContent = problem
    ? session.reloadRequired
      ? 'Ресурсы мира изменились. Обновите страницу.'
      : 'Не удалось загрузить окружение. Повторите попытку.'
    : `Загружаем окружение… После подготовки: ${continuationHint()}`;
  element('area-retry').hidden = !problem;
  element('area-retry').textContent = session.reloadRequired
    ? 'Обновить страницу'
    : 'Повторить загрузку';
  renderGamePanels();
}, 250);
window.addEventListener('pageshow', (event) => {
  if (event.persisted) location.reload();
});
window.addEventListener(
  'pagehide',
  () => {
    clearInterval(uiTimer);
    clearTimeout(noticeTimer);
    unbindTouchButtons();
    resetGameInput();
    session.dispose();
    touch?.dispose();
    inputMode.dispose();
    cameraPointer?.dispose();
    view?.dispose();
    keyboard.dispose();
    help?.dispose();
    interactions?.dispose();
    preview?.dispose();
    reactions?.dispose();
    animations?.dispose();
    chat?.dispose();
    inventory?.dispose();
  },
  { once: true },
);
if (import.meta.env.DEV || new URLSearchParams(location.search).get('diagnostics') === '1') {
  Object.defineProperty(window, '__SU_DEBUG__', {
    value: Object.freeze({
      snapshot: () => structuredClone(session.diagnostics()),
      controls: () => ({
        mode: inputMode.value,
        input:
          inputMode.value === 'touch'
            ? touch!.read(view?.cameraAngle ?? 0)
            : keyboard.read(view?.cameraAngle),
        touchAvailable: canTouch(),
      }),
      corrections: () => session.correctionHistory(),
      report: () => ({
        ...diagnosticReport(session, view, graphicsLost),
        rendering: view?.renderingDiagnostics() ?? null,
      }),
      buildings: () => structuredClone(view?.buildingDiagnostics() ?? []),
      avatars: () => view?.avatarDiagnostics() ?? [],
    }),
    writable: false,
  });
}
void start();
