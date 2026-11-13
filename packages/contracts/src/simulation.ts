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
