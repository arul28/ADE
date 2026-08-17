import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { collectDiagnosticReport } from "./diagnosticReportService";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-diag-report-"));

afterAll(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function deps() {
  return {
    appVersion: "1.2.3",
    packageChannel: null,
    isPackaged: false,
    userDataPath: path.join(tempRoot, "userData"),
    reportsDir: path.join(tempRoot, "reports"),
    installId: "install-abc",
  };
}

describe("collectDiagnosticReport", () => {
  // Regression: when the renderer named a project root main did not recognise,
  // the handler silently substituted the currently open project, so a report
  // about a failed open carried a different project's logs and diagnosis. It
  // now degrades to machine-level state — and has to SAY so, or the reader
  // draws conclusions from an absence they were never told about.
  it("renders caller notes about a degraded report alongside the machine ones", async () => {
    const { report } = await collectDiagnosticReport(deps(), {
      surface: "project_recovery",
      projectRoot: null,
      extraNotes: ["requested project root was not recognised; machine-level state only"],
    });

    expect(report).toContain("## Notes");
    expect(report).toContain("- requested project root was not recognised; machine-level state only");
  });

  it("omits the notes line when there is nothing to say", async () => {
    const { report } = await collectDiagnosticReport(deps(), {
      surface: "project_recovery",
      projectRoot: null,
    });

    expect(report).not.toContain("requested project root was not recognised");
  });
});
