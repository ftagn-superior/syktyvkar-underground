import './style.css';
import { Engine } from '@babylonjs/core/Engines/engine';
import { KeyboardInput } from './input/keyboard';
import { CameraPointerInput } from './input/camera-pointer';
import { GameSession, readableError, type ConnectionState } from './network/session';
import { WorldView } from './rendering/world-view';
import type { RenderQuality } from './rendering/render-quality';
import { diagnosticReport, downloadDiagnosticReport } from './ui/diagnostic-report';
import { ReactionMenu } from './ui/reactions';
import { AnimationMenu } from './ui/animations';
import { ChatConsole } from './ui/chat';
import { InventoryPanel } from './ui/inventory';
import { AccountPanel } from './ui/account-panel';

function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing UI: ${id}`);
  return node as T;
}
const canvas = element<HTMLCanvasElement>('world');
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
const actions = document.querySelector<HTMLElement>('.actions')!;
const actionsResize = new ResizeObserver(() => {
  document.documentElement.style.setProperty(
    '--game-actions-height',
    `${actions.getBoundingClientRect().height}px`,
  );
});
actionsResize.observe(actions);
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
let reactions: ReactionMenu | undefined;
let animations: AnimationMenu | undefined;
let chat: ChatConsole | undefined;
let inventory: InventoryPanel | undefined;

function resetCameraInput(): void {
  cameraPointer?.cancel();
  view?.stopCamera();
}

function showNotice(message: string): void {
  notice.textContent = message;
  notice.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    notice.hidden = true;
  }, 7000);
}
function updateState(state: ConnectionState, message?: string): void {
  const playing = state === 'playing';
  const reconnecting = state === 'reconnecting';
  const preparing = state === 'preparing' || state === 'waiting';
  welcome.hidden = graphicsLost || playing || ((reconnecting || preparing) && !!session.room);
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
                : 'Войти';
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
  if (state !== 'waiting' && !(playing && previousConnection === 'waiting')) {
    keyboard?.clear();
    resetCameraInput();
  }
  previousConnection = state;
  if (
    playing &&
    !graphicsLost &&
    !document.querySelector('.inventory-panel:not([hidden]), .chat-console:not([hidden])')
  ) {
    canvas.focus({ preventScroll: true });
  }
  if (message) showNotice(message);
  renderRespawn();
  reactions?.update(session.reactionStatus());
  animations?.update(session.animationStatus());
  renderChat();
  inventory?.update();
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
    resetCameraInput();
    session.neutral();
    element('controls-title').textContent = placing ? 'Поворот предмета' : 'Свободное движение';
    element('controls-description').textContent = placing
      ? 'W / S — наклон · A / D — поворот · Q / E — крен'
      : 'WASD / стрелки · Shift — быстрый бег · удерживайте Q / E или тяните ПКМ — камера';
  },
);
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
    session.react(id);
    reactions!.update(session.reactionStatus());
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
    session.animate(id);
    animations!.update(session.animationStatus());
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
    session.sendChat(text);
    renderChat();
  },
  (open) => {
    keyboard?.setEnabled(!open && !graphicsLost);
    resetCameraInput();
    session.neutral();
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
  chat?.update({ ...state, available: state.available && !graphicsLost });
}
keyboard = new KeyboardInput(
  () => {
    resetCameraInput();
    session.neutral();
  },
  setCameraRotation,
  () => reactions!.toggleOpen(),
  (initialText) => chat!.open(initialText),
  () => animations!.toggleOpen(),
  (axis, direction) => inventory?.rotatePlacement(axis, direction),
);
cameraPointer = new CameraPointerInput(
  canvas,
  () => loaded && !graphicsLost && keyboard.cameraEnabled,
  (radians) => view?.rotateCameraBy(radians),
  () => view?.stopCamera(),
);
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
        'Для полигона нужен браузер с WebGL2. Откройте страницу в настольном Chromium и включите аппаратное ускорение.',
      );
      return;
    }
    resetCameraInput();
    view?.dispose();
    view = undefined;
    await session.load();
    view = new WorldView(canvas, element('labels'), session.definition, quality);
    view.engine.onContextRestoredObservable.add(() => {
      if (!graphicsLost) return;
      graphicsLost = false;
      graphicsRecovery.hidden = true;
      document.body.classList.remove('graphics-unavailable');
      qualitySelect.disabled = false;
      keyboard.setEnabled(true);
      session.setInputEnabled(true);
      session.resetFrameMeasurements();
      updateState(session.state);
      showNotice(
        session.state === 'playing'
          ? 'Графика восстановлена. Нажмите клавишу движения, чтобы продолжить.'
          : 'Графика восстановлена.',
      );
    });
    if (view.engine.webGLVersion < 2) {
      view.dispose();
      view = undefined;
      session.markPreparationFailed(
        'Браузер не поддерживает WebGL2. Используйте настольный Chromium с аппаратным ускорением.',
      );
      return;
    }
    session.connectGraphics(view);
    view.onFrame((now, delta) => {
      try {
        const area = view!.graphicalArea();
        view!.setStreamingRadius(session.updateVisualArea(area.center, area.drawRadius));
        const frame = session.frame(now, delta, keyboard.read(view!.cameraAngle));
        view!.follow(frame.ownId);
        view!.update(frame.entities, frame.ownId, delta);
        inventory?.frame(view!);
      } catch (error) {
        loaded = false;
        starting = true;
        keyboard.clear();
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
  session.respawn();
  renderRespawn();
  canvas.focus({ preventScroll: true });
});
leave.addEventListener('click', () => {
  keyboard.clear();
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
  resetCameraInput();
  session.setInputEnabled(false);
  graphicsRecovery.hidden = false;
  qualitySelect.disabled = true;
  document.body.classList.add('graphics-unavailable');
  updateState(session.state);
  graphicsReload.focus({ preventScroll: true });
});
// Feedback remains alive even when WebGL has stopped producing frames.
const uiTimer = setInterval(() => {
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
    : 'Загружаем окружение… Движение продолжится после подготовки.';
  element('area-retry').hidden = !problem;
  element('area-retry').textContent = session.reloadRequired
    ? 'Обновить страницу'
    : 'Повторить загрузку';
  reactions?.update(session.reactionStatus());
  animations?.update(session.animationStatus());
  renderChat();
  inventory?.update();
}, 250);
window.addEventListener('pageshow', (event) => {
  if (event.persisted) location.reload();
});
window.addEventListener(
  'pagehide',
  () => {
    clearInterval(uiTimer);
    clearTimeout(noticeTimer);
    actionsResize.disconnect();
    session.neutral();
    session.dispose();
    cameraPointer?.dispose();
    view?.dispose();
    keyboard.dispose();
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
