import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildDiagnosticIssueUrl,
  buildDiagnosticReport,
} from "../services/diagnostics/diagnosticReport";
import {
  collectMachineDiagnosticSources,
  readDiagnosticJsonFile,
} from "../services/diagnostics/diagnosticSources";

/**
 * Headless counterpart to the desktop "Report issue" button. Reads only local
 * files — it never starts or contacts the brain — so it still works on the
 * machine where ADE itself will not come up, and on Windows where there is no
 * desktop error screen to press.
 */

export type ReportIssueOptions = {
  surface?: string;
  projectRoot?: string | null;
  cliVersion?: string | null;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
};

export type ReportIssueResult = {
  report: string;
  issueUrl: string;
  installId: string;
};

/**
 * The same PostHog `distinct_id` the desktop reports, read without writing.
 *
 * Null whenever analytics is off — the `.disabled` marker the desktop writes,
 * or `enabled: false` in the state itself. No event carries the id then, so it
 * correlates to nothing, and printing it into a report the user is about to
 * paste into a public issue is the opposite of the choice they made.
 */
function readInstallId(secretsDir: string): string | null {
  const statePath = path.join(secretsDir, "product-analytics.json");
  if (fs.existsSync(`${statePath}.disabled`)) return null;
  const state = readDiagnosticJsonFile(statePath);
  if (!state || typeof state !== "object") return null;
  const record = state as Record<string, unknown>;
  if (record.enabled === false) return null;
  // Only the two keys PostHog actually uses as `distinct_id`; `installationId`
  // is a different identifier and would make the CLI report an id no event in
  // PostHog is ever attributed to.
  for (const key of ["identifiedUserHash", "anonymousId"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

export function buildCliDiagnosticReport(options: ReportIssueOptions = {}): ReportIssueResult {
  const env = options.env ?? process.env;
  const at = options.now?.() ?? new Date();
  const projectRoot = options.projectRoot?.trim() || null;
  const surface = options.surface?.trim() || "cli";

  const sources = collectMachineDiagnosticSources({
    env,
    projectRoot,
    includeProjectCliLog: true,
  });
  const installId = readInstallId(sources.layout.secretsDir) ?? "unknown";

  const report = buildDiagnosticReport({
    generatedAt: at.toISOString(),
    app: {
      version: options.cliVersion ?? null,
      packageChannel: env.ADE_PACKAGE_CHANNEL?.trim() || null,
      isPackaged: null,
      platform: process.platform,
      arch: process.arch,
      osRelease: os.release(),
      nodeVersion: process.versions.node ?? null,
      timezoneOffsetMinutes: -at.getTimezoneOffset(),
    },
    identity: { installId },
    context: {
      surface,
      headline: null,
      code: null,
      technicalDetail: null,
      projectRoot,
    },
    state: sources.state,
    storage: sources.storage,
    logs: sources.logs,
    notes: sources.notes,
    redaction: sources.redaction,
  });

  return {
    report,
    installId,
    issueUrl: buildDiagnosticIssueUrl({
      surface,
      appVersion: options.cliVersion ?? null,
      platform: process.platform,
      arch: process.arch,
      installId,
      redaction: sources.redaction,
    }),
  };
}
