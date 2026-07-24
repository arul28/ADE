import { useCallback, useEffect, useState } from "react";
import { ArrowCounterClockwise } from "@phosphor-icons/react";
import type { LocalRuntimeStatus } from "../../../shared/types";

type LastWedge = NonNullable<LocalRuntimeStatus["lastWedge"]>;

/** localStorage key holding the `ts` of the most recently acknowledged wedge. */
export const RECOVERY_ACK_STORAGE_KEY = "ade.brainRecovery.ackedTs";

/**
 * A recovery notice shows once per distinct wedge event. Acknowledgment is the
 * wedge's own `ts`, so a fresh recovery (new `ts`) reappears even after a prior
 * one was dismissed, but the same event never nags twice.
 */
export function shouldShowRecoveryNotice(
  lastWedge: LocalRuntimeStatus["lastWedge"] | undefined,
  ackedTs: string | null,
): boolean {
  if (!lastWedge) return false;
  return lastWedge.ts !== ackedTs;
}

/** "HH:MM" for the notice; falls back to the raw value if it can't be parsed. */
export function formatRecoveryTime(ts: string): string {
  const parsed = Date.parse(ts);
  if (!Number.isFinite(parsed)) return ts;
  return new Date(parsed).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Trims a long command to something that fits inline in the notice. */
export function formatRecoveryCommand(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) return "background task";
  return trimmed.length > 48 ? `${trimmed.slice(0, 47)}…` : trimmed;
}

function readAckedTs(): string | null {
  try {
    return window.localStorage.getItem(RECOVERY_ACK_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeAckedTs(ts: string): void {
  try {
    window.localStorage.setItem(RECOVERY_ACK_STORAGE_KEY, ts);
  } catch {
    // Ignore unavailable/quota-exceeded localStorage; the notice simply may
    // reappear on the next mount, which is harmless.
  }
}

/**
 * App-shell banner announcing that the brain recovered from a background
 * event-loop wedge.
 */
export function BrainRecoveryNotice() {
  const [lastWedge, setLastWedge] = useState<LastWedge | null>(null);
  const [ackedTs, setAckedTs] = useState<string | null>(() => readAckedTs());

  useEffect(() => {
    let cancelled = false;
    let statusRevision = 0;
    const unsubscribe = window.ade.app?.onRuntimeStatusChanged?.((status) => {
      statusRevision += 1;
      if (!cancelled) setLastWedge(status.lastWedge ?? null);
    });
    const readRevision = statusRevision;
    const infoPromise = window.ade.app?.getInfo?.();
    if (infoPromise) {
      void infoPromise
        .then((info) => {
          // Subscribe before reading. If a reconnect status arrived while the
          // snapshot was in flight, do not let that older read erase it.
          if (!cancelled && statusRevision === readRevision) {
            setLastWedge(info.localRuntime?.lastWedge ?? null);
          }
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  const handleDismiss = useCallback(() => {
    if (!lastWedge) return;
    writeAckedTs(lastWedge.ts);
    setAckedTs(lastWedge.ts);
  }, [lastWedge]);

  if (!shouldShowRecoveryNotice(lastWedge, ackedTs) || !lastWedge) return null;

  return (
    <div className="shrink-0 mx-3 mt-1.5 flex items-center gap-2 rounded border border-amber-500/25 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-800">
      <ArrowCounterClockwise size={14} weight="bold" className="shrink-0" aria-hidden="true" />
      <span className="flex-1 min-w-0">
        ADE recovered from a background issue at {formatRecoveryTime(lastWedge.ts)} — a
        stuck task ({formatRecoveryCommand(lastWedge.lastCommand)}) was restarted.
      </span>
      <button
        type="button"
        onClick={handleDismiss}
        className="shrink-0 text-amber-900/70 hover:text-amber-900"
        title="Dismiss"
        aria-label="Dismiss recovery notice"
      >
        ×
      </button>
    </div>
  );
}
