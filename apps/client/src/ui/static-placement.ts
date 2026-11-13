import {
  buildingBounds,
  staticPlacementRotation,
  type ItemPose,
  type PlacementCatalog,
  type PlaceStaticResult,
  type StaticPlacementEffect,
} from '@su/contracts';
import type { GameSession } from '../network/session';
import type { WorldView } from '../rendering/world-view';
import { PlacementCatalogPanel } from './placement-catalog';
import { ICONS } from './icons';

/** The local catalog/ghost is disposable; the durable operation belongs to GameSession. */
export class StaticPlacement {
  private panel = document.createElement('section');
  private title = document.createElement('b');
  private status = document.createElement('p');
  private confirm = document.createElement('button');
  private cancelButton = document.createElement('button');
  private otherModel = document.createElement('button');
  private retryModel = document.createElement('button');
  private readonly catalogPanel: PlacementCatalogPanel;
  private catalog?: PlacementCatalog;
  private effect?: StaticPlacementEffect;
  private assetId?: string;
  private ghost?: Awaited<ReturnType<WorldView['createStaticGhost']>>;
  private controller?: AbortController;
  private listeners = new AbortController();
  private generation = 0;
  private yawStep = 0;
  private pose?: ItemPose;
  private focused = true;
  private freshPointer = false;
  private freshConfirmKey = false;
  private errorMessage = '';
  private terminalError = false;
  private recovering = false;
  private retryRecovery?: () => void;

  constructor(
    private session: GameSession,
    private canvas: HTMLCanvasElement,
    private view: () => WorldView | undefined,
    private mode: (active: boolean) => void,
    private available: () => boolean,
  ) {
    this.catalogPanel = new PlacementCatalogPanel(
      canvas,
      () => this.close(),
      (assetId) => {
        void this.startGhost(assetId);
      },
    );
    this.panel.id = 'static-placement';
    this.panel.className = 'place-pill ui-panel';
    this.panel.hidden = true;
    this.panel.setAttribute('aria-label', 'Размещение объекта');
    this.status.setAttribute('role', 'status');
    this.status.className = 'place-status';
    const copy = document.createElement('span');
    copy.className = 'place-copy';
    const line = document.createElement('span');
    line.append(this.title, ' · A / D — поворот на 15°');
    const optional = Object.assign(document.createElement('span'), {
      className: 'opt',
      textContent: ' · Esc — отмена',
    });
    line.append(optional);
    copy.append(line, this.status);
    this.confirm.type =
      this.cancelButton.type =
      this.otherModel.type =
      this.retryModel.type =
        'button';
    this.confirm.id = 'static-placement-confirm';
    this.confirm.textContent = 'Поставить';
    this.confirm.className = 'ui-btn ui-pri';
    this.otherModel.id = 'static-placement-other';
    this.otherModel.textContent = 'Другая модель';
    this.otherModel.className = this.retryModel.className = 'ui-btn';
    this.retryModel.textContent = 'Повторить загрузку';
    this.retryModel.id = 'static-placement-retry';
    this.retryModel.hidden = true;
    this.cancelButton.className = 'ui-btn ui-icon-btn';
    this.cancelButton.setAttribute('aria-label', 'Отменить размещение (Esc)');
    this.cancelButton.innerHTML = ICONS.close;
    this.panel.append(copy, this.retryModel, this.otherModel, this.confirm, this.cancelButton);
    (document.getElementById('hud-top') ?? document.body).append(this.panel);
    const options = { signal: this.listeners.signal };
    this.confirm.addEventListener(
      'click',
      (event) => {
        if ((event.detail === 0 && this.freshConfirmKey) || (event.detail > 0 && this.freshPointer))
          this.place();
        this.freshPointer = this.freshConfirmKey = false;
      },
      options,
    );
    window.addEventListener(
      'pointerdown',
      () => {
        this.freshPointer = this.focused && !this.browsing && !!this.ghost;
      },
      options,
    );
    this.confirm.addEventListener(
      'keydown',
      (event) => {
        if (!['Enter', 'NumpadEnter', 'Space'].includes(event.code)) return;
        if (event.repeat || !this.focused) event.preventDefault();
        else this.freshConfirmKey = true;
      },
      options,
    );
    this.confirm.addEventListener(
      'keyup',
      (event) => {
        if (event.code === 'Space' && !this.freshConfirmKey) event.preventDefault();
        if (event.code !== 'Space') this.freshConfirmKey = false;
      },
      options,
    );
    this.cancelButton.addEventListener(
      'click',
      () => {
        if (!session.staticPlacementPending) this.close();
      },
      options,
    );
    this.otherModel.addEventListener('click', () => this.browse(), options);
    this.retryModel.addEventListener(
      'click',
      () => {
        if (this.retryRecovery) this.retryRecovery();
        else if (this.assetId) void this.startGhost(this.assetId);
      },
      options,
    );
    canvas.addEventListener(
      'click',
      (event) => {
        if (event.detail <= 1 && this.focused && this.freshPointer && !this.browsing) this.place();
        this.freshPointer = false;
      },
      options,
    );
    window.addEventListener(
      'keydown',
      (event) => {
        if (
          this.active &&
          event.code === 'Escape' &&
          !event.repeat &&
          !session.staticPlacementPending
        ) {
          event.preventDefault();
          this.close();
        }
      },
      options,
    );
    const blur = () => {
      this.focused = false;
      this.freshPointer = this.freshConfirmKey = false;
      this.pose = undefined;
      this.ghost?.show();
    };
    window.addEventListener('blur', blur, options);
    window.addEventListener(
      'focus',
      () => {
        this.focused = true;
      },
      options,
    );
    document.addEventListener(
      'visibilitychange',
      () => {
        if (document.hidden) blur();
        else this.focused = document.hasFocus();
      },
      options,
    );
    session.onStaticPlacementResult = (result) => {
      void this.result(result);
    };
  }
  get active() {
    return !!this.effect;
  }
  get browsing() {
    return this.catalogPanel.visible;
  }
  diagnostics() {
    return {
      active: this.active,
      hasCatalog: !!this.catalog,
      recovering: this.recovering,
      hasGhost: !!this.ghost,
      focused: this.focused,
      pending: this.session.staticPlacementPending,
      worldPaused: this.session.worldPaused,
      catalog: this.catalogPanel.diagnostics(),
    };
  }

