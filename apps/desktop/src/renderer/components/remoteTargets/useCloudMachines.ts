import { useCallback, useEffect, useRef, useState } from "react";
import { cloudMachineSettling, type CloudMachinesResult } from "../../../shared/adeCloud";
import { extractError } from "../../lib/format";

/** While a box is waking, sleeping or resizing, how often its state is read again. */
const SETTLING_POLL_MS = 4_000;
/** A box that never settles stops the quick re-reads after this; focus reads again. */
const SETTLING_POLL_LIMIT_MS = 5 * 60_000;

export type CloudMachinesState = {
  /** The last answer; it stays while a refresh runs, so the cards never flicker. */
  result: CloudMachinesResult | null;
  loading: boolean;
  /** ADE could not ask at all (the call threw). */
  loadError: string | null;
  refresh: () => void;
};

/**
 * The account's ADE Cloud boxes for the machine list. Account-level: it asks
 * this desktop's main process with no pin (cloud access is the account's).
 *
 * Read when the list opens, on window focus and when the integration changes,
 * never on a standing poll; only while a box is moving between states does it
 * read again every few seconds, until the box settles.
 */
export function useCloudMachines(enabled: boolean): CloudMachinesState {
  const bridge = window.ade?.cloud;
  const [result, setResult] = useState<CloudMachinesResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const generation = useRef(0);
  const settlingSince = useRef<number | null>(null);

  const load = useCallback(() => {
    const listMachines = bridge?.listMachines;
    if (!enabled || !listMachines) return;
    const current = ++generation.current;
    setLoading(true);
    void listMachines().then(
      (next) => {
        if (current !== generation.current) return;
        setResult(next);
        setLoadError(null);
      },
      (error: unknown) => {
        if (current !== generation.current) return;
        setLoadError(extractError(error));
      },
    ).finally(() => {
      if (current === generation.current) setLoading(false);
    });
  }, [bridge, enabled]);

  useEffect(() => {
    if (!enabled) {
      generation.current += 1;
      setResult(null);
      return;
    }
    load();
    const off = bridge?.onStatusChanged?.(load);
    window.addEventListener("focus", load);
    return () => {
      off?.();
      window.removeEventListener("focus", load);
    };
  }, [bridge, enabled, load]);

  const settling = Boolean(result?.machines.some((machine) => cloudMachineSettling(machine.state)));
  useEffect(() => {
    if (!settling) {
      settlingSince.current = null;
      return;
    }
    settlingSince.current ??= Date.now();
    if (Date.now() - settlingSince.current > SETTLING_POLL_LIMIT_MS) return;
    const timer = window.setTimeout(load, SETTLING_POLL_MS);
    return () => window.clearTimeout(timer);
  }, [load, result, settling]);

  return { result, loading, loadError, refresh: load };
}
