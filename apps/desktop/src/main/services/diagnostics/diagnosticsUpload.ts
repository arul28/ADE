import {
  DEFAULT_ADE_ACCOUNT_DIRECTORY_URL,
  resolveTrustedAccountDirectoryBaseUrl,
} from "../../../shared/accountDirectory";

/**
 * "Send to ADE": posts an already-redacted diagnostic report to the account
 * directory Worker's `POST /diagnostics/upload`.
 *
 * MIRROR of `apps/ade-cli/src/services/diagnostics/diagnosticUpload.ts` — same
 * path, same size cap, same body shape — kept separate on purpose. The desktop
 * renderer is the only surface that can trigger this (there is no diagnostics
 * IPC channel for uploads, only `openIssue`), and Vite's dev server refuses to
 * serve files outside `apps/desktop`, so the renderer cannot import the CLI's
 * copy. Change one, change the other.
 *
 * Deliberately free of Node built-ins and of `import.meta`, so the identical
 * module loads in the renderer bundle and in the main process. Plain `fetch`
 * with no platform branches: Windows behaves exactly as macOS does.
 *
 * The report is redacted upstream, in the main process, before it ever reaches
 * the renderer, and this module sends those bytes verbatim — what is uploaded
 * is byte-for-byte what the user can read on their clipboard.
 */

export const DIAGNOSTICS_UPLOAD_PATH = "/diagnostics/upload";

/** Mirror of `MAX_DIAGNOSTIC_REPORT_BYTES` in `apps/account-directory/src/diagnostics.ts`. */
export const MAX_DIAGNOSTIC_REPORT_BYTES = 512 * 1024;

const DEFAULT_UPLOAD_TIMEOUT_MS = 20_000;

export type DiagnosticUploadFailure =
  | "too_large"
  | "rate_limited"
  | "unavailable"
  | "rejected"
  | "network";

export type DiagnosticUploadResult =
  | { ok: true; id: string; reference: string }
  | { ok: false; reason: DiagnosticUploadFailure };

/**
 * Where uploads go.
 *
 * The desktop's own account origin is resolved in the main process by the
 * account bridge, which the renderer cannot reach, so the base is derived here
 * from the same two sources that bridge uses: an explicit override, else ADE's
 * hosted directory. A malformed override falls back to the default rather than
 * silently posting a report somewhere else.
 */
export function resolveDiagnosticsUploadBaseUrl(override?: string | null): string {
  return resolveTrustedAccountDirectoryBaseUrl(override) ?? DEFAULT_ADE_ACCOUNT_DIRECTORY_URL;
}

export function diagnosticsUploadUrl(baseUrl: string): string {
  return `${baseUrl.trim().replace(/\/+$/, "")}${DIAGNOSTICS_UPLOAD_PATH}`;
}

/** Short handle a user can read out to support; the full id is unreadable aloud. */
export function diagnosticReference(id: string): string {
  return id.trim().slice(0, 8);
}

export type DiagnosticUploadRequest = {
  /** The redacted report, exactly as the copy button hands it over. */
  report: string;
  installId?: string | null;
  appVersion?: string | null;
  /**
   * Clerk access token, when a caller has one. The renderer never does — access
   * tokens live in the brain's credential store and are not exposed over the
   * preload bridge — so desktop uploads are anonymous and carry only the
   * install id the report already embeds. `ade report-issue --send` reads the
   * store directly and does send a token.
   */
  token?: string | null;
  baseUrl?: string | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export async function uploadDiagnosticReport(
  request: DiagnosticUploadRequest,
): Promise<DiagnosticUploadResult> {
  if (!request.report.trim()) return { ok: false, reason: "rejected" };
  // Checked before sending so an oversized report fails immediately instead of
  // spending one of the user's few daily uploads on a doomed request.
  if (new TextEncoder().encode(request.report).byteLength > MAX_DIAGNOSTIC_REPORT_BYTES) {
    return { ok: false, reason: "too_large" };
  }

  const send = request.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS);
  let response: Response;
  try {
    response = await send(
      diagnosticsUploadUrl(resolveDiagnosticsUploadBaseUrl(request.baseUrl)),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(request.token ? { authorization: `Bearer ${request.token}` } : {}),
        },
        body: JSON.stringify({
          report: request.report,
          ...(request.installId ? { installId: request.installId } : {}),
          ...(request.appVersion ? { appVersion: request.appVersion } : {}),
        }),
        signal: controller.signal,
      },
    );
  } catch {
    return { ok: false, reason: "network" };
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 413) return { ok: false, reason: "too_large" };
  if (response.status === 429) return { ok: false, reason: "rate_limited" };
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
