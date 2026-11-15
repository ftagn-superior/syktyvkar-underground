import { createElementLookup } from './dom';
import { GameHud } from './game-hud';
import { GamePanels } from './game-panels';
import { LobbyPreview } from './lobby-preview';
import { WorldHud } from './world-hud';
import { HelpMenu } from '../ui/help';
import { InteractionSystem } from '../interaction/prompt';
import { PickupSource } from '../interaction/pickups';
import { BusStopSource } from '../interaction/bus-stops';
import { BusMapPanel, type BusMapBackground } from '../ui/bus-map';
import { Engine } from '@babylonjs/core/Engines/engine';
import { KeyboardInput, isTextInput } from '../input/keyboard';
import { GamepadInput, type GamepadButtons } from '../input/gamepad';
import { GamepadNavigation } from '../ui/gamepad-navigation';
import { FirstPersonInput } from '../input/first-person';
import { ChatReturnContext } from '../input/chat-return';
import {
  validateBusNetwork,
  dayClockHour,
  MAX_PLAYERS,
  NEUTRAL_INPUT,
  type BusNetwork,
  type MoveInput,
} from '@su/contracts';
import { firstPersonMovement, gamepadCameraDelta } from '../rendering/camera-controller';
import { CameraPointerInput } from '../input/camera-pointer';
import { GameInputMode } from '../input/mode';
import { TouchInput } from '../input/touch';
import { GameSession, readableError, type ConnectionState } from '../network/session';
import { WorldView } from '../rendering/world-view';
import { parseWeatherOverride } from '../rendering/environment/weather-mix';
import type { RenderQuality } from '../rendering/render-quality';
import { diagnosticReport, downloadDiagnosticReport } from '../ui/diagnostic-report';
import { ReactionMenu } from '../ui/reactions';
import { AnimationMenu } from '../ui/animations';
import { ChatConsole, type ChatCloseReason } from '../ui/chat';
import { CommandHelpPanel } from '../ui/command-help';
import { ChatSettings } from '../ui/chat-settings';
import { StaticPlacement } from '../ui/static-placement';
import { StaticRemoval } from '../ui/static-removal';
import { InventoryPanel } from '../ui/inventory';
import { AccountPanel } from '../ui/account-panel';
import { bindTouchButtons } from '../ui/touch-buttons';
import { GameAudio } from '../audio/game-audio';
import { AudioSettings } from '../ui/audio-settings';
import { MenuSounds } from '../ui/menu-sounds';

