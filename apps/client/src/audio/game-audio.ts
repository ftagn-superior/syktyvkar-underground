import type { Vec3 } from '@su/contracts';
import { CreateAudioEngineAsync } from '@babylonjs/core/AudioV2/webAudio/webAudioEngine';
import type { AudioEngineV2 } from '@babylonjs/core/AudioV2/abstractAudio/audioEngineV2';
import type { AudioBus } from '@babylonjs/core/AudioV2/abstractAudio/audioBus';
import type { StaticSound } from '@babylonjs/core/AudioV2/abstractAudio/staticSound';
import { SoundState } from '@babylonjs/core/AudioV2/soundState';
import {
  AUDIO_SAMPLES,
  DEFAULT_AUDIO_SETTINGS,
  MAX_UI_VOICES,
  MAX_WORLD_VOICES,
  SETTINGS_KEY,
  UI_GAIN,
  UI_SAMPLES,
  WORLD_MIX,
  WORLD_SAMPLES,
  chooseVariant,
  clampUnit,
  distanceGain,
  listenerYaw,
  samplesFor,
  sanitizeSettings,
  validPosition,
  type AudioSettings,
  type UiCue,
  type WorldCue,
} from './policy';

export type { AudioSettings, UiCue, WorldCue } from './policy';
export type WorldSoundOptions = {
  typeId?: string;
  strength?: number;
  own?: boolean;
  sourceId?: string;
};
type Voice = {
  sound: StaticSound;
  sample: string;
  world: boolean;
  until: number;
  priority: number;
};

/** Client presentation only: no audio callbacks belong in prediction or server physics replay. */
export class GameAudio {
  private engine?: AudioEngineV2;
  private worldBus?: AudioBus;
  private uiBus?: AudioBus;
  private voices: Voice[] = [];
  private currentSettings: AudioSettings = { ...DEFAULT_AUDIO_SETTINGS };
  private listener?: Vec3;
  private cameraAngle = Math.PI / 4;
  private active = true;
  private disposed = false;
  private ready = false;
  private unlockRequested = false;
  private unlockedOnce = false;
  private contextTransition?: Promise<void>;
  private contextWatchdog?: ReturnType<typeof setInterval>;
  private loadedAssets = 0;
  private failedAssets = 0;
  private errors = 0;
  private dropped = 0;
  private played: Record<string, number> = {};
  private lastSample = new Map<string, string>();
  private lastPlayed = new Map<string, number>();

  constructor() {
    try {
      this.currentSettings = sanitizeSettings(
        JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null'),
      );
    } catch {
      /* Storage can be unavailable; sound preferences remain session-local. */
    }
    void this.prepare().catch(() => {
      this.errors++;
      this.ready = true;
    });
  }

  get settings(): AudioSettings {
    return { ...this.currentSettings };
  }

