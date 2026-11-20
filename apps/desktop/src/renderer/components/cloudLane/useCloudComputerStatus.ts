import { useEffect, useState } from "react";
import type { CloudComputerStatus } from "../../../shared/adeCloud";

/**
 * A lane computer's live status (`window.ade.cloud.computerStatus`), read
 * once when its menu opens: no poll, no wake. Account level, by the computer's
 * ADE Cloud id, like the list (the server reads it wherever the lane runs).
 * A read this window made in the last `KEEP_MS` is shown at once and not
 * asked again, so opening the menu twice costs one read.
 */

const KEEP_MS = 20_000;
const kept = new Map<string, { at: number; status: CloudComputerStatus | null }>();

/** Drops the kept read after this window changed the computer (a sleep, a wake), so the next open reads again. */
export function forgetCloudComputerStatus(instanceId: string): void {
  kept.delete(instanceId);
}

export function useCloudComputerStatus(instanceId: string): { status: CloudComputerStatus | null; loading: boolean } {
  const fresh = kept.get(instanceId);
  const initial = fresh && Date.now() - fresh.at < KEEP_MS ? fresh : null;
  const [state, setState] = useState<{ id: string; status: CloudComputerStatus | null; loading: boolean }>(() => ({
    id: instanceId,
    status: initial?.status ?? null,
    loading: initial == null,
  }));
  useEffect(() => {
    const hit = kept.get(instanceId);
    if (hit && Date.now() - hit.at < KEEP_MS) {
      setState({ id: instanceId, status: hit.status, loading: false });
      return;
    }
    const read = window.ade?.cloud?.computerStatus;
    if (!read) {
      setState({ id: instanceId, status: null, loading: false });
      return;
    }
    let live = true;
    setState((current) => ({ id: instanceId, status: current.id === instanceId ? current.status : null, loading: true }));
    void read(instanceId).then(
      (status) => {
        kept.set(instanceId, { at: Date.now(), status: status ?? null });
        if (live) setState({ id: instanceId, status: status ?? null, loading: false });
      },
      (error: unknown) => {
        // The menu shows what the list and the account already say.
        console.warn("[cloud] reading a lane computer's status failed", error);
        if (live) setState({ id: instanceId, status: null, loading: false });
      },
    );
    return () => {
      live = false;
    };
  }, [instanceId]);
  return state.id === instanceId ? { status: state.status, loading: state.loading } : { status: null, loading: true };
}
