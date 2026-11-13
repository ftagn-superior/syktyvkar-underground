import {
  REACTION_COOLDOWN_MS,
  WORLD_ACTIVITY_MOVE_DURATION_MS,
  chatCooldownMs,
  findAnimation,
  findAvatarSkin,
  findReaction,
  isPlayerMoving,
  millisecondsToTicks,
  ticksToMilliseconds,
  type ActionResult,
  type ErrorCode,
  type MoveInput,
  type PlayerState,
} from '@su/contracts';
import type { PlayerSchema } from '@su/protocol';

type ActivityResult = Omit<ActionResult, 'requestId'>;

function result(code?: ErrorCode, retryAfterMs?: number): ActivityResult {
  return {
    ok: code === undefined,
    ...(code ? { code } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
}

/** Natural expiry preserves the original end tick and does not start a new sequence. */
function expireAnimation(player: PlayerSchema, tick: number): void {
  if (player.animationId && player.animationEndsAtTick && tick >= player.animationEndsAtTick) {
    player.animationId = '';
    player.animationChangedAtTick = player.animationEndsAtTick;
  }
}

/** Interruptions are distinct from a naturally completed animation on the client. */
export function cancelAnimation(player: PlayerSchema, tick: number): void {
  expireAnimation(player, tick);
  if (!player.animationId) return;
  player.animationId = '';
  player.animationSequence++;
  player.animationChangedAtTick = tick;
}

/** Call before projecting physics so revision changes still describe a discontinuity. */
export function updatePlayerActivities(
  player: PlayerSchema,
  actual: PlayerState | undefined,
  tick: number,
): void {
  if (actual && (!actual.grounded || actual.revision !== player.revision))
    cancelAnimation(player, tick);
  if (actual && isPlayerMoving(actual.velocity)) {
    const expires = tick + millisecondsToTicks(WORLD_ACTIVITY_MOVE_DURATION_MS);
    if (player.reactionId && !player.reactionExpiresAtTick) player.reactionExpiresAtTick = expires;
    if (player.animationId && !player.animationEndsAtTick) {
      player.animationEndsAtTick = expires;
      player.animationChangedAtTick = tick;
    }
    if (player.chatText && !player.chatExpiresAtTick) player.chatExpiresAtTick = expires;
  }
  expireAnimation(player, tick);
  if (player.reactionId && player.reactionExpiresAtTick && tick >= player.reactionExpiresAtTick) {
    player.reactionId = '';
    player.reactionExpiresAtTick = 0;
  }
  if (player.chatText && player.chatExpiresAtTick && tick >= player.chatExpiresAtTick) {
    player.chatText = '';
    player.chatExpiresAtTick = 0;
  }
}

/** Per-session cooldowns; playback itself lives in the replicated player state. */
export class PlayerActivities {
  private reactionAvailableAtTick = 0;
  private chatAvailableAtTick = 0;

  react(
    player: PlayerSchema | undefined,
    reactionId: unknown,
    tick: number,
    code?: ErrorCode,
  ): ActivityResult {
    const reaction = findReaction(reactionId);
    const remainingTicks = Math.max(
      0,
      this.reactionAvailableAtTick - tick,
      (player?.reactionExpiresAtTick ?? 0) - tick,
    );
    code ??= player ? undefined : 'WORLD_NOT_READY';
    if (!code) {
      if (!reaction) code = 'INVALID_INPUT';
      else if (remainingTicks > 0) code = 'RATE_LIMITED';
      else {
        player!.reactionId = reaction.id;
        player!.reactionSequence++;
        player!.reactionExpiresAtTick = 0;
        this.reactionAvailableAtTick = tick + millisecondsToTicks(REACTION_COOLDOWN_MS);
      }
    }
    return result(
      code,
      code === undefined
        ? REACTION_COOLDOWN_MS
        : code === 'RATE_LIMITED'
          ? ticksToMilliseconds(remainingTicks)
          : undefined,
    );
  }

  animate(
    player: PlayerSchema | undefined,
    actual: PlayerState | undefined,
    lastInput: MoveInput,
    animationId: unknown,
    tick: number,
    code?: ErrorCode,
  ): ActivityResult {
    const animation = findAnimation(animationId);
    if (player) expireAnimation(player, tick);
    const remainingTicks = player?.animationId
      ? Math.max(
          0,
          player.animationStartedAtTick +
            millisecondsToTicks(findAnimation(player.animationId)?.cooldownMs ?? 0) -
            tick,
          player.animationEndsAtTick - tick,
        )
      : 0;
    code ??= player ? undefined : 'WORLD_NOT_READY';
    if (!code) {
      if (!animation) code = 'INVALID_INPUT';
      else if (remainingTicks > 0) code = 'RATE_LIMITED';
      else if (
        !actual?.grounded ||
        findAvatarSkin(player!.skinId)?.rig !== animation.rig ||
        (animation.mode === 'fullBody' &&
          (isPlayerMoving(actual.velocity) || lastInput.moveX !== 0 || lastInput.moveZ !== 0))
      )
        code = 'ANIMATION_NOT_ALLOWED';
      else {
        player!.animationSequence++;
        player!.animationId = animation.id;
        player!.animationStartedAtTick = player!.animationChangedAtTick = tick;
        player!.animationEndsAtTick = 0;
      }
    }
    return result(code, code === 'RATE_LIMITED' ? ticksToMilliseconds(remainingTicks) : undefined);
  }

  /** Text is normalized at dispatch so slash commands never become public speech. */
  chat(
    player: PlayerSchema | undefined,
    text: string | undefined,
    tick: number,
    code?: ErrorCode,
  ): ActivityResult {
    const remainingTicks = Math.max(
      0,
      this.chatAvailableAtTick - tick,
      (player?.chatExpiresAtTick ?? 0) - tick,
    );
    code ??= player ? undefined : 'WORLD_NOT_READY';
    if (!code) {
      if (!text) code = 'INVALID_INPUT';
      else if (remainingTicks > 0) code = 'RATE_LIMITED';
      else {
        player!.chatText = text;
        player!.chatSequence++;
        player!.chatExpiresAtTick = 0;
        this.chatAvailableAtTick = tick + millisecondsToTicks(chatCooldownMs(text));
      }
    }
    // Acknowledgements contain neither message bodies nor a chat history.
    return result(
      code,
      code === undefined
        ? chatCooldownMs(text!)
        : code === 'RATE_LIMITED'
          ? ticksToMilliseconds(remainingTicks)
          : undefined,
    );
  }
}
