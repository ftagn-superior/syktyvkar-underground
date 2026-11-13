import { CUSTOM_COLOR_LABEL, PROFILE_COLORS, resolveProfileColor } from '@su/contracts';
import { ICONS } from './icons';
import { customColor, customControls } from './theme';

const DEFAULT_ID = PROFILE_COLORS[0].id;
const CUSTOM = 'custom';

/**
 * Круглые образцы (настоящие радиокнопки) и «свой цвет» с двумя ползунками: оттенок и тон.
 * Значение — id предустановленного цвета или `#RRGGBB`, как и раньше.
 */
export class ColorPicker {
  private readonly radios: HTMLInputElement[] = [];
  private readonly dots: HTMLElement[] = [];
  private readonly own: HTMLLabelElement;
  private readonly ownRadio: HTMLInputElement;
  private readonly box = document.getElementById('profile-own')!;
  private readonly hue = document.getElementById('profile-hue') as HTMLInputElement;
  private readonly tone = document.getElementById('profile-tone') as HTMLInputElement;
  private current: string = DEFAULT_ID;

  constructor(
    private readonly container: HTMLElement,
    private readonly label: HTMLElement,
    private readonly onChange: (colorId: string) => void,
  ) {
    for (const color of PROFILE_COLORS) {
      const { dot, input } = swatch(color.id, color.label);
      dot.style.setProperty('--c', color.hex);
      dot.title = color.label;
      input.dataset.colorId = color.id;
      input.addEventListener('change', () => input.checked && this.select(color.id, true));
      this.container.append(dot);
      this.radios.push(input);
      this.dots.push(dot);
    }
    const custom = swatch(CUSTOM, `${CUSTOM_COLOR_LABEL}: оттенок и тон`);
    this.own = custom.dot;
    this.ownRadio = custom.input;
    this.own.classList.add('own');
    this.own.title = CUSTOM_COLOR_LABEL;
    this.own.insertAdjacentHTML('beforeend', ICONS.plus);
    this.ownRadio.addEventListener(
      'change',
      () => this.ownRadio.checked && this.select(this.sliderColor(), true),
    );
    this.container.append(this.own);
    const fromSliders = () => this.select(this.sliderColor(), true);
    this.hue.addEventListener('input', fromSliders);
    this.tone.addEventListener('input', fromSliders);
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
    for (const input of [...this.radios, this.ownRadio, this.hue, this.tone])
      input.disabled = value;
  }
  private sliderColor(): string {
    return customColor(Number(this.hue.value), Number(this.tone.value));
  }
  private select(colorId: string, notify: boolean): void {
    const color = resolveProfileColor(colorId) ?? resolveProfileColor(DEFAULT_ID)!;
    this.current = color.custom ? color.hex : color.id;
    this.radios.forEach((input, index) => {
      const on = !color.custom && input.value === color.id;
      input.checked = on;
      this.dots[index].classList.toggle('is-on', on);
    });
    this.ownRadio.checked = color.custom;
    this.own.classList.toggle('is-on', color.custom);
    this.own.style.setProperty('--c', color.hex);
    this.box.hidden = !color.custom;
    if (color.custom) {
      const controls = customControls(color.hex);
      // Keep the thumbs where the player left them while dragging.
      if (customColor(Number(this.hue.value), Number(this.tone.value)) !== color.hex) {
        this.hue.value = String(controls.hue);
        this.tone.value = String(controls.tone);
      }
      const hue = Number(this.hue.value);
      this.tone.style.setProperty(
        '--tr',
        `linear-gradient(90deg, ${customColor(hue, 0)}, ${customColor(hue, 50)}, ${customColor(hue, 100)})`,
      );
    }
    this.label.textContent = color.label;
    if (notify) this.onChange(this.current);
  }
}

function swatch(value: string, label: string): { dot: HTMLLabelElement; input: HTMLInputElement } {
  const dot = document.createElement('label');
  dot.className = 'dot';
  const input = document.createElement('input');
  input.type = 'radio';
  input.name = 'profile-color';
  input.value = value;
  input.setAttribute('aria-label', label);
  dot.append(input);
  return { dot, input };
}
