import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProductAnalyticsCapture } from "../../../shared/types/productAnalytics";
import {
  createAutoDiagnosticsService,
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

  it("holds a send nobody was listening for until a window drains it", async () => {
    const { service, filePath } = harness({ onSent: undefined });

    await expect(service.report({ failureCode: "disk_full", surface: "project_recovery" }))
      .resolves.toBe("completed");

    expect(service.flushPendingNotices()).toEqual([
      { failureCode: "disk_full", reportPath: "/tmp/reports/report.md", reference: "abcd1234" },
    ]);
    expect(service.flushPendingNotices()).toEqual([]);
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("still holds the notice when a window took the fast-path toast", async () => {
    // Regression: `webContents.send` does not throw when the renderer has
    // crashed or has not mounted its toast host, so "a window existed" was
    // being recorded as "the user was told" and the notice was retired
    // unshown. A successful send is now ALWAYS pending until a renderer
    // drains it; the immediate send is only a fast path.
    const { service, onSent } = harness();

    await expect(service.report({ failureCode: "disk_full", surface: "project_recovery" }))
      .resolves.toBe("completed");

    expect(onSent).toHaveBeenCalledTimes(1);
    expect(service.flushPendingNotices()).toEqual([
      { failureCode: "disk_full", reportPath: "/tmp/reports/report.md", reference: "abcd1234" },
    ]);
    // Drained once and only once, so the redundant delivery is bounded at one.
    expect(service.flushPendingNotices()).toEqual([]);
  });

  it("records the send even when the toast listener throws", async () => {
    const { service } = harness({
      onSent: () => {
        throw new Error("renderer is gone");
      },
    });

    await expect(service.report({ failureCode: "disk_full", surface: "project_recovery" }))
      .resolves.toBe("completed");
    expect(service.flushPendingNotices()).toHaveLength(1);
  });

  it("exposes the toggle the settings pane and the toast both write", async () => {
    const { service } = harness();
    expect(service.isEnabled()).toBe(true);
    expect(service.setEnabled(false)).toBe(false);
    expect(service.getStatus()).toEqual({ enabled: false, sendsInWindow: 0, limit: 3 });
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
