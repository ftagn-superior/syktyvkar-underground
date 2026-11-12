/** Observe semantic visibility changes, not arbitrary DOM clicks or every UI refresh. */
export class MenuSounds {
  private readonly observer: MutationObserver;
  private readonly visible = new Map<HTMLElement, boolean>();
  private closeTimer?: ReturnType<typeof setTimeout>;

  constructor(
    panels: HTMLElement[],
    private readonly enabled: () => boolean,
    private readonly play: (cue: 'open' | 'close') => void,
  ) {
    for (const panel of panels) this.visible.set(panel, !panel.hidden);
    this.observer = new MutationObserver(() => {
      let opened = false,
        closed = false;
      for (const [panel, before] of this.visible) {
        const after = !panel.hidden;
        opened ||= !before && after;
        closed ||= before && !after;
        this.visible.set(panel, after);
      }
      if (!this.enabled()) {
        clearTimeout(this.closeTimer);
        return;
      }
      if (opened) {
        clearTimeout(this.closeTimer);
        this.play('open');
      } else if (closed) {
        clearTimeout(this.closeTimer);
        // Opening the next panel wins over an outside-pointerdown close.
        this.closeTimer = setTimeout(() => {
          if (this.enabled()) this.play('close');
        }, 80);
      }
    });
    for (const panel of panels)
      this.observer.observe(panel, { attributes: true, attributeFilter: ['hidden'] });
  }

  dispose(): void {
    this.observer.disconnect();
    clearTimeout(this.closeTimer);
  }
}
