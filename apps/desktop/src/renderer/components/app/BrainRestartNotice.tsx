import { useCallback, useEffect, useState } from "react";
import { ArrowCounterClockwise } from "@phosphor-icons/react";
import type { LocalRuntimeStatus } from "../../../shared/types";
import { APP_BANNER_PRIORITY, useAppBanner } from "../ui/notice";
import { formatRecoveryTime } from "./BrainRecoveryNotice";

type UnplannedRestart = NonNullable<LocalRuntimeStatus["lastUnplannedRestart"]>;

/** localStorage key holding the `ts` of the most recently acknowledged restart. */
export const RESTART_ACK_STORAGE_KEY = "ade.brainRestart.ackedTs";

/** What the banner says: when the service came back, and what kept going. */
export function formatRestartMessage(restart: UnplannedRestart): string {
  const head = `ADE's background service restarted at ${formatRecoveryTime(restart.ts)}.`;
  const chats = restart.chats > 0;
  const sessions = restart.cliSessions > 0;
  const chatWord = restart.chats === 1 ? "chat" : "chats";
  const sessionWord = restart.cliSessions === 1 ? "session" : "sessions";
  // A reopened CLI session is told to continue only when it was mid-turn.
  if (chats && sessions) return `${head} Your ${chatWord} continued and your ${sessionWord} reopened.`;
  if (chats) return `${head} Your ${chatWord} continued.`;
  if (sessions) return `${head} Your ${sessionWord} reopened.`;
  return head;
}

function readAckedTs(): string | null {
  try {
    return window.localStorage.getItem(RESTART_ACK_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeAckedTs(ts: string): void {
  try {
    window.localStorage.setItem(RESTART_ACK_STORAGE_KEY, ts);
  } catch {
    // Unavailable storage: the banner may show again on the next mount.
  }
}

/**
 * App banner after this computer's background service stopped unplanned (a
 * crash, a kill) and came back. One per restart: dismissing it acknowledges
 * that restart's `ts`, so a later restart shows again. An update, a restart
 * someone asked for, or a reboot sets no fact and shows nothing.
 *
 * It reads the local brain's status only. A window whose project tab is bound
 * to another machine's brain does not hear that machine's restart here: the
 * remote connection does not carry the fact to this banner yet. The chat
 * itself still shows its one restart line, from that machine.
 */
export function BrainRestartNotice(): null {
  const [restart, setRestart] = useState<UnplannedRestart | null>(null);
  const [ackedTs, setAckedTs] = useState<string | null>(() => readAckedTs());

  useEffect(() => {
    let cancelled = false;
    let statusRevision = 0;
    const unsubscribe = window.ade.app?.onRuntimeStatusChanged?.((status) => {
      statusRevision += 1;
      if (!cancelled) setRestart(status.lastUnplannedRestart ?? null);
    });
    const readRevision = statusRevision;
    const infoPromise = window.ade.app?.getInfo?.();
    if (infoPromise) {
      void infoPromise
        .then((info) => {
          // A status that arrived while the snapshot was in flight is newer.
          if (!cancelled && statusRevision === readRevision) {
            setRestart(info.localRuntime?.lastUnplannedRestart ?? null);
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
    if (!restart) return;
    writeAckedTs(restart.ts);
    setAckedTs(restart.ts);
  }, [restart]);

  const visible = restart != null && restart.ts !== ackedTs;

  useAppBanner(
    visible && restart
      ? {
          id: "brain-restart",
          tone: "info",
          icon: <ArrowCounterClockwise size={13} weight="bold" />,
          title: formatRestartMessage(restart),
          dismiss: { onDismiss: handleDismiss },
        }
      : null,
    { placement: "docked", priority: APP_BANNER_PRIORITY.app },
  );

  return null;
}
