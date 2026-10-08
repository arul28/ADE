import { describe, expect, it } from "vitest";
import type { TerminalSessionSummary } from "../../../shared/types";
import type { SessionFilingBucket } from "../../lib/terminalAttention";
import {
  EMPTY_WORK_LANE_RETURN_STATE,
  floatReturnedLanes,
  nextWorkLaneReturnState,
  stampWorkSeenAt,
  summarizeLaneFocus,
  WORK_SEEN_AT_LIMIT,
  workFocusQueue,
} from "./workLaneFocus";

const NOW_ISO = "2026-04-01T12:00:00.000Z";
const STALE_ISO = "2026-04-01T06:00:00.000Z"; // >3h before NOW_ISO
const FINISHED_ISO = "2026-04-01T10:00:00.000Z";
const SEEN_ISO = "2026-04-01T11:00:00.000Z"; // after FINISHED_ISO

const NO_BUCKETS = new Map<string, SessionFilingBucket>();

function session(
  overrides: Partial<TerminalSessionSummary> & { id: string },
): TerminalSessionSummary {
  return {
    laneId: "lane-1",
    laneName: "lane-1",
    ptyId: null,
    tracked: true,
    pinned: false,
    goal: null,
    toolType: "codex",
    title: overrides.id,
    status: "running",
    startedAt: NOW_ISO,
    endedAt: null,
    exitCode: null,
    transcriptPath: "",
    headShaStart: null,
    headShaEnd: null,
    lastOutputPreview: null,
    summary: null,
    runtimeState: "running",
    resumeCommand: null,
    ...overrides,
  } as TerminalSessionSummary;
}

/** An ended, clean-exit CLI: the canonical `ended` phase, which reads Done. */
function finished(id: string): TerminalSessionSummary {
  return session({
    id,
    status: "completed",
    runtimeState: "exited",
    exitCode: 0,
    startedAt: FINISHED_ISO,
    endedAt: FINISHED_ISO,
  });
}

const running = (id: string) => session({ id });

/** A chat between turns (canonical idle), optionally parked on a scheduled wake. */
function idleChat(id: string, nextWakeAt: string | null = null): TerminalSessionSummary {
  return session({
    id,
    toolType: "codex-chat",
    runtimeState: "idle",
    startedAt: FINISHED_ISO,
    lastActivityAt: FINISHED_ISO,
    nextWakeAt,
  });
}

const NOW_MS = Date.parse(NOW_ISO);
const WAKE_AHEAD_ISO = "2026-04-01T12:12:00.000Z";
const WAKE_OVERDUE_ISO = "2026-04-01T11:50:00.000Z"; // 10 min past due, past the grace

function focus(args: {
  sessions: TerminalSessionSummary[];
  seen?: Record<string, string>;
  nested?: string[];
  launching?: number;
  laneWaiting?: boolean;
  filingBuckets?: ReadonlyMap<string, SessionFilingBucket>;
  busyParents?: string[];
  nowMs?: number;
}) {
  return summarizeLaneFocus({
    sessions: args.sessions,
    filingBuckets: args.filingBuckets ?? NO_BUCKETS,
    laneWaiting: args.laneWaiting ?? false,
    seenAtBySessionId: args.seen ?? {},
    nestedSessionIds: new Set(args.nested ?? []),
    busySubagentParentIds: new Set(args.busyParents ?? []),
    launching: args.launching,
    nowMs: args.nowMs,
  });
}

