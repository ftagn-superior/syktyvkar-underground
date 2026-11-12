import type { GameAudio } from '../audio/game-audio';

export class AudioSettings {
  private readonly controller = new AbortController();
  private readonly buttons = ['audio-toggle', 'audio-lobby-toggle'].map(
    (id) => document.getElementById(id) as HTMLButtonElement,
  );
  private readonly sliders = [
    ['audio-volume', 'volume'],
    ['audio-world-volume', 'worldVolume'],
    ['audio-ui-volume', 'uiVolume'],
  ] as const;

  constructor(private readonly audio: GameAudio) {
    const options = { signal: this.controller.signal };
    for (const button of this.buttons)
      button.addEventListener(
        'click',
        () => {
          audio.updateSettings({ muted: !audio.settings.muted });
          audio.unlock();
          this.render();
        },
        options,
      );
    for (const [id, key] of this.sliders) {
      const slider = document.getElementById(id) as HTMLInputElement;
      slider.addEventListener(
        'input',
        () => {
          audio.updateSettings({ [key]: Number(slider.value) / 100 });
          audio.unlock();
          this.render();
        },
        options,
      );
    }
    this.render();
  }

  private render(): void {
    const settings = this.audio.settings;
    for (const button of this.buttons) {
      button.textContent = settings.muted ? 'Звук выключен' : 'Звук включён';
      button.setAttribute('aria-pressed', String(!settings.muted));
      button.title = settings.muted ? 'Включить звук' : 'Выключить звук';
    }
    for (const [id, key] of this.sliders) {
      const value = String(Math.round(settings[key] * 100));
      (document.getElementById(id) as HTMLInputElement).value = value;
      document.getElementById(`${id}-value`)!.textContent = `${value}%`;
    }
  }
  dispose(): void {
    this.controller.abort();
  }
}
