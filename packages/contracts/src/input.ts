export const INPUT_TIMEOUT_MS = 250;
export const MAX_INPUT_QUEUE = 32;
export const MAX_PREDICTION_MS = 500;

export type MoveInput = { moveX: number; moveZ: number; sprint?: boolean; facingYaw?: number };
export const NEUTRAL_INPUT: Readonly<MoveInput> = Object.freeze({
  moveX: 0,
  moveZ: 0,
  sprint: false,
});
export function normalizeInput(value: unknown): MoveInput | undefined {
  if (!value || typeof value !== 'object') return;
  const { moveX, moveZ, sprint = false, facingYaw } = value as MoveInput;
  if (
    typeof moveX !== 'number' ||
    typeof moveZ !== 'number' ||
    !Number.isFinite(moveX) ||
    !Number.isFinite(moveZ) ||
    typeof sprint !== 'boolean'
  )
    return;
  if (Math.abs(moveX) > 100 || Math.abs(moveZ) > 100) return;
  const length = Math.max(1, Math.hypot(moveX, moveZ));
  const input: MoveInput = { moveX: moveX / length, moveZ: moveZ / length, sprint };
  if (typeof facingYaw === 'number' && Number.isFinite(facingYaw))
    input.facingYaw = normalizeYaw(facingYaw);
  return input;
}
/** World yaw: zero faces +Z. Canonical range includes -PI and excludes +PI. */
export function normalizeYaw(yaw: number): number {
  if (yaw >= -Math.PI && yaw < Math.PI) return yaw;
  const turn = Math.PI * 2;
  return (((yaw % turn) + Math.PI + turn) % turn) - Math.PI;
}