  async open(effect: StaticPlacementEffect) {
    if (
      !this.available() ||
      this.session.staticPlacementPending ||
      this.session.state !== 'playing'
    )
      return;
    if (this.active) {
      if (this.browsing) this.catalogPanel.focus();
      else this.canvas.focus({ preventScroll: true });
      return;
    }
    this.effect = effect;
    this.mode(true);
    await this.loadCatalog();
  }
  private async loadCatalog() {
    if (!this.effect || this.session.staticPlacementPending) return;
    this.releaseGhost();
    const generation = ++this.generation;
    const controller = (this.controller = new AbortController());
    this.panel.hidden = true;
    this.catalogPanel.loading(() => {
      void this.loadCatalog();
    });
    this.mode(true);
    try {
      const catalog = await this.session.loadPlacementCatalog(
        this.effect.catalog,
        controller.signal,
      );
      if (generation !== this.generation) return;
      this.catalog = catalog;
      if (
        this.session.info.placementCatalog?.placementCatalogVersion ===
        catalog.placementCatalogVersion
      )
        this.effect!.catalog = this.session.info.placementCatalog;
      this.assetId = undefined;
      this.catalogPanel.show(catalog, this.session.manifest, (path, signal) =>
        this.session.readStaticAsset(path, signal),
      );
    } catch (error) {
      if (generation !== this.generation || controller.signal.aborted) return;
      this.catalogPanel.error();
      console.warn('Placement catalog failed', error);
    }
  }
  private browse() {
    if (!this.catalog || this.session.staticPlacementPending || this.recovering) return;
    this.generation++;
    this.releaseGhost();
    this.panel.hidden = true;
    this.catalogPanel.show(
      this.catalog,
      this.session.manifest,
      (path, signal) => this.session.readStaticAsset(path, signal),
      true,
    );
    this.mode(true);
  }
  private releaseGhost() {
    this.controller?.abort();
    this.controller = undefined;
    this.ghost?.dispose();
    this.ghost = undefined;
    this.pose = undefined;
    this.freshPointer = this.freshConfirmKey = false;
  }
  private async startGhost(assetId: string) {
    if (
      !this.catalog ||
      this.session.staticPlacementPending ||
      this.session.worldPaused ||
      this.recovering
    )
      return;
    this.releaseGhost();
    this.catalogPanel.hide();
    this.canvas.focus({ preventScroll: true });
    this.assetId = assetId;
    this.yawStep = 0;
    this.errorMessage = '';
    this.terminalError = false;
    this.retryRecovery = undefined;
    this.retryModel.textContent = 'Повторить загрузку';
    this.panel.hidden = false;
    this.confirm.disabled = true;
    this.cancelButton.disabled = this.otherModel.disabled = false;
    this.retryModel.hidden = true;
    this.title.textContent = this.catalog.models.find(
      (model) => model.assetId === assetId,
    )!.metadata.name;
    this.status.textContent = 'Загружаем модель…';
    this.mode(true);
    const generation = ++this.generation;
    const controller = (this.controller = new AbortController());
    try {
      const view = this.view();
      if (!view) throw new Error('World view unavailable');
      const ghost = await view.createStaticGhost(
        this.session.manifest.assets[assetId],
        (path, signal) => this.session.readStaticAsset(path, signal),
        controller.signal,
      );
      if (generation !== this.generation) {
        ghost.dispose();
        return;
      }
      this.ghost = ghost;
      this.freshPointer = this.freshConfirmKey = false;
      this.canvas.focus({ preventScroll: true });
    } catch (error) {
      if (generation !== this.generation || controller.signal.aborted) return;
      this.status.textContent =
        'Не удалось загрузить модель. Повторите загрузку или выберите другую.';
      this.retryModel.hidden = false;
      console.warn('Placement ghost failed', error);
    }
  }
  close() {
    const active = this.active;
    this.generation++;
    this.releaseGhost();
    this.catalogPanel.hide(active);
    this.catalog = undefined;
    this.effect = undefined;
    this.assetId = undefined;
    this.recovering = false;
    this.retryRecovery = undefined;
    this.panel.hidden = true;
    this.confirm.disabled = true;
    if (active) this.mode(false);
  }
  rotate(direction: -1 | 1) {
    if (
      !this.active ||
      this.browsing ||
      this.session.staticPlacementPending ||
      !this.focused ||
      this.recovering ||
      !this.catalog
    )
      return;
    this.yawStep = (this.yawStep + direction + this.catalog.yawSteps) % this.catalog.yawSteps;
  }
  private place() {
    if (
      !this.pose ||
      this.confirm.disabled ||
      !this.focused ||
      !this.available() ||
      !this.assetId ||
      !this.catalog ||
      this.recovering
    )
      return;
    if (
      this.session.placeStatic(
        { x: this.pose.position.x, z: this.pose.position.z },
        this.yawStep,
        this.assetId,
        this.catalog.placementCatalogVersion,
      )
    ) {
      this.errorMessage = '';
      this.confirm.disabled = this.cancelButton.disabled = this.otherModel.disabled = true;
      this.status.textContent = 'Сохраняем размещение…';
    }
  }
  private async result(result: PlaceStaticResult) {
    if (result.ok) {
      this.close();
      return;
    }
    if (!this.active) return;
    if (result.code === 'AUTH_REQUIRED') {
      this.close();
      return;
    }
    this.errorMessage =
      result.message ??
      (
        {
          OUT_OF_BOUNDS: 'Объект выходит за границы мира.',
          BLOCKED: 'Это место занято.',
          RATE_LIMITED: 'Слишком часто. Подождите перед новой попыткой.',
          CONTENT_LIMIT: 'Достигнут лимит объектов.',
          OPERATION_CONFLICT: 'Ошибка операции. Откройте инструмент снова.',
        } as Record<string, string>
      )[result.code] ??
      'Не удалось разместить объект.';
    if (
      ['CATALOG_CHANGED', 'ASSET_NOT_ALLOWED', 'STALE_WORLD', 'VERSION_MISMATCH'].includes(
        result.code,
      )
    ) {
      const generation = ++this.generation;
      this.releaseGhost();
      this.recovering = true;
      this.confirm.disabled = this.otherModel.disabled = true;
      this.cancelButton.disabled = false;
      this.status.textContent = 'Обновляем каталог…';
      await this.session.refreshPublication().catch(() => {});
      if (!this.active || generation !== this.generation) return;
      this.recovering = false;
      if (this.session.info.placementCatalog) {
        this.effect!.catalog = this.session.info.placementCatalog;
        await this.loadCatalog();
      } else {
        this.panel.hidden = true;
        this.catalogPanel.loading(() => {
          void this.loadCatalog();
        });
        this.catalogPanel.error('Каталог размещения недоступен для этого мира.');
        this.mode(true);
      }
    } else if (result.code === 'LAYOUT_CHANGED') {
      await this.recoverLayout();
    }
    // Retryable storage/world errors remain pending in GameSession with the exact request.
    if (result.code === 'OPERATION_CONFLICT' || result.code === 'CONTENT_LIMIT') {
      this.terminalError = true;
      this.ghost?.show();
      this.pose = undefined;
    }
  }
  private async recoverLayout() {
    const generation = ++this.generation;
    this.recovering = true;
    this.confirm.disabled = this.otherModel.disabled = true;
    this.cancelButton.disabled = false;
    this.retryModel.hidden = true;
    this.freshPointer = this.freshConfirmKey = false;
    this.status.textContent = 'Обновляем расстановку…';
    try {
      await this.session.refreshPublication();
    } catch {
      if (!this.active || generation !== this.generation) return;
      this.errorMessage = 'Не удалось обновить расстановку. Повторите обновление.';
      this.status.textContent = this.errorMessage;
      this.retryModel.textContent = 'Повторить обновление';
      this.retryModel.hidden = false;
      this.retryRecovery = () => {
        void this.recoverLayout();
      };
      this.retryModel.focus();
      return;
    }
    if (!this.active || generation !== this.generation) return;
    this.recovering = false;
    this.retryRecovery = undefined;
    this.freshPointer = this.freshConfirmKey = false;
    this.errorMessage = 'Расстановка обновлена. Подтвердите место заново.';
  }
  private setStatus(message: string) {
    if (this.status.textContent !== message) this.status.textContent = message;
  }
  frame() {
    if (!this.active) return;
    if (!this.available() || !['playing', 'waiting', 'preparing'].includes(this.session.state)) {
      this.close();
      return;
    }
    if (this.browsing) {
      this.catalogPanel.setUnavailable(
        this.session.worldPaused || this.session.state !== 'playing',
      );
      return;
    }
    if (this.recovering) {
      this.confirm.disabled = this.otherModel.disabled = true;
      return;
    }
    const pending = this.session.staticPlacementPending;
    this.cancelButton.disabled = this.otherModel.disabled = pending;
    if (pending || this.session.state !== 'playing') {
      this.confirm.disabled = true;
      if (pending) this.setStatus('Сохраняем размещение…');
      return;
    }
    const view = this.view();
    if (!view || !this.ghost || !this.catalog || !this.assetId) return;
    if (this.terminalError) {
      this.confirm.disabled = true;
      this.setStatus(this.errorMessage);
      return;
    }
    const ray = view.pointerRay(),
      dy = ray.to.y - ray.from.y;
    const t = dy === 0 ? -1 : (this.catalog.groundY - ray.from.y) / dy;
    this.pose = undefined;
    if (t >= 0 && this.focused && !document.hidden) {
      const position = {
        x: ray.from.x + (ray.to.x - ray.from.x) * t,
        y: this.catalog.groundY,
        z: ray.from.z + (ray.to.z - ray.from.z) * t,
      };
      const rotation = staticPlacementRotation(this.yawStep);
      const bounds = buildingBounds(
        { entityId: 'preview', assetId: this.assetId, position, rotation },
        this.session.manifest.assets[this.assetId].bounds,
      );
      const world = this.session.definition.bounds;
      if (
        ['x', 'y', 'z'].every((a) => {
          const axis = a as keyof typeof position;
          return bounds.min[axis] >= world.min[axis] && bounds.max[axis] <= world.max[axis];
        })
      )
        this.pose = { position, rotation };
    }
    this.ghost.show(this.pose);
    this.confirm.disabled = !this.pose || this.session.worldPaused;
    this.setStatus(
      this.errorMessage ||
        (this.pose ? 'Проверка места — при размещении' : 'Укажите место целиком в границах мира'),
    );
  }
  dispose() {
    this.close();
    this.listeners.abort();
    this.catalogPanel.dispose();
    this.panel.remove();
  }
}
