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
      properties: { feature: "issue_report", action: "auto_sent", outcome: "completed" },
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
      properties: { feature: "issue_report", action: "auto_sent", outcome: "skipped_budget" },
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

describe("createAutoDiagnosticsService.prepareManual and sendPrepared", () => {
  const TEN_MINUTES_MS = 10 * 60_000;

  /** One prepare and one send, for the budget tests. */
  async function prepareAndSend(service: ReturnType<typeof harness>["service"]) {
    const prepared = await service.prepareManual();
    if (!prepared.ok) throw new Error("prepare failed in test setup");
    return service.sendPrepared(prepared.id);
  }

  it("prepares the redacted report for reading, with no upload and no budget spent", async () => {
    const { service, upload, writeReportFile, onSent } = harness();

    const prepared = await service.prepareManual();

    expect(prepared).toEqual({
      ok: true,
      id: expect.any(String),
      report: "# report for user_requested",
      bytes: Buffer.byteLength("# report for user_requested", "utf8"),
      expiresAtMs: T0 + TEN_MINUTES_MS,
      noteMaxChars: 2000,
    });
    // Opening the dialog and pressing Cancel must cost the person nothing.
    expect(upload).not.toHaveBeenCalled();
    expect(writeReportFile).not.toHaveBeenCalled();
    expect(onSent).not.toHaveBeenCalled();
    expect(service.getStatus().manualSendsInWindow).toBe(0);
  });

  it("uploads exactly the prepared text, tagged as not automatic, and claims the budget once", async () => {
    const { service, upload, writeReportFile, onSent } = harness();
    const prepared = await service.prepareManual();
    if (!prepared.ok) throw new Error("prepare failed in test setup");

    await expect(service.sendPrepared(prepared.id)).resolves.toEqual({
      result: {
        ok: true,
        reference: "abcd1234",
        reportPath: "/tmp/reports/report.md",
      },
      context: { surface: "settings_manual" },
      claimed: true,
    });

    expect(writeReportFile).toHaveBeenCalledWith("/tmp/reports/report.md", prepared.report);
    expect(upload).toHaveBeenCalledTimes(1);
    // `auto: false` keeps these separable server-side from the reports nobody chose to file.
    expect(upload.mock.calls[0]?.[0]).toMatchObject({
      auto: false,
      failureCode: "user_requested",
      report: prepared.report,
      installId: "install-1",
    });
    // No toast: the person who pressed the button is already reading the answer.
    expect(onSent).not.toHaveBeenCalled();
    expect(service.listPendingNotices()).toEqual([]);
    expect(service.getStatus().manualSendsInWindow).toBe(1);
    // One use: the same text is not sent again under the same id.
    await expect(service.sendPrepared(prepared.id)).resolves.toMatchObject({
      result: { ok: false, reason: "expired" },
    });
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["an unknown id", { unknownId: true, discard: false, expire: false }],
    ["a discarded id", { unknownId: false, discard: true, expire: false }],
    ["an id past its ten minutes", { unknownId: false, discard: false, expire: true }],
  ])("uploads nothing for %s", async (_label, { unknownId, discard, expire }) => {
    let clock = T0;
    const { service, upload } = harness({ now: () => clock });
    const prepared = await service.prepareManual();
    if (!prepared.ok) throw new Error("prepare failed in test setup");
    if (discard) service.discardPrepared(prepared.id);
    if (expire) clock = T0 + TEN_MINUTES_MS + 1;
    const id = unknownId ? "not-a-real-id" : prepared.id;

    await expect(service.sendPrepared(id)).resolves.toEqual({
      result: { ok: false, reason: "expired" },
      context: null,
    });
    expect(upload).not.toHaveBeenCalled();
    expect(service.getStatus().manualSendsInWindow).toBe(0);
  });

  it("answers a build failure as a prepare failure that claims nothing", async () => {
    const { service, upload } = harness({
      buildReport: async () => {
        throw new Error("collector wedged");
      },
    });

    await expect(service.prepareManual()).resolves.toEqual({ ok: false, reason: "failed" });
    expect(upload).not.toHaveBeenCalled();
    expect(service.getStatus().manualSendsInWindow).toBe(0);
  });

  it("keeps at most four drafts, and the oldest one expires first", async () => {
    const { service, upload } = harness();
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const prepared = await service.prepareManual();
      if (!prepared.ok) throw new Error("prepare failed in test setup");
      ids.push(prepared.id);
    }

    await expect(service.sendPrepared(ids[0] as string)).resolves.toMatchObject({
      result: { ok: false, reason: "expired" },
    });
    await expect(service.sendPrepared(ids[4] as string)).resolves.toMatchObject({
      result: { ok: true },
    });
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("gives a second send for a running id the same answer, with one upload and one claim", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const upload = vi.fn(async (_request: { auto?: boolean }) => {
      await gate;
      return { ok: true as const, id: "abcd1234-rest", reference: "abcd1234" };
    });
    const { service } = harness({ upload });
    const prepared = await service.prepareManual();
    if (!prepared.ok) throw new Error("prepare failed in test setup");

    const first = service.sendPrepared(prepared.id);
    const second = service.sendPrepared(prepared.id);
    release();

    const [firstAnswer, secondAnswer] = await Promise.all([first, second]);
    expect(firstAnswer.result).toMatchObject({ ok: true, reference: "abcd1234" });
    expect(secondAnswer).toMatchObject({ result: { ok: true, reference: "abcd1234" }, joined: true });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(service.getStatus().manualSendsInWindow).toBe(1);
  });

  it("keeps a failed send's text, so Try again sends the same report", async () => {
    const upload = vi
      .fn<[{ report: string }], Promise<{ ok: false; reason: "network" } | { ok: true; id: string; reference: string }>>()
      .mockResolvedValueOnce({ ok: false, reason: "network" })
      .mockResolvedValueOnce({ ok: true, id: "abcd1234-rest", reference: "abcd1234" });
    const { service } = harness({ upload });
    const prepared = await service.prepareManual();
    if (!prepared.ok) throw new Error("prepare failed in test setup");

    await expect(service.sendPrepared(prepared.id)).resolves.toMatchObject({
      result: { ok: false, reason: "failed" },
    });
    await expect(service.sendPrepared(prepared.id)).resolves.toMatchObject({
      result: { ok: true, reference: "abcd1234" },
    });
    expect(upload.mock.calls[0]?.[0].report).toBe(prepared.report);
    expect(upload.mock.calls[1]?.[0].report).toBe(prepared.report);
  });

  // The IPC handler files the person's note for a send that was tried and
  // failed, and for no other: a send that tried nothing must not file notes
  // past the daily limit.
  it.each([
    ["an upload that failed", "upload_failed", true],
    ["a ledger that cannot be read", "ledger_unreadable", undefined],
  ] as const)("says whether a failed send was tried: %s", async (_label, failure, claimed) => {
    const stateFilePath = stateFile();
    const upload = vi.fn(async () => ({ ok: false as const, reason: "network" as const }));
    const { service } = harness({ stateFilePath, ...(failure === "upload_failed" ? { upload } : {}) });
    const prepared = await service.prepareManual();
    if (!prepared.ok) throw new Error("prepare failed in test setup");
    if (failure === "ledger_unreadable") {
      fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
      fs.writeFileSync(stateFilePath, "not json");
    }

    const answer = await service.sendPrepared(prepared.id);

    expect(answer.result).toMatchObject({ ok: false, reason: "failed" });
    expect(answer.claimed).toBe(claimed);
  });

  it("refuses past the fifth send of the day, in the user's own words", async () => {
    const { service, upload } = harness();

    for (let i = 0; i < 5; i += 1) {
      await expect(prepareAndSend(service)).resolves.toMatchObject({ result: { ok: true } });
    }
    const refused = await prepareAndSend(service);
    expect(refused.result).toEqual({ ok: false, reason: "local_limit", limit: 5 });
    // Nothing was tried, so no note is filed for it either.
    expect(refused.claimed).toBeUndefined();
    // Refused HERE, so the request never reaches the account directory.
    expect(upload).toHaveBeenCalledTimes(5);
  });

  it("keeps the manual budget and the automatic one out of each other's way", async () => {
    const { service } = harness();

    for (let i = 0; i < 5; i += 1) await prepareAndSend(service);
    await expect(prepareAndSend(service)).resolves.toMatchObject({ result: { ok: false } });

    // A user asking for help must not silence the reports that explain the failure.
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
    await expect(prepareAndSend(service)).resolves.toMatchObject({ result: { ok: true } });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(service.isEnabled()).toBe(false);

    // The automatic path stays refused, so consent is honoured where it applies.
    await expect(service.report({ failureCode: "disk_full", surface: "project_recovery" }))
      .resolves.toBe("skipped_disabled");
  });

  it.each([
    ["rate_limited", "rate_limited"],
    ["unavailable", "unavailable"],
    ["too_large", "too_large"],
    ["network", "failed"],
    ["rejected", "failed"],
  ] as const)("carries an upload refusal of %s through as the reason %s", async (uploadReason, reason) => {
    const { service } = harness({
      upload: async () => ({ ok: false as const, reason: uploadReason }),
    });

    await expect(prepareAndSend(service)).resolves.toMatchObject({
      result: {
        ok: false,
        reason,
        // The local copy still exists, so the surface can offer to show it.
        reportPath: "/tmp/reports/report.md",
      },
    });
  });
});
