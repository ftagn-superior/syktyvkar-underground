import {
  PROFILE_COLORS,
  parseProfileUpdate,
  resolveAvatarSkinId,
  type AccountResponse,
  type AccountView,
  type PlayerProfile,
} from '@su/contracts';
import { AvatarPicker } from './avatar-picker';
import { ColorPicker } from './color-picker';
import { applyAccent } from './theme';

const guestSkinKey = 'su:guest-skin:v1';
function guestSkin() {
  try {
    return resolveAvatarSkinId(sessionStorage.getItem(guestSkinKey));
  } catch {
    return resolveAvatarSkinId(undefined);
  }
}

const errors: Record<string, string> = {
  AUTH_REQUIRED: 'Войдите через Telegram ещё раз.',
  INVALID_PROFILE:
    'Имя должно содержать от 2 до 24 символов. Выберите цвет и внешность из каталога.',
  PROFILE_CONFLICT:
    'Профиль изменён в другой вкладке. Загружены актуальные данные; повторите изменение.',
  RATE_LIMITED: 'Слишком много запросов. Подождите минуту и повторите.',
  INVALID_ORIGIN: 'Не удалось подтвердить запрос. Обновите страницу.',
};

/** Account settings live in the lobby; game connections consume the saved profile on join. */
export class AccountPanel {
  account: AccountView | null = null;
  enabled = false;
  loading = true;
  private csrfToken?: string;
  private saving = false;
  private readonly skins: AvatarPicker;
  private readonly panel = document.getElementById('account-panel')!;
  private readonly form = document.getElementById('profile-form') as HTMLFormElement;
  private readonly name = document.getElementById('profile-name') as HTMLInputElement;
  private readonly colors: ColorPicker;
  private readonly logout = document.getElementById('account-logout') as HTMLButtonElement;
  private readonly retry = document.getElementById('account-retry') as HTMLButtonElement;
  private readonly message = document.getElementById('account-message')!;
  private readonly login = document.getElementById('telegram-login') as HTMLAnchorElement;
  private readonly note = document.getElementById('welcome-note')!;

