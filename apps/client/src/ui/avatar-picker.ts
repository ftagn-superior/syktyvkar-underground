import { DEFAULT_AVATAR_SKIN, resolveAvatarSkinId, type AvatarSkinId } from '@su/contracts';
import { availableCharacters, CHARACTERS, type CharacterEntry } from './characters';

type Filter = 'all' | 'available' | 'locked';
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'Все' },
  { id: 'available', label: 'Доступные' },
  { id: 'locked', label: 'Скоро' },
];
const SVG = 'http://www.w3.org/2000/svg';

/** Character list window, ◀ ▶ navigation and plate. Radios keep it a native, keyboard-friendly group. */
export class AvatarPicker {
  private readonly fieldset = document.getElementById('avatar-skins') as HTMLFieldSetElement;
  private readonly options = document.getElementById('avatar-skin-options')!;
  private readonly tabs = document.getElementById('avatar-tabs')!;
  private readonly inputs = new Map<string, HTMLInputElement>();
  private readonly cards = new Map<string, HTMLElement>();
  private readonly tabButtons = new Map<Filter, HTMLButtonElement>();
  private filter: Filter = 'all';
  private selected: AvatarSkinId = DEFAULT_AVATAR_SKIN;
  private name = '';
  private colorLabel = '';

  constructor(private readonly onChange: () => void) {
    this.buildStage();
    for (const character of CHARACTERS) this.options.append(this.buildCard(character));
    for (const { id, label } of FILTERS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'su-tab';
      button.dataset.filter = id;
      button.addEventListener('click', () => {
        this.filter = id;
        this.render();
      });
      this.tabs.append(button);
      this.tabButtons.set(id, button);
      void label;
    }
    document.getElementById('preview-prev')!.addEventListener('click', () => this.step(-1));
    document.getElementById('preview-next')!.addEventListener('click', () => this.step(1));
    this.render();
  }
  get value(): AvatarSkinId {
    return this.selected;
  }
  set value(value: AvatarSkinId) {
    this.selected = resolveAvatarSkinId(value);
    this.render();
  }
  set disabled(value: boolean) {
    this.fieldset.disabled = value;
    for (const id of ['preview-prev', 'preview-next'])
      (document.getElementById(id) as HTMLButtonElement).disabled = value;
  }
  /** The plate under the preview shows the in-progress name and colour. */
  setIdentity(name: string, colorLabel: string): void {
    this.name = name;
    this.colorLabel = colorLabel;
    this.renderPlate();
  }
  private step(direction: -1 | 1): void {
    const list = availableCharacters();
    const index = list.findIndex((character) => character.skinId === this.selected);
    const next = list[(index + direction + list.length) % list.length];
    this.choose(next.skinId!);
  }
  private choose(skinId: AvatarSkinId): void {
    if (skinId === this.selected) return;
    this.selected = skinId;
    this.render();
    this.onChange();
  }
  private buildCard(character: CharacterEntry): HTMLElement {
    const card = document.createElement('label');
    card.className = 'su-card';
    card.dataset.characterId = character.id;
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'avatar-skin';
    input.value = character.skinId ?? character.id;
    input.disabled = character.locked;
    input.setAttribute('aria-label', `${character.name}${character.locked ? ' — скоро' : ''}`);
    if (character.skinId)
      input.addEventListener('change', () => input.checked && this.choose(character.skinId!));
    const figure = document.createElement('span');
    figure.className = 'fig';
    if (character.locked) {
      card.classList.add('is-locked');
      figure.append(lockedSilhouette());
    } else {
      const image = document.createElement('img');
      image.src = `/avatars/${character.id}.svg`;
      image.alt = '';
      image.width = 56;
      image.height = 90;
      figure.append(image);
    }
    const name = document.createElement('span');
    name.className = 'nm';
    name.textContent = character.name;
    const status = document.createElement('span');
    status.className = 'st';
    card.append(input, figure, platform(), name, status);
    if (character.locked) card.append(lockIcon());
    this.inputs.set(character.id, input);
    this.cards.set(character.id, card);
    return card;
  }
  private render(): void {
    const open = availableCharacters().length;
    for (const character of CHARACTERS) {
      const card = this.cards.get(character.id)!;
      const on = character.skinId === this.selected;
      this.inputs.get(character.id)!.checked = on;
      card.classList.toggle('is-on', on);
      card.hidden =
        this.filter === 'available'
          ? character.locked
          : this.filter === 'locked'
            ? !character.locked
            : false;
      card.querySelector('.st')!.textContent = character.locked
        ? 'Скоро'
        : on
          ? 'Выбран'
          : 'Доступен';
    }
    const counts: Record<Filter, number> = {
      all: CHARACTERS.length,
      available: open,
      locked: CHARACTERS.length - open,
    };
    for (const { id, label } of FILTERS) {
      const button = this.tabButtons.get(id)!;
      button.replaceChildren(
        label,
        Object.assign(document.createElement('span'), {
          className: 'c',
          textContent: String(counts[id]),
        }),
      );
      button.classList.toggle('is-on', this.filter === id);
      button.setAttribute('aria-pressed', String(this.filter === id));
    }
    const list = availableCharacters();
    document.getElementById('list-count')!.textContent = `${open} / ${CHARACTERS.length} открыто`;
    document.getElementById('preview-index')!.textContent = `${
      list.findIndex((character) => character.skinId === this.selected) + 1
    } / ${list.length}`;
    const fallback = document.getElementById('preview-fallback') as HTMLImageElement;
    fallback.src = `/avatars/${this.selected}.svg`;
    this.renderPlate();
  }
  private renderPlate(): void {
    const character = CHARACTERS.find((entry) => entry.skinId === this.selected);
    document.getElementById('plate-name')!.textContent = this.name || 'Игрок';
    document.getElementById('plate-model')!.textContent = [character?.name, this.colorLabel]
      .filter(Boolean)
      .join(' · ');
    document.getElementById('plate-description')!.textContent = character?.description ?? '';
  }
  /** Deterministic low-poly mesh behind the preview, tinted by the accent. */
  private buildStage(): void {
    const mesh = document.getElementById('stage-mesh');
    if (!mesh) return;
    const columns = 4;
    const width = 520 / columns;
    const rows = 3;
    const height = 430 / rows;
    let seed = 7;
    const opacity = () => {
      seed = (seed * 9301 + 49297) % 233280;
      return (0.03 + (seed / 233280) * 0.08).toFixed(3);
    };
    const triangle = (points: number[][]) => {
      const polygon = document.createElementNS(SVG, 'polygon');
      polygon.setAttribute('points', points.map((p) => p.join(',')).join(' '));
      polygon.setAttribute('fill-opacity', opacity());
      mesh.append(polygon);
    };
    for (let row = 0; row < rows; row++)
      for (let column = 0; column <= columns; column++) {
        const shift = row % 2 ? width / 2 : 0;
        const x = column * width - shift;
        const y = row * height;
        triangle([
          [x, y],
          [x + width, y],
          [x + width / 2, y + height],
        ]);
        triangle([
          [x + width / 2, y + height],
          [x - width / 2, y + height],
          [x, y],
        ]);
      }
  }
}

