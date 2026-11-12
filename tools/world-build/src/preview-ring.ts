/**
 * Офлайн-просмотр кольца: вид сверху на поверхность, дома и разметку без сервера и браузерной игры.
 *
 *   pnpm world:preview-ring            # импорт участка → dist/preview/ring.html
 *   pnpm world:preview-ring -- --no-import   # только перерисовать из уже собранного контента
 *
 * Файл самодостаточный: откройте его двойным щелчком. Поверх схемы можно включить
 * эталоны из `reference/ring/` (карта и спутниковый снимок) и менять их прозрачность.
 * Слои рисуются в том же порядке, что и в игре. Север сверху, как в игре при стандартной камере.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { importDistrict } from './import-district.js';
import type { Point2 } from './triangulate.js';

const CONFIG = 'content/worlds/ring-block/import.json';
const OUT = 'dist/preview/ring.html';
const TRACE_FILE = 'content/worlds/ring-block/ring-trace.json';
/**
 * Что трассируется. Линии ведутся от дальнего конца подъезда к кольцу и заканчиваются там,
 * где край дороги встречает внешнюю окружность кольца; островки — замкнутые контуры.
 */
const TRACE_ARMS = [
  ['oktyabrsky-north', 'Октябрьский на С-С-З', ['западный', 'восточный']],
  ['oktyabrsky-south', 'Октябрьский на Ю-Ю-В', ['западный', 'восточный']],
  ['kommunisticheskaya-west', 'Коммунистическая на З-Ю-З', ['северный', 'южный']],
  ['kommunisticheskaya-east', 'Коммунистическая на В-С-В', ['северный', 'южный']],
] as const;
const TRACE_PRESETS = [
  ...TRACE_ARMS.flatMap(([id, title, sides]) => [
    ...sides.map((side) => ({
      id: `${id}:edge-${side}`,
      label: `${title} — ${side} край проезжей части`,
    })),
    { id: `${id}:island`, label: `${title} — островок (замкнутый контур)` },
    { id: `${id}:lane-dashed`, label: `${title} — линия прерывистая` },
    { id: `${id}:lane-solid`, label: `${title} — линия сплошная` },
    { id: `${id}:lane-double`, label: `${title} — двойная сплошная` },
    { id: `${id}:yield-line`, label: `${title} — линия «Уступи дорогу» на въезде в кольцо` },
    { id: `${id}:crosswalk`, label: `${title} — «зебра» (отрезок поперёк дороги)` },
  ]),
  { id: 'ring:lane-dashed', label: 'Кольцо — линия прерывистая' },
  { id: 'ring:lane-solid', label: 'Кольцо — линия сплошная' },
  { id: 'ring:edge-outer', label: 'Кольцо — внешний край, если не круг' },
  { id: 'other', label: 'Другое (дорожка, забор, газон)' },
];
/** Видимая область в метрах от центра кольца: запад/восток по x, север/юг по z. */
const VIEW = { x: [-125, 125], z: [-100, 100] } as const;

/**
 * Привязка эталонов к метрам: пикселей на метр и пиксель, где лежит центр кольца.
 * Подобрано по карте: край центрального острова (радиус 32,3 м) на скриншоте — около 102 px.
 */
const REFERENCES = [
  { id: 'map', title: 'Карта', file: 'correct marking.png', scale: 3.16, center: [557, 480] },
  {
    id: 'photo',
    title: 'Спутник',
    file: 'correct marking photo.png',
    scale: 4.5,
    center: [668, 405],
  },
] as const;

interface Layer {
  id: string;
  color: string;
  polygons: Point2[][][];
}

/** Контур с отверстиями: правило even-odd действует только внутри одного многоугольника. */
const path = (rings: Point2[][]) =>
  rings.map((ring) => 'M' + ring.map(([x, z]) => `${x} ${z}`).join('L') + 'Z').join('');

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, 'utf8')) as T;
}

