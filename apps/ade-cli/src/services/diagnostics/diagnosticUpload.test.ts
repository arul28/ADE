import { describe, expect, it, vi } from "vitest";
import {
  diagnosticsUploadUrl,
  MAX_DIAGNOSTIC_REPORT_BYTES,
  uploadDiagnosticReport,
} from "./diagnosticUpload";

const REPORT = "# ADE diagnostic report\n\n- surface: cli\n- note: already redacted\n";
const BASE_URL = "https://directory.example";

function okResponse(id = "11111111-2222-4333-8444-555555555555"): Response {
  return new Response(JSON.stringify({ ok: true, id }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function capture(response: Response = okResponse()) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return response;
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function sentBody(init: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

describe("uploadDiagnosticReport", () => {
  it("posts the report verbatim to the upload route", async () => {
    const { calls, fetchImpl } = capture();
    const result = await uploadDiagnosticReport({
      baseUrl: `${BASE_URL}/`,
      report: REPORT,
      installId: "install-1",
      appVersion: "1.2.60",
      fetchImpl,
    });

    expect(result).toEqual({
      ok: true,
      id: "11111111-2222-4333-8444-555555555555",
      reference: "11111111",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE_URL}/diagnostics/upload`);
    expect(calls[0]!.init.method).toBe("POST");
    // Redaction is upstream: whatever this module was handed is exactly what
    // goes on the wire. If this ever stops matching, the user is being shown
    // one thing and sending another.
    expect(sentBody(calls[0]!.init)).toEqual({
      report: REPORT,
      installId: "install-1",
      appVersion: "1.2.60",
    });
  });

  it("sends the account token only when there is one", async () => {
    const authed = capture();
    await uploadDiagnosticReport({
      baseUrl: BASE_URL,
      report: REPORT,
      token: "clerk-token",
      fetchImpl: authed.fetchImpl,
    });
    expect(new Headers(authed.calls[0]!.init.headers).get("authorization"))
      .toBe("Bearer clerk-token");

    const anonymous = capture();
    await uploadDiagnosticReport({
      baseUrl: BASE_URL,
      report: REPORT,
      fetchImpl: anonymous.fetchImpl,
    });
    expect(new Headers(anonymous.calls[0]!.init.headers).get("authorization")).toBeNull();
    expect(sentBody(anonymous.calls[0]!.init)).toEqual({ report: REPORT });
  });

  it("refuses an oversized report before spending a request", async () => {
    const { calls, fetchImpl } = capture();
    const result = await uploadDiagnosticReport({
      baseUrl: BASE_URL,
      report: "x".repeat(MAX_DIAGNOSTIC_REPORT_BYTES + 1),
      fetchImpl,
    });
    expect(result).toEqual({ ok: false, reason: "too_large" });
    expect(calls).toHaveLength(0);
  });

  it("maps each refusal to a reason the caller can explain", async () => {
    const cases: Array<[number, string]> = [
      [413, "too_large"],
      [429, "rate_limited"],
      [503, "unavailable"],
      [400, "rejected"],
      [500, "rejected"],
    ];
    for (const [status, reason] of cases) {
      const { fetchImpl } = capture(new Response("{}", { status }));
      await expect(uploadDiagnosticReport({ baseUrl: BASE_URL, report: REPORT, fetchImpl }))
        .resolves.toEqual({ ok: false, reason });
    }
  });

  it("treats an unusable success body as a failure rather than inventing a reference", async () => {
    const { fetchImpl } = capture(new Response("not json", { status: 200 }));
    await expect(uploadDiagnosticReport({ baseUrl: BASE_URL, report: REPORT, fetchImpl }))
      .resolves.toEqual({ ok: false, reason: "rejected" });

    const noId = capture(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await expect(uploadDiagnosticReport({
      baseUrl: BASE_URL,
      report: REPORT,
      fetchImpl: noId.fetchImpl,
    })).resolves.toEqual({ ok: false, reason: "rejected" });
  });

  it("reports a network failure instead of throwing at an error screen", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }) as unknown as typeof fetch;
    await expect(uploadDiagnosticReport({ baseUrl: BASE_URL, report: REPORT, fetchImpl }))
      .resolves.toEqual({ ok: false, reason: "network" });
  });

  it("normalizes the base URL", () => {
    expect(diagnosticsUploadUrl("https://x.dev")).toBe("https://x.dev/diagnostics/upload");
    expect(diagnosticsUploadUrl("https://x.dev///")).toBe("https://x.dev/diagnostics/upload");
    expect(diagnosticsUploadUrl("  https://x.dev  ")).toBe("https://x.dev/diagnostics/upload");
  });
});
