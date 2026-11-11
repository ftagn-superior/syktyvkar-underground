import './style.css';
import { Engine } from '@babylonjs/core/Engines/engine';
import { KeyboardInput } from './input/keyboard';
import { GameSession, readableError, type ConnectionState } from './network/session';
import { WorldView } from './rendering/world-view';
import type { RenderQuality } from './rendering/render-quality';
import { diagnosticReport, downloadDiagnosticReport } from './ui/diagnostic-report';
import { ReactionMenu } from './ui/reactions';
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
const cameraLeft = element<HTMLButtonElement>('camera-left');
const cameraRight = element<HTMLButtonElement>('camera-right');
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
let graphicsLost = false;
let reactions: ReactionMenu | undefined;
let chat: ChatConsole | undefined;
let inventory: InventoryPanel | undefined;

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
  welcome.hidden = graphicsLost || playing || (reconnecting && !!session.room);
  join.disabled =
    graphicsLost || accounts.busy || state === 'loading' || state === 'connecting' || reconnecting;
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
    reconnecting: 'Восстановление',
    error: 'Нет соединения',
  }[state];
  if (graphicsLost) status.textContent = 'Графика недоступна';
  statusDot.dataset.online = String(!graphicsLost && (playing || state === 'ready'));
  document.body.classList.toggle('connection-lost', reconnecting);
  respawn.hidden = !playing;
  leave.hidden = !playing && !reconnecting;
  keyboard?.clear();
  if (playing && !graphicsLost) {
    canvas.focus({ preventScroll: true });
    notice.hidden = true;
  }
  if (message) showNotice(message);
  renderRespawn();
  reactions?.update(session.reactionStatus());
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
inventory = new InventoryPanel(session, canvas);
const accountPreparation = accounts.load();
function rotateCamera(direction: -1 | 1): void {
  if (!loaded || graphicsLost) return;
  view?.rotateCamera(direction);
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
    session.neutral();
    if (open) {
      reactions?.close(false);
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
  () => session.neutral(),
  rotateCamera,
  () => reactions!.toggleOpen(),
  () => chat!.open(),
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
  cameraLeft.disabled = cameraRight.disabled = !loaded || graphicsLost;
}
function renderMetrics(): void {
  element('player-count').textContent = `${session.playerCount} / 8`;
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
    ['Предсказание', data.stalled ? 'Ожидание сервера' : 'Активно'],
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
    await view.prepareBuildings(session.manifest, (path) => session.readAsset(path));
    view.onFrame((now, delta) => {
      try {
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
    view?.dispose();
    view = undefined;
    session.markPreparationFailed(readableError(error));
    console.error('World preparation failed', error);
  } finally {
    starting = false;
  }
}
join.addEventListener('click', () => {
  if (session.reloadRequired) location.reload();
  else if (loaded)
    void accounts.prepareJoin().then((ready) => {
      if (ready) void session.join();
    });
  else void start();
});
cameraLeft.addEventListener('click', () => {
  rotateCamera(-1);
  canvas.focus({ preventScroll: true });
});
cameraRight.addEventListener('click', () => {
  rotateCamera(1);
  canvas.focus({ preventScroll: true });
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
  reactions?.update(session.reactionStatus());
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
    session.neutral();
    session.dispose();
    view?.dispose();
    keyboard.dispose();
    reactions?.dispose();
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
      report: () => diagnosticReport(session, view, graphicsLost),
      buildings: () => structuredClone(view?.buildingDiagnostics() ?? []),
      avatars: () => view?.avatarDiagnostics() ?? [],
    }),
    writable: false,
  });
}
void start();
