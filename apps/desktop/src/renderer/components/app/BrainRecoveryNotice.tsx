import { useCallback, useEffect, useState } from "react";
import { ArrowCounterClockwise } from "@phosphor-icons/react";
import type { LocalRuntimeStatus } from "../../../shared/types";
import { APP_BANNER_PRIORITY, useAppBanner } from "../ui/notice";

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

/**
 * The sentinel the external watchdog writes in place of a command name. It is
 * the name of a mechanism, not of anything the person was doing.
 */
export const EXTERNAL_WATCHDOG_COMMAND = "external-watchdog";

/**
 * What the notice says happened.
 *
 * The external watchdog stops the whole background service, so naming a "stuck
 * task (external-watchdog)" told the user about our plumbing and nothing about
 * their work. Only a real command name earns the task wording.
 */
export function formatRecoveryMessage(lastWedge: { lastCommand: string; ts: string }): string {
  const at = formatRecoveryTime(lastWedge.ts);
  if (lastWedge.lastCommand.trim() === EXTERNAL_WATCHDOG_COMMAND) {
    return `ADE restarted its background service at ${at} after it stopped responding.`;
  }
  return `ADE recovered from a background issue at ${at} — a stuck task (${
    formatRecoveryCommand(lastWedge.lastCommand)
  }) was restarted.`;
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
 * App-level banner announcing that the brain recovered from a background
 * event-loop wedge. Registers with the app banner host; renders nothing itself.
 */
export function BrainRecoveryNotice(): null {
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

  const visible = shouldShowRecoveryNotice(lastWedge, ackedTs) && lastWedge != null;

  useAppBanner(
    visible && lastWedge
      ? {
          id: "brain-recovery",
          tone: "warning",
          icon: <ArrowCounterClockwise size={13} weight="bold" />,
          title: formatRecoveryMessage(lastWedge),
          dismiss: { onDismiss: handleDismiss },
        }
      : null,
    { placement: "docked", priority: APP_BANNER_PRIORITY.app },
  );

  return null;
}
