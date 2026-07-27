import { describe, expect, it } from "vitest";
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

  it("stays silent when the other machine's head commit is unknown", () => {
    expect(
      detectPushDivergence({ current, others: [machine({ headSha: null, ahead: 9 })] }),
    ).toBeNull();
    expect(
      detectPushDivergence({ current, others: [machine({ headSha: "   ", ahead: 9 })] }),
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

  it("falls back to the ahead comparison when the current head commit is unknown", () => {
    const unknownHead = { ...current, headSha: null, ahead: 1 };
    expect(detectPushDivergence({ current: unknownHead, others: [machine({ ahead: 4 })] })).toEqual({
      machineName: "MacBook Pro (97)",
      aheadBy: 4,
      branchRef: "feature/divergence",
    });
    expect(detectPushDivergence({ current: unknownHead, others: [machine({ ahead: 1 })] })).toBeNull();
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
