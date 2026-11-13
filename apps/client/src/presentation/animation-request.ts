import type { ActionResult, AnimationId, AnimationPlayback } from '@su/contracts';

/** A successful reply keeps the request locked until replication (or a bounded timeout). */
export class AnimationRequestState {
  pending?: {
    requestId: number;
    id: AnimationId;
    sequence: number;
    deadline: number;
    accepted: boolean;
  };
  accepted = 0;
  message = '';
  /** Server cooldown, which grows when the player spams animations. */
  private availableAt = 0;

  begin(requestId: number, id: AnimationId, sequence: number, now: number): void {
    this.pending = { requestId, id, sequence, deadline: now + 5000, accepted: false };
    this.message = '';
  }
  result(result: ActionResult, now = performance.now()): boolean {
    if (result.requestId !== this.pending?.requestId) return false;
    if ((result.ok || result.code === 'RATE_LIMITED') && Number.isFinite(result.retryAfterMs))
      this.availableAt = now + Math.max(0, result.retryAfterMs!);
    if (result.ok) this.accept();
    else {
      this.message =
        result.code === 'RATE_LIMITED'
          ? 'Слишком часто — подождите немного.'
          : result.code === 'ANIMATION_NOT_ALLOWED'
            ? 'Дождитесь опоры; для движений всем телом остановитесь.'
            : result.code === 'WORLD_NOT_READY'
              ? 'Мир пока недоступен.'
              : result.code === 'STALE_WORLD'
                ? 'Мир изменился. Войдите снова.'
                : 'Сервер отклонил анимацию. Попробуйте снова.';
      this.pending = undefined;
    }
    return true;
  }
  observe(playback: AnimationPlayback): void {
    if (
      this.pending &&
      playback.sequence > this.pending.sequence &&
      (playback.animationId === this.pending.id ||
        (playback.animationId === null &&
          (this.pending.accepted || playback.sequence > this.pending.sequence + 1)))
    ) {
      this.accept();
      this.pending = undefined;
    }
  }
  private accept(): void {
    if (this.pending && !this.pending.accepted) {
      this.pending.accepted = true;
      this.accepted++;
      this.message = '';
    }
  }
  expire(now: number): void {
    if (this.pending && now >= this.pending.deadline) {
      this.pending = undefined;
      this.message = 'Подтверждение анимации не получено. Проверьте связь и попробуйте снова.';
    }
  }
  remainingMs(now = performance.now()): number {
    return Math.max(0, this.availableAt - now);
  }
  /** Reconnect keeps the accepted cooldown; `reset` forgets it with the session. */
  clear(): void {
    this.pending = undefined;
    this.message = '';
  }
  reset(): void {
    this.clear();
    this.availableAt = 0;
  }
}
