import type { AvatarSkinId, SimulationConfig } from '@su/contracts';
import { CharacterPreview } from '../ui/character-preview';
import { applyAccent } from '../ui/theme';

/** Owns the lobby-only scene and the accent shared with in-world UI. */
export class LobbyPreview {
  private preview?: CharacterPreview;
  private accent = '';

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly fallback: HTMLImageElement,
  ) {}

  get color(): string {
    return this.accent || '#6EE0C4';
  }

  setAccent(color: string): void {
    if (color === this.accent) return;
    this.accent = color;
    applyAccent(color);
  }

  update(
    visible: boolean,
    skinId: AvatarSkinId,
    color: string,
    character?: SimulationConfig['character'],
  ): void {
    if (!visible) {
      this.dispose();
      return;
    }
    this.setAccent(color);
    if (!this.preview && character) {
      try {
        this.canvas.hidden = false;
        this.preview = new CharacterPreview(this.canvas, character, skinId, color);
        this.fallback.hidden = true;
      } catch (error) {
        console.warn('Character preview unavailable', error);
        this.canvas.hidden = true;
        this.fallback.hidden = false;
      }
    }
    this.preview?.setSkin(skinId);
    this.preview?.setColor(color);
  }

  dispose(): void {
    this.preview?.dispose();
    this.preview = undefined;
    this.canvas.hidden = true;
    this.fallback.hidden = false;
  }
}
