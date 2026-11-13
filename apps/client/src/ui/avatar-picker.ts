import { DEFAULT_AVATAR_SKIN, resolveAvatarSkinId, type AvatarSkinId } from '@su/contracts';
import { CHARACTERS, UPCOMING_CHARACTERS, type CharacterEntry } from './characters';

/** Полоса персонажей и стрелки у предпросмотра. Радиокнопки держат группу нативной для клавиатуры. */
export class AvatarPicker {
  private readonly fieldset = document.getElementById('avatar-skins') as HTMLFieldSetElement;
  private readonly options = document.getElementById('avatar-skin-options')!;
  private readonly inputs = new Map<string, HTMLInputElement>();
  private readonly cards = new Map<string, HTMLElement>();
  private selected: AvatarSkinId = DEFAULT_AVATAR_SKIN;
  private name = '';
  private colorLabel = '';

  constructor(private readonly onChange: () => void) {
    for (const character of CHARACTERS) this.options.append(this.buildCard(character));
    const more = document.getElementById('avatar-more')!;
    more.textContent = `Ещё ${UPCOMING_CHARACTERS} ${plural(UPCOMING_CHARACTERS)} появятся с обновлениями`;
    more.hidden = UPCOMING_CHARACTERS <= 0;
    document.getElementById('preview-prev')!.addEventListener('click', () => this.step(-1));
    document.getElementById('preview-next')!.addEventListener('click', () => this.step(1));
    this.render();
  }
  get value(): AvatarSkinId {
    return this.selected;
  }
  set value(value: AvatarSkinId) {
    this.selected = resolveAvatarSkinId(value);
    this.render();
  }
  set disabled(value: boolean) {
    this.fieldset.disabled = value;
    for (const id of ['preview-prev', 'preview-next'])
      (document.getElementById(id) as HTMLButtonElement).disabled = value;
  }
  /** The plate under the preview shows the in-progress name and colour. */
  setIdentity(name: string, colorLabel: string): void {
    this.name = name;
    this.colorLabel = colorLabel;
    this.renderPlate();
  }
  private step(direction: -1 | 1): void {
    const index = CHARACTERS.findIndex((character) => character.skinId === this.selected);
    const next = CHARACTERS[(index + direction + CHARACTERS.length) % CHARACTERS.length];
    this.choose(next.skinId);
  }
  private choose(skinId: AvatarSkinId): void {
    if (skinId === this.selected) return;
    this.selected = skinId;
    this.render();
    this.onChange();
  }
  private buildCard(character: CharacterEntry): HTMLElement {
    const card = document.createElement('label');
    card.className = 'ui-btn r-card';
    card.dataset.characterId = character.id;
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'avatar-skin';
    input.value = character.skinId;
    input.setAttribute('aria-label', character.name);
    input.addEventListener('change', () => input.checked && this.choose(character.skinId));
    const image = document.createElement('img');
    image.src = `/avatars/${character.id}.svg`;
    image.alt = '';
    image.width = 36;
    image.height = 52;
    const copy = document.createElement('span');
    const name = document.createElement('span');
    name.textContent = character.name;
    const status = document.createElement('small');
    status.className = 'st';
    copy.append(name, status);
    card.append(input, image, copy);
    this.inputs.set(character.id, input);
    this.cards.set(character.id, card);
    return card;
  }
  private render(): void {
    for (const character of CHARACTERS) {
      const card = this.cards.get(character.id)!;
      const on = character.skinId === this.selected;
      this.inputs.get(character.id)!.checked = on;
      card.classList.toggle('is-on', on);
      card.querySelector('.st')!.textContent = on ? 'Выбран' : 'Доступен';
    }
    const fallback = document.getElementById('preview-fallback') as HTMLImageElement;
    fallback.src = `/avatars/${this.selected}.svg`;
    this.renderPlate();
  }
  private renderPlate(): void {
    const character = CHARACTERS.find((entry) => entry.skinId === this.selected);
    document.getElementById('plate-name')!.textContent = this.name || 'Игрок';
    document.getElementById('plate-model')!.textContent = [character?.name, this.colorLabel]
      .filter(Boolean)
      .join(' · ');
    document.getElementById('plate-description')!.textContent = character?.description ?? '';
  }
}

function plural(count: number): string {
  const tens = count % 100;
  const ones = count % 10;
  if (tens >= 11 && tens <= 14) return 'персонажей';
  if (ones === 1) return 'персонаж';
  if (ones >= 2 && ones <= 4) return 'персонажа';
  return 'персонажей';
}
