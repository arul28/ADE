import path from "node:path";

import { resolveMachineAdeLayout } from "../../../../../ade-cli/src/services/projects/machineLayout";
import { createFileLogger, type FileLoggerOptions, type Logger } from "./logger";

/**
 * The desktop main process's MACHINE-scoped log.
 *
 * The only structured sink main had was `createFileLogger(<project>/.ade/
 * transcripts/logs/main.jsonl)`, built inside the project-open paths. Two
 * consequences, both observed on a real machine: everything before a project
 * opened had nowhere durable to go (which is why the early-startup lines were
 * `console.log("[main] …")` — the comment there said the structured logger may
 * not be ready yet, and it was right), and machine-level facts like the `ade`
 * CLI auto-install outcome were filed under whichever project happened to open,
 * so the same computer told a different story depending on what was open. A
 * user whose app failed before opening a project produced a diagnostic report
 * with no main-process log at all.
 *
 * It lives in the machine's `~/.ade/runtime`, next to `brain.jsonl` and
 * `account-trust.jsonl`, and NOT under `app.getPath("userData")`. The deciding
 * question is who can read it: `resolveMachineAdeLayout` is the same resolver
 * `ade report-issue` uses, so a headless report — collected on the machine
 * where the desktop will not start, which is the whole point — finds this file
 * by construction and honours the same `ADE_HOME`, so each channel keeps its
 * own. Electron's `userData` is a per-platform, per-productName directory the
 * CLI would have to guess at, which is why `local-runtime.jsonl` and
 * `ade-update.jsonl` are still desktop-only sources in a report.
 *
 * Size is the shared file logger's problem, deliberately: same 10 MiB rotation
 * to `desktop-main.1.jsonl` that bounds `brain.jsonl`.
 */
export const MACHINE_MAIN_LOG_FILE_NAME = "desktop-main.jsonl";

export function machineMainLogPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveMachineAdeLayout(env).runtimeDir, MACHINE_MAIN_LOG_FILE_NAME);
}

/**
 * Never `null`, so no caller has to branch on "did the log exist" on the path
 * that runs before the app does. A machine whose `~/.ade` cannot even be
 * resolved still starts ADE.
 */
const NOOP_LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  flushSync: () => {},
};

export function createMachineMainLogger(
  options: { env?: NodeJS.ProcessEnv; fileLogger?: FileLoggerOptions } = {},
): Logger {
  try {
    return createFileLogger(machineMainLogPath(options.env), options.fileLogger);
  } catch {
    // `resolveMachineAdeLayout` reads the environment and, on Windows, the
    // user identity; a box where that throws must still boot. Writes are
    // already best-effort inside the file logger itself.
    return NOOP_LOGGER;
  }
}

let sharedMachineMainLogger: Logger | null = null;

export function getMachineMainLogger(): Logger {
  if (!sharedMachineMainLogger) sharedMachineMainLogger = createMachineMainLogger();
  return sharedMachineMainLogger;
}

/** Test seam: the shared logger caches the path it resolved at first use. */
export function resetMachineMainLoggerForTests(): void {
  sharedMachineMainLogger = null;
}

type MachineLogLevel = "debug" | "info" | "warn" | "error";

const CONSOLE_METHOD_BY_LEVEL: Record<MachineLogLevel, "debug" | "log" | "warn" | "error"> = {
  debug: "debug",
  info: "log",
  warn: "warn",
  error: "error",
};

/**
 * One machine-scoped event: durable in `desktop-main.jsonl` AND on stdout.
 *
 * The console half is not vestigial. A terminal-launched app shows it to the
 * person watching, and the pathological case this log exists to diagnose — an
 * old plist that boots the whole desktop app as the background service — routes
 * main's stdout into `~/.ade/runtime/launchd.out.log`, which a report also
 * collects. Two independent copies of a startup line cost nothing and the
 * incident that motivated this file turned on exactly such a line.
 */
export function logMachineEvent(
  level: MachineLogLevel,
  event: string,
  fields?: Record<string, unknown>,
): void {
  try {
    getMachineMainLogger()[level](event, fields);
  } catch {
    // A log sink is never worth a failed launch.
  }
  try {
    // Resolved per call, not captured at module load: this runs before the app
    // does, and whatever `console` is at that moment is what gets the line.
    console[CONSOLE_METHOD_BY_LEVEL[level]](`[main] ${event}`, fields ?? "");
  } catch {
    // stdout can be gone entirely (detached GUI launch, closed terminal).
  }
}

/**
 * Drains still-queued lines to disk. Writes batch onto an async stream, so a
 * caller about to end the process must call this or the records explaining the
 * exit die with it — see `Logger.flushSync`. Deliberately NOT called after
 * every line: `flushSync` skips rotation by design, so a logger that only ever
 * flushed that way would never rotate.
 */
export function flushMachineMainLog(): void {
  try {
    getMachineMainLogger().flushSync?.();
  } catch {
    // Same contract as the writes.
  }
}
