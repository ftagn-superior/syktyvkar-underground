import type { PlacementCatalog, WorldManifest } from '@su/contracts';
import type { ModelResourceReader } from '../rendering/model-visual';
import { ModelPreview } from './model-preview';
import { ICONS } from './icons';

type CatalogModel = PlacementCatalog['models'][number];
const synonyms: Record<string, string> = {
  tree: 'дерево деревья',
  birch: 'береза',
  spruce: 'ель елка',
  leaf: 'лиственное',
  bush: 'куст кусты',
  bench: 'скамейка лавка',
  fence: 'забор ограда секция',
  lamp: 'фонарь освещение',
  bollard: 'столбик',
  'traffic-light': 'светофор',
  small: 'малый маленький',
  medium: 'средний',
  large: 'большой крупный',
  high: 'высокий',
  low: 'низкий',
  short: 'короткий',
  long: 'длинный',
};
export const normalizePlacementSearch = (value: string) =>
  value.toLocaleLowerCase('ru').replace(/ё/g, 'е').trim().replace(/\s+/g, ' ');
export function filterPlacementModels(
  models: readonly CatalogModel[],
  query: string,
  category = '',
) {
  const words = normalizePlacementSearch(query).split(' ').filter(Boolean);
  return models
    .filter((model) => {
      if (category && model.metadata.category !== category) return false;
      const { name, description, tags } = model.metadata;
      const haystack = normalizePlacementSearch(
        [model.assetId, name, description, ...tags, ...tags.map((tag) => synonyms[tag] ?? '')].join(
          ' ',
        ),
      );
      return words.every((word) => haystack.includes(word));
    })
    .sort(
      (a, b) =>
        a.metadata.name.localeCompare(b.metadata.name, 'ru') || a.assetId.localeCompare(b.assetId),
    );
}

function button(label: string, callback: () => void, primary = false) {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = `ui-btn${primary ? ' ui-pri' : ''}`;
  element.textContent = label;
  element.addEventListener('click', callback);
  return element;
}

/** Modal catalog. It owns one preview; its owner owns catalog fetching and durable operations. */
export class PlacementCatalogPanel {
  private readonly backdrop = document.createElement('div');
  private readonly dialog = document.createElement('section');
  private readonly search = document.createElement('input');
  private readonly categories = document.createElement('div');
  private readonly status = document.createElement('p');
  private readonly results = document.createElement('div');
  private readonly details = document.createElement('div');
  private readonly previewCanvas = document.createElement('canvas');
  private readonly previewStatus = document.createElement('p');
  private readonly heading = document.createElement('h3');
  private readonly description = document.createElement('p');
  private readonly dimensions = document.createElement('p');
  private readonly placeButton: HTMLButtonElement;
  private readonly retry = button('Повторить', () => this.retryAction?.());
  private readonly resetSearch = button('Сбросить поиск', () => {
    this.search.value = '';
    this.category = '';
    this.renderCategories();
    this.renderResults();
    this.search.focus();
  });
  private readonly rotateButton: HTMLButtonElement;
  private readonly resetViewButton: HTMLButtonElement;
  private readonly retryPreview = button('Повторить загрузку модели', () => {
    void this.loadPreview();
  });
  private readonly listeners = new AbortController();
  private catalog?: PlacementCatalog;
  private manifest?: WorldManifest;
  private read?: ModelResourceReader;
  private preview?: ModelPreview;
  private controller?: AbortController;
  private generation = 0;
  private category = '';
  private selectedId?: string;
  private previewReady = false;
  private unavailable = false;
  private retryAction?: () => void;

