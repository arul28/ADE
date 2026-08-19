/**
 * Sends an already-redacted diagnostic report to ADE.
 *
 * Everything private is stripped by `redactDiagnosticText` before a report
 * exists at all, so this module deliberately does nothing to the text: it posts
 * the exact bytes the user could have pasted themselves. Any transformation
 * here would mean the thing that was sent is not the thing that was shown.
 *
 * Plain `fetch` and nothing else — no Node built-ins, no platform branches — so
 * the same code path runs on macOS, Linux and Windows, and inside the desktop's
 * main process, where this module is imported the same way
 * `diagnosticReportService` already imports the report builder.
 *
 * The desktop RENDERER cannot import this file (Vite's dev server only serves
 * paths under `apps/desktop`), so the button's own post lives in
 * `apps/desktop/src/main/services/diagnostics/diagnosticsUpload.ts`. Keep the
 * two in step: same path, same cap, same body shape.
 */

export const DIAGNOSTICS_UPLOAD_PATH = "/diagnostics/upload";

/** Mirror of `MAX_DIAGNOSTIC_REPORT_BYTES` in `apps/account-directory/src/diagnostics.ts`. */
export const MAX_DIAGNOSTIC_REPORT_BYTES = 512 * 1024;

const DEFAULT_UPLOAD_TIMEOUT_MS = 20_000;

export type DiagnosticUploadResult =
  | { ok: true; id: string; reference: string }
  | { ok: false; reason: DiagnosticUploadFailure };

/**
 * Why a send failed, in terms a UI can turn into one short sentence. Never a
 * server string: the caller is a user who already hit one failure, and a raw
 * status line is not an improvement on "couldn't send".
 */
export type DiagnosticUploadFailure =
  | "too_large"
  | "rate_limited"
  | "unavailable"
  | "rejected"
  | "network";

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
  baseUrl: string;
  /** The redacted report, byte-for-byte as the user sees it. */
  report: string;
  /** Clerk access token when the machine is signed in; omitted uploads are anonymous. */
  token?: string | null;
  installId?: string | null;
  appVersion?: string | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export async function uploadDiagnosticReport(
  request: DiagnosticUploadRequest,
): Promise<DiagnosticUploadResult> {
  const report = request.report;
  if (!report.trim()) return { ok: false, reason: "rejected" };
  // Checked here as well as on the Worker so an oversized report fails without
  // spending the user's daily quota on a request that cannot succeed.
  if (new TextEncoder().encode(report).byteLength > MAX_DIAGNOSTIC_REPORT_BYTES) {
    return { ok: false, reason: "too_large" };
  }

  const send = request.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS);
  let response: Response;
  try {
    response = await send(diagnosticsUploadUrl(request.baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(request.token ? { authorization: `Bearer ${request.token}` } : {}),
      },
      body: JSON.stringify({
        report,
        ...(request.installId ? { installId: request.installId } : {}),
        ...(request.appVersion ? { appVersion: request.appVersion } : {}),
      }),
      signal: controller.signal,
    });
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
