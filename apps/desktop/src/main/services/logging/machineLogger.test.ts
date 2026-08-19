import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createMachineMainLogger,
  flushMachineMainLog,
  getMachineMainLogger,
  logMachineEvent,
  machineMainLogPath,
  resetMachineMainLoggerForTests,
} from "./machineLogger";

/**
 * The main process had no durable log until a project opened, so everything
 * before that — the `ade://` claim, the single-instance lock, the CLI
 * auto-install outcome — either vanished or was filed under whichever project
 * happened to open. These cover the properties that fix depends on.
 */

const tempDirs: string[] = [];

function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-machine-log-"));
  tempDirs.push(dir);
  return dir;
}

const ORIGINAL_ADE_HOME = process.env.ADE_HOME;

beforeEach(() => {
  resetMachineMainLoggerForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetMachineMainLoggerForTests();
  if (ORIGINAL_ADE_HOME === undefined) delete process.env.ADE_HOME;
  else process.env.ADE_HOME = ORIGINAL_ADE_HOME;
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("machineMainLogPath", () => {
  // The whole point of the location: a headless `ade report-issue` resolves it
  // with the same `resolveMachineAdeLayout` the collector already uses, on a
  // machine where no project has ever been opened. An `app.getPath("userData")`
  // path would be a per-platform, per-productName directory the CLI must guess.
  it("sits in the machine's runtime dir, beside brain.jsonl", () => {
    const adeHome = path.join(tempHome(), ".ade");

    expect(machineMainLogPath({ ADE_HOME: adeHome })).toBe(
      path.join(adeHome, "runtime", "desktop-main.jsonl"),
    );
  });

  // Each packaged channel gets its own ADE home; two of them must not append to
  // one file and read as a single machine's story.
  it("follows ADE_HOME, so channels do not share one log", () => {
    const stable = path.join(tempHome(), ".ade");
    const beta = path.join(tempHome(), ".ade-beta");

    expect(machineMainLogPath({ ADE_HOME: stable })).not.toBe(
      machineMainLogPath({ ADE_HOME: beta }),
    );
  });
});

describe("logMachineEvent", () => {
  it("writes machine events to the machine log and not to any project", () => {
    const home = tempHome();
    process.env.ADE_HOME = path.join(home, ".ade");
    const projectLogsDir = path.join(home, "project", ".ade", "transcripts", "logs");
    fs.mkdirSync(projectLogsDir, { recursive: true });
    vi.spyOn(console, "log").mockImplementation(() => {});

    logMachineEvent("info", "ade_cli.auto_install", { ok: true });
    flushMachineMainLog();

    const written = fs.readFileSync(machineMainLogPath(), "utf8");
    expect(JSON.parse(written.trim())).toMatchObject({
      level: "info",
      event: "ade_cli.auto_install",
      meta: { ok: true },
    });
    expect(fs.existsSync(path.join(projectLogsDir, "main.jsonl"))).toBe(false);
  });

  // Not vestigial: a terminal-launched app shows it to whoever is watching, and
  // an old plist that boots the desktop app as the background service routes
  // main's stdout into launchd.out.log, which a report also collects.
  it("still mirrors to the console", () => {
    process.env.ADE_HOME = path.join(tempHome(), ".ade");
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    logMachineEvent("warn", "deeplink.single_instance.lock_lost", { claimAsDefault: true });

    expect(consoleSpy).toHaveBeenCalledWith(
      "[main] deeplink.single_instance.lock_lost",
      { claimAsDefault: true },
    );
  });

  // This runs before the app exists. A log sink that can throw would turn a
  // broken `~/.ade` into an app that will not start at all.
  it("never throws, even when the log cannot be written", () => {
    // A file where the runtime DIRECTORY has to be: mkdir fails for every write.
    const home = tempHome();
    const adeHome = path.join(home, ".ade");
    fs.mkdirSync(adeHome, { recursive: true });
    fs.writeFileSync(path.join(adeHome, "runtime"), "not a directory", "utf8");
    process.env.ADE_HOME = adeHome;
    vi.spyOn(console, "log").mockImplementation(() => {});

    expect(() => {
      logMachineEvent("info", "desktop.main_started", { pid: 1 });
      flushMachineMainLog();
    }).not.toThrow();
  });

  // A detached GUI launch can leave the process with no usable stdout at all.
  it("survives a console that throws", () => {
    process.env.ADE_HOME = path.join(tempHome(), ".ade");
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {
      throw new Error("no console");
    });

    expect(() => logMachineEvent("error", "desktop.main_started")).not.toThrow();
    expect(consoleErrorSpy).toHaveBeenCalled();
    flushMachineMainLog();
    expect(fs.readFileSync(machineMainLogPath(), "utf8")).toContain("desktop.main_started");
  });

  it("reuses one logger across calls", () => {
    process.env.ADE_HOME = path.join(tempHome(), ".ade");

    expect(getMachineMainLogger()).toBe(getMachineMainLogger());
  });
});

describe("rotation", () => {
  // Bounded by the shared file logger's scheme, the same one that bounds
  // brain.jsonl: at the cap the live file is renamed to `.1.jsonl`. A log that
  // exists from process start on every launch may not grow without limit.
  it("rotates to desktop-main.1.jsonl at the size cap", async () => {
    const adeHome = path.join(tempHome(), ".ade");
    const logger = createMachineMainLogger({
      env: { ADE_HOME: adeHome },
      fileLogger: { maxFileBytes: 512, rotationCheckWriteInterval: 1, flushIntervalMs: 1 },
    });
    const logPath = machineMainLogPath({ ADE_HOME: adeHome });

    for (let index = 0; index < 40; index += 1) {
      logger.info("desktop.main_started", { index, padding: "x".repeat(64) });
      await new Promise((resolve) => setTimeout(resolve, 2));
    }

    expect(fs.existsSync(path.join(path.dirname(logPath), "desktop-main.1.jsonl"))).toBe(true);
    expect(fs.statSync(logPath).size).toBeLessThanOrEqual(512);
  });
});
