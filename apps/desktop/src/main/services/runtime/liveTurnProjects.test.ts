import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveAdeLayout } from "../../../shared/adeLayout";
import { recordCliSessionsToReopen, takeCliSessionsToReopen } from "../pty/cliReopenAfterRestart";
import {
  closeLiveTurnProjectsRecord,
  enableLiveTurnProjectsRecord,
  noteBrainStopIntent,
  noteLiveTurn,
  plannedStopRecordedFor,
  recordPlannedBrainStop,
  registerPlannedStopCliSource,
  stoppedForGoodListWriters,
  takeCarriedCliSessionsToReopen,
  takeLiveTurnProjectsFromStoppedBrains,
} from "./liveTurnProjects";

const SIX_HOURS_MS = 6 * 60 * 60_000;
// Past any platform's pid range: another brain's list, never this process.
const OTHER_BRAIN_PID = 99_999_903;

/** A list another brain (another endpoint, such as the machine brain) wrote for the project. */
function writeOtherBrainList(projectRoot: string, sessions: Array<Record<string, unknown>>): void {
  const cacheDir = resolveAdeLayout(projectRoot).cacheDir;
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(
    path.join(cacheDir, `reopen-cli-after-restart.${OTHER_BRAIN_PID}.json`),
    JSON.stringify({ version: 1, writtenAt: new Date().toISOString(), sessions }),
  );
}

