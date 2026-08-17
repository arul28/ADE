import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCliDiagnosticReport } from "./reportIssue";

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
