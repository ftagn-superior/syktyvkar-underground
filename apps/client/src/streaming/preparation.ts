/** Return the preparation slot on abort; dispose a non-abortable loader's late result. */
export function abortablePreparation<T>(
  pending: Promise<T>,
  signal: AbortSignal,
  release: (value: T) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let cancelled = signal.aborted;
    const abort = () => {
      cancelled = true;
      reject(new DOMException('Preparation cancelled', 'AbortError'));
    };
    if (cancelled) abort();
    else signal.addEventListener('abort', abort, { once: true });
    void pending
      .then(
        (value) => {
          signal.removeEventListener('abort', abort);
          if (cancelled) release(value);
          else resolve(value);
        },
        (error) => {
          signal.removeEventListener('abort', abort);
          reject(error);
        },
      )
      .catch(reject);
  });
}
