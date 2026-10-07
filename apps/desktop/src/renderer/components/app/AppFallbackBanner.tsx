import { useEffect, useState } from "react";
import type { LocalRuntimeStatus } from "../../../shared/types";
import { APP_BANNER_PRIORITY, useAppBanner, type NoticeAction } from "../ui/notice";
import { showToast } from "./toast/toastStore";

/** A degraded but usable desktop while its background service cannot start. */
export function AppFallbackBanner(): null {
  const [fallback, setFallback] = useState<LocalRuntimeStatus["appFallback"]>(null);
  const [fixing, setFixing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let revision = 0;
    const unsubscribe = window.ade.app?.onRuntimeStatusChanged?.((status) => {
      revision += 1;
      if (!cancelled) setFallback(status.appFallback ?? null);
    });
    const readRevision = revision;
    void window.ade.app?.getInfo?.().then((info) => {
      if (!cancelled && revision === readRevision) {
        setFallback(info.localRuntime?.appFallback ?? null);
      }
    }).catch(() => {});
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  const blocked = fallback?.reason === "background_item_blocked";
  const openSettings = window.ade.recovery?.openBackgroundSettings;
  const restart = window.ade.app?.restartBackgroundService;
  const actions: NoticeAction[] = [];
  // Reinstalling cannot flip "Allow in the Background"; only the person can.
  if (blocked && openSettings) {
    actions.push({ label: "Open System Settings", onClick: () => void openSettings().catch(() => undefined) });
  }
  if (restart) {
    actions.push({
      // A real restart waits for the service brain to answer, which can take
      // minutes; the button says so instead of looking dead.
      label: fixing ? "Fixing…" : "Fix it",
      busy: fixing,
      onClick: () => {
        if (fixing) return;
        setFixing(true);
        void restart().finally(() => setFixing(false)).catch(() => {
          showToast({
            tone: "warning",
            title: "Phone sync is still off",
            message: blocked
              ? "Turn on ADE under Allow in the Background, then choose Fix it again."
              : "ADE's background service still won't start. Try again, or restart ADE.",
          });
        });
      },
    });
  }

  useAppBanner(
    fallback && {
      id: "app-fallback",
      tone: "warning",
      title: "Phone sync is off",
      detail: blocked
        ? "macOS is blocking ADE's background service, so ADE is running it itself. Turn on ADE under Allow in the Background to reconnect your phone."
        : "ADE's background service couldn't start, so ADE is running it itself. Your phone can't connect until it's fixed.",
      actions,
      dismiss: { key: "app-fallback", fingerprint: `${fallback.reason}:${fallback.since}` },
    },
    { placement: "docked", priority: APP_BANNER_PRIORITY.app },
  );

  return null;
}
