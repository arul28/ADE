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
import {
  uploadDiagnosticReport,
  type DiagnosticUploadResult,
} from "../../../desktop/src/shared/diagnosticsUpload";
import { DEFAULT_ADE_ACCOUNT_DIRECTORY_URL } from "../../../desktop/src/shared/accountDirectory";
import { getSignedInAccountAccessToken } from "../services/account/accountAuthService";
import {
  getSharedAccountAuthService,
  getSharedAccountDirectoryBaseUrl,
} from "../services/account/sharedAccountAuthService";
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
  /** CLI version stamped into the report; sent as upload metadata. */
  appVersion: string | null;
  /** Where this machine's account session lives, so `--send` can read a token. */
  secretsDir: string;
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
    appVersion: options.cliVersion ?? null,
    secretsDir: sources.layout.secretsDir,
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
 * `ade report-issue --send`: hand the same redacted report to ADE over HTTPS.
 *
 * Everything it needs is read from local files — the account session out of the
 * machine's own credential store, the directory origin out of the same resolver
 * the brain uses — so it still works on the machine where the brain will not
 * start, which is the only machine anyone runs this on. A signed-in machine
 * sends its Clerk token so support can tie the report to the account; a
 * signed-out one uploads anonymously against the install id the report already
 * carries. Neither path changes a byte of the report.
 */
export async function sendDiagnosticReport(
  built: Pick<ReportIssueResult, "report" | "installId" | "appVersion" | "secretsDir">,
  deps: {
    env?: NodeJS.ProcessEnv;
    baseUrl?: string;
    /** Test seam; production resolves the token from the credential store. */
    getToken?: () => Promise<string | null>;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<DiagnosticUploadResult> {
  const env = deps.env ?? process.env;
  // Both lookups touch the machine's own config and credential store, and this
  // command exists for machines whose state is damaged. Neither may throw: a
  // failed send has to stay a failed send, not take the printed report with it.
  const baseUrl = deps.baseUrl ?? (() => {
    try {
      return getSharedAccountDirectoryBaseUrl({ secretsDir: built.secretsDir, env });
    } catch {
      return DEFAULT_ADE_ACCOUNT_DIRECTORY_URL;
    }
  })();
  const token = await (deps.getToken ?? (async () => {
    // An unreadable or absent session simply means an anonymous upload, which
    // is exactly what the route accepts them for.
    try {
      return await getSignedInAccountAccessToken(
        getSharedAccountAuthService({ secretsDir: built.secretsDir, env }),
      );
    } catch {
      return null;
    }
  }))();

  return uploadDiagnosticReport({
    baseUrl,
    report: built.report,
    token,
    installId: built.installId === "unknown" ? null : built.installId,
    appVersion: built.appVersion,
    fetchImpl: deps.fetchImpl,
  });
}

/** One short line for `--text`, in the same register as the rest of the command. */
export function describeDiagnosticUpload(result: DiagnosticUploadResult): string {
  if (result.ok) return `Sent to ADE — reference ${result.reference}`;
  switch (result.reason) {
    case "rate_limited":
      return "Not sent: you've already sent several reports today. Try again tomorrow.";
    case "too_large":
      return "Not sent: this report is too big to send. File it on GitHub instead.";
    case "unavailable":
      return "Not sent: ADE can't take reports right now. File it on GitHub instead.";
    default:
      return "Not sent: ADE couldn't reach the report service. File it on GitHub instead.";
  }
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
  sent?: DiagnosticUploadResult | null,
): {
  ok: true;
  installId: string;
  issueUrl: string;
  copied: boolean;
  report: string;
  sent?: { ok: boolean; reference?: string; reason?: string };
} {
  return {
    ok: true,
    installId: built.installId,
    issueUrl: built.issueUrl,
    copied: side?.copied ?? false,
    report: built.report,
    // Omitted entirely without `--send`, so a script can tell "not asked for"
    // from "asked for and failed".
    ...(sent
      ? {
        sent: sent.ok
          ? { ok: true, reference: sent.reference }
          : { ok: false, reason: sent.reason },
      }
      : {}),
  };
}
