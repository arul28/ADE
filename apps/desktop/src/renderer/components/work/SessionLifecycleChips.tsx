import { useMemo, useState } from "react";
import { Moon } from "@phosphor-icons/react";

import type { TerminalSessionSummary } from "../../../shared/types";
import { selectActiveProjectStateKey, useAppStore } from "../../state/appStore";
import { canonicalInputFromSummary, sessionCanonicalUiState } from "../../lib/terminalAttention";
import { isSessionSnoozed, snoozeWakeLabel } from "../../lib/sessionSnooze";
import {
  unsettleSession,
  wakeSessionNow,
} from "../terminals/sessionLifecycleActions";
import { cn } from "../ui/cn";

/**
 * Ambient lifecycle chips for a chat surface header. The chat pane had zero
 * lifecycle awareness: a settled or snoozed chat looked identical to a live one
 * once you were inside it.
 *
 * These are HEADER chips, not a strip above the composer — that slot belongs to
 * lane branch drift. State is resolved from the same derived helpers the Work
 * sidebar uses (`sessionCanonicalUiState` + `isSessionSnoozed`), so the chip and
 * the row can never disagree.
 */

const CHIP_CLASS =
  "inline-flex h-5 shrink-0 items-center gap-1 rounded-md border border-white/[0.10] bg-white/[0.04] px-1.5 font-sans text-[10px] font-medium text-muted-fg/75 transition-colors hover:border-white/[0.18] hover:text-fg/85";

/**
 * Read a chat's terminal-session row out of the per-project cache the Work tab
 * already mirrors into the store. No extra IPC, and it stays as fresh as the
 * sidebar it is mirroring.
 */
export function useSessionLifecycleSnapshot(
  sessionId: string | null | undefined,
): TerminalSessionSummary | null {
  const projectStateKey = useAppStore(selectActiveProjectStateKey);
  const cached = useAppStore((state) =>
    (projectStateKey ? state.sessionsCacheByProject[projectStateKey] : undefined),
  );
  return useMemo(() => {
    const id = sessionId?.trim();
    if (!id || !cached) return null;
    return cached.find((session) => session.id === id) ?? null;
  }, [cached, sessionId]);
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

export function SessionLifecycleChips({
  sessionId,
  className,
}: {
  sessionId: string | null | undefined;
  className?: string;
}) {
  const session = useSessionLifecycleSnapshot(sessionId);
  const [openChip, setOpenChip] = useState<"snoozed" | "settled" | null>(null);

  if (!session) return null;

  const snoozed = isSessionSnoozed(session);
  const settled = sessionCanonicalUiState(canonicalInputFromSummary(session)).phase === "settled";
  if (!snoozed && !settled) return null;

  const wakeLabel = snoozeWakeLabel(session.snoozedUntil);

  return (
    <>
      {snoozed ? (
        <span className={cn("relative inline-flex", className)}>
          <button
            type="button"
            className={CHIP_CLASS}
            data-testid="chat-session-snoozed-chip"
            aria-haspopup="menu"
            aria-expanded={openChip === "snoozed"}
            aria-label={wakeLabel ? `Snoozed, ${wakeLabel}` : "Snoozed"}
            title={wakeLabel ? `Snoozed — ${wakeLabel}` : "Snoozed"}
            onClick={() => setOpenChip((current) => (current === "snoozed" ? null : "snoozed"))}
          >
            <Moon size={10} weight="fill" aria-hidden />
            snoozed
          </button>
          {openChip === "snoozed" ? (
            <ChipMenu
              label="Snoozed session"
              onClose={() => setOpenChip(null)}
              items={[
                { key: "wake", label: "Wake now", onSelect: () => { void wakeSessionNow(session); } },
              ]}
            />
          ) : null}
        </span>
      ) : null}

      {settled ? (
        <span className={cn("relative inline-flex", className)}>
          <button
            type="button"
            className={CHIP_CLASS}
            data-testid="chat-session-settled-chip"
            aria-haspopup="menu"
            aria-expanded={openChip === "settled"}
            aria-label="Settled"
            title="Settled"
            onClick={() => setOpenChip((current) => (current === "settled" ? null : "settled"))}
          >
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full border bg-transparent"
              style={{ borderColor: "rgba(255,255,255,0.4)" }}
              aria-hidden
            />
            settled
          </button>
          {openChip === "settled" ? (
            <ChipMenu
              label="Settled session"
              onClose={() => setOpenChip(null)}
              items={[
                {
                  key: "unsettle",
                  label: "Unsettle",
                  // The declared-vs-derived branch lives in the shared action so
                  // the chip and the Work row menu can never disagree.
                  onSelect: () => { void unsettleSession(session); },
                },
              ]}
            />
          ) : null}
        </span>
      ) : null}
    </>
  );
}
