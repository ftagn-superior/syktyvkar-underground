type PanelName =
  'help' | 'players' | 'static' | 'reactions' | 'animations' | 'chat' | 'inventory' | 'diagnostics';

/** Opening a game panel cancels competing panels and their transient placement state. */
export class GamePanels {
  constructor(private readonly close: Record<PanelName, () => void>) {}

  /** The persistent chat dock may remain open alongside one foreground panel. */
  closeExcept(...keep: PanelName[]): void {
    for (const name of Object.keys(this.close) as PanelName[]) {
      if (!keep.includes(name)) this.close[name]();
    }
  }
}
