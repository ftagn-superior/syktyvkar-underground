import {
  buildingBounds,
  staticPlacementRotation,
  type ItemPose,
  type StaticPlacementEffect,
} from '@su/contracts';
import type { GameSession } from '../network/session';
import type { WorldView } from '../rendering/world-view';

/** One desktop tool. A pending durable request belongs to GameSession, beyond the ghost's life. */
export class StaticPlacement {
  private panel = document.createElement('section');
  private status = document.createElement('p');
  private confirm = document.createElement('button');
  private cancelButton = document.createElement('button');
  private effect?: StaticPlacementEffect;
  private ghost?: Awaited<ReturnType<WorldView['createStaticGhost']>>;
  private controller?: AbortController;
  private listeners = new AbortController();
  private generation = 0;
  private yawStep = 0;
  private pose?: ItemPose;
  private focused = true;
  private freshPointer = false;
  private freshConfirmKey = false;
  constructor(
    private session: GameSession,
    private canvas: HTMLCanvasElement,
    private view: () => WorldView | undefined,
    private mode: (active: boolean) => void,
    private available: () => boolean,
  ) {
    this.panel.id = 'static-placement';
    this.panel.className = 'placement-toolbar';
    this.panel.hidden = true;
    this.panel.setAttribute('aria-label', 'Размещение скамейки');
    this.status.setAttribute('role', 'status');
    const title = Object.assign(document.createElement('strong'), {
      textContent: 'Размещение скамейки',
    });
    const hints = Object.assign(document.createElement('p'), {
      textContent: 'A / D — поворот на 15° · колесо — масштаб · Esc — отмена',
    });
    this.confirm.type = this.cancelButton.type = 'button';
    this.confirm.id = 'static-placement-confirm';
    this.confirm.textContent = 'Разместить';
    this.confirm.className = 'button inventory-primary';
    this.cancelButton.textContent = 'Отмена · Esc';
    this.cancelButton.className = 'button quiet';
    this.panel.append(title, this.status, hints, this.confirm, this.cancelButton);
    document.body.append(this.panel);
    const options = { signal: this.listeners.signal };
    this.confirm.addEventListener(
      'click',
      (event) => {
        if (event.detail === 0 || this.freshPointer) this.place();
        this.freshPointer = false;
        this.freshConfirmKey = false;
      },
      options,
    );
    window.addEventListener(
      'pointerdown',
      () => {
        this.freshPointer = this.focused;
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
    canvas.addEventListener(
      'click',
      (event) => {
        if (event.detail <= 1 && this.focused && this.freshPointer) this.place();
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
    window.addEventListener(
      'blur',
      () => {
        this.focused = false;
        this.freshPointer = false;
        this.freshConfirmKey = false;
        this.pose = undefined;
        this.ghost?.show();
      },
      options,
    );
    window.addEventListener(
      'focus',
      () => {
        this.focused = true;
      },
      options,
    );
    session.onStaticPlacementResult = (result) => {
      if (result.ok) this.close();
    };
  }
  get active() {
    return !!this.effect;
  }
  async open(effect: StaticPlacementEffect) {
    if (
      !this.available() ||
      this.session.staticPlacementPending ||
      this.session.state !== 'playing'
    )
      return;
    this.close();
    this.effect = effect;
    this.yawStep = 0;
    this.mode(true);
    this.panel.hidden = false;
    this.confirm.disabled = true;
    this.cancelButton.disabled = false;
    this.status.textContent = 'Загружаем модель…';
    const generation = ++this.generation;
    const controller = (this.controller = new AbortController());
    try {
      const descriptor = this.session.manifest.assets[effect.assetId];
      if (!descriptor) throw new Error('Missing static model');
      const bytes = await this.session.readStaticAsset(descriptor.modelFile, controller.signal);
      if (generation !== this.generation) return;
      const ghost = await this.view()!.createStaticGhost(bytes);
      if (generation !== this.generation) {
        ghost.dispose();
        return;
      }
      this.ghost = ghost;
      this.canvas.focus({ preventScroll: true });
    } catch (error) {
      if (generation === this.generation) {
        this.status.textContent = 'Не удалось загрузить модель. Откройте инструмент снова.';
        console.warn(error);
      }
    }
  }
  close() {
    const active = this.active;
    this.generation++;
    this.controller?.abort();
    this.controller = undefined;
    this.ghost?.dispose();
    this.ghost = undefined;
    this.effect = undefined;
    this.pose = undefined;
    this.freshPointer = false;
    this.freshConfirmKey = false;
    this.panel.hidden = true;
    this.confirm.disabled = true;
    if (active) this.mode(false);
  }
  rotate(direction: -1 | 1) {
    if (!this.active || this.session.staticPlacementPending || !this.focused) return;
    this.yawStep = (this.yawStep + direction + this.effect!.yawSteps) % this.effect!.yawSteps;
  }
  private place() {
    if (!this.pose || this.confirm.disabled || !this.focused || !this.available()) return;
    if (
      this.session.placeStatic({ x: this.pose.position.x, z: this.pose.position.z }, this.yawStep)
    ) {
      this.confirm.disabled = true;
      this.cancelButton.disabled = true;
      this.status.textContent = 'Сохраняем размещение…';
    }
  }
  frame() {
    if (!this.active) return;
    if (!this.available() || !['playing', 'waiting'].includes(this.session.state)) {
      this.close();
      return;
    }
    if (this.session.state === 'waiting') {
      this.confirm.disabled = true;
      return;
    }
    const view = this.view();
    if (!view || !this.ghost) return;
    const pending = this.session.staticPlacementPending;
    this.cancelButton.disabled = pending;
    if (pending) {
      this.confirm.disabled = true;
      this.status.textContent = 'Сохраняем размещение…';
      return;
    }
    const ray = view.pointerRay(),
      dy = ray.to.y - ray.from.y;
    const t = dy === 0 ? -1 : (this.effect!.groundY - ray.from.y) / dy;
    this.pose = undefined;
    if (t >= 0 && this.focused && !document.hidden) {
      const position = {
        x: ray.from.x + (ray.to.x - ray.from.x) * t,
        y: this.effect!.groundY,
        z: ray.from.z + (ray.to.z - ray.from.z) * t,
      };
      const rotation = staticPlacementRotation(this.yawStep);
      const bounds = buildingBounds(
        { entityId: 'preview', assetId: this.effect!.assetId, position, rotation },
        this.session.manifest.assets[this.effect!.assetId].bounds,
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
    this.status.textContent = this.pose
      ? 'Проверка места — при размещении'
      : 'Укажите место целиком в границах мира';
  }
  dispose() {
    this.close();
    this.listeners.abort();
    this.panel.remove();
  }
}
