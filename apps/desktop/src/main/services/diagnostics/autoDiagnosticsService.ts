import type { ProductAnalyticsCapture } from "../../../shared/types/productAnalytics";
import {
  resolveDiagnosticsUploadBaseUrl,
  uploadDiagnosticReport,
  type DiagnosticUploadRequest,
} from "../../../shared/diagnosticsUpload";
import { writeDiagnosticReportFile } from "./diagnosticReportService";
import {
  runAutoDiagnosticsSend,
  type AutoDiagnosticsLogger,
  type AutoDiagnosticsOutcome,
  type AutoDiagnosticsSentNotice,
  type AutoDiagnosticsUploadResult,
} from "./autoDiagnosticsSend";
import {
  ackAutoDiagnosticsNotices,
  claimManualDiagnosticsSend,
  completeAutoDiagnosticsSend,
  isAutoDiagnosticsEnabled,
  listPendingAutoDiagnosticsNotices,
  readAutoDiagnosticsState,
  setAutoDiagnosticsEnabled,
  MANUAL_DIAGNOSTICS_FAILURE_CODE,
  MAX_MANUAL_DIAGNOSTICS_PER_WINDOW,
  type AutoDiagnosticsNotice,
} from "./autoDiagnosticsStore";
import type { DiagnosticsManualSendResult } from "../../../shared/types/diagnostics";

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
 *
 * All of which is `runAutoDiagnosticsSend`, shared with the brain's sender.
 * What lives here is only what is specific to the desktop: how a report gets
 * built, that it uploads anonymously, and the toggle the settings pane reads.
 */

type ManualSendFailure = Extract<DiagnosticsManualSendResult, { ok: false }>["reason"];

export type AutoDiagnosticsRequest = {
  /** Short machine code, e.g. `brain_crash_looping`. Never free text. */
  failureCode: string;
  /** Which screen or subsystem produced it; matches the manual surfaces. */
  surface: string;
  projectRoot?: string | null;
  headline?: string | null;
  technicalDetail?: string | null;
};

/**
 * What the screen that asked for a manual send knows about its own failure.
 *
 * Every field is optional and every field is a report field, not a control: a
 * caller describes what broke, and nothing here can change the budget, the
 * consent rule or where the report goes. Absent entirely, the send is the
 * Settings one — a person reporting with nothing visibly broken.
 *
 * `projectRoot` names whose logs get read, so the IPC handler fills it from the
 * project main already has open and never from the renderer's payload.
 */
export type ManualDiagnosticsContext = {
  surface?: string | null;
  /** The screen's own failure code, for the report. Never the budget's. */
  code?: string | null;
  headline?: string | null;
  technicalDetail?: string | null;
  projectRoot?: string | null;
};

export type { AutoDiagnosticsOutcome, AutoDiagnosticsSentNotice };

export type AutoDiagnosticsReport = {
  report: string;
  filePath: string;
  installId: string;
};

export type AutoDiagnosticsServiceDeps = {
  /** `<adeHome>/secrets/diagnostics-autosend.json`. */
  stateFilePath: string;
  buildReport: (request: AutoDiagnosticsRequest) => Promise<AutoDiagnosticsReport>;
  appVersion: string | null;
  /**
   * Fires once per successful send so a window that is up can toast
   * immediately. It is a fast path only: the send is recorded pending either
   * way and the renderer's acknowledgement is what actually retires it.
   */
  onSent?: (notice: AutoDiagnosticsSentNotice) => void;
  capture?: (input: ProductAnalyticsCapture) => void;
  logger?: AutoDiagnosticsLogger;
  /**
   * Test seams. `upload` is typed by what this service needs of an answer
   * rather than as `typeof uploadDiagnosticReport`, so a test can pass a plain
   * stub instead of casting one through `as unknown as`.
   */
  env?: NodeJS.ProcessEnv;
  upload?: (request: DiagnosticUploadRequest) => Promise<AutoDiagnosticsUploadResult>;
  writeReportFile?: (filePath: string, report: string) => boolean;
  now?: () => number;
};

