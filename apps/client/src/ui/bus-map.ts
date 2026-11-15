import {
  busStopOrder,
  busTransferPath,
  busTripsFrom,
  type BusNetwork,
  type BusPoint,
  type BusRoute,
  type BusStop,
  type BusTrip,
} from '@su/contracts';
import { ICONS } from './icons';

/** Подложка карты: улицы и дома в границах мира (`content/.../bus-network/map.json`). */
export interface BusMapBackground {
  roads: { k: string; p: BusPoint[] }[];
  buildings: BusPoint[][];
}
export interface BusMapHost {
  network(): BusNetwork | undefined;
  /** Мировые границы X/Z: рамка «края мира» и начальный вид. */
  bounds(): { minX: number; maxX: number; minZ: number; maxZ: number };
  /** Подложка грузится один раз при первом открытии и не входит в основной бандл. */
  loadBackground(): Promise<BusMapBackground>;
  /** Отправляет поездку; false — запрос сейчас невозможен (ожидание, перезарядка). */
  travel(fromStopId: string, toStopId: string): boolean;
  travelStatus(): { pending: boolean; remainingMs: number };
  /** Открытие карты закрывает другие панели и отпускает ввод мира. */
  opened(): void;
  closed(): void;
}

const NS = 'http://www.w3.org/2000/svg';
const ROAD_WIDTH: Record<string, number> = {
  primary: 15,
  secondary: 13,
  tertiary: 11,
  unclassified: 8,
  residential: 7.5,
  living_street: 6,
  busway: 8,
  service: 4.5,
};
const HUB = 4;
const refOrder = (a: string, b: string) =>
  Number.parseInt(a, 10) - Number.parseInt(b, 10) || a.localeCompare(b);
const plural = (n: number, one: string, few: string, many: string) => {
  const m = n % 10,
    h = n % 100;
  return `${n} ${m === 1 && h !== 11 ? one : m >= 2 && m <= 4 && (h < 12 || h > 14) ? few : many}`;
};
const stops = (n: number) => plural(n, 'остановка', 'остановки', 'остановок');
const escapeHtml = (text: string) =>
  text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const svgEl = <K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number | undefined>,
  parent?: Element,
): SVGElementTagNameMap[K] => {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs))
    if (value !== undefined) node.setAttribute(key, String(value));
  parent?.append(node);
  return node;
};
const pathData = (pts: readonly BusPoint[]) =>
  'M' + pts.map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join('L');
const segmentKey = (a: BusPoint, b: BusPoint) => {
  const ka = `${a[0]},${a[1]}`,
    kb = `${b[0]},${b[1]}`;
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
};

