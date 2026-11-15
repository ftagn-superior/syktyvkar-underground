type PanelName =
  | 'help'
  | 'players'
  | 'static'
  | 'removal'
  | 'reactions'
  | 'animations'
  | 'commands'
  | 'chat'
  | 'inventory'
  | 'bus'
  | 'diagnostics';

type Panel = { close: () => void; isOpen: () => boolean };

/** Opening a game panel cancels competing panels and their transient placement state. */
export class GamePanels {
  constructor(
    private readonly panels: Record<PanelName, Panel>,
    private readonly beforeOpen: (name: PanelName) => void,
  ) {}

  /** Claim input before closing chat: its close callback must see the newer intent. */
  open(name: PanelName, ...keep: PanelName[]): void {
    this.beforeOpen(name);
    this.closeExcept(name, ...keep);
  }

  get hasForeground(): boolean {
    return (Object.keys(this.panels) as PanelName[]).some(
      (name) => name !== 'chat' && this.panels[name].isOpen(),
    );
  }

  /** The persistent chat dock may remain open alongside one foreground panel. */
  closeExcept(...keep: PanelName[]): void {
    for (const name of Object.keys(this.panels) as PanelName[]) {
      if (!keep.includes(name)) this.panels[name].close();
    }
  }
}
