import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowsClockwise, WarningCircle } from "@phosphor-icons/react";
import type { AutoUpdateSnapshot, UpdateTransactionResult } from "../../../shared/types";
import { useAutoUpdateSnapshot } from "./useAutoUpdateSnapshot";
import { useBrainRepair } from "../../hooks/useBrainRepair";
import { BrainRepairButton } from "../settings/BrainRepairButton";
import { dismissToast, showToast } from "./toast/toastStore";
import { captureUpdatePromptDecision } from "./captureUpdatePromptDecision";
import { ReportIssueButton } from "./ReportIssueButton";

const AUTO_APPLY_TOAST_ID = "ade-auto-update-auto-apply";

type StalenessBanner = {
  /** Exceptional install states that need a prominent recovery action. */
  kind: "parked" | "failed";
  /**
   * Stable identity for this banner state. Dismissal is keyed on it so the
   * banner reappears for a fresh failed attempt but stays hidden for an
   * unchanged state.
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
      signature: `parked:${snapshot.parked.reason}:${snapshot.parked.at}:${snapshot.version ?? ""}`,
    };
  }
  if (
    snapshot.status === "ready"
    && snapshot.lastInstallFailed
    && snapshot.lastInstallFailed.targetVersion === snapshot.version
  ) {
    return {
      kind: "failed",
      signature:
        `failed:${snapshot.lastInstallFailed.targetVersion}:`
        + `${snapshot.lastInstallFailed.attempt}`,
    };
  }
  return null;
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
  const currentVersion = snapshot.currentVersion;
  const updateVersion = snapshot.version;

  // Re-enable the Restart action whenever the banner state changes (or clears);
  // a stale "restarting" flag must never stick across a new staged version.
  useEffect(() => {
    setRestarting(false);
  }, [signature]);

  const handleRestart = useCallback(() => {
    captureUpdatePromptDecision({ currentVersion, version: updateVersion }, "accepted");
    setRestarting(true);
    void window.ade.updateQuitAndInstall()
      .then((started) => {
        if (!started) setRestarting(false);
      })
      .catch(() => {
        setRestarting(false);
      });
  }, [currentVersion, updateVersion]);

  const handleCancelAutoApply = useCallback(() => {
    captureUpdatePromptDecision({ currentVersion, version: updateVersion }, "deferred");
    cancelRequestedRef.current = true;
    dismissToast(AUTO_APPLY_TOAST_ID);
    void window.ade.updateCancelAutoApply?.().then(
      (accepted) => {
        // A declined cancel must not leave the countdown invisible while
        // auto-apply proceeds; the snapshot event reconciles accepted ones.
        if (accepted === false) cancelRequestedRef.current = false;
      },
      () => {
        cancelRequestedRef.current = false;
      },
    );
  }, [currentVersion, updateVersion]);

  // Drive the countdown toast off `autoApplyPending`. Re-render once a second so
  // the visible seconds tick down; the snapshot event clears it on apply/cancel.
  const pending = snapshot.autoApplyPending;
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
        title: `ADE will update in ${secondsLeft}s`,
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
  }, [pending, handleCancelAutoApply]);

  // Tidy up the toast if this component unmounts mid-countdown.
  useEffect(() => () => dismissToast(AUTO_APPLY_TOAST_ID), []);

  const showBanner = Boolean(banner) && signature !== dismissedSignature;

  return (
    <>
      <UpdateTransactionNotice result={snapshot.updateTransaction ?? null} />
      {showBanner && banner ? (
        // Same dark-shell amber strip as UpdateTransactionNotice below: this
        // one was still written for a light surface, so its body read as brown
        // text on near-black while its dismiss was already converted.
        <div className="shrink-0 mx-3 mt-1.5 flex items-center gap-2 rounded border border-amber-400/25 bg-amber-400/[0.08] px-3 py-1.5 text-[11px] text-amber-100/90">
          <WarningCircle size={14} weight="fill" className="shrink-0 text-amber-300" aria-hidden="true" />
          <span className="flex-1 min-w-0">
            {banner.kind === "parked"
              ? "ADE update didn't finish — Restart to retry"
              : "ADE update did not install — Restart to retry"}
          </span>
          <button
            type="button"
            onClick={handleRestart}
            disabled={restarting}
            className="inline-flex shrink-0 items-center gap-1 rounded border border-amber-400/35 bg-amber-400/15 px-2 py-0.5 font-medium text-amber-100 transition-colors hover:bg-amber-400/25 disabled:opacity-60"
          >
            <ArrowsClockwise size={12} weight="bold" aria-hidden="true" />
            {restarting ? "Restarting…" : "Restart now"}
          </button>
          <button
            type="button"
            onClick={() => {
              captureUpdatePromptDecision(snapshot, "dismissed");
              setDismissedSignature(signature);
            }}
            className="shrink-0 text-amber-100/50 transition-colors hover:text-amber-100"
            title="Dismiss until the next update"
            aria-label="Dismiss update banner"
          >
            ×
          </button>
        </div>
      ) : null}
    </>
  );
}

/**
 * Applying an update is one transaction. When it half-lands — the app is new
 * but the background service is not — say which step failed and offer the same
 * Repair control every other background-service failure uses.
 */
function UpdateTransactionNotice({ result }: { result: UpdateTransactionResult | null }) {
  const [dismissed, setDismissed] = useState(false);
  const repair = useBrainRepair();
  const failureMessage = result && !result.ok ? result.failureMessage : null;

  useEffect(() => {
    setDismissed(false);
  }, [failureMessage]);

  if (!failureMessage || dismissed) return null;

  return (
    // Same amber strip as every other app-shell failure banner. It used to be
    // written for a light surface (amber-800 on amber-500/10), which on ADE's
    // near-black shell rendered as brown text and an all-but-invisible dismiss.
    <div className="shrink-0 mx-3 mt-1.5 flex items-start gap-2 rounded-md border border-amber-400/25 bg-amber-400/[0.08] px-3 py-1.5 text-[11.5px] leading-relaxed text-amber-100/90">
      <WarningCircle size={14} weight="fill" className="mt-0.5 shrink-0 text-amber-300" aria-hidden="true" />
      {/* The message can run long and Repair grows a failure line of its own,
          so the row wraps rather than crushing either into an ellipsis. */}
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 leading-relaxed">
        <span className="min-w-0">{failureMessage}</span>
        {repair.available ? <BrainRepairButton repair={repair} height={20} /> : null}
        <ReportIssueButton
          variant="ghost"
          context={{
            surface: "update_transaction",
            headline: failureMessage,
            code: "update_transaction_failed",
            technicalDetail: result ? JSON.stringify(result, null, 2) : null,
          }}
        />
      </div>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        className="shrink-0 text-amber-100/50 transition-colors hover:text-amber-100"
        title="Dismiss"
        aria-label="Dismiss update notice"
      >
        ×
      </button>
    </div>
  );
}