/** Линии на общих улицах: место каждого маршрута в пучке и цвет без совпадений с соседями. */
class LineBundles {
  readonly slots = new Map<string, string[]>();
  readonly colors = new Map<string, number>();
  constructor(network: BusNetwork) {
    const sets = new Map<string, Set<string>>();
    for (const route of network.routes)
      for (const leg of route.legs)
        for (const piece of leg)
          for (let i = 1; i < piece.length; i++) {
            const key = segmentKey(piece[i - 1]!, piece[i]!);
            (sets.get(key) ?? sets.set(key, new Set()).get(key)!).add(route.ref);
          }
    for (const [key, refs] of sets) this.slots.set(key, [...refs].sort(refOrder));
    const refs = [...new Set(network.routes.map((r) => r.ref))];
    const conflict = new Map(refs.map((r) => [r, new Map<string, number>()]));
    for (const shared of sets.values())
      for (const x of shared)
        for (const y of shared)
          if (x !== y) conflict.get(x)!.set(y, (conflict.get(x)!.get(y) ?? 0) + 1);
    for (const ref of refs.sort((a, b) => conflict.get(b)!.size - conflict.get(a)!.size)) {
      const penalty = Array<number>(10).fill(0);
      for (const [other, weight] of conflict.get(ref)!) {
        const c = this.colors.get(other);
        if (c !== undefined) penalty[c]! += weight;
      }
      this.colors.set(ref, penalty.indexOf(Math.min(...penalty)));
    }
  }
  color(ref: string): string {
    return `var(--bus-l${this.colors.get(ref) ?? 0})`;
  }
  /**
   * Сдвиг линии от оси улицы по её месту в пучке. На крутых поворотах (кольцо) пучок
   * сжимается до 0,45 радиуса поворота, в вершинах смещения соседних отрезков усредняются.
   */
  offset(piece: readonly BusPoint[], ref: string, spacing: number): BusPoint[] {
    const n = piece.length;
    if (n < 2) return [...piece];
    const off: number[] = [],
      normal: BusPoint[] = [],
      length: number[] = [],
      dir: BusPoint[] = [];
    for (let i = 1; i < n; i++) {
      const a = piece[i - 1]!,
        b = piece[i]!;
      const list = this.slots.get(segmentKey(a, b)) ?? [ref];
      off.push((list.indexOf(ref) - (list.length - 1) / 2) * spacing);
      const [p, q] = `${a[0]},${a[1]}` < `${b[0]},${b[1]}` ? [a, b] : [b, a];
      const l = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
      normal.push([-(q[1] - p[1]) / l, (q[0] - p[0]) / l]);
      length.push(l);
      dir.push([(b[0] - a[0]) / l, (b[1] - a[1]) / l]);
    }
    const capAt = Array<number>(n).fill(Infinity);
    for (let j = 1; j < n - 1; j++) {
      const d1 = dir[j - 1]!,
        d2 = dir[j]!;
      const angle = Math.acos(Math.max(-1, Math.min(1, d1[0] * d2[0] + d1[1] * d2[1])));
      if (angle > 0.02) capAt[j] = (0.45 * ((length[j - 1]! + length[j]!) / 2)) / angle;
    }
    const cap = off.map((_, s) => Math.min(...capAt.slice(Math.max(0, s - 1), s + 3)));
    const shift = (s: number): BusPoint => {
      const o = Math.max(-cap[s]!, Math.min(cap[s]!, off[s]!));
      return [normal[s]![0] * o, normal[s]![1] * o];
    };
    return piece.map((p, j) => {
      const parts = [j - 1, j].filter((s) => s >= 0 && s < n - 1).map(shift);
      return [
        p[0] + parts.reduce((t, d) => t + d[0], 0) / parts.length,
        p[1] + parts.reduce((t, d) => t + d[1], 0) / parts.length,
      ] as BusPoint;
    });
  }
}

/**
 * Карта автобусов: открывается подсказкой у остановки. Видны только маршруты с этой
 * остановки; «Все маршруты» раскрывает остальную сеть. Выбор остановки показывает, на
 * каком автобусе и сколько ехать, или пересадку. Поездку проверяет и выполняет сервер.
 */
export class BusMapPanel {
  private readonly backdrop = document.createElement('div');
  private readonly dialog = document.createElement('section');
  private readonly subtitle = document.createElement('small');
  private readonly side = document.createElement('aside');
  private readonly svg = svgEl('svg', { role: 'img', 'aria-label': 'Карта автобусов по улицам' });
  private readonly root = svgEl('g', {});
  private readonly base = svgEl('g', {});
  private readonly lines = svgEl('g', {});
  private readonly stopsLayer = svgEl('g', {});
  private readonly ring = svgEl('circle', { class: 'bus-map-ring' });
  private readonly controller = new AbortController();
  private network?: BusNetwork;
  private bundles?: LineBundles;
  private routes = new Map<string, BusRoute>();
  private stopsById = new Map<string, BusStop>();
  private trips = new Map<string, Map<string, BusTrip[]>>();
  private here?: string;
  private target?: string;
  private next?: string;
  private line?: string;
  private all = false;
  private sending = false;
  private background?: Promise<void>;
  private view = { x: 0, y: 0, w: 1, h: 1 };
  private scale = 1;
  private redraw?: ReturnType<typeof setTimeout>;
  private readonly pointers = new Map<number, [number, number]>();
  private moved = 0;
  private pinch = 0;
  private resize?: ResizeObserver;
  private openedAt = 0;