/** Composes the browser game; gameplay state stays in GameSession and WorldView. */
export function startGame(): void {
  const pageEvents = new AbortController();
  const eventOptions = { signal: pageEvents.signal };
  let disposed = false;
  const element = createElementLookup(document);
  const hud = new GameHud(element);
  const showNotice = hud.showNotice;
  const canvas = element<HTMLCanvasElement>('world');
  const stick = element('touch-stick');
  const welcome = element('welcome');
  const join = element<HTMLButtonElement>('join');
  const joinLabel = element('join-label');
  const respawn = element<HTMLButtonElement>('respawn');
  const leave = element<HTMLButtonElement>('leave');
  const diagnostics = element('diagnostics');
  const metrics = element('metrics');
  const diagnosticsToggle = element<HTMLButtonElement>('diagnostics-toggle');
  const qualitySelect = element<HTMLSelectElement>('quality');
  const graphicsRecovery = element('graphics-recovery');
  const graphicsReload = element<HTMLButtonElement>('graphics-reload');
  const audio = new GameAudio();
  const audioSettings = new AudioSettings(audio);
  const chatSettings = new ChatSettings();
  const audioInputs = new AbortController();
  const unlockAudio = () => audio.unlock();
  document.addEventListener('pointerdown', unlockAudio, {
    capture: true,
    signal: audioInputs.signal,
  });
  document.addEventListener('keydown', unlockAudio, { capture: true, signal: audioInputs.signal });
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
  let view: WorldView | undefined;
  let loaded = false;
  let starting = false;
  let keyboard: KeyboardInput;
  let cameraPointer: CameraPointerInput | undefined;
  let firstPerson: FirstPersonInput | undefined;
  let graphicsLost = false;
  let previousConnection: ConnectionState = 'loading';
  let pageActive = !document.hidden;
  let touch: TouchInput | undefined;
  let gamepad: GamepadInput | undefined;
  const gamepadNavigation = new GamepadNavigation();
  let gamepadContext = '';
  let gamepadResumeRequired = false;
  let gamepadHasWalked = false;
  let previousGamepadBase = false;
  let entryPending = false;
  let leavePending = false;
  let reactions: ReactionMenu | undefined;
  let animations: AnimationMenu | undefined;
  let chat: ChatConsole | undefined;
  let commandHelp: CommandHelpPanel | undefined;
  let inventory: InventoryPanel | undefined;
  let staticPlacement: StaticPlacement | undefined;
  let staticRemoval: StaticRemoval | undefined;
  let placementOwner: 'inventory' | 'static' | 'removal' | undefined;
  let help: HelpMenu | undefined;
  let interactions: InteractionSystem | undefined;
  const chatReturn = new ChatReturnContext();
  let controlSession: object | undefined;
  let controlReady = false;
  let busMap: BusMapPanel | undefined;
  let busNetworkCache: { worldId: string; network?: BusNetwork } | undefined;
  /**
   * Сеть автобусов текущего мира с сервера (`/api/bus-network`), один запрос на мир.
   * Пока ответа нет или в мире нет автобусов, подсказок у остановок нет.
   */
  function busNetwork(): BusNetwork | undefined {
    const worldId = loaded ? session.definition?.worldId : undefined;
    if (!worldId) return;
    if (busNetworkCache?.worldId !== worldId) {
      const entry: { worldId: string; network?: BusNetwork } = { worldId };
      busNetworkCache = entry;
      void fetch('/api/bus-network')
        .then((response) => (response.ok ? response.json() : undefined))
        .then((value) => {
          if (value !== undefined) entry.network = validateBusNetwork(value);
        })
        .catch(() => undefined);
    }
    return busNetworkCache.network;
  }
  const worldHud = new WorldHud(
    element,
    () => panels.open('players', 'chat'),
    () => canvas.focus({ preventScroll: true }),
  );
  // ?time=14.5 fixes the visible world hour for screenshots and visual tests.
  const fixedHour = Number.parseFloat(new URLSearchParams(location.search).get('time') ?? '');
  const weatherOverride = parseWeatherOverride(new URLSearchParams(location.search).get('weather'));
  const lobbyPreview = new LobbyPreview(
    element<HTMLCanvasElement>('preview-canvas'),
    element<HTMLImageElement>('preview-fallback'),
  );
  function syncPreview(): void {
    lobbyPreview.update(
      !welcome.hidden,
      accounts.selectedSkinId,
      accounts.previewColor,
      loaded && !graphicsLost ? session.definition.simulation.character : undefined,
    );
  }

  function resetCameraInput(): void {
    cameraPointer?.cancel();
    view?.stopCamera();
  }

  function resetGameInput(): void {
    keyboard?.clear();
    touch?.reset();
    gamepad?.reset();
    resetCameraInput();
    session.neutral();
  }
  const panels = new GamePanels(
    {
      help: {
        close: () => help?.close(false),
        isOpen: () => !!help?.isOpen,
      },
      players: {
        close: () => worldHud.closePlayers(),
        isOpen: () => !element('players-panel').hidden,
      },
      static: {
        close: () => staticPlacement?.close(),
        isOpen: () => placementOwner === 'static',
      },
      removal: {
        close: () => staticRemoval?.close(),
        isOpen: () => placementOwner === 'removal',
      },
      reactions: {
        close: () => reactions?.close(false),
        isOpen: () => !element('reactions-panel').hidden,
      },
      animations: {
        close: () => animations?.close(false),
        isOpen: () => !element('animations-panel').hidden,
      },
      commands: {
        close: () => commandHelp?.close(false),
        isOpen: () => !!commandHelp?.isOpen,
      },
      chat: {
        close: () => chat?.close('replace'),
        isOpen: () => !!chat?.isOpen,
      },
      inventory: {
        close: () => inventory?.close(),
        isOpen: () => !element('inventory-panel').hidden,
      },
      bus: {
        close: () => busMap?.close(),
        isOpen: () => !!busMap?.visible,
      },
      diagnostics: {
        close: () => {
          diagnostics.hidden = true;
          diagnosticsToggle.setAttribute('aria-expanded', 'false');
        },
        isOpen: () => !diagnostics.hidden,
      },
    },
    (name) => {
      if (name !== 'chat') interruptControls();
    },
  );
  function interruptControls(): void {
    chatReturn.invalidate();
    firstPerson?.suspend();
  }
  function closeGamePanels(): void {
    panels.closeExcept();
    view?.showPlacement();
  }
  const inputMode = new GameInputMode(canvas, stick, (mode) => {
    interruptControls();
    if (mode !== 'desktop') firstPerson?.overview();
    resetGameInput();
    closeGamePanels();
    gamepadNavigation.clear();
    gamepadContext = '';
    gamepadResumeRequired = false;
    previousGamepadBase = false;
    if (mode !== 'gamepad') gamepad?.release();
    help?.setGamepad(mode === 'gamepad');
    view?.setTouchMode(mode === 'touch');
    view?.setGamepadMode(mode === 'gamepad');
    renderInputMode();
    renderGamePanels();
    showNotice(
      mode === 'gamepad'
        ? 'Геймпад включён. Отпустите стики и кнопки, затем используйте крестовину и A.'
        : mode === 'touch'
          ? 'Сенсорное управление включено. Стик слева — ходьба, свайп справа — камера.'
          : 'Управление переключено на мышь и клавиатуру. Нажмите клавишу движения ещё раз.',
    );
  });
  function renderControls(placing = !!placementOwner): void {
    hud.renderControls({
      placement: placing ? placementOwner : undefined,
      firstPerson: firstPerson?.selected ?? false,
      mode: inputMode.value,
    });
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
  function overviewPanelsAvailable(): boolean {
    return (
      inputMode.value === 'desktop' &&
      !graphicsLost &&
      !firstPerson?.selected &&
      !firstPerson?.requesting
    );
  }
  function renderInputMode(): void {
    const isTouch = inputMode.value === 'touch';
    document.body.dataset.inputMode = inputMode.value;
    stick.hidden = !isTouch || session.state !== 'playing' || graphicsLost;
    // A text input consumes typing; an open chat dock alone does not disable movement.
    keyboard?.setEnabled(inputMode.value === 'desktop' && !graphicsLost);
    inventory?.setTouch(inputMode.value !== 'desktop');
    inventory?.setEnabled(
      inputMode.value !== 'gamepad' &&
        !graphicsLost &&
        !firstPerson?.selected &&
        !firstPerson?.requesting,
    );
    renderControls();
    syncTouchInput();
  }
  function syncTouchInput(): void {
    touch?.setEnabled(canTouch());
  }
  function renderGamePanels(): void {
    if (session.state !== 'playing' || graphicsLost) busMap?.close();
    const available = overviewPanelsAvailable();
    const reaction = session.reactionStatus();
    const animation = session.animationStatus();
    reactions?.update({ ...reaction, available: available && reaction.available });
    animations?.update(
      { ...animation, available: available && animation.available },
      available && !!session.room && ['playing', 'waiting'].includes(session.state),
    );
    renderChat();
    inventory?.update();
    renderFirstPerson();
  }
  function firstPersonEligible(): boolean {
    const room = session.room;
    return (
      loaded &&
      !graphicsLost &&
      pageActive &&
      !document.hidden &&
      inputMode.value === 'desktop' &&
      !placementOwner &&
      session.gameplayInputEnabled &&
      !!room?.state.players.get(room.sessionId)
    );
  }
  function canControlFirstPerson(): boolean {
    return !!firstPerson?.locked && firstPersonCaptureAllowed();
  }
  function firstPersonCaptureAllowed(): boolean {
    return (
      !disposed && firstPersonEligible() && !panels.hasForeground && element('chat-console').hidden
    );
  }
  function syncControlAvailability(): void {
    const room = session.room;
    const ready = firstPersonEligible();
    const interrupted = room !== controlSession || (controlReady && !ready);
    controlSession = room;
    controlReady = ready;
    if (interrupted) interruptControls();
  }
  function finishChat(reason: ChatCloseReason): void {
    if (disposed) {
      chatReturn.invalidate();
      return;
    }
    const previous = chatReturn.finish(session.room);
    resetGameInput();
    if (reason === 'replace' || reason === 'unavailable' || reason === 'dispose') {
      chatReturn.invalidate();
      return;
    }
    // The later canvas click, not pointerdown/close, owns explicit continuation.
    if (reason === 'world') chatReturn.invalidate();
    if (!firstPersonCaptureAllowed()) return;
    canvas.focus({ preventScroll: true });
    if (reason !== 'world' && previous?.mode === 'first-person-active')
      firstPerson?.resume(() => chatReturn.isCurrent(previous, session.room));
  }
  function readMovement(): MoveInput {
    if (inputMode.value === 'gamepad')
      return canGamepadWalk() ? gamepad!.read(view?.cameraAngle ?? 0) : { ...NEUTRAL_INPUT };
    if (inputMode.value === 'touch') return touch!.read(view?.cameraAngle ?? 0);
    if (firstPerson?.requesting) return { ...NEUTRAL_INPUT };
    if (firstPerson?.selected) {
      if (!canControlFirstPerson()) return { ...NEUTRAL_INPUT };
      return firstPersonMovement(keyboard.read(view?.cameraAngle), view!.facingYaw);
    }
    return keyboard.read(view?.cameraAngle);
  }
  function renderFirstPerson(): void {
    hud.renderFirstPerson({
      selected: firstPerson?.selected ?? false,
      pending: firstPerson?.requesting ?? false,
      locked: firstPerson?.locked ?? false,
      eligible: firstPersonEligible(),
    });
  }
  function continuationHint(): string {
    return inputMode.value === 'gamepad'
      ? 'Отпустите стики и кнопки, затем нажмите A, чтобы продолжить. Y — меню.'
      : firstPerson?.selected
        ? 'Щёлкните по миру, чтобы продолжить.'
        : inputMode.value === 'touch'
          ? 'Коснитесь стика заново, чтобы продолжить.'
          : 'Нажмите клавишу движения, чтобы продолжить.';
  }

  function updateState(state: ConnectionState, message?: string): void {
    if (disposed) return;
    syncControlAvailability();
    if (!['playing', 'waiting', 'preparing'].includes(state)) {
      staticPlacement?.close();
      staticRemoval?.close();
    }
    const playing = state === 'playing';
    if (!playing) audio.stopWorld();
    const reconnecting = state === 'reconnecting';
    const preparing = state === 'preparing' || state === 'waiting';
    if (state !== 'playing') firstPerson?.suspend();
    if (!session.room && !reconnecting && !preparing) firstPerson?.overview();
    hud.renderConnection({
      state,
      loaded,
      graphicsLost,
      roomPresent: !!session.room,
      accountBusy: accounts.busy,
      guestEntry: accounts.enabled && !accounts.account,
      reloadRequired: session.reloadRequired,
      worldAvailable: session.info?.available,
    });
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
      !panels.hasForeground &&
      !staticPlacement?.browsing &&
      !document.querySelector(
        '.inventory-panel:not([hidden]), .chat-form:not([hidden]), .catalog:not([hidden])',
      )
    ) {
      canvas.focus({ preventScroll: true });
    }
    if (message) showNotice(message);
    renderRespawn();
    renderGamePanels();
    if (playing) {
      const own = session.room?.state.players.get(session.room.sessionId);
      if (own?.color) lobbyPreview.setPlayerColor(own.color);
    }
    help?.setAvailable(welcome.hidden && !graphicsLost && !!session.room);
    if (!session.room) worldHud.clearChat();
    syncPreview();
  }
  const session = new GameSession(updateState, showNotice);
  session.onControlInterruption = interruptControls;
  const gamepadStatus = document.createElement('p');
  gamepadStatus.id = 'gamepad-status';
  gamepadStatus.className = 'gamepad-status ui-panel';
  gamepadStatus.setAttribute('role', 'status');
  gamepadStatus.hidden = true;
  element('hud-top').append(gamepadStatus);
  function gamepadBaseReady(): boolean {
    const room = session.room;
    return (
      loaded &&
      !graphicsLost &&
      pageActive &&
      !document.hidden &&
      session.gameplayInputEnabled &&
      !!room?.state.players.get(room.sessionId)
    );
  }
  function canGamepadWalk(): boolean {
    return (
      inputMode.value === 'gamepad' &&
      gamepadBaseReady() &&
      !!gamepad?.snapshot().ready &&
      !gamepadResumeRequired &&
      !help?.isOpen &&
      !session.criticalAreaProblem &&
      !isTextInput(document.activeElement)
    );
  }
  function interruptGamepad(confirm: boolean): void {
    if (inputMode.value !== 'gamepad') return;
    if (confirm && gamepadHasWalked) gamepadResumeRequired = true;
    resetGameInput();
  }
  function syncGamepadReadiness(): void {
    if (inputMode.value !== 'gamepad') return;
    const ready = gamepadBaseReady();
    if (previousGamepadBase && !ready) interruptGamepad(true);
    previousGamepadBase = ready;
    if (canGamepadWalk()) gamepadHasWalked = true;
  }
  function gamepadBlockReason(): string {
    const state = gamepad?.snapshot();
    if (!state?.apiAvailable) return 'Gamepad API недоступен. Используйте управление браузером.';
    if (state.issue === 'api-error')
      return 'Браузер запретил доступ к геймпаду. Проверьте Game Controls.';
    if (state.issue === 'unsupported') return 'Нужен геймпад со стандартной раскладкой Xbox.';
    if (state.issue === 'invalid-data')
      return 'Геймпад передаёт некорректные данные. Подключите его заново.';
    if (state.activeIndex === null) return 'Геймпад отключён. Нажмите A, чтобы выбрать контроллер.';
    if (!pageActive || document.hidden) return 'Вернитесь в игру, чтобы продолжить.';
    if (graphicsLost) return 'Графика недоступна. A — перезагрузить страницу.';
    if (help?.isOpen) return '';
    if (session.criticalAreaProblem)
      return 'Не удалось загрузить окружение. A — повторить · Y — меню.';
    if ((session.room || gamepadContext === 'waiting') && !gamepadBaseReady())
      return 'Ожидаем готовности мира. Y — меню.';
    if (!state.ready) return 'Отпустите стики и кнопки.';
    if (gamepadResumeRequired) return 'Нажмите A, чтобы продолжить. Y — меню.';
    return '';
  }
  function syncGamepadContext(): boolean {
    const lobbyStatus = element('gamepad-lobby-status');
    if (inputMode.value !== 'gamepad') {
      gamepadStatus.hidden = true;
      const state = gamepad?.snapshot();
      const message = state?.supportedCount
        ? 'Нажмите A, чтобы включить управление с геймпада.'
        : state?.issue === 'unsupported'
          ? 'Нужен геймпад со стандартной раскладкой Xbox.'
          : state?.issue === 'api-error' || state?.issue === 'unavailable'
            ? 'Gamepad API недоступен. Проверьте Game Controls или используйте управление браузером.'
            : '';
      if (lobbyStatus.textContent !== message) lobbyStatus.textContent = message;
      return false;
    }
    syncGamepadReadiness();
    if (graphicsLost && help?.isOpen) help.close(false);
    help?.syncGamepad({ resumeEnabled: gamepadBaseReady() });
    const context = graphicsLost
      ? 'graphics'
      : help?.isOpen
        ? help.gamepadContext
        : session.criticalAreaProblem && session.room
          ? 'area-error'
          : !welcome.hidden
            ? 'lobby'
            : gamepadBaseReady()
              ? 'walk'
              : 'waiting';
    const changed = gamepadContext !== context;
    gamepadContext = context;
    if (changed) resetGameInput();
    if (context === 'graphics')
      gamepadNavigation.setContext(context, [{ id: 'graphics-reload', element: graphicsReload }]);
    else if (context === 'menu' || context === 'confirm-exit')
      gamepadNavigation.setContext(context, help!.gamepadItems(), help!.gamepadPreferredId);
    else if (context === 'area-error') {
      element('area-status').hidden = false;
      element('area-retry').hidden = false;
      gamepadNavigation.setContext(context, [{ id: 'area-retry', element: element('area-retry') }]);
    } else if (context === 'lobby') {
      const ids = ['join', 'preview-prev', 'preview-next', 'audio-lobby-toggle', 'account-retry'];
      gamepadNavigation.setContext(
        context,
        ids.filter((id) => !element(id).hidden).map((id) => ({ id, element: element(id) })),
      );
    } else gamepadNavigation.clear();
    const reason = gamepadBlockReason();
    const message = reason || '↑↓ Выбрать · A Подтвердить';
    if (lobbyStatus.textContent !== message) lobbyStatus.textContent = message;
    if (gamepadStatus.textContent !== reason) gamepadStatus.textContent = reason;
    gamepadStatus.hidden = !welcome.hidden || !reason;
    return changed;
  }
  function pollGamepad(buttons: GamepadButtons): void {
    if (
      disposed ||
      syncGamepadContext() ||
      inputMode.value !== 'gamepad' ||
      !pageActive ||
      document.hidden ||
      isTextInput(document.activeElement) ||
      !gamepad?.snapshot().ready
    )
      return;
    if (buttons.y && !!session.room && !graphicsLost && gamepadContext !== 'confirm-exit') {
      if (help?.isOpen) help.handleGamepadBack('y');
      else help?.open(true);
    } else if (buttons.b && help?.isOpen) help.handleGamepadBack('b');
    else if (gamepadContext === 'walk' || gamepadContext === 'waiting') {
      if (buttons.a && gamepadResumeRequired && gamepadBaseReady()) {
        gamepadResumeRequired = false;
        resetGameInput();
      }
    } else {
      const action = buttons.a
        ? 'a'
        : buttons.up
          ? 'up'
          : buttons.down
            ? 'down'
            : buttons.left
              ? 'left'
              : buttons.right
                ? 'right'
                : undefined;
      if (action) gamepadNavigation.handle(action);
    }
    syncGamepadContext();
  }
  session.onSpawn = () => audio.playUi('spawn');
  session.onActionFeedback = (cue) => audio.playUi(cue);
  function syncAudioActivity(): void {
    const active = pageActive && !document.hidden && !graphicsLost;
    audio.setActive(active);
    session.setSoundActive(active);
  }
  syncAudioActivity();
  const storageStatus = document.createElement('div');
  storageStatus.className = 'storage-status ui-panel';
  storageStatus.setAttribute('role', 'status');
  storageStatus.hidden = true;
  storageStatus.textContent =
    'Мир приостановлен: сохранение недоступно. Игра продолжится после восстановления связи.';
  element('hud-top').append(storageStatus);
  const staticOperationStatus = document.createElement('div');
  staticOperationStatus.id = 'static-operation-status';
  staticOperationStatus.className = 'static-operation-status ui-panel';
  staticOperationStatus.setAttribute('role', 'status');
  staticOperationStatus.hidden = true;
  staticOperationStatus.textContent = 'Запрос отправлен. Проверяем и сохраняем…';
  element('hud-top').append(staticOperationStatus);
  const accounts = new AccountPanel(
    () => {
      if (session.accountId !== accounts.account?.accountId) {
        interruptControls();
        staticPlacement?.close();
        staticRemoval?.close();
      }
      session.accountId = accounts.account?.accountId;
      session.guestSkinId = accounts.selectedSkinId;
      updateState(session.state);
    },
    () => session.leave(),
  );
  inventory = new InventoryPanel(
    session,
    canvas,
    () => panels.open('inventory', 'chat'),
    (placing) => {
      if (placing) {
        staticPlacement?.close();
        staticRemoval?.close();
        placementOwner = 'inventory';
      } else if (placementOwner === 'inventory') placementOwner = undefined;
      keyboard?.setPlacementMode(!!placementOwner);
      resetGameInput();
      renderControls(placing);
    },
    (name, icon) => showNotice(`${name} — в рюкзаке`, { toast: { hint: 'X', icon } }),
  );
  staticPlacement = new StaticPlacement(
    session,
    canvas,
    () => view,
    (active) => {
      placementOwner = active ? 'static' : undefined;
      keyboard?.setPlacementMode(active);
      resetGameInput();
      renderControls(active);
    },
    () => inputMode.value === 'desktop' && !graphicsLost,
  );
  session.onStaticPlacementOpen = (effect, requestId) => {
    if (
      !chatReturn.acceptCommand(requestId, session.room) ||
      !firstPersonEligible() ||
      inputMode.value !== 'desktop' ||
      graphicsLost ||
      session.staticPlacementPending ||
      session.staticRemovalPending
    )
      return;
    firstPerson?.overview();
    panels.open('static');
    help?.close(false);
    void staticPlacement?.open(effect);
  };
  staticRemoval = new StaticRemoval(
    session,
    canvas,
    () => view,
    (active) => {
      placementOwner = active ? 'removal' : undefined;
      keyboard?.setPlacementMode(active);
      resetGameInput();
      renderControls(active);
    },
    () => inputMode.value === 'desktop' && !graphicsLost,
  );
  session.onStaticRemovalOpen = (effect, requestId) => {
    if (
      !chatReturn.acceptCommand(requestId, session.room) ||
      !firstPersonEligible() ||
      inputMode.value !== 'desktop' ||
      graphicsLost ||
      session.staticPlacementPending ||
      session.staticRemovalPending
    )
      return;
    firstPerson?.overview();
    panels.open('removal');
    help?.close(false);
    staticRemoval?.open(effect);
  };
  help = new HelpMenu(
    () => canvas.focus({ preventScroll: true }),
    () => {
      panels.open('help', 'chat');
      if (inputMode.value === 'gamepad') resetGameInput();
      if (!firstPerson?.selected && !firstPerson?.requesting) return;
      firstPerson?.suspend();
      resetGameInput();
    },
    worldHud.theme,
    chatSettings,
  );
  help.onGamepadClose = () => resetGameInput();
  help.onGamepadContinue = () => {
    if (gamepadBaseReady()) gamepadResumeRequired = false;
  };
  busMap = new BusMapPanel({
    network: busNetwork,
    bounds: () => {
      const { min, max } = session.definition.bounds;
      return { minX: min.x, maxX: max.x, minZ: min.z, maxZ: max.z };
    },
    loadBackground: async () => {
      const response = await fetch('/api/bus-map');
      if (!response.ok) throw new Error(`Bus map: HTTP ${response.status}`);
      return (await response.json()) as BusMapBackground;
    },
    travel: (from, to) => session.busTravel(from, to),
    travelStatus: () => session.busTravelStatus(),
    opened: () => {
      firstPerson?.overview();
      panels.open('bus');
      help?.close(false);
      resetGameInput();
    },
    closed: () => canvas.focus({ preventScroll: true }),
  });
  session.onBusTravelResult = (result) => busMap?.travelResult(result.ok);
  const busStops = new BusStopSource(busNetwork, (stopId) => busMap?.open(stopId));
  const pickups = new PickupSource(
    session,
    () => view,
    () => lobbyPreview.color,
    (itemId, name, typeId) => inventory?.pickup(itemId, name, typeId),
  );
  interactions = new InteractionSystem({
    player: () => {
      const room = session.room;
      const self = room?.state.players.get(room.sessionId);
      return self ? { x: self.x, y: self.y, z: self.z } : undefined;
    },
    // Подбор — только для вошедших игроков; остановки доступны и гостям.
    candidates: () => {
      const room = session.room;
      const self = room?.state.players.get(room.sessionId);
      const player = self ? { x: self.x, y: self.y, z: self.z } : undefined;
      const stops = busStops.candidates(player);
      return inventory?.canCollect ? [...pickups.candidates(), ...stops] : stops;
    },
    project: (anchor, out) => (view ? view.project(anchor, out) : (out.visible = false)),
    enabled: () =>
      loaded &&
      !graphicsLost &&
      !busMap?.visible &&
      session.state === 'playing' &&
      // Во время размещения из рюкзака подсказки скрыты, как и прежде.
      !placementOwner,
    // Touch players use the contextual prompt; hardware keys belong to desktop input.
    keys: () => inputMode.value === 'desktop',
  });
  const accountPreparation = accounts.load();
  function setCameraRotation(direction: -1 | 0 | 1): void {
    if (!loaded || graphicsLost) return;
    if (
      direction !== 0 &&
      (firstPerson?.requesting || (firstPerson?.selected && !canControlFirstPerson()))
    )
      return;
    view?.setCameraRotation(direction);
  }
  reactions = new ReactionMenu(
    element<HTMLButtonElement>('reactions-toggle'),
    element('reactions-panel'),
    element('reactions-status'),
    canvas,
    (id) => {
      if (!overviewPanelsAvailable()) return;
      session.react(id);
      renderGamePanels();
    },
    () => {
      panels.open('reactions', 'chat');
      renderGamePanels();
    },
  );
  animations = new AnimationMenu(
    element<HTMLButtonElement>('animations-toggle'),
    element('animations-panel'),
    element('animations-status'),
    canvas,
    (id) => {
      if (!overviewPanelsAvailable()) return;
      session.animate(id);
      renderGamePanels();
    },
    () => {
      panels.open('animations', 'chat');
      // Opening a catalog must not wait for the periodic HUD refresh to enable shortcuts.
      renderGamePanels();
    },
    () =>
      loaded
        ? {
            character: session.definition.simulation.character,
            skinId: accounts.selectedSkinId,
            color: accounts.previewColor,
          }
        : undefined,
  );
  chat = new ChatConsole(
    element<HTMLButtonElement>('chat-toggle'),
    element<HTMLFormElement>('chat-console'),
    element('chat-row'),
    element<HTMLInputElement>('chat-input'),
    element('chat-status'),
    element('chat-counter'),
    element<HTMLButtonElement>('chat-send'),
    canvas,
    (text) => {
      if (inputMode.value !== 'desktop' || graphicsLost) return false;
      const requestId = session.sendChat(text);
      if (requestId !== undefined && session.room) chatReturn.sent(requestId, session.room);
      renderChat();
      return requestId !== undefined;
    },
    {
      beforeOpen: () => {
        const mode = canControlFirstPerson()
          ? 'first-person-active'
          : firstPerson?.selected
            ? 'first-person-cursor'
            : 'overview';
        if (session.room) chatReturn.begin(mode, session.room);
        else chatReturn.invalidate();
        firstPerson?.suspend();
        resetGameInput();
        // Command help remains readable while composing a command.
        panels.open('chat', 'commands');
      },
      closed: finishChat,
      canFocus: () =>
        !disposed &&
        pageActive &&
        !document.hidden &&
        !graphicsLost &&
        inputMode.value === 'desktop' &&
        !panels.hasForeground &&
        session.chatStatus().available,
    },
    chatSettings,
    element('chat-suggest'),
    {
      commands: () => session.commands(),
      players: () => {
        const names: string[] = [];
        session.room?.state?.players?.forEach((player) => {
          if (player.name) names.push(player.name);
        });
        return names;
      },
    },
  );
  session.onCommandCatalog = () => chat?.refreshSuggestions();
  session.onDayClock = (clock) => view?.setDayClock(clock);
  session.onWeather = (weather) => view?.setWeather(weather);
  session.onChatResult = (result) => {
    chatReturn.acceptCommand(result.requestId, session.room);
    chat?.complete(result.ok);
    renderChat();
  };
  // Route chat Escape before other window handlers, including first-person suspension.
  window.addEventListener(
    'keydown',
    (event) => {
      if (event.code !== 'Escape' || !chat?.isOpen) return;
      const target = event.target;
      const inChat =
        target instanceof Node &&
        (element('chat-console').contains(target) || element('chat-toggle').contains(target));
      if (inChat || !panels.hasForeground) chat.handleEscape(event);
    },
    { ...eventOptions, capture: true },
  );
  commandHelp = new CommandHelpPanel(
    element('commands-panel'),
    canvas,
    element('chat-row'),
    (text) => chat?.insert(text),
    () => panels.open('commands', 'chat'),
    element('chat-suggest'),
  );
  session.onCommandHelp = (help, requestId) => {
    const room = session.room;
    // Ответ со справкой можно читать и во время ожидания сети: управление персонажем ему не нужно.
    if (
      !chatReturn.acceptCommand(requestId, room) ||
      !loaded ||
      graphicsLost ||
      !pageActive ||
      document.hidden ||
      inputMode.value !== 'desktop' ||
      placementOwner ||
      !['playing', 'waiting'].includes(session.state) ||
      !room?.state.players.has(room.sessionId)
    )
      return;
    commandHelp?.show(help);
  };
  const menuSounds = new MenuSounds(
    [
      'help-panel',
      'reactions-panel',
      'animations-panel',
      'commands-panel',
      'inventory-panel',
      'players-panel',
      'chat-console',
      'diagnostics',
    ].map((id) => element(id)),
    () => pageActive && !document.hidden && !graphicsLost && session.state === 'playing',
    (cue) => audio.playUi(cue),
  );
  function renderChat(): void {
    const state = session.chatStatus();
    const desktop = !graphicsLost && inputMode.value === 'desktop';
    const keepOpen = desktop && session.state === 'waiting';
    // Краткая сетевая пауза сохраняет и черновик, и справку, которую читают при вводе.
    if (!desktop || (!state.available && !keepOpen)) commandHelp?.close(false);
    chat?.update({
      ...state,
      available: state.available && desktop,
      keepOpen,
    });
  }
  keyboard = new KeyboardInput(
    resetGameInput,
    setCameraRotation,
    () => reactions!.toggleOpen(),
    (initialText) => chat!.open(initialText),
    () => animations!.toggleOpen(),
    (axis, direction) => {
      if (placementOwner === 'static') {
        if (axis === 'y') staticPlacement?.rotate(direction);
      } else if (placementOwner !== 'removal') inventory?.rotatePlacement(axis, direction);
    },
    () => (staticPlacement?.browsing ?? false) || !!busMap?.visible,
  );
  cameraPointer = new CameraPointerInput(
    canvas,
    () =>
      inputMode.value === 'desktop' &&
      loaded &&
      !graphicsLost &&
      keyboard.cameraEnabled &&
      !firstPerson?.selected &&
      !firstPerson?.requesting,
    (radians) => view?.rotateCameraBy(radians),
    () => view?.stopCamera(),
  );
  firstPerson = new FirstPersonInput(canvas, {
    eligible: firstPersonEligible,
    captureAllowed: firstPersonCaptureAllowed,
    intentChanged: () => chatReturn.invalidate(),
    prepare: () => {
      closeGamePanels();
      help?.close(false);
    },
    reset: resetGameInput,
    modeChanged: (enabled) => {
      view?.setFirstPerson(enabled);
      renderInputMode();
      renderGamePanels();
    },
    stateChanged: () => {
      renderInputMode();
      renderGamePanels();
    },
    look: (x, y) => view?.lookBy(x, y),
    notice: showNotice,
  });
  element('view-toggle').addEventListener('click', () => firstPerson!.toggle(), eventOptions);
  element('overview-button').addEventListener('click', () => firstPerson!.overview(), eventOptions);
  touch = new TouchInput(
    canvas,
    stick,
    element('touch-thumb'),
    canTouch,
    (radians) => view?.rotateCameraBy(radians),
    () => session.neutral(),
    resetGameInput,
  );
  gamepad = new GamepadInput({
    canSelect: () => pageActive && !document.hidden && !isTextInput(document.activeElement),
    onSelected: () => {
      gamepadHasWalked = false;
      gamepadResumeRequired = false;
      inputMode.select('gamepad');
      resetGameInput();
    },
    onDisconnected: () => {
      interruptGamepad(false);
      gamepadResumeRequired = false;
      if (inputMode.value === 'gamepad')
        showNotice('Геймпад отключён. Нажмите A для повторного выбора.');
    },
    onInterrupted: (reason) => interruptGamepad(reason !== 'resize'),
    onPoll: pollGamepad,
  });
  gamepad.start();
  renderInputMode();
  window.addEventListener(
    'blur',
    () => {
      pageActive = false;
      interruptControls();
      syncAudioActivity();
      resetGameInput();
      syncTouchInput();
    },
    eventOptions,
  );
  window.addEventListener(
    'focus',
    () => {
      pageActive = true;
      syncAudioActivity();
      syncTouchInput();
    },
    eventOptions,
  );
  document.addEventListener(
    'visibilitychange',
    () => {
      syncAudioActivity();
      if (document.hidden) {
        interruptControls();
        resetGameInput();
      }
      syncTouchInput();
    },
    eventOptions,
  );
  const resetTouchScreen = () => {
    if (inputMode.value !== 'desktop' || firstPerson?.selected) resetGameInput();
  };
  window.addEventListener('resize', resetTouchScreen, eventOptions);
  window.addEventListener('orientationchange', resetTouchScreen, eventOptions);
  screen.orientation?.addEventListener('change', resetTouchScreen, eventOptions);
  function renderRespawn(): void {
    hud.renderRespawn(
      session.respawnStatus(),
      !graphicsLost &&
        session.state === 'playing' &&
        (inputMode.value !== 'gamepad' || gamepadBaseReady()),
    );
  }
  function renderWorldHud(): void {
    const hour =
      view?.hour ??
      (Number.isFinite(fixedHour) ? fixedHour : dayClockHour(session.dayClock, Date.now()));
    const room = session.room;
    worldHud.update(hour, session.occupancy, room?.state?.players ?? [], room?.sessionId);
  }
  function renderMetrics(): void {
    element('player-count').textContent = `${session.occupancy} из ${MAX_PLAYERS}`;
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
  function recoverGameLoop(error: unknown): void {
    if (disposed) return;
    loaded = false;
    starting = true;
    interruptControls();
    resetGameInput();
    view?.onFrame(() => {});
    view?.onInputFrame(() => {});
    view?.onCameraFrame(() => {});
    console.error('Game loop failed', error);
    updateState('loading');
    joinLabel.textContent = 'Восстанавливаем интерфейс…';
    void session.leave().finally(() => {
      if (disposed) return;
      view?.dispose();
      view = undefined;
      starting = false;
      session.markPreparationFailed(readableError(error));
    });
  }
  async function start(): Promise<void> {
    if (starting || disposed) return;
    starting = true;
    loaded = false;
    try {
      if (!Engine.isSupported()) {
        session.markPreparationFailed(
          'Для игры нужен браузер с WebGL2. Включите аппаратное ускорение и откройте страницу в браузере с WebGL2.',
        );
        return;
      }
      resetGameInput();
      firstPerson?.overview();
      view?.dispose();
      view = undefined;
      await session.load();
      if (disposed) return;
      view = new WorldView(canvas, element('labels'), session.definition, quality);
      view.setAudio(audio);
      view.setDayClock(session.dayClock);
      view.setWeather(session.weather);
      if (weatherOverride) view.setWeatherOverride(weatherOverride);
      if (Number.isFinite(fixedHour)) view.setTimeOfDay(fixedHour);
      view.setTouchMode(inputMode.value === 'touch');
      view.setGamepadMode(inputMode.value === 'gamepad');
      view.setOverlayTest((from, to, targetId) => session.overlayBlocked(from, to, targetId));
      view.engine.onContextRestoredObservable.add(() => {
        if (!graphicsLost) return;
        graphicsLost = false;
        syncAudioActivity();
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
      view.onInputFrame((_now, delta) => {
        syncGamepadReadiness();
        if (canGamepadWalk()) view!.rotateCameraBy(gamepadCameraDelta(gamepad!.cameraX, delta));
      });
      view.onFrame((now, delta) => {
        try {
          syncControlAvailability();
          if (!firstPersonCaptureAllowed()) firstPerson?.suspend();
          syncTouchInput();
          const command = readMovement();
          if (command.moveX || command.moveZ) help?.noteMovement();
          const frame = session.frame(now, delta, command);
          syncGamepadReadiness();
          view!.setRenderDeferred(session.state === 'preparing');
          syncControlAvailability();
          if (!firstPersonEligible()) firstPerson?.suspend();
          if (!frame.ownId && session.state !== 'reconnecting' && session.state !== 'preparing')
            firstPerson?.overview();
          syncTouchInput();
          view!.follow(frame.ownId);
          view!.update(frame.entities, frame.ownId, delta, session.ownPhysicalPosition());
          for (const event of session.takeWorldSounds(now)) {
            const own = event.actorId === session.room?.sessionId;
            if (event.kind === 'pickup' && own) audio.playUi('pickup');
            else
              audio.playWorld(event.kind, event.position, {
                typeId: event.typeId,
                strength: event.strength,
                own,
                sourceId: event.entityId,
              });
          }
        } catch (error) {
          recoverGameLoop(error);
        }
      });
      view.onCameraFrame((now) => {
        try {
          const area = view!.graphicalArea();
          view!.setStreamingRadius(session.updateVisualArea(area.center, area.drawRadius));
          interactions?.tick(now);
          if (placementOwner === 'static') staticPlacement?.frame();
          else if (placementOwner === 'removal') staticRemoval?.frame();
          else inventory?.frame(view!);
        } catch (error) {
          recoverGameLoop(error);
        }
      });
      loaded = true;
      await accountPreparation;
      if (disposed) return;
      session.markPrepared();
      await session.restore();
    } catch (error) {
      if (disposed) return;
      loaded = false;
      session.markPreparationFailed(readableError(error));
      view?.dispose();
      view = undefined;
      console.error('World preparation failed', error);
    } finally {
      starting = false;
    }
  }
  element('area-retry').addEventListener(
    'click',
    () => {
      if (session.reloadRequired) location.reload();
      else session.retryArea();
    },
    eventOptions,
  );
  join.addEventListener(
    'click',
    () => {
      if (join.disabled || entryPending) return;
      if (session.reloadRequired) location.reload();
      else if (loaded) {
        entryPending = true;
        void accounts
          .prepareJoin()
          .then(async (ready) => {
            if (ready && !disposed) await session.join();
          })
          .finally(() => {
            entryPending = false;
          });
      } else void start();
    },
    eventOptions,
  );
  respawn.addEventListener(
    'click',
    () => {
      if (respawn.disabled || (inputMode.value === 'gamepad' && !gamepadBaseReady())) return;
      interruptControls();
      resetGameInput();
      session.respawn();
      renderRespawn();
      canvas.focus({ preventScroll: true });
    },
    eventOptions,
  );
  leave.addEventListener(
    'click',
    () => {
      if (leavePending || leave.disabled) return;
      leavePending = true;
      gamepadHasWalked = false;
      gamepadResumeRequired = false;
      help?.close(false);
      firstPerson?.overview();
      resetGameInput();
      void session.leave().finally(() => {
        leavePending = false;
      });
    },
    eventOptions,
  );
  diagnosticsToggle.addEventListener(
    'click',
    () => {
      if (inputMode.value === 'gamepad') return;
      panels.open('diagnostics');
      diagnostics.hidden = !diagnostics.hidden;
      diagnosticsToggle.setAttribute('aria-expanded', String(!diagnostics.hidden));
      renderMetrics();
    },
    eventOptions,
  );
  qualitySelect.addEventListener(
    'change',
    () => {
      resetGameInput();
      quality = qualitySelect.value === 'economy' ? 'economy' : 'standard';
      view?.setQuality(quality);
      session.resetFrameMeasurements();
      try {
        localStorage.setItem(qualityStorageKey, quality);
      } catch {
        /* A live preference still works without browser storage. */
      }
      renderMetrics();
    },
    eventOptions,
  );
  element('download-report').addEventListener(
    'click',
    () => {
      downloadDiagnosticReport(diagnosticReport(session, view, graphicsLost));
    },
    eventOptions,
  );
  graphicsReload.addEventListener('click', () => location.reload(), eventOptions);
  canvas.addEventListener(
    'webglcontextlost',
    (event) => {
      event.preventDefault();
      graphicsLost = true;
      interruptControls();
      interruptGamepad(true);
      closeGamePanels();
      staticPlacement?.close();
      staticRemoval?.close();
      firstPerson?.suspend();
      syncAudioActivity();
      keyboard.setEnabled(false);
      resetGameInput();
      session.setInputEnabled(false);
      renderInputMode();
      graphicsRecovery.hidden = false;
      qualitySelect.disabled = true;
      document.body.classList.add('graphics-unavailable');
      updateState(session.state);
      graphicsReload.focus({ preventScroll: true });
    },
    eventOptions,
  );
  // Feedback remains alive even when WebGL has stopped producing frames.
  const uiTimer = setInterval(() => {
    syncControlAvailability();
    audioSettings.refresh();
    syncTouchInput();
    storageStatus.hidden = !session.storageUnavailable;
    staticOperationStatus.hidden = !session.staticPlacementPending && !session.staticRemovalPending;
    renderRespawn();
    renderMetrics();
    renderWorldHud();
    const loading = session.state === 'preparing' || session.state === 'waiting';
    const problem = session.areaProblem;
    element('area-status').hidden = (!loading && !problem) || graphicsLost;
    element('area-message').textContent = problem
      ? session.reloadRequired
        ? 'Ресурсы мира изменились. Обновите страницу.'
        : 'Не удалось загрузить окружение. Повторите попытку.'
      : session.layoutUpdating
        ? 'Обновляем окружение…'
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
      disposed = true;
      interruptControls();
      pageEvents.abort();
      clearInterval(uiTimer);
      clearInterval(previewRefreshTimer);
      hud.dispose();
      unbindTouchButtons();
      resetGameInput();
      firstPerson?.dispose();
      session.dispose();
      touch?.dispose();
      gamepad?.dispose();
      gamepadNavigation.clear();
      gamepadStatus.remove();
      inputMode.dispose();
      cameraPointer?.dispose();
      staticPlacement?.dispose();
      staticRemoval?.dispose();
      view?.dispose();
      keyboard.dispose();
      help?.dispose();
      worldHud.dispose();
      interactions?.dispose();
      lobbyPreview.dispose();
      reactions?.dispose();
      animations?.dispose();
      commandHelp?.dispose();
      chat?.dispose();
      inventory?.dispose();
      busMap?.dispose();
      menuSounds.dispose();
      audioSettings.dispose();
      audioInputs.abort();
      audio.dispose();
      storageStatus.remove();
    },
    { once: true },
  );
  if (import.meta.env.DEV || new URLSearchParams(location.search).get('diagnostics') === '1') {
    Object.defineProperty(window, '__SU_DEBUG__', {
      value: Object.freeze({
        snapshot: () => structuredClone(session.diagnostics()),
        motion: () => session.motionSnapshot(),
        frames: () => session.frameHistory(),
        placement: () => staticPlacement?.diagnostics(),
        removal: () => staticRemoval?.diagnostics(),
        project: (position: { x: number; y: number; z: number }) => {
          const out = { x: 0, y: 0, visible: false };
          view?.project(position, out);
          return out;
        },
        controls: () => ({
          mode: inputMode.value,
          view: firstPerson?.selected ? 'first-person' : 'overview',
          pointerLocked: firstPerson?.locked ?? false,
          pointerPending: firstPerson?.requesting ?? false,
          firstPersonAvailable: firstPersonEligible(),
          input: readMovement(),
          touchAvailable: canTouch(),
          gamepad: gamepad?.snapshot(),
          gamepadContext,
          gamepadFocus: gamepadNavigation.selectedId,
          gamepadBlocked: inputMode.value === 'gamepad' ? gamepadBlockReason() : '',
          gamepadResumeRequired,
          gamepadAvailable: canGamepadWalk(),
        }),
        corrections: () => session.correctionHistory(),
        report: () => ({
          ...diagnosticReport(session, view, graphicsLost),
          rendering: view?.renderingDiagnostics() ?? null,
        }),
        buildings: () => structuredClone(view?.buildingDiagnostics() ?? []),
        avatars: () => view?.avatarDiagnostics() ?? [],
        audio: () => audio.diagnostics(),
      }),
      writable: false,
    });
  }
  const refreshPreview = () => {
    if (loaded && !session.room && !document.hidden)
      void session.refreshPublication().catch(() => {});
  };
  window.addEventListener('focus', refreshPreview, eventOptions);
  const previewRefreshTimer = setInterval(refreshPreview, 15_000);
  void start();
}
