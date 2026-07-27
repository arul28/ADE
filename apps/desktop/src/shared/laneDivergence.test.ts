import { describe, expect, it } from "vitest";
import type { LaneListSnapshot, LaneSummary } from "./types/lanes";
import {
  detectPushDivergence,
  formatPushDivergenceMessage,
  formatPushDivergenceTitle,
  toMachineBranchState,
  type MachineBranchState,
} from "./laneDivergence";

function machine(overrides: Partial<MachineBranchState> = {}): MachineBranchState {
  return {
    machineId: "machine-other",
    machineName: "MacBook Pro (97)",
    branchRef: "feature/divergence",
    headSha: "bbbbbbb",
    ahead: 2,
    behind: 0,
    ...overrides,
  };
}

const current = machine({
  machineId: "machine-this",
  machineName: "This Mac",
  headSha: "aaaaaaa",
  ahead: 1,
  behind: 0,
});

describe("detectPushDivergence", () => {
  it("stays silent when no other machine holds the branch", () => {
    expect(detectPushDivergence({ current, others: [] })).toBeNull();
  });

  it("warns when another machine holds the same branch at a different, later commit", () => {
    expect(detectPushDivergence({ current, others: [machine()] })).toEqual({
      machineName: "MacBook Pro (97)",
      aheadBy: 2,
      branchRef: "feature/divergence",
    });
  });

  it("stays silent when the other machine sits at the same commit", () => {
    expect(
      detectPushDivergence({ current, others: [machine({ headSha: "aaaaaaa", ahead: 5 })] }),
    ).toBeNull();
  });

  it("stays silent when the other machine is strictly behind (the push fast-forwards it)", () => {
    expect(
      detectPushDivergence({ current, others: [machine({ ahead: 0, behind: 3 })] }),
    ).toBeNull();
  });

  it("still warns when the other machine's head commit is unknown but it holds unpushed commits", () => {
    // The normal case: no lane record carries a head sha. An unknown head must
    // not suppress the one dialog that stands between a push and lost work.
    expect(
      detectPushDivergence({ current, others: [machine({ headSha: null, ahead: 9 })] }),
    ).toEqual({ machineName: "MacBook Pro (97)", aheadBy: 9, branchRef: "feature/divergence" });
    expect(
      detectPushDivergence({ current, others: [machine({ headSha: "   ", ahead: 9 })] }),
    ).toEqual({ machineName: "MacBook Pro (97)", aheadBy: 9, branchRef: "feature/divergence" });
  });

  it("stays silent when neither head is known and the other machine has nothing unpushed", () => {
    expect(
      detectPushDivergence({
        current: { ...current, headSha: null },
        others: [machine({ headSha: null, ahead: 0, behind: 2 })],
      }),
    ).toBeNull();
  });

  it("stays silent for machines on a different branch", () => {
    expect(
      detectPushDivergence({ current, others: [machine({ branchRef: "feature/other", ahead: 9 })] }),
    ).toBeNull();
  });

  it("ignores an entry for the current machine itself", () => {
    expect(
      detectPushDivergence({
        current,
        others: [machine({ machineId: current.machineId, headSha: "ccccccc", ahead: 9 })],
      }),
    ).toBeNull();
  });

  it("warns when both machines are equally ahead of upstream but at different commits", () => {
    expect(
      detectPushDivergence({ current, others: [machine({ ahead: 1 })] }),
    ).toEqual({ machineName: "MacBook Pro (97)", aheadBy: 1, branchRef: "feature/divergence" });
  });

  it("warns when the other machine has fewer unpushed commits but a different history", () => {
    expect(
      detectPushDivergence({
        current: { ...current, ahead: 3 },
        others: [machine({ ahead: 1 })],
      }),
    ).toEqual({ machineName: "MacBook Pro (97)", aheadBy: 1, branchRef: "feature/divergence" });
  });

  it("warns off ahead alone when the current head commit is unknown", () => {
    const unknownHead = { ...current, headSha: null, ahead: 1 };
    expect(detectPushDivergence({ current: unknownHead, others: [machine({ ahead: 4 })] })).toEqual({
      machineName: "MacBook Pro (97)",
      aheadBy: 4,
      branchRef: "feature/divergence",
    });
    // Fewer unpushed commits there than here is not safety: they are still
    // commits this push would strand.
    expect(detectPushDivergence({ current: unknownHead, others: [machine({ ahead: 1 })] })).toEqual({
      machineName: "MacBook Pro (97)",
      aheadBy: 1,
      branchRef: "feature/divergence",
    });
  });

  it("matches branches regardless of a refs/heads prefix or padding", () => {
    expect(
      detectPushDivergence({
        current: { ...current, branchRef: "refs/heads/feature/divergence" },
        others: [machine({ branchRef: "  feature/divergence  " })],
      }),
    ).toEqual({ machineName: "MacBook Pro (97)", aheadBy: 2, branchRef: "feature/divergence" });
  });

  it("reports the machine that is furthest ahead when several diverge", () => {
    const warning = detectPushDivergence({
      current,
      others: [
        machine({ machineId: "m-a", machineName: "Mac Studio (12)", headSha: "ccccccc", ahead: 2 }),
        machine({ machineId: "m-b", machineName: "MacBook Air (4)", headSha: "ddddddd", ahead: 7 }),
        machine({ machineId: "m-c", machineName: "Mac mini (8)", headSha: "eeeeeee", ahead: 0 }),
      ],
    });
    expect(warning).toEqual({
      machineName: "MacBook Air (4)",
      aheadBy: 7,
      branchRef: "feature/divergence",
    });
  });

  it("keeps the first machine when several are tied on how far ahead they are", () => {
    const warning = detectPushDivergence({
      current,
      others: [
        machine({ machineId: "m-a", machineName: "Mac Studio (12)", headSha: "ccccccc", ahead: 3 }),
        machine({ machineId: "m-b", machineName: "MacBook Air (4)", headSha: "ddddddd", ahead: 3 }),
      ],
    });
    expect(warning?.machineName).toBe("Mac Studio (12)");
  });

  it("treats malformed counters as zero rather than as evidence", () => {
    expect(
      detectPushDivergence({
        current: { ...current, headSha: null, ahead: Number.NaN },
        others: [machine({ ahead: Number.NaN, headSha: "ccccccc" })],
      }),
    ).toBeNull();
  });

  it("stays silent when the current branch ref is empty", () => {
    expect(
      detectPushDivergence({ current: { ...current, branchRef: "  " }, others: [machine()] }),
    ).toBeNull();
  });
});

