import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AUTO_DIAGNOSTICS_WINDOW_MS,
  claimAutoDiagnosticsSend,
  completeAutoDiagnosticsSend,
  drainAutoDiagnosticsNotices,
  isAutoDiagnosticsEnabled,
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

  it("hands a brain-side send to the desktop exactly once", () => {
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
      reference: "abcd1234",
      pending: true,
      now: () => T0,
    });

    expect(drainAutoDiagnosticsNotices(filePath, { now: () => T0 })).toEqual([
      { failureCode: "snapshot_failed", reportPath: "/tmp/report.md", reference: "abcd1234" },
    ]);
    // Drained means shown: a second window must not toast the same report.
    expect(drainAutoDiagnosticsNotices(filePath, { now: () => T0 })).toEqual([]);
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
