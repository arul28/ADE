import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowsClockwise, Wrench } from "@phosphor-icons/react";
import type { AutoUpdateSnapshot, UpdateTransactionResult } from "../../../shared/types";
import { useAutoUpdateSnapshot } from "./useAutoUpdateSnapshot";
import { useBrainRepair, type BrainRepair } from "../../hooks/useBrainRepair";
import { dismissToast, showToast } from "./toast/toastStore";
import { APP_BANNER_PRIORITY, useAppBanner, type NoticeAction } from "../ui/notice";
import { captureUpdatePromptDecision } from "./captureUpdatePromptDecision";
import { requestDownloadedUpdateInstall } from "./autoUpdateInstallAction";
import { ReportIssueButton } from "./ReportIssueButton";

const AUTO_APPLY_TOAST_ID = "ade-auto-update-auto-apply";
const APP_BANNER = { placement: "docked", priority: APP_BANNER_PRIORITY.app } as const;
const UPDATE_PROMPT_BANNER = { placement: "floating", priority: APP_BANNER_PRIORITY.app } as const;

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
          icon: <ArrowsClockwise size={13} weight="bold" />,
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

  return <UpdateTransactionNotice result={snapshot.updateTransaction ?? null} />;
}

/**
 * The Repair control as a banner action: same label, same pending state and
 * same handler as `BrainRepairButton`, drawn as the banner's own pill.
 */
function repairAction(repair: BrainRepair): NoticeAction {
  return {
    label: repair.pending ? "Repairing…" : "Repair",
    icon: <Wrench size={12} weight="bold" />,
    variant: "secondary",
    busy: repair.pending,
    onClick: repair.run,
  };
}

/**
 * What the last Repair said, under the banner text — the same lines
 * `BrainRepairButton` prints beside itself on other surfaces.
 */
function RepairOutcome({ repair }: { repair: BrainRepair }) {
  if (repair.error) {
    return (
      <>
        <span style={{ color: "var(--color-warning)", minWidth: 0 }} title={repair.error}>
          {`Repair didn't finish. ${repair.error.replace(/\.?\s*$/, ".")}`}
        </span>
        <ReportIssueButton
          variant="ghost"
          context={{
            surface: "brain_repair",
            headline: "Repair didn't finish",
            technicalDetail: repair.error,
          }}
        />
      </>
    );
  }
  if (repair.notice) {
    return (
      <span style={{ color: repair.notice.tone === "ok" ? "var(--color-secondary-fg)" : "var(--color-warning)" }}>
        {repair.notice.text}
      </span>
    );
  }
  return null;
}

/**
 * Applying an update is one transaction. When it half-lands — the app is new
 * but the background service is not — say which step failed and offer the same
 * Repair control every other background-service failure uses.
 */
function UpdateTransactionNotice({ result }: { result: UpdateTransactionResult | null }): null {
  const [dismissed, setDismissed] = useState(false);
  const repair = useBrainRepair();
  const failureMessage = result && !result.ok ? result.failureMessage : null;

  useEffect(() => {
    setDismissed(false);
  }, [failureMessage]);

  useAppBanner(
    failureMessage && !dismissed
      ? {
          id: "update-transaction-failed",
          tone: "warning",
          title: failureMessage,
          actions: repair.available ? [repairAction(repair)] : undefined,
          // The message can run long and Repair grows a failure line of its
          // own, so the outcome and Report issue sit under the text rather
          // than crushing it.
          extra: (
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "4px 8px", fontSize: 11, lineHeight: 1.45 }}>
              {repair.available ? <RepairOutcome repair={repair} /> : null}
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
          ),
          dismiss: { onDismiss: () => setDismissed(true) },
        }
      : null,
    APP_BANNER,
  );

  return null;
}
