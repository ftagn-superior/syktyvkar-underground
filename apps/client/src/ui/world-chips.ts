import { MAX_PLAYERS } from '@su/contracts';
import { ICONS } from './icons';
import { createSign } from './player-sign';

export interface PlayerEntry {
  key: string;
  name: string;
  color: string;
  own: boolean;
}

/** «ЧЧ:ММ» for a game hour 0..24. */
export function formatHour(hour: number): string {
  const minutes = Math.round((((hour % 24) + 24) % 24) * 60) % 1440;
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/**
 * Чипы справа вверху: часы мира с солнцем или луной и число игроков. По щелчку на втором — список
 * «знак · имя». Клиент видит только игроков в своей области интереса, поэтому общее число берётся
 * из сведений о комнате, а список подписан, если показаны не все.
 */
export class WorldChips {
  private readonly clockText = document.getElementById('clock-text')!;
  private readonly clockIcon = document.getElementById('clock-icon')!;
  private readonly toggle = document.getElementById('players-toggle') as HTMLButtonElement;
  private readonly count = document.getElementById('players-count')!;
  private readonly panel = document.getElementById('players-panel')!;
  private readonly total = document.getElementById('players-total')!;
  private readonly list = document.getElementById('players-list')!;
  private readonly note = document.getElementById('players-note')!;
  private readonly controller = new AbortController();
  private clock = '';
  private daylight?: boolean;
  private listSignature = '';
  private occupancy = -1;
  constructor(
    private readonly onOpen: () => void,
    private readonly focusWorld: () => void,
  ) {
    const options = { signal: this.controller.signal };
    this.toggle.addEventListener('click', () => this.open(this.panel.hidden), options);
    window.addEventListener(
      'keydown',
      (event) => {
        if (event.code === 'Escape' && !this.panel.hidden) {
          event.preventDefault();
          this.close(true);
        }
      },
      options,
    );
    window.addEventListener(
      'pointerdown',
      (event) => {
        if (
          !this.panel.hidden &&
          event.target instanceof Node &&
          !this.panel.contains(event.target) &&
          !this.toggle.contains(event.target)
        )
          this.close(false);
      },
      options,
    );
  }
  setClock(hour: number, daylight: boolean): void {
    const text = formatHour(hour);
    if (text !== this.clock) {
      this.clock = text;
      this.clockText.textContent = text;
    }
    if (daylight !== this.daylight) {
      this.daylight = daylight;
      this.clockIcon.innerHTML = daylight ? ICONS.sun : ICONS.moon;
      this.clockIcon.parentElement!.setAttribute(
        'aria-label',
        daylight ? 'Время в мире, день' : 'Время в мире, ночь',
      );
    }
  }
  setPlayers(occupancy: number, players: readonly PlayerEntry[]): void {
    if (occupancy !== this.occupancy) {
      this.occupancy = occupancy;
      this.count.textContent = String(occupancy);
      this.total.textContent = `${occupancy} из ${MAX_PLAYERS}`;
      this.toggle.setAttribute('aria-label', `Игроки в сети: ${occupancy}`);
    }
    if (this.panel.hidden) return;
    const sorted = [...players].sort((a, b) => Number(b.own) - Number(a.own));
    const signature = sorted.map((p) => `${p.key}|${p.name}|${p.color}`).join(',');
    this.note.hidden = players.length >= occupancy;
    if (signature === this.listSignature) return;
    this.listSignature = signature;
    this.list.replaceChildren(
      ...sorted.map((player) => {
        const row = document.createElement('li');
        const name = document.createElement('span');
        name.textContent = player.name;
        row.append(createSign(player.name, player.color), name);
        if (player.own) {
          const you = document.createElement('small');
          you.textContent = 'вы';
          row.append(you);
        }
        return row;
      }),
    );
  }
  get isOpen(): boolean {
    return !this.panel.hidden;
  }
  private open(open: boolean): void {
    if (!open) return this.close(true);
    this.onOpen();
    this.listSignature = '';
    this.panel.hidden = false;
    this.toggle.setAttribute('aria-expanded', 'true');
  }
  close(restoreFocus = false): void {
    const wasOpen = !this.panel.hidden;
    this.panel.hidden = true;
    this.toggle.setAttribute('aria-expanded', 'false');
    if (wasOpen && restoreFocus) {
      if (this.panel.contains(document.activeElement) || document.activeElement === this.toggle)
        this.toggle.focus({ preventScroll: true });
      else this.focusWorld();
    }
  }
  dispose(): void {
    this.controller.abort();
  }
}
