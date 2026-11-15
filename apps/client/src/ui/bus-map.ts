import {
  busOppositePlatformTrips,
  busPlatformById,
  busStopOrder,
  busTransferPath,
  busTripsFrom,
  type BusNetwork,
  type BusPlatform,
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
  /** Отправляет поездку с платформы на платформу по рейсу; false — запрос сейчас невозможен. */
  travel(
    fromPlatformId: string,
    toPlatformId: string,
    routeId: string,
    directionIndex: number,
  ): boolean;
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
/** Максимальный суммарный разброс пучка линий поперёк дороги (внутри полотна артериальной улицы). */
const MAX_BUNDLE_SPAN = 11;
const MAX_VERTEX_OFFSET = 6.5;
const refOrder = (a: string, b: string) =>
  Number.parseInt(a, 10) - Number.parseInt(b, 10) || a.localeCompare(b);
const canonicalPair = (a: BusPoint, b: BusPoint): [BusPoint, BusPoint] =>
  a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]) ? [a, b] : [b, a];
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
  const [p, q] = canonicalPair(a, b);
  return `${p[0]},${p[1]}|${q[0]},${q[1]}`;
};

const routePieces = (route: BusRoute): BusPoint[][] => {
  const pieces: BusPoint[][] = [];
  for (const dir of route.directions)
    for (const leg of dir.legs) for (const piece of leg) pieces.push(piece);
  return pieces;
};

/** Линии на общих улицах: место каждого маршрута в пучке и цвет без совпадений с соседями. */
export class LineBundles {
  readonly slots = new Map<string, string[]>();
  readonly colors = new Map<string, number>();