describe("summarizeLaneFocus — the fold rule", () => {
  it("keeps a lane out for a raised hand even alongside busy rows", () => {
    const needs = session({ id: "needs", pendingInputItemId: "ask-1" });
    const result = focus({ sessions: [needs, running("run")] });
    expect(result.status).toBe("needs_you");
    expect(result.folds).toBe(false);
  });

  it("keeps a lane out for a running row that has gone stale", () => {
    const stale = session({ id: "stale", runtimeState: "running", lastActivityAt: STALE_ISO });
    const result = focus({ sessions: [stale] });
    expect(result.status).toBe("working");
    expect(result.folds).toBe(false);
  });

  it("holds the lane out while a finished row has not been left since it finished", () => {
    const result = focus({ sessions: [finished("done"), running("run")] });
    // The running row is Working; the unseen finish still pins the lane open.
    expect(result.status).toBe("working");
    expect(result.folds).toBe(false);
  });

  it("lets a finished row the user has already left stop holding the lane out", () => {
    const result = focus({
      sessions: [finished("done"), running("run")],
      seen: { done: SEEN_ISO },
    });
    expect(result.status).toBe("working");
    expect(result.folds).toBe(true);
  });

  it("ignores a finished nested row but still honors a nested raised hand", () => {
    // Nobody opens a helper to mark it seen, so a finished nested row must not
    // pin its lane out forever — and it is not busy either.
    const nestedDone = focus({
      sessions: [running("run"), finished("nested-done")],
      nested: ["nested-done"],
    });
    expect(nestedDone.status).toBe("working");
    expect(nestedDone.folds).toBe(true);

    const nestedNeeds = session({ id: "nested-needs", pendingInputItemId: "ask-1" });
    const held = focus({
      sessions: [running("run"), nestedNeeds],
      nested: ["nested-needs"],
    });
    expect(held.status).toBe("needs_you");
    expect(held.folds).toBe(false);
  });

  it("counts a launch with no session row yet as busy work", () => {
    const result = focus({ sessions: [], launching: 2 });
    expect(result.status).toBe("working");
    expect(result.folds).toBe(true);
  });

  it("rolls status up by priority and only folds when something is actually busy", () => {
    const waiting = focus({ sessions: [running("run")], laneWaiting: true });
    expect(waiting.status).toBe("waiting");
    expect(waiting.folds).toBe(true);

    // Working outranks a Done row; Needs you outranks everything.
    const withDone = focus({ sessions: [finished("done"), running("run")], seen: { done: SEEN_ISO } });
    expect(withDone.status).toBe("working");
    const withNeeds = focus({
      sessions: [session({ id: "needs", pendingInputItemId: "ask" }), running("run"), finished("done")],
      seen: { done: SEEN_ISO },
    });
    expect(withNeeds.status).toBe("needs_you");

    // Only finished (already-seen) rows is not working — it waits to be settled.
    const onlyDone = focus({ sessions: [finished("done")], seen: { done: SEEN_ISO } });
    expect(onlyDone.status).toBe("done");
    expect(onlyDone.folds).toBe(false);

    // A plain shell (a dev server, an App Control shell) runs forever, so it is
    // not busy work: it cannot keep a done chat's lane folded, or fold on its own.
    const shell = session({ id: "shell", toolType: "shell", chatSessionId: "chat" });
    const doneChatWithShell = focus({
      sessions: [idleChat("chat"), shell],
      seen: { chat: SEEN_ISO },
      nested: ["shell"],
    });
    expect(doneChatWithShell.status).toBe("working");
    expect(doneChatWithShell.folds).toBe(false);
    expect(focus({ sessions: [shell] }).folds).toBe(false);
    expect(focus({ sessions: [running("run"), shell], nested: ["shell"] }).folds).toBe(true);

    // A snoozed-only lane has no live rows at all.
    const snoozedOnly = focus({
      sessions: [running("snoozed")],
      filingBuckets: new Map<string, SessionFilingBucket>([["snoozed", "snoozed"]]),
    });
    expect(snoozedOnly.status).toBeNull();
    expect(snoozedOnly.folds).toBe(false);
  });
});

describe("summarizeLaneFocus — scheduled wakes and busy subagents", () => {
  // The reported case: a /ship subagent parked on a CI-poll wake, its parent
  // idle. Both are still working from a person's point of view.
  it.each<[string, Parameters<typeof focus>[0], { status: string | null; folds: boolean }]>([
    ["a chat parked on a wake still to come is Waiting and folds",
      { sessions: [idleChat("poller", WAKE_AHEAD_ISO)] }, { status: "waiting", folds: true }],
    ["an unseen parent whose subagent is busy folds with it",
      { sessions: [idleChat("parent"), idleChat("child", WAKE_AHEAD_ISO)], nested: ["child"], busyParents: ["parent"] },
      { status: "waiting", folds: true }],
    ["the same unseen parent with no busy subagent holds the lane out",
      { sessions: [idleChat("parent"), idleChat("child")], nested: ["child"] }, { status: "done", folds: false }],
    ["an overdue wake holds the lane out even after the user saw it",
      { sessions: [idleChat("poller", WAKE_OVERDUE_ISO), running("run")], seen: { poller: SEEN_ISO } },
      { status: "working", folds: false }],
    ["a failed parent still holds the lane out, whatever its subagent is doing",
      { sessions: [session({ id: "parent", status: "failed", runtimeState: "exited", exitCode: 1 }), idleChat("child", WAKE_AHEAD_ISO)],
        nested: ["child"], busyParents: ["parent"] },
      { status: "waiting", folds: false }],
    ["an overdue wake on a nested subagent still holds the lane out",
      { sessions: [running("parent"), idleChat("child", WAKE_OVERDUE_ISO)], nested: ["child"] },
      { status: "working", folds: false }],
  ])("%s", (_label, args, expected) => {
    expect(focus({ ...args, nowMs: NOW_MS })).toEqual(expected);
  });

  it("gives the Focus grid a tile for a missed wake but not for a parent its subagent keeps busy", () => {
    const sessions = [
      idleChat("busy-parent"),
      idleChat("busy-child", WAKE_AHEAD_ISO),
      idleChat("other-parent"),
      idleChat("missed-child", WAKE_OVERDUE_ISO),
      session({ id: "failed-parent", toolType: "codex-chat", status: "failed", runtimeState: "exited", exitCode: 1 }),
    ];
    const tiles = workFocusQueue({
      sessions,
      filingBuckets: NO_BUCKETS,
      foldedLaneIds: new Set(),
      laneWaiting: () => false,
      nestedSessionIds: new Set(["busy-child", "missed-child"]),
      busySubagentParentIds: new Set(["busy-parent", "failed-parent"]),
      nowMs: NOW_MS,
    });
    expect(tiles).not.toContain("busy-parent");
    expect(tiles).not.toContain("busy-child");
    expect(tiles).toContain("missed-child");
    expect(tiles).toContain("other-parent");
    // A failure needs the user even while its subagent keeps working.
    expect(tiles).toContain("failed-parent");
  });
});

