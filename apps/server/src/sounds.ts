import type { WorldSoundEvent, Vec3 } from '@su/contracts';

export interface SoundRecipient {
  connected: boolean;
  position?: Vec3;
  send: (event: WorldSoundEvent) => void;
}

/** Cosmetic messages are best-effort and cannot break simulation or durable item writes. */
export function deliverWorldSound(
  event: WorldSoundEvent,
  recipients: Iterable<SoundRecipient>,
): void {
  for (const recipient of recipients) {
    const p = recipient.position;
    if (
      !recipient.connected ||
      !p ||
      Math.hypot(p.x - event.position.x, p.y - event.position.y, p.z - event.position.z) > 40
    )
      continue;
    try {
      recipient.send(event);
    } catch {
      /* A client can disconnect between selection and send. */
    }
  }
}
