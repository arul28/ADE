import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ArrowsClockwise, Cpu } from "@phosphor-icons/react";
import {
  isBackgroundItemBlocked,
  type LocalRuntimeStatus,
  type UpdateTransactionResult,
} from "../../../shared/types";
import { isRuntimeUpdateInProgressError } from "../../../shared/runtimeErrors";
import { extractError } from "../../lib/format";
import { isRecoveryScreenError, useAppStore } from "../../state/appStore";
import { APP_BANNER_PRIORITY, useAppBanner, type BannerModel, type NoticeAction } from "../ui/notice";
import { showToast } from "./toast/toastStore";
import { ReportIssueButton } from "./ReportIssueButton";
import { ResetAdeDialog } from "./ResetAdeDialog";
import { canRestartAde, clearRestartStamp, restartAde, restartedAdeRecently } from "./restartAde";

const APP_BANNER = { placement: "docked", priority: APP_BANNER_PRIORITY.app } as const;
/** How often the banner re-reads the service while macOS blocks it. */
const BLOCKED_POLL_MS = 3_000;

/** Why the background service is down after an update, in the words the banner uses. */
export type BrainDownCause = "background_blocked" | "service" | "restart" | "health";

/**
 * The cause of a half-applied update, or null when the update landed (or its
 * failure was the app swap, which is not a background-service problem). The
 * live service status wins over the transaction's step: "Allow in the
 * Background" switched off is the one cause only the person can fix.
 */
export function brainDownCause(
  result: UpdateTransactionResult | null,
  status: LocalRuntimeStatus | null,
): BrainDownCause | null {
  if (!result || result.ok) return null;
  const failed = result.steps.find((step) => step.status === "failed")?.id;
  if (!failed || failed === "swap") return null;
  if (status && isBackgroundItemBlocked(status)) return "background_blocked";
  return failed;
}

// The owner publishes whether it is speaking for "the background service is
// down", so the project-open banner can stand down while it does. One problem,
// one notice: a failed open is a symptom of the down service, not news.
let brainDownShowing = false;
const showingListeners = new Set<() => void>();
function publishBrainDownShowing(next: boolean): void {
  if (brainDownShowing === next) return;
  brainDownShowing = next;
  for (const listener of showingListeners) listener();
}
function subscribeBrainDownShowing(listener: () => void): () => void {
  showingListeners.add(listener);
  return () => showingListeners.delete(listener);
}

/** True while the brain-down notice owns the app's background-service problem. */
export function useBrainDownNoticeShowing(): boolean {
  return useSyncExternalStore(subscribeBrainDownShowing, () => brainDownShowing, () => false);
}

/**
 * This window's view of the local background service: one read up front, then
 * every status the main process pushes. While `poll` is set it also re-reads on
 * a timer, because the service's own health (the Background Items verdict) is
 * refreshed on read, not pushed.
 */
