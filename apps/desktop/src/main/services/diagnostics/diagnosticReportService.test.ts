import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  collectDiagnosticReport,
  diagnosticReportRoots,
  resolveRevealableDiagnosticReport,
} from "./diagnosticReportService";

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

  it("still returns when the runtime never answers", async () => {
    // Both optional steps talk to the subsystem the user is reporting as
    // broken. A step that never settles used to hold the whole report, leaving
    // the "Report issue" button spinning forever.
    const projectRoot = fs.mkdtempSync(path.join(tempRoot, "project-"));
    const { report } = await collectDiagnosticReport(
      {
        ...deps(),
        stepTimeoutMs: 20,
        getLocalRuntimeStatus: () => new Promise<never>(() => {}),
        diagnoseProject: () => new Promise<never>(() => {}),
      },
      { surface: "project_recovery", projectRoot },
    );

    expect(report).toContain("## Notes");
  });

  // The step deadline is a race, and losing a race does not cancel a timer.
  // Every report used to leave one pending 8s timer per optional step behind
  // it -- unref'd, so it held nothing open, but still a handle the process is
  // carrying and enough to hang a fake-timer test that runs after it.
  it("cancels the step deadline once the step has answered", async () => {
    const projectRoot = fs.mkdtempSync(path.join(tempRoot, "project-"));
    vi.useFakeTimers();
    try {
      await collectDiagnosticReport(
        {
          ...deps(),
          stepTimeoutMs: 60_000,
          getLocalRuntimeStatus: async () => ({ state: "running" }),
          diagnoseProject: async () => ({ state: "healthy" }),
        },
        { surface: "project_recovery", projectRoot },
      );

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still returns when a collection step throws synchronously", async () => {
    const projectRoot = fs.mkdtempSync(path.join(tempRoot, "project-"));
    const { report } = await collectDiagnosticReport(
      {
        ...deps(),
        getLocalRuntimeStatus: () => {
          throw new Error("runtime module is not loaded");
        },
        diagnoseProject: () => {
          throw new Error("recovery service is gone");
        },
      },
      { surface: "project_recovery", projectRoot },
    );

    expect(report).toContain("## Notes");
  });

  it("omits the notes line when there is nothing to say", async () => {
    const { report } = await collectDiagnosticReport(deps(), {
      surface: "project_recovery",
      projectRoot: null,
    });

    expect(report).not.toContain("requested project root was not recognised");
  });

  // A machine-scoped report is the one a user reaches when nothing will open,
  // and it used to be the one missing `main.jsonl` — the desktop appended it
  // only when a project happened to be open. The evidence was on disk the
  // whole time.
  it("carries the last project's main.jsonl when no project is open", async () => {
    const adeHome = fs.mkdtempSync(path.join(tempRoot, "adeHome-"));
    const projectRoot = fs.mkdtempSync(path.join(tempRoot, "photon-"));
    const logsDir = path.join(projectRoot, ".ade", "transcripts", "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(path.join(logsDir, "main.jsonl"), '{"event":"deeplink.scheme_claimed"}\n', "utf8");
    fs.writeFileSync(path.join(logsDir, "ade-cli.jsonl"), '{"event":"cli.started"}\n', "utf8");
    fs.writeFileSync(
      path.join(adeHome, "projects.json"),
      JSON.stringify({
        version: 2,
        projects: [{ rootPath: projectRoot, lastOpenedAt: 7, catalogVisibility: "recent" }],
      }),
      "utf8",
    );

    const { report } = await collectDiagnosticReport(
      { ...deps(), env: { ADE_HOME: adeHome } },
      { surface: "project_recovery", projectRoot: null },
    );

    expect(report).toContain("### Desktop main");
    expect(report).toContain("deeplink.scheme_claimed");
    expect(report).toContain("### ADE CLI");
    expect(report).toContain("no project was open");
    // The project's absolute path must not ride along with its logs.
    expect(report).not.toContain(projectRoot);
  });

  // The desktop and `ade report-issue` are meant to produce the same document;
  // the section that says what the background service was told to be is part
  // of it, present-or-noted, on every platform.
  it("always carries a background service definition section", async () => {
    const adeHome = fs.mkdtempSync(path.join(tempRoot, "adeHome-"));

    const { report } = await collectDiagnosticReport(
      { ...deps(), env: { ADE_HOME: adeHome } },
      { surface: "project_recovery", projectRoot: null },
    );

    expect(report).toContain("## Background service definition");
  });
});

describe("resolveRevealableDiagnosticReport", () => {
  // Regression: the reveal handler carried only the desktop's reports
  // directory, so "View" on every toast for a BRAIN send — the sends nobody
  // was present for, and therefore the ones most worth opening — threw.
  function roots() {
    const userDataDir = fs.mkdtempSync(path.join(tempRoot, "userData-"));
    const adeDir = fs.mkdtempSync(path.join(tempRoot, "adeHome-"));
    for (const dir of diagnosticReportRoots({ userDataDir, adeDir })) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return { userDataDir, adeDir, list: diagnosticReportRoots({ userDataDir, adeDir }) };
  }

  it("reveals a report written by either sender", () => {
    const { userDataDir, adeDir, list } = roots();
    const desktopReport = path.join(userDataDir, "diagnostic-reports", "ade-desktop.md");
    const brainReport = path.join(adeDir, "diagnostic-reports", "ade-brain.md");
    fs.writeFileSync(desktopReport, "# desktop", "utf8");
    fs.writeFileSync(brainReport, "# brain", "utf8");

    expect(resolveRevealableDiagnosticReport(list, desktopReport)).toBe(desktopReport);
    expect(resolveRevealableDiagnosticReport(list, brainReport)).toBe(brainReport);
  });

  it("refuses anything outside both reports directories", () => {
    const { adeDir, list } = roots();
    // A neighbour of a reports directory, a walk out of one, and an absolute
    // path the renderer simply invented.
    const neighbour = path.join(adeDir, "secrets", "credentials.json");
    fs.mkdirSync(path.dirname(neighbour), { recursive: true });
    fs.writeFileSync(neighbour, "{}", "utf8");

    expect(resolveRevealableDiagnosticReport(list, neighbour)).toBeNull();
    expect(
      resolveRevealableDiagnosticReport(
        list,
        path.join(adeDir, "diagnostic-reports", "..", "secrets", "credentials.json"),
      ),
    ).toBeNull();
    expect(resolveRevealableDiagnosticReport(list, path.join(os.homedir(), ".ssh", "id_rsa")))
      .toBeNull();
  });
});
