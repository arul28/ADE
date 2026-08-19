import type { ProductAnalyticsCapture } from "../../../shared/types/productAnalytics";
import {
  resolveDiagnosticsUploadBaseUrl,
  uploadDiagnosticReport,
  type DiagnosticUploadResult,
} from "../../../shared/diagnosticsUpload";
import { writeDiagnosticReportFile } from "./diagnosticReportService";
import {
  claimAutoDiagnosticsSend,
  completeAutoDiagnosticsSend,
  drainAutoDiagnosticsNotices,
  isAutoDiagnosticsEnabled,
  normalizeAutoDiagnosticsFailureCode,
  readAutoDiagnosticsState,
  setAutoDiagnosticsEnabled,
  type AutoDiagnosticsNotice,
} from "./autoDiagnosticsStore";

/**
 * Sends the diagnostic report nobody was ever going to press the button for.
 *
 * "Report issue" only ever fires when somebody notices the button, decides the
 * failure is worth reporting, and follows through — on a screen that already
 * told them ADE is broken. The reports that would explain the worst failures
 * are exactly the ones that never arrive. So when ADE hits a failure it already
 * classified, it sends the same already-redacted report by itself.
 *
 * The guardrails are the feature, not decoration around it:
 *   - a Settings toggle, default on, honoured by this process and by the brain;
 *   - a hard client budget (one per failure code, three total, per day, per
 *     install) reserved before the request so nothing here can become a loop;
 *   - a toast on every send, so it is never something that happened silently;
 *   - and total silence on failure. A user staring at a broken app must not
 *     also be told that the thing they did not ask for did not work.
 */

export type AutoDiagnosticsRequest = {
  /** Short machine code, e.g. `brain_crash_looping`. Never free text. */
  failureCode: string;
  /** Which screen or subsystem produced it; matches the manual surfaces. */
  surface: string;
  projectRoot?: string | null;
  headline?: string | null;
  technicalDetail?: string | null;
};

export type AutoDiagnosticsOutcome =
  | "completed"
  | "skipped_disabled"
  | "skipped_budget"
  | "failed";

export type AutoDiagnosticsReport = {
  report: string;
  filePath: string;
  installId: string;
};

export type AutoDiagnosticsSentNotice = {
  failureCode: string;
  /** Empty when the local copy could not be written; the toast hides "View". */
  reportPath: string;
  reference: string;
};

export type AutoDiagnosticsServiceDeps = {
  /** `<adeHome>/secrets/diagnostics-autosend.json`. */
  stateFilePath: string;
  buildReport: (request: AutoDiagnosticsRequest) => Promise<AutoDiagnosticsReport>;
  appVersion: string | null;
  /**
   * Fires once per successful send; the desktop turns it into a toast. Returns
   * whether a window actually received it — a send made while every window is
   * closed is held pending rather than silently losing its toast.
   */
  onSent?: (notice: AutoDiagnosticsSentNotice) => boolean | void;
  capture?: (input: ProductAnalyticsCapture) => void;
  logger?: {
    info?: (event: string, meta?: Record<string, unknown>) => void;
    warn?: (event: string, meta?: Record<string, unknown>) => void;
  };
  /** Test seams. */
  env?: NodeJS.ProcessEnv;
  upload?: typeof uploadDiagnosticReport;
  writeReportFile?: (filePath: string, report: string) => boolean;
  now?: () => number;
};

export type AutoDiagnosticsService = {
  /** One call per failure point. Never throws and never rejects. */
  report: (request: AutoDiagnosticsRequest) => Promise<AutoDiagnosticsOutcome>;
  isEnabled: () => boolean;
  setEnabled: (enabled: boolean) => boolean;
  getStatus: () => { enabled: boolean; sendsInWindow: number; limit: number };
  /**
   * Shows the toasts for sends the brain made while no window was listening.
   * Called when a renderer subscribes, so there is no timer behind it.
   */
  flushPendingNotices: () => AutoDiagnosticsNotice[];
};

const ANALYTICS_DEDUPE_MS = 60 * 60 * 1_000;

