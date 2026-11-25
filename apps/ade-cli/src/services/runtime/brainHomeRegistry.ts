/**
 * Who else is on this `ADE_HOME`.
 *
 * ADE refuses a second sync host loudly, names the app that holds it, and
 * prints the command to quit it. A second brain on the same DATABASE gets
 * none of that: it starts, attaches, and says nothing. On 2026-09-22 three
 * brains shared one `~/.ade` — the installed app, a lane's dev brain, and an
 * orphan whose window had exited five hours earlier — and the only way to
 * find that out was to read `ps` output by hand. Agents died and it read as
 * bad luck.
 *
 * This does NOT refuse. Two brains on one home is a supported thing to do:
 * `npm run dev:desktop` from a lane worktree is the documented dev loop, and
 * it deliberately shares `~/.ade` with the installed app. Refusing would break
 * the workflow this warning exists to make legible. It only answers "who else
 * is here", so the answer can be logged, shown, and acted on.
 *
 * Liveness is pid AND start time, never the pid alone: the OS recycles pid
 * numbers (and on Linux a thread id answers `kill(pid, 0)`), and a stale record
 * naming a reused pid would accuse an innocent process. A pid that is now a
 * thread of another process (`/proc/<pid>/status` Tgid) is gone; a process
 * whose start time can't be read right now (`ps` failed or timed out under
 * load) keeps its record. A record written without a start time (Windows,
 * where `ps` start times don't exist) goes by the pid alone.
 */

import fs from "node:fs";
import path from "node:path";
import { PROCESS_START_TIME_TOLERANCE_MS } from "../../../../desktop/src/main/services/processes/processStartTime";

export type BrainRegistryRecord = {
  pid: number;
  /** The endpoint this brain serves: a socket path or a named pipe. */
  endpoint: string;
  /** OS-reported process start, used with the pid to reject pid reuse. */
  startedAtMs: number | null;
  /** Channel/app label, so the warning can name something a person recognises. */
  label: string | null;
  recordedAt: string;
};

export type BrainHomeRegistryDeps = {
  /** `<ADE_HOME>`. Records live in `<home>/brains`. */
  home: string;
  /** OS-reported start time for a live pid, or null. Reused from the desktop. */
  readProcessStartTimeMs: (pid: number) => number | null;
  /** `process.kill(pid, 0)` in production; a set in tests. */
  isPidAlive: (pid: number) => boolean;
  /**
   * The process a task id belongs to (Linux `Tgid`), or null when it can't
   * be told: `readLinuxThreadGroupId` in production.
   */
  readThreadGroupId: (pid: number) => number | null;
  now?: () => Date;
};

/** `Tgid` from `/proc/<pid>/status`: the process a Linux thread id belongs to. Null off Linux or unreadable. */
export function readLinuxThreadGroupId(pid: number): number | null {
  if (process.platform !== "linux") return null;
  try {
    const match = /^Tgid:\s+(\d+)/m.exec(fs.readFileSync(`/proc/${pid}/status`, "utf8"));
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

const REGISTRY_DIR = "brains";

function registryDir(home: string): string {
  return path.join(home, REGISTRY_DIR);
}

function recordPath(home: string, pid: number): string {
  return path.join(registryDir(home), `${pid}.json`);
}

/**
 * True when the record still names the process that wrote it.
 *
 * A dead pid is gone. A live pid whose start time disagrees is a DIFFERENT
 * process wearing a recycled number, which is the case that would otherwise
 * make this lie.
 */
export function isBrainRecordLive(
  record: BrainRegistryRecord,
  deps: Pick<BrainHomeRegistryDeps, "isPidAlive" | "readProcessStartTimeMs" | "readThreadGroupId">,
): boolean {
  if (!Number.isInteger(record.pid) || record.pid <= 0) return false;
  if (!deps.isPidAlive(record.pid)) return false;
  // On Linux a thread id answers `kill(pid, 0)` too: an ADE Cloud computer
  // restarts with the new brain's threads on the old brain's pid numbers, and
  // the old record then warned of a second brain on every restart. A brain
  // record names a process, so a pid that is another process's thread is gone.
  const threadGroupId = deps.readThreadGroupId(record.pid);
  if (threadGroupId != null && threadGroupId !== record.pid) return false;
  // Written where start times can't be read (Windows): the pid is all there is.
  if (record.startedAtMs == null) return true;
  // A real process whose start time can't be read right now (`ps` failed or
  // hit its 2 s timeout under load) keeps its record: a live brain must not
  // lose it to a slow `ps`.
  const actual = deps.readProcessStartTimeMs(record.pid);
  if (actual == null) return true;
  return Math.abs(actual - record.startedAtMs) <= PROCESS_START_TIME_TOLERANCE_MS;
}

export function createBrainHomeRegistry(deps: BrainHomeRegistryDeps) {
  const now = deps.now ?? (() => new Date());

  /** Every live record except this process's own. Stale files are removed. */
  function listOthers(selfPid: number): BrainRegistryRecord[] {
    let names: string[] = [];
    try {
      names = fs.readdirSync(registryDir(deps.home));
    } catch {
      return [];
    }
    const live: BrainRegistryRecord[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const full = path.join(registryDir(deps.home), name);
      let record: BrainRegistryRecord | null = null;
      try {
        record = JSON.parse(fs.readFileSync(full, "utf8")) as BrainRegistryRecord;
      } catch {
        record = null;
      }
      // An unreadable record names nobody. Removing it keeps the directory
      // from growing a file per crashed brain forever.
      if (!record || !isBrainRecordLive(record, deps)) {
        try { fs.rmSync(full, { force: true }); } catch { /* best effort */ }
        continue;
      }
      if (record.pid === selfPid) continue;
      live.push(record);
    }
    return live.sort((a, b) => a.pid - b.pid);
  }

  return {
    listOthers,

    /** Announce this brain and return whoever was already here. */
    join(self: Omit<BrainRegistryRecord, "recordedAt">): BrainRegistryRecord[] {
      const others = listOthers(self.pid);
      try {
        fs.mkdirSync(registryDir(deps.home), { recursive: true, mode: 0o700 });
        fs.writeFileSync(
          recordPath(deps.home, self.pid),
          `${JSON.stringify({ ...self, recordedAt: now().toISOString() }, null, 2)}\n`,
          { mode: 0o600 },
        );
      } catch {
        // A home we cannot write is a home we cannot warn about. The brain
        // still runs: this is diagnostics, never a gate.
      }
      return others;
    },

    /** Remove this brain's record. Safe to call twice. */
    leave(pid: number): void {
      try { fs.rmSync(recordPath(deps.home, pid), { force: true }); } catch { /* best effort */ }
    },
  };
}

/**
 * The sentence a person can act on: who else is here, and on what.
 *
 * Deliberately not phrased as an error. Sharing a home is supported, and a
 * warning that cries wolf on the documented dev loop would be turned off.
 */
export function describeOtherBrains(others: readonly BrainRegistryRecord[]): string | null {
  if (others.length === 0) return null;
  const list = others
    .map((other) => `${other.label?.trim() || "ADE brain"} (pid ${other.pid}, ${other.endpoint})`)
    .join("; ");
  const count = others.length === 1 ? "Another ADE brain is" : `${others.length} other ADE brains are`;
  return `${count} already using this ADE home: ${list}. They share one database, so a chat can only be owned by one of them.`;
}
