import { useEffect, useState } from "react";
import type { LocalRuntimeStatus } from "../../../shared/types";
import { APP_BANNER_PRIORITY, useAppBanner } from "../ui/notice";
import { showToast } from "./toast/toastStore";

/** A degraded but usable desktop while its background service cannot start. */
export function AppFallbackBanner(): null {
  const [fallback, setFallback] = useState<LocalRuntimeStatus["appFallback"]>(null);

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

  useAppBanner(
    fallback && {
      id: "app-fallback",
      tone: "warning",
      title: "Phone sync is off",
      detail: "ADE's background service couldn't start, so ADE is running it itself. Your phone can't connect until it's fixed.",
      actions: window.ade.app?.restartBackgroundService
        ? [{
            label: "Fix it",
            onClick: () => {
              void window.ade.app.restartBackgroundService?.().catch((error: unknown) => {
                showToast({
                  tone: "error",
                  title: "Background service couldn't start",
                  message: error instanceof Error ? error.message : String(error),
                });
              });
            },
          }]
        : [],
      dismiss: { key: "app-fallback", fingerprint: `${fallback.reason}:${fallback.since}` },
    },
    { placement: "docked", priority: APP_BANNER_PRIORITY.app },
  );

  return null;
}
