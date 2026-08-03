import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Runs a user-initiated async action and reports whether it is in flight.
 *
 * Adapted from interior.dev's `useAsyncAction` (MIT), reduced to the two
 * guarantees the renderer's hand-rolled `const [busy, setBusy] = useState(false)`
 * pairs keep getting wrong:
 *
 * - **Re-entrancy.** `phaseRef` is set synchronously, so a double-click in one
 *   tick cannot start the action twice — a `busy` state flag flips a render
 *   later and does not.
 * - **Unmount.** A settle after the component is gone is dropped, instead of
 *   updating state on a dead component.
 *
 * Callers keep their own error state and populate it from `onError`; this hook
 * deliberately does not model success/error phases, because every current
 * caller unmounts or navigates away on success.
 */

export type UseAsyncActionOptions<T> = {
  action: () => T | Promise<T>;
  onSuccess?: (value: T) => void;
  onError?: (error: unknown) => void;
};

export type UseAsyncActionResult = {
  run: () => void;
  pending: boolean;
};

export function useAsyncAction<T>({
  action,
  onSuccess,
  onError,
}: UseAsyncActionOptions<T>): UseAsyncActionResult {
  const [pending, setPending] = useState(false);

  // `pending` is async; `phaseRef` is the synchronous truth `run` guards on.
  const phaseRef = useRef(false);
  const runIdRef = useRef(0);
  const mountedRef = useRef(true);

  const actionRef = useRef(action);
  const onSuccessRef = useRef(onSuccess);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    actionRef.current = action;
    onSuccessRef.current = onSuccess;
    onErrorRef.current = onError;
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const run = useCallback(() => {
    if (phaseRef.current) return;

    const id = ++runIdRef.current;
    phaseRef.current = true;
    setPending(true);

    const settle = () => {
      if (!mountedRef.current || id !== runIdRef.current) return;
      phaseRef.current = false;
      setPending(false);
    };

    // `Promise.resolve().then` so a synchronous throw in `action` lands in the
    // rejection path rather than escaping `run`.
    Promise.resolve()
      .then(() => actionRef.current())
      .then(
        (value) => {
          if (mountedRef.current && id === runIdRef.current) onSuccessRef.current?.(value);
          settle();
        },
        (reason: unknown) => {
          if (mountedRef.current && id === runIdRef.current) onErrorRef.current?.(reason);
          settle();
        },
      );
  }, []);

  return { run, pending };
}
