/**
 * What every Sentry report from this machine says about its background
 * service: the supervisor or service manager that starts the brain and starts
 * it again when it dies.
 *
 * A report about a brain that keeps restarting is only fixable with the
 * service's side of the story, and that side lives in files the brain's own
 * log never holds: how many times the supervisor restarted the brain and why
 * it last died, the brain's last output before it went, the last startup
 * failure, an update that was replacing it. Before this, reading them took
 * the user's disk.
 *
 * Main and the brain both register it (`shared/sentry/diagnostics.ts`): the
 * `brain_service` context on every event (a few small file reads), and the
 * service's logs as `brain-service-logs.txt` on the events that get files. The
 * desktop app's logs (`desktopLogsAttachment`) go only on a restart loop
 * report (`brainRestartLoop.ts`).
 */
import fs from "node:fs";
import path from "node:path";
import {
  registerSentryDiagnosticAttachment,
  registerSentryDiagnosticContext,
  type DiagnosticAttachment,
  type DiagnosticEvent,
} from "../../../desktop/src/shared/sentry/diagnostics";
import { MACHINE_MAIN_LOG_FILE_NAME } from "../../../desktop/src/main/services/logging/machineLogger";
import { isPidAlive, resolveRuntimeServiceName } from "../serviceManager/common";
import {
  resolveWindowsBrainOutputLogPath,
  resolveWindowsServicePidPath,
  resolveWindowsSupervisorLogPath,
} from "../serviceManager/installWindows";
import { readWindowsServicePidRecord } from "../serviceManager/windowsSupervisor";
import { brainLogPath, resolveMachineAdeLayout } from "../services/projects/machineLayout";
import { readBrainHeartbeat } from "../services/runtime/brainHeartbeat";

/** The state files are a few hundred bytes; anything far larger is not one of them. */
const STATE_FILE_MAX_BYTES = 64 * 1024;
const STATE_TEXT_MAX_CHARS = 500;

export function registerBrainServiceSentryDiagnostics(options: {
  /** Events this machine's service says nothing about (a call to another machine's brain). */
  skipFor?: (event: DiagnosticEvent) => boolean;
} = {}): void {
  registerSentryDiagnosticContext("brain_service", (event) =>
    (options.skipFor?.(event) ? null : brainServiceContext()));
  registerSentryDiagnosticAttachment("brain-service-logs", (event) =>
    (options.skipFor?.(event) ? null : brainServiceLogsAttachment()));
}

/**
 * The service as it stands at the moment of the report. On Windows the
 * supervisor's own record (restart count, last exit, next restart); on every
 * platform the brain's heartbeat, the last startup failure and the last update.
 */
function brainServiceContext(env: NodeJS.ProcessEnv = process.env, nowMs = Date.now()): Record<string, unknown> {
  const { runtimeDir } = resolveMachineAdeLayout(env);
  const context: Record<string, unknown> = { serviceName: resolveRuntimeServiceName(env) };
  if (process.platform === "win32") {
    const record = readWindowsServicePidRecord(resolveWindowsServicePidPath({ env }));
    context.supervisor = record
      ? {
        ...record,
        running: isPidAlive(record.supervisorPid),
        brainUptimeSec: record.runtimeStartedAtMs ? Math.round((nowMs - record.runtimeStartedAtMs) / 1000) : null,
      }
      : null;
  }
  const heartbeat = readBrainHeartbeat(runtimeDir);
  if (heartbeat) {
    context.heartbeat = {
      pid: heartbeat.pid,
      // A live pid with an old beat is a wedged brain, not a dead one.
      secondsSinceBeat: Math.round((nowMs - heartbeat.ts) / 1000),
      startedAt: new Date(heartbeat.startedAt).toISOString(),
    };
  }
  const failure = readStateFile(path.join(runtimeDir, "last-failure.json"));
  if (failure) {
    context.lastFailure = pick(failure, ["code", "component", "message", "detail", "at", "firstAt", "count"]);
  }
  const update = readStateFile(path.join(runtimeDir, "update-status.json"));
  if (update) context.lastUpdate = pick(update, ["state", "version", "updatedAt", "message"]);
  const installedApp = readStateFile(path.join(runtimeDir, "desktop-app.json"));
  if (installedApp) context.installedAppVersion = installedApp.version ?? null;
  return context;
}

type LogTailFile = { label: string; filePath: string; maxBytes: number };

