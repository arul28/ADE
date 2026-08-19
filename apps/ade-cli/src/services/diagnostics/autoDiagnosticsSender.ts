import path from "node:path";
import {
  claimAutoDiagnosticsSend,
  completeAutoDiagnosticsSend,
  isAutoDiagnosticsEnabled,
  normalizeAutoDiagnosticsFailureCode,
  resolveAutoDiagnosticsStateFile,
} from "../../../../desktop/src/main/services/diagnostics/autoDiagnosticsStore";
import type { ProductAnalyticsCapture } from "../../../../desktop/src/shared/types/productAnalytics";
import { buildCliDiagnosticReport, sendDiagnosticReport } from "../../commands/reportIssue";
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
 * It shares the desktop's consent flag and its budget file, so "three a day"
 * really is three a day for the computer rather than three per process. What it
 * cannot do is show a toast: there may be no window at all. A successful send
 * is therefore left marked pending, and the desktop drains it into the same
 * toast the next time a renderer subscribes.
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

export type BrainAutoDiagnosticsOutcome =
  | "completed"
  | "skipped_disabled"
  | "skipped_budget"
  | "failed";

export type BrainAutoDiagnosticsDeps = {
  cliVersion?: string | null;
  env?: NodeJS.ProcessEnv;
  logger?: {
    info?: (event: string, meta?: Record<string, unknown>) => void;
    warn?: (event: string, meta?: Record<string, unknown>) => void;
  };
  capture?: (input: ProductAnalyticsCapture) => void;
  /** Test seams. */
  stateFilePath?: string;
  reportsDir?: string;
  build?: typeof buildCliDiagnosticReport;
  send?: typeof sendDiagnosticReport;
  writeReportFile?: (filePath: string, report: string) => boolean;
  now?: () => number;
};

export type BrainAutoDiagnostics = {
  report: (request: BrainAutoDiagnosticsRequest) => Promise<BrainAutoDiagnosticsOutcome>;
};

const ANALYTICS_DEDUPE_MS = 60 * 60 * 1_000;

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

  const captureOutcome = (outcome: "completed" | "skipped_budget" | "failed"): void => {
    try {
      deps.capture?.({
        event: "ade_feature_used",
        // The brain's own surface, as every other headless emitter reports it.
        // Attributing a send nobody was at the keyboard for to `desktop` would
        // read as a person's app doing it.
        surface: "api",
        properties: { feature: "connections", action: "auto_sent", outcome },
        projectId: null,
        dedupeKey: `diagnostics_auto_sent:${outcome}`,
        minimumIntervalMs: ANALYTICS_DEDUPE_MS,
      });
    } catch {
      // Analytics never changes what the diagnostics path does.
    }
  };

  const report = async (
    request: BrainAutoDiagnosticsRequest,
  ): Promise<BrainAutoDiagnosticsOutcome> => {
    const failureCode = normalizeAutoDiagnosticsFailureCode(request.failureCode);
    if (!failureCode || inFlight) return "skipped_budget";
    inFlight = true;
    try {
      if (!isAutoDiagnosticsEnabled(stateFilePath)) return "skipped_disabled";
      const claim = claimAutoDiagnosticsSend({
        filePath: stateFilePath,
        failureCode,
        source: "brain",
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

      const at = new Date(now());
      let built: ReturnType<typeof buildCliDiagnosticReport>;
      try {
        built = build({
          surface: request.surface,
          code: failureCode,
          headline: request.headline ?? null,
          cliVersion: deps.cliVersion ?? null,
          env,
          now: () => at,
        });
      } catch (error) {
        deps.logger?.warn?.("diagnostics.auto_send_build_failed", {
          failureCode,
          error: error instanceof Error ? error.message : String(error),
        });
        captureOutcome("failed");
        return "failed";
      }

      const filePath = diagnosticReportFilePath(reportsDir, request.surface, at);
      const written = writeReportFile(filePath, built.report);

      let result: Awaited<ReturnType<typeof sendDiagnosticReport>>;
      try {
        result = await send(built, { env, auto: true, failureCode });
      } catch {
        result = { ok: false, reason: "network" };
      }

      completeAutoDiagnosticsSend({
        filePath: stateFilePath,
        failureCode,
        atMs: claim.atMs,
        reportPath: written ? filePath : null,
        reference: result.ok ? result.reference : null,
        // Pending only on success: the desktop shows a toast for a report that
        // was actually sent, never for one that was not.
        pending: result.ok,
        now,
      });

      if (!result.ok) {
        // Any failure — including a 429 from the per-user or fleet budget — is
        // a silent skip. Nothing retries; the reservation is already spent.
        deps.logger?.warn?.("diagnostics.auto_send_failed", {
          failureCode,
          surface: request.surface,
          reason: result.reason,
        });
        captureOutcome("failed");
        return "failed";
      }
      deps.logger?.info?.("diagnostics.auto_sent", {
        failureCode,
        surface: request.surface,
        reference: result.reference,
      });
      captureOutcome("completed");
      return "completed";
    } finally {
      inFlight = false;
    }
  };

  return { report };
}