  updateSettings(partial: Partial<AudioSettings>): void {
    if (this.disposed) return;
    this.currentSettings = sanitizeSettings(partial, this.currentSettings);
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.currentSettings));
    } catch {
      /* Optional. */
    }
    this.safely(() => {
      if (this.currentSettings.muted || this.currentSettings.volume === 0) this.stopAll();
      this.applyVolume();
    });
  }

  /** Call directly from a click, key or touch handler; never await this in the game entry flow. */
  unlock(): void {
    if (this.disposed) return;
    this.unlockRequested = true;
    this.safely(() => this.reconcileContext());
  }

  setActive(active: boolean): void {
    if (this.disposed || active === this.active) return;
    this.active = active;
    this.safely(() => {
      this.stopAll();
      this.applyVolume();
      this.reconcileContext();
    });
  }

  setListener(position: Vec3 | undefined, cameraAngle?: number): void {
    if (this.disposed) return;
    if (!validPosition(position)) {
      if (this.listener) this.stopWorld();
      this.listener = undefined;
      return;
    }
    this.listener = { ...position };
    if (cameraAngle !== undefined && Number.isFinite(cameraAngle)) this.cameraAngle = cameraAngle;
    this.safely(() => this.updateListener());
  }

  playUi(cue: UiCue): void {
    this.safely(() => {
      if (!this.canPlay(false)) return;
      const now = performance.now();
      // Opening one panel can close another in the same event. Keep only one transition sound.
      const key = cue === 'open' || cue === 'close' ? 'ui:panel' : `ui:${cue}`;
      if (!this.allow(key, now, cue === 'error' ? 250 : 45)) return;
      this.start(UI_SAMPLES[cue], false, UI_GAIN[cue], 1, 3, now, `ui:${cue}`);
    });
  }

  playWorld(cue: WorldCue, position: Vec3, options: WorldSoundOptions = {}): void {
    this.safely(() => {
      if (!this.canPlay(true) || !this.listener || !validPosition(position)) return;
      const mix = WORLD_MIX[cue];
      const attenuation = distanceGain(this.listener, position, mix.near, mix.far);
      const strength = clampUnit(options.strength, 1);
      if (attenuation <= 0 || strength === 0) {
        this.dropped++;
        return;
      }
      const now = performance.now();
      const family = cue === 'run' ? 'step' : cue;
      const key = `${family}:${options.sourceId ?? `${position.x.toFixed(1)},${position.z.toFixed(1)}`}`;
      if (!this.allow(key, now, mix.cooldown)) return;
      const requested = samplesFor(cue, options.typeId);
      let available = requested.filter((sample) =>
        this.voices.some((v) => v.world && v.sample === sample),
      );
      // A missing material recording may use a loaded soft impact; never retry a failed request per event.
      if (!available.length && (cue === 'place' || cue === 'impact'))
        available = samplesFor('impact').filter((sample) =>
          this.voices.some((v) => v.world && v.sample === sample),
        );
      const sample = chooseVariant(available, this.lastSample.get(key));
      if (!sample) {
        this.dropped++;
        return;
      }
      const footsteps = cue === 'step' || cue === 'run';
      const gain =
        mix.gain *
        (footsteps && !options.own ? 0.63 : 1) *
        strength *
        (0.94 + Math.random() * 0.12);
      const rate = footsteps ? 0.97 + Math.random() * 0.06 : 1;
      const priority = attenuation * gain + (options.own ? 0.5 : 0) + (footsteps ? 0 : 0.15);
      if (this.start(sample, true, gain, rate, priority, now, cue, position, mix.near, mix.far))
        this.lastSample.set(key, sample);
    });
  }

  stopWorld(): void {
    this.safely(() => {
      for (const voice of this.voices)
        if (voice.world) {
          voice.sound.stop();
          voice.until = 0;
        }
      this.lastPlayed.clear();
      this.lastSample.clear();
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.contextWatchdog);
    this.safely(() => {
      this.stopAll();
      this.engine?.dispose();
    });
    this.voices = [];
    this.listener = undefined;
    this.engine = undefined;
  }

  diagnostics() {
    const now = performance.now();
    return {
      ready: this.ready,
      unlocked: this.engine?.state === 'running',
      contextState: this.engine?.state ?? 'unavailable',
      contextTransition: !!this.contextTransition,
      active: this.active,
      disposed: this.disposed,
      loadedAssets: this.loadedAssets,
      failedAssets: this.failedAssets,
      errors: this.errors,
      dropped: this.dropped,
      played: { ...this.played },
      activeWorldVoices: this.voices.filter((v) => v.world && v.until > now).length,
      activeUiVoices: this.voices.filter((v) => !v.world && v.until > now).length,
      totalVoices: this.voices.length,
      listener: this.listener ? { ...this.listener } : undefined,
      settings: this.settings,
    } as const;
  }

  private async prepare(): Promise<void> {
    const engine = await CreateAudioEngineAsync({
      listenerEnabled: true,
      listenerAutoUpdate: false,
      disableDefaultUI: true,
      resumeOnInteraction: true,
      resumeOnPause: false,
    });
    if (this.disposed) {
      engine.dispose();
      return;
    }
    this.engine = engine;
    this.applyVolume();
    this.reconcileContext();
    // Browsers may suspend/interrupt a previously unlocked context without a visibility
    // event. Use our active state, not Babylon's unconditional resumeOnPause timer.
    this.contextWatchdog = setInterval(
      () =>
        this.safely(() => {
          if (this.disposed || !this.engine) return;
          if (this.engine.state === 'running') this.unlockedOnce = true;
          if (this.active && !this.unlockedOnce) return;
          if (this.engine.state !== 'running') this.stopAll();
          this.reconcileContext();
        }),
      1000,
    );
    [this.worldBus, this.uiBus] = await Promise.all([
      engine.createBusAsync('world'),
      engine.createBusAsync('ui'),
    ]);
    if (this.disposed) {
      engine.dispose();
      return;
    }
    this.applyVolume();
    await Promise.all(
      AUDIO_SAMPLES.map(async (sample) => {
        try {
          // One bounded decode per asset. All source voices share this immutable buffer.
          const buffer = await engine.createSoundBufferAsync(
            `${import.meta.env.BASE_URL}audio/${sample}.wav`,
          );
          if (this.disposed) return;
          const world = WORLD_SAMPLES.includes(sample);
          const count = world ? 3 : 2;
          for (let index = 0; index < count; index++) {
            if (this.disposed) return;
            const sound = await engine.createSoundAsync(`${sample}:${index}`, buffer, {
              outBus: world ? this.worldBus : this.uiBus,
              maxInstances: 1,
              autoplay: false,
              ...(world
                ? {
                    spatialEnabled: true,
                    spatialAutoUpdate: false,
                    spatialDistanceModel: 'linear',
                    spatialMinDistance: 2,
                    spatialMaxDistance: 24,
                    spatialRolloffFactor: 1,
                    spatialPanningModel: 'equalpower',
                  }
                : {}),
            });
            if (this.disposed) {
              sound.dispose();
              return;
            }
            this.voices.push({ sound, sample, world, until: 0, priority: 0 });
          }
          this.loadedAssets++;
        } catch {
          this.failedAssets++;
        }
      }),
    );
    if (this.disposed) return;
    this.ready = true;
    this.updateListener();
  }

  private canPlay(world: boolean): boolean {
    if (
      this.disposed ||
      !this.active ||
      this.currentSettings.muted ||
      this.currentSettings.volume === 0 ||
      (world ? this.currentSettings.worldVolume : this.currentSettings.uiVolume) === 0 ||
      this.engine?.state !== 'running' ||
      (world && !this.listener)
    ) {
      this.dropped++;
      return false;
    }
    return true;
  }

  private reconcileContext(): void {
    const engine = this.engine;
    if (this.disposed || !engine || this.contextTransition || engine.state === 'closed') return;
    const active = this.active;
    if (active) {
      // Babylon 9.35 caches resumeAsync's promise until statechange -> running.
      // Calling it while already running leaves a fulfilled cache, preventing the
      // next real resume after suspend. Ordinary movement keydowns must be no-ops.
      if (engine.state === 'running') {
        this.unlockedOnce = true;
        return;
      }
      if (!this.unlockRequested && !this.unlockedOnce) return;
    } else if (engine.state === 'suspended') return;

    // A delayed pause must finish before focus returning may resume, and vice versa.
    // Mute and voice disposal are immediate; this only orders native context work.
    const transition = active ? engine.unlockAsync() : engine.pauseAsync();
    this.contextTransition = transition;
    void transition
      .then(
        () => {
          if (engine.state === 'running') this.unlockedOnce = true;
        },
        () => {
          this.errors++;
        },
      )
      .then(() => {
        if (this.contextTransition !== transition) return;
        this.contextTransition = undefined;
        // Reconcile changed intent once. Failed unchanged intent waits for a later
        // gesture/watchdog tick instead of spinning in a rejected-promise loop.
        if (this.active !== active) this.safely(() => this.reconcileContext());
      });
  }

  private allow(key: string, now: number, interval: number): boolean {
    if (now - (this.lastPlayed.get(key) ?? -Infinity) < interval) {
      this.dropped++;
      return false;
    }
    // Source IDs may be unbounded across long sessions; keep the cooldown history bounded too.
    if (this.lastPlayed.size >= 256) {
      for (const [oldKey, time] of this.lastPlayed)
        if (now - time > 2000) {
          this.lastPlayed.delete(oldKey);
          this.lastSample.delete(oldKey);
        }
      if (this.lastPlayed.size >= 256) {
        const oldest = this.lastPlayed.keys().next().value as string;
        this.lastPlayed.delete(oldest);
        this.lastSample.delete(oldest);
      }
    }
    this.lastPlayed.set(key, now);
    return true;
  }

  private start(
    sample: string,
    world: boolean,
    gain: number,
    rate: number,
    priority: number,
    now: number,
    cue: string,
    position?: Vec3,
    near = 2,
    far = 24,
  ): boolean {
    const pool = this.voices.filter((v) => v.world === world);
    let voice = pool.find((v) => v.sample === sample && v.until <= now);
    if (!voice) {
      const sameSample = pool
        .filter((v) => v.sample === sample)
        .sort((a, b) => a.priority - b.priority)[0];
      if (!sameSample || sameSample.priority >= priority) {
        this.dropped++;
        return false;
      }
      voice = sameSample;
      voice.sound.stop();
      voice.until = 0;
    }
    const active = pool.filter((v) => v.until > now);
    if (active.length >= (world ? MAX_WORLD_VOICES : MAX_UI_VOICES)) {
      const weakest = active.sort((a, b) => a.priority - b.priority)[0];
      if (weakest.priority > priority) {
        this.dropped++;
        return false;
      }
      weakest.sound.stop();
      weakest.until = 0;
    }
    if (world && position) {
      voice.sound.spatial.position.set(position.x, position.y, position.z);
      voice.sound.spatial.minDistance = near;
      voice.sound.spatial.maxDistance = far;
      voice.sound.spatial.update();
    }
    voice.sound.playbackRate = rate;
    voice.sound.play({ volume: gain });
    if (voice.sound.state === SoundState.FailedToStart) {
      this.dropped++;
      return false;
    }
    voice.until = now + (voice.sound.buffer.duration / rate) * 1000;
    voice.priority = priority;
    this.played[cue] = (this.played[cue] ?? 0) + 1;
    return true;
  }

  private updateListener(): void {
    if (!this.engine || !this.listener) return;
    this.engine.listener.position.set(this.listener.x, this.listener.y, this.listener.z);
    this.engine.listener.rotation.set(0, listenerYaw(this.cameraAngle), 0);
    this.engine.listener.update();
  }

  private applyVolume(): void {
    if (this.engine)
      this.engine.volume =
        this.active && !this.currentSettings.muted ? this.currentSettings.volume : 0;
    if (this.worldBus) this.worldBus.volume = this.currentSettings.worldVolume;
    if (this.uiBus) this.uiBus.volume = this.currentSettings.uiVolume;
  }

  private stopAll(): void {
    for (const voice of this.voices) {
      voice.sound.stop();
      voice.until = 0;
    }
    this.lastPlayed.clear();
    this.lastSample.clear();
  }

  private safely(action: () => void): void {
    try {
      action();
    } catch {
      this.errors++;
    }
  }
}
