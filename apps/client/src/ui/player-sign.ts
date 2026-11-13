/**
 * Знак игрока: одна из девяти простых фигур. Фигура не уникальна; вместе с цветом она различает
 * людей в чате, над головой и в списке. Протокол не меняется, поэтому знак считается от имени и
 * цвета: он стабилен между входами, но меняется при переименовании или смене цвета.
 */
const SHAPES = [
  // круг
  '<circle cx="12" cy="12" r="8.5"/>',
  // скруглённый квадрат
  '<rect x="4.5" y="4.5" width="15" height="15" rx="4"/>',
  // треугольник
  '<path d="M12 4.5 20 18.5H4Z"/>',
  // ромб
  '<path d="M12 3 21 12 12 21 3 12Z"/>',
  // пятиугольник
  '<path d="M12 3.5 20.6 9.8 17.3 19.8H6.7L3.4 9.8Z"/>',
  // шестиугольник
  '<path d="M12 3 19.8 7.5V16.5L12 21 4.2 16.5V7.5Z"/>',
  // восьмиконечная звезда
  '<rect x="5.5" y="5.5" width="13" height="13"/><rect x="5.5" y="5.5" width="13" height="13" transform="rotate(45 12 12)"/>',
  // клевер из четырёх кругов
  '<circle cx="8" cy="8" r="4.6"/><circle cx="16" cy="8" r="4.6"/><circle cx="8" cy="16" r="4.6"/><circle cx="16" cy="16" r="4.6"/>',
  // арка
  '<path d="M5 20.5V11a7 7 0 0 1 14 0v9.5Z"/>',
] as const;
export const SIGN_COUNT = SHAPES.length;

/** Stable shape index for a player's name and colour. Case of the hex colour does not matter. */
export function signIndex(name: string, color = ''): number {
  let hash = 7;
  for (const char of `${name.trim()}|${color.trim().toUpperCase()}`)
    hash = (hash * 31 + char.codePointAt(0)!) % 9973;
  return hash % SHAPES.length;
}

const SAFE_COLOR = /^#[0-9a-f]{6}$/i;
/** SVG markup: a contour in `--ln` under a fill in the player's colour, so light colours read on paper. */
export function signMarkup(index: number, color: string): string {
  const shape = SHAPES[((index % SHAPES.length) + SHAPES.length) % SHAPES.length];
  const fill = SAFE_COLOR.test(color) ? color : 'var(--me)';
  return (
    `<g fill="var(--ln)" stroke="var(--ln)" stroke-width="3.4" stroke-linejoin="round">${shape}</g>` +
    `<g fill="${fill}" stroke="${fill}" stroke-width=".6" stroke-linejoin="round">${shape}</g>`
  );
}

/** A decorative sign element; the name next to it carries the meaning for assistive technology. */
export function createSign(name: string, color: string, className = 'ui-sign'): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', className);
  updateSign(svg, name, color);
  return svg;
}
export function updateSign(svg: SVGSVGElement, name: string, color: string): void {
  const key = `${signIndex(name, color)}|${color}`;
  if (svg.dataset.sign === key) return;
  svg.dataset.sign = key;
  svg.innerHTML = signMarkup(signIndex(name, color), color);
}
