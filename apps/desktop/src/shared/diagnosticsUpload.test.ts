import { describe, expect, it, vi } from "vitest";
import { DEFAULT_ADE_ACCOUNT_DIRECTORY_URL } from "./accountDirectory";
import {
  describeDiagnosticUploadFailure,
  diagnosticsUploadUrl,
  MAX_DIAGNOSTIC_UPLOAD_BYTES,
  resolveDiagnosticsUploadBaseUrl,
  uploadDiagnosticReport,
} from "./diagnosticsUpload";

const REPORT = "# ADE diagnostic report\n\n- surface: brain_repair\n- note: already redacted\n";
const BASE_URL = "https://directory.example";

function capture(response: Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return response;
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function ok(id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"): Response {
  return new Response(JSON.stringify({ ok: true, id }), { status: 200 });
}

function sentBody(init: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

describe("resolveDiagnosticsUploadBaseUrl", () => {
  it("defaults to ADE's hosted directory and honours a valid override", () => {
    expect(resolveDiagnosticsUploadBaseUrl()).toBe(DEFAULT_ADE_ACCOUNT_DIRECTORY_URL);
    expect(resolveDiagnosticsUploadBaseUrl("  ")).toBe(DEFAULT_ADE_ACCOUNT_DIRECTORY_URL);
    expect(resolveDiagnosticsUploadBaseUrl("https://self.hosted.example"))
      .toBe("https://self.hosted.example");
  });

  it("falls back rather than posting a report to a malformed destination", () => {
    expect(resolveDiagnosticsUploadBaseUrl("not a url"))
      .toBe(DEFAULT_ADE_ACCOUNT_DIRECTORY_URL);
    expect(resolveDiagnosticsUploadBaseUrl("https://x.dev/?leak=1"))
      .toBe(DEFAULT_ADE_ACCOUNT_DIRECTORY_URL);
  });
});

describe("uploadDiagnosticReport", () => {
  it("posts the exact report the clipboard holds, with the caller's metadata", async () => {
    const { calls, fetchImpl } = capture(ok());
    const result = await uploadDiagnosticReport({
      report: REPORT,
      installId: "install-5",
      appVersion: "1.2.60",
      baseUrl: `${BASE_URL}/`,
      fetchImpl,
    });

    expect(result).toEqual({
      ok: true,
      id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      reference: "aaaaaaaa",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE_URL}/diagnostics/upload`);
    expect(calls[0]!.init.method).toBe("POST");
    // Redaction is upstream: whatever this module was handed is exactly what
    // goes on the wire. If this ever stops matching, the user is being shown
    // one thing and sending another.
    expect(sentBody(calls[0]!.init)).toEqual({
      report: REPORT,
      installId: "install-5",
      appVersion: "1.2.60",
    });
  });

  it("sends the account token only when a caller has one", async () => {
    // `ade report-issue --send` reads the machine's credential store; the
    // renderer cannot, and uploads anonymously against the default directory.
    const authed = capture(ok());
    await uploadDiagnosticReport({
      report: REPORT,
      baseUrl: BASE_URL,
      token: "clerk-token",
      fetchImpl: authed.fetchImpl,
    });
    expect(new Headers(authed.calls[0]!.init.headers).get("authorization"))
      .toBe("Bearer clerk-token");

    const anonymous = capture(ok());
    await uploadDiagnosticReport({
      report: REPORT,
      baseUrl: resolveDiagnosticsUploadBaseUrl(),
      fetchImpl: anonymous.fetchImpl,
    });
    expect(new Headers(anonymous.calls[0]!.init.headers).get("authorization")).toBeNull();
    expect(anonymous.calls[0]!.url.startsWith(DEFAULT_ADE_ACCOUNT_DIRECTORY_URL)).toBe(true);
    expect(sentBody(anonymous.calls[0]!.init)).toEqual({ report: REPORT });
  });

  it("refuses an oversized report locally instead of burning a daily upload", async () => {
    const { calls, fetchImpl } = capture(ok());
    await expect(uploadDiagnosticReport({
      report: "x".repeat(MAX_DIAGNOSTIC_UPLOAD_BYTES + 1),
      baseUrl: BASE_URL,
      fetchImpl,
    })).resolves.toEqual({ ok: false, reason: "too_large" });
    expect(calls).toHaveLength(0);
  });

  it("never puts a body on the wire that the Worker's identical cap would refuse", async () => {
    // The Worker bounds the whole request body, so a report sitting exactly at
    // the cap is already over it once the JSON envelope is added. Caught here,
    // it costs nothing; missed, it is a 413 that spends a request.
    const atCap = capture(ok());
    await expect(uploadDiagnosticReport({
      report: "x".repeat(MAX_DIAGNOSTIC_UPLOAD_BYTES),
      baseUrl: BASE_URL,
      fetchImpl: atCap.fetchImpl,
    })).resolves.toEqual({ ok: false, reason: "too_large" });
    expect(atCap.calls).toHaveLength(0);

    // The largest report that does fit is still sent, and what goes out is
    // within the cap the Worker applies to the same bytes.
    const envelope = new TextEncoder().encode(JSON.stringify({ report: "" })).byteLength;
    const fits = capture(ok());
    await expect(uploadDiagnosticReport({
      report: "x".repeat(MAX_DIAGNOSTIC_UPLOAD_BYTES - envelope),
      baseUrl: BASE_URL,
      fetchImpl: fits.fetchImpl,
    })).resolves.toMatchObject({ ok: true });
    expect(new TextEncoder().encode(String(fits.calls[0]!.init.body)).byteLength)
      .toBe(MAX_DIAGNOSTIC_UPLOAD_BYTES);
  });

  it("turns every refusal into a reason, never an exception on an error screen", async () => {
    for (
      const [status, reason] of [
        [413, "too_large"],
        [429, "rate_limited"],
        [503, "unavailable"],
        [400, "rejected"],
        [500, "rejected"],
      ] as const
    ) {
      const { fetchImpl } = capture(new Response("{}", { status }));
      await expect(uploadDiagnosticReport({ report: REPORT, baseUrl: BASE_URL, fetchImpl }))
        .resolves.toEqual({ ok: false, reason });
    }

    const thrown = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }) as unknown as typeof fetch;
    await expect(uploadDiagnosticReport({ report: REPORT, baseUrl: BASE_URL, fetchImpl: thrown }))
      .resolves.toEqual({ ok: false, reason: "network" });
  });

  it("treats an unusable success body as a failure rather than inventing a reference", async () => {
    const { fetchImpl } = capture(new Response("not json", { status: 200 }));
    await expect(uploadDiagnosticReport({ report: REPORT, baseUrl: BASE_URL, fetchImpl }))
      .resolves.toEqual({ ok: false, reason: "rejected" });

    const noId = capture(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await expect(uploadDiagnosticReport({
      report: REPORT,
      baseUrl: BASE_URL,
      fetchImpl: noId.fetchImpl,
    })).resolves.toEqual({ ok: false, reason: "rejected" });
  });

  it("normalizes the base URL", () => {
    expect(diagnosticsUploadUrl("https://x.dev")).toBe("https://x.dev/diagnostics/upload");
    expect(diagnosticsUploadUrl("https://x.dev///")).toBe("https://x.dev/diagnostics/upload");
    expect(diagnosticsUploadUrl("  https://x.dev  ")).toBe("https://x.dev/diagnostics/upload");
  });

  it("explains failures without a status code or a file path", () => {
    for (const reason of ["too_large", "rate_limited", "unavailable", "rejected", "network"] as const) {
      const sentence = describeDiagnosticUploadFailure(reason);
      expect(sentence.length).toBeGreaterThan(0);
      expect(sentence).not.toMatch(/\d{3}|http|\//);
    }
  });
});
