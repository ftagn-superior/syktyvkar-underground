import { CUSTOM_COLOR_LABEL, PROFILE_COLORS, resolveProfileColor } from '@su/contracts';

const DEFAULT_ID = PROFILE_COLORS[0].id;

/** Hexagonal swatches (real radios) plus a native colour input for a custom colour. */
export class ColorPicker {
  private readonly radios: HTMLInputElement[] = [];
  private readonly cells: HTMLElement[] = [];
  private readonly wheel: HTMLLabelElement;
  private readonly custom: HTMLInputElement;
  private current: string = DEFAULT_ID;

  constructor(
    private readonly container: HTMLElement,
    private readonly label: HTMLElement,
    private readonly onChange: (colorId: string) => void,
  ) {
    for (const color of PROFILE_COLORS) {
      const cell = document.createElement('label');
      cell.className = 'su-swatch';
      cell.style.setProperty('--sw', color.hex);
      cell.title = color.label;
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'profile-color';
      input.value = color.id;
      input.dataset.colorId = color.id;
      input.setAttribute('aria-label', color.label);
      input.addEventListener('change', () => this.select(color.id, true));
      cell.append(input, hexagons('su-hx-i'));
      this.container.append(cell);
      this.radios.push(input);
      this.cells.push(cell);
    }
    this.wheel = document.createElement('label');
    this.wheel.className = 'su-swatch su-wheel';
    this.wheel.title = CUSTOM_COLOR_LABEL;
    this.custom = document.createElement('input');
    this.custom.type = 'color';
    this.custom.id = 'profile-color-custom';
    this.custom.setAttribute('aria-label', 'Свой цвет — открыть палитру');
    this.custom.value = PROFILE_COLORS[0].hex.toLowerCase();
    // `input` fires continuously while dragging inside the native picker: preview live.
    this.custom.addEventListener('input', () => this.select(this.custom.value, true));
    const centre = document.createElement('span');
    centre.className = 'su-hx su-hx-c';
    centre.append(document.createElement('span'));
    const body = hexagons('su-hx-i');
    body.querySelector('.su-hx-i')!.append(centre);
    this.wheel.append(this.custom, body);
    this.container.append(this.wheel);
    this.select(DEFAULT_ID, false);
  }
  get value(): string {
    return this.current;
  }
  set value(colorId: string) {
    this.select(colorId, false);
  }
  get hex(): string {
    return resolveProfileColor(this.current)?.hex ?? PROFILE_COLORS[0].hex;
  }
  get colorLabel(): string {
    return resolveProfileColor(this.current)?.label ?? PROFILE_COLORS[0].label;
  }
  set disabled(value: boolean) {
    for (const input of [...this.radios, this.custom]) input.disabled = value;
  }
  private select(colorId: string, notify: boolean): void {
    const color = resolveProfileColor(colorId) ?? resolveProfileColor(DEFAULT_ID)!;
    this.current = color.custom ? color.hex : color.id;
    this.radios.forEach((input, index) => {
      const on = !color.custom && input.value === color.id;
      input.checked = on;
      this.cells[index].classList.toggle('is-on', on);
    });
    this.wheel.classList.toggle('is-on', color.custom);
    this.wheel.style.setProperty('--sw', color.hex);
    if (color.custom) this.custom.value = color.hex.toLowerCase();
    this.label.textContent = color.label;
    if (notify) this.onChange(this.current);
  }
}

/** Three nested hexagons give the selected ring (outer) and a dark gap (middle). */
function hexagons(inner: string): HTMLElement {
  const outer = document.createElement('span');
  outer.className = 'su-hx su-hx-o';
  const middle = document.createElement('span');
  middle.className = 'su-hx su-hx-m';
  const gem = document.createElement('span');
  gem.className = `su-hx ${inner}`;
  middle.append(gem);
  outer.append(middle);
  return outer;
}
