/** Number keys select visible catalog entries without taking WASD or arrows from the world. */
export function bindCatalogShortcuts(
  panel: HTMLElement,
  choices: readonly HTMLButtonElement[],
  signal: AbortSignal,
): void {
  choices.forEach((button, index) => {
    if (index >= 9) return;
    button.setAttribute('aria-keyshortcuts', String(index + 1));
    const key = document.createElement('kbd');
    key.className = 'catalog-choice-key';
    key.textContent = String(index + 1);
    key.setAttribute('aria-hidden', 'true');
    button.append(key);
  });
  window.addEventListener(
    'keydown',
    (event) => {
      if (
        panel.hidden ||
        event.defaultPrevented ||
        event.repeat ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        (event.target instanceof HTMLElement &&
          (event.target.matches('input,textarea,select') || event.target.isContentEditable))
      )
        return;
      const digit = /^(?:Digit|Numpad)([1-9])$/.exec(event.code);
      const choice = digit && choices[Number(digit[1]) - 1];
      if (choice && !choice.disabled) {
        event.preventDefault();
        choice.click();
      }
    },
    { signal },
  );
}
