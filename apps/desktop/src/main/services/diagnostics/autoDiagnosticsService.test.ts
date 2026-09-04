import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProductAnalyticsCapture } from "../../../shared/types/productAnalytics";
import {
  createAutoDiagnosticsService,
  type AutoDiagnosticsRequest,
  type AutoDiagnosticsServiceDeps,
} from "./autoDiagnosticsService";
import {
  resolveAutoDiagnosticsStateFile,
  setAutoDiagnosticsEnabled,
} from "./autoDiagnosticsStore";

const dirs: string[] = [];
const T0 = Date.parse("2026-08-19T10:00:00.000Z");

function stateFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-auto-diagnostics-service-"));
  dirs.push(dir);
  return resolveAutoDiagnosticsStateFile(dir, {});
}

function harness(overrides: Partial<AutoDiagnosticsServiceDeps> = {}) {
  const filePath = overrides.stateFilePath ?? stateFile();
  const upload = vi.fn(async (_request: { auto?: boolean; failureCode?: string | null }) =>
    ({ ok: true as const, id: "abcd1234-rest", reference: "abcd1234" }));
  const onSent = vi.fn(() => true);
  const capture = vi.fn<[ProductAnalyticsCapture], void>();
  const writeReportFile = vi.fn(() => true);
  const service = createAutoDiagnosticsService({
    stateFilePath: filePath,
    appVersion: "1.2.3",
    env: {},
    now: () => T0,
    upload,
    writeReportFile,
    onSent,
    capture,
    buildReport: async (request) => ({
      report: `# report for ${request.failureCode}`,
      filePath: "/tmp/reports/report.md",
      installId: "install-1",
    }),
    ...overrides,
  });
  return { service, filePath, upload, onSent, capture, writeReportFile };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("createAutoDiagnosticsService", () => {
  it("sends the report, saves the local copy, and says so exactly once", async () => {
    const { service, upload, onSent, writeReportFile, capture } = harness();

    await expect(service.report({ failureCode: "disk_full", surface: "project_recovery" }))
      .resolves.toBe("completed");

    expect(writeReportFile).toHaveBeenCalledWith("/tmp/reports/report.md", "# report for disk_full");
    expect(upload).toHaveBeenCalledTimes(1);
    // The server needs both to keep automatic reports separable from filed ones.
    expect(upload.mock.calls[0]?.[0]).toMatchObject({
      auto: true,
      failureCode: "disk_full",
      report: "# report for disk_full",
      installId: "install-1",
      appVersion: "1.2.3",
    });
    expect(onSent).toHaveBeenCalledWith({
      failureCode: "disk_full",
      reportPath: "/tmp/reports/report.md",
      reference: "abcd1234",
    });
    expect(capture.mock.calls[0]?.[0]).toMatchObject({
      event: "ade_feature_used",
      properties: { feature: "connections", action: "auto_sent", outcome: "completed" },
    });
  });

  it("does nothing at all while the setting is off", async () => {
    const filePath = stateFile();
    setAutoDiagnosticsEnabled(filePath, false, { now: () => T0 });
    const { service, upload, onSent, capture } = harness({ stateFilePath: filePath });

    await expect(service.report({ failureCode: "disk_full", surface: "project_recovery" }))
      .resolves.toBe("skipped_disabled");

    expect(upload).not.toHaveBeenCalled();
    expect(onSent).not.toHaveBeenCalled();
    // Not even a "we chose not to" event: consent is withdrawn, so nothing goes.
    expect(capture).not.toHaveBeenCalled();
  });

  it("stops at the budget instead of reporting the same failure twice", async () => {
    const { service, upload, capture } = harness();

    await expect(service.report({ failureCode: "disk_full", surface: "project_recovery" }))
      .resolves.toBe("completed");
    await expect(service.report({ failureCode: "disk_full", surface: "project_recovery" }))
      .resolves.toBe("skipped_budget");

    expect(upload).toHaveBeenCalledTimes(1);
    expect(capture.mock.calls.at(-1)?.[0]).toMatchObject({
      properties: { feature: "connections", action: "auto_sent", outcome: "skipped_budget" },
    });
  });

  it("treats a rate-limited server as a silent skip, with no toast and no retry", async () => {
    const upload = vi.fn(async () => ({ ok: false as const, reason: "rate_limited" as const }));
    const { service, onSent, capture } = harness({
      upload,
    });

    await expect(service.report({ failureCode: "disk_full", surface: "project_recovery" }))
      .resolves.toBe("failed");

    expect(onSent).not.toHaveBeenCalled();
    expect(capture.mock.calls.at(-1)?.[0]).toMatchObject({
      properties: { outcome: "failed" },
    });

    // The refusal already spent the reservation: a machine ADE said no to does
    // not get to ask again about the same failure today.
    await expect(service.report({ failureCode: "disk_full", surface: "project_recovery" }))
      .resolves.toBe("skipped_budget");
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("stays silent when the network throws rather than answering", async () => {
    const upload = vi.fn(async () => {
      throw new Error("socket hang up");
    });
    const { service, onSent } = harness({
      upload,
    });

    await expect(service.report({ failureCode: "disk_full", surface: "project_recovery" }))
      .resolves.toBe("failed");
    expect(onSent).not.toHaveBeenCalled();
  });

  it("does not attempt an upload when the report cannot be built", async () => {
    const upload = vi.fn();
    const { service } = harness({
      upload,
      buildReport: async () => {
        throw new Error("collector wedged");
      },
    });

    await expect(service.report({ failureCode: "disk_full", surface: "project_recovery" }))
      .resolves.toBe("failed");
    expect(upload).not.toHaveBeenCalled();
    // The reservation is NOT given back. What the budget bounds is how often
    // this computer tries on its own, and a collector that wedges every time
    // would otherwise retry the same failure forever.
    expect(service.getStatus().sendsInWindow).toBe(1);
    await expect(service.report({ failureCode: "disk_full", surface: "project_recovery" }))
      .resolves.toBe("skipped_budget");
  });

  it("holds a send nobody was listening for until a window says it showed it", async () => {
    const { service, filePath } = harness({ onSent: undefined });

    await expect(service.report({ failureCode: "disk_full", surface: "project_recovery" }))
      .resolves.toBe("completed");

    const notice = {
      failureCode: "disk_full",
      reportPath: "/tmp/reports/report.md",
      reference: "abcd1234",
    };
    expect(service.listPendingNotices()).toEqual([notice]);
    // No renderer acknowledged it, so it is still on offer — being handed to a
    // window that then dies is not the same as being seen.
    expect(service.listPendingNotices()).toEqual([notice]);

    service.ackNotices(["abcd1234"]);
    expect(service.listPendingNotices()).toEqual([]);
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("stops re-toasting a fast-path send across a restart once it is acknowledged", async () => {
    // Regression, both halves. `webContents.send` does not throw when the
    // renderer has crashed or has not mounted its toast host, so "a window
    // existed" must not be recorded as "the user was told" — but leaving it
    // pending forever meant the live toast came back at every launch. The
    // renderer's ack is what closes it, and it survives the process.
    const { service, filePath, onSent } = harness();

    await expect(service.report({ failureCode: "disk_full", surface: "project_recovery" }))
      .resolves.toBe("completed");
    expect(onSent).toHaveBeenCalledTimes(1);
    // The window that got the fast path toasted it and said so.
    service.ackNotices(["abcd1234"]);

    // Next launch: a brand new service over the same ledger.
    const { service: afterRestart } = harness({ stateFilePath: filePath });
    expect(afterRestart.listPendingNotices()).toEqual([]);
  });

  it("records the send even when the toast listener throws", async () => {
    const { service } = harness({
      onSent: () => {
        throw new Error("renderer is gone");
      },
    });

    await expect(service.report({ failureCode: "disk_full", surface: "project_recovery" }))
      .resolves.toBe("completed");
    expect(service.listPendingNotices()).toHaveLength(1);
  });

  it("exposes the toggle the settings pane and the toast both write", async () => {
    const { service } = harness();
    expect(service.isEnabled()).toBe(true);
    expect(service.setEnabled(false)).toBe(false);
    expect(service.getStatus()).toEqual({
      enabled: false,
      sendsInWindow: 0,
      limit: 3,
      manualSendsInWindow: 0,
      manualLimit: 5,
    });
  });

  it("drops a failure code the server would refuse without touching the budget", async () => {
    const { service, upload, capture } = harness();
    // `skipped_ineligible`, not `skipped_budget`: nothing was refused and
    // nothing was spent, and — as before — nothing is reported either.
    await expect(service.report({ failureCode: "   ", surface: "project_recovery" }))
      .resolves.toBe("skipped_ineligible");
    expect(upload).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
    expect(service.getStatus().sendsInWindow).toBe(0);
  });

  it("skips a second failure that fires while the first is still sending", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { service, upload } = harness({
      buildReport: async (request) => {
        await gate;
        return {
          report: `# report for ${request.failureCode}`,
          filePath: "/tmp/reports/report.md",
          installId: "install-1",
        };
      },
    });

    const first = service.report({ failureCode: "disk_full", surface: "project_recovery" });
    // Same reason as above: never sent, never counted, never announced.
    await expect(service.report({ failureCode: "db_integrity", surface: "project_recovery" }))
      .resolves.toBe("skipped_ineligible");
    release();
    await expect(first).resolves.toBe("completed");
    expect(upload).toHaveBeenCalledTimes(1);
    expect(service.getStatus().sendsInWindow).toBe(1);
  });
});

describe("createAutoDiagnosticsService.sendManual", () => {
  it("sends the same report the failure screens send, tagged as not automatic", async () => {
    const { service, upload, writeReportFile, onSent } = harness();

    await expect(service.sendManual()).resolves.toEqual({
      ok: true,
      reference: "abcd1234",
      reportPath: "/tmp/reports/report.md",
    });

    expect(writeReportFile).toHaveBeenCalledWith("/tmp/reports/report.md", "# report for user_requested");
    // `auto: false` is what keeps these separable server-side from the reports
    // nobody chose to file.
    expect(upload.mock.calls[0]?.[0]).toMatchObject({
      auto: false,
      failureCode: "user_requested",
      report: "# report for user_requested",
      installId: "install-1",
    });
    // No toast: the person who pressed the button is already reading the answer.
    expect(onSent).not.toHaveBeenCalled();
    expect(service.listPendingNotices()).toEqual([]);
  });

  it("stamps the asking screen's surface and code onto the report", async () => {
    const buildReport = vi.fn(async (_request: AutoDiagnosticsRequest) => ({
      report: "# report",
      filePath: "/tmp/reports/report.md",
      installId: "install-1",
    }));
    const { service, upload } = harness({ buildReport });

    await expect(service.sendManual({
      surface: "renderer_crash",
      code: "boundary_threw",
      headline: "ADE needs to reload this window",
      technicalDetail: "TypeError: undefined is not a function",
      projectRoot: "/tmp/photon",
    })).resolves.toMatchObject({ ok: true });

    // The report is filed under the screen that broke, not the settings pane.
    expect(buildReport).toHaveBeenCalledWith({
      failureCode: "boundary_threw",
      surface: "renderer_crash",
      headline: "ADE needs to reload this window",
      technicalDetail: "TypeError: undefined is not a function",
      projectRoot: "/tmp/photon",
    });
    // The budget and the upload still count this as what it is: one person
    // pressing one button, whichever screen they pressed it on.
    expect(upload.mock.calls[0]?.[0]).toMatchObject({ auto: false, failureCode: "user_requested" });
    expect(service.getStatus().manualSendsInWindow).toBe(1);
  });

  it("falls back to the settings surface when no screen names one", async () => {
    const buildReport = vi.fn(async (_request: AutoDiagnosticsRequest) => ({
      report: "# report",
      filePath: "/tmp/reports/report.md",
      installId: "install-1",
    }));
    const { service } = harness({ buildReport });

    // Blank is not a surface: a payload that arrived empty must not file the
    // report under "" or under whatever the last caller said.
    await expect(service.sendManual({ surface: "  ", code: "" }))
      .resolves.toMatchObject({ ok: true });
    await expect(service.sendManual()).resolves.toMatchObject({ ok: true });

    for (const call of buildReport.mock.calls) {
      expect(call[0]).toMatchObject({ surface: "settings_manual", failureCode: "user_requested" });
    }
    expect(buildReport).toHaveBeenCalledTimes(2);
  });

  it("refuses past the fifth send of the day, in the user's own words", async () => {
    const { service, upload } = harness();

    for (let i = 0; i < 5; i += 1) {
      await expect(service.sendManual()).resolves.toMatchObject({ ok: true });
    }
    await expect(service.sendManual()).resolves.toEqual({
      ok: false,
      reason: "local_limit",
      limit: 5,
    });
    // Refused HERE, so the request never reaches the account directory and
    // never spends one of the caller's server-side slots.
    expect(upload).toHaveBeenCalledTimes(5);
  });

  it("keeps the manual budget and the automatic one out of each other's way", async () => {
    const { service } = harness();

    for (let i = 0; i < 5; i += 1) await service.sendManual();
    expect((await service.sendManual()).ok).toBe(false);

    // A user asking for help must not silence the reports that explain the
    // failure they are asking about.
    await expect(service.report({ failureCode: "disk_full", surface: "project_recovery" }))
      .resolves.toBe("completed");
    expect(service.getStatus()).toMatchObject({
      sendsInWindow: 1,
      limit: 3,
      manualSendsInWindow: 5,
      manualLimit: 5,
    });
  });

  it("still sends when automatic sharing is off, and does not turn it back on", async () => {
    const { service, filePath, upload } = harness();
    setAutoDiagnosticsEnabled(filePath, false, { now: () => T0 });

    // The toggle is about what ADE does BY ITSELF. Refusing a deliberate click
    // would leave this user with no way to report anything at all.
    await expect(service.sendManual()).resolves.toMatchObject({ ok: true });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(service.isEnabled()).toBe(false);

    // The automatic path stays refused, so consent is honoured where it applies.
    await expect(service.report({ failureCode: "disk_full", surface: "project_recovery" }))
      .resolves.toBe("skipped_disabled");
  });

  it("carries each refusal through as its own reason, never a status code", async () => {
    for (
      const [uploadReason, reason] of [
        ["rate_limited", "rate_limited"],
        ["unavailable", "unavailable"],
        ["too_large", "too_large"],
        ["network", "failed"],
        ["rejected", "failed"],
      ] as const
    ) {
      const { service } = harness({
        upload: async () => ({ ok: false as const, reason: uploadReason }),
      });
      await expect(service.sendManual()).resolves.toEqual({
        ok: false,
        reason,
        // The local copy still exists, so the surface can offer to show it.
        reportPath: "/tmp/reports/report.md",
      });
    }
  });

  it("keeps the reservation when the report cannot even be built", async () => {
    const { service, upload } = harness({
      buildReport: async () => {
        throw new Error("collector wedged");
      },
    });

    await expect(service.sendManual()).resolves.toEqual({ ok: false, reason: "failed" });
    expect(upload).not.toHaveBeenCalled();
    // Spent on purpose: what the budget bounds is how often this computer
    // tries, not how often it wins. A collector that wedges every time would
    // otherwise be an unbounded retry loop behind a button.
    expect(service.getStatus().manualSendsInWindow).toBe(1);
  });
});
