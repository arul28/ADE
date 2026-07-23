export function abortSignalError(
  signal: AbortSignal,
  fallbackMessage: string,
): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error(
    typeof signal.reason === "string" && signal.reason.trim()
      ? signal.reason
      : fallbackMessage,
  );
  error.name = "AbortError";
  return error;
}

export async function runWithAbortSignal<T>(
  run: () => Promise<T> | T,
  signal: AbortSignal | undefined,
  fallbackMessage: string,
): Promise<T> {
  if (!signal) return await run();
  if (signal.aborted) throw abortSignalError(signal, fallbackMessage);
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const settle = (complete: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      complete();
    };
    const onAbort = (): void => {
      settle(() => reject(abortSignalError(signal, fallbackMessage)));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve()
      .then(run)
      .then(
        (value) => settle(() => resolve(value)),
        (error) => settle(() => reject(error)),
      );
  });
}
