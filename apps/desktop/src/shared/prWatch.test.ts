import { describe, expect, it } from "vitest";
import type { PrCheck } from "./types/prs";
import {
  PR_SHIP_REVIEW_BOT_GRACE_MS,
  PR_WATCH_COMMENT_ONLY_WAKE_LIMIT,
  evaluatePrWatch,
  initialPrWatchState,
  type PrWatchMode,
  type PrWatchPrInput,
  type PrWatchRemark,
  type PrWatchState,
} from "./prWatch";

const T0 = Date.parse("2026-10-01T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

const pr = (overrides: Partial<PrWatchPrInput> = {}): PrWatchPrInput => ({
  githubPrNumber: 42,
  githubUrl: "https://github.com/acme/app/pull/42",
  baseBranch: "main",
  state: "open",
  headSha: "head-1",
  checksStatus: "pending",
  mergeConflicts: false,
  ...overrides,
});

const check = (name: string, status: PrCheck["status"], conclusion: PrCheck["conclusion"] = null): PrCheck =>
  ({ name, status, conclusion, detailsUrl: null } as PrCheck);

const remark = (id: string, author: string, atMs: number, authorIsBot = false): PrWatchRemark => ({
  id,
  author,
  authorIsBot,
  body: `note ${id}`,
  createdAt: iso(atMs),
  kind: "comment",
});

function step(
  mode: PrWatchMode,
  state: PrWatchState,
  input: { pr?: Partial<PrWatchPrInput>; checks?: PrCheck[] | null; remarks?: PrWatchRemark[] | null; nowMs: number; ignored?: string[] },
) {
  return evaluatePrWatch({
    mode,
    state,
    pr: pr(input.pr),
    checks: input.checks === undefined ? [] : input.checks,
    remarks: input.remarks === undefined ? [] : input.remarks,
    ignoredRemarkIds: new Set(input.ignored ?? []),
    nowMs: input.nowMs,
  });
}

const kinds = (evaluation: { changes: { kind: string }[] }) => evaluation.changes.map((change) => change.kind);

describe("evaluatePrWatch", () => {
  it("Watch tells a newly failed check once, then a human remark, and never ADE's own comment", () => {
    let state = initialPrWatchState(iso(T0), "head-1");
    const failing = [check("build", "completed", "failure"), check("lint", "in_progress")];

    const first = step("watch", state, { checks: failing, nowMs: T0 + 60_000 });
    expect(kinds(first)).toEqual(["checks_failed"]);
    state = first.next;

    // The same failure is not news twice.
    expect(kinds(step("watch", state, { checks: failing, nowMs: T0 + 120_000 }))).toEqual([]);

    const remarks = [
      remark("ade-1", "arul28", T0 + 150_000),
      remark("human-1", "reviewer", T0 + 160_000),
    ];
    const told = step("watch", state, { checks: failing, remarks, ignored: ["ade-1"], nowMs: T0 + 180_000 });
    expect(kinds(told)).toEqual(["remarks"]);
    const remarkChange = told.changes[0];
    expect(remarkChange?.kind === "remarks" ? remarkChange.remarks.map((entry) => entry.id) : []).toEqual(["human-1"]);
  });

  it("Ship holds news until CI finishes and review bots are heard, but a conflict goes out at once", () => {
    const pushedAt = T0 + 60_000;
    // A head pushed after the watch began starts the bot grace clock.
    let state = step("ship", initialPrWatchState(iso(T0), "head-0"), {
      pr: { headSha: "head-1" },
      checks: [check("build", "in_progress")],
      nowMs: pushedAt,
    }).next;

    const held = step("ship", state, {
      checks: [check("build", "completed", "failure"), check("e2e", "in_progress")],
      nowMs: pushedAt + 60_000,
    });
    expect(held.changes).toEqual([]);
    expect(held.next.held.map((change) => change.kind)).toEqual(["checks_failed"]);
    state = held.next;

    // CI done and an agent reviewer spoke on this head: everything goes out together.
    const released = step("ship", state, {
      checks: [check("build", "completed", "failure"), check("e2e", "completed", "success")],
      remarks: [remark("bot-1", "coderabbitai[bot]", pushedAt + 120_000, true)],
      nowMs: pushedAt + 180_000,
    });
    expect(kinds(released)).toEqual(expect.arrayContaining(["checks_failed", "remarks"]));
    expect(released.next.held).toEqual([]);

    const conflict = step("ship", released.next, {
      pr: { mergeConflicts: true },
      checks: [check("e2e", "in_progress")],
      nowMs: pushedAt + 240_000,
    });
    expect(kinds(conflict)).toContain("conflicting");
  });

  it("Ship does not read an empty check list right after a push as finished CI", () => {
    const pushedAt = T0 + 60_000;
    let state = step("ship", initialPrWatchState(iso(T0), "head-0"), {
      pr: { headSha: "head-1" },
      checks: [],
      nowMs: pushedAt,
    }).next;
    const early = step("ship", state, {
      checks: [],
      remarks: [remark("bot-1", "coderabbitai[bot]", pushedAt + 30_000, true)],
      nowMs: pushedAt + 60_000,
    });
    expect(early.changes).toEqual([]);
    state = early.next;
    // A repo with no CI at all is released by the grace.
    const late = step("ship", state, { checks: [], nowMs: pushedAt + PR_SHIP_REVIEW_BOT_GRACE_MS + 1_000 });
    expect(kinds(late)).toEqual(["remarks"]);
  });

  it("switching Ship to Watch releases what Ship was holding", () => {
    const pushedAt = T0 + 60_000;
    const state = step("ship", step("ship", initialPrWatchState(iso(T0), "head-0"), {
      pr: { headSha: "head-1" },
      checks: [check("build", "in_progress")],
      nowMs: pushedAt,
    }).next, {
      checks: [check("build", "completed", "failure"), check("e2e", "in_progress")],
      nowMs: pushedAt + 60_000,
    }).next;
    expect(state.held.length).toBeGreaterThan(0);

    const watched = step("watch", state, {
      checks: [check("build", "completed", "failure"), check("e2e", "in_progress")],
      nowMs: pushedAt + 120_000,
    });
    expect(kinds(watched)).toEqual(["checks_failed"]);
    expect(watched.next.held).toEqual([]);
  });

  it("a merge tells the remarks left on the way out, then stops", () => {
    const state = initialPrWatchState(iso(T0), "head-1");
    const merged = step("watch", state, {
      pr: { state: "merged" },
      remarks: [remark("thanks", "reviewer", T0 + 60_000)],
      nowMs: T0 + 120_000,
    });
    expect(kinds(merged)).toEqual(["remarks", "merged"]);
    expect(merged.stop).toBe("merged");
    expect(merged.next.remarkIds).toEqual(["thanks"]);
  });

  it("ends a watch that only ever hears comments", () => {
    let state = initialPrWatchState(iso(T0), "head-1");
    let last = null as ReturnType<typeof step> | null;
    for (let index = 1; index <= PR_WATCH_COMMENT_ONLY_WAKE_LIMIT; index += 1) {
      last = step("watch", state, {
        remarks: [remark(`c-${index}`, "reviewer", T0 + index * 60_000)],
        nowMs: T0 + index * 60_000 + 1_000,
      });
      expect(kinds(last)).toEqual(["remarks"]);
      state = last.next;
    }
    expect(last?.exhausted).toBe(true);
  });
});
