import {
  AVATAR_SKINS,
  DEFAULT_AVATAR_SKIN,
  resolveAvatarSkinId,
  type AvatarSkinId,
} from '@su/contracts';

/** The same catalog supplies account settings and the guest entry choice. */
export class AvatarPicker {
  private readonly fieldset = document.getElementById('avatar-skins') as HTMLFieldSetElement;
  private readonly inputs: HTMLInputElement[] = [];
  constructor(onChange: () => void) {
    const options = document.getElementById('avatar-skin-options')!;
    for (const skin of AVATAR_SKINS) {
      const label = document.createElement('label');
      label.className = 'skin-choice';
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'avatar-skin';
      input.value = skin.id;
      input.checked = skin.id === DEFAULT_AVATAR_SKIN;
      input.addEventListener('change', onChange);
      const preview = document.createElement('img');
      preview.src = `/avatars/${skin.id}.svg`;
      preview.alt = '';
      preview.width = preview.height = 76;
      const title = document.createElement('strong');
      title.textContent = skin.label;
      const description = document.createElement('small');
      description.textContent = skin.description;
      label.append(input, preview, title, description);
      options.append(label);
      this.inputs.push(input);
    }
  }
  get value(): AvatarSkinId {
    return resolveAvatarSkinId(this.inputs.find((input) => input.checked)?.value);
  }
  set value(value: AvatarSkinId) {
    for (const input of this.inputs) input.checked = input.value === value;
  }
  set disabled(value: boolean) {
    this.fieldset.disabled = value;
  }
}
