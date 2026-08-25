import {
  DEFAULT_ADE_ACCOUNT_DIRECTORY_URL,
  resolveTrustedAccountDirectoryBaseUrl,
} from "./accountDirectory";

/**
 * "Send to ADE": posts an already-redacted diagnostic report to the account
 * directory Worker's `POST /diagnostics/upload`.
 *
 * ONE home for the upload, shared by every surface that offers it — the desktop
 * renderer's "Report issue" button, the desktop main process, and
 * `ade report-issue --send`. It lives under `apps/desktop/src/shared` because
 * that is the only directory all three can import: Vite's dev server refuses to
 * serve files outside `apps/desktop`, so the renderer cannot reach the CLI's
 * tree, while the CLI already imports from here.
 *
 * Deliberately free of Node built-ins and of `import.meta`, so the identical
 * module loads in the renderer bundle, in the main process, and in the CLI.
 * Plain `fetch` with no platform branches: Windows behaves exactly as macOS.
 *
 * Everything private is stripped by `redactDiagnosticText` before a report
 * exists at all, so this module deliberately does nothing to the text: it posts
 * the exact bytes the user could have pasted themselves. Any transformation
 * here would mean the thing that was sent is not the thing that was shown.
 *
 * Surface-specific concerns stay with their surface: the CLI reads an account
 * token out of the machine's credential store in `sendDiagnosticReport`, and
 * the renderer has none (access tokens live in the brain's store and are not
 * exposed over the preload bridge), so desktop uploads are anonymous.
 */

export const DIAGNOSTICS_UPLOAD_PATH = "/diagnostics/upload";

/**
 * Mirror of `MAX_DIAGNOSTIC_REPORT_BYTES` in `apps/account-directory/src/diagnostics.ts`.
 *
 * Same number, deliberately measured against a different thing on each side —
 * and they still agree. The Worker has to bound the bytes as they arrive, before
 * anything is parsed, so its cap is on the WHOLE request body; this side knows
 * what it is about to send, so it weighs the serialized body too rather than the
 * report inside it. Checking only the report would pass a report sitting exactly
 * at the cap and then have the `{"report":...}` envelope and its escaping push
 * the request over on the wire — a 413 a round-trip later for something that was
 * knowable here.
 */
export const MAX_DIAGNOSTIC_UPLOAD_BYTES = 512 * 1024;

const DEFAULT_UPLOAD_TIMEOUT_MS = 20_000;

/**
 * Why a send failed, in terms a UI can turn into one short sentence. Never a
 * server string: the caller is a user who already hit one failure, and a raw
 * status line is not an improvement on "couldn't send".
 */
export type DiagnosticUploadFailure =
  | "too_large"
  /** THIS caller has stored its allowance of reports today. */
  | "rate_limited"
  /** Nothing to do with this caller: the fleet's day is spent, or the route is down. */
  | "unavailable"
  | "rejected"
  | "network";

/**
 * The fleet-wide 429's body, mirrored from `apps/account-directory/src/diagnostics.ts`.
 *
 * The route answers two DISTINCT 429s on purpose — one about the caller's own
 * quota, one about the whole fleet's daily ceiling — because only the first is
 * something the caller can do anything about. Telling someone "you have sent
 * several today" when in fact ADE stopped taking reports from everyone is a
 * lie, and the wire already carries enough to avoid it.
 *
 * A literal rather than an import: the Worker is a separate deploy unit and this
 * module is loaded by the renderer, main and the CLI. Change one, change both.
 */
const FLEET_BUDGET_EXHAUSTED_ERROR = "daily diagnostics budget exhausted";

export type DiagnosticUploadResult =
  | { ok: true; id: string; reference: string }
  | { ok: false; reason: DiagnosticUploadFailure };

/**
 * Where DESKTOP uploads go.
 *
 * The desktop's own account origin is resolved in the main process by the
 * account bridge, which the renderer cannot reach, so the base is derived here
 * from the same two sources that bridge uses: an explicit override, else ADE's
 * hosted directory. A malformed override falls back to the default rather than
 * silently posting a report somewhere else.
 *
 * The CLI does NOT go through this: it already resolves the directory origin
 * the way the brain does (project secret, machine override, else the official
 * URL for the issuer) and hands the result to `uploadDiagnosticReport`. Passing
 * it through here as well would silently redirect a self-hosted machine's
 * report — and its account token — to ADE's directory instead.
 */
export function resolveDiagnosticsUploadBaseUrl(override?: string | null): string {
  return resolveTrustedAccountDirectoryBaseUrl(override) ?? DEFAULT_ADE_ACCOUNT_DIRECTORY_URL;
}

export function diagnosticsUploadUrl(baseUrl: string): string {
  return `${baseUrl.trim().replace(/\/+$/, "")}${DIAGNOSTICS_UPLOAD_PATH}`;
}

