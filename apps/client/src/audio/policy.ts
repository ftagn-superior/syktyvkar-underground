import type { Vec3 } from '@su/contracts';

export type UiCue = 'open' | 'close' | 'click' | 'error' | 'pickup' | 'spawn';
export type WorldCue = 'step' | 'run' | 'reaction' | 'place' | 'pickup' | 'impact';
export type AudioSettings = {
  muted: boolean;
  volume: number;
  worldVolume: number;
  uiVolume: number;
};
export const DEFAULT_AUDIO_SETTINGS: Readonly<AudioSettings> = {
  muted: false,
  volume: 0.7,
  worldVolume: 0.8,
  uiVolume: 0.8,
};
export const MAX_WORLD_VOICES = 16;
export const MAX_UI_VOICES = 4;
export const SETTINGS_KEY = 'su.audio.v1';

const concrete = [
  'footstep_concrete_000',
  'footstep_concrete_001',
  'footstep_concrete_002',
  'footstep_concrete_003',
];
const soft = ['impactSoft_medium_000', 'impactSoft_medium_001'];
const wood = ['impactWood_medium_000', 'impactWood_medium_001'];
const generic = ['impactGeneric_light_000'];
const ball = ['impactSoft_heavy_000'];

export const UI_SAMPLES: Record<UiCue, string> = {
  open: 'click_001',
  close: 'click_005',
  click: 'click_003',
  error: 'error_004',
  pickup: 'confirmation_001',
  spawn: 'maximize_007',
};
export const WORLD_SAMPLES = [...concrete, ...soft, ...wood, ...generic, ...ball, 'pluck_001'];
export const AUDIO_SAMPLES = [...new Set([...WORLD_SAMPLES, ...Object.values(UI_SAMPLES)])];

export const WORLD_MIX: Record<
  WorldCue,
  { near: number; far: number; gain: number; cooldown: number }
> = {
  step: { near: 2, far: 18, gain: 0.25, cooldown: 70 },
  run: { near: 2, far: 24, gain: 0.32, cooldown: 70 },
  reaction: { near: 1, far: 12, gain: 0.22, cooldown: 250 },
  place: { near: 2, far: 24, gain: 0.36, cooldown: 120 },
  pickup: { near: 2, far: 18, gain: 0.25, cooldown: 120 },
  impact: { near: 3, far: 30, gain: 0.48, cooldown: 100 },
};
export const UI_GAIN: Record<UiCue, number> = {
  open: 0.22,
  close: 0.16,
  click: 0.2,
  error: 0.24,
  pickup: 0.3,
  spawn: 0.3,
};

export function clampUnit(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : fallback;
}

export function sanitizeSettings(
  value: unknown,
  previous: Readonly<AudioSettings> = DEFAULT_AUDIO_SETTINGS,
): AudioSettings {
  const input = value && typeof value === 'object' ? (value as Partial<AudioSettings>) : {};
  return {
    muted: typeof input.muted === 'boolean' ? input.muted : previous.muted,
    volume: clampUnit(input.volume, previous.volume),
    worldVolume: clampUnit(input.worldVolume, previous.worldVolume),
    uiVolume: clampUnit(input.uiVolume, previous.uiVolume),
  };
}

export function validPosition(position: Vec3 | undefined): position is Vec3 {
  return !!position && [position.x, position.y, position.z].every(Number.isFinite);
}

export function distanceGain(listener: Vec3, source: Vec3, near: number, far: number): number {
  if (!validPosition(listener) || !validPosition(source) || far <= near) return 0;
  const distance = Math.hypot(source.x - listener.x, source.y - listener.y, source.z - listener.z);
  return Math.max(0, Math.min(1, 1 - (distance - near) / (far - near)));
}

export function samplesFor(cue: WorldCue, typeId?: string): readonly string[] {
  if (cue === 'step' || cue === 'run') return concrete;
  if (cue === 'reaction' || cue === 'pickup') return ['pluck_001'];
  if (typeId === 'wooden-crate') return wood;
  if (typeId === 'watermelon-ball') return ball;
  if (typeId === 'confidence-monument' || typeId === 'giant-domino') return generic;
  return soft;
}

/** Choose among available variants without immediately repeating the previous recording. */
export function chooseVariant(
  samples: readonly string[],
  last: string | undefined,
  random = Math.random(),
): string | undefined {
  const candidates = samples.length > 1 ? samples.filter((sample) => sample !== last) : samples;
  if (!candidates.length) return undefined;
  return candidates[
    Math.min(candidates.length - 1, Math.floor(clampUnit(random, 0) * candidates.length))
  ];
}

/** ArcRotateCamera's horizontal gaze is (-cos(alpha), 0, -sin(alpha)); listener forward is -Z. */
export function listenerYaw(cameraAngle: number): number {
  return Math.PI / 2 - cameraAngle;
}
