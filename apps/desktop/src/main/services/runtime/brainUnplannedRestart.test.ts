import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  brainRunEndpointKey,
  brainUnplannedRestart,
  markBrainRunStoppedBy,
  markBrainRunStoppedCleanly,
  recordBrainRunStart,
} from "./brainUnplannedRestart";
import {
  closeLiveTurnProjectsRecord,
  noteLiveTurnProjectOpening,
  settleLiveTurnProjectAfterCrash,
  takeLiveTurnProjectsFromStoppedBrains,
} from "./liveTurnProjects";

/** The pid of a process that ran and exited: what a crashed brain leaves behind. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""]);
  expect(child.pid, "setup: a child process ran").toBeGreaterThan(0);
  return child.pid;
}

let runtimeDir: string;
let socketPath: string;

beforeEach(() => {
  runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-brain-restart-"));
  socketPath = path.join(runtimeDir, "sock", "ade.sock");
});

afterEach(() => {
  markBrainRunStoppedCleanly();
  closeLiveTurnProjectsRecord();
  fs.rmSync(runtimeDir, { recursive: true, force: true });
});

function runRecordPath(): string {
  return path.join(runtimeDir, "brain-run", `${brainRunEndpointKey(socketPath)}.json`);
}

function writeRunRecord(record: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(runRecordPath()), { recursive: true });
  fs.writeFileSync(runRecordPath(), JSON.stringify(record));
}

describe("unplanned brain restart record", () => {
  // Only a crash of the same build since this boot is a restart to report. A
  // banner after an update, a reboot or a deliberate stop would tell the user
  // something went wrong when nothing did.
  it.each([
    { name: "the previous brain crashed", previous: "crashed", build: "b1", reported: true },
    { name: "it stopped in an orderly way", previous: "stopped", build: "b1", reported: false },
    { name: "another ADE process stopped it on purpose", previous: "forced", build: "b1", reported: false },
    { name: "an update replaced the build", previous: "crashed", build: "b2", reported: false },
    { name: "it started before this boot", previous: "before_boot", build: "b1", reported: false },
    { name: "its pid now runs another process", previous: "pid_alive", build: "b1", reported: false },
  ])("reports a restart only when $name says so", ({ previous, build, reported }) => {
    const nowMs = Date.now();
    const pid = previous === "pid_alive" ? process.ppid : deadPid();
    const startedAt = previous === "before_boot"
      ? new Date(nowMs - (os.uptime() + 3_600) * 1000).toISOString()
      : new Date(nowMs - 60_000).toISOString();
    writeRunRecord({
      pid,
      startedAt,
      build: "b1",
      ...(previous === "stopped" ? { stoppedAt: new Date(nowMs - 1_000).toISOString() } : {}),
    });
    if (previous === "forced") markBrainRunStoppedBy(pid, "service_reinstall", runtimeDir);

    const restart = recordBrainRunStart({ runtimeDir, socketPath, build, nowMs });

    if (reported) {
      expect(restart).toEqual({ ts: new Date(nowMs).toISOString(), previousPid: pid, chats: 0, cliSessions: 0 });
    } else {
      expect(restart).toBeNull();
    }
    expect(brainUnplannedRestart()).toEqual(restart);
    // This brain's own record replaces the previous one, so the next start reads this brain.
    expect(JSON.parse(fs.readFileSync(runRecordPath(), "utf8"))).toEqual(
      expect.objectContaining({ pid: process.pid, build }),
    );
  });

  it("lets a brain an app started take the crash once, without a record of its own", () => {
    const nowMs = Date.now();
    const crashedPid = deadPid();
    writeRunRecord({ pid: crashedPid, startedAt: new Date(nowMs - 60_000).toISOString(), build: "b1" });

    const first = recordBrainRunStart({ runtimeDir, socketPath, build: "b1", writeOwnRecord: false, nowMs });

    expect(first?.previousPid).toBe(crashedPid);
    const taken = JSON.parse(fs.readFileSync(runRecordPath(), "utf8")) as Record<string, unknown>;
    expect(taken).toEqual(expect.objectContaining({ pid: crashedPid, stoppedBy: "next_brain_started" }));
    expect(typeof taken.stoppedAt).toBe("string");

    // The service brain that starts later must not show the same crash again.
    const second = recordBrainRunStart({ runtimeDir, socketPath, build: "b1", nowMs: nowMs + 5_000 });
    expect(second).toBeNull();
    expect(brainUnplannedRestart()).toBeNull();
  });
});

describe("projects with a running turn after a crash", () => {
  it("claims each crashed brain's file once and keeps unopened projects through a second crash", () => {
    const key = brainRunEndpointKey(socketPath);
    const dir = path.join(runtimeDir, "live-turns");
    fs.mkdirSync(dir, { recursive: true });
    const [rootA, rootB, rootC, rootLive, rootOther] = ["a", "b", "c", "live", "other"].map((name) =>
      path.join(runtimeDir, "projects", name));
    const crashed = deadPid();
    const write = (name: string, projects: string[]) =>
      fs.writeFileSync(path.join(dir, name), JSON.stringify({ version: 1, pid: 1, projects }));
    write(`${key}.${crashed}.json`, [rootA, rootB, rootC]);
    // Another brain on this endpoint still runs: its turns are its own.
    write(`${key}.${process.ppid}.json`, [rootLive]);
    // A crashed brain's half-written file, and a file of another endpoint.
    write(`${key}.${deadPid()}.json.tmp`, [rootOther]);
    write(`0000000000000000.${crashed}.json`, [rootOther]);

    const taken = takeLiveTurnProjectsFromStoppedBrains({ runtimeDir, socketPath });

    expect([...taken].sort()).toEqual([rootA, rootB, rootC].sort());
    expect(fs.readdirSync(dir).sort()).toEqual([
      `0000000000000000.${crashed}.json`,
      `${key}.${process.pid}.pending.json`,
      `${key}.${process.ppid}.json`,
    ].sort());
    // Claimed once: asking again finds nothing to open.
    expect(takeLiveTurnProjectsFromStoppedBrains({ runtimeDir, socketPath })).toEqual([]);

    // A opens; this brain crashes while it opens B.
    noteLiveTurnProjectOpening(rootA);
    settleLiveTurnProjectAfterCrash(rootA);
    noteLiveTurnProjectOpening(rootB);
    const secondCrashed = deadPid();
    fs.renameSync(
      path.join(dir, `${key}.${process.pid}.pending.json`),
      path.join(dir, `${key}.${secondCrashed}.pending.json`),
    );
    closeLiveTurnProjectsRecord();

    // The next brain opens C. It skips B, so a project whose open crashes the
    // brain cannot crash every brain after it.
    expect(takeLiveTurnProjectsFromStoppedBrains({ runtimeDir, socketPath })).toEqual([rootC]);
    expect(fs.existsSync(path.join(dir, `${key}.${secondCrashed}.pending.json`))).toBe(false);
  });
});
