import { useEffect, useMemo, useState } from "react";
import { Moon } from "@phosphor-icons/react";

import type { OpenProjectBinding, TerminalSessionSummary } from "../../../shared/types";
import { selectActiveProjectStateKey, useAppStore, useRootAppStore } from "../../state/appStore";
import { isSessionSnoozed, nextSnoozeDeadlineMs, snoozeWakeLabel } from "../../lib/sessionSnooze";
import { wakeSessionNow } from "../terminals/sessionLifecycleActions";
import { cn } from "../ui/cn";

/**
 * Ambient snooze chip for a chat surface header.
 *
 * Settled state lives only in the compact composer-adjacent pill; repeating it
 * in the header added chrome without adding information. Snooze stays here
 * because its wake deadline is useful away from the composer too.
 */

const CHIP_CLASS =
  "inline-flex h-5 shrink-0 items-center gap-1 rounded-md border border-white/[0.10] bg-white/[0.04] px-1.5 font-sans text-[10px] font-medium text-muted-fg/75 transition-colors hover:border-white/[0.18] hover:text-fg/85";
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

function ChipMenu({
  label,
  items,
  onClose,
}: {
  label: string;
  items: Array<{ key: string; label: string; onSelect: () => void }>;
  onClose: () => void;
}) {
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        role="menu"
        aria-label={label}
        className="ade-liquid-glass-menu absolute left-0 top-full z-50 mt-1 min-w-[150px] py-1"
      >
        {items.map((item) => (
          <button
            key={item.key}
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 rounded px-3 py-1.5 text-left text-xs transition-colors hover:bg-muted/40"
            onClick={() => {
              onClose();
              item.onSelect();
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
    </>
  );
}

export function SessionSnoozeChip({
  sessionId,
  className,
  runtimePin = null,
}: {
  sessionId: string | null | undefined;
  className?: string;
  runtimePin?: OpenProjectBinding | null;
}) {
  const session = useSessionLifecycleSnapshot(sessionId);
  const [menuOpen, setMenuOpen] = useState(false);

  if (!session) return null;

  const snoozed = isSessionSnoozed(session);
  if (!snoozed) return null;

  const wakeLabel = snoozeWakeLabel(session.snoozedUntil);

  return (
    <span className={cn("relative inline-flex", className)}>
      <button
        type="button"
        className={CHIP_CLASS}
        data-testid="chat-session-snoozed-chip"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label={wakeLabel ? `Snoozed, ${wakeLabel}` : "Snoozed"}
        title={wakeLabel ? `Snoozed — ${wakeLabel}` : "Snoozed"}
        onClick={() => setMenuOpen((current) => !current)}
      >
        <Moon size={10} weight="fill" aria-hidden />
        snoozed
      </button>
      {menuOpen ? (
        <ChipMenu
          label="Snoozed session"
          onClose={() => setMenuOpen(false)}
          items={[
            { key: "wake", label: "Wake now", onSelect: () => { void wakeSessionNow(session, runtimePin); } },
          ]}
        />
      ) : null}
    </span>
  );
}
