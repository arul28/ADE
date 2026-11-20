import fs from "node:fs";
import path from "node:path";
import { compareUpdateVersions } from "../../../desktop/src/shared/updateVersions";

/**
 * What kept the last Windows update from installing, as the brain reports it
 * to other machines (`runtimeInfo.lastUpdateBlock` in its handshake). The
 * installer writes `<ADE home>/runtime/update-blocked.json` when the old
 * uninstaller fails (`apps/desktop/build/ade-update-holders.ps1`): the
 * processes that held files in the install folder open.
 *
 * `ageMs`, not a time: the reader's clock is another machine's.
 */
export type UpdateBlockedReport = {
  ageMs: number;
  targetVersion: string | null;
  holders: Array<{ pid: number; name: string; path: string | null }>;
};

/** Older than this, the block says nothing about the update in front of you. */
const MAX_REPORT_AGE_MS = 6 * 60 * 60_000;
const MAX_HOLDERS = 8;

/**
 * The report in `text`, or null when there is none worth showing: unreadable,
 * old, or for a version the machine has installed since (`installedVersion`
 * at or past the one that was blocked).
 */
export function parseUpdateBlockedReport(
  text: string | null,
  nowMs: number,
  installedVersion: string | null,
): UpdateBlockedReport | null {
  if (!text) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const at = typeof record.at === "string" ? Date.parse(record.at) : Number.NaN;
  if (!Number.isFinite(at)) return null;
  const ageMs = Math.max(0, nowMs - at);
  if (ageMs > MAX_REPORT_AGE_MS) return null;
  const targetVersion = typeof record.targetVersion === "string" && record.targetVersion.trim()
    ? record.targetVersion.trim()
    : null;
  if (targetVersion && installedVersion && compareUpdateVersions(installedVersion, targetVersion) >= 0) return null;
  const holders = (Array.isArray(record.holders) ? record.holders : [])
    .flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const holder = entry as Record<string, unknown>;
      const pid = typeof holder.pid === "number" && Number.isInteger(holder.pid) ? holder.pid : null;
      const name = typeof holder.name === "string" ? holder.name.trim() : "";
      if (pid == null || !name) return [];
      const holderPath = typeof holder.path === "string" && holder.path.trim() ? holder.path.trim() : null;
      return [{ pid, name, path: holderPath }];
    })
    .slice(0, MAX_HOLDERS);
  return { ageMs, targetVersion, holders };
}

/**
 * Reads the report for a brain's handshake without touching the disk on the
 * event loop: each `read` answers from the last read and starts the next one
 * (never two at once). The first read starts when the reader is made, at brain
 * start, so the handshake that follows a failed update, the one that matters,
 * already has it.
 */
export function createUpdateBlockedReader(runtimeDir: string): {
  read(nowMs: number, installedVersion: string | null): UpdateBlockedReport | null;
} {
  const filePath = path.join(runtimeDir, "update-blocked.json");
  let text: string | null = null;
  let reading = false;
  const refresh = () => {
    if (reading) return;
    reading = true;
    fs.promises.readFile(filePath, "utf8")
      .then((value) => {
        text = value;
      }, (error: NodeJS.ErrnoException) => {
        if (error?.code === "ENOENT") text = null;
      })
      .finally(() => {
        reading = false;
      });
  };
  refresh();
  return {
    read(nowMs, installedVersion) {
      refresh();
      return parseUpdateBlockedReport(text, nowMs, installedVersion);
    },
  };
}
