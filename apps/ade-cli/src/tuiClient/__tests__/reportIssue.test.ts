import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildTuiDiagnosticReport, sendTuiDiagnosticReport } from "../reportIssue";

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("buildTuiDiagnosticReport", () => {
  it("writes an owner-only report and points the pane at it", () => {
    const adeHome = tempDir("ade-home-");
    const reportsDir = path.join(adeHome, "diagnostic-reports");
    const built = buildTuiDiagnosticReport({
      projectRoot: null,
      env: { ADE_HOME: adeHome, ADE_CLI_VERSION: "9.9.9" },
      now: () => new Date("2026-08-16T09:30:00.000Z"),
      reportsDir,
    });

    expect(built.filePath).toBe(
      path.join(reportsDir, "2026-08-16T09-30-00-000Z-ade-code.md"),
    );
    const stat = fs.statSync(built.filePath!);
    // The report carries machine state; it must not be world-readable.
    expect(stat.mode & 0o077).toBe(0);
    expect(fs.readFileSync(built.filePath!, "utf8")).toContain("9.9.9");

    // The pane body is the only thing the user sees, so it has to carry both
    // ways of acting on the report.
    expect(built.body).toContain(built.filePath!);
    expect(built.body).toContain(built.issueUrl);
  });

  it("still yields an issue URL when the report cannot be written", () => {
    const adeHome = tempDir("ade-home-");
    const blocked = path.join(adeHome, "blocked");
    // A file where the directory should be: mkdir fails, and reporting a bug
    // must not itself fail.
    fs.writeFileSync(blocked, "not a directory");

    const built = buildTuiDiagnosticReport({
      projectRoot: null,
      env: { ADE_HOME: adeHome },
      reportsDir: path.join(blocked, "reports"),
    });

    expect(built.filePath).toBeNull();
    expect(built.issueUrl).toMatch(/^https:\/\/github\.com\//);
    expect(built.body).toContain(built.issueUrl);
  });

  it("offers the send before anything has left the machine", () => {
    const adeHome = tempDir("ade-home-");
    const built = buildTuiDiagnosticReport({
      projectRoot: null,
      env: { ADE_HOME: adeHome },
      reportsDir: path.join(adeHome, "diagnostic-reports"),
    });
    expect(built.body).toContain("/report-issue send");
  });
});

describe("sendTuiDiagnosticReport", () => {
  function build(): ReturnType<typeof buildTuiDiagnosticReport> {
    const adeHome = tempDir("ade-home-");
    return buildTuiDiagnosticReport({
      projectRoot: null,
      env: { ADE_HOME: adeHome, ADE_CLI_VERSION: "9.9.9" },
      reportsDir: path.join(adeHome, "diagnostic-reports"),
    });
  }

  it("posts the exact bytes the pane showed and reports the reference", async () => {
    const built = build();
    let posted: { url: string; body: unknown } | null = null;
    const sent = await sendTuiDiagnosticReport(built, {
      baseUrl: "https://directory.example",
      getToken: async () => "token-abc",
      fetchImpl: (async (url: string, init: RequestInit) => {
        posted = { url, body: JSON.parse(String(init.body)) };
        expect((init.headers as Record<string, string>).authorization).toBe("Bearer token-abc");
        return new Response(JSON.stringify({ id: "abcdef01-2345-6789-abcd-ef0123456789" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
    });

    expect(sent.result.ok).toBe(true);
    expect(posted!.url).toBe("https://directory.example/diagnostics/upload");
    // The report is redacted once, at build time; sending must not reshape it.
    expect((posted!.body as { report: string }).report).toBe(built.sendable.report);
    expect((posted!.body as { appVersion?: string }).appVersion).toBe("9.9.9");
    expect(sent.body).toContain("reference");
    // Nothing is left to do, so the pane stops asking for the send.
    expect(sent.body).not.toContain("/report-issue send");
    // The local escape hatches survive a successful send.
    expect(sent.body).toContain(built.issueUrl);
  });

  it("keeps the manual route when the send fails", async () => {
    const built = build();
    const sent = await sendTuiDiagnosticReport(built, {
      baseUrl: "https://directory.example",
      getToken: async () => null,
      fetchImpl: (async () => new Response("", { status: 429 })) as unknown as typeof fetch,
    });

    expect(sent.result).toEqual({ ok: false, reason: "rate_limited" });
    expect(sent.notice).toContain("Not sent");
    expect(sent.body).toContain(built.issueUrl);
    expect(sent.body).toContain(built.filePath!);
    // Still offered: a rate limit is a "try later", not a dead end.
    expect(sent.body).toContain("/report-issue send");
  });

  it("downgrades an unreachable service to a failure, not a throw", async () => {
    const built = build();
    const sent = await sendTuiDiagnosticReport(built, {
      baseUrl: "https://directory.example",
      getToken: async () => null,
      fetchImpl: (async () => {
        throw new Error("getaddrinfo ENOTFOUND");
      }) as unknown as typeof fetch,
    });

    expect(sent.result).toEqual({ ok: false, reason: "network" });
    expect(sent.body).toContain(built.issueUrl);
  });
});