export function createAutoDiagnosticsService(
  deps: AutoDiagnosticsServiceDeps,
): AutoDiagnosticsService {
  const now = deps.now ?? Date.now;
  const upload = deps.upload ?? uploadDiagnosticReport;
  const writeReportFile = deps.writeReportFile ?? writeDiagnosticReportFile;
  const env = deps.env ?? process.env;
  // One at a time. Two failures that fire together would otherwise race on the
  // budget file and, worse, run two report collections at once on a machine
  // that is already unwell.
  let inFlight = false;

  const captureOutcome = (outcome: "completed" | "skipped_budget" | "failed"): void => {
    try {
      deps.capture?.({
        event: "ade_feature_used",
        surface: "desktop",
        properties: { feature: "connections", action: "auto_sent", outcome },
        projectId: null,
        dedupeKey: `diagnostics_auto_sent:${outcome}`,
        minimumIntervalMs: ANALYTICS_DEDUPE_MS,
      });
    } catch {
      // Analytics must never change what the diagnostics path does.
    }
  };

  const report = async (request: AutoDiagnosticsRequest): Promise<AutoDiagnosticsOutcome> => {
    const failureCode = normalizeAutoDiagnosticsFailureCode(request.failureCode);
    if (!failureCode) return "skipped_budget";
    if (inFlight) return "skipped_budget";
    inFlight = true;
    try {
      if (!isAutoDiagnosticsEnabled(deps.stateFilePath)) return "skipped_disabled";
      const claim = claimAutoDiagnosticsSend({
        filePath: deps.stateFilePath,
        failureCode,
        source: "desktop",
        now,
      });
      if (!claim.allowed) {
        deps.logger?.info?.("diagnostics.auto_send_skipped", {
          failureCode,
          surface: request.surface,
          reason: claim.reason,
        });
        if (claim.reason !== "disabled") captureOutcome("skipped_budget");
        return claim.reason === "disabled" ? "skipped_disabled" : "skipped_budget";
      }

      let built: AutoDiagnosticsReport;
      try {
        built = await deps.buildReport({ ...request, failureCode });
      } catch (error) {
        deps.logger?.warn?.("diagnostics.auto_send_build_failed", {
          failureCode,
          error: error instanceof Error ? error.message : String(error),
        });
        captureOutcome("failed");
        return "failed";
      }

      // Saved exactly like a manual report, and before the upload: the local
      // copy is the half of this the user can always still get to, so it must
      // not depend on the network half working.
      const written = writeReportFile(built.filePath, built.report);
      const reportPath = written ? built.filePath : null;

      let result: DiagnosticUploadResult;
      try {
        result = await upload({
          baseUrl: resolveDiagnosticsUploadBaseUrl(env.ADE_ACCOUNT_DIRECTORY_URL),
          report: built.report,
          installId: built.installId === "unknown" ? null : built.installId,
          appVersion: deps.appVersion,
          auto: true,
          failureCode,
        });
      } catch {
        result = { ok: false, reason: "network" };
      }

      if (!result.ok) {
        // Every failure is the same failure here, including a 429 from either
        // the per-user or the fleet budget: the send does not happen, the log
        // records why, and nothing reaches the screen. There is no retry — the
        // reservation is already spent, which is what keeps a server saying no
        // from turning into a machine asking repeatedly.
        completeAutoDiagnosticsSend({
          filePath: deps.stateFilePath,
          failureCode,
          atMs: claim.atMs,
          reportPath,
          reference: null,
          pending: false,
          now,
        });
        deps.logger?.warn?.("diagnostics.auto_send_failed", {
          failureCode,
          surface: request.surface,
          reason: result.reason,
        });
        captureOutcome("failed");
        return "failed";
      }

      let shown = false;
      try {
        shown = deps.onSent?.({
          failureCode,
          reportPath: reportPath ?? "",
          reference: result.reference,
        }) === true;
      } catch {
        // A broken listener must not turn a successful send into a failure.
        shown = false;
      }
      completeAutoDiagnosticsSend({
        filePath: deps.stateFilePath,
        failureCode,
        atMs: claim.atMs,
        reportPath,
        reference: result.reference,
        // A send nobody has been shown yet — no window open, or none listening
        // — stays pending until a renderer drains it.
        pending: !shown,
        now,
      });
      deps.logger?.info?.("diagnostics.auto_sent", {
        failureCode,
        surface: request.surface,
        reference: result.reference,
        shown,
      });
      captureOutcome("completed");
      return "completed";
    } finally {
      inFlight = false;
    }
  };

  return {
    report,
    isEnabled: () => isAutoDiagnosticsEnabled(deps.stateFilePath),
    setEnabled: (enabled) => setAutoDiagnosticsEnabled(deps.stateFilePath, enabled, { now }),
    getStatus: () => readAutoDiagnosticsState(deps.stateFilePath, { now }),
    flushPendingNotices: () => drainAutoDiagnosticsNotices(deps.stateFilePath, { now }),
  };
}
