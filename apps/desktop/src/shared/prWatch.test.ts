import { describe, expect, it } from "vitest";
import type { PrCheck } from "./types/prs";
import {
  PR_SHIP_REVIEW_BOT_GRACE_MS,
  PR_THREAD_CLOSEOUT_RULE,
  PR_WATCH_COMMENT_ONLY_WAKE_LIMIT,
  buildPrWatchWakeText,
  evaluatePrWatch,
  initialPrWatchState,
  type PrMergeQueueRemoval,
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
  input: {
    pr?: Partial<PrWatchPrInput>;
    checks?: PrCheck[] | null;
    remarks?: PrWatchRemark[] | null;
    mergeQueueRemoval?: PrMergeQueueRemoval | null;
    watchStartedAt?: string;
    nowMs: number;
    ignored?: string[];
  },
) {
  return evaluatePrWatch({
    mode,
    state,
    pr: pr(input.pr),
    checks: input.checks === undefined ? [] : input.checks,
    remarks: input.remarks === undefined ? [] : input.remarks,
    ignoredRemarkIds: new Set(input.ignored ?? []),
    mergeQueueRemoval: input.mergeQueueRemoval,
    watchStartedAt: input.watchStartedAt,
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

  it("tells a review bot's edit of its old comment one time, and not a person's edit or an unchanged comment", () => {
    let state = initialPrWatchState(iso(T0), "head-1");
    // CI is running on this repo: an empty check list would also be news (no CI
    // reported), which is not what this test is about.
    const building = [check("build", "in_progress")];
    const summary = remark("bot-summary", "coderabbitai[bot]", T0 + 60_000, true);
    const first = step("watch", state, { checks: building, remarks: [summary], nowMs: T0 + 120_000 });
    expect(kinds(first)).toEqual(["remarks"]);
    state = first.next;

    // The bot reviews the next push by editing the same comment: same id, same createdAt.
    const edited = { ...summary, body: "second review", editedAt: iso(T0 + 600_000) };
    const second = step("watch", state, { checks: building, remarks: [edited], nowMs: T0 + 660_000 });
    expect(kinds(second)).toEqual(["remarks"]);
    state = second.next;

    expect(kinds(step("watch", state, { checks: building, remarks: [edited], nowMs: T0 + 720_000 }))).toEqual([]);

    // A person who edits an old comment has said nothing new.
    const person = remark("human-1", "reviewer", T0 + 30_000);
    const typoFix = { ...person, editedAt: iso(T0 + 900_000) };
    expect(kinds(step("watch", state, { checks: building, remarks: [edited, typoFix], nowMs: T0 + 960_000 }))).toEqual([]);
  });

  it("Ship counts a review bot's edit as the review of the new head, and tells its newest text", () => {
    // The bot's one summary comment is older than the push it will review.
    const summary = remark("bot-summary", "coderabbitai[bot]", T0 + 10_000, true);
    const pushedAt = T0 + 60_000;
    let state = step("ship", initialPrWatchState(iso(T0), "head-0"), {
      pr: { headSha: "head-1" },
      checks: [check("build", "in_progress")],
      remarks: [summary],
      nowMs: pushedAt,
    }).next;

    const firstEdit = { ...summary, body: "review in progress", editedAt: iso(pushedAt + 30_000) };
    const held = step("ship", state, { checks: [check("build", "in_progress")], remarks: [firstEdit], nowMs: pushedAt + 60_000 });
    expect(held.changes).toEqual([]);
    state = held.next;

    // CI ends well inside the 12-minute grace. The bot's second edit is the review.
    const secondEdit = { ...summary, body: "2 findings on head-1", editedAt: iso(pushedAt + 90_000) };
    const released = step("ship", state, {
      checks: [check("build", "completed", "success")],
      remarks: [secondEdit],
      nowMs: pushedAt + 120_000,
    });
    const told = released.changes.flatMap((change) => (change.kind === "remarks" ? change.remarks : []));
    expect(told.map((entry) => entry.body)).toEqual(["2 findings on head-1"]);
    expect(released.next.held).toEqual([]);
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
    // A repo with no CI at all is released by the grace, and the agent is told
    // once that nothing verified the commit.
    const late = step("ship", state, { checks: [], nowMs: pushedAt + PR_SHIP_REVIEW_BOT_GRACE_MS + 1_000 });
    expect(kinds(late)).toEqual(["remarks", "no_checks"]);
    // The no-CI warning is news once, not on every later read.
    expect(kinds(step("ship", late.next, { checks: [], nowMs: pushedAt + PR_SHIP_REVIEW_BOT_GRACE_MS + 60_000 }))).toEqual([]);
  });

  it("tells a merge-queue drop once, and not a queue merge or a drop from before the watch", () => {
    const state = initialPrWatchState(iso(T0), "head-1");
    const watchStartedAt = iso(T0);
    const drop = { id: "removal-1", createdAt: iso(T0 + 60_000), reason: "manual" };
    const told = step("watch", state, { mergeQueueRemoval: drop, watchStartedAt, nowMs: T0 + 120_000 });
    expect(kinds(told)).toEqual(["merge_queue_removed"]);
    // The same removal is not news twice.
    expect(kinds(step("watch", told.next, { mergeQueueRemoval: drop, watchStartedAt, nowMs: T0 + 180_000 }))).toEqual([]);
    // The queue merging the PR writes a removal too; the merge itself is the
    // terminal path's news, so the removal stays quiet.
    expect(kinds(step("watch", state, {
      mergeQueueRemoval: { id: "removal-2", createdAt: iso(T0 + 60_000), reason: "merged" },
      watchStartedAt,
      nowMs: T0 + 120_000,
    }))).toEqual([]);
    // A removal from before the watch began is history.
    expect(kinds(step("watch", state, {
      mergeQueueRemoval: { id: "removal-3", createdAt: iso(T0 - 60_000), reason: "manual" },
      watchStartedAt,
      nowMs: T0 + 120_000,
    }))).toEqual([]);
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

  it("tells an agent to close out review threads when a wake carries comments, and not when it carries checks", () => {
    const wake = (mode: PrWatchMode, changes: Parameters<typeof buildPrWatchWakeText>[0]["changes"]) =>
      buildPrWatchWakeText({ mode, pr: pr(), changes, stop: null });
    const comments = [{ kind: "remarks" as const, remarks: [remark("c-1", "reviewer", T0)] }];
    const checks = [{ kind: "checks_passed" as const }];
    expect(wake("watch", comments)).toContain(PR_THREAD_CLOSEOUT_RULE);
    expect(wake("watch", checks)).not.toContain(PR_THREAD_CLOSEOUT_RULE);
    // Ship carries the rule in its standing instructions on every wake.
    expect(wake("ship", checks)).toContain(PR_THREAD_CLOSEOUT_RULE);
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
