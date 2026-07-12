import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  toAdeRecoveryErrorCode,
  type AdeLastFailureReport,
  type AdeRecoveryErrorCode,
} from "../../../shared/types/recovery";
import { readValidJson, writeFileAtomic } from "../state/durableFile";

const MESSAGE_MAX_BYTES = 2 * 1024;
const DETAIL_MAX_BYTES = 8 * 1024;
const CRASH_LOOP_WINDOW_MS = 5 * 60 * 1_000;

export type LastFailureTarget =
  | { kind: "machine"; env?: NodeJS.ProcessEnv }
  | { kind: "project"; projectRoot: string };

export type LastFailureInput = {
  code: AdeRecoveryErrorCode;
  message: string;
  detail?: string;
  projectRoot?: string;
  component: AdeLastFailureReport["component"];
  at?: string;
};

function machineAdeDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.ADE_HOME?.trim();
  return explicit ? path.resolve(explicit) : path.join(os.homedir(), ".ade");
}

export function lastFailurePathForMachine(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(machineAdeDir(env), "runtime", "last-failure.json");
}

export function lastFailurePathForProject(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), ".ade", "runtime", "last-failure.json");
}

function pathForTarget(target: LastFailureTarget): string {
  return target.kind === "machine"
    ? lastFailurePathForMachine(target.env)
    : lastFailurePathForProject(target.projectRoot);
}

function previousPath(currentPath: string): string {
  return path.join(path.dirname(currentPath), "last-failure.prev.json");
}

function boundUtf8(value: string, maxBytes: number): string {
  const normalized = value.replace(/\0/g, "");
  const encoded = Buffer.from(normalized, "utf8");
  if (encoded.byteLength <= maxBytes) return normalized;
  return encoded.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD$/, "");
}

function plainMessage(value: string): string {
  return boundUtf8(value.replace(/[\r\n\t]+/g, " ").replace(/[\u0001-\u001f\u007f]/g, " ").trim(), MESSAGE_MAX_BYTES);
}

function isLastFailureReport(value: unknown): value is AdeLastFailureReport {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const report = value as Partial<AdeLastFailureReport>;
  return report.version === 1
    && toAdeRecoveryErrorCode(report.code) !== null
    && typeof report.message === "string"
    && Buffer.byteLength(report.message, "utf8") <= MESSAGE_MAX_BYTES
    && typeof report.at === "string"
    && typeof report.firstAt === "string"
    && Number.isInteger(report.count)
    && (report.count ?? 0) > 0
    && ["brain_startup", "project_db_open", "sync_host", "desktop_repair"].includes(report.component ?? "")
    && (report.detail === undefined || (
      typeof report.detail === "string"
      && Buffer.byteLength(report.detail, "utf8") <= DETAIL_MAX_BYTES
    ))
    && (report.projectRoot === undefined || typeof report.projectRoot === "string");
}

function readReportPath(filePath: string): AdeLastFailureReport | null {
  return readValidJson(filePath, isLastFailureReport);
}

function sameSignature(left: AdeLastFailureReport, right: LastFailureInput): boolean {
  const rightProjectRoot = right.projectRoot ? path.resolve(right.projectRoot) : "";
  return left.code === right.code
    && left.component === right.component
    && (left.projectRoot ?? "") === rightProjectRoot;
}

function reportWriteFailure(action: string, error: unknown): void {
  try {
    process.stderr.write(`ADE could not ${action} the last-failure report: ${error instanceof Error ? error.message : String(error)}\n`);
  } catch {
    // Diagnostics are best effort too.
  }
}

function moveCurrentToPrevious(currentPath: string): void {
  const prevPath = previousPath(currentPath);
  fs.rmSync(prevPath, { force: true });
  fs.renameSync(currentPath, prevPath);
}

export function recordLastFailure(
  target: LastFailureTarget,
  input: LastFailureInput,
): AdeLastFailureReport | null {
  const currentPath = pathForTarget(target);
  try {
    fs.mkdirSync(path.dirname(currentPath), { recursive: true, mode: 0o700 });
    const existing = readReportPath(currentPath);
    const at = input.at ?? new Date().toISOString();
    const repeated = existing != null && sameSignature(existing, input);
    if (existing && !repeated) moveCurrentToPrevious(currentPath);
    const report: AdeLastFailureReport = {
      version: 1,
      code: input.code,
      message: plainMessage(input.message) || "ADE recovery failed.",
      ...(input.detail ? { detail: boundUtf8(input.detail, DETAIL_MAX_BYTES) } : {}),
      at,
      ...(input.projectRoot ? { projectRoot: path.resolve(input.projectRoot) } : {}),
      component: input.component,
      count: repeated ? existing.count + 1 : 1,
      firstAt: repeated ? existing.firstAt : at,
    };
    writeFileAtomic(currentPath, `${JSON.stringify(report, null, 2)}\n`, { fsync: true });
    return report;
  } catch (error) {
    reportWriteFailure("write", error);
    return null;
  }
}

export function readLastFailure(target: LastFailureTarget): AdeLastFailureReport | null {
  return readReportPath(pathForTarget(target));
}

export function clearLastFailure(target: LastFailureTarget): void {
  const currentPath = pathForTarget(target);
  if (!fs.existsSync(currentPath)) return;
  try {
    moveCurrentToPrevious(currentPath);
  } catch (error) {
    reportWriteFailure("clear", error);
  }
}

export function computeStartupBackoffMs(
  report: AdeLastFailureReport | null,
  now: number | Date = Date.now(),
): number {
  if (!report || report.count < 3) return 0;
  const nowMs = now instanceof Date ? now.getTime() : now;
  const firstAtMs = Date.parse(report.firstAt);
  if (!Number.isFinite(firstAtMs) || nowMs - firstAtMs < 0 || nowMs - firstAtMs > CRASH_LOOP_WINDOW_MS) {
    return 0;
  }
  return Math.min((report.count - 2) * 10_000, 60_000);
}
