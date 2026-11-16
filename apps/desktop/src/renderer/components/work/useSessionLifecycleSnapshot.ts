import { useEffect, useState } from "react";

import type { TerminalSessionSummary } from "../../../shared/types";
import { selectActiveProjectStateKey, useAppStore, useRootAppStore } from "../../state/appStore";
import { isSessionSnoozed, nextSnoozeDeadlineMs } from "../../lib/sessionSnooze";
import { canonicalInputFromSummary, sessionCanonicalUiState } from "../../lib/terminalAttention";

const LIFECYCLE_TICK_MAX_DELAY_MS = 10 * 60 * 1000;

type CrossMachineSessions = Record<string, { sessions: readonly TerminalSessionSummary[] }>;

function findForeignSession(
  crossMachineLanesByMachineId: CrossMachineSessions,
  id: string,
): TerminalSessionSummary | null {
  for (const machine of Object.values(crossMachineLanesByMachineId)) {
    const foreign = machine.sessions.find((session) => session.id === id);
    if (foreign) return foreign;
  }
  return null;
}

/**
 * A snooze is a persisted deadline, not a scheduler event. Re-render once
 * when the soonest deadline passes, so a reader shows the row as live even
 * if no store write happens at that moment.
 */
function useSnoozeDeadlineTick(snoozedUntil: string | null | undefined): void {
  const [lifecycleEpoch, setLifecycleEpoch] = useState(0);
  useEffect(() => {
    const deadlineMs = nextSnoozeDeadlineMs([{ snoozedUntil: snoozedUntil ?? null }]);
    if (deadlineMs == null) return undefined;
    const delay = Math.min(
      Math.max(deadlineMs - Date.now(), 250),
      LIFECYCLE_TICK_MAX_DELAY_MS,
    );
    const timer = window.setTimeout(() => setLifecycleEpoch((value) => value + 1), delay);
    return () => window.clearTimeout(timer);
  }, [lifecycleEpoch, snoozedUntil]);
}

/**
 * Read a chat's terminal-session row out of the local per-project cache the Work
 * tab already mirrors into the store, falling back to the root cross-machine
 * snapshot for a foreign chat. No extra IPC, and it stays as fresh as the
 * sidebar it is mirroring.
 *
 * The selectors return the row, not the list: the Work list keeps the object
 * of a row that did not change, so a refresh that changed another chat does
 * not re-render this reader.
 */
export function useSessionLifecycleSnapshot(
  sessionId: string | null | undefined,
): TerminalSessionSummary | null {
  const id = sessionId?.trim() || null;
  const projectStateKey = useAppStore(selectActiveProjectStateKey);
  const local = useAppStore((state) => (
    id && projectStateKey
      ? state.sessionsCacheByProject[projectStateKey]?.find((session) => session.id === id) ?? null
      : null
  ));
  const foreign = useRootAppStore((state) => (
    id && !local ? findForeignSession(state.crossMachineLanesByMachineId, id) : null
  ));
  const snapshot = local ?? foreign;
  useSnoozeDeadlineTick(snapshot?.snoozedUntil);
  return snapshot;
}

/** What the lifecycle pill reads from a row, as one comparable value. */
function lifecyclePillInputs(session: TerminalSessionSummary | null | undefined): string | null {
  if (!session) return null;
  const settled = sessionCanonicalUiState(canonicalInputFromSummary(session)).phase === "settled";
  return `${settled ? "1" : "0"}|${session.snoozedUntil ?? ""}`;
}

/**
 * Whether the composer shows the settled or snoozed pill for this chat
 * (`shouldRenderChatLifecyclePill` on the row), for a reader that draws
 * nothing else of the row. The selectors return only the pill's inputs, so a
 * Work list refresh that changes the row's other fields (a running chat's
 * preview or activity time) does not re-render the reader. The chat pane used
 * to re-render whole on every such refresh for this one boolean.
 */
export function useSessionLifecyclePillVisible(sessionId: string | null | undefined): boolean {
  const id = sessionId?.trim() || null;
  const projectStateKey = useAppStore(selectActiveProjectStateKey);
  const localInputs = useAppStore((state) => (
    id && projectStateKey
      ? lifecyclePillInputs(state.sessionsCacheByProject[projectStateKey]?.find((session) => session.id === id))
      : null
  ));
  const foreignInputs = useRootAppStore((state) => (
    id && localInputs == null
      ? lifecyclePillInputs(findForeignSession(state.crossMachineLanesByMachineId, id))
      : null
  ));
  const inputs = localInputs ?? foreignInputs;
  const separator = inputs?.indexOf("|") ?? -1;
  const settled = inputs != null && inputs.startsWith("1");
  const snoozedUntil = inputs != null && separator >= 0 ? inputs.slice(separator + 1) || null : null;
  useSnoozeDeadlineTick(snoozedUntil);
  if (inputs == null) return false;
  return isSessionSnoozed({ snoozedUntil }) || settled;
}
