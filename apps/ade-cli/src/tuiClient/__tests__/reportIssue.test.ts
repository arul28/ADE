import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildTuiDiagnosticReport } from "../reportIssue";

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
});