  constructor(network: BusNetwork) {
    const sets = this.collectSegments(network.routes);
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

  /** Вычисляет пучки только для указанного видимого подмножества маршрутов. */
  slotsFor(routes: readonly BusRoute[]): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const [key, refs] of this.collectSegments(routes)) out.set(key, [...refs].sort(refOrder));
    return out;
  }

  private collectSegments(routes: readonly BusRoute[]): Map<string, Set<string>> {
    const sets = new Map<string, Set<string>>();
    for (const route of routes)
      for (const piece of routePieces(route))
        for (let i = 1; i < piece.length; i++) {
          const key = segmentKey(piece[i - 1]!, piece[i]!);
          (sets.get(key) ?? sets.set(key, new Set()).get(key)!).add(route.ref);
        }
    return sets;
  }

  color(ref: string): string {
    return `var(--bus-l${this.colors.get(ref) ?? 0})`;
  }

  /** Общий отрезок встречных направлений рисуется один раз, даже при разбиении на разные legs. */
  paths(route: BusRoute, spacing: number, slots: ReadonlyMap<string, string[]>): BusPoint[][] {
    const seen = new Set<string>();
    const paths: BusPoint[][] = [];
    for (const piece of routePieces(route)) {
      const shifted = this.offset(piece, route.ref, spacing, slots);
      let path: BusPoint[] = [];
      const flush = () => {
        if (path.length > 1) paths.push(path);
        path = [];
      };
      for (let i = 1; i < piece.length; i++) {
        const key = segmentKey(piece[i - 1]!, piece[i]!);
        if (seen.has(key)) {
          flush();
          continue;
        }
        seen.add(key);
        if (!path.length) path.push(shifted[i - 1]!);
        path.push(shifted[i]!);
      }
      flush();
    }
    return paths;
  }

  /**
   * Сдвиг линии от оси улицы по её месту в пучке. Числовое сравнение концов отрезка
   * не даёт разворотов на границах разрядов, разброс пучка ограничен шириной дороги.
   */
  offset(
    piece: readonly BusPoint[],
    ref: string,
    spacing: number,
    slots: ReadonlyMap<string, string[]> = this.slots,
  ): BusPoint[] {
    const n = piece.length;
    if (n < 2) return [...piece];
    const off: number[] = [],
      normal: BusPoint[] = [],
      length: number[] = [],
      dir: BusPoint[] = [];
    for (let i = 1; i < n; i++) {
      const a = piece[i - 1]!,
        b = piece[i]!;
      const list = slots.get(segmentKey(a, b)) ?? [ref];
      const idx = list.indexOf(ref);
      const rank = idx >= 0 ? idx - (list.length - 1) / 2 : 0;
      const effSpacing =
        list.length > 1 ? Math.min(spacing, MAX_BUNDLE_SPAN / (list.length - 1)) : 0;
      off.push(rank * effSpacing);
      const [p, q] = canonicalPair(a, b);
      const l = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
      normal.push([-(q[1] - p[1]) / l, (q[0] - p[0]) / l]);
      length.push(l);
      dir.push([(b[0] - a[0]) / l, (b[1] - a[1]) / l]);
    }
    const capAt = Array<number>(n).fill(MAX_VERTEX_OFFSET);
    for (let j = 1; j < n - 1; j++) {
      const d1 = dir[j - 1]!,
        d2 = dir[j]!;
      const angle = Math.acos(Math.max(-1, Math.min(1, d1[0] * d2[0] + d1[1] * d2[1])));
      if (angle > 0.02)
        capAt[j] = Math.min(
          MAX_VERTEX_OFFSET,
          (0.45 * ((length[j - 1]! + length[j]!) / 2)) / angle,
        );
    }
    const cap = off.map((_, s) => Math.min(...capAt.slice(Math.max(0, s - 1), s + 3)));
    const shift = (s: number): BusPoint => {
      const o = Math.max(-cap[s]!, Math.min(cap[s]!, off[s]!));
      return [normal[s]![0] * o, normal[s]![1] * o];
    };
    return piece.map((p, j) => {
      const parts = [j - 1, j].filter((s) => s >= 0 && s < n - 1).map(shift);
      let dx = parts.reduce((t, d) => t + d[0], 0) / parts.length;
      let dz = parts.reduce((t, d) => t + d[1], 0) / parts.length;
      const mag = Math.hypot(dx, dz);
      if (mag > MAX_VERTEX_OFFSET) {
        dx = (dx / mag) * MAX_VERTEX_OFFSET;
        dz = (dz / mag) * MAX_VERTEX_OFFSET;
      }
      return [p[0] + dx, p[1] + dz] as BusPoint;
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
  private herePlatform?: string;
  private target?: string;
  private pickedTripIdx = 0;
  private next?: string;
  private pendingToPlatform?: string;
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

  /** Открывает карту у платформы `platformOrStopId`; `target` — цель (после пересадки). */
  open(platformOrStopId: string, target?: string): void {
    const network = this.host.network();
    if (!network) return;
    const byPlat = busPlatformById(network, platformOrStopId);
    const stop = byPlat?.stop ?? network.stops.find((s) => s.id === platformOrStopId);
    const platform = byPlat?.platform ?? stop?.platforms[0];
    if (!stop || !platform) return;
    if (network !== this.network) this.setNetwork(network);
    this.host.opened();
    this.here = stop.id;
    this.herePlatform = platform.id;
    this.target = target && target !== stop.id ? target : undefined;
    this.pickedTripIdx = 0;
    this.line = undefined;
    this.sending = false;
    this.pendingToPlatform = undefined;
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
    this.pendingToPlatform = undefined;
    this.resize?.disconnect();
    this.host.closed();
  }

  /** Итог поездки от сервера: успех закрывает карту, после пересадки открывает её снова. */
  travelResult(ok: boolean): void {
    if (!this.sending) return;
    this.sending = false;
    const arrivedPlatform = this.pendingToPlatform;
    const next = this.next;
    this.pendingToPlatform = undefined;
    if (ok) {
      this.close();
      if (
        arrivedPlatform &&
        next &&
        busPlatformById(this.network!, arrivedPlatform)?.stop.id !== next
      )
        this.open(arrivedPlatform, next);
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
    this.trips.clear();
  }

  private tripsFor(platformId: string): Map<string, BusTrip[]> {
    let map = this.trips.get(platformId);
    if (!map && this.network) {
      map = busTripsFrom(this.network, platformId);
      this.trips.set(platformId, map);
    }
    return map ?? new Map();
  }

  private platformRefs(platformId: string): string[] {
    if (!this.network) return [];
    const refs: string[] = [];
    for (const route of this.network.routes) {
      const stopsHere = route.directions.some((dir) =>
        dir.sequence.some((entry) => 'platformId' in entry && entry.platformId === platformId),
      );
      if (stopsHere) refs.push(route.ref);
    }
    return refs.sort(refOrder);
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
    this.stopsLayer.textContent = '';
    for (const stop of this.network.stops) {
      const [x, y] = stop.position;
      const r = this.radius(stop);
      const pr = Math.max(2.1 / this.scale, r * 0.45);
      const g = svgEl(
        'g',
        {
          class: 'bus-map-stop',
          'data-stop': stop.id,
          tabindex: 0,
          role: 'button',
          'aria-label': stop.name,
        },
        this.stopsLayer,
      );
      svgEl('circle', { class: 'hit', cx: x, cy: y, r: r + 9 / this.scale }, g);
      svgEl('circle', { class: 'dot', cx: x, cy: y, r, 'stroke-width': 2.2 / this.scale }, g);
      for (const plat of stop.platforms) {
        svgEl(
          'circle',
          {
            class: 'bus-map-plat',
            'data-plat': plat.id,
            cx: plat.position[0],
            cy: plat.position[1],
            r: pr,
            'stroke-width': 1.4 / this.scale,
          },
          g,
        );
      }
      svgEl(
        'text',
        { x, y, 'font-size': 12.5 / this.scale, 'stroke-width': 4 / this.scale },
        g,
      ).textContent = stop.name;
    }
    this.placeLabels();
    this.paint();
  }

  private drawLines(on: ReadonlySet<string>, chosenTrip?: BusTrip): void {
    if (!this.network || !this.bundles) return;
    this.lines.textContent = '';
    const visibleRoutes = this.all
      ? this.network.routes
      : this.network.routes.filter((r) => on.has(r.ref));
    const slots = this.bundles.slotsFor(visibleRoutes);
    const width = Math.min(7.5, Math.max(2.4 / this.scale, 2.2));
    const spacing = Math.max(3.2 / this.scale, 2.6);
    const ordered = [
      ...visibleRoutes.filter((r) => !on.has(r.ref)),
      ...visibleRoutes.filter((r) => on.has(r.ref)),
    ];
    for (const route of ordered) {
      const active = on.has(route.ref);
      const d = this.bundles.paths(route, spacing, slots).map(pathData).join('');
      if (!d) continue;
      svgEl(
        'path',
        {
          class: active ? 'bus-map-line on' : 'bus-map-line',
          d,
          stroke: this.bundles.color(route.ref),
          'stroke-width': active ? width * 1.1 : width * 0.9,
          'data-ref': route.ref,
        },
        this.lines,
      );

      // На активном выбранном маршруте или рейсе рисуем стрелки направления движения.
      const showDirs =
        this.line === route.ref
          ? route.directions
          : chosenTrip && chosenTrip.routeId === route.id
            ? [route.directions[chosenTrip.directionIndex]!]
            : [];
      for (const dir of showDirs) {
        if (!dir) continue;
        this.drawArrows(dir.legs, route.ref, spacing, slots, this.bundles.color(route.ref), width);
      }
    }
  }

  private drawArrows(
    legs: readonly BusPoint[][][],
    ref: string,
    spacing: number,
    slots: ReadonlyMap<string, string[]>,
    color: string,
    width: number,
  ): void {
    const arrowLen = Math.max(width * 1.35, Math.min(9, 4.5 / this.scale));
    let acc = 120;
    const cmds: string[] = [];
    for (const leg of legs) {
      for (const piece of leg) {
        const pts = this.bundles!.offset(piece, ref, spacing, slots);
        for (let i = 1; i < pts.length; i++) {
          const a = pts[i - 1]!,
            b = pts[i]!;
          const segLen = Math.hypot(b[0] - a[0], b[1] - a[1]);
          acc += segLen;
          if (acc < 240 || segLen < Math.max(14, arrowLen * 2)) continue;
          acc = 0;
          const mx = (a[0] + b[0]) / 2,
            mz = (a[1] + b[1]) / 2;
          const ux = (b[0] - a[0]) / segLen,
            uz = (b[1] - a[1]) / segLen;
          const px = -uz,
            pz = ux;
          const backX = mx - ux * arrowLen,
            backZ = mz - uz * arrowLen;
          cmds.push(
            `M${(backX + px * arrowLen * 0.72).toFixed(1)} ${(backZ + pz * arrowLen * 0.72).toFixed(1)}` +
              `L${mx.toFixed(1)} ${mz.toFixed(1)}` +
              `L${(backX - px * arrowLen * 0.72).toFixed(1)} ${(backZ - pz * arrowLen * 0.72).toFixed(1)}`,
          );
        }
      }
    }
    if (cmds.length)
      svgEl(
        'path',
        {
          class: 'bus-map-arrow',
          d: cmds.join(''),
          stroke: color,
          'stroke-width': Math.max(1.8, width * 0.55),
        },
        this.lines,
      );
  }

  private radius(stop: BusStop): number {
    return (stop.routes.length >= HUB ? 6.5 : 4.8) / this.scale;
  }

  /** Подписи по 8 позициям с удержанием внутри видимой области и без наложений. */
  private placeLabels(): void {
    if (!this.network) return;
    const b = this.host.bounds();
    const pad = 6 / this.scale;
    const clip =
      this.view.w > 1 && this.view.h > 1
        ? {
            x0: this.view.x + pad,
            x1: this.view.x + this.view.w - pad,
            y0: this.view.y + pad,
            y1: this.view.y + this.view.h - pad,
          }
        : { x0: b.minX - 24, x1: b.maxX + 24, y0: b.minZ - 24, y1: b.maxZ + 24 };
    const must = new Set([this.here, this.target]);
    const boxes: { x: number; y: number; w: number; h: number }[] = [];
    const circles = this.network.stops.map((s) => {
      const r = this.radius(s);
      return { id: s.id, x: s.position[0] - r, y: s.position[1] - r, w: 2 * r, h: 2 * r };
    });
    const hit = (a: (typeof boxes)[number], c: (typeof boxes)[number]) =>
      a.x < c.x + c.w && c.x < a.x + a.w && a.y < c.y + c.h && c.y < a.y + a.h;
    const overflow = (box: (typeof boxes)[number]) =>
      Math.max(0, clip.x0 - box.x) +
      Math.max(0, box.x + box.w - clip.x1) +
      Math.max(0, clip.y0 - box.y) +
      Math.max(0, box.y + box.h - clip.y1);
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
      const measured =
        typeof text.getComputedTextLength === 'function' ? text.getComputedTextLength() : 0;
      const w = (measured > 0 ? measured : (stop.name.length * 7.2) / this.scale) + 3 / this.scale;
      const h = 16 / this.scale;
      let best: (typeof boxes)[number] | undefined;
      let bestScore: [number, number] | undefined;
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
        const overlaps =
          boxes.filter((o) => hit(box, o)).length +
          circles.filter((o) => o.id !== stop.id && hit(box, o)).length;
        const out = overflow(box);
        if (overlaps === 0 && out === 0) {
          best = box;
          break;
        }
        if (must.has(stop.id)) {
          if (
            !bestScore ||
            overlaps < bestScore[0] ||
            (overlaps === bestScore[0] && out < bestScore[1])
          ) {
            bestScore = [overlaps, out];
            best = box;
          }
        }
      }
      if (best && overflow(best) > 0) {
        best = {
          ...best,
          x: Math.min(Math.max(clip.x0, best.x), Math.max(clip.x0, clip.x1 - best.w)),
          y: Math.min(Math.max(clip.y0, best.y), Math.max(clip.y0, clip.y1 - best.h)),
        };
      }
      text.style.display = best ? '' : 'none';
      if (!best) continue;
      boxes.push(best);
      text.setAttribute('x', String(best.x + 1.5 / this.scale));
      text.setAttribute('y', String(best.y + h - 4 / this.scale));
    }
  }

  /** Подсветка и маршрутные линии: видимые маршруты, доступные остановки, «вы здесь». */
  private paint(): void {
    if (!this.network || !this.here || !this.herePlatform) return;
    const reach = this.tripsFor(this.herePlatform);
    const platRefs = this.platformRefs(this.herePlatform);
    const options = this.target ? reach.get(this.target) : undefined;
    const chosenTrip =
      options && options.length > 0
        ? options[Math.min(this.pickedTripIdx, options.length - 1)]
        : undefined;
    const opp =
      this.target && !options?.length
        ? busOppositePlatformTrips(this.network, this.herePlatform, this.target)
        : [];
    const oppPlatIds = new Set(opp.map((o) => o.platform.id));

    const on = new Set<string>();
    if (this.line) on.add(this.line);
    else if (this.target && options?.length) options.forEach((t) => on.add(t.ref));
    else if (opp.length) opp.forEach((o) => o.trips.forEach((t) => on.add(t.ref)));
    else platRefs.forEach((r) => on.add(r));

    this.root.classList.toggle('all', this.all);
    this.drawLines(on, chosenTrip);

    const lineStops = this.line
      ? new Set(
          this.routes
            .get(this.line)!
            .directions.flatMap((d) => busStopOrder(d).map((r) => r?.stopId))
            .filter((id): id is string => Boolean(id)),
        )
      : undefined;
    this.stopsLayer.querySelectorAll<SVGGElement>('.bus-map-stop').forEach((g) => {
      const id = g.dataset.stop!;
      const ok = lineStops ? lineStops.has(id) : reach.has(id) || id === this.here;
      g.classList.toggle('far', !ok && !(this.target === id && opp.length > 0));
      g.classList.toggle('here', id === this.here);
      g.classList.toggle('target', id === this.target);
    });
    this.stopsLayer.querySelectorAll<SVGCircleElement>('.bus-map-plat').forEach((c) => {
      const pid = c.dataset.plat!;
      c.classList.toggle('here', pid === this.herePlatform);
      c.classList.toggle('opp', oppPlatIds.has(pid));
    });

    const origin = busPlatformById(this.network, this.herePlatform)!;
    const [hx, hy] = origin.platform.position;
    this.ring.setAttribute('cx', String(hx));
    this.ring.setAttribute('cy', String(hy));
    this.ring.setAttribute('r', String(10 / this.scale));
    this.ring.setAttribute('stroke-width', String(3 / this.scale));
    const hint = origin.platform.sideHint ? ` (${origin.platform.sideHint})` : '';
    this.subtitle.textContent = `Остановка «${origin.stop.name}»${hint} · ${plural(platRefs.length, 'маршрут', 'маршрута', 'маршрутов')}`;
    this.renderSide(reach, platRefs, opp);
  }

  // ---------- боковая колонка ----------

  private chip(ref: string, button = false): string {
    const color = this.bundles!.color(ref);
    return button
      ? `<button class="ui-btn bus-chip" type="button" data-line="${ref}" style="--c:${color}" aria-pressed="${this.line === ref}">${ref}</button>`
      : `<span class="bus-chip sm" style="--c:${color}">${ref}</span>`;
  }

  private renderSide(
    reach: Map<string, BusTrip[]>,
    platRefs: readonly string[],
    opp: { platform: BusPlatform; trips: BusTrip[] }[],
  ): void {
    const origin = busPlatformById(this.network!, this.herePlatform!)!;
    const here = origin.stop;
    const herePlat = origin.platform;
    const name = (id: string) => escapeHtml(this.stopsById.get(id)?.name ?? id);
    const platHint = (pid: string) => busPlatformById(this.network!, pid)?.platform.sideHint;
    const status = this.host.travelStatus();
    const busy = this.sending || status.pending;

    let html = `<div class="bus-here"><div class="bus-eyebrow">Вы на остановке</div><h3 class="disp">${escapeHtml(here.name)}</h3>${
      herePlat.sideHint ? `<div class="bus-flag">${escapeHtml(herePlat.sideHint)}</div>` : ''
    }</div>
      <div class="bus-chips" role="group" aria-label="Маршруты с этой платформы">${
        platRefs.length
          ? platRefs.map((r) => this.chip(r, true)).join('')
          : '<p class="bus-note">На этой платформе только высадка.</p>'
      }</div>`;

    if (this.line) {
      const route = this.routes.get(this.line)!;
      const dirsHtml = route.directions
        .map((dir) => {
          const names = dir.sequence.map((e) =>
            'stopId' in e
              ? `<b>${name(e.stopId)}</b>`
              : `<span class="bus-mut">за краем: ${stops(e.offWorld.length)}</span>`,
          );
          const dirLabel = dir.circular
            ? `Кольцевой · ${escapeHtml(dir.towards)}`
            : `→ ${escapeHtml(dir.towards)}`;
          return `<div class="bus-flag"><b>${dirLabel}</b></div><p class="bus-note">${names.join(' → ')}</p>`;
        })
        .join('');
      html += `<div class="bus-card"><h3 class="disp">${this.chip(this.line)} ${escapeHtml(route.name)}</h3>
        ${dirsHtml}
        <button class="ui-link" type="button" data-act="clear">Все маршруты с платформы</button></div>`;
    } else if (this.target) {
      const target = this.stopsById.get(this.target)!;
      const options = reach.get(this.target);
      html += `<div class="bus-card"><div><div class="bus-eyebrow">Куда</div><h3 class="disp">${escapeHtml(target.name)}</h3></div>`;
      if (options?.length) {
        const pickIdx = Math.min(this.pickedTripIdx, options.length - 1);
        const chosen = options[pickIdx]!;
        const formatTripBody = (t: BusTrip) => {
          const destHint = platHint(t.toPlatformId);
          return `в сторону «${escapeHtml(t.towards)}», ${stops(t.steps)}${
            destHint ? `<br><span class="bus-mut">высадка: ${escapeHtml(destHint)}</span>` : ''
          }${t.leaves ? '<br><span class="bus-mut">часть пути за краем мира</span>' : ''}${
            t.fasterOpposite
              ? `<br><span class="bus-warn">Быстрее со встречной стороны (${stops(t.fasterOpposite.steps)}, → ${escapeHtml(t.fasterOpposite.towards)})</span>`
              : ''
          }`;
        };
        html += options
          .map((t, idx) =>
            options.length > 1
              ? `<button type="button" class="bus-opt pick" data-pick="${idx}" aria-pressed="${idx === pickIdx}">${this.chip(t.ref)}<p>${formatTripBody(t)}</p></button>`
              : `<div class="bus-opt">${this.chip(t.ref)}<p>${formatTripBody(t)}</p></div>`,
          )
          .join('');
        html += `<button class="ui-btn ui-pri bus-go disp" type="button" data-go="${this.target}" data-to-platform="${chosen.toPlatformId}" data-route="${chosen.routeId}" data-dir="${chosen.directionIndex}"${busy ? ' disabled' : ''}>${
          this.sending ? 'Едем…' : `Поехать на ${chosen.ref}`
        }<span class="k" aria-hidden="true">Z</span></button>`;
      } else if (opp.length) {
        const alt = opp[0]!;
        html += `<p class="bus-note bus-opp-note"><b>В эту сторону автобусы идут с другой стороны остановки</b>${
          alt.platform.sideHint ? ` (${escapeHtml(alt.platform.sideHint)})` : ''
        }.</p>`;
        html += alt.trips
          .map(
            (t) =>
              `<div class="bus-opt">${this.chip(t.ref)}<p>в сторону «${escapeHtml(t.towards)}», ${stops(t.steps)}</p></div>`,
          )
          .join('');
      } else {
        const path = busTransferPath(this.network!, this.herePlatform!, this.target);
        html += '<p class="bus-note">Прямого автобуса с этой стороны нет.</p>';
        if (path && path.length >= 2) {
          const hopTrips: BusTrip[] = [];
          let curPlat = this.herePlatform!;
          for (let i = 1; i < path.length; i++) {
            const destStopId = path[i]!;
            let trip = this.tripsFor(curPlat).get(destStopId)?.[0];
            if (!trip) {
              const curStop = this.stopsById.get(path[i - 1]!);
              for (const sibling of curStop?.platforms ?? []) {
                trip = this.tripsFor(sibling.id).get(destStopId)?.[0];
                if (trip) break;
              }
            }
            if (!trip) break;
            hopTrips.push(trip);
            curPlat = trip.toPlatformId;
          }
          const first = hopTrips[0];
          if (first) {
            html +=
              '<div class="bus-eyebrow">С пересадкой</div>' +
              hopTrips
                .map(
                  (t) =>
                    `<div class="bus-opt">${this.chip(t.ref)}<p>до «${name(t.toStopId)}» (${stops(t.steps)})</p></div>`,
                )
                .join('') +
              `<button class="ui-btn ui-pri bus-go disp" type="button" data-go="${first.toStopId}" data-to-platform="${first.toPlatformId}" data-route="${first.routeId}" data-dir="${first.directionIndex}" data-next="${this.target}"${busy ? ' disabled' : ''}>${
                this.sending ? 'Едем…' : `Поехать до «${name(first.toStopId)}»`
              }<span class="k" aria-hidden="true">Z</span></button>`;
          } else html += '<p class="bus-note">Туда не доехать даже с пересадкой.</p>';
        } else html += '<p class="bus-note">Туда не доехать даже с пересадкой.</p>';
      }
      html += '</div>';
    } else {
      const items = [...reach.entries()].sort((a, b) => a[1][0]!.steps - b[1][0]!.steps);
      html += `<p class="bus-note">Выберите остановку на карте. Яркие — куда можно уехать с этой стороны без пересадки.</p>
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
      <p class="bus-note"><b>Правило.</b> Поездка начинается с текущей стороны остановки и идёт только по направлению маршрута.</p>
      <p class="bus-note bus-credit">Маршруты — «Транспорт 11», улицы и дома — © участники OpenStreetMap (ODbL).</p>`;
    this.side.innerHTML = html;
    this.side.querySelectorAll<HTMLButtonElement>('[data-line]').forEach((b) =>
      b.addEventListener('click', () => {
        this.line = this.line === b.dataset.line ? undefined : b.dataset.line;
        this.target = undefined;
        this.pickedTripIdx = 0;
        this.paint();
      }),
    );
    this.side
      .querySelectorAll<HTMLButtonElement>('[data-stop]')
      .forEach((b) => b.addEventListener('click', () => this.choose(b.dataset.stop!)));
    this.side.querySelectorAll<HTMLButtonElement>('[data-pick]').forEach((b) =>
      b.addEventListener('click', () => {
        this.pickedTripIdx = Number.parseInt(b.dataset.pick!, 10) || 0;
        this.paint();
      }),
    );
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
      const toPlatformId = button.dataset.toPlatform!;
      const routeId = button.dataset.route!;
      const directionIndex = Number.parseInt(button.dataset.dir!, 10);
      if (
        !this.herePlatform ||
        !this.host.travel(this.herePlatform, toPlatformId, routeId, directionIndex)
      )
        return;
      this.sending = true;
      this.next = button.dataset.next;
      this.pendingToPlatform = toPlatformId;
      this.target = to;
      this.paint();
    });
  }

  private choose(id: string): void {
    if (this.sending) return;
    this.target = id === this.here ? undefined : id;
    this.pickedTripIdx = 0;
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
    } else if (this.stopsLayer.childElementCount) {
      this.placeLabels();
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
