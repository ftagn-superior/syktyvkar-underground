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

  begin(requestId: number, id: AnimationId, sequence: number, now: number): void {
    this.pending = { requestId, id, sequence, deadline: now + 5000, accepted: false };
    this.message = '';
  }
  result(result: ActionResult): boolean {
    if (result.requestId !== this.pending?.requestId) return false;
    if (result.ok) this.accept();
    else {
      this.message =
        result.code === 'RATE_LIMITED'
          ? 'Дождитесь окончания текущей анимации.'
          : result.code === 'ANIMATION_NOT_ALLOWED'
            ? 'Дождитесь опоры; для танца остановитесь.'
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
  clear(): void {
    this.pending = undefined;
    this.message = '';
  }
}