describe("nextWorkLaneReturnState", () => {
  it("takes a baseline, stamps a return, and clears it when the lane folds again or disappears", () => {
    const baseline = nextWorkLaneReturnState(
      EMPTY_WORK_LANE_RETURN_STATE,
      new Set(["a", "b"]),
      new Set(["a", "b"]),
      1_000,
    );
    expect(baseline.initialized).toBe(true);
    expect([...baseline.folded].sort()).toEqual(["a", "b"]);
    expect(baseline.returnedAtMs.size).toBe(0);

    const returned = nextWorkLaneReturnState(baseline, new Set(["b"]), new Set(["a", "b"]), 2_000);
    expect(returned.returnedAtMs.get("a")).toBe(2_000);

    const refolded = nextWorkLaneReturnState(returned, new Set(["a", "b"]), new Set(["a", "b"]), 3_000);
    expect(refolded.returnedAtMs.has("a")).toBe(false);

    const gone = nextWorkLaneReturnState(returned, new Set(["b"]), new Set(["b"]), 4_000);
    expect(gone.returnedAtMs.has("a")).toBe(false);

    // An unchanged folded set returns the same state, so a repeated render
    // (StrictMode included) cannot re-stamp a return.
    const stable = nextWorkLaneReturnState(returned, new Set(["b"]), new Set(["a", "b"]), 5_000);
    expect(stable).toBe(returned);
  });
});

describe("floatReturnedLanes", () => {
  const lanes = [
    { id: "primary" },
    { id: "pin" },
    { id: "a" },
    { id: "b" },
    { id: "c" },
  ];
  const canFloat = (lane: { id: string }) => lane.id !== "primary" && lane.id !== "pin";
  const ids = (list: readonly { id: string }[]) => list.map((lane) => lane.id);

  it("floats returned lanes to the front of the floatable run, newest first", () => {
    const out = floatReturnedLanes(lanes, new Map([["a", 100], ["c", 200]]), canFloat);
    expect(ids(out)).toEqual(["primary", "pin", "c", "a", "b"]);
  });

  it("leaves the order untouched when nothing can float", () => {
    expect(ids(floatReturnedLanes(lanes, new Map([["a", 100]]), () => false)))
      .toEqual(["primary", "pin", "a", "b", "c"]);
    expect(ids(floatReturnedLanes(lanes, new Map(), canFloat)))
      .toEqual(["primary", "pin", "a", "b", "c"]);
  });
});

describe("stampWorkSeenAt", () => {
  it("re-stamps a touched id as the newest entry and ignores empty ids", () => {
    const next = stampWorkSeenAt({ a: "t1", b: "t2" }, ["a", ""], "t3");
    expect(Object.keys(next)).toEqual(["b", "a"]);
    expect(next).toEqual({ b: "t2", a: "t3" });
  });

  it("keeps only the newest WORK_SEEN_AT_LIMIT entries", () => {
    const previous: Record<string, string> = {};
    for (let index = 0; index < WORK_SEEN_AT_LIMIT; index += 1) {
      previous[`s${index}`] = "2026-04-01T00:00:00.000Z";
    }
    const next = stampWorkSeenAt(previous, ["new"], "2026-04-02T00:00:00.000Z");
    expect(Object.keys(next)).toHaveLength(WORK_SEEN_AT_LIMIT);
    expect(next.new).toBe("2026-04-02T00:00:00.000Z");
    expect(next.s0).toBeUndefined();
    expect(next.s1).toBeDefined();
  });
});
