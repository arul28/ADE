import { useCallback, useEffect, useState } from "react";
import type { SyncRoleSnapshot } from "../../shared/types";
import { readThisMachineRefusal, type ThisMachineRefusal } from "../../shared/accountMachineRefusal";
import { readLocalSyncStatus } from "../lib/localSyncStatusReader";

/** A refusal rarely changes on its own; this only catches a missed broadcast. */
const REFUSAL_REFRESH_MS = 60_000;

function sameRefusal(a: ThisMachineRefusal | null, b: ThisMachineRefusal | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.code === b.code && a.revokedAt === b.revokedAt && a.recoveryGaveUpAt === b.recoveryGaveUpAt;
}

/**
 * Is the account directory refusing THIS computer right now?
 *
 * Read from this machine's own sync snapshot (`routeHealth.accountDirectory`),
 * never from a remote-bound project's runtime: the refusal belongs to the
 * physical machine this window runs on. The `sync-status` event is only an
 * invalidation, for the same reason AppShell's relay banner treats it so.
 */
export function useThisComputerRefusal(): {
  refusal: ThisMachineRefusal | null;
  refresh: () => void;
} {
  const [refusal, setRefusal] = useState<ThisMachineRefusal | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((value) => value + 1), []);

  useEffect(() => {
    const syncApi = window.ade?.sync;
    if (!syncApi) return;
    let cancelled = false;
    let readLocal: ((force: boolean) => Promise<SyncRoleSnapshot>) | null = null;
    // Capability probe for old preloads, as in AppShell.
    if (typeof syncApi.getLocalStatus === "function") {
      readLocal = (force) => readLocalSyncStatus({ force });
    } else if (typeof syncApi.getStatus === "function") {
      readLocal = () => syncApi.getStatus();
    }
    const read = (force = false) => {
      if (!readLocal) return;
      void readLocal(force)
        .then((snapshot) => {
          if (cancelled) return;
          const next = readThisMachineRefusal(snapshot?.routeHealth?.accountDirectory);
          setRefusal((previous) => (sameRefusal(previous, next) ? previous : next));
        })
        .catch(() => {});
    };
    // A refresh someone asked for (after a reconnect) must not be served the
    // read that was already in flight before the repair.
    read(tick > 0);
    const onFocus = () => read();
    const dispose = syncApi.onEvent?.((event) => {
      if (event.type === "sync-status") read();
    });
    const interval = window.setInterval(onFocus, REFUSAL_REFRESH_MS);
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      dispose?.();
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [tick]);

  return { refusal, refresh };
}