  constructor(
    private readonly onChange: () => void,
    private readonly beforeLogout: () => Promise<void>,
  ) {
    this.skins = new AvatarPicker(() => {
      if (!this.account) {
        try {
          sessionStorage.setItem(guestSkinKey, this.skins.value);
        } catch {
          /* Optional preference. */
        }
      }
      this.onChange();
    });
    this.skins.value = guestSkin();
    this.colors = new ColorPicker(
      document.getElementById('profile-swatches')!,
      document.getElementById('profile-color-label')!,
      () => {
        this.preview();
        this.onChange();
      },
    );
    this.name.addEventListener('input', () => this.preview());
    this.form.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.submit();
    });
    this.logout.addEventListener('click', () => {
      void this.signOut();
    });
    this.retry.addEventListener('click', () => {
      void this.load();
    });
    this.preview();
  }
  async load(): Promise<void> {
    this.loading = true;
    this.skins.disabled = this.colors.disabled = true;
    this.retry.hidden = true;
    this.onChange();
    try {
      const response = await fetch('/api/me', {
        cache: 'no-store',
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error('ACCOUNTS_UNAVAILABLE');
      const state = (await response.json()) as AccountResponse;
      this.enabled = state.enabled;
      this.account = state.account;
      this.csrfToken = state.csrfToken;
      this.render();
      const url = new URL(location.href);
      const result = url.searchParams.get('login');
      if (result) {
        this.message.textContent =
          result === 'success' && state.account
            ? 'Вход выполнен. Имя, цвет и внешность сохраняются в аккаунте.'
            : result === 'expired'
              ? 'Время входа истекло. Повторите вход через Telegram.'
              : result === 'unavailable'
                ? 'Не удалось сохранить аккаунт. Попробуйте войти позже.'
                : 'Вход через Telegram не завершён. Можно повторить попытку.';
        url.searchParams.delete('login');
        history.replaceState(null, '', url.pathname + url.search + url.hash);
      }
    } catch {
      this.enabled = true;
      this.account = null;
      this.csrfToken = undefined;
      this.render();
      this.retry.hidden = false;
      this.message.textContent =
        'Не удалось загрузить аккаунт. Повторите загрузку или войдите гостем.';
    } finally {
      this.loading = false;
      this.skins.disabled = this.colors.disabled = false;
      this.preview();
      this.onChange();
    }
  }
  private render(): void {
    this.panel.hidden = !this.enabled;
    this.form.hidden = !this.account;
    this.login.hidden = !!this.account;
    this.logout.hidden = !this.account;
    this.message.textContent = '';
    if (this.account) this.fill(this.account.profile);
    else {
      this.skins.value = guestSkin();
      this.preview();
    }
    this.note.textContent = this.account
      ? 'Имя, цвет и персонаж сохранятся при входе. Один персонаж на аккаунт.'
      : this.enabled
        ? 'Гостю доступны движение и толкание. Для инвентаря войдите через Telegram.'
        : 'Без регистрации. Для второго игрока откройте ещё одну вкладку.';
  }
  private fill(profile: PlayerProfile): void {
    this.name.value = profile.displayName;
    this.colors.value = profile.colorId;
    this.skins.value = profile.skinId;
    this.preview();
  }
  /** Colour, plate and accent follow the form live; nothing is saved until the player enters. */
  private preview(): void {
    applyAccent(this.previewColor);
    this.skins.setIdentity(this.account ? this.name.value.trim() : '', this.colorLabel);
  }
  private get colorLabel(): string {
    return this.account ? this.colors.colorLabel : '';
  }
  /** Guests are coloured by the server, so their preview keeps the default mint. */
  get previewColor(): string {
    return this.account ? this.colors.hex : PROFILE_COLORS[0].hex;
  }
  private async submit(): Promise<boolean> {
    if (!this.account || this.saving) return false;
    const update = parseProfileUpdate({
      displayName: this.name.value,
      colorId: this.colors.value,
      skinId: this.skins.value,
      version: this.account.profile.version,
    });
    if (!update) {
      this.message.textContent = errors.INVALID_PROFILE;
      return false;
    }
    this.saving = true;
    this.skins.disabled = this.colors.disabled = true;
    this.logout.disabled = true;
    this.onChange();
    try {
      const response = await fetch('/api/me/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': this.csrfToken! },
        body: JSON.stringify(update),
        signal: AbortSignal.timeout(10000),
      });
      const result = await response.json();
      if (response.status === 409 && result.profile) {
        this.account.profile = result.profile;
        this.fill(result.profile);
      }
      if (!response.ok) throw new Error(result.code);
      this.account.profile = result.profile;
      this.fill(result.profile);
      this.message.textContent = 'Профиль сохранён.';
      return true;
    } catch (error) {
      this.message.textContent =
        errors[(error as Error).message] ??
        'Не удалось подтвердить сохранение. Проверьте соединение и повторите попытку.';
      return false;
    } finally {
      this.saving = false;
      this.skins.disabled = this.colors.disabled = false;
      this.logout.disabled = false;
      this.onChange();
    }
  }
  get selectedSkinId() {
    return this.skins.value;
  }
  async prepareJoin(): Promise<boolean> {
    if (this.busy) return false;
    const profile = this.account?.profile;
    if (!profile) return true;
    const changed =
      this.name.value !== profile.displayName ||
      this.colors.value !== profile.colorId ||
      this.skins.value !== profile.skinId;
    return changed ? this.submit() : true;
  }
  private async signOut(): Promise<void> {
    if (!this.account || this.saving) return;
    this.saving = true;
    this.logout.disabled = true;
    this.onChange();
    try {
      await this.beforeLogout();
      const response = await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'X-CSRF-Token': this.csrfToken! },
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error('Logout failed');
      await this.load();
      this.message.textContent = 'Вы вышли из аккаунта.';
    } catch {
      this.message.textContent = 'Не удалось подтвердить выход из аккаунта. Повторите попытку.';
    } finally {
      this.saving = false;
      this.logout.disabled = false;
      this.onChange();
    }
  }
  get busy(): boolean {
    return this.loading || this.saving;
  }
}
