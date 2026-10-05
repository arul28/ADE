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

function focus(args: {
  sessions: TerminalSessionSummary[];
  seen?: Record<string, string>;
  nested?: string[];
  launching?: number;
  laneWaiting?: boolean;
  filingBuckets?: ReadonlyMap<string, SessionFilingBucket>;
}) {
  return summarizeLaneFocus({
    sessions: args.sessions,
    filingBuckets: args.filingBuckets ?? NO_BUCKETS,
    laneWaiting: args.laneWaiting ?? false,
    seenAtBySessionId: args.seen ?? {},
    nestedSessionIds: new Set(args.nested ?? []),
    launching: args.launching,
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

    // A snoozed-only lane has no live rows at all.
    const snoozedOnly = focus({
      sessions: [running("snoozed")],
      filingBuckets: new Map<string, SessionFilingBucket>([["snoozed", "snoozed"]]),
    });
    expect(snoozedOnly.status).toBeNull();
    expect(snoozedOnly.folds).toBe(false);
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
