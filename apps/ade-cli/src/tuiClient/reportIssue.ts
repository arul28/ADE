import path from "node:path";
import { buildCliDiagnosticReport } from "../commands/reportIssue";
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
};

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
  const body = [
    "A diagnostic report has been prepared.",
    "Private paths, account names, emails and tokens are removed before it is written.",
    "",
    written ? "Saved to:" : "It could not be saved to disk, so paste it from the issue page instead.",
    written ? filePath : null,
    "",
    "File the issue at:",
    built.issueUrl,
    "",
    `Install id: ${built.installId}`,
    "",
    "If ADE Code will not start at all, run ade report-issue --open in any terminal — it reads local files only.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
  return { body, filePath: written ? filePath : null, issueUrl: built.issueUrl, installId: built.installId };
}
