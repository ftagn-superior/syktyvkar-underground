import { describe, expect, it, vi } from 'vitest';
import { GamePanels } from './game-panels';

describe('panel input ownership', () => {
  it('claims input before closing chat and reports every open foreground panel', () => {
    const events: string[] = [];
    const panel = (name: string, open = false) => ({
      close: vi.fn(() => {
        events.push(`close:${name}`);
        open = false;
      }),
      isOpen: () => open,
      show: () => (open = true),
    });
    const chat = panel('chat', true);
    const players = panel('players');
    const panels = new GamePanels(
      {
        help: panel('help'),
        players,
        static: panel('static'),
        removal: panel('removal'),
        reactions: panel('reactions'),
        animations: panel('animations'),
        inventory: panel('inventory'),
        diagnostics: panel('diagnostics'),
        chat,
      },
      (name) => events.push(`claim:${name}`),
    );
    expect(panels.hasForeground).toBe(false);
    panels.open('players');
    expect(events[0]).toBe('claim:players');
    expect(chat.close).toHaveBeenCalledOnce();
    players.show();
    expect(panels.hasForeground).toBe(true);
    panels.closeExcept('chat');
    expect(panels.hasForeground).toBe(false);
  });
});
