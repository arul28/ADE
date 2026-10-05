import { useEffect, useMemo, useState } from "react";

import type { TerminalSessionSummary } from "../../../shared/types";
import { selectActiveProjectStateKey, useAppStore, useRootAppStore } from "../../state/appStore";
import { nextSnoozeDeadlineMs } from "../../lib/sessionSnooze";

const LIFECYCLE_TICK_MAX_DELAY_MS = 10 * 60 * 1000;

/**
 * Read a chat's terminal-session row out of the local per-project cache the Work
 * tab already mirrors into the store, falling back to the root cross-machine
 * snapshot for a foreign chat. No extra IPC, and it stays as fresh as the
 * sidebar it is mirroring.
 */
export function useSessionLifecycleSnapshot(
  sessionId: string | null | undefined,
): TerminalSessionSummary | null {
  const projectStateKey = useAppStore(selectActiveProjectStateKey);
  const cached = useAppStore((state) =>
    (projectStateKey ? state.sessionsCacheByProject[projectStateKey] : undefined),
  );
  const crossMachineLanesByMachineId = useRootAppStore((state) => state.crossMachineLanesByMachineId);
  const snapshot = useMemo(() => {
    const id = sessionId?.trim();
    if (!id) return null;
    const local = cached?.find((session) => session.id === id);
    if (local) return local;
    for (const machine of Object.values(crossMachineLanesByMachineId)) {
      const foreign = machine.sessions.find((session) => session.id === id);
      if (foreign) return foreign;
    }
    return null;
  }, [cached, crossMachineLanesByMachineId, sessionId]);

  // A snooze is represented by a persisted deadline, not a scheduler event.
  // Arm one deadline timer here so an open chat header/composer re-renders when
  // the row becomes live even if the session cache object never changes.
  const [lifecycleEpoch, setLifecycleEpoch] = useState(0);
  useEffect(() => {
    const deadlineMs = nextSnoozeDeadlineMs(snapshot ? [snapshot] : []);
    if (deadlineMs == null) return undefined;
    const delay = Math.min(
      Math.max(deadlineMs - Date.now(), 250),
      LIFECYCLE_TICK_MAX_DELAY_MS,
    );
    const timer = window.setTimeout(() => setLifecycleEpoch((value) => value + 1), delay);
    return () => window.clearTimeout(timer);
  }, [lifecycleEpoch, snapshot]);

  return snapshot;
}