export async function renderRingPreview(withImport = true) {
  if (withImport) await importDistrict(CONFIG);
  const config = await readJson<{ worldId: string; roundabout?: unknown }>(CONFIG);
  const buildings = join('content/buildings', config.worldId);
  const ground = await readJson<{ layers: Layer[]; color: string }>(
    join(buildings, `${config.worldId}-ground`, 'source.json'),
  );
  // Контуры домов лежат в координатах модели: сдвигаются на положение экземпляра в ячейке.
  const cell = await readJson<{
    buildings: { assetId: string; position: { x: number; z: number } }[];
  }>(join('content/worlds', config.worldId, 'cells/0_0.json'));
  const houses: Point2[][] = [];
  for (const { assetId, position } of cell.buildings) {
    if (!assetId.startsWith('osm-way-')) continue;
    const source = await readJson<{ outline?: Point2[] }>(join(buildings, assetId, 'source.json'));
    if (source.outline)
      houses.push(source.outline.map(([x, z]) => [x + position.x, z + position.z] as Point2));
  }
  let traces: unknown[] = [];
  try {
    traces = (await readJson<{ traces: unknown[] }>(TRACE_FILE)).traces;
  } catch {
    // файла трассировки ещё нет
  }
  const [x0, x1] = VIEW.x,
    [z0, z1] = VIEW.z;
  const layers = ground.layers
    .map(
      (layer) =>
        `<g class="layer l-${layer.id}" data-layer="${layer.id}" fill="${layer.color}" fill-rule="evenodd">${layer.polygons.map((polygon) => `<path d="${path(polygon)}"/>`).join('')}</g>`,
    )
    .join('\n');
  const images = REFERENCES.map((ref) => {
    return `<image class="ref" id="ref-${ref.id}" href="../../reference/ring/${encodeURI(ref.file)}" data-scale="${ref.scale}" data-cx="${ref.center[0]}" data-cy="${ref.center[1]}" opacity="0"/>`;
  }).join('\n');
  const toggles = ground.layers
    .map(
      (l) =>
        `<label><input type="checkbox" data-toggle="${l.id}" checked><i style="background:${l.color}"></i>${l.id}</label>`,
    )
    .join('');
  const sliders = REFERENCES.map(
    (ref) =>
      `<label>${ref.title} <input type="range" min="0" max="1" step="0.05" value="0" data-ref="${ref.id}"></label>`,
  ).join('');
  const html = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>Кольцо — предпросмотр</title>
<style>
  html,body{margin:0;height:100%;background:#1b1f23;color:#dde;font:13px system-ui,sans-serif}
  #bar select,#bar textarea{width:100%;box-sizing:border-box;margin:4px 0;font:12px system-ui}
  #bar button{margin:2px 2px 2px 0}
  #tr-list{padding-left:18px;margin:4px 0}
  #bar{position:fixed;inset:0 auto 0 0;width:260px;padding:10px;background:#252a30;overflow:auto;box-sizing:border-box}
  #bar label{display:flex;align-items:center;gap:6px;margin:4px 0}
  #bar i{width:12px;height:12px;border:1px solid #0006;display:inline-block}
  #bar h4{margin:12px 0 4px}
  svg{position:fixed;left:260px;top:0;width:calc(100% - 260px);height:100%}
  #coords{position:fixed;right:10px;bottom:8px;background:#000a;padding:3px 8px;border-radius:4px}
</style></head><body>
<div id="bar"><b>Слои</b>${toggles}
<label><input type="checkbox" data-toggle="houses" checked><i style="background:#b9b3a6"></i>дома</label>
<h4>Эталон поверх</h4>${sliders}
<h4>Масштаб</h4><div>колесо — масштаб,<br>перетаскивание — сдвиг</div>
<h4>Трассировка</h4>
<label><input type="checkbox" id="tr-on"> включить (клик — точка)</label>
<select id="tr-name"></select>
<div><button id="tr-done">Завершить (Enter)</button><button id="tr-undo">Убрать точку (Backspace)</button><button id="tr-cancel">Сбросить текущий (Esc)</button></div>
<ol id="tr-list"></ol>
<div><button id="tr-copy">Копировать JSON</button><button id="tr-save">Скачать ring-trace.json</button><button id="tr-reset">Очистить всё</button></div>
<textarea id="tr-out" readonly rows="5"></textarea></div>
<svg id="svg" viewBox="${x0} ${z0} ${x1 - x0} ${z1 - z0}" preserveAspectRatio="xMidYMid meet">
<rect x="${x0}" y="${z0}" width="${x1 - x0}" height="${z1 - z0}" fill="${ground.color}"/>
<g id="scene">
${layers}
<g class="layer" data-layer="houses" fill="#b9b3a699" stroke="#6d675c" stroke-width=".3">${houses.map((h) => `<path d="${path([h])}"/>`).join('')}</g>
</g>
<g id="refs">${images}</g>
<g id="traces"></g>
</svg>
<div id="coords"></div>
<script>
const svg=document.getElementById('svg');
const view={x:${x0},y:${z0},w:${x1 - x0},h:${z1 - z0}};
const apply=()=>svg.setAttribute('viewBox',[view.x,view.y,view.w,view.h].join(' '));
for(const box of document.querySelectorAll('[data-toggle]'))
  box.onchange=()=>{for(const el of document.querySelectorAll('[data-layer="'+box.dataset.toggle+'"]'))el.style.display=box.checked?'':'none'};
// Эталон: пиксель (cx,cy) попадает в центр кольца, scale пикселей на метр, север сверху.
for(const img of document.querySelectorAll('image.ref')){
  const s=+img.dataset.scale, cx=+img.dataset.cx, cy=+img.dataset.cy;
  img.setAttribute('x',-cx/s);img.setAttribute('y',-cy/s);
  const t=new Image();t.onload=()=>{img.setAttribute('width',t.naturalWidth/s);img.setAttribute('height',t.naturalHeight/s)};t.src=img.getAttribute('href');
}
for(const r of document.querySelectorAll('[data-ref]'))
  r.oninput=()=>document.getElementById('ref-'+r.dataset.ref).setAttribute('opacity',r.value);
svg.onwheel=e=>{e.preventDefault();const k=e.deltaY>0?1.15:1/1.15;const p=pt(e);
  view.x=p.x-(p.x-view.x)*k;view.y=p.y-(p.y-view.y)*k;view.w*=k;view.h*=k;apply()};
let drag=null;
svg.onpointerdown=e=>{drag={x:e.clientX,y:e.clientY,vx:view.x,vy:view.y,moved:false};svg.setPointerCapture(e.pointerId)};
svg.onpointerup=e=>{
  if(drag&&!drag.moved&&document.getElementById('tr-on').checked){
    const p=pt(e);
    if(!cur)cur={name:document.getElementById('tr-name').value,points:[]};
    cur.points.push([Math.round(p.x*10)/10,Math.round(p.y*10)/10]);redraw();
  }
  drag=null};
svg.onpointermove=e=>{const p=pt(e);document.getElementById('coords').textContent='x '+p.x.toFixed(1)+'  z '+p.y.toFixed(1)+'  (r '+Math.hypot(p.x,p.y).toFixed(1)+')';
  if(!drag)return;if(Math.hypot(e.clientX-drag.x,e.clientY-drag.y)>4)drag.moved=true;
  if(!drag.moved)return;const r=svg.getBoundingClientRect();const k=Math.max(view.w/r.width,view.h/r.height);
  view.x=drag.vx-(e.clientX-drag.x)*k;view.y=drag.vy-(e.clientY-drag.y)*k;apply()};
function pt(e){const m=svg.getScreenCTM().inverse();const p=new DOMPoint(e.clientX,e.clientY).matrixTransform(m);return{x:p.x,y:p.y}}
// --- Трассировка: клики по эталону записываются в метрах и сохраняются в localStorage ---
const PRESETS=${JSON.stringify(TRACE_PRESETS)};
const FILE=${JSON.stringify(traces)};
let traces=null;
try{traces=JSON.parse(localStorage.getItem('ring-traces')||'null')}catch(_){}
if(!Array.isArray(traces))traces=FILE;
let cur=null;
const NS='http://www.w3.org/2000/svg';
const sel=document.getElementById('tr-name');
for(const p of PRESETS){const o=document.createElement('option');o.value=p.id;o.textContent=p.label;sel.appendChild(o)}
const colour=name=>{let h=0;for(const c of name.split(':')[0])h=(h*37+c.charCodeAt(0))%360;return 'hsl('+h+',95%,55%)'};
const closed=name=>/:island$/.test(name);
function mk(tag,attrs){const el=document.createElementNS(NS,tag);for(const k in attrs)el.setAttribute(k,attrs[k]);return el}
function exportJson(){
  const nl=String.fromCharCode(10);
  return '{'+nl+'"formatVersion":1,'+nl+'"note":"game metres: x east, z south; lines run from the far end of the arm towards the ring",'+nl+'"traces":['+nl+
    traces.map(t=>JSON.stringify(t)).join(','+nl)+nl+']}'+nl;
}
function redraw(){
  try{localStorage.setItem('ring-traces',JSON.stringify(traces))}catch(_){}
  const g=document.getElementById('traces');g.textContent='';
  for(const t of traces.concat(cur?[cur]:[])){
    if(!t.points.length)continue;
    const c=colour(t.name),done=t!==cur;
    const d='M'+t.points.map(p=>p[0]+' '+p[1]).join('L')+(done&&closed(t.name)?'Z':'');
    g.appendChild(mk('path',{d:d,fill:'none',stroke:c,'stroke-width':2,'vector-effect':'non-scaling-stroke','stroke-dasharray':done?'':'6 4'}));
    for(const p of t.points)g.appendChild(mk('path',{d:'M'+p[0]+' '+p[1]+'l0 0',stroke:c,'stroke-width':7,'stroke-linecap':'round','vector-effect':'non-scaling-stroke'}));
  }
  const list=document.getElementById('tr-list');list.textContent='';
  traces.forEach((t,i)=>{const li=document.createElement('li');li.style.color=colour(t.name);
    li.textContent=t.name.split(':')[0]+' ('+t.points.length+') ';const b=document.createElement('button');b.textContent='✕';
    b.onclick=()=>{traces.splice(i,1);redraw()};li.appendChild(b);
    // Переименование: можно сменить вид уже обведённой линии (например, сплошная вместо прерывистой).
    const kind=document.createElement('select');kind.style.fontSize='11px';
    const names=PRESETS.map(p=>p.id);if(names.indexOf(t.name)<0)names.unshift(t.name);
    for(const id of names){const o=document.createElement('option');o.value=id;o.textContent=id;kind.appendChild(o)}
    kind.value=t.name;kind.onchange=()=>{t.name=kind.value;redraw()};li.appendChild(kind);
    list.appendChild(li)});
  document.getElementById('tr-out').value=exportJson();
}
function finish(){
  if(!cur)return;
  const need=closed(cur.name)?3:2;
  if(cur.points.length<need){alert('Мало точек: нужно минимум '+need);return}
  traces.push(cur);cur=null;redraw();
}
function undo(){if(cur){cur.points.pop();if(!cur.points.length)cur=null;redraw()}}
document.getElementById('tr-done').onclick=finish;
document.getElementById('tr-undo').onclick=undo;
document.getElementById('tr-cancel').onclick=()=>{cur=null;redraw()};
document.getElementById('tr-reset').onclick=()=>{if(confirm('Удалить все трассы?')){traces=[];cur=null;redraw()}};
document.getElementById('tr-copy').onclick=()=>{if(navigator.clipboard)navigator.clipboard.writeText(exportJson())};
document.getElementById('tr-save').onclick=()=>{const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob([exportJson()],{type:'application/json'}));a.download='ring-trace.json';a.click()};
addEventListener('keydown',e=>{
  if(e.target.tagName==='SELECT'||e.target.tagName==='TEXTAREA')return;
  if(e.key==='Enter')finish();
  else if(e.key==='Backspace'){e.preventDefault();undo()}
  else if(e.key==='Escape'){cur=null;redraw()}
});
redraw();
</script></body></html>
`;
  await mkdir('dist/preview', { recursive: true });
  await writeFile(OUT, html);
  return resolve(OUT);
}

const entry = process.argv[1] ? resolve(process.argv[1]).replaceAll('\\', '/') : '';
if (entry.endsWith('tools/world-build/src/preview-ring.ts')) {
  const file = await renderRingPreview(!process.argv.includes('--no-import'));
  console.log(`Предпросмотр кольца: ${file}`);
}
