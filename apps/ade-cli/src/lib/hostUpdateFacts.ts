import fs from "node:fs";
import path from "node:path";
import { compareUpdateVersions } from "../../../desktop/src/shared/updateVersions";
import { readUpdateBlockHolders } from "../../../desktop/src/shared/updateBlock";
import type { SyncHostUpdateBlock, SyncPeerMetadata } from "../../../desktop/src/shared/types/sync";
import { readInstalledDesktopAppVersion } from "../../../desktop/src/main/services/native/nativeHelperPaths";
import { resolveMachineAdeLayout } from "../services/projects/machineLayout";

/**
 * What a brain tells other devices about its last update, in every handshake
 * (`runtimeInfo` for desktops, the sync hello's `brain` metadata for phones):
 *
 * - `startedAgoMs`: how long ago this brain started, by the wall clock. A
 *   start after the update was sent means the brain restarted for it. Not
 *   `process.uptime()`: on macOS and Linux that clock stops while the
 *   computer sleeps, so a laptop that slept would look freshly restarted.
 * - `lastUpdateBlock`: what kept the last Windows update from installing.
 *   The installer writes `<ADE home>/runtime/update-blocked.json` when the old
 *   uninstaller fails (`apps/desktop/build/ade-update-holders.ps1`): the
 *   processes that held files in the install folder open.
 *
 * Both are ages, not times: the reader's clock is another machine's.
 */

/** Read when this module loads, at brain start, before any sleep. */
const brainStartedAtWallMs = Date.now() - Math.round(process.uptime() * 1_000);

export function brainStartedAgoMs(nowMs = Date.now()): number {
  return Math.max(0, nowMs - brainStartedAtWallMs);
}

/** Older than this, the block says nothing about the update in front of you. */
const MAX_REPORT_AGE_MS = 6 * 60 * 60_000;
/** Hellos and status ticks come often; the file changes once per failed update. */
const REFRESH_INTERVAL_MS = 30_000;

type Warn = (event: string, meta: Record<string, unknown>) => void;

/**
 * The report in the installer's file (already JSON-parsed), or null when there
 * is none worth showing: malformed, old, or for a version the machine has
 * installed since (`installedVersion` at or past the one that was blocked).
 * `installedVersion` is asked only when there is a report, so a hello with
 * nothing to report reads no app version.
 */
export function parseUpdateBlockedReport(
  raw: unknown,
  nowMs: number,
  installedVersion: () => string | null,
): SyncHostUpdateBlock | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const at = typeof record.at === "string" ? Date.parse(record.at) : Number.NaN;
  if (!Number.isFinite(at)) return null;
  const ageMs = Math.max(0, nowMs - at);
  if (ageMs > MAX_REPORT_AGE_MS) return null;
  const targetVersion = typeof record.targetVersion === "string" && record.targetVersion.trim()
    ? record.targetVersion.trim()
    : null;
  const installed = targetVersion ? installedVersion() : null;
  if (targetVersion && installed && compareUpdateVersions(installed, targetVersion) >= 0) return null;
  return { ageMs, targetVersion, holders: readUpdateBlockHolders(record.holders) };
}

/**
 * Reads the report without touching the disk on the event loop: `read`
 * answers from the last read and starts the next one at most every 30 s
 * (never two at once). The first read starts when the reader is made. The
 * file is parsed once per change; a file that cannot be read or parsed is
 * logged once.
 */
export function createUpdateBlockedReader(runtimeDir: string, warn?: Warn): {
  read(nowMs: number, installedVersion: () => string | null): SyncHostUpdateBlock | null;
} {
  const filePath = path.join(runtimeDir, "update-blocked.json");
  let text: string | null = null;
  let parsed: unknown = null;
  let reading = false;
  let lastReadAt = Number.NEGATIVE_INFINITY;
  let warnedRead = false;
  const take = (value: string | null) => {
    if (value === text) return;
    text = value;
    parsed = null;
    if (value == null) return;
    try {
      parsed = JSON.parse(value.replace(/^\uFEFF/, ""));
    } catch (error) {
      warn?.("brain.update_block_unreadable", { reason: "json", message: error instanceof Error ? error.message : String(error) });
    }
  };
  const refresh = (nowMs: number) => {
    if (reading || nowMs - lastReadAt < REFRESH_INTERVAL_MS) return;
    reading = true;
    lastReadAt = nowMs;
    fs.promises.readFile(filePath, "utf8")
      .then(take, (error: NodeJS.ErrnoException) => {
        if (error?.code === "ENOENT") {
          take(null);
          return;
        }
        // Kept: the last good report. Said once, so a file held by a scan
        // does not log on every tick.
        if (!warnedRead) warn?.("brain.update_block_unreadable", { reason: "read", code: error?.code ?? null });
        warnedRead = true;
      })
      .finally(() => {
        reading = false;
      });
  };
  refresh(Date.now());
  return {
    read(nowMs, installedVersion) {
      refresh(nowMs);
      return parseUpdateBlockedReport(parsed, nowMs, installedVersion);
    },
  };
}

let machineReader: ReturnType<typeof createUpdateBlockedReader> | null = null;

/**
 * Starts reading this machine's report at brain start, so the handshakes right
 * after a failed update (the ones that matter) already carry it. Only the
 * Windows installer writes one; elsewhere this does nothing.
 */
export function primeMachineUpdateBlock(warn?: Warn): void {
  if (process.platform !== "win32" || machineReader) return;
  machineReader = createUpdateBlockedReader(path.join(resolveMachineAdeLayout().adeDir, "runtime"), warn);
}

/** This machine's report for a handshake; always null off Windows. */
export function readMachineUpdateBlock(installedVersion: () => string | null): SyncHostUpdateBlock | null {
  if (process.platform !== "win32") return null;
  primeMachineUpdateBlock();
  return machineReader?.read(Date.now(), installedVersion) ?? null;
}

/** The two facts for a sync hello's `brain` metadata. */
export function hostUpdateFacts(): Pick<SyncPeerMetadata, "startedAgoMs" | "lastUpdateBlock"> {
  const block = readMachineUpdateBlock(() => readInstalledDesktopAppVersion());
  return {
    startedAgoMs: brainStartedAgoMs(),
    ...(block ? { lastUpdateBlock: block } : {}),
  };
}