/** The service's own logs, newest part of each, as one file. Null when there are none. */
function brainServiceLogsAttachment(env: NodeJS.ProcessEnv = process.env): DiagnosticAttachment | null {
  const { runtimeDir } = resolveMachineAdeLayout(env);
  const files: LogTailFile[] = [];
  if (process.platform === "win32") {
    files.push(
      { label: "Supervisor", filePath: resolveWindowsSupervisorLogPath({ env }), maxBytes: 32_000 },
      { label: "Brain output (stdout and stderr)", filePath: resolveWindowsBrainOutputLogPath({ env }), maxBytes: 64_000 },
    );
  } else {
    // launchd on macOS, the systemd unit on Linux (`renderSystemdUnit`).
    const manager = process.platform === "darwin" ? "launchd" : "systemd";
    files.push(
      // What the last trim kept (`copytruncateLogIfOversized`); absent until the first one.
      { label: `${manager} stderr, before the last trim`, filePath: path.join(runtimeDir, `${manager}.err.log.1`), maxBytes: 16_000 },
      { label: `${manager} stderr`, filePath: path.join(runtimeDir, `${manager}.err.log`), maxBytes: 64_000 },
      { label: `${manager} stdout`, filePath: path.join(runtimeDir, `${manager}.out.log`), maxBytes: 32_000 },
    );
  }
  // Each install, update and service removal, with how long it took.
  files.push({ label: "Install steps", filePath: path.join(runtimeDir, "install-steps.log"), maxBytes: 16_000 });
  return logTailsAttachment("brain-service-logs.txt", files);
}

/**
 * The desktop app's side of a brain that keeps restarting: its runtime log
 * (`local-runtime.jsonl`: every brain it started, replaced, repaired or
 * stopped) and its machine log (`desktop-main.jsonl`: each launch and quit).
 * On 2026-11-05 a Windows report showed two brains killed 3 s and 9 s after
 * they started, and nothing in it said by what. The runtime log is in
 * Electron's `userData`, which the app records in `desktop-app.json`; a
 * machine without the app (or with an app older than that record) sends the
 * machine log alone. Null when there is neither.
 */
export function desktopLogsAttachment(env: NodeJS.ProcessEnv = process.env): DiagnosticAttachment | null {
  const { runtimeDir } = resolveMachineAdeLayout(env);
  const userDataPath = readStateFile(path.join(runtimeDir, "desktop-app.json"))?.userDataPath;
  const files: LogTailFile[] = [];
  if (typeof userDataPath === "string" && userDataPath) {
    files.push({ label: "Desktop runtime log", filePath: path.join(userDataPath, "local-runtime.jsonl"), maxBytes: 128_000 });
  }
  files.push({ label: "Desktop machine log", filePath: path.join(runtimeDir, MACHINE_MAIN_LOG_FILE_NAME), maxBytes: 64_000 });
  return logTailsAttachment("desktop-logs.txt", files);
}

/**
 * The brain log on disk, which every brain on this ADE home writes. The log
 * tail a report carries by default is the reporting brain's own memory, so on
 * a restart loop it held only the brain that survived: on 2026-11-09 a Windows
 * report showed four brains exit with code 1 and no line from any of them.
 * This is their last words. Null when the file is absent or empty.
 */
export function brainLogAttachment(env: NodeJS.ProcessEnv = process.env): DiagnosticAttachment | null {
  const logPath = brainLogPath(resolveMachineAdeLayout(env));
  const { dir, name, ext } = path.parse(logPath);
  return logTailsAttachment("brain-log.txt", [
    // What the logger's last rotation kept: the earlier brains' lines when the
    // log rotated during the loop. Absent until the first rotation.
    { label: "Brain log, before the last rotation", filePath: path.join(dir, `${name}.1${ext}`), maxBytes: 64_000 },
    { label: "Brain log, all brains", filePath: logPath, maxBytes: 192_000 },
  ]);
}

/** The newest part of each file under its own heading, as one file. Null when every file is absent or empty. */
function logTailsAttachment(filename: string, files: readonly LogTailFile[]): DiagnosticAttachment | null {
  const sections = files.flatMap(({ label, filePath, maxBytes }) => {
    const tail = readFileTail(filePath, maxBytes);
    return tail ? [`===== ${label} (${filePath}) =====\n${tail}`] : [];
  });
  return sections.length > 0 ? { filename, data: sections.join("\n\n") } : null;
}

/**
 * The newest `maxBytes` of a file, starting at a whole line. Reads only those
 * bytes. Null when the file is absent, empty or unreadable.
 */
export function readFileTail(filePath: string, maxBytes: number): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    if (length <= 0) return null;
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    const text = buffer.toString("utf8");
    // A read that starts mid-file starts mid-line: drop that partial line.
    const data = length < size ? text.slice(text.indexOf("\n") + 1) : text;
    return data || null;
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/** A small JSON object from a runtime state file (size-capped, BOM stripped), or null. */
export function readStateFile(filePath: string): Record<string, unknown> | null {
  try {
    if (fs.statSync(filePath).size > STATE_FILE_MAX_BYTES) return null;
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^﻿/, ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function pick(record: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of keys) {
    const value = record[key];
    if (value === undefined || value === null) continue;
    picked[key] = typeof value === "string" ? value.slice(0, STATE_TEXT_MAX_CHARS) : value;
  }
  return picked;
}
