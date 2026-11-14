/**
 * Сравнение моделей зданий с фото Street View.
 *
 * Для каждого кадра из reference/streetview/<osm-id>/manifest.json (см. tools/streetview-capture.ts)
 * модель здания и соседей генерируется прямо из рецептов content/buildings/ring-block/ и
 * рендерится Babylon'ом из той же точки, тем же направлением и углом обзора, что и панорама.
 * Пары «фото | модель» собираются в листы по шесть кадров:
 * reference/streetview/<osm-id>/compare/sheet-<n>.jpg. Сеть и ключ API не нужны.
 *
 *   pnpm buildings:compare --building osm-way-1317554464
 *   pnpm buildings:compare --building osm-way-1317554464 --facade NW.1,NW.2 --size 640
 *
 * Флаги: --building <id[,id]>, --match <текст>, --all, --facade <ключи>, --size <px панели, 360>,
 * --best <n> — только n самых фронтальных и открытых кадров.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium, type Page } from 'playwright';
import { generateFootprint, type FootprintRecipe } from './world-build/src/city.js';
import { encodeStaticGlb } from './world-build/src/glb.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILDINGS_DIR = join(ROOT, 'content/buildings/ring-block');
const CELLS_DIR = join(ROOT, 'content/worlds/ring-block/cells');
const OUT_DIR = join(ROOT, 'reference/streetview');
const WORK_DIR = join(OUT_DIR, '.compare');
const IMAGE_SIZE = 640;
const CAMERA_HEIGHT = 2.5;
const NEIGHBOUR_RADIUS = 320;
const PER_SHEET = 6;

type Pixel = [number, number];
interface Placement {
  id: string;
  x: number;
  y: number;
  z: number;
  name: string;
}
interface Shot {
  file: string;
  heading: number;
  pitch: number;
  fov: number;
  overlays: Array<{ kind: string; points: Pixel[] }>;
  error?: string;
}
interface View {
  facade: string;
  date: string | null;
  pano: { x: number; z: number };
  distance: number;
  incidence: number;
  visibility: number;
  shots: Shot[];
}
interface Manifest {
  id: string;
  name: string;
  facades: Array<{ key: string; side: string; part?: [number, number] }>;
  views: View[];
}

const readJson = <T = any>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;

function loadPlacements(): Placement[] {
  const out: Placement[] = [];
  for (const file of readdirSync(CELLS_DIR).filter((f) => f.endsWith('.json'))) {
    for (const entry of readJson(join(CELLS_DIR, file)).buildings ?? []) {
      if (typeof entry.assetId !== 'string' || !entry.assetId.startsWith('osm-way-')) continue;
      const assetPath = join(BUILDINGS_DIR, entry.assetId, 'asset.json');
      if (!existsSync(assetPath)) continue;
      const r = entry.rotation;
      if (r && (Math.abs(r.x) > 1e-6 || Math.abs(r.y) > 1e-6 || Math.abs(r.z) > 1e-6))
        throw new Error(`${entry.assetId}: повёрнутые здания не поддерживаются`);
      out.push({
        id: entry.assetId,
        x: entry.position.x,
        y: entry.position.y ?? 0,
        z: entry.position.z,
        name: readJson(assetPath).metadata?.name ?? entry.assetId,
      });
    }
  }
  return out;
}

function parseArgs(argv: string[]) {
  const args = {
    buildings: [] as string[],
    match: [] as string[],
    all: false,
    facades: [] as string[],
    best: 0,
    size: 360,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a}: нужно значение`);
      return v;
    };
    if (a === '--building') args.buildings.push(...value().split(','));
    else if (a === '--match') args.match.push(value().toLowerCase());
    else if (a === '--all') args.all = true;
    else if (a === '--facade') args.facades.push(...value().split(','));
    else if (a === '--best') args.best = Math.max(1, Number(value()));
    else if (a === '--size') args.size = Math.max(160, Math.min(IMAGE_SIZE, Number(value())));
    else throw new Error(`Неизвестный флаг ${a}`);
  }
  return args;
}

async function openRenderer(): Promise<{
  page: Page;
  sheetPage: Page;
  close: () => Promise<void>;
}> {
  mkdirSync(WORK_DIR, { recursive: true });
  await build({
    entryPoints: [join(ROOT, 'tools/building-compare/render-entry.ts')],
    bundle: true,
    format: 'iife',
    minify: true,
    outfile: join(WORK_DIR, 'render.js'),
    // Babylon установлен только в пакете клиента.
    nodePaths: [join(ROOT, 'apps/client/node_modules')],
    logLevel: 'warning',
  });
  writeFileSync(
    join(WORK_DIR, 'render.html'),
    `<!doctype html><meta charset="utf-8"><style>body{margin:0}canvas{display:block}</style>` +
      `<canvas id="view" width="${IMAGE_SIZE}" height="${IMAGE_SIZE}"></canvas><script src="render.js"></script>`,
  );
  // Как в tests/helpers/browser.ts; без скачанного Chromium берём установленный Chrome.
  const options = { args: ['--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader'] };
  const browser = await chromium
    .launch({ ...options, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH })
    .catch(() => chromium.launch({ ...options, channel: 'chrome' }));
  const context = await browser.newContext({ viewport: { width: IMAGE_SIZE, height: IMAGE_SIZE } });
  const page = await context.newPage();
  page.on('pageerror', (error) => console.warn(`render: ${error.message}`));
  await page.goto(pathToFileURL(join(WORK_DIR, 'render.html')).href);
  await page.waitForFunction(() => (window as any).compare?.ready === true);
  return { page, sheetPage: await context.newPage(), close: () => browser.close() };
}

const escapeHtml = (text: string) =>
  text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function outlineSvg(shot: Shot, size: number): string {
  const k = size / IMAGE_SIZE;
  const target = shot.overlays.find((o) => o.kind === 'target');
  if (!target) return '';
  const points = target.points
    .map(([x, y]) => `${(x * k).toFixed(1)},${(y * k).toFixed(1)}`)
    .join(' ');
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><polygon points="${points}"/></svg>`;
}

function sheetHtml(
  m: Manifest,
  pairs: Array<{ view: View; shot: Shot; photo: string; render: string }>,
  size: number,
  index: number,
  total: number,
): string {
  const cells = pairs
    .map(({ view, shot, photo, render }) => {
      const facade = m.facades.find((f) => f.key === view.facade);
      const svg = outlineSvg(shot, size);
      const label = `${view.facade} ${facade?.part ? `(${facade.part[0]}/${facade.part[1]})` : ''} · ${view.date ?? '?'} · ${view.distance} м, ${view.incidence}° · ${shot.file}`;
      return `<div class="pair"><div class="label">${escapeHtml(label)}</div><div class="row">
        <div class="panel"><img src="${photo}">${svg}<span>фото</span></div>
        <div class="panel"><img src="${render}">${svg}<span>модель</span></div></div></div>`;
    })
    .join('');
  return `<!doctype html><meta charset="utf-8"><style>
    body { margin: 0; background: #16181b; color: #eee; font: 600 13px system-ui, sans-serif; }
    h1 { margin: 0; padding: 8px 10px; font-size: 15px; background: #23262b; }
    .grid { display: grid; grid-template-columns: repeat(2, ${size * 2 + 4}px); gap: 10px; padding: 10px; }
    .label { padding: 0 0 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .row { display: flex; gap: 4px; }
    .panel { position: relative; width: ${size}px; height: ${size}px; }
    .panel img, .panel svg { position: absolute; inset: 0; width: ${size}px; height: ${size}px; }
    .panel span { position: absolute; left: 4px; top: 4px; padding: 1px 5px; background: rgba(0,0,0,.6); font-size: 11px; }
    polygon { fill: none; stroke: #ff3b6b; stroke-width: 1.5; stroke-dasharray: 5 3; opacity: .85; }
  </style><h1>${escapeHtml(`${m.name} · ${m.id} · лист ${index}/${total}`)}</h1><div class="grid">${cells}</div>`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const placements = loadPlacements();
  const selected = placements.filter(
    (p) =>
      args.all ||
      args.buildings.includes(p.id) ||
      args.match.some((m) => `${p.id} ${p.name}`.toLowerCase().includes(m)),
  );
  const unknown = args.buildings.filter((id) => !placements.some((p) => p.id === id));
  if (unknown.length) throw new Error(`Не найдены здания: ${unknown.join(', ')}`);
  if (!selected.length)
    throw new Error('Не выбрано ни одного здания: укажите --building, --match или --all');

  const glbCache = new Map<string, string>();
  const glbOf = (id: string) => {
    let glb = glbCache.get(id);
    if (!glb) {
      const recipe = readJson<FootprintRecipe>(join(BUILDINGS_DIR, id, 'source.json'));
      glb = Buffer.from(encodeStaticGlb(generateFootprint(id, recipe).parts)).toString('base64');
      glbCache.set(id, glb);
    }
    return glb;
  };

  const { page, sheetPage, close } = await openRenderer();
  const inScene = new Set<string>();
  try {
    for (const target of selected) {
      const dir = join(OUT_DIR, target.id);
      const manifestPath = join(dir, 'manifest.json');
      if (!existsSync(manifestPath)) {
        console.warn(`${target.id}: нет manifest.json — сначала pnpm reference:streetview`);
        continue;
      }
      const m = readJson<Manifest>(manifestPath);
      for (const p of placements) {
        if (inScene.has(p.id) || Math.hypot(p.x - target.x, p.z - target.z) > NEIGHBOUR_RADIUS)
          continue;
        await page.evaluate(
          ({ id, glb, x, y, z }) => (window as any).compare.addModel(id, glb, x, y, z),
          { id: p.id, glb: glbOf(p.id), x: p.x, y: p.y, z: p.z },
        );
        inScene.add(p.id);
      }

      const pairs: Array<{ view: View; shot: Shot; photo: string; render: string }> = [];
      // --best N: самые фронтальные и открытые кадры, по одному на фасад.
      const views = args.best
        ? [...m.views]
            .sort(
              (a, b) =>
                b.visibility * Math.cos((b.incidence * Math.PI) / 180) -
                a.visibility * Math.cos((a.incidence * Math.PI) / 180),
            )
            .filter((v, i, all) => all.findIndex((o) => o.facade === v.facade) === i)
            .slice(0, args.best)
        : m.views;
      for (const view of views) {
        if (args.facades.length && !args.facades.includes(view.facade)) continue;
        for (const shot of view.shots) {
          const file = join(dir, shot.file);
          if (shot.error || !existsSync(file)) continue;
          const render: string = await page.evaluate(
            (spec) => (window as any).compare.render(spec),
            {
              x: view.pano.x,
              z: view.pano.z,
              height: CAMERA_HEIGHT,
              heading: shot.heading,
              pitch: shot.pitch,
              fov: shot.fov,
            },
          );
          pairs.push({
            view,
            shot,
            photo: `data:image/jpeg;base64,${readFileSync(file).toString('base64')}`,
            render,
          });
        }
      }

      const outDir = join(dir, 'compare');
      rmSync(outDir, { recursive: true, force: true });
      mkdirSync(outDir, { recursive: true });
      const total = Math.ceil(pairs.length / PER_SHEET);
      for (let i = 0; i < total; i++) {
        const chunk = pairs.slice(i * PER_SHEET, (i + 1) * PER_SHEET);
        await sheetPage.setViewportSize({ width: 2 * (args.size * 2 + 4) + 30, height: 100 });
        await sheetPage.setContent(sheetHtml(m, chunk, args.size, i + 1, total));
        await sheetPage.screenshot({
          path: join(outDir, `sheet-${i + 1}.jpg`),
          type: 'jpeg',
          quality: 85,
          fullPage: true,
        });
      }
      console.log(`${target.id} ${m.name}: ${pairs.length} кадров → ${total} лист(ов) в ${outDir}`);
    }
  } finally {
    await close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
