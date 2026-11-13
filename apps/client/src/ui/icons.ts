/** Иконки интерфейса: поле 24×24, линия 2,2. Только разметка SVG, без логики. */
const stroke = (body: string, width = 2.2) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const fill = (body: string) =>
  `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${body}</svg>`;

export const ICONS = {
  chat: stroke('<path d="M4 5.5h16v10H10l-4.5 3.5V15.5H4Z"/>'),
  react: stroke(
    '<circle cx="12" cy="12" r="8.5"/><path d="M8.5 14c1 1.6 2.2 2.3 3.5 2.3s2.5-.7 3.5-2.3M9 9.5v.5M15 9.5v.5"/>',
  ),
  emote: stroke('<circle cx="12" cy="5" r="2"/><path d="M5 8l7 3 7-5M12 11v5l-4 5M12 16l4 5"/>'),
  eye: stroke(
    '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.8"/>',
  ),
  pack: stroke(
    '<path d="M6 9a6 6 0 0 1 12 0v10a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2Z"/><path d="M9.5 5V3.5h5V5M9 14h6v3H9Z"/>',
  ),
  send: stroke('<path d="M5 12h13M13 6l6 6-6 6"/>', 2.6),
  close: stroke('<path d="M6 6l12 12M18 6 6 18"/>', 2.6),
  prev: stroke('<path d="M15 5l-7 7 7 7"/>', 2.6),
  next: stroke('<path d="M9 5l7 7-7 7"/>', 2.6),
  /** Четыре стрелки клавиатуры одной строкой: шрифты интерфейса рисуют ← и → тире. */
  arrows:
    '<svg viewBox="0 0 48 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2 4 6l4 4M4 6h7M18 10V3M15 5.5 18 2.5l3 3M30 2v7M27 6.5l3 3 3-3M40 6h7M43 2l4 4-4 4"/></svg>',
  plus: stroke('<path d="M12 5v14M5 12h14"/>', 3),
  sun: stroke(
    '<circle cx="12" cy="12" r="4" fill="currentColor"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8"/>',
  ),
  moon: fill('<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z"/>'),
  people: fill(
    '<circle cx="9" cy="8" r="3.4"/><path d="M2.5 20c0-4 3-6.5 6.5-6.5s6.5 2.5 6.5 6.5Z"/><circle cx="17" cy="9" r="2.6" opacity=".6"/><path d="M16.5 13.2c3 0 5 2 5 5.3h-4.3c-.2-2.2-.9-3.9-2.2-5Z" opacity=".6"/>',
  ),
  /** Памятник «Трудовая слава»: постамент, два пилона, плита с медальоном, веер пластин. */
  brand: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="21.3" width="12" height="1.7" rx=".4"/><rect x="9.7" y="11" width="1.5" height="10.5"/><rect x="12.8" y="11" width="1.5" height="10.5"/><rect x="8.3" y="8.6" width="7.4" height="3.6" rx=".4"/><circle cx="12" cy="10.4" r="1.25" fill="var(--p)"/><rect x="10.5" y="1.4" width="1.2" height="7.6"/><rect x="12.3" y="1.9" width="1.2" height="7.1"/><rect x="8.6" y="2.7" width="1.2" height="6.3"/><rect x="14.2" y="3.2" width="1.2" height="5.8"/><rect x="6.7" y="4.3" width="1.2" height="4.7"/><rect x="16.1" y="4.8" width="1.2" height="4.2"/></svg>`,
} as const;

export type IconName = keyof typeof ICONS;

/** Inserts a trusted, static icon at the start of `parent`. */
export function setIcon(parent: Element, name: IconName): void {
  parent.querySelector(':scope > svg')?.remove();
  parent.insertAdjacentHTML('afterbegin', ICONS[name]);
}
