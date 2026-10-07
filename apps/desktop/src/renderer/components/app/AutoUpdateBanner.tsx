import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowsClockwise, Bell } from "@phosphor-icons/react";
import type { AutoUpdateSnapshot, UpdateTransactionResult } from "../../../shared/types";
import { useAutoUpdateSnapshot } from "./useAutoUpdateSnapshot";
import { dismissToast, showToast } from "./toast/toastStore";
import { APP_BANNER_PRIORITY, useAppBanner } from "../ui/notice";
import { captureUpdatePromptDecision } from "./captureUpdatePromptDecision";
import { requestDownloadedUpdateInstall } from "./autoUpdateInstallAction";
import { ReportIssueButton } from "./ReportIssueButton";
import { BrainDownNotice } from "./BrainDownNotice";

const AUTO_APPLY_TOAST_ID = "ade-auto-update-auto-apply";
const APP_BANNER = { placement: "docked", priority: APP_BANNER_PRIORITY.app } as const;
const UPDATE_PROMPT_BANNER = { placement: "floating", priority: APP_BANNER_PRIORITY.updatePrompt } as const;

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
  const [dismissedReadyVersion, setDismissedReadyVersion] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [installRequested, setInstallRequested] = useState(false);
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

  useEffect(() => {
    if (snapshot.status !== "ready") setInstallRequested(false);
  }, [snapshot.status, updateVersion]);

  const handleRestart = useCallback(() => {
    // The same confirmation every other manual install affordance uses, so a
    // retry after a failed or parked install also names the chats it will
    // interrupt and offers to resume them.
    setRestarting(true);
    void requestDownloadedUpdateInstall(snapshot, () => setRestarting(true))
      .then((started) => {
        if (!started) setRestarting(false);
      })
      .catch(() => {
        setRestarting(false);
      });
  }, [snapshot]);

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

  const handleInstallReadyUpdate = useCallback(() => {
    void requestDownloadedUpdateInstall(snapshot, () => setInstallRequested(true))
      .then((started) => {
        if (!started) setInstallRequested(false);
      });
  }, [snapshot]);

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
        actions: [{ label: "Cancel", onClick: handleCancelAutoApply }],
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
  const showReadyUpdatePrompt =
    snapshot.status === "ready"
    && Boolean(updateVersion)
    && !banner
    && dismissedReadyVersion !== updateVersion;

  useAppBanner(
    showBanner && banner
      ? {
          id: "auto-update-staleness",
          tone: "warning",
          icon: <ArrowsClockwise size={13} weight="bold" />,
          title: banner.kind === "parked"
            ? "ADE update didn't finish — Restart to retry"
            : "ADE update did not install — Restart to retry",
          actions: [{
            label: restarting ? "Restarting…" : "Restart now",
            icon: <ArrowsClockwise size={12} weight="bold" />,
            variant: "primary",
            busy: restarting,
            onClick: handleRestart,
          }],
          dismiss: {
            title: "Dismiss until the next update",
            onDismiss: () => {
              captureUpdatePromptDecision(snapshot, "dismissed");
              setDismissedSignature(signature);
            },
          },
        }
      : null,
    APP_BANNER,
  );

  useAppBanner(
    showReadyUpdatePrompt
      ? {
          id: "auto-update-ready",
          tone: "accent",
          // A notice mark on the left; the install action on the right keeps
          // its arrow so the button still reads as "restart and install".
          icon: <Bell size={13} weight="bold" />,
          title: `Update v${updateVersion} is ready to install`,
          actions: [{
            label: installRequested ? "Restarting…" : "Restart and install",
            icon: <ArrowsClockwise size={12} weight="bold" />,
            variant: "primary",
            busy: installRequested,
            disabled: installRequested,
            onClick: handleInstallReadyUpdate,
          }],
          dismiss: {
            label: "Dismiss update prompt",
            title: "Dismiss update prompt",
            onDismiss: () => {
              captureUpdatePromptDecision(snapshot, "dismissed");
              setDismissedReadyVersion(updateVersion);
            },
          },
        }
      : null,
    UPDATE_PROMPT_BANNER,
  );

  return (
    <>
      <UpdateSwapNotice result={snapshot.updateTransaction ?? null} stalenessShowing={showBanner} />
      <BrainDownNotice result={snapshot.updateTransaction ?? null} />
    </>
  );
}

/**
 * Applying an update is one transaction. When the app swap itself did not
 * land, say so; the staleness banner above already offers the retry when it
 * shows, so this one stands down then. Every other failed step is the
 * background service, which `BrainDownNotice` owns.
 */
function UpdateSwapNotice({
  result,
  stalenessShowing,
}: {
  result: UpdateTransactionResult | null;
  stalenessShowing: boolean;
}): null {
  const [dismissed, setDismissed] = useState<UpdateTransactionResult | null>(null);
  const swapFailed = Boolean(
    result && !result.ok && result.steps.find((step) => step.status === "failed")?.id === "swap",
  );

  useAppBanner(
    result && swapFailed && !stalenessShowing && dismissed !== result
      ? {
          id: "update-transaction-failed",
          tone: "warning",
          icon: <ArrowsClockwise size={13} weight="bold" />,
          title: result.failureMessage ?? "The update didn't finish installing.",
          extra: (
            <ReportIssueButton
              variant="ghost"
              context={{
                surface: "update_transaction",
                headline: result.failureMessage,
                code: "update_swap",
                technicalDetail: JSON.stringify(result, null, 2),
              }}
            />
          ),
          dismiss: { onDismiss: () => setDismissed(result) },
        }
      : null,
    APP_BANNER,
  );

  return null;
}
