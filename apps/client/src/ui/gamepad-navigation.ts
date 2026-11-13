export interface GamepadNavigationItem {
  /** Stable across DOM updates, unlike an element's position in a list. */
  id: string;
  element: HTMLElement;
  activate?: () => void;
  adjust?: (direction: -1 | 1) => void;
}

export type GamepadNavigationAction = 'a' | 'up' | 'down' | 'left' | 'right';

/** Explicit navigation for the current panel; never discovers arbitrary page controls. */
export class GamepadNavigation {
  private context?: string;
  private items: readonly GamepadNavigationItem[] = [];
  private selected?: string;
  private highlighted?: HTMLElement;
  private highlightedDisabled = false;

  get selectedId(): string | undefined {
    return this.selected;
  }

  setContext(context: string, items: readonly GamepadNavigationItem[], preferredId?: string): void {
    const changed = this.context !== context;
    this.context = context;
    this.items = items;
    if (changed || !items.some((item) => item.id === this.selected))
      this.selected = items.find((item) => item.id === preferredId)?.id ?? items[0]?.id;
    this.render();
  }

  handle(action: GamepadNavigationAction): boolean {
    const index = this.items.findIndex((item) => item.id === this.selected);
    if (index < 0) return false;
    if (action === 'up' || action === 'down') {
      const next = Math.max(0, Math.min(this.items.length - 1, index + (action === 'up' ? -1 : 1)));
      if (next === index) return false;
      this.selected = this.items[next].id;
      this.render();
      return true;
    }
    const item = this.items[index];
    if (disabled(item.element)) return false;
    if (action === 'a') {
      item.activate ? item.activate() : item.element.click();
      return true;
    }
    if (!item.adjust) return false;
    item.adjust(action === 'left' ? -1 : 1);
    return true;
  }

  clear(): void {
    this.highlighted?.classList.remove('gamepad-focus');
    this.highlighted = undefined;
    this.highlightedDisabled = false;
    this.context = undefined;
    this.selected = undefined;
    this.items = [];
  }

  private render(): void {
    const element = this.items.find((item) => item.id === this.selected)?.element;
    const changed = this.highlighted !== element;
    const wasDisabled = this.highlightedDisabled;
    if (changed) this.highlighted?.classList.remove('gamepad-focus');
    this.highlighted = element;
    if (!element) return;
    this.highlightedDisabled = disabled(element);
    element.classList.add('gamepad-focus');
    if (!this.highlightedDisabled && (changed || wasDisabled) && document.activeElement !== element)
      element.focus({ preventScroll: true });
    // Repeated HUD refreshes must preserve focus and the player's scroll position.
    if (changed)
      element.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
  }
}

function disabled(element: HTMLElement): boolean {
  return (
    ('disabled' in element && !!element.disabled) ||
    element.getAttribute('aria-disabled') === 'true'
  );
}