function platform(): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'ped');
  svg.setAttribute('width', '64');
  svg.setAttribute('height', '18');
  svg.setAttribute('viewBox', '0 0 64 18');
  svg.setAttribute('aria-hidden', 'true');
  for (const [points, cls] of [
    ['2,7 16,13 48,13 62,7 62,11 48,17 16,17 2,11', 'side'],
    ['2,7 16,1 48,1 62,7 48,13 16,13', 'top'],
  ]) {
    const polygon = document.createElementNS(SVG, 'polygon');
    polygon.setAttribute('points', points);
    polygon.setAttribute('class', cls);
    svg.append(polygon);
  }
  return svg;
}
function lockedSilhouette(): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('width', '56');
  svg.setAttribute('height', '90');
  svg.setAttribute('viewBox', '0 0 56 90');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML =
    '<polygon points="28,4 44,12 44,30 28,38 12,30 12,12" fill="#2a3338"/>' +
    '<polygon points="28,4 44,12 28,20 12,12" fill="#38444a"/>' +
    '<polygon points="10,42 46,42 50,80 6,80" fill="#2a3338"/>' +
    '<polygon points="10,42 28,42 22,80 6,80" fill="#333f45"/>' +
    '<text x="28" y="66" text-anchor="middle" font-family="Unbounded,sans-serif" font-weight="700" font-size="20" fill="#6f7d80">?</text>';
  return svg;
}
function lockIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'lock');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2.4');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML =
    '<rect x="5" y="11" width="14" height="10" rx="1"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>';
  return svg;
}