  constructor(
    private readonly gameCanvas: HTMLCanvasElement,
    close: () => void,
    place: (assetId: string) => void,
  ) {
    this.backdrop.id = 'placement-catalog';
    this.backdrop.className = 'placement-catalog-backdrop';
    this.backdrop.hidden = true;
    this.dialog.className = 'placement-catalog-dialog ui-panel';
    this.dialog.setAttribute('role', 'dialog');
    this.dialog.setAttribute('aria-modal', 'true');
    this.dialog.setAttribute('aria-labelledby', 'placement-catalog-title');
    const title = document.createElement('h2');
    title.id = 'placement-catalog-title';
    title.textContent = 'Размещение объектов';
    const dismiss = button('Закрыть', close);
    dismiss.classList.add('ui-icon-btn');
    dismiss.setAttribute('aria-label', 'Закрыть каталог (Esc)');
    dismiss.innerHTML = ICONS.close;
    const header = document.createElement('header');
    header.append(title, dismiss);
    this.search.type = 'search';
    this.search.id = 'placement-catalog-search';
    this.search.placeholder = 'Поиск по названию или описанию…';
    this.search.setAttribute('aria-label', 'Поиск моделей');
    this.search.autocomplete = 'off';
    this.categories.className = 'placement-catalog-categories';
    this.categories.setAttribute('aria-label', 'Категории моделей');
    this.status.setAttribute('role', 'status');
    this.status.setAttribute('aria-live', 'polite');
    this.status.className = 'placement-catalog-status';
    this.results.className = 'placement-catalog-results';
    this.results.setAttribute('role', 'group');
    this.results.setAttribute('aria-label', 'Модели');
    this.details.className = 'placement-catalog-details';
    this.previewCanvas.id = 'placement-model-preview';
    this.previewCanvas.setAttribute(
      'aria-label',
      '3D-превью выбранной модели. Для поворота используйте кнопки ниже.',
    );
    this.previewStatus.setAttribute('role', 'status');
    this.previewStatus.setAttribute('aria-live', 'polite');
    this.dimensions.className = 'placement-catalog-dimensions';
    this.rotateButton = button('Повернуть', () => this.preview?.rotate());
    this.resetViewButton = button('Сбросить вид', () => this.preview?.reset());
    const previewControls = document.createElement('div');
    previewControls.className = 'placement-catalog-preview-controls';
    previewControls.append(this.rotateButton, this.resetViewButton);
    this.placeButton = button(
      'Разместить',
      () => {
        if (this.previewReady && !this.unavailable && this.selectedId) place(this.selectedId);
      },
      true,
    );
    this.placeButton.id = 'placement-catalog-place';
    this.placeButton.disabled = true;
    this.details.append(
      this.heading,
      this.previewCanvas,
      this.previewStatus,
      this.retryPreview,
      this.description,
      this.dimensions,
      previewControls,
      this.placeButton,
    );
    const content = document.createElement('div');
    content.className = 'placement-catalog-content';
    content.append(this.results, this.details);
    this.dialog.append(
      header,
      this.search,
      this.categories,
      this.status,
      this.retry,
      this.resetSearch,
      content,
    );
    this.backdrop.append(this.dialog);
    document.body.append(this.backdrop);
    this.clearSelection();
    const options = { signal: this.listeners.signal };
    this.search.addEventListener('input', () => this.renderResults(), options);
    // All catalog keyboard and pointer input belongs to this modal.
    this.backdrop.addEventListener(
      'keydown',
      (event) => {
        event.stopPropagation();
        if (event.code === 'Escape') {
          event.preventDefault();
          close();
          return;
        }
        if (event.key !== 'Tab') return;
        const controls = [
          ...this.dialog.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), [tabindex="0"]',
          ),
        ].filter((node) => !node.hidden && node.getClientRects().length > 0);
        const first = controls[0],
          last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      },
      options,
    );
    this.backdrop.addEventListener('keyup', (event) => event.stopPropagation(), options);
    this.backdrop.addEventListener('pointerdown', (event) => event.stopPropagation(), options);
    this.backdrop.addEventListener('click', (event) => event.stopPropagation(), options);
    this.backdrop.addEventListener('wheel', (event) => event.stopPropagation(), {
      ...options,
      passive: true,
    });
    document.addEventListener(
      'focusin',
      (event) => {
        if (this.visible && !this.dialog.contains(event.target as Node)) this.focus();
      },
      options,
    );
    document.addEventListener(
      'visibilitychange',
      () => {
        if (document.hidden) this.releasePreview();
        else if (this.visible && this.selectedId) void this.loadPreview();
      },
      options,
    );
  }
  get visible() {
    return !this.backdrop.hidden;
  }
  diagnostics() {
    return {
      visible: this.visible,
      selectedId: this.selectedId,
      previewReady: this.previewReady,
      unavailable: this.unavailable,
      placeDisabled: this.placeButton.disabled,
    };
  }
  focus() {
    const target = !this.search.disabled
      ? this.search
      : !this.retry.hidden
        ? this.retry
        : this.dialog.querySelector<HTMLButtonElement>('header button');
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  loading(retry: () => void) {
    this.releasePreview();
    this.backdrop.hidden = false;
    this.catalog = undefined;
    this.retryAction = retry;
    this.status.textContent = 'Загружаем каталог…';
    this.search.disabled = true;
    this.categories.replaceChildren();
    this.results.replaceChildren();
    this.retry.hidden = this.resetSearch.hidden = true;
    this.details.hidden = true;
    this.dialog.scrollTop = 0;
    this.focus();
  }
  error(message = 'Не удалось загрузить каталог. Повторите попытку.') {
    this.status.textContent = message;
    this.retry.hidden = false;
    this.retry.focus();
  }
  show(
    catalog: PlacementCatalog,
    manifest: WorldManifest,
    read: ModelResourceReader,
    preserveSelection = false,
  ) {
    this.catalog = catalog;
    this.manifest = manifest;
    this.read = read;
    this.backdrop.hidden = false;
    this.search.disabled = false;
    this.retry.hidden = true;
    this.details.hidden = false;
    if (!Object.hasOwn(catalog.categories, this.category)) this.category = '';
    if (!preserveSelection) this.clearSelection();
    this.renderCategories();
    this.renderResults();
    if (this.selectedId) void this.loadPreview();
    if (!preserveSelection) this.dialog.scrollTop = 0;
    this.focus();
  }
  hide(returnFocus = false) {
    this.backdrop.hidden = true;
    this.releasePreview();
    if (returnFocus) this.gameCanvas.focus({ preventScroll: true });
  }
  setUnavailable(value: boolean) {
    this.unavailable = value;
    const disabled = value || !this.previewReady;
    if (this.placeButton.disabled !== disabled) this.placeButton.disabled = disabled;
  }
  clearSelection() {
    this.selectedId = undefined;
    this.releasePreview();
    this.heading.textContent = 'Выберите модель';
    this.description.textContent =
      'Выберите объект из списка, чтобы рассмотреть его и разместить в мире.';
    this.dimensions.textContent = '';
    this.previewCanvas.hidden = true;
    this.previewStatus.textContent = '';
    this.retryPreview.hidden = true;
    this.rotateButton.disabled = this.resetViewButton.disabled = true;
  }
  private renderCategories() {
    if (!this.catalog) return;
    const entries = [
      ['', 'Все'],
      ...Object.entries(this.catalog.categories).map(([id, value]) => [id, value.name]),
    ];
    this.categories.replaceChildren(
      ...entries.map(([id, name]) => {
        const control = button(name, () => {
          this.category = id;
          this.renderCategories();
          this.renderResults();
          this.categories.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus();
        });
        control.dataset.category = id;
        control.setAttribute('aria-pressed', String(id === this.category));
        return control;
      }),
    );
  }
  private renderResults() {
    if (!this.catalog) return;
    const models = filterPlacementModels(this.catalog.models, this.search.value, this.category);
    if (this.selectedId && !models.some((model) => model.assetId === this.selectedId))
      this.clearSelection();
    this.status.textContent = models.length
      ? `Найдено моделей: ${models.length}`
      : 'Ничего не найдено. Измените условия поиска.';
    this.resetSearch.hidden = models.length > 0;
    this.results.replaceChildren(
      ...models.map((model) => {
        const control = button('', () => {
          this.selectedId = model.assetId;
          for (const other of this.results.querySelectorAll<HTMLButtonElement>('button'))
            other.setAttribute('aria-pressed', String(other === control));
          void this.loadPreview();
        });
        control.classList.add('placement-catalog-card');
        control.dataset.assetId = model.assetId;
        control.setAttribute('aria-pressed', String(model.assetId === this.selectedId));
        const icon = document.createElement('span');
        icon.className = 'placement-catalog-icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent =
          ({ vegetation: '♧', lighting: '☼', barriers: '▥' } as Record<string, string>)[
            model.metadata.category
          ] ?? '▱';
        const name = document.createElement('span');
        name.textContent = model.metadata.name;
        control.append(icon, name);
        return control;
      }),
    );
  }
  private releasePreview() {
    this.generation++;
    this.controller?.abort();
    this.controller = undefined;
    this.previewReady = false;
    this.placeButton.disabled = true;
    this.preview?.dispose();
    this.preview = undefined;
  }
  private async loadPreview() {
    if (!this.visible || document.hidden || !this.catalog || !this.manifest || !this.read) return;
    const model = this.catalog.models.find((entry) => entry.assetId === this.selectedId);
    if (!model) return;
    // Keep the engine while browsing; cancel and release the previous model only.
    this.generation++;
    const generation = this.generation;
    this.controller?.abort();
    const controller = (this.controller = new AbortController());
    this.previewReady = false;
    this.placeButton.disabled = true;
    this.rotateButton.disabled = this.resetViewButton.disabled = true;
    this.heading.textContent = model.metadata.name;
    this.description.textContent = model.metadata.description;
    const descriptor = this.manifest.assets[model.assetId];
    const { min, max } = descriptor.bounds;
    const number = new Intl.NumberFormat('ru', { maximumFractionDigits: 2 });
    this.dimensions.textContent = `Габариты: ${[max.x - min.x, max.y - min.y, max.z - min.z].map((value) => number.format(value)).join(' × ')} м`;
    this.previewCanvas.hidden = false;
    this.previewStatus.textContent = 'Загружаем модель…';
    this.retryPreview.hidden = true;
    try {
      this.preview ??= new ModelPreview(this.previewCanvas);
      await this.preview.select(descriptor, this.read, controller.signal);
      if (generation !== this.generation || controller.signal.aborted) return;
      this.previewReady = true;
      this.previewStatus.textContent = 'Модель готова';
      this.placeButton.disabled = this.unavailable;
      this.rotateButton.disabled = this.resetViewButton.disabled = false;
    } catch (error) {
      if (generation !== this.generation || controller.signal.aborted) return;
      this.previewStatus.textContent = 'Не удалось загрузить модель.';
      this.retryPreview.hidden = false;
      console.warn('Model preview failed', error);
    }
  }
  dispose() {
    this.hide();
    this.listeners.abort();
    this.backdrop.remove();
  }
}