describe("toMachineBranchState", () => {
  it("reads branch + ahead/behind straight off a lane-shaped record", () => {
    expect(
      toMachineBranchState({
        machineId: "machine-this",
        machineName: "This Mac",
        lane: { branchRef: "feature/x", status: { ahead: 2, behind: 1 } },
        headSha: "aaaaaaa",
      }),
    ).toEqual({
      machineId: "machine-this",
      machineName: "This Mac",
      branchRef: "feature/x",
      headSha: "aaaaaaa",
      ahead: 2,
      behind: 1,
    });
  });

  it("defaults an absent head commit and absent counters instead of guessing", () => {
    expect(
      toMachineBranchState({
        machineId: "machine-this",
        machineName: "This Mac",
        lane: { branchRef: "feature/x" },
      }),
    ).toEqual({
      machineId: "machine-this",
      machineName: "This Mac",
      branchRef: "feature/x",
      headSha: null,
      ahead: 0,
      behind: 0,
    });
  });
});

/**
 * The guard shipped unable to fire: it read a `headSha` off lane records that
 * do not have one, so every candidate was skipped. These cases are built from
 * real `LaneListSnapshot` values — typed, so an invented field is a compile
 * error — to prove a warning can come out of data the app genuinely holds.
 */
describe("detectPushDivergence over real lane snapshots", () => {
  function laneSummary(overrides: Partial<LaneSummary> = {}): LaneSummary {
    return {
      id: "lane-1",
      name: "Divergence lane",
      laneType: "worktree",
      baseRef: "main",
      branchRef: "feature/divergence",
      worktreePath: "/tmp/ade/divergence",
      parentLaneId: null,
      childCount: 0,
      stackDepth: 1,
      parentStatus: null,
      isEditProtected: false,
      // Exactly the columns `lane_state_snapshots` stores.
      status: { dirty: false, ahead: 2, behind: 0, remoteBehind: 0, rebaseInProgress: false },
      color: null,
      icon: null,
      tags: [],
      createdAt: "2026-07-20T12:00:00.000Z",
      ...overrides,
    };
  }

  function laneSnapshot(overrides: Partial<LaneSummary> = {}): LaneListSnapshot {
    return {
      lane: laneSummary(overrides),
      runtime: {
        bucket: "none",
        runningCount: 0,
        awaitingInputCount: 0,
        endedCount: 0,
        sessionCount: 0,
      },
      rebaseSuggestion: null,
      autoRebaseStatus: null,
      conflictStatus: null,
      stateSnapshot: null,
      adoptableAttached: false,
    };
  }

  it("warns from two real lane snapshots with no head sha anywhere", () => {
    const here = laneSnapshot();
    const there = laneSnapshot({
      id: "lane-2",
      worktreePath: "/Users/other/ade/divergence",
      status: { dirty: false, ahead: 3, behind: 0, remoteBehind: 0, rebaseInProgress: false },
    });

    expect(
      detectPushDivergence({
        current: toMachineBranchState({
          machineId: "this-mac",
          machineName: "This Mac",
          lane: here.lane,
        }),
        others: [
          toMachineBranchState({
            machineId: "machine-mbp",
            machineName: "MacBook Pro (97)",
            lane: there.lane,
          }),
        ],
      }),
    ).toEqual({
      machineName: "MacBook Pro (97)",
      aheadBy: 3,
      branchRef: "feature/divergence",
    });
  });

  it("stays silent when the other machine's snapshot has nothing unpushed", () => {
    const here = laneSnapshot();
    const there = laneSnapshot({
      id: "lane-2",
      status: { dirty: true, ahead: 0, behind: 5, remoteBehind: 0, rebaseInProgress: false },
    });

    expect(
      detectPushDivergence({
        current: toMachineBranchState({
          machineId: "this-mac",
          machineName: "This Mac",
          lane: here.lane,
        }),
        others: [
          toMachineBranchState({
            machineId: "machine-mbp",
            machineName: "MacBook Pro (97)",
            lane: there.lane,
          }),
        ],
      }),
    ).toBeNull();
  });

  it("stays silent for this machine's own lane snapshot", () => {
    const here = laneSnapshot();
    const current = toMachineBranchState({
      machineId: "this-mac",
      machineName: "This Mac",
      lane: here.lane,
    });

    expect(detectPushDivergence({ current, others: [current] })).toBeNull();
  });
});

describe("push divergence copy", () => {
  it("names the machine in the title", () => {
    expect(
      formatPushDivergenceTitle({ machineName: "MacBook Pro (97)", aheadBy: 3, branchRef: "feature/x" }),
    ).toBe("MacBook Pro (97) also has this branch");
  });

  it("states the commit count, the branch, and what pushing does", () => {
    expect(
      formatPushDivergenceMessage({ machineName: "MacBook Pro (97)", aheadBy: 3, branchRef: "feature/x" }),
    ).toBe(
      "MacBook Pro (97) is 3 commits ahead of what you are about to push on feature/x. Pushing now makes that machine's copy diverge.",
    );
  });

  it("singularizes a one-commit lead", () => {
    expect(
      formatPushDivergenceMessage({ machineName: "Mac mini (8)", aheadBy: 1, branchRef: "feature/x" }),
    ).toContain("is 1 commit ahead");
  });
});
