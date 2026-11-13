import { isTextInput } from '../input/keyboard';

/**
 * Number keys select the first nine entries of the list currently shown in an open catalog
 * (after the category filter), without taking WASD or arrows from the world.
 */
export class CatalogShortcuts {
  private choices: readonly HTMLButtonElement[] = [];
  constructor(
    private readonly isOpen: () => boolean,
    signal: AbortSignal,
  ) {
    window.addEventListener(
      'keydown',
      (event) => {
        if (
          !this.isOpen() ||
          event.defaultPrevented ||
          event.repeat ||
          event.ctrlKey ||
          event.metaKey ||
          event.altKey ||
          isTextInput(event.target)
        )
          return;
        const digit = /^(?:Digit|Numpad)([1-9])$/.exec(event.code);
        const choice = digit && this.choices[Number(digit[1]) - 1];
        if (choice && !choice.disabled) {
          event.preventDefault();
          choice.click();
        }
      },
      { signal },
    );
  }
  /** Rebinds keys 1–9 to `choices` and marks them with a pale key label. */
  bind(choices: readonly HTMLButtonElement[]): void {
    for (const button of this.choices) {
      button.removeAttribute('aria-keyshortcuts');
      button.querySelector('.catalog-choice-key')?.remove();
    }
    this.choices = choices.slice(0, 9);
    this.choices.forEach((button, index) => {
      button.setAttribute('aria-keyshortcuts', String(index + 1));
      const key = document.createElement('span');
      key.className = 'catalog-choice-key';
      key.textContent = String(index + 1);
      key.setAttribute('aria-hidden', 'true');
      button.append(key);
    });
  }
}

/** Category filter row: «Все» plus each category in catalog order. */
export class CatalogFilter {
  static readonly ALL = 'Все';
  private current = CatalogFilter.ALL;
  private readonly buttons: HTMLButtonElement[] = [];
  constructor(
    container: HTMLElement,
    categories: readonly string[],
    onChange: (category: string) => void,
    signal: AbortSignal,
  ) {
    for (const category of [CatalogFilter.ALL, ...new Set(categories)]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ui-btn';
      button.textContent = category;
      button.dataset.filter = category;
      button.setAttribute('aria-pressed', String(category === this.current));
      button.addEventListener(
        'click',
        () => {
          this.current = category;
          for (const other of this.buttons)
            other.setAttribute('aria-pressed', String(other === button));
          onChange(category);
        },
        { signal },
      );
      container.append(button);
      this.buttons.push(button);
    }
  }
  get value(): string {
    return this.current;
  }
  matches(category: string): boolean {
    return this.current === CatalogFilter.ALL || this.current === category;
  }
}
