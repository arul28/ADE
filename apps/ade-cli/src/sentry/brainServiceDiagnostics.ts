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
 * service's logs as `brain-service-logs.txt` on the events that get files.
 */
import fs from "node:fs";
import path from "node:path";
import {
  registerSentryDiagnosticAttachment,
  registerSentryDiagnosticContext,
  type DiagnosticAttachment,
  type DiagnosticEvent,
} from "../../../desktop/src/shared/sentry/diagnostics";
import { isPidAlive, resolveRuntimeServiceName } from "../serviceManager/common";
import {
  resolveWindowsBrainOutputLogPath,
  resolveWindowsServicePidPath,
  resolveWindowsSupervisorLogPath,
} from "../serviceManager/installWindows";
import { readWindowsServicePidRecord } from "../serviceManager/windowsSupervisor";
import { resolveMachineAdeLayout } from "../services/projects/machineLayout";
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

/** The service's own logs, newest part of each, as one file. Null when there are none. */
function brainServiceLogsAttachment(env: NodeJS.ProcessEnv = process.env): DiagnosticAttachment | null {
  const { runtimeDir } = resolveMachineAdeLayout(env);
  const files: Array<{ label: string; filePath: string; maxBytes: number }> = [];
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
  const sections = files.flatMap(({ label, filePath, maxBytes }) => {
    const tail = readFileTail(filePath, maxBytes);
    return tail ? [`===== ${label} (${filePath}) =====\n${tail}`] : [];
  });
  return sections.length > 0 ? { filename: "brain-service-logs.txt", data: sections.join("\n\n") } : null;
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

function readStateFile(filePath: string): Record<string, unknown> | null {
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
