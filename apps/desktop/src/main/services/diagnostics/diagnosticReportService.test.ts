import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
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

  // The other half of the same regression: refusing the renderer's root has to
  // mean the report is genuinely machine-scoped. If the collector still ran a
  // project diagnosis, the note would say "machine-level state only" over a
  // body that quietly carried the open project's recovery verdict.
  it("runs no project diagnosis at all for a machine-level report", async () => {
    const diagnoseProject = vi.fn(async () => ({ state: "healthy" }));

    const machineLevel = await collectDiagnosticReport(
      { ...deps(), diagnoseProject },
      { surface: "project_recovery", projectRoot: null },
    );

    expect(diagnoseProject).not.toHaveBeenCalled();
    expect(machineLevel.report).not.toContain("healthy");

    // ...and the project-scoped path is still wired, so the assertion above is
    // about the null root rather than a diagnosis that never runs.
    const projectRoot = path.join(tempRoot, "photon");
    fs.mkdirSync(projectRoot, { recursive: true });
    const scoped = await collectDiagnosticReport(
      { ...deps(), diagnoseProject },
      { surface: "project_recovery", projectRoot },
    );

    expect(diagnoseProject).toHaveBeenCalledTimes(1);
    expect(diagnoseProject).toHaveBeenCalledWith(projectRoot);
    expect(scoped.report).toContain("healthy");
  });

  it("omits the notes line when there is nothing to say", async () => {
    const { report } = await collectDiagnosticReport(deps(), {
      surface: "project_recovery",
      projectRoot: null,
    });

    expect(report).not.toContain("requested project root was not recognised");
  });
});