function useLocalRuntimeStatus(poll: boolean): [LocalRuntimeStatus | null, () => void] {
  const [status, setStatus] = useState<LocalRuntimeStatus | null>(null);
  const refresh = useCallback(() => {
    void window.ade?.app?.getInfo?.()
      .then((info) => setStatus(info.localRuntime ?? null))
      .catch(() => {});
  }, []);
  useEffect(() => {
    let cancelled = false;
    let revision = 0;
    const unsubscribe = window.ade?.app?.onRuntimeStatusChanged?.((next) => {
      revision += 1;
      if (!cancelled) setStatus(next);
    });
    const readRevision = revision;
    void window.ade?.app?.getInfo?.()
      .then((info) => {
        // A pushed status that arrived while this read was in flight is newer.
        if (!cancelled && revision === readRevision) setStatus(info.localRuntime ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);
  useEffect(() => {
    if (!poll) return;
    const timer = window.setInterval(refresh, BLOCKED_POLL_MS);
    return () => window.clearInterval(timer);
  }, [poll, refresh]);
  return [status, refresh];
}

/**
 * The background service is answering this window. An isolated, app-owned
 * runtime does not count: ADE limps along on it, but the service is still down.
 */
function serviceAnswering(status: LocalRuntimeStatus | null): boolean {
  return status?.connectionState === "connected" && status.runtimeMode === "primary";
}

/**
 * The one app banner for "ADE's background service is down" around an update.
 *
 * It owns two states, so they never stack as two notices that disagree:
 * - an update is still replacing the service and a project could not open
 *   yet: a quiet "Finishing the update" that reopens the project by itself;
 * - the update half-landed (the app is new, the service is not running):
 *   the cause in plain words and one escalation ladder — Fix it (the real
 *   service reinstall and restart, `app.restartBackgroundService`), then
 *   Restart ADE, then Reset ADE, with Report issue under the text.
 *
 * It stands down while the full-screen recovery flow is up (that screen owns
 * the same problem with more room) and while the desktop's own fallback brain
 * is serving (`AppFallbackBanner` speaks for that). The project-open banner
 * stands down while this one shows (`useBrainDownNoticeShowing`).
 */
export function BrainDownNotice({ result }: { result: UpdateTransactionResult | null }): JSX.Element | null {
  const projectTransition = useAppStore((s) => s.projectTransition);
  const projectTransitionError = useAppStore((s) => s.projectTransitionError);
  const clearProjectTransitionError = useAppStore((s) => s.clearProjectTransitionError);
  const switchProjectToPath = useAppStore((s) => s.switchProjectToPath);

  // The failure the person (or the service itself) already got past, and the
  // one they dismissed. Keyed on the result object: a new failed update is a
  // new problem and starts the ladder over.
  const [settledResult, setSettledResult] = useState<UpdateTransactionResult | null>(null);
  const [dismissedResult, setDismissedResult] = useState<UpdateTransactionResult | null>(null);
  const [fixing, setFixing] = useState(false);
  const [fixError, setFixError] = useState<string | null>(null);
  const [failedFixes, setFailedFixes] = useState(0);
  // Restart ADE ends this renderer; a stamp from before the relaunch is how
  // the ladder knows that rung was already climbed.
  const [restartedRecently] = useState(() => restartedAdeRecently());
  const [resetOpen, setResetOpen] = useState(false);
  const [sawBlocked, setSawBlocked] = useState(false);
  const autoFixedRef = useRef(false);

  const failedResult = result && !result.ok && result !== settledResult ? result : null;
  const [status, refreshStatus] = useLocalRuntimeStatus(Boolean(failedResult) && sawBlocked && !autoFixedRef.current);
  const cause = brainDownCause(failedResult, status);

  // A project open refused because the update owns the service. Not a project
  // problem, so the project banner never shows it; this notice does.
  const pendingOpen = projectTransitionError
    && !isRecoveryScreenError(projectTransitionError)
    && isRuntimeUpdateInProgressError(projectTransitionError.message)
    ? projectTransitionError
    : null;
  const recoveryScreenUp = !projectTransition && isRecoveryScreenError(projectTransitionError);

  const reopenPending = useCallback(() => {
    if (!pendingOpen) return;
    const target = pendingOpen.retryRootPath ?? null;
    clearProjectTransitionError();
    if (target) void switchProjectToPath(target).catch(() => {});
  }, [pendingOpen, clearProjectTransitionError, switchProjectToPath]);

  const markRecovered = useCallback(() => {
    if (failedResult) setSettledResult(failedResult);
    clearRestartStamp();
    reopenPending();
  }, [failedResult, reopenPending]);

  // The service came back by itself, or through another surface's repair.
  useEffect(() => {
    if (failedResult && !fixing && serviceAnswering(status)) markRecovered();
  }, [failedResult, fixing, status, markRecovered]);

  // An update that is still running: reopen the project once the service
  // answers, or once the update settles cleanly.
  useEffect(() => {
    if (!pendingOpen || failedResult) return;
    if (serviceAnswering(status) || result?.ok) reopenPending();
  }, [pendingOpen, failedResult, status, result, reopenPending]);

  // Fix it is the real service reinstall and restart — the same verified
  // sequence the recovery screen's repair runs — not the sign-in repair the
  // account surfaces use. It resolves only once the new service answers.
  const fixAvailable = typeof window.ade?.app?.restartBackgroundService === "function";
  const fixInFlightRef = useRef(false);
  const runFix = useCallback(() => {
    const restart = window.ade?.app?.restartBackgroundService;
    if (!restart || fixInFlightRef.current) return;
    fixInFlightRef.current = true;
    setFixing(true);
    setFixError(null);
    void restart()
      .then(() => {
        markRecovered();
        showToast({ tone: "success", title: "ADE's background service is running again" });
      })
      .catch((error: unknown) => {
        setFixError(extractError(error));
        setFailedFixes((count) => count + 1);
        // The install just recorded why it failed; read it, so a fix that ran
        // into "Allow in the Background" turns into that notice.
        refreshStatus();
      })
      .finally(() => {
        fixInFlightRef.current = false;
        setFixing(false);
      });
  }, [markRecovered, refreshStatus]);

  // While macOS blocks the service, watch the switch; once it is back on, one
  // fix installs the service again, so nobody has to come back and press
  // anything.
  useEffect(() => {
    if (cause === "background_blocked") {
      setSawBlocked(true);
      return;
    }
    if (!sawBlocked || !cause || autoFixedRef.current || !fixAvailable) return;
    autoFixedRef.current = true;
    runFix();
  }, [cause, sawBlocked, fixAvailable, runFix]);

  const restartAvailable = canRestartAde();
  // While the desktop runs its own brain in place of the service, ADE works and
  // the fallback banner already says what is missing (phone sync) and offers
  // the same Fix it; a second banner about the same service would contradict it.
  const appFallbackServing = Boolean(status?.appFallback) && status?.connectionState === "connected";
  const down = Boolean(cause) && failedResult !== dismissedResult && !recoveryScreenUp && !appFallbackServing;
  useEffect(() => {
    publishBrainDownShowing(down);
  }, [down]);
  useEffect(() => () => publishBrainDownShowing(false), []);

  let model: BannerModel | null = null;
  if (down && cause && failedResult) {
    const blocked = cause === "background_blocked";
    // The ladder: Fix it, then Restart ADE, then Reset ADE. A fix that fails
    // again after a restart goes straight to Reset.
    const lead: LadderRung = failedFixes === 0 && fixAvailable
      ? "fix"
      : restartAvailable && !(failedFixes > 0 && restartedRecently)
        ? "restart"
        : "reset";
    const title = blocked
      ? "macOS isn't letting ADE's background service run"
      : failedResult.failureMessage ?? "ADE's background service isn't running";

    const actions: NoticeAction[] = [];
    if (blocked) {
      actions.push({
        label: "Open System Settings",
        variant: "primary",
        onClick: () => void window.ade?.recovery?.openBackgroundSettings?.().catch(() => undefined),
      });
    } else {
      if (lead === "reset") actions.push({ label: "Reset ADE…", variant: "primary", onClick: () => setResetOpen(true) });
      if (lead === "restart") {
        actions.push({
          label: "Restart ADE",
          variant: "primary",
          icon: <ArrowsClockwise size={12} weight="bold" />,
          onClick: () => void restartAde(),
        });
      }
      if (fixAvailable) {
        actions.push({
          label: fixing ? "Fixing…" : failedFixes > 0 ? "Try again" : "Fix it",
          variant: lead === "fix" ? "primary" : "secondary",
          busy: fixing,
          onClick: runFix,
        });
      }
    }

    const detail = brainDownDetail({ blocked, fixing, lead, failedFixes, restartAvailable });

    const technicalDetail = [
      `cause: ${cause}`,
      ...failedResult.steps.map((step) => `${step.id}: ${step.status}${step.detail ? ` — ${step.detail}` : ""}`),
      status?.serviceInstall.failureStep ? `serviceInstallFailureStep: ${status.serviceInstall.failureStep}` : null,
      status?.serviceInstall.message ? `serviceInstallMessage: ${status.serviceInstall.message}` : null,
      status?.serviceHealth.backgroundItem ? `backgroundItem: ${status.serviceHealth.backgroundItem}` : null,
      fixError ? `fixError: ${fixError}` : null,
    ].filter((line): line is string => Boolean(line)).join("\n");

    model = {
      id: "brain-down",
      tone: "error",
      icon: <Cpu size={13} weight="bold" />,
      busy: fixing,
      title,
      detail,
      actions,
      // Report issue under the text: the raw step details and the
      // installer's own words travel in the report, never in the banner.
      extra: (
        <ReportIssueButton
          variant="ghost"
          context={{
            surface: "update_transaction",
            headline: title,
            code: `update_${failedResult.steps.find((step) => step.status === "failed")?.id ?? "unknown"}`,
            technicalDetail,
          }}
        />
      ),
      // In-memory: recovery is read from the live status, but a stale verdict
      // must never pin a banner the person cannot get rid of.
      dismiss: { onDismiss: () => setDismissedResult(failedResult) },
    };
  } else if (pendingOpen && !failedResult && !recoveryScreenUp) {
    model = {
      id: "brain-down",
      tone: "neutral",
      busy: true,
      title: "Finishing the update",
      detail: "ADE's background service is restarting. Your project opens when it's back.",
      actions: pendingOpen.retryRootPath
        ? [{ label: "Try again", variant: "secondary", onClick: reopenPending }]
        : undefined,
      dismiss: { onDismiss: clearProjectTransitionError },
    };
  }

  useAppBanner(model, APP_BANNER);

  return resetOpen ? <ResetAdeDialog open={resetOpen} onOpenChange={setResetOpen} /> : null;
}

type LadderRung = "fix" | "restart" | "reset";

/** The banner's one line under the title, for the rung the ladder is on. */
function brainDownDetail(args: {
  blocked: boolean;
  fixing: boolean;
  lead: LadderRung;
  failedFixes: number;
  restartAvailable: boolean;
}): string {
  if (args.blocked) return "Turn on ADE under \"Allow in the Background\" in System Settings. ADE continues by itself.";
  if (args.fixing) return "Starting ADE's background service. This can take a minute.";
  if (args.lead === "fix") return "Fix it reinstalls it and starts it again. Your work is safe.";
  if (args.lead === "restart") {
    return args.failedFixes > 0
      ? "Fix it didn't work. Restart ADE next; it quits and reopens."
      : "Restart ADE to start it again. Your work is safe.";
  }
  return args.restartAvailable
    ? "Restarting didn't help. Reset ADE sets it up fresh; your code stays."
    : "Fix it didn't work. Reset ADE sets it up fresh; your code stays.";
}
