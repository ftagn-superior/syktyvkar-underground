import type { ItemState } from './items.js';

export const TICK_RATE = 60;
export const STEP_SECONDS = 1 / TICK_RATE;
export type Vec3 = { x: number; y: number; z: number };
export type Quat = Vec3 & { w: number };
export type Bounds = { min: Vec3; max: Vec3 };
export interface SimulationConfig {
  tickRate: number;
  gravity: Vec3;
  character: { height: number; radius: number; speed: number; sprintSpeed: number; mass: number };
}
export interface EntityState {
  entityId: string;
  kind: 'player' | 'item';
  revision: number;
  position: Vec3;
  rotation: Quat;
  velocity: Vec3;
  angularVelocity: Vec3;
}
export interface PlayerState extends EntityState {
  kind: 'player';
  grounded: boolean;
  /** Множитель скорости ходьбы и бега от `/speed`; отсутствует при обычной скорости. */
  speedScale?: number;
}

/**
 * Пределы `/speed` в процентах обычной скорости. По сети множитель передаётся целым процентом,
 * поэтому сервер и предсказание клиента получают одно и то же число `percent / 100`.
 */
export const PLAYER_SPEED_PERCENT = { min: 10, max: 400, normal: 100 } as const;
export function speedScaleFromPercent(percent: number): number | undefined {
  return percent === PLAYER_SPEED_PERCENT.normal ? undefined : percent / 100;
}
export function speedPercentFromScale(scale: number | undefined): number {
  return Math.round((scale ?? 1) * 100);
}
export interface SimulationSnapshot {
  scope: 'authoritative';
  players: PlayerState[];
  items: ItemState[];
}
/** Partial replication must never be passed as the authoritative server snapshot. */
export interface LocalSimulationSnapshot {
  scope: 'local';
  players: PlayerState[];
  items: ItemState[];
}
