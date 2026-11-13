type PanelName =
  'help' | 'static' | 'reactions' | 'animations' | 'chat' | 'inventory' | 'diagnostics';

/** Opening a game panel cancels competing panels and their transient placement state. */
export class GamePanels {
  constructor(private readonly close: Record<PanelName, () => void>) {}

  closeExcept(keep?: PanelName): void {
    for (const name of Object.keys(this.close) as PanelName[]) {
      if (name !== keep) this.close[name]();
    }
  }
}
