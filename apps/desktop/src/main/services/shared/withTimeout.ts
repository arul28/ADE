/** `promise`'s value, or null once `ms` pass or it rejects. The timer never keeps the process alive. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    timer.unref?.();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(null); },
    );
  });
}

/**
 * `work`'s value, or a rejection with `timeoutError()` once `timeoutMs` pass.
 * The timer never keeps the process alive, and both handlers are attached up
 * front, so a rejection from the abandoned work after the deadline is handled
 * here instead of surfacing as an unhandled one.
 */
export function withDeadline<T>(
  work: Promise<T>,
  timeoutMs: number,
  timeoutError: () => Error = () => new Error(`The operation did not finish within ${timeoutMs}ms.`),
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(timeoutError()), Math.max(1, timeoutMs));
    timer.unref?.();
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}
