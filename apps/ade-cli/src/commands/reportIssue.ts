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
import { copyToClipboard } from "../lib/clipboard";
import { openExternalUrl } from "../lib/externalLinks";

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

/**
 * The side effects of `ade report-issue --open`, in the order the desktop
 * "Report issue" button does them: the report goes on the clipboard, *then*
 * the prefilled GitHub issue opens.
 *
 * The order is the whole point. The template the URL carries says "paste the
 * report from your clipboard" — the URL itself only holds a stub, because a
 * full report does not fit in a query string. A flow that opens that form
 * without copying anything sends the user to a page asking for something that
 * is not there (and whatever unrelated text they had copied is what they would
 * paste). Both steps are best effort: a box with no clipboard binary and no
 * browser still gets the whole report on stdout.
 */
export async function openDiagnosticIssue(
  built: Pick<ReportIssueResult, "report" | "issueUrl">,
  deps: {
    copy?: (text: string) => boolean;
    open?: (url: string) => Promise<void>;
  } = {},
): Promise<{ copied: boolean; opened: boolean }> {
  const copy = deps.copy ?? copyToClipboard;
  const open = deps.open ?? openExternalUrl;
  let copied = false;
  try {
    copied = copy(built.report);
  } catch {
    copied = false;
  }
  let opened = false;
  try {
    await open(built.issueUrl);
    opened = true;
  } catch {
    // Headless boxes have no browser; the caller still prints the URL.
    opened = false;
  }
  return { copied, opened };
}

/**
 * The `--json` shape of `ade report-issue`. `copied` is here because `--open`
 * has two side effects, and a script that asked for machine-readable output
 * could not tell whether the second one happened: on a box with no clipboard
 * binary the report is only on stdout, and a caller that assumed otherwise
 * would tell its user to paste something that is not there. Without `--open`
 * nothing is copied, so it is simply false.
 */
export function buildReportIssuePayload(
  built: Pick<ReportIssueResult, "report" | "issueUrl" | "installId">,
  side: { copied: boolean } | null,
): { ok: true; installId: string; issueUrl: string; copied: boolean; report: string } {
  return {
    ok: true,
    installId: built.installId,
    issueUrl: built.issueUrl,
    copied: side?.copied ?? false,
    report: built.report,
  };
}
