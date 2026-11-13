import { ChatLog, type ChatSource } from '../ui/chat-log';
import { UiThemeController } from '../ui/ui-theme';
import { WorldChips, type PlayerEntry } from '../ui/world-chips';
import type { ElementLookup } from './dom';

/** Projects the shared world clock and nearby players into the persistent HUD. */
export class WorldHud {
  readonly theme = new UiThemeController();
  private readonly chips: WorldChips;
  private readonly chatLog: ChatLog;

  constructor(element: ElementLookup, openPlayers: () => void, focusWorld: () => void) {
    this.chips = new WorldChips(openPlayers, focusWorld);
    this.chatLog = new ChatLog(element('chat-log'));
  }

  update(
    hour: number,
    occupancy: number,
    sources: Iterable<[string, ChatSource]>,
    ownKey?: string,
  ): void {
    this.theme.setHour(hour);
    this.chips.setClock(hour, this.theme.daylight);
    const entries = [...sources];
    const players: PlayerEntry[] = entries.map(([key, player]) => ({
      key,
      name: player.name || 'Гость',
      color: player.color ?? '',
      own: key === ownKey,
    }));
    this.chips.setPlayers(Math.max(occupancy, players.length), players);
    if (ownKey) this.chatLog.observe(entries, ownKey);
  }

  closePlayers(): void {
    this.chips.close();
  }

  clearChat(): void {
    this.chatLog.clear();
  }

  dispose(): void {
    this.chips.dispose();
    this.chatLog.clear();
  }
}
