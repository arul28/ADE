import { useCallback, useRef, useState } from "react";

/**
 * What a row is waiting on. Keyed per row, so one row never locks another.
 * "stopping" is a cancelled account pairing that main is still finishing.
 */
export type RowAction =
  | "connect"
  | "stopping"
  | "cancel"
  | "disconnect"
  | "remove"
  | "autoConnect";

export function accountRowKey(machineKey: string): string {
  return `account:${machineKey}`;
}

/**
 * Per-row busy state and connect-attempt ownership for the Machines pane.
 * Saved targets are keyed by target id, account machines by
 * `account:<machineKey>`, nearby machines by their id.
 */
export function useRowActions() {
  const [busyById, setBusyById] = useState<Record<string, RowAction>>({});
  // The connect attempt each row owns right now. Cancel drops the entry, and an
  // attempt that is no longer the owner ignores whatever main answers later.
  const connectAttemptsRef = useRef(new Map<string, number>());
  const nextConnectAttemptRef = useRef(0);
  // Pairings main is still running, by row. Main cannot interrupt a pairing and
  // does not dedupe them, so a cancelled one keeps its row locked until it
  // settles; a Connect before then would start a second pairing.
  const pairingsInFlightRef = useRef(new Map<string, Promise<unknown>>());

  const setRowBusy = useCallback((rowId: string, action: RowAction | null) => {
    setBusyById((current) => {
      if (action == null) {
        if (!(rowId in current)) return current;
        const next = { ...current };
        delete next[rowId];
        return next;
      }
      return current[rowId] === action ? current : { ...current, [rowId]: action };
    });
  }, []);

  // Ends `action` on a row only if the row still holds it: a Connect started
  // while a cancel or disconnect was awaiting main owns the row now.
  const finishRowAction = useCallback((rowId: string, action: RowAction) => {
    setBusyById((current) => {
      if (current[rowId] !== action) return current;
      const next = { ...current };
      delete next[rowId];
      return next;
    });
  }, []);

  const beginConnectAttempt = useCallback(
    (rowId: string): number => {
      nextConnectAttemptRef.current += 1;
      const attempt = nextConnectAttemptRef.current;
      connectAttemptsRef.current.set(rowId, attempt);
      setRowBusy(rowId, "connect");
      return attempt;
    },
    [setRowBusy],
  );

  const isConnectAttemptCurrent = useCallback(
    (rowId: string, attempt: number) =>
      connectAttemptsRef.current.get(rowId) === attempt,
    [],
  );

  const endConnectAttempt = useCallback(
    (rowId: string, attempt: number) => {
      if (connectAttemptsRef.current.get(rowId) !== attempt) return;
      connectAttemptsRef.current.delete(rowId);
      setRowBusy(rowId, null);
    },
    [setRowBusy],
  );

  /**
   * Abandons the row's connect attempt, if it has one, and frees the row, or
   * marks it stopping while a pairing it started is still running in main.
   */
  const dropConnectAttempt = useCallback(
    (rowId: string) => {
      if (!connectAttemptsRef.current.delete(rowId)) return;
      setRowBusy(rowId, pairingsInFlightRef.current.has(rowId) ? "stopping" : null);
    },
    [setRowBusy],
  );

  /** Records a pairing the row is waiting on until main settles it. */
  const trackPairing = useCallback(
    <T>(rowId: string, pairing: Promise<T>): Promise<T> => {
      pairingsInFlightRef.current.set(rowId, pairing);
      const settle = () => {
        if (pairingsInFlightRef.current.get(rowId) !== pairing) return;
        pairingsInFlightRef.current.delete(rowId);
        setBusyById((current) => {
          if (current[rowId] !== "stopping") return current;
          const next = { ...current };
          delete next[rowId];
          return next;
        });
      };
      void pairing.then(settle, settle);
      return pairing;
    },
    [],
  );

  const isPairingInFlight = useCallback(
    (rowId: string) => pairingsInFlightRef.current.has(rowId),
    [],
  );

  return {
    busyById,
    setRowBusy,
    finishRowAction,
    beginConnectAttempt,
    isConnectAttemptCurrent,
    endConnectAttempt,
    dropConnectAttempt,
    trackPairing,
    isPairingInFlight,
  };
}