/**
 * The short handle a user reads back to support. Full uuids are unreadable over
 * a phone call and the prefix is enough to find the object.
 */
export function diagnosticReference(id: string): string {
  return id.trim().slice(0, 8);
}

export type DiagnosticUploadRequest = {
  /** The redacted report, byte-for-byte as the user sees it. */
  report: string;
  installId?: string | null;
  appVersion?: string | null;
  /**
   * Clerk access token, when a caller has one. `ade report-issue --send` reads
   * the machine's credential store and does send one; the renderer cannot and
   * uploads anonymously against the install id the report already carries.
   */
  token?: string | null;
  /** Already resolved by the caller; see `resolveDiagnosticsUploadBaseUrl`. */
  baseUrl: string;
  /**
   * True when ADE decided to send this, rather than a person pressing a button.
   *
   * The route stores it so the two populations stay separable: an automatic
   * report is one nobody chose to file, and reading them as if a user had
   * would badly misread which failures people actually care about.
   */
  auto?: boolean;
  /**
   * The failure that triggered an automatic send — a short code such as
   * `brain_crash_looping`, never text. Shape is `/^[a-z][a-z0-9_-]{0,47}$/`;
   * anything else is dropped here rather than sent for the Worker to refuse.
   */
  failureCode?: string | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

/**
 * Mirror of the account directory route's `failureCode` shape.
 *
 * Exported because the auto-send ledger has to reject a code BEFORE it spends
 * one of the day's three sends on a request this uploader would then strip. The
 * Worker keeps its own copy (`apps/account-directory/src/diagnostics.ts`) on
 * purpose — it is a separate deploy unit and must not import from the app — but
 * inside this process there is exactly one.
 */
export const FAILURE_CODE_PATTERN = /^[a-z][a-z0-9_-]{0,47}$/;

export async function uploadDiagnosticReport(
  request: DiagnosticUploadRequest,
): Promise<DiagnosticUploadResult> {
  const report = request.report;
  if (!report.trim()) return { ok: false, reason: "rejected" };

  const failureCode = request.failureCode?.trim() ?? "";
  const body = JSON.stringify({
    report,
    ...(request.installId ? { installId: request.installId } : {}),
    ...(request.appVersion ? { appVersion: request.appVersion } : {}),
    ...(request.auto ? { auto: true } : {}),
    ...(FAILURE_CODE_PATTERN.test(failureCode) ? { failureCode } : {}),
  });
  // Checked here as well as on the Worker so an oversized report fails without
  // spending one of the user's few daily uploads on a doomed request. The exact
  // bytes that would go on the wire, so this side never sends something the
  // Worker's identical cap would refuse.
  if (new TextEncoder().encode(body).byteLength > MAX_DIAGNOSTIC_UPLOAD_BYTES) {
    return { ok: false, reason: "too_large" };
  }

  const send = request.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS);
  let response: Response;
  try {
    response = await send(
      diagnosticsUploadUrl(request.baseUrl),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(request.token ? { authorization: `Bearer ${request.token}` } : {}),
        },
        body,
        signal: controller.signal,
      },
    );
  } catch {
    return { ok: false, reason: "network" };
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 413) return { ok: false, reason: "too_large" };
  if (response.status === 429) {
    // Which 429 is it? A body we cannot read falls back to the caller-scoped
    // reading, which is what this returned before there were two of them —
    // the conservative answer, since it only ever asks the user to wait.
    let body = "";
    try {
      body = await response.text();
    } catch {
      body = "";
    }
    return {
      ok: false,
      reason: body.includes(FLEET_BUDGET_EXHAUSTED_ERROR) ? "unavailable" : "rate_limited",
    };
  }
  if (response.status === 503) return { ok: false, reason: "unavailable" };
  if (!response.ok) return { ok: false, reason: "rejected" };

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, reason: "rejected" };
  }
  const id = payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>).id
    : null;
  if (typeof id !== "string" || !id.trim()) return { ok: false, reason: "rejected" };
  return { ok: true, id: id.trim(), reference: diagnosticReference(id) };
}

/**
 * One short, non-technical sentence per outcome. The person reading this is
 * already looking at an error screen; a status code is not help.
 *
 * The CLI words its own line differently (`describeDiagnosticUpload` in
 * `apps/ade-cli/src/commands/reportIssue.ts`) because it prints a terminal line
 * rather than a sentence under a button; the reasons themselves are this
 * module's, and there is only one table of them.
 */
export function describeDiagnosticUploadFailure(reason: DiagnosticUploadFailure): string {
  switch (reason) {
    case "rate_limited":
      return "You've already sent a few reports today. Try again tomorrow.";
    case "too_large":
      return "This report is too big to send. Copy it and post it on GitHub instead.";
    case "unavailable":
      return "ADE can't take reports right now. Copy it and post it on GitHub instead.";
    default:
      return "ADE couldn't send the report. Copy it and post it on GitHub instead.";
  }
}
