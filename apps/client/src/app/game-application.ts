import { createElementLookup } from './dom';
import { GameHud } from './game-hud';
import { GamePanels } from './game-panels';
import { LobbyPreview } from './lobby-preview';
import { WorldHud } from './world-hud';
import { HelpMenu } from '../ui/help';
import { InteractionSystem } from '../interaction/prompt';
import { PickupSource } from '../interaction/pickups';
import { Engine } from '@babylonjs/core/Engines/engine';
import { KeyboardInput } from '../input/keyboard';
import { FirstPersonInput } from '../input/first-person';
import { dayClockHour, MAX_PLAYERS, NEUTRAL_INPUT, type MoveInput } from '@su/contracts';
import { firstPersonMovement } from '../rendering/camera-controller';
import { CameraPointerInput } from '../input/camera-pointer';
import { GameInputMode } from '../input/mode';
import { TouchInput } from '../input/touch';
import { GameSession, readableError, type ConnectionState } from '../network/session';
import { WorldView } from '../rendering/world-view';
import type { RenderQuality } from '../rendering/render-quality';
import { diagnosticReport, downloadDiagnosticReport } from '../ui/diagnostic-report';
import { ReactionMenu } from '../ui/reactions';
import { AnimationMenu } from '../ui/animations';
import { ChatConsole } from '../ui/chat';
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
  let reactions: ReactionMenu | undefined;
  let animations: AnimationMenu | undefined;
  let chat: ChatConsole | undefined;
  let inventory: InventoryPanel | undefined;
  let staticPlacement: StaticPlacement | undefined;
  let staticRemoval: StaticRemoval | undefined;
  let placementOwner: 'inventory' | 'static' | 'removal' | undefined;
  let help: HelpMenu | undefined;
  let interactions: InteractionSystem | undefined;
  const worldHud = new WorldHud(
    element,
    () => panels.closeExcept('players', 'chat'),
    () => canvas.focus({ preventScroll: true }),
  );
  // ?time=14.5 fixes the visible world hour for screenshots and visual tests.
  const fixedHour = Number.parseFloat(new URLSearchParams(location.search).get('time') ?? '');
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
    resetCameraInput();
    session.neutral();
  }
  const panels = new GamePanels({
    help: () => help?.close(false),
    players: () => worldHud.closePlayers(),
    static: () => staticPlacement?.close(),
    removal: () => staticRemoval?.close(),
    reactions: () => reactions?.close(false),
    animations: () => animations?.close(false),
    chat: () => chat?.close(false),
    inventory: () => inventory?.close(),
    diagnostics: () => {
      diagnostics.hidden = true;
      diagnosticsToggle.setAttribute('aria-expanded', 'false');
    },
  });
  function closeGamePanels(): void {
    panels.closeExcept();
    view?.showPlacement();
  }
  const inputMode = new GameInputMode(canvas, stick, (mode) => {
    if (mode === 'touch') firstPerson?.overview();
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
    keyboard?.setEnabled(!isTouch && !graphicsLost);
    inventory?.setTouch(isTouch);
    inventory?.setEnabled(!graphicsLost && !firstPerson?.selected && !firstPerson?.requesting);
    renderControls();
    syncTouchInput();
  }
  function syncTouchInput(): void {
    touch?.setEnabled(canTouch());
  }
  function renderGamePanels(): void {
    const available = overviewPanelsAvailable();
    const reaction = session.reactionStatus();
    const animation = session.animationStatus();
    reactions?.update({ ...reaction, available: available && reaction.available });
    animations?.update({ ...animation, available: available && animation.available });
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
  function readMovement(): MoveInput {
    if (inputMode.value === 'touch') return touch!.read(view?.cameraAngle ?? 0);
    if (firstPerson?.requesting) return { ...NEUTRAL_INPUT };
    if (firstPerson?.selected) {
      if (
        !firstPerson.locked ||
        !firstPersonEligible() ||
        help?.isOpen ||
        !element('chat-console').hidden
      )
        return { ...NEUTRAL_INPUT };
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
    return firstPerson?.selected
      ? 'Щёлкните по миру, чтобы продолжить.'
      : inputMode.value === 'touch'
        ? 'Коснитесь стика заново, чтобы продолжить.'
        : 'Нажмите клавишу движения, чтобы продолжить.';
  }

  function updateState(state: ConnectionState, message?: string): void {
    if (disposed) return;
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
      !staticPlacement?.browsing &&
      !document.querySelector('.inventory-panel:not([hidden]), .chat-form:not([hidden])')
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
  const accounts = new AccountPanel(
    () => {
      if (session.accountId !== accounts.account?.accountId) {
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
    () => panels.closeExcept('inventory', 'chat'),
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
  session.onStaticPlacementOpen = (effect) => {
    if (
      inputMode.value !== 'desktop' ||
      graphicsLost ||
      session.staticPlacementPending ||
      session.staticRemovalPending
    )
      return;
    firstPerson?.overview();
    panels.closeExcept('static');
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
  session.onStaticRemovalOpen = (effect) => {
    if (
      inputMode.value !== 'desktop' ||
      graphicsLost ||
      session.staticPlacementPending ||
      session.staticRemovalPending
    )
      return;
    firstPerson?.overview();
    panels.closeExcept('removal');
    help?.close(false);
    staticRemoval?.open(effect);
  };
  help = new HelpMenu(
    () => canvas.focus({ preventScroll: true }),
    () => {
      panels.closeExcept('help', 'chat');
      if (!firstPerson?.selected && !firstPerson?.requesting) return;
      firstPerson?.suspend();
      resetGameInput();
    },
    worldHud.theme,
  );
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
    candidates: () => pickups.candidates(),
    project: (anchor, out) => (view ? view.project(anchor, out) : (out.visible = false)),
    enabled: () =>
      loaded &&
      !graphicsLost &&
      (!placementOwner || placementOwner === 'inventory') &&
      !!inventory?.canCollect,
    // Touch players use the contextual prompt; hardware keys belong to desktop input.
    keys: () => inputMode.value === 'desktop',
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
      if (!overviewPanelsAvailable()) return;
      session.react(id);
      renderGamePanels();
    },
    () => {
      panels.closeExcept('reactions', 'chat');
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
      panels.closeExcept('animations', 'chat');
      // Opening a catalog must not wait for the periodic HUD refresh to enable shortcuts.
      renderGamePanels();
    },
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
      if (inputMode.value !== 'desktop' || graphicsLost) return;
      session.sendChat(text);
      renderChat();
    },
    (open) => {
      if (open) firstPerson?.suspend();
      resetGameInput();
      if (open) panels.closeExcept('chat');
    },
  );
  session.onDayClock = (clock) => view?.setDayClock(clock);
  session.onChatResult = (result) => {
    chat?.complete(result.ok);
    renderChat();
  };
  const menuSounds = new MenuSounds(
    [
      'help-panel',
      'reactions-panel',
      'animations-panel',
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
    chat?.update({
      ...state,
      available: state.available && !graphicsLost && inputMode.value === 'desktop',
      keepOpen: session.state === 'waiting' && !graphicsLost && inputMode.value === 'desktop',
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
    () => staticPlacement?.browsing ?? false,
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
  renderInputMode();
  window.addEventListener(
    'blur',
    () => {
      pageActive = false;
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
      if (document.hidden) resetGameInput();
      syncTouchInput();
    },
    eventOptions,
  );
  const resetTouchScreen = () => {
    if (inputMode.value === 'touch' || firstPerson?.selected) resetGameInput();
  };
  window.addEventListener('resize', resetTouchScreen, eventOptions);
  window.addEventListener('orientationchange', resetTouchScreen, eventOptions);
  screen.orientation?.addEventListener('change', resetTouchScreen, eventOptions);
  function renderRespawn(): void {
    hud.renderRespawn(session.respawnStatus(), !graphicsLost && session.state === 'playing');
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
    firstPerson?.suspend();
    resetGameInput();
    view?.onFrame(() => {});
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
          'Для полигона нужен браузер с WebGL2. Включите аппаратное ускорение и откройте страницу в браузере с WebGL2.',
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
      if (Number.isFinite(fixedHour)) view.setTimeOfDay(fixedHour);
      view.setTouchMode(inputMode.value === 'touch');
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
      view.onFrame((now, delta) => {
        try {
          if (!firstPersonEligible() || help?.isOpen || !element('chat-console').hidden)
            firstPerson?.suspend();
          syncTouchInput();
          const command = readMovement();
          if (command.moveX || command.moveZ) help?.noteMovement();
          const frame = session.frame(now, delta, command);
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
      if (session.reloadRequired) location.reload();
      else if (loaded)
        void accounts.prepareJoin().then((ready) => {
          if (ready && !disposed) void session.join();
        });
      else void start();
    },
    eventOptions,
  );
  respawn.addEventListener(
    'click',
    () => {
      firstPerson?.suspend();
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
      firstPerson?.overview();
      resetGameInput();
      void session.leave();
    },
    eventOptions,
  );
  diagnosticsToggle.addEventListener(
    'click',
    () => {
      firstPerson?.suspend();
      panels.closeExcept('diagnostics');
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
    syncTouchInput();
    storageStatus.hidden = !session.storageUnavailable && !session.layoutUpdating;
    storageStatus.textContent = session.layoutUpdating
      ? 'Обновляется окружение. Игра продолжится после подготовки игроков.'
      : 'Мир приостановлен: сохранение недоступно. Игра продолжится после восстановления связи.';
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
      pageEvents.abort();
      clearInterval(uiTimer);
      clearInterval(previewRefreshTimer);
      hud.dispose();
      unbindTouchButtons();
      resetGameInput();
      firstPerson?.dispose();
      session.dispose();
      touch?.dispose();
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
      chat?.dispose();
      inventory?.dispose();
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
