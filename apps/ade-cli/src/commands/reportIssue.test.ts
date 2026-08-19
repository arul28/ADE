import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCliDiagnosticReport,
  buildReportIssuePayload,
  describeDiagnosticUpload,
  openDiagnosticIssue,
  sendDiagnosticReport,
} from "./reportIssue";

const tempDirs: string[] = [];

function adeHome(analytics: Record<string, unknown> | null): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-report-issue-"));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, "secrets"), { recursive: true });
  if (analytics) {
    fs.writeFileSync(
      path.join(dir, "secrets", "product-analytics.json"),
      JSON.stringify(analytics),
      "utf8",
    );
  }
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("buildCliDiagnosticReport", () => {
  it("reports the PostHog distinct_id and a prefilled issue URL", () => {
    const built = buildCliDiagnosticReport({
      env: { ADE_HOME: adeHome({ identifiedUserHash: "hash-1", anonymousId: "anon-1" }) },
      cliVersion: "1.2.60",
      now: () => new Date("2026-08-16T09:30:00.000Z"),
    });

    expect(built.installId).toBe("hash-1");
    expect(built.issueUrl.startsWith("https://github.com/")).toBe(true);
    expect(built.issueUrl).toContain("/issues/new");
    expect(built.report).toContain("1.2.60");
  });

  it("falls back to the anonymous id, then to 'unknown', without throwing", () => {
    const anonymous = buildCliDiagnosticReport({
      env: { ADE_HOME: adeHome({ anonymousId: "anon-2", installationId: "install-2" }) },
    });
    // `installationId` is a different identifier: no PostHog event is attributed
    // to it, so it must never be reported as the install id.
    expect(anonymous.installId).toBe("anon-2");

    const missing = buildCliDiagnosticReport({ env: { ADE_HOME: adeHome(null) } });
    expect(missing.installId).toBe("unknown");
    expect(missing.report.length).toBeGreaterThan(0);
  });

  it("omits the install id when analytics is switched off", () => {
    const built = buildCliDiagnosticReport({
      env: { ADE_HOME: adeHome({ identifiedUserHash: "hash-3", anonymousId: "anon-3", enabled: false }) },
    });

    expect(built.installId).toBe("unknown");
    expect(built.report).not.toContain("hash-3");
    expect(built.report).not.toContain("anon-3");
  });

  it("omits the install id when the opt-out marker is on disk", () => {
    const home = adeHome({ identifiedUserHash: "hash-4", anonymousId: "anon-4" });
    fs.writeFileSync(path.join(home, "secrets", "product-analytics.json.disabled"), "disabled\n", "utf8");

    const built = buildCliDiagnosticReport({ env: { ADE_HOME: home } });

    expect(built.installId).toBe("unknown");
    expect(built.report).not.toContain("hash-4");
  });
});

describe("openDiagnosticIssue", () => {
  it("puts the report on the clipboard before it opens the issue template", async () => {
    // The template says "paste the report from your clipboard", so the copy has
    // to have happened by the time the browser is opened -- otherwise the user
    // lands on a form asking for something that is not on their clipboard.
    const order: string[] = [];
    let copiedText: string | null = null;

    const result = await openDiagnosticIssue(
      { report: "REPORT BODY", issueUrl: "https://github.com/acme/ade/issues/new?title=x" },
      {
        copy: (text) => {
          order.push("copy");
          copiedText = text;
          return true;
        },
        open: async (url) => {
          order.push(`open:${url}`);
        },
      },
    );

    expect(order).toEqual(["copy", "open:https://github.com/acme/ade/issues/new?title=x"]);
    expect(copiedText).toBe("REPORT BODY");
    expect(result).toEqual({ copied: true, opened: true });
  });

  it("still opens the issue when the machine has no clipboard, and survives a browserless box", async () => {
    const result = await openDiagnosticIssue(
      { report: "REPORT BODY", issueUrl: "https://github.com/acme/ade/issues/new" },
      {
        copy: () => {
          throw new Error("no pbcopy here");
        },
        open: async () => {
          throw new Error("no browser here");
        },
      },
    );

    expect(result).toEqual({ copied: false, opened: false });
  });
});

describe("buildReportIssuePayload", () => {
  const built = {
    report: "REPORT BODY",
    issueUrl: "https://github.com/acme/ade/issues/new",
    installId: "install-abc",
  };

  it("tells a scripted caller whether --open actually reached the clipboard", () => {
    // `--open` copies the report and then opens a template that says "paste the
    // report from your clipboard". A box with no clipboard binary silently
    // skips the copy, so the JSON has to say so -- otherwise the only way to
    // find out is a user pasting nothing into a GitHub issue.
    expect(buildReportIssuePayload(built, { copied: true })).toEqual({
      ok: true,
      installId: "install-abc",
      issueUrl: "https://github.com/acme/ade/issues/new",
      copied: true,
      report: "REPORT BODY",
    });
    expect(buildReportIssuePayload(built, { copied: false }).copied).toBe(false);
  });

  it("reports nothing copied when --open was not asked for", () => {
    const payload = buildReportIssuePayload(built, null);

    expect(payload.copied).toBe(false);
    // The rest of the contract is unchanged: same keys, same `ok`.
    expect(payload.ok).toBe(true);
    expect(payload.issueUrl).toBe(built.issueUrl);
  });
});

describe("sendDiagnosticReport", () => {
  const built = {
    report: "REPORT BODY",
    installId: "install-abc",
    appVersion: "1.2.60",
    secretsDir: "/tmp/does-not-need-to-exist/secrets",
  };

  function capture(response: Response) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return response;
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }

  it("sends the built report unchanged, with the account token when signed in", async () => {
    const { calls, fetchImpl } = capture(
      new Response(JSON.stringify({ ok: true, id: "abcdef12-3456-4789-8abc-def012345678" }), {
        status: 200,
      }),
    );

    const result = await sendDiagnosticReport(built, {
      baseUrl: "https://directory.example",
      getToken: async () => "clerk-token",
      fetchImpl,
    });

    expect(result).toEqual({
      ok: true,
      id: "abcdef12-3456-4789-8abc-def012345678",
      reference: "abcdef12",
    });
    expect(calls[0]!.url).toBe("https://directory.example/diagnostics/upload");
    expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe("Bearer clerk-token");
    // The report is redacted upstream; --send must post those exact bytes.
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      report: "REPORT BODY",
      installId: "install-abc",
      appVersion: "1.2.60",
    });
  });

  it("uploads anonymously when there is no session, and drops the placeholder install id", async () => {
    const { calls, fetchImpl } = capture(
      new Response(JSON.stringify({ ok: true, id: "0f0f0f0f-1111-4222-8333-444444444444" }), {
        status: 200,
      }),
    );

    await sendDiagnosticReport(
      { ...built, installId: "unknown" },
      { baseUrl: "https://directory.example", getToken: async () => null, fetchImpl },
    );

    expect(new Headers(calls[0]!.init.headers).get("authorization")).toBeNull();
    // "unknown" is the report's stand-in for "analytics is off"; sending it as
    // an install id would attach a metadata value that identifies nothing.
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      report: "REPORT BODY",
      appVersion: "1.2.60",
    });
  });

  it("describes each failure in one plain sentence", async () => {
    expect(describeDiagnosticUpload({ ok: true, id: "abcdef1234", reference: "abcdef12" }))
      .toBe("Sent to ADE — reference abcdef12");
    expect(describeDiagnosticUpload({ ok: false, reason: "rate_limited" }))
      .toContain("already sent several reports today");
    expect(describeDiagnosticUpload({ ok: false, reason: "network" }))
      .toContain("couldn't reach");
  });
});
