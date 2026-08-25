import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildDiagnosticIssueUrl,
  buildDiagnosticReport,
  diagnosticReportFilePath,
  writeDiagnosticReportFile,
} from "../services/diagnostics/diagnosticReport";
import {
  collectMachineDiagnosticSources,
  collectMachineDiagnosticSourcesAsync,
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
  /**
   * The failure this report is about, when the caller already knows it. The
   * interactive command does not (a person pressed "report", not a subsystem),
   * so it stays null there; the automatic sender always has one.
   */
  code?: string | null;
  headline?: string | null;
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
  /**
   * `~/.ade/diagnostic-reports` — the same directory the brain's automatic
   * sender saves to, so the desktop toast's "View" reaches a CLI report too.
   */
  reportsDir: string;
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

/**
 * The two builders below differ only in how they collect: a one-shot
 * `ade report-issue` has nothing to hold up and stays synchronous, while a
 * long-lived process must not block its event loop on the collector's
 * subprocesses. Everything after collection is identical, so it lives here
 * rather than being duplicated and drifting.
 */
function finishCliDiagnosticReport(
  options: ReportIssueOptions,
  inputs: { at: Date; projectRoot: string | null; surface: string },
  sources: ReturnType<typeof collectMachineDiagnosticSources>,
): ReportIssueResult {
  const { at, projectRoot, surface } = inputs;
  const env = options.env ?? process.env;
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
      headline: options.headline?.trim().slice(0, 300) || null,
      code: options.code?.trim().slice(0, 120) || null,
      technicalDetail: null,
      projectRoot,
    },
    state: sources.state,
    storage: sources.storage,
    storageEnvironment: sources.storageEnvironment,
    logs: sources.logs,
    serviceDefinition: sources.serviceDefinition,
    notes: sources.notes,
    redaction: sources.redaction,
  });

  return {
    report,
    installId,
    appVersion: options.cliVersion ?? null,
    secretsDir: sources.layout.secretsDir,
    reportsDir: path.join(sources.layout.adeDir, "diagnostic-reports"),
    issueUrl: buildDiagnosticIssueUrl({
      surface,
      headline: options.headline?.trim().slice(0, 300) || null,
      code: options.code?.trim().slice(0, 120) || null,
      appVersion: options.cliVersion ?? null,
      platform: process.platform,
      arch: process.arch,
      installId,
      redaction: sources.redaction,
    }),
  };
}

function resolveCliReportInputs(options: ReportIssueOptions): {
  at: Date;
  projectRoot: string | null;
  surface: string;
} {
  return {
    at: options.now?.() ?? new Date(),
    projectRoot: options.projectRoot?.trim() || null,
    surface: options.surface?.trim() || "cli",
  };
}

export function buildCliDiagnosticReport(options: ReportIssueOptions = {}): ReportIssueResult {
  const env = options.env ?? process.env;
  const inputs = resolveCliReportInputs(options);
  const sources = collectMachineDiagnosticSources({ env, projectRoot: inputs.projectRoot });
  return finishCliDiagnosticReport(options, inputs, sources);
}

/**
 * The builder for processes that stay alive. The brain sends automatic reports
 * while it is serving RPC, and the collector shells out (`journalctl` on Linux,
 * `Export-ScheduledTask` on Windows) with a 4s cap per command — synchronously,
 * that is 4s of a frozen event loop for a report nobody asked for.
 */
export async function buildCliDiagnosticReportAsync(
  options: ReportIssueOptions = {},
): Promise<ReportIssueResult> {
  const env = options.env ?? process.env;
  const inputs = resolveCliReportInputs(options);
  const sources = await collectMachineDiagnosticSourcesAsync({
    env,
    projectRoot: inputs.projectRoot,
  });
  return finishCliDiagnosticReport(options, inputs, sources);
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
    /** Set by the automatic sender; `ade report-issue --send` leaves it off. */
    auto?: boolean;
    failureCode?: string | null;
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
    auto: deps.auto === true,
    failureCode: deps.failureCode ?? null,
    fetchImpl: deps.fetchImpl,
  });
}

/**
 * Saves the exact bytes that were (or would have been) uploaded, next to the
 * brain's automatic reports.
 *
 * `--send` writes one unconditionally, because both outcomes need a file: a
 * successful send needs somewhere to point when the user asks "what did you
 * just take from my machine", and a failed one needs to leave them holding
 * something concrete instead of a sentence about a service they cannot reach.
 * Best effort — a read-only or full disk must not turn reporting a bug into a
 * second bug.
 */
export function saveDiagnosticReportCopy(
  built: Pick<ReportIssueResult, "report" | "reportsDir">,
  args: { surface?: string; at?: Date } = {},
): string | null {
  const filePath = diagnosticReportFilePath(
    built.reportsDir,
    args.surface?.trim() || "cli",
    args.at ?? new Date(),
  );
  return writeDiagnosticReportFile(filePath, built.report) ? filePath : null;
}

/**
 * What `--send` prints, in the same register as the rest of the command.
 *
 * Both branches end somewhere the user can go. A success names the reference
 * support will ask for AND the local copy of what was sent; a failure says why
 * in plain words and names the file, because "couldn't send" with nothing
 * attached is how a support thread turns into four more round trips.
 */
export function describeDiagnosticUpload(
  result: DiagnosticUploadResult,
  savedPath?: string | null,
): string {
  if (result.ok) {
    const sent = `Sent to ADE — reference ${result.reference}`;
    return savedPath ? `${sent}\nExactly what was sent is saved at ${savedPath}` : sent;
  }
  const reason = (() => {
    switch (result.reason) {
      case "rate_limited":
        return "Not sent: you've already sent several reports today. Try again tomorrow.";
      case "too_large":
        return "Not sent: this report is too big to send.";
      case "unavailable":
        return "Not sent: ADE can't take reports right now.";
      case "rejected":
        return "Not sent: the report service refused this report.";
      default:
        return "Not sent: ADE couldn't reach the report service.";
    }
  })();
  return savedPath
    ? `${reason}\nThe report is saved at ${savedPath} — attach that file to a GitHub issue.`
    : `${reason} File it on GitHub instead (the full report is above).`;
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
  savedPath?: string | null,
): {
  ok: true;
  installId: string;
  issueUrl: string;
  copied: boolean;
  report: string;
  reportPath?: string;
  sent?: { ok: boolean; reference?: string; reason?: string };
} {
  return {
    ok: true,
    installId: built.installId,
    issueUrl: built.issueUrl,
    copied: side?.copied ?? false,
    report: built.report,
    // The same file the text output names, so a script that wraps `--send`
    // can attach it without re-serializing the report itself.
    ...(savedPath ? { reportPath: savedPath } : {}),
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
