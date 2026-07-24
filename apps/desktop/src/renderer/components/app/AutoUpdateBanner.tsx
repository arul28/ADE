import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowsClockwise, WarningCircle } from "@phosphor-icons/react";
import type { AutoUpdateSnapshot } from "../../../shared/types";
import { useAutoUpdateSnapshot } from "./useAutoUpdateSnapshot";
import { dismissToast, showToast } from "./toast/toastStore";

const AUTO_APPLY_TOAST_ID = "ade-auto-update-auto-apply";

type StalenessBanner = {
  /** "ready" = a downloaded update is waiting; "parked" = a consented install aborted. */
  kind: "ready" | "parked";
  version: string | null;
  /**
   * Stable identity for this banner state. Dismissal is keyed on it so the
   * banner reappears whenever the underlying state changes (new version staged,
   * a fresh install abort) but stays hidden for an unchanged state.
   */
  signature: string;
};

/**
 * Decides whether the app is running behind what is staged on disk. A parked
 * install (consented but aborted before the native updater took over) wins over
 * a plain ready state so we surface the "didn't finish" retry copy.
 */
export function describeStalenessBanner(snapshot: AutoUpdateSnapshot): StalenessBanner | null {
  if (snapshot.parked) {
    return {
      kind: "parked",
      version: snapshot.version,
      signature: `parked:${snapshot.parked.reason}:${snapshot.parked.at}:${snapshot.version ?? ""}`,
    };
  }
  if (snapshot.status === "ready") {
    return {
      kind: "ready",
      version: snapshot.version,
      signature: `ready:${snapshot.version ?? ""}`,
    };
  }
  return null;
}

function versionText(version: string | null): string {
  return version ? version : "the latest version";
}

/**
 * App-shell staleness/update banner plus the idle-countdown toast. Both consume
 * the same auto-update snapshot, so they are colocated to share one subscription
 * and never disagree about the pending update.
 */
export function AutoUpdateBanner() {
  const snapshot = useAutoUpdateSnapshot();
  const [dismissedSignature, setDismissedSignature] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);
  const cancelRequestedRef = useRef(false);

  const banner = describeStalenessBanner(snapshot);
  const signature = banner?.signature ?? null;

  // Re-enable the Restart action whenever the banner state changes (or clears);
  // a stale "restarting" flag must never stick across a new staged version.
  useEffect(() => {
    setRestarting(false);
  }, [signature]);

  const handleRestart = useCallback(() => {
    setRestarting(true);
    void window.ade.updateQuitAndInstall()
      .then((started) => {
        if (!started) setRestarting(false);
      })
      .catch(() => {
        setRestarting(false);
      });
  }, []);

  const handleCancelAutoApply = useCallback(() => {
    cancelRequestedRef.current = true;
    dismissToast(AUTO_APPLY_TOAST_ID);
    void window.ade.updateCancelAutoApply().catch(() => {
      cancelRequestedRef.current = false;
      // Main process logs cancellation failures; the snapshot event reconciles.
    });
  }, []);

  // Drive the countdown toast off `autoApplyPending`. Re-render once a second so
  // the visible seconds tick down; the snapshot event clears it on apply/cancel.
  const pending = snapshot.autoApplyPending;
  const pendingVersion = snapshot.version;
  useEffect(() => {
    if (!pending) {
      dismissToast(AUTO_APPLY_TOAST_ID);
      cancelRequestedRef.current = false;
      return;
    }
    const renderToast = () => {
      if (cancelRequestedRef.current) return;
      const secondsLeft = Math.max(0, Math.ceil((pending.deadlineAt - Date.now()) / 1000));
      showToast({
        id: AUTO_APPLY_TOAST_ID,
        title: `Updating to ${versionText(pendingVersion)} in ${secondsLeft}s`,
        tone: "info",
        durationMs: 0,
        action: { label: "Cancel", onClick: handleCancelAutoApply },
      });
    };
    renderToast();
    const timer = window.setInterval(renderToast, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [pending, pendingVersion, handleCancelAutoApply]);

  // Tidy up the toast if this component unmounts mid-countdown.
  useEffect(() => () => dismissToast(AUTO_APPLY_TOAST_ID), []);

  if (!banner || signature === dismissedSignature) return null;

  return (
    <div className="shrink-0 mx-3 mt-1.5 flex items-center gap-2 rounded border border-amber-500/25 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-800">
      <WarningCircle size={14} weight="fill" className="shrink-0" aria-hidden="true" />
      <span className="flex-1 min-w-0">
        {banner.kind === "parked"
          ? `Update to ${versionText(banner.version)} didn't finish — Restart to retry`
          : `Running ${snapshot.currentVersion} · ${versionText(banner.version)} is ready`}
      </span>
      <button
        type="button"
        onClick={handleRestart}
        disabled={restarting}
        className="inline-flex shrink-0 items-center gap-1 rounded border border-amber-500/35 bg-amber-500/15 px-2 py-0.5 font-medium text-amber-900 transition-colors hover:bg-amber-500/25 disabled:opacity-60"
      >
        <ArrowsClockwise size={12} weight="bold" aria-hidden="true" />
        {restarting ? "Restarting…" : "Restart now"}
      </button>
      <button
        type="button"
        onClick={() => setDismissedSignature(signature)}
        className="shrink-0 text-amber-900/70 hover:text-amber-900"
        title="Dismiss until the next update"
        aria-label="Dismiss update banner"
      >
        ×
      </button>
    </div>
  );
}
