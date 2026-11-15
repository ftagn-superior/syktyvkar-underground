import type { CommandHelpEffect, CommandHelpEntry } from '@su/contracts';
import { CatalogFilter } from './catalog-shortcuts';

/**
 * Окно `/help` над строкой чата. Список присылает сервер, уже отфильтрованный по правам, поэтому
 * клиент команд не знает. Фильтр по категориям как у реакций и анимаций; щелчок по имени или
 * примеру подставляет команду в поле чата.
 */
export class CommandHelpPanel {
  private readonly controller = new AbortController();
  private filterController?: AbortController;
  private filter?: CatalogFilter;
  private entries: { element: HTMLElement; category: string }[] = [];
  private readonly list: HTMLElement;
  private readonly filters: HTMLElement;
  private readonly scroll: HTMLElement;
  private readonly shown: HTMLElement;
  private readonly count: HTMLElement;
  constructor(
    private readonly panel: HTMLElement,
    private readonly canvas: HTMLCanvasElement,
    /** Строка чата: щелчки по ней не закрывают окно, чтобы справку можно было читать при вводе. */
    chatRow: HTMLElement,
    private readonly insert: (text: string) => void,
    private readonly onOpen: () => void,
  ) {
    const options = { signal: this.controller.signal };
    this.list = panel.querySelector('.command-list')!;
    this.filters = panel.querySelector('.filters')!;
    this.scroll = panel.querySelector('.catalog-scroll')!;
    this.shown = panel.querySelector('[data-catalog-shown]')!;
    this.count = panel.querySelector('[data-catalog-count]')!;
    panel.querySelector('.pop-close')?.addEventListener('click', () => this.close(), options);
    window.addEventListener(
      'keydown',
      (event) => {
        if (event.code === 'Escape' && this.isOpen) {
          event.preventDefault();
          this.close();
        }
      },
      options,
    );
    window.addEventListener(
      'pointerdown',
      (event) => {
        if (
          this.isOpen &&
          event.target instanceof Node &&
          !panel.contains(event.target) &&
          !chatRow.contains(event.target)
        )
          this.close(false);
      },
      options,
    );
  }
  get isOpen(): boolean {
    return !this.panel.hidden;
  }
  show(help: CommandHelpEffect): void {
    this.onOpen();
    this.filterController?.abort();
    this.filterController = new AbortController();
    this.filters.replaceChildren();
    this.entries = help.commands.map((command) => ({
      element: this.entry(command, command.name === help.focus),
      category: command.category,
    }));
    this.list.replaceChildren(...this.entries.map(({ element }) => element));
    this.count.textContent = String(this.entries.length);
    this.filter = new CatalogFilter(
      this.filters,
      help.commands.map((command) => command.category),
      () => this.renderList(),
      this.filterController.signal,
    );
    this.renderList();
    this.panel.hidden = false;
    // A hidden element cannot scroll: position once the list is laid out.
    const focused = this.list.querySelector<HTMLElement>('[data-focus="true"]');
    if (focused) {
      focused.scrollIntoView({ block: 'nearest' });
      focused.querySelector<HTMLButtonElement>('.command-name')?.focus({ preventScroll: true });
    } else {
      this.scroll.scrollTop = 0;
      this.filters.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
    }
  }
  close(restoreFocus = true): void {
    const wasOpen = this.isOpen;
    this.panel.hidden = true;
    if (wasOpen && restoreFocus) this.canvas.focus({ preventScroll: true });
  }
  private renderList(): void {
    let shown = 0;
    for (const { element, category } of this.entries) {
      element.hidden = !(this.filter?.matches(category) ?? true);
      if (!element.hidden) shown++;
    }
    this.shown.textContent = String(shown);
    this.scroll.scrollTop = 0;
  }
  private choose(text: string): void {
    this.close(false);
    this.insert(text);
  }
  private entry(command: CommandHelpEntry, focused: boolean): HTMLElement {
    const signal = this.filterController!.signal;
    const element = document.createElement('article');
    element.className = 'command-entry';
    element.dataset.command = command.name;
    if (focused) element.dataset.focus = 'true';
    const head = document.createElement('div');
    head.className = 'command-head';
    const name = document.createElement('button');
    name.type = 'button';
    name.className = 'ui-btn command-name';
    name.textContent = `/${command.name}`;
    name.title = 'Вставить в чат';
    name.addEventListener('click', () => this.choose(`/${command.name} `), { signal });
    head.append(name);
    if (command.aliases.length) {
      const aliases = document.createElement('span');
      aliases.className = 'command-aliases';
      aliases.textContent = `или ${command.aliases.map((alias) => `/${alias}`).join(', ')}`;
      head.append(aliases);
    }
    const summary = document.createElement('p');
    summary.className = 'command-summary';
    summary.textContent = command.summary;
    const usage = document.createElement('code');
    usage.className = 'command-usage';
    // Перенос строки только между частями формата, не внутри `[--set ЧЧ[:ММ]]`.
    for (const [index, part] of `/${command.usage}`.split(/ (?=[[<])/).entries()) {
      const token = document.createElement('span');
      token.textContent = part;
      usage.append(...(index ? [' ', token] : [token]));
    }
    element.append(head, summary, usage);
    const options = [
      ...command.args.map((arg) => ({
        term: arg.optional ? `[<${arg.name}>]` : `<${arg.name}>`,
        help: arg.help,
      })),
      ...command.flags.map((flag) => ({
        term: [
          `--${flag.negatable ? '[no-]' : ''}${flag.name}`,
          flag.short ? `, -${flag.short}` : '',
          flag.value ? ` ${flag.value}` : '',
        ].join(''),
        help: flag.help,
      })),
    ];
    if (options.length) {
      const list = document.createElement('dl');
      list.className = 'command-flags';
      for (const option of options) {
        const row = document.createElement('div');
        const term = document.createElement('dt');
        term.textContent = option.term;
        const description = document.createElement('dd');
        description.textContent = option.help;
        row.append(term, description);
        list.append(row);
      }
      element.append(list);
    }
    if (command.examples.length) {
      const examples = document.createElement('div');
      examples.className = 'command-examples';
      examples.setAttribute('role', 'group');
      examples.setAttribute('aria-label', `Примеры /${command.name}`);
      for (const text of command.examples) {
        const example = document.createElement('button');
        example.type = 'button';
        example.className = 'ui-btn command-example';
        example.textContent = text;
        example.addEventListener('click', () => this.choose(text), { signal });
        examples.append(example);
      }
      element.append(examples);
    }
    return element;
  }
  dispose(): void {
    this.filterController?.abort();
    this.controller.abort();
  }
}
