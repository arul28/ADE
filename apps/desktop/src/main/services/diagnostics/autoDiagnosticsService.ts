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
  isAutoDiagnosticsEnabled,
  listPendingAutoDiagnosticsNotices,
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
 *
 * All of which is `runAutoDiagnosticsSend`, shared with the brain's sender.
 * What lives here is only what is specific to the desktop: how a report gets
 * built, that it uploads anonymously, and the toggle the settings pane reads.
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
  isEnabled: () => boolean;
  setEnabled: (enabled: boolean) => boolean;
  getStatus: () => { enabled: boolean; sendsInWindow: number; limit: number };
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

  return {
    report,
    isEnabled: () => isAutoDiagnosticsEnabled(deps.stateFilePath),
    setEnabled: (enabled) => setAutoDiagnosticsEnabled(deps.stateFilePath, enabled, { now }),
    getStatus: () => readAutoDiagnosticsState(deps.stateFilePath, { now }),
    listPendingNotices: () => listPendingAutoDiagnosticsNotices(deps.stateFilePath),
    ackNotices: (references) =>
      ackAutoDiagnosticsNotices(deps.stateFilePath, references, { now }),
  };
}
