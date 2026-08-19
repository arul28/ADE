import path from "node:path";
import {
  runAutoDiagnosticsSend,
  type AutoDiagnosticsLogger,
  type AutoDiagnosticsOutcome,
  type AutoDiagnosticsUploadResult,
} from "../../../../desktop/src/main/services/diagnostics/autoDiagnosticsSend";
import { resolveAutoDiagnosticsStateFile } from "../../../../desktop/src/main/services/diagnostics/autoDiagnosticsStore";
import type { ProductAnalyticsCapture } from "../../../../desktop/src/shared/types/productAnalytics";
import {
  buildCliDiagnosticReport,
  sendDiagnosticReport,
  type ReportIssueResult,
} from "../../commands/reportIssue";
import { resolveMachineAdeLayout } from "../projects/machineLayout";
import { diagnosticReportFilePath, writeDiagnosticReportFile } from "./diagnosticReport";

/**
 * The brain's half of automatic diagnostics.
 *
 * Some of the failures worth a report are ones the desktop never sees: a
 * headless machine whose pairing recovery gave up, an account publisher that
 * has been failing for minutes with nobody logged in at the console. The brain
 * also has something the renderer does not — the machine's own credential
 * store — so its reports carry an account token and land attributed.
 *
 * It shares the desktop's consent flag, its budget file and its send policy
 * (`runAutoDiagnosticsSend`), so "three a day" really is three a day for the
 * computer rather than three per process, and the guarantees are not restated
 * here to drift. What it cannot do is show a toast: there may be no window at
 * all. Successful sends are left pending in the shared ledger, and the desktop
 * drains them into the same toast the next time a renderer subscribes.
 *
 * The desktop and the brain can both report the same incident — a brain that
 * cannot publish is also a brain the recovery screen may diagnose. They carry
 * different failure codes and different surfaces, so both are individually
 * useful, and the per-install ceiling of three a day bounds the duplication.
 * Nothing coordinates them beyond that, deliberately.
 */

export type BrainAutoDiagnosticsRequest = {
  failureCode: string;
  surface: string;
  headline?: string | null;
};

export type BrainAutoDiagnosticsOutcome = AutoDiagnosticsOutcome;

/** Everything the send needs out of a built CLI report, and nothing more. */
export type BrainDiagnosticReport = Pick<
  ReportIssueResult,
  "report" | "installId" | "appVersion" | "secretsDir"
>;

/**
 * The two seams, written STRUCTURALLY rather than as `typeof
 * buildCliDiagnosticReport` / `typeof sendDiagnosticReport`.
 *
 * The real functions are assignable to both, and a test can hand in an ordinary
 * stub — the previous `as never` casts silently disabled every check on the
 * shape these are called with, which is the one thing a seam exists to keep.
 */
export type BrainDiagnosticsBuild = (options: {
  surface: string;
  code: string;
  headline: string | null;
  cliVersion: string | null;
  env: NodeJS.ProcessEnv;
  now: () => Date;
}) => BrainDiagnosticReport;

export type BrainDiagnosticsSend = (
  built: BrainDiagnosticReport,
  deps: { env: NodeJS.ProcessEnv; auto: boolean; failureCode: string },
) => Promise<AutoDiagnosticsUploadResult>;

export type BrainAutoDiagnosticsDeps = {
  cliVersion?: string | null;
  env?: NodeJS.ProcessEnv;
  logger?: AutoDiagnosticsLogger;
  capture?: (input: ProductAnalyticsCapture) => void;
  /** Test seams. */
  stateFilePath?: string;
  reportsDir?: string;
  build?: BrainDiagnosticsBuild;
  send?: BrainDiagnosticsSend;
  writeReportFile?: (filePath: string, report: string) => boolean;
  now?: () => number;
};

export type BrainAutoDiagnostics = {
  report: (request: BrainAutoDiagnosticsRequest) => Promise<BrainAutoDiagnosticsOutcome>;
};

export function createBrainAutoDiagnostics(
  deps: BrainAutoDiagnosticsDeps = {},
): BrainAutoDiagnostics {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const layout = resolveMachineAdeLayout(env);
  const stateFilePath = deps.stateFilePath ?? resolveAutoDiagnosticsStateFile(layout.adeDir, env);
  const reportsDir = deps.reportsDir ?? path.join(layout.adeDir, "diagnostic-reports");
  const build = deps.build ?? buildCliDiagnosticReport;
  const send = deps.send ?? sendDiagnosticReport;
  const writeReportFile = deps.writeReportFile ?? writeDiagnosticReportFile;
  let inFlight = false;

  const report = async (
    request: BrainAutoDiagnosticsRequest,
  ): Promise<BrainAutoDiagnosticsOutcome> => {
    if (inFlight) return "skipped_ineligible";
    inFlight = true;
    // One timestamp for the report's own header and for the file it is saved
    // under, so the two never disagree by a tick.
    const at = new Date(now());
    try {
      return await runAutoDiagnosticsSend<BrainDiagnosticReport>({
        stateFilePath,
        source: "brain",
        // The brain's own surface, as every other headless emitter reports it.
        // Attributing a send nobody was at the keyboard for to `desktop` would
        // read as a person's app doing it.
        analyticsSurface: "api",
        failureCode: request.failureCode,
        surface: request.surface,
        build: (failureCode) =>
          build({
            surface: request.surface,
            code: failureCode,
            headline: request.headline ?? null,
            cliVersion: deps.cliVersion ?? null,
            env,
            now: () => at,
          }),
        reportPathOf: (built) => {
          const filePath = diagnosticReportFilePath(reportsDir, request.surface, at);
          return writeReportFile(filePath, built.report) ? filePath : null;
        },
        send: (built, failureCode) => send(built, { env, auto: true, failureCode }),
        logger: deps.logger,
        capture: deps.capture,
        now,
      });
    } finally {
      inFlight = false;
    }
  };

  return { report };
}
