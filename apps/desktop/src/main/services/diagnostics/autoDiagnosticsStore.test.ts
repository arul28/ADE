import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ackAutoDiagnosticsNotices,
  AUTO_DIAGNOSTICS_WINDOW_MS,
  claimAutoDiagnosticsSend,
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