  constructor(private readonly host: BusMapHost) {
    this.backdrop.className = 'bus-map-backdrop';
    this.backdrop.hidden = true;
    this.dialog.className = 'bus-map ui-panel';
    this.dialog.setAttribute('role', 'dialog');
    this.dialog.setAttribute('aria-modal', 'true');
    this.dialog.setAttribute('aria-labelledby', 'bus-map-title');
    const head = document.createElement('header');
    head.className = 'bus-map-head';
    head.innerHTML = `<span class="bus-map-sign" aria-hidden="true">${ICONS.bus}</span>`;
    const titles = document.createElement('div');
    const title = document.createElement('h2');
    title.id = 'bus-map-title';
    title.className = 'disp';
    title.textContent = 'Автобусы';
    titles.append(title, this.subtitle);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'ui-btn ui-icon-btn bus-map-close';
    close.setAttribute('aria-label', 'Закрыть карту автобусов');
    close.setAttribute('aria-keyshortcuts', 'Escape');
    close.innerHTML = ICONS.close;
    head.append(titles, close);
    const orn = document.createElement('div');
    orn.className = 'ui-orn';
    const body = document.createElement('div');
    body.className = 'bus-map-body';
    const mapBox = document.createElement('div');
    mapBox.className = 'bus-map-view';
    const zoom = document.createElement('div');
    zoom.className = 'bus-map-zoom';
    for (const [label, aria, action] of [
      ['+', 'Приблизить', () => this.zoomBy(0.65)],
      ['−', 'Отдалить', () => this.zoomBy(1.5)],
      ['⤢', 'Показать весь город', () => this.fit()],
    ] as const) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ui-btn ui-icon-btn';
      button.textContent = label;
      button.setAttribute('aria-label', aria);
      button.addEventListener('click', action);
      zoom.append(button);
    }
    this.root.append(this.base, this.lines, this.stopsLayer, this.ring);
    this.svg.append(this.root);
    mapBox.append(this.svg, zoom);
    this.side.className = 'bus-map-side';
    this.side.setAttribute('aria-live', 'polite');
    body.append(mapBox, this.side);
    this.dialog.append(orn, head, body);
    this.backdrop.append(this.dialog);
    document.body.append(this.backdrop);

