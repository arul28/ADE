import path from "node:path";
import {
  buildCliDiagnosticReport,
  describeDiagnosticUpload,
  sendDiagnosticReport,
  type ReportIssueResult,
} from "../commands/reportIssue";
import type { DiagnosticUploadResult } from "../../../desktop/src/shared/diagnosticsUpload";
import {
  diagnosticReportFilePath,
  writeDiagnosticReportFile,
} from "../services/diagnostics/diagnosticReport";
import { resolveMachineAdeLayout } from "../services/projects/machineLayout";

/**
 * `/report-issue` for the TUI — the terminal counterpart of the desktop
 * "Report issue" button and of `ade report-issue`.
 *
 * Like both of those it reads only local files: it never asks the brain for
 * anything, so it still answers on a machine where the brain is the problem.
 * The report is redacted in {@link buildCliDiagnosticReport} (private paths,
 * account names, emails, addresses and tokens) before it is written anywhere.
 *
 * `/report-issue send` is the third surface of the same one-way handoff the
 * desktop's "Send to ADE" link and `ade report-issue --send` offer. Building
 * and sending are separate steps on purpose: the report exists, is written, and
 * is shown before a single byte leaves the machine, so a failed send costs the
 * user nothing they had already been given.
 */

declare const __ADE_VERSION__: string | undefined;

/**
 * The TUI bundle carries the same `__ADE_VERSION__` define as the `ade`
 * entrypoint, so a report filed from `ade code` names the same build. Running
 * from source (tests, `npm run dev:code`) has no define and falls back to the
 * env var the packaged runtime sets.
 */
export function resolveTuiCliVersion(env: NodeJS.ProcessEnv = process.env): string | null {
  const bundled = typeof __ADE_VERSION__ === "string" ? __ADE_VERSION__.trim() : "";
  if (bundled && bundled !== "0.0.0") return bundled;
  return env.ADE_CLI_VERSION?.trim() || bundled || null;
}

export type TuiDiagnosticReport = {
  /** Narrow-pane summary rendered by the `details` right pane. */
  body: string;
  /** Where the full report landed, or null when it could not be written. */
  filePath: string | null;
  issueUrl: string;
  installId: string;
  /**
   * Exactly what {@link sendTuiDiagnosticReport} posts — the same bytes this
   * pane showed and wrote to disk, never a re-derived report.
   */
  sendable: Pick<ReportIssueResult, "report" | "installId" | "appVersion" | "secretsDir">;
};

/**
 * The pane body, in both of its states: freshly built, or built and then sent.
 * Pure so the wording is testable without touching disk or the network.
 */
export function formatTuiDiagnosticBody(input: {
  filePath: string | null;
  issueUrl: string;
  installId: string;
  /** Null before `/report-issue send` runs; the outcome after it does. */
  sent: DiagnosticUploadResult | null;
}): string {
  const written = input.filePath !== null;
  return [
    "A diagnostic report has been prepared.",
    "Private paths, account names, emails and tokens are removed before it is written or sent.",
    "",
    input.sent ? describeDiagnosticUpload(input.sent) : null,
    input.sent ? "" : null,
    written ? "Saved to:" : "It could not be saved to disk, so paste it from the issue page instead.",
    input.filePath,
    "",
    "File the issue at:",
    input.issueUrl,
    "",
    `Install id: ${input.installId}`,
    "",
    // Only offered while it is still the thing left to do: repeating it under a
    // "Sent to ADE" line reads as though the send did not take.
    input.sent?.ok
      ? null
      : "Run /report-issue send to hand this same report to ADE instead of filing it yourself.",
    "If ADE Code will not start at all, run ade report-issue --open --send in any terminal — it reads local files only.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

export function buildTuiDiagnosticReport(args: {
  projectRoot: string | null;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  /** Overrides the directory the report is written to (tests). */
  reportsDir?: string;
}): TuiDiagnosticReport {
  const env = args.env ?? process.env;
  const at = args.now?.() ?? new Date();
  const surface = "ade_code";
  const built = buildCliDiagnosticReport({
    surface,
    projectRoot: args.projectRoot,
    cliVersion: resolveTuiCliVersion(env),
    env,
    now: () => at,
  });
  const reportsDir = args.reportsDir
    ?? path.join(resolveMachineAdeLayout(env).adeDir, "diagnostic-reports");
  const filePath = diagnosticReportFilePath(reportsDir, surface, at);
  const written = writeDiagnosticReportFile(filePath, built.report);
  const resolved = {
    filePath: written ? filePath : null,
    issueUrl: built.issueUrl,
    installId: built.installId,
  };
  return {
    ...resolved,
    body: formatTuiDiagnosticBody({ ...resolved, sent: null }),
    sendable: {
      report: built.report,
      installId: built.installId,
      appVersion: built.appVersion,
      secretsDir: built.secretsDir,
    },
  };
}

/**
 * `/report-issue send`: hand the already-built report to ADE and re-render the
 * pane around the outcome.
 *
 * The upload itself, the account token, and the directory origin are all
 * resolved by {@link sendDiagnosticReport}, so the terminal, the desktop, and
 * `ade report-issue --send` post identical bytes to identical places. Failures
 * come back as a result, never a throw — the report is already on disk and the
 * issue URL is still in the pane, so a dead network downgrades to "file it
 * yourself" rather than losing the report.
 */
export async function sendTuiDiagnosticReport(
  built: TuiDiagnosticReport,
  deps?: Parameters<typeof sendDiagnosticReport>[1],
): Promise<{ result: DiagnosticUploadResult; body: string; notice: string }> {
  const result = await sendDiagnosticReport(built.sendable, deps);
  return {
    result,
    body: formatTuiDiagnosticBody({
      filePath: built.filePath,
      issueUrl: built.issueUrl,
      installId: built.installId,
      sent: result,
    }),
    notice: describeDiagnosticUpload(result),
  };
}
