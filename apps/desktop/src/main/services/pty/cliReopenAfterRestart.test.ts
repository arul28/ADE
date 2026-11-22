import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  claimCliReopen,
  countCliCrashReopen,
  findCliSessionsCutOffByCrash,
  forgetCliSessionsToReopen,
  recordCliSessionsToReopen,
  resetCliCrashReopenCount,
  takeCliSessionsToReopen,
} from "./cliReopenAfterRestart";
import { resolveAdeLayout } from "../../../shared/adeLayout";

const DAY_MS = 24 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;
// Past any platform's pid range, so never a live process.
const DEAD_PID = 99_999_901;
const OTHER_DEAD_PID = 99_999_902;

describe("CLI reopen after restart", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });
  const projectRoot = (): string => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cli-reopen-"));
    roots.push(root);
    return root;
  };

  it("hands a stopped runtime's CLIs to the next start once, and drops stale or forgotten lists", () => {
    const root = projectRoot();
    const stoppedAt = new Date("2026-11-04T12:00:00.000Z");
    const aMinuteLater = () => new Date(stoppedAt.getTime() + 60_000);

    recordCliSessionsToReopen(root, [
      { sessionId: "cli-a", midTurn: true },
      { sessionId: "cli-b", midTurn: false },
    ], () => stoppedAt);
    expect(takeCliSessionsToReopen(root, DAY_MS, aMinuteLater)).toEqual([
      { sessionId: "cli-a", midTurn: true },
      { sessionId: "cli-b", midTurn: false },
    ]);
    // Taken once: another runtime of the project, or the next restart, never
    // reopens the same CLIs again.
    expect(takeCliSessionsToReopen(root, DAY_MS, aMinuteLater)).toEqual([]);

    // A list older than the bound names work that is stale.
    recordCliSessionsToReopen(root, [{ sessionId: "cli-c", midTurn: true }], () => stoppedAt);
    expect(takeCliSessionsToReopen(root, 1_000, () => new Date(stoppedAt.getTime() + 2_000))).toEqual([]);

    // One stop writes in two steps (a planned brain stop saves the chats, the
    // terminals' teardown its CLIs): the list holds both.
    recordCliSessionsToReopen(root, [{ sessionId: "chat-mine", midTurn: true, kind: "chat" }], () => stoppedAt);
    recordCliSessionsToReopen(root, [
      { sessionId: "chat-machine", midTurn: true, kind: "chat" },
      { sessionId: "cli-e", midTurn: false },
    ], () => stoppedAt);
    // A runtime that is not the entry's owner leaves it, with its list's time,
    // for the owner's next start.
    expect(takeCliSessionsToReopen(root, DAY_MS, aMinuteLater, undefined, (entry) => entry.sessionId === "chat-machine"))
      .toEqual([
        { sessionId: "chat-mine", midTurn: true, kind: "chat" },
        { sessionId: "cli-e", midTurn: false },
      ]);
    expect(takeCliSessionsToReopen(root, DAY_MS, aMinuteLater)).toEqual([
      { sessionId: "chat-machine", midTurn: true, kind: "chat" },
    ]);

    // The left entries cannot be written back (the temp file's name is
    // taken by a folder): the list goes back whole, and this runtime takes
    // nothing from it, least of all the entry left for the other runtime.
    recordCliSessionsToReopen(root, [
      { sessionId: "chat-machine", midTurn: true, kind: "chat" },
      { sessionId: "cli-f", midTurn: false },
    ], () => stoppedAt);
    const blockedWrite = path.join(resolveAdeLayout(root).cacheDir, `reopen-cli-after-restart.${process.pid}.json.${process.pid}.tmp`);
    fs.mkdirSync(blockedWrite);
    expect(takeCliSessionsToReopen(root, DAY_MS, aMinuteLater, undefined, (entry) => entry.sessionId === "chat-machine"))
      .toEqual([]);
    fs.rmdirSync(blockedWrite);
    expect(takeCliSessionsToReopen(root, DAY_MS, aMinuteLater)).toEqual([
      { sessionId: "chat-machine", midTurn: true, kind: "chat" },
      { sessionId: "cli-f", midTurn: false },
    ]);

    // A project removed from the machine forgets its list.
    recordCliSessionsToReopen(root, [{ sessionId: "cli-d", midTurn: false }], () => stoppedAt);
    forgetCliSessionsToReopen(root);
    expect(takeCliSessionsToReopen(root, DAY_MS, aMinuteLater)).toEqual([]);
  });

  it("after a crash, reopens only this computer's recent CLIs whose owner is gone", () => {
    const now = Date.now();
    const seen = (agoMs: number) => new Date(now - agoMs).toISOString();
    const startedAt = "2026-11-12T10:00:00.000Z";
    const row = (id: string, ownerPid: number | null, extra: Record<string, unknown> = {}) => ({
      id,
      status: "running",
      archivedAt: null,
      ownerPid,
      ownerProcessStartedAt: startedAt,
      ...extra,
    });
    const result = findCliSessionsCutOffByCrash({
      rows: [
        row("cut-off", DEAD_PID),
        row("swept", DEAD_PID, { status: "detached" }),
        // Another machine's row: the session table syncs, the process registry does not.
        row("other-machine", 77_777_777),
        // A live peer runtime of this computer still serves it.
        row("live-peer", process.pid),
        // The pid came back as another process: not the owner the row names.
        row("reused-pid", DEAD_PID, { ownerProcessStartedAt: "2026-11-12T09:00:00.000Z" }),
        row("stale", OTHER_DEAD_PID),
        row("archived", DEAD_PID, { archivedAt: seen(0) }),
        row("ended", DEAD_PID, { status: "disposed" }),
        row("planned", DEAD_PID),
        row("no-owner", null),
      ],
      knownOwners: [
        { pid: DEAD_PID, startedAt, lastSeen: seen(60_000) },
        { pid: process.pid, startedAt, lastSeen: seen(0) },
        { pid: OTHER_DEAD_PID, startedAt, lastSeen: seen(7 * HOUR_MS) },
      ],
      ownPid: 1,
      exclude: new Set(["planned"]),
      maxAgeMs: 6 * HOUR_MS,
    });
    expect(result.cutOff).toEqual([
      { sessionId: "cut-off", ownerPid: DEAD_PID, ownerStartedAt: startedAt },
      { sessionId: "swept", ownerPid: DEAD_PID, ownerStartedAt: startedAt },
    ]);
    expect(result.stale).toBe(1);
    expect(result.cutOff.map((entry) => entry.sessionId)).not.toContain("other-machine");
  });

  it("claims a session once per dead owner and caps reopens after unclean stops in a row", () => {
    const root = projectRoot();
    const owner = { sessionId: "cli-a", ownerPid: DEAD_PID, ownerStartedAt: "2026-11-12T10:00:00.000Z" };
    // Two runtimes, or the planned list and the crash list, race for one session.
    expect(claimCliReopen(root, owner)).toBe(true);
    expect(claimCliReopen(root, owner)).toBe(false);
    // The runtime that reopened it crashes too: a new owner, a new claim.
    expect(claimCliReopen(root, { ...owner, ownerPid: OTHER_DEAD_PID })).toBe(true);

    expect([1, 2, 3, 4].map(() => countCliCrashReopen(root, "cli-a", 6 * HOUR_MS))).toEqual([1, 2, 3, 4]);
    // Another session keeps its own count.
    expect(countCliCrashReopen(root, "cli-b", 6 * HOUR_MS)).toBe(1);
    // A planned stop or a resume by hand breaks the row.
    resetCliCrashReopenCount(root, ["cli-a"]);
    expect(countCliCrashReopen(root, "cli-a", 6 * HOUR_MS)).toBe(1);
    // Forgetting the project drops its claims with its lists.
    forgetCliSessionsToReopen(root);
    expect(claimCliReopen(root, owner)).toBe(true);
  });
});
