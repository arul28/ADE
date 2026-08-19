import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ackAutoDiagnosticsNotices,
  AUTO_DIAGNOSTICS_WINDOW_MS,
  claimAutoDiagnosticsSend,
  claimManualDiagnosticsSend,
  completeAutoDiagnosticsSend,
  isAutoDiagnosticsEnabled,
  listPendingAutoDiagnosticsNotices,
  normalizeAutoDiagnosticsFailureCode,
  readAutoDiagnosticsState,
  resolveAutoDiagnosticsStateFile,
  setAutoDiagnosticsEnabled,
} from "./autoDiagnosticsStore";

const dirs: string[] = [];

function stateFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-auto-diagnostics-"));
  dirs.push(dir);
  return resolveAutoDiagnosticsStateFile(dir, {});
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const T0 = Date.parse("2026-08-19T10:00:00.000Z");

describe("auto diagnostics budget", () => {
  it("defaults to on for a machine that has never auto-sent", () => {
    const filePath = stateFile();
    expect(isAutoDiagnosticsEnabled(filePath)).toBe(true);
    expect(readAutoDiagnosticsState(filePath, { now: () => T0 })).toEqual({
      enabled: true,
      sendsInWindow: 0,
      limit: 3,
      manualSendsInWindow: 0,
      manualLimit: 5,
    });
  });

  it("allows one send per failure code per day and three in total", () => {
    const filePath = stateFile();
    const claim = (failureCode: string, atMs: number) =>
      claimAutoDiagnosticsSend({ filePath, failureCode, source: "desktop", now: () => atMs });

    expect(claim("disk_full", T0).allowed).toBe(true);
    // Same failure again, minutes later: the user is told about a problem once.
    expect(claim("disk_full", T0 + 60_000)).toEqual({ allowed: false, reason: "code_limit" });
    expect(claim("db_integrity", T0 + 60_000).allowed).toBe(true);
    expect(claim("renderer_crash", T0 + 120_000).allowed).toBe(true);
    // Fourth distinct failure in the same day: the daily ceiling, not the code.
    expect(claim("update_service", T0 + 180_000)).toEqual({ allowed: false, reason: "daily_limit" });
  });

  it("keeps the budget across restarts and releases it when the window rolls", () => {
    const filePath = stateFile();
    const claim = (failureCode: string, atMs: number) =>
      claimAutoDiagnosticsSend({ filePath, failureCode, source: "desktop", now: () => atMs });

    expect(claim("disk_full", T0).allowed).toBe(true);
    expect(claim("db_integrity", T0).allowed).toBe(true);
    expect(claim("renderer_crash", T0).allowed).toBe(true);

    // A fresh process reads the same file: the ledger is the file, not memory.
    expect(claim("update_health", T0 + 60_000)).toEqual({ allowed: false, reason: "daily_limit" });
    expect(readAutoDiagnosticsState(filePath, { now: () => T0 }).sendsInWindow).toBe(3);

    const nextDay = T0 + AUTO_DIAGNOSTICS_WINDOW_MS + 1;
    expect(claim("disk_full", nextDay).allowed).toBe(true);
    expect(readAutoDiagnosticsState(filePath, { now: () => nextDay }).sendsInWindow).toBe(1);
  });

  it("refuses every send while the setting is off, and resumes when it is back on", () => {
    const filePath = stateFile();
    setAutoDiagnosticsEnabled(filePath, false, { now: () => T0 });
    expect(isAutoDiagnosticsEnabled(filePath)).toBe(false);
    expect(
      claimAutoDiagnosticsSend({ filePath, failureCode: "disk_full", source: "desktop", now: () => T0 }),
    ).toEqual({ allowed: false, reason: "disabled" });

    setAutoDiagnosticsEnabled(filePath, true, { now: () => T0 });
    expect(
      claimAutoDiagnosticsSend({ filePath, failureCode: "disk_full", source: "desktop", now: () => T0 }).allowed,
    ).toBe(true);
  });

  it("treats an unreadable ledger as spent rather than as untouched", () => {
    const filePath = stateFile();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "{ this is not json", "utf8");
    // Forgiving a garbled counter is the same as not keeping one.
    expect(
      claimAutoDiagnosticsSend({ filePath, failureCode: "disk_full", source: "desktop", now: () => T0 }),
    ).toEqual({ allowed: false, reason: "state_unavailable" });
  });

  it("fails closed while another process holds the lock", () => {
    const filePath = stateFile();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.mkdirSync(`${filePath}.lock`);
    // Held right now on the same clock the claim reads, so it is not stale.
    fs.utimesSync(`${filePath}.lock`, T0 / 1_000, T0 / 1_000);
    expect(
      claimAutoDiagnosticsSend({ filePath, failureCode: "disk_full", source: "desktop", now: () => T0 }),
    ).toEqual({ allowed: false, reason: "state_unavailable" });
  });

  it("waits out a lock the holder releases instead of dropping the write", () => {
    // The lock used to be one shot: a holder that released microseconds later
    // still cost the caller its whole operation. Simulated by releasing on the
    // second `now()` read, which is the retry loop's own tick.
    const filePath = stateFile();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const lockPath = `${filePath}.lock`;
    fs.mkdirSync(lockPath);
    fs.utimesSync(lockPath, T0 / 1_000, T0 / 1_000);
    let reads = 0;
    const now = () => {
      reads += 1;
      if (reads === 1) fs.rmdirSync(lockPath);
      return T0;
    };

    expect(
      claimAutoDiagnosticsSend({ filePath, failureCode: "disk_full", source: "desktop", now }).allowed,
    ).toBe(true);
  });

  it("lands a contended withdrawal of consent without eating the ledger", () => {
    const filePath = stateFile();
    const claim = claimAutoDiagnosticsSend({
      filePath,
      failureCode: "disk_full",
      source: "desktop",
      now: () => T0,
    });
    expect(claim.allowed).toBe(true);

    // Another process is holding the lock and does not let go inside the wait.
    const lockPath = `${filePath}.lock`;
    fs.mkdirSync(lockPath);
    fs.utimesSync(lockPath, T0 / 1_000, T0 / 1_000);

    // Consent is the one write that may not be dropped, so it still lands —
    // and it must not take the spend ledger down with it. The old fallback
    // wrote whatever it had read and could silently reset the day's count.
    expect(setAutoDiagnosticsEnabled(filePath, false, { now: () => T0 })).toBe(false);
    expect(readAutoDiagnosticsState(filePath, { now: () => T0 })).toEqual({
      enabled: false,
      sendsInWindow: 1,
      limit: 3,
      manualSendsInWindow: 0,
      manualLimit: 5,
    });
  });

  // Directory permissions are the lever here, and `chmod` is a no-op on
  // Windows; the behaviour it pins is platform-independent.
  it.skipIf(process.platform === "win32")("reports the state on disk when a toggle cannot be persisted at all", () => {
    const filePath = stateFile();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ version: 1, enabled: true }), "utf8");
    // Lock held AND the file itself unwritable: nothing can land. A consent
    // pane must not then render an "off" that is really on.
    const lockPath = `${filePath}.lock`;
    fs.mkdirSync(lockPath);
    fs.utimesSync(lockPath, T0 / 1_000, T0 / 1_000);
    fs.chmodSync(path.dirname(filePath), 0o500);
    try {
      expect(setAutoDiagnosticsEnabled(filePath, false, { now: () => T0 })).toBe(true);
    } finally {
      fs.chmodSync(path.dirname(filePath), 0o700);
    }
  });

  function recordPendingSend(
    filePath: string,
    failureCode: string,
    reference: string,
  ): void {
    const claim = claimAutoDiagnosticsSend({
      filePath,
      failureCode,
      source: "brain",
      now: () => T0,
    });
    expect(claim.allowed).toBe(true);
    if (!claim.allowed) return;
    completeAutoDiagnosticsSend({
      filePath,
      failureCode,
      atMs: claim.atMs,
      reportPath: "/tmp/report.md",
      reference,
      pending: true,
      now: () => T0,
    });
  }

  it("refuses to mark a send pending when nothing can ever acknowledge it", () => {
    // An ack names an upload reference. A pending entry without one could never
    // be retired, so it would be replayed to every renderer on every launch
    // forever — the one failure mode worse than a missed toast.
    for (const reference of [null, "", "   "]) {
      const filePath = stateFile();
      const claim = claimAutoDiagnosticsSend({
        filePath,
        failureCode: "snapshot_failed",
        source: "brain",
        now: () => T0,
      });
      expect(claim.allowed).toBe(true);
      if (!claim.allowed) return;
      completeAutoDiagnosticsSend({
        filePath,
        failureCode: "snapshot_failed",
        atMs: claim.atMs,
        reportPath: "/tmp/report.md",
        reference,
        pending: true,
        now: () => T0,
      });
      expect(listPendingAutoDiagnosticsNotices(filePath)).toEqual([]);
    }
  });

  it("keeps offering a brain-side send until a renderer says it showed it", () => {
    const filePath = stateFile();
    recordPendingSend(filePath, "snapshot_failed", "abcd1234");

    const notice = {
      failureCode: "snapshot_failed",
      reportPath: "/tmp/report.md",
      reference: "abcd1234",
    };
    expect(listPendingAutoDiagnosticsNotices(filePath)).toEqual([notice]);
    // Listing is not showing. Nothing has claimed to have put this on screen,
    // so it is still on offer — including to a window that opens later.
    expect(listPendingAutoDiagnosticsNotices(filePath)).toEqual([notice]);

    ackAutoDiagnosticsNotices(filePath, ["abcd1234"], { now: () => T0 });
    // Acknowledged means shown: the next launch must not toast it again.
    expect(listPendingAutoDiagnosticsNotices(filePath)).toEqual([]);
  });

  it("takes an acknowledgement from either window and ignores one for nothing", () => {
    const filePath = stateFile();
    recordPendingSend(filePath, "snapshot_failed", "abcd1234");
    recordPendingSend(filePath, "disk_full", "efgh5678");

    // Two windows both got the fast-path notice and both toasted it; the second
    // ack is a no-op rather than an error, and so is one for a send that never
    // existed or was already retired.
    ackAutoDiagnosticsNotices(filePath, ["abcd1234"], { now: () => T0 });
    ackAutoDiagnosticsNotices(filePath, ["abcd1234"], { now: () => T0 });
    ackAutoDiagnosticsNotices(filePath, ["nosuchref", ""], { now: () => T0 });

    expect(listPendingAutoDiagnosticsNotices(filePath)).toEqual([
      { failureCode: "disk_full", reportPath: "/tmp/report.md", reference: "efgh5678" },
    ]);
    ackAutoDiagnosticsNotices(filePath, ["efgh5678"], { now: () => T0 });
    expect(listPendingAutoDiagnosticsNotices(filePath)).toEqual([]);
  });
});

