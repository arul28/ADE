/**
 * Per-launch temp directories ADE owns for an ACP agent.
 *
 * Antigravity's server is a Python zip app that unpacks itself into the system
 * temp directory on every launch (about 1 GB once a session runs) and leaves
 * it there when it is force-killed. ADE points the agent's TMPDIR (TEMP/TMP on
 * Windows) at a directory of its own instead, deletes it when the process
 * exits, and sweeps the ones a crashed ADE left behind.
 *
 * Layout: `<os.tmpdir()>/ade-agent-tmp/<ADE pid>-<provider>-<random>`. The
 * leading pid names the ADE process that owns the directory, so a sweep from
 * any ADE (stable, beta, a headless brain) removes only directories whose
 * owner is gone, never one a live ADE is using. The path stays short: the
 * agent unpacks members up to ~120 characters deep, and Windows keeps a
 * 260-character limit.
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SCRATCH_ROOT_NAME = "ade-agent-tmp";
const OWNER_PATTERN = /^(\d+)-[a-z0-9]+-[0-9a-f]+$/;

export function acpScratchRoot(): string {
  return path.join(os.tmpdir(), SCRATCH_ROOT_NAME);
}

/** A fresh path for one launch. Pure: nothing is created until the spawn. */
export function allocateAcpScratchDir(provider: string): string {
  const safeProvider = provider.toLowerCase().replace(/[^a-z0-9]/g, "") || "agent";
  return path.join(acpScratchRoot(), `${process.pid}-${safeProvider}-${randomBytes(4).toString("hex")}`);
}

function processIsAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

let sweepStarted = false;

/**
 * Remove scratch directories whose owning ADE process is gone. Best effort and
 * in the background: a failure leaves the directory for the next sweep.
 */
export async function sweepStaleAcpScratchDirs(root: string = acpScratchRoot()): Promise<number> {
  let names: string[];
  try {
    names = await fs.promises.readdir(root);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    const match = OWNER_PATTERN.exec(name);
    if (!match) continue;
    const owner = Number(match[1]);
    if (!Number.isSafeInteger(owner) || owner <= 0 || processIsAlive(owner)) continue;
    try {
      await fs.promises.rm(path.join(root, name), { recursive: true, force: true, maxRetries: 3 });
      removed += 1;
    } catch {
      // Still in use on Windows, or permissions; the next sweep retries.
    }
  }
  return removed;
}

/** Run the stale sweep once per process, off the hot path. */
export function startAcpScratchSweepOnce(): void {
  if (sweepStarted) return;
  sweepStarted = true;
  void sweepStaleAcpScratchDirs().catch(() => undefined);
}

/** Create the launch's directory (0700) right before the spawn. */
export function prepareAcpScratchDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  startAcpScratchSweepOnce();
}

/** Delete the launch's directory after the process exits. Never throws. */
export function removeAcpScratchDir(dir: string): void {
  // Only ever a directory this module allocated.
  if (path.dirname(dir) !== acpScratchRoot()) return;
  fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
}