export type AutoDiagnosticsService = {
  /** One call per failure point. Never throws and never rejects. */
  report: (request: AutoDiagnosticsRequest) => Promise<AutoDiagnosticsOutcome>;
  /**
   * One report, because a person asked for it. Never throws and never rejects;
   * every outcome comes back named so the surface can say what happened.
   */
  sendManual: (context?: ManualDiagnosticsContext) => Promise<DiagnosticsManualSendResult>;
  isEnabled: () => boolean;
  setEnabled: (enabled: boolean) => boolean;
  getStatus: () => {
    enabled: boolean;
    sendsInWindow: number;
    limit: number;
    manualSendsInWindow: number;
    manualLimit: number;
  };
  /**
   * The sends no renderer has acknowledged showing yet — the brain's, and any
   * this process made while no window was listening. Read when a renderer
   * subscribes, so there is no timer behind it. Listing does NOT retire them:
   * `ackNotices` does, once the toast is on screen.
   */
  listPendingNotices: () => AutoDiagnosticsNotice[];
  /** Retires the notices a renderer has actually rendered. Idempotent. */
  ackNotices: (references: readonly string[]) => void;
};

/** A present, non-blank string, or null. Blank is not a surface or a code. */
function trimmedOrNull(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed : null;
}

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

  const report = async (request: AutoDiagnosticsRequest): Promise<AutoDiagnosticsOutcome> => {
    if (inFlight) return "skipped_ineligible";
    inFlight = true;
    try {
      return await runAutoDiagnosticsSend<AutoDiagnosticsReport>({
        stateFilePath: deps.stateFilePath,
        source: "desktop",
        analyticsSurface: "desktop",
        failureCode: request.failureCode,
        surface: request.surface,
        build: (failureCode) => deps.buildReport({ ...request, failureCode }),
        reportPathOf: (built) => (writeReportFile(built.filePath, built.report) ? built.filePath : null),
        send: async (built, failureCode) =>
          upload({
            baseUrl: resolveDiagnosticsUploadBaseUrl(env.ADE_ACCOUNT_DIRECTORY_URL),
            report: built.report,
            installId: built.installId === "unknown" ? null : built.installId,
            appVersion: deps.appVersion,
            auto: true,
            failureCode,
          }),
        onSent: deps.onSent,
        logger: deps.logger,
        capture: deps.capture,
        now,
      });
    } finally {
      inFlight = false;
    }
  };

  /**
   * "Send a report to ADE", pressed by hand in Settings.
   *
   * Same collector, same redaction, same uploader as every other send — the
   * only thing that differs is who decided and what happens afterwards.
   *
   * Consent is deliberately NOT checked. The setting the pane offers is about
   * reports ADE files BY ITSELF when something breaks; this is a person asking,
   * about a report they can open and read. Refusing it would mean anyone who
   * turned off background reporting has no way to send anything at all — and
   * that is exactly the user this control exists for. The pane says as much
   * next to the button when the toggle is off, so the click can never be
   * mistaken for turning automatic sending back on. Nothing here writes
   * `enabled`.
   *
   * It is also NOT `runAutoDiagnosticsSend`: that policy is silence on failure
   * and a pending toast, both correct for a send nobody asked for and both
   * wrong here. A user watching a button has to be told the answer, and telling
   * them twice — inline and again in a toast — is worse than once.
   */
  const sendManual = async (
    context?: ManualDiagnosticsContext,
  ): Promise<DiagnosticsManualSendResult> => {
    // A collection already running is not a budget event: nothing is claimed,
    // so a retry a moment later costs the user nothing.
    if (inFlight) return { ok: false, reason: "failed" };
    inFlight = true;
    try {
      const claim = claimManualDiagnosticsSend({
        filePath: deps.stateFilePath,
        source: "desktop",
        now,
      });
      if (!claim.allowed) {
        deps.logger?.info?.("diagnostics.manual_send_skipped", { reason: claim.reason });
        // A ledger that cannot be read or locked fails closed, exactly as the
        // automatic claim does — but the user gets told, rather than nothing.
        return claim.reason === "daily_limit"
          ? { ok: false, reason: "local_limit", limit: MAX_MANUAL_DIAGNOSTICS_PER_WINDOW }
          : { ok: false, reason: "failed" };
      }

      let built: AutoDiagnosticsReport;
      try {
        built = await deps.buildReport({
          // Two codes, on purpose. The ledger and the upload below keep
          // `MANUAL_DIAGNOSTICS_FAILURE_CODE`, because what they count is "a
          // person pressed the button", which is one thing however it was
          // reached. The REPORT's code is the screen's own when the screen has
          // one, because that is the line someone reading the report needs.
          failureCode: trimmedOrNull(context?.code) ?? MANUAL_DIAGNOSTICS_FAILURE_CODE,
          // "settings_manual" is the default rather than the only answer: a
          // send from a crash screen that arrived stamped "settings_manual"
          // would file every renderer crash under the pane nobody was looking
          // at, and the surface is the first thing triage reads.
          surface: trimmedOrNull(context?.surface) ?? "settings_manual",
          headline: context?.headline ?? null,
          technicalDetail: context?.technicalDetail ?? null,
          projectRoot: context?.projectRoot ?? null,
        });
      } catch (error) {
        deps.logger?.warn?.("diagnostics.manual_send_build_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        // The reservation stays spent, for the automatic sender's reason: what
        // it bounds is how often this computer tries, not how often it wins.
        completeAutoDiagnosticsSend({
          filePath: deps.stateFilePath,
          failureCode: MANUAL_DIAGNOSTICS_FAILURE_CODE,
          atMs: claim.atMs,
          reportPath: null,
          reference: null,
          pending: false,
          kind: "manual",
          now,
        });
        return { ok: false, reason: "failed" };
      }

      let reportPath: string | null;
      try {
        reportPath = writeReportFile(built.filePath, built.report) ? built.filePath : null;
      } catch {
        reportPath = null;
      }

      let result: AutoDiagnosticsUploadResult;
      try {
        result = await upload({
          baseUrl: resolveDiagnosticsUploadBaseUrl(env.ADE_ACCOUNT_DIRECTORY_URL),
          report: built.report,
          installId: built.installId === "unknown" ? null : built.installId,
          appVersion: deps.appVersion,
          // `auto: false` is the whole point of the flag: server-side these have
          // to stay separable from the reports nobody chose to file.
          auto: false,
          failureCode: MANUAL_DIAGNOSTICS_FAILURE_CODE,
        });
      } catch {
        result = { ok: false, reason: "network" };
      }

      completeAutoDiagnosticsSend({
        filePath: deps.stateFilePath,
        failureCode: MANUAL_DIAGNOSTICS_FAILURE_CODE,
        atMs: claim.atMs,
        reportPath,
        reference: result.ok ? result.reference : null,
        // Never pending: the person who pressed the button is looking at the
        // answer. A toast on top of it would be the same news twice.
        pending: false,
        kind: "manual",
        now,
      });

      if (!result.ok) {
        deps.logger?.warn?.("diagnostics.manual_send_failed", { reason: result.reason });
        // The uploader tells the two 429s apart for us: `rate_limited` is this
        // caller's own daily allowance, `unavailable` is ADE not taking reports
        // from anyone. Those are different sentences to a user, so they stay
        // different reasons all the way to the screen.
        const reason: ManualSendFailure =
          result.reason === "rate_limited"
            ? "rate_limited"
            : result.reason === "unavailable"
              ? "unavailable"
              : result.reason === "too_large"
                ? "too_large"
                : "failed";
        return { ok: false, reason, ...(reportPath ? { reportPath } : {}) };
      }

      deps.logger?.info?.("diagnostics.manual_sent", { reference: result.reference });
      return { ok: true, reference: result.reference, reportPath: reportPath ?? "" };
    } finally {
      inFlight = false;
    }
  };

  return {
    report,
    sendManual,
    isEnabled: () => isAutoDiagnosticsEnabled(deps.stateFilePath),
    setEnabled: (enabled) => setAutoDiagnosticsEnabled(deps.stateFilePath, enabled, { now }),
    getStatus: () => readAutoDiagnosticsState(deps.stateFilePath, { now }),
    listPendingNotices: () => listPendingAutoDiagnosticsNotices(deps.stateFilePath),
    ackNotices: (references) =>
      ackAutoDiagnosticsNotices(deps.stateFilePath, references, { now }),
  };
}