describe("a brain stop someone asked for", () => {
  let dir = "";
  let runtimeDir = "";
  let socketPath = "";
  let chatProject = "";
  let cliProject = "";
  let unregister: (() => void) | null = null;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-live-turns-"));
    runtimeDir = path.join(dir, "home", "runtime");
    socketPath = path.join(dir, "home", "ade.sock");
    chatProject = path.join(dir, "chat-project");
    cliProject = path.join(dir, "cli-project");
    fs.mkdirSync(chatProject, { recursive: true });
    fs.mkdirSync(cliProject, { recursive: true });
  });

  afterEach(() => {
    unregister?.();
    unregister = null;
    closeLiveTurnProjectsRecord();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A brain with a chat turn running in one project and two open CLIs (one mid-turn) in another, then stopped. */
  const stopWithWorkInFlight = (nowMs?: number) => {
    enableLiveTurnProjectsRecord({ runtimeDir, socketPath });
    noteLiveTurn(chatProject, "chat:chat-at-work", true);
    unregister = registerPlannedStopCliSource(cliProject, () => [
      { sessionId: "cli-at-work", midTurn: true },
      { sessionId: "cli-idle", midTurn: false },
    ]);
    const summary = recordPlannedBrainStop({ runtimeDir, socketPath, nowMs });
    // The teardown after the stop ends every turn; that must not change the record.
    noteLiveTurn(chatProject, "chat:chat-at-work", false);
    return summary;
  };

  it("keeps what was at work, and the next start opens those projects and continues those chats and CLIs once", () => {
    const summary = stopWithWorkInFlight();

    expect(summary).toMatchObject({ intent: null, projects: 2, chats: 1, midTurnClis: 1, failed: 0 });
    // The terminals' own teardown writes nothing more: the list is already saved.
    expect(plannedStopRecordedFor(cliProject)).toBe(true);
    const records: Array<{ projects: number; stale: boolean }> = [];
    const opened = takeLiveTurnProjectsFromStoppedBrains({
      runtimeDir,
      socketPath,
      maxStoppedAgeMs: SIX_HOURS_MS,
      onStoppedRecord: (record) => records.push(record),
    });
    expect(opened.sort()).toEqual([chatProject, cliProject].map((root) => path.resolve(root)).sort());
    expect(records).toEqual([{ projects: 2, stale: false }]);
    expect(takeCliSessionsToReopen(chatProject, SIX_HOURS_MS)).toEqual([
      { sessionId: "chat-at-work", midTurn: true, kind: "chat" },
    ]);
    expect(takeCliSessionsToReopen(cliProject, SIX_HOURS_MS)).toEqual([
      { sessionId: "cli-at-work", midTurn: true },
      { sessionId: "cli-idle", midTurn: false },
    ]);
    // Taken once: a second start finds nothing to open or continue.
    expect(takeLiveTurnProjectsFromStoppedBrains({ runtimeDir, socketPath, maxStoppedAgeMs: SIX_HOURS_MS })).toEqual([]);
    expect(takeCliSessionsToReopen(chatProject, SIX_HOURS_MS)).toEqual([]);
  });

  it("opens nothing for a stop older than 6 h, and drops each list as stale", () => {
    const stoppedAt = Date.now() - SIX_HOURS_MS - 60_000;
    stopWithWorkInFlight(stoppedAt);
    const records: Array<{ projects: number; stale: boolean }> = [];

    const opened = takeLiveTurnProjectsFromStoppedBrains({
      runtimeDir,
      socketPath,
      maxStoppedAgeMs: SIX_HOURS_MS,
      onStoppedRecord: (record) => records.push(record),
    });

    expect(opened).toEqual([]);
    expect(records).toEqual([{ projects: 2, stale: true }]);
    // The project lists carry their own time: written now in this test, so
    // they only age through the reader's clock.
    const stale: string[] = [];
    const later = () => new Date(Date.now() + SIX_HOURS_MS + 60_000);
    expect(takeCliSessionsToReopen(chatProject, SIX_HOURS_MS, later, (entries) => {
      stale.push(...entries.map((entry) => entry.sessionId));
    })).toEqual([]);
    expect(stale).toEqual(["chat-at-work"]);
  });

  it.each([
    ["a stop for good keeps nothing, and its CLIs only reopen", "stop_for_good" as const, {
      projects: 0,
      opens: false,
      acceptedUpdate: undefined,
      clis: [
        { sessionId: "cli-at-work", midTurn: false, stoppedForGood: true },
        { sessionId: "cli-idle", midTurn: false, stoppedForGood: true },
      ],
    }],
    ["an accepted update keeps the work and restarts the cap", "accepted_update" as const, {
      projects: 2,
      opens: true,
      acceptedUpdate: true,
      clis: [
        { sessionId: "cli-at-work", midTurn: true, acceptedUpdate: true },
        { sessionId: "cli-idle", midTurn: false, acceptedUpdate: true },
      ],
    }],
  ])("%s", (_label, intent, expected) => {
    noteBrainStopIntent(intent, { runtimeDir, socketPath });

    const summary = stopWithWorkInFlight();

    expect(summary).toMatchObject({ intent, projects: expected.projects });
    // The terminals' teardown writes nothing more either way (`ptyService.disposeAll`).
    expect(plannedStopRecordedFor(cliProject)).toBe(true);
    const opened = takeLiveTurnProjectsFromStoppedBrains({ runtimeDir, socketPath, maxStoppedAgeMs: SIX_HOURS_MS });
    expect(opened.length > 0).toBe(expected.opens);
    const chats = takeCliSessionsToReopen(chatProject, SIX_HOURS_MS);
    expect(chats.map((entry) => entry.acceptedUpdate)).toEqual(expected.opens ? [expected.acceptedUpdate] : []);
    expect(takeCliSessionsToReopen(cliProject, SIX_HOURS_MS)).toEqual(expected.clis);
  });

  it("a stop for good also takes the continues from projects an earlier stop left unopened, and only this brain's", () => {
    stopWithWorkInFlight();
    // Another brain's work in the same project is not this brain's to stop.
    writeOtherBrainList(chatProject, [{ sessionId: "chat-of-other-brain", midTurn: true, kind: "chat" }]);
    // The next brain takes the record, then is stopped for good before it opens them.
    expect(takeLiveTurnProjectsFromStoppedBrains({ runtimeDir, socketPath, maxStoppedAgeMs: SIX_HOURS_MS })).toHaveLength(2);
    enableLiveTurnProjectsRecord({ runtimeDir, socketPath });
    noteBrainStopIntent("stop_for_good", { runtimeDir, socketPath });

    expect(recordPlannedBrainStop({ runtimeDir, socketPath })).toMatchObject({ intent: "stop_for_good", projects: 0 });

    expect(takeLiveTurnProjectsFromStoppedBrains({ runtimeDir, socketPath, maxStoppedAgeMs: SIX_HOURS_MS })).toEqual([]);
    expect(takeCliSessionsToReopen(chatProject, SIX_HOURS_MS)).toEqual([
      { sessionId: "chat-of-other-brain", midTurn: true, kind: "chat" },
    ]);
    expect(takeCliSessionsToReopen(cliProject, SIX_HOURS_MS)).toEqual([
      { sessionId: "cli-at-work", midTurn: false, stoppedForGood: true },
      { sessionId: "cli-idle", midTurn: false, stoppedForGood: true },
    ]);
  });

  it("keeps a stop for good whose list cannot be rewritten, so a later take continues nothing", () => {
    stopWithWorkInFlight();
    expect(takeLiveTurnProjectsFromStoppedBrains({ runtimeDir, socketPath, maxStoppedAgeMs: SIX_HOURS_MS })).toHaveLength(2);
    enableLiveTurnProjectsRecord({ runtimeDir, socketPath });
    // The list cannot be claimed (a folder holds the claim's name), as in a
    // read-only or locked cache.
    const listPath = path.join(resolveAdeLayout(cliProject).cacheDir, `reopen-cli-after-restart.${process.pid}.json`);
    // A CLI of the earlier stop that this stop no longer names: its continue
    // is only in the list, so the list itself must be rewritten.
    const earlier = JSON.parse(fs.readFileSync(listPath, "utf8"));
    earlier.sessions.push({ sessionId: "cli-ended-since", midTurn: true });
    fs.writeFileSync(listPath, JSON.stringify(earlier));
    const blockedClaim = `${listPath}.claimed-${process.pid}`;
    fs.mkdirSync(path.join(blockedClaim, "held"), { recursive: true });
    noteBrainStopIntent("stop_for_good", { runtimeDir, socketPath });

    expect(recordPlannedBrainStop({ runtimeDir, socketPath })).toMatchObject({ intent: "stop_for_good", failed: 1 });

    // The next start still cannot rewrite it, so the decision stays.
    expect(takeLiveTurnProjectsFromStoppedBrains({ runtimeDir, socketPath, maxStoppedAgeMs: SIX_HOURS_MS })).toEqual([]);
    expect(stoppedForGoodListWriters(cliProject)).toEqual(new Set([process.pid]));
    // The folder writes again: the project's take reopens the CLIs and continues nothing.
    fs.rmSync(blockedClaim, { recursive: true, force: true });
    expect(takeCliSessionsToReopen(cliProject, SIX_HOURS_MS, undefined, undefined, undefined, stoppedForGoodListWriters(cliProject)))
      .toEqual([
        { sessionId: "cli-at-work", midTurn: false, stoppedForGood: true },
        { sessionId: "cli-idle", midTurn: false, stoppedForGood: true },
        { sessionId: "cli-ended-since", midTurn: false, stoppedForGood: true },
      ]);
  });

  it.each([
    ["another endpoint", () => ({ socketPath: path.join(dir, "home", "other.sock") }), null],
    ["another brain's pid", () => ({ socketPath, pid: process.pid + 1 }), null],
    ["this brain's pid", () => ({ socketPath, pid: process.pid }), "stop_for_good"],
  ] as const)("honors a stop for good only for its brain: %s", (_label, target, intent) => {
    noteBrainStopIntent("stop_for_good", { runtimeDir, ...target() });

    expect(stopWithWorkInFlight()).toMatchObject({ intent });
  });

  it("opens a project whose folder refuses the list, and carries its chats in the record", () => {
    // `.ade` is a file: the project's cache folder cannot be made.
    fs.writeFileSync(path.join(chatProject, ".ade"), "");
    enableLiveTurnProjectsRecord({ runtimeDir, socketPath });
    noteLiveTurn(chatProject, "chat:chat-at-work", true);
    // A project whose terminals fail to list still saves its chats.
    noteLiveTurn(cliProject, "chat:chat-beside-clis", true);
    unregister = registerPlannedStopCliSource(cliProject, () => {
      throw new Error("terminal list failed");
    });

    expect(recordPlannedBrainStop({ runtimeDir, socketPath })).toMatchObject({ projects: 2, chats: 2, failed: 2 });
    // Its teardown still writes the CLIs, into the same list.
    expect(plannedStopRecordedFor(cliProject)).toBe(false);
    recordCliSessionsToReopen(cliProject, [{ sessionId: "cli-idle", midTurn: false }]);

    const opened = takeLiveTurnProjectsFromStoppedBrains({ runtimeDir, socketPath, maxStoppedAgeMs: SIX_HOURS_MS });
    expect(opened.sort()).toEqual([chatProject, cliProject].map((root) => path.resolve(root)).sort());
    expect(takeCarriedCliSessionsToReopen(chatProject)).toEqual([{ sessionId: "chat-at-work", midTurn: true, kind: "chat" }]);
    expect(takeCarriedCliSessionsToReopen(chatProject)).toEqual([]);
    expect(takeCliSessionsToReopen(cliProject, SIX_HOURS_MS)).toEqual([
      { sessionId: "chat-beside-clis", midTurn: true, kind: "chat" },
      { sessionId: "cli-idle", midTurn: false },
    ]);
  });
});