describe("manual diagnostics budget", () => {
  const claimManual = (filePath: string, atMs: number) =>
    claimManualDiagnosticsSend({ filePath, source: "desktop", now: () => atMs });
  const claimAuto = (filePath: string, failureCode: string, atMs: number) =>
    claimAutoDiagnosticsSend({ filePath, failureCode, source: "desktop", now: () => atMs });

  it("allows five sends a day and then refuses, in the user's own words", () => {
    const filePath = stateFile();
    for (let i = 0; i < 5; i += 1) {
      expect(claimManual(filePath, T0 + i * 60_000).allowed).toBe(true);
    }
    expect(claimManual(filePath, T0 + 300_000)).toEqual({ allowed: false, reason: "daily_limit" });
    // And it comes back when the window rolls, rather than being spent forever.
    expect(claimManual(filePath, T0 + AUTO_DIAGNOSTICS_WINDOW_MS + 1).allowed).toBe(true);
  });

  it("does not spend the automatic budget, and is not spent by it", () => {
    const filePath = stateFile();

    // A user pressing the button five times must not silence the automatic
    // reports that would explain the failure they are reporting.
    for (let i = 0; i < 5; i += 1) claimManual(filePath, T0 + i * 60_000);
    expect(claimAuto(filePath, "disk_full", T0 + 400_000).allowed).toBe(true);
    expect(claimAuto(filePath, "db_integrity", T0 + 410_000).allowed).toBe(true);
    expect(claimAuto(filePath, "renderer_crash", T0 + 420_000).allowed).toBe(true);
    expect(claimAuto(filePath, "update_service", T0 + 430_000))
      .toEqual({ allowed: false, reason: "daily_limit" });

    // And the reverse: a machine that has burned its three automatic sends must
    // not lock the user out of asking for help.
    const other = stateFile();
    claimAuto(other, "disk_full", T0);
    claimAuto(other, "db_integrity", T0 + 1_000);
    claimAuto(other, "renderer_crash", T0 + 2_000);
    expect(claimAuto(other, "update_service", T0 + 3_000))
      .toEqual({ allowed: false, reason: "daily_limit" });
    expect(claimManual(other, T0 + 4_000).allowed).toBe(true);
  });

  it("counts the two budgets apart in the settings view", () => {
    const filePath = stateFile();
    claimAuto(filePath, "disk_full", T0);
    claimManual(filePath, T0 + 1_000);
    claimManual(filePath, T0 + 2_000);

    expect(readAutoDiagnosticsState(filePath, { now: () => T0 + 3_000 })).toEqual({
      enabled: true,
      sendsInWindow: 1,
      limit: 3,
      manualSendsInWindow: 2,
      manualLimit: 5,
    });
  });

  it("sends even when automatic sharing is switched off", () => {
    const filePath = stateFile();
    setAutoDiagnosticsEnabled(filePath, false, { now: () => T0 });

    // The toggle governs what ADE does BY ITSELF. A deliberate click is not
    // that, and refusing it would leave this user unable to report anything.
    expect(claimManual(filePath, T0 + 1_000).allowed).toBe(true);
    expect(claimAuto(filePath, "disk_full", T0 + 2_000))
      .toEqual({ allowed: false, reason: "disabled" });
    // ...and asking never flips the setting back on.
    expect(isAutoDiagnosticsEnabled(filePath)).toBe(false);
  });

  it("only annotates an entry of the kind that was claimed", () => {
    const filePath = stateFile();
    expect(claimManual(filePath, T0).allowed).toBe(true);
    const complete = (kind: "auto" | "manual") =>
      completeAutoDiagnosticsSend({
        filePath,
        failureCode: "user_requested",
        atMs: T0,
        reportPath: "/tmp/report.md",
        reference: "abcd1234",
        pending: true,
        kind,
        now: () => T0,
      });

    // The default kind is `auto`, so an automatic completion must not land on a
    // manual reservation that happens to share its code and timestamp.
    complete("auto");
    expect(listPendingAutoDiagnosticsNotices(filePath)).toEqual([]);
    complete("manual");
    expect(listPendingAutoDiagnosticsNotices(filePath)).toEqual([
      { failureCode: "user_requested", reportPath: "/tmp/report.md", reference: "abcd1234" },
    ]);
  });
});

describe("normalizeAutoDiagnosticsFailureCode", () => {
  it("passes the codes ADE actually produces", () => {
    for (const code of ["disk_full", "brain_crash_looping", "snapshot_failed", "update_service"]) {
      expect(normalizeAutoDiagnosticsFailureCode(code)).toBe(code);
    }
  });

  it("coerces or rejects anything that would not survive the server", () => {
    expect(normalizeAutoDiagnosticsFailureCode("Disk Full")).toBe("disk_full");
    expect(normalizeAutoDiagnosticsFailureCode("  ")).toBeNull();
    expect(normalizeAutoDiagnosticsFailureCode("123")).toBeNull();
    expect(normalizeAutoDiagnosticsFailureCode(null)).toBeNull();
    expect(normalizeAutoDiagnosticsFailureCode("a".repeat(80))).toBe("a".repeat(48));
  });
});
