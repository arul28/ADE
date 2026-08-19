import { describe, expect, it } from "vitest";
import { DEFAULT_ADE_ACCOUNT_DIRECTORY_URL } from "../../../shared/accountDirectory";
import {
  describeDiagnosticUploadFailure,
  MAX_DIAGNOSTIC_REPORT_BYTES,
  resolveDiagnosticsUploadBaseUrl,
  uploadDiagnosticReport,
} from "./diagnosticsUpload";

const REPORT = "# ADE diagnostic report\n\n- surface: brain_repair\n- note: already redacted\n";

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
  it("posts the exact report the clipboard holds", async () => {
    const { calls, fetchImpl } = capture(ok());
    const result = await uploadDiagnosticReport({
      report: REPORT,
      installId: "install-5",
      baseUrl: "https://directory.example",
      fetchImpl,
    });

    expect(result).toEqual({
      ok: true,
      id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      reference: "aaaaaaaa",
    });
    expect(calls[0]!.url).toBe("https://directory.example/diagnostics/upload");
    // Redaction happened in the main process before the renderer ever saw this
    // text. The send must be byte-identical to what the user can read.
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      report: REPORT,
      installId: "install-5",
    });
  });

  it("sends no authorization header — the renderer has no account token", async () => {
    const { calls, fetchImpl } = capture(ok());
    await uploadDiagnosticReport({ report: REPORT, fetchImpl });
    expect(new Headers(calls[0]!.init.headers).get("authorization")).toBeNull();
    expect(calls[0]!.url.startsWith(DEFAULT_ADE_ACCOUNT_DIRECTORY_URL)).toBe(true);
  });

  it("refuses an oversized report locally instead of burning a daily upload", async () => {
    const { calls, fetchImpl } = capture(ok());
    await expect(uploadDiagnosticReport({
      report: "x".repeat(MAX_DIAGNOSTIC_REPORT_BYTES + 1),
      fetchImpl,
    })).resolves.toEqual({ ok: false, reason: "too_large" });
    expect(calls).toHaveLength(0);
  });

  it("turns every refusal into a reason, never an exception on an error screen", async () => {
    for (const [status, reason] of [[413, "too_large"], [429, "rate_limited"], [503, "unavailable"], [500, "rejected"]] as const) {
      const { fetchImpl } = capture(new Response("{}", { status }));
      await expect(uploadDiagnosticReport({ report: REPORT, fetchImpl }))
        .resolves.toEqual({ ok: false, reason });
    }

    const thrown = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    await expect(uploadDiagnosticReport({ report: REPORT, fetchImpl: thrown }))
      .resolves.toEqual({ ok: false, reason: "network" });
  });

  it("explains failures without a status code or a file path", () => {
    for (const reason of ["too_large", "rate_limited", "unavailable", "rejected", "network"] as const) {
      const sentence = describeDiagnosticUploadFailure(reason);
      expect(sentence.length).toBeGreaterThan(0);
      expect(sentence).not.toMatch(/\d{3}|http|\//);
    }
  });
});
