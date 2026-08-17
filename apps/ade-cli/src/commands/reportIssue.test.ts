import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCliDiagnosticReport,
  buildReportIssuePayload,
  openDiagnosticIssue,
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