    const options = { signal: this.controller.signal };
    close.addEventListener('click', () => this.close(), options);
    this.backdrop.addEventListener(
      'pointerdown',
      (event) => event.target === this.backdrop && this.close(),
      options,
    );
    window.addEventListener(
      'keydown',
      (event) => {
        // Та же нажатая Z, что открыла карту, не должна сразу отправить поездку.
        if (this.backdrop.hidden || event.repeat || performance.now() - this.openedAt < 250) return;
        if (event.code === 'Escape') {
          event.preventDefault();
          if (this.target || this.line) {
            this.target = this.line = undefined;
            this.paint();
          } else this.close();
        } else if (event.code === 'KeyZ' && !event.ctrlKey && !event.metaKey && !event.altKey) {
          const go = this.side.querySelector<HTMLButtonElement>('[data-go]');
          if (go && !go.disabled) {
            event.preventDefault();
            go.click();
          }
        }
      },
      options,
    );
    this.bindPointer(options);
  }

  get visible(): boolean {
    return !this.backdrop.hidden;
  }

  /** Открывает карту у остановки `stopId`; `target` — уже выбранная цель (после пересадки). */
  open(stopId: string, target?: string): void {
    const network = this.host.network();
    if (!network || !network.stops.some((s) => s.id === stopId)) return;
    if (network !== this.network) this.setNetwork(network);
    this.host.opened();
    this.here = stopId;
    this.target = target && target !== stopId ? target : undefined;
    this.line = undefined;
    this.sending = false;
    this.backdrop.hidden = false;
    this.openedAt = performance.now();
    this.resize ??= new ResizeObserver(() => this.applyView());
    this.resize.observe(this.svg);
    this.fit();
    this.draw();
    this.background ??= this.host.loadBackground().then(
      (data) => this.drawBackground(data),
      () => undefined,
    );
    this.side.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
  }

  close(): void {
    if (this.backdrop.hidden) return;
    this.backdrop.hidden = true;
    this.next = undefined;
    this.resize?.disconnect();
    this.host.closed();
  }

  /** Итог поездки от сервера: успех закрывает карту, после пересадки открывает её снова. */
  travelResult(ok: boolean): void {
    if (!this.sending) return;
    this.sending = false;
    const arrived = this.target;
    const next = this.next;
    if (ok) {
      this.close();
      if (arrived && next && next !== arrived) this.open(arrived, next);
      return;
    }
    this.next = undefined;
    if (this.visible) this.paint();
  }

  dispose(): void {
    this.controller.abort();
    this.resize?.disconnect();
    clearTimeout(this.redraw);
    this.backdrop.remove();
  }

  private setNetwork(network: BusNetwork): void {
    this.network = network;
    this.bundles = new LineBundles(network);
    this.routes = new Map(network.routes.map((r) => [r.ref, r]));
    this.stopsById = new Map(network.stops.map((s) => [s.id, s]));
    this.trips = new Map(network.stops.map((s) => [s.id, busTripsFrom(network, s.id)]));
  }

  // ---------- рисование ----------

  private drawBackground(data: BusMapBackground): void {
    this.base.textContent = '';
    if (data.buildings.length)
      svgEl(
        'path',
        { class: 'bus-map-bld', d: data.buildings.map((b) => pathData(b) + 'Z').join('') },
        this.base,
      );
    const kinds = Object.keys(ROAD_WIDTH).reverse();
    for (const layer of ['bus-map-road-case', 'bus-map-road'])
      for (const kind of kinds) {
        const d = data.roads
          .filter((r) => r.k === kind)
          .map((r) => pathData(r.p))
          .join('');
        if (d)
          svgEl(
            'path',
            {
              class: layer,
              d,
              'stroke-width': ROAD_WIDTH[kind]! + (layer === 'bus-map-road-case' ? 3 : 0),
            },
            this.base,
          );
      }
    this.drawEdge();
  }

  private drawEdge(): void {
    const b = this.host.bounds();
    const m = 3000;
    svgEl(
      'path',
      {
        class: 'bus-map-outside',
        'fill-rule': 'evenodd',
        d: `M${b.minX - m} ${b.minZ - m}H${b.maxX + m}V${b.maxZ + m}H${b.minX - m}Z M${b.minX} ${b.minZ}V${b.maxZ}H${b.maxX}V${b.minZ}Z`,
      },
      this.base,
    );
    svgEl(
      'rect',
      {
        class: 'bus-map-edge',
        x: b.minX,
        y: b.minZ,
        width: b.maxX - b.minX,
        height: b.maxZ - b.minZ,
      },
      this.base,
    );
  }

  private draw(): void {
    if (!this.network || !this.bundles) return;
    if (!this.base.childElementCount) this.drawEdge();
    this.lines.textContent = '';
    const width = Math.max(3.5 / this.scale, 3.2);
    const spacing = Math.max(4.4 / this.scale, 4);
    for (const route of this.network.routes) {
      const d = route.legs
        .flatMap((leg) =>
          leg.map((piece) => pathData(this.bundles!.offset(piece, route.ref, spacing))),
        )
        .join('');
      if (d)
        svgEl(
          'path',
          {
            class: 'bus-map-line',
            d,
            stroke: this.bundles.color(route.ref),
            'stroke-width': width,
            'data-ref': route.ref,
          },
          this.lines,
        );
    }
    this.stopsLayer.textContent = '';
    for (const stop of this.network.stops) {
      const [x, y] = stop.position;
      const r = this.radius(stop);
      const g = svgEl(
        'g',
        {
          class: 'bus-map-stop' + (stop.source === 'interpolated' ? ' approx' : ''),
          'data-stop': stop.id,
          tabindex: 0,
          role: 'button',
          'aria-label': stop.name,
        },
        this.stopsLayer,
      );
      svgEl('circle', { class: 'hit', cx: x, cy: y, r: r + 9 / this.scale }, g);
      svgEl('circle', { class: 'dot', cx: x, cy: y, r, 'stroke-width': 2.2 / this.scale }, g);
      svgEl(
        'text',
        { x, y, 'font-size': 12.5 / this.scale, 'stroke-width': 4 / this.scale },
        g,
      ).textContent = stop.name;
    }
    this.placeLabels();
    this.paint();
  }

  private radius(stop: BusStop): number {
    return (stop.routes.length >= HUB ? 6.5 : 4.8) / this.scale;
  }

  /** Подписи по 8 позициям; без места мелкая остановка остаётся без подписи до приближения. */
  private placeLabels(): void {
    if (!this.network) return;
    const must = new Set([this.here, this.target]);
    const boxes: { x: number; y: number; w: number; h: number }[] = [];
    const circles = this.network.stops.map((s) => {
      const r = this.radius(s);
      return { id: s.id, x: s.position[0] - r, y: s.position[1] - r, w: 2 * r, h: 2 * r };
    });
    const hit = (a: (typeof boxes)[number], b: (typeof boxes)[number]) =>
      a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    const order = [...this.network.stops].sort(
      (a, b) =>
        Number(must.has(b.id)) - Number(must.has(a.id)) || b.routes.length - a.routes.length,
    );
    for (const stop of order) {
      const text = this.stopsLayer.querySelector<SVGTextElement>(`[data-stop="${stop.id}"] text`);
      if (!text) continue;
      text.style.display = '';
      const [x, y] = stop.position;
      const r = this.radius(stop) + 3.5 / this.scale;
      const w = text.getComputedTextLength() + 3 / this.scale;
      const h = 16 / this.scale;
      let best: (typeof boxes)[number] | undefined;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, -1],
        [0, 1],
        [1, -1],
        [-1, -1],
        [1, 1],
        [-1, 1],
      ] as const) {
        const k = dx && dy ? 0.72 : 1;
        const ax = x + dx * r * k,
          ay = y + dy * r * k;
        const box = {
          x: dx > 0 ? ax : dx < 0 ? ax - w : ax - w / 2,
          y: dy > 0 ? ay : dy < 0 ? ay - h : ay - h / 2,
          w,
          h,
        };
        if (boxes.some((o) => hit(box, o)) || circles.some((o) => o.id !== stop.id && hit(box, o)))
          continue;
        best = box;
        break;
      }
      if (!best && must.has(stop.id)) best = { x: x + r, y: y - h / 2, w, h };
      text.style.display = best ? '' : 'none';
      if (!best) continue;
      boxes.push(best);
      text.setAttribute('x', String(best.x + 1.5 / this.scale));
      text.setAttribute('y', String(best.y + h - 4 / this.scale));
    }
  }

  /** Подсветка без перерисовки: видимые маршруты, доступные остановки, «вы здесь». */
  private paint(): void {
    if (!this.network || !this.here) return;
    const reach = this.trips.get(this.here) ?? new Map<string, BusTrip[]>();
    const on = new Set<string>();
    if (this.line) on.add(this.line);
    else if (this.target && reach.has(this.target))
      reach.get(this.target)!.forEach((t) => on.add(t.ref));
    else this.stopsById.get(this.here)?.routes.forEach((r) => on.add(r));
    this.root.classList.toggle('all', this.all);
    this.lines
      .querySelectorAll<SVGPathElement>('.bus-map-line')
      .forEach((p) => p.classList.toggle('on', on.has(p.dataset.ref!)));
    const lineStops = this.line
      ? new Set(busStopOrder(this.routes.get(this.line)!).filter(Boolean))
      : undefined;
    this.stopsLayer.querySelectorAll<SVGGElement>('.bus-map-stop').forEach((g) => {
      const id = g.dataset.stop!;
      const ok = lineStops ? lineStops.has(id) : reach.has(id) || id === this.here;
      g.classList.toggle('far', !ok);
      g.classList.toggle('here', id === this.here);
      g.classList.toggle('target', id === this.target);
    });
    const [hx, hy] = this.stopsById.get(this.here)!.position;
    this.ring.setAttribute('cx', String(hx));
    this.ring.setAttribute('cy', String(hy));
    this.ring.setAttribute('r', String(10 / this.scale));
    this.ring.setAttribute('stroke-width', String(3 / this.scale));
    const stop = this.stopsById.get(this.here)!;
    this.subtitle.textContent = `Остановка «${stop.name}» · ${plural(stop.routes.length, 'маршрут', 'маршрута', 'маршрутов')}`;
    this.renderSide(reach);
  }

  // ---------- боковая колонка ----------

  private chip(ref: string, button = false): string {
    const color = this.bundles!.color(ref);
    return button
      ? `<button class="ui-btn bus-chip" type="button" data-line="${ref}" style="--c:${color}" aria-pressed="${this.line === ref}">${ref}</button>`
      : `<span class="bus-chip sm" style="--c:${color}">${ref}</span>`;
  }

  private renderSide(reach: Map<string, BusTrip[]>): void {
    const here = this.stopsById.get(this.here!)!;
    const name = (id: string) => escapeHtml(this.stopsById.get(id)?.name ?? id);
    const status = this.host.travelStatus();
    const busy = this.sending || status.pending;
    let html = `<div class="bus-here"><div class="bus-eyebrow">Вы на остановке</div><h3 class="disp">${escapeHtml(here.name)}</h3></div>
      <div class="bus-chips" role="group" aria-label="Маршруты с остановки">${here.routes.map((r) => this.chip(r, true)).join('')}</div>`;
    if (this.line) {
      const route = this.routes.get(this.line)!;
      const names = route.sequence.map((e) =>
        typeof e === 'string'
          ? `<b>${name(e)}</b>`
          : `<span class="bus-mut">за краем: ${stops(e.offWorld.length)}</span>`,
      );
      html += `<div class="bus-card"><h3 class="disp">${this.chip(this.line)} ${escapeHtml(route.name)}</h3>
        <p class="bus-note">${route.circular ? 'Кольцевой.' : 'Ходит в обе стороны.'} ${names.join(' → ')}</p>
        <button class="ui-link" type="button" data-act="clear">Все маршруты с остановки</button></div>`;
    } else if (this.target) {
      const target = this.stopsById.get(this.target)!;
      const options = reach.get(this.target);
      html += `<div class="bus-card"><div><div class="bus-eyebrow">Куда</div><h3 class="disp">${escapeHtml(target.name)}</h3>${
        target.source === 'interpolated'
          ? '<div class="bus-flag">Место остановки примерное</div>'
          : ''
      }</div>`;
      if (options) {
        html += options
          .map(
            (t) =>
              `<div class="bus-opt">${this.chip(t.ref)}<p>в сторону «${escapeHtml(t.towards)}», ${stops(t.steps)}${
                t.leaves ? '<br><span class="bus-mut">часть пути за краем мира</span>' : ''
              }</p></div>`,
          )
          .join('');
        html += `<button class="ui-btn ui-pri bus-go disp" type="button" data-go="${this.target}"${busy ? ' disabled' : ''}>${
          this.sending ? 'Едем…' : `Поехать на ${options[0]!.ref}`
        }<span class="k" aria-hidden="true">Z</span></button>`;
      } else {
        const path = busTransferPath(this.network!, this.here!, this.target);
        html += '<p class="bus-note">Прямого автобуса отсюда нет.</p>';
        if (path) {
          html +=
            '<div class="bus-eyebrow">С пересадкой</div>' +
            path
              .slice(1)
              .map(
                (s, i) =>
                  `<div class="bus-opt">${this.chip(this.trips.get(path[i]!)!.get(s)![0]!.ref)}<p>до «${name(s)}»</p></div>`,
              )
              .join('') +
            `<button class="ui-btn ui-pri bus-go disp" type="button" data-go="${path[1]}" data-next="${this.target}"${busy ? ' disabled' : ''}>${
              this.sending ? 'Едем…' : `Поехать до «${name(path[1]!)}»`
            }<span class="k" aria-hidden="true">Z</span></button>`;
        } else html += '<p class="bus-note">Туда не доехать даже с пересадкой.</p>';
      }
      html += '</div>';
    } else {
      const items = [...reach.entries()].sort((a, b) => a[1][0]!.steps - b[1][0]!.steps);
      html += `<p class="bus-note">Выберите остановку на карте. Яркие — куда можно уехать отсюда без пересадки.</p>
        <div><div class="bus-eyebrow">Без пересадки · ${items.length}</div><ul class="bus-dest">${items
          .map(
            ([id, trips]) =>
              `<li><button type="button" data-stop="${id}"><span>${name(id)}</span><span class="bus-chips">${[
                ...new Set(trips.map((t) => t.ref)),
              ]
                .slice(0, 4)
                .map((r) => this.chip(r))
                .join('')}</span></button></li>`,
          )
          .join('')}</ul></div>`;
    }
    const refs = [...this.routes.keys()].sort(refOrder);
    html += `<button class="ui-btn bus-more" type="button" data-act="all" aria-expanded="${this.all}" aria-controls="bus-all-routes"><span>Все маршруты · ${refs.length}</span><span aria-hidden="true">›</span></button>
      <div class="bus-chips" id="bus-all-routes"${this.all ? '' : ' hidden'}>${refs.map((r) => this.chip(r, true)).join('')}</div>
      <p class="bus-note"><b>Правило.</b> Уехать можно только на автобусе, который останавливается здесь, и только туда, где он проходит.</p>
      <p class="bus-note bus-credit">Маршруты — «Транспорт 11», улицы и дома — © участники OpenStreetMap (ODbL).</p>`;
    this.side.innerHTML = html;
    this.side.querySelectorAll<HTMLButtonElement>('[data-line]').forEach((b) =>
      b.addEventListener('click', () => {
        this.line = this.line === b.dataset.line ? undefined : b.dataset.line;
        this.target = undefined;
        this.paint();
      }),
    );
    this.side
      .querySelectorAll<HTMLButtonElement>('[data-stop]')
      .forEach((b) => b.addEventListener('click', () => this.choose(b.dataset.stop!)));
    this.side.querySelector('[data-act="clear"]')?.addEventListener('click', () => {
      this.line = undefined;
      this.paint();
    });
    this.side.querySelector('[data-act="all"]')?.addEventListener('click', () => {
      this.all = !this.all;
      this.paint();
      this.side.querySelector<HTMLElement>('[data-act="all"]')?.focus();
    });
    this.side.querySelector<HTMLButtonElement>('[data-go]')?.addEventListener('click', (event) => {
      const button = event.currentTarget as HTMLButtonElement;
      const to = button.dataset.go!;
      if (!this.here || !this.host.travel(this.here, to)) return;
      this.sending = true;
      this.next = button.dataset.next;
      this.target = to;
      this.paint();
    });
  }

  private choose(id: string): void {
    if (this.sending) return;
    this.target = id === this.here ? undefined : id;
    this.line = undefined;
    this.placeLabels();
    this.paint();
  }

  // ---------- вид, перетаскивание, масштаб ----------

  private fit(): void {
    const b = this.host.bounds();
    this.view = {
      x: b.minX - 30,
      y: b.minZ - 30,
      w: b.maxX - b.minX + 60,
      h: b.maxZ - b.minZ + 60,
    };
    this.applyView();
  }

  private applyView(): void {
    const rect = this.svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const aspect = rect.width / rect.height;
    let { x, y, w, h } = this.view;
    if (Math.abs(w / h - aspect) > 1e-6) {
      if (w / h < aspect) {
        const nw = h * aspect;
        x -= (nw - w) / 2;
        w = nw;
      } else {
        const nh = w / aspect;
        y -= (nh - h) / 2;
        h = nh;
      }
    }
    this.view = { x, y, w, h };
    this.svg.setAttribute('viewBox', `${x} ${y} ${w} ${h}`);
    const scale = rect.width / w;
    if (Math.abs(scale - this.scale) / this.scale > 0.02) {
      this.scale = scale;
      clearTimeout(this.redraw);
      this.redraw = setTimeout(() => this.draw(), 70);
    }
  }

  private zoomBy(
    factor: number,
    cx = this.view.x + this.view.w / 2,
    cy = this.view.y + this.view.h / 2,
  ): void {
    const b = this.host.bounds();
    const width = Math.min((b.maxX - b.minX) * 1.4, Math.max(220, this.view.w * factor));
    const k = width / this.view.w;
    this.view = {
      x: cx - (cx - this.view.x) * k,
      y: cy - (cy - this.view.y) * k,
      w: this.view.w * k,
      h: this.view.h * k,
    };
    this.applyView();
  }

  private toMap(clientX: number, clientY: number): [number, number] {
    const rect = this.svg.getBoundingClientRect();
    return [
      this.view.x + ((clientX - rect.left) / rect.width) * this.view.w,
      this.view.y + ((clientY - rect.top) / rect.height) * this.view.h,
    ];
  }

  private bindPointer(options: AddEventListenerOptions): void {
    const svg = this.svg;
    svg.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        const [x, y] = this.toMap(event.clientX, event.clientY);
        this.zoomBy(Math.exp(event.deltaY * 0.0015), x, y);
      },
      { ...options, passive: false },
    );
    svg.addEventListener(
      'pointerdown',
      (event) => {
        this.pointers.set(event.pointerId, [event.clientX, event.clientY]);
        this.moved = 0;
        if (this.pointers.size === 2) {
          const [a, b] = [...this.pointers.values()];
          this.pinch = Math.hypot(a![0] - b![0], a![1] - b![1]);
        }
      },
      options,
    );
    svg.addEventListener(
      'pointermove',
      (event) => {
        const previous = this.pointers.get(event.pointerId);
        if (!previous) return;
        this.pointers.set(event.pointerId, [event.clientX, event.clientY]);
        const rect = svg.getBoundingClientRect();
        if (this.pointers.size === 1) {
          const dx = event.clientX - previous[0],
            dy = event.clientY - previous[1];
          this.moved += Math.abs(dx) + Math.abs(dy);
          if (this.moved > 4) {
            svg.classList.add('drag');
            svg.setPointerCapture?.(event.pointerId);
          }
          this.view = {
            ...this.view,
            x: this.view.x - (dx / rect.width) * this.view.w,
            y: this.view.y - (dy / rect.height) * this.view.h,
          };
          this.applyView();
        } else if (this.pointers.size === 2 && this.pinch) {
          const [a, b] = [...this.pointers.values()];
          const d = Math.hypot(a![0] - b![0], a![1] - b![1]);
          const [cx, cy] = this.toMap((a![0] + b![0]) / 2, (a![1] + b![1]) / 2);
          this.zoomBy(this.pinch / d, cx, cy);
          this.pinch = d;
          this.moved = 99;
        }
      },
      options,
    );
    const up = (event: PointerEvent) => {
      this.pointers.delete(event.pointerId);
      if (this.pointers.size < 2) this.pinch = 0;
      svg.classList.remove('drag');
    };
    svg.addEventListener('pointerup', up, options);
    svg.addEventListener('pointercancel', up, options);
    svg.addEventListener(
      'click',
      (event) => {
        if (this.moved > 6) return;
        const stop = (event.target as Element).closest<SVGGElement>('[data-stop]');
        if (stop) this.choose(stop.dataset.stop!);
      },
      options,
    );
    svg.addEventListener(
      'keydown',
      (event) => {
        const stop = (event.target as Element).closest?.<SVGGElement>('[data-stop]');
        if (stop && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          this.choose(stop.dataset.stop!);
        }
      },
      options,
    );
  }
}
