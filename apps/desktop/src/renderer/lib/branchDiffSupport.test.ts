import { afterEach, describe, expect, it, vi } from "vitest";
import { hostSupportsBranchDiff, isBranchDiffUnsupported } from "./branchDiffSupport";

describe("isBranchDiffUnsupported", () => {
  it.each([
    { name: "an older brain's coded refusal", error: new Error("action_not_callable: Action 'diff.getBranchChanges' is not callable."), unsupported: true },
    { name: "an older brain's bare sentence", error: new Error("Action 'diff.getBranchChanges' is not exposed through ADE actions."), unsupported: true },
    { name: "the same, through Electron's IPC wrapper", error: new Error("Error invoking remote method 'ade.diff.getBranchChanges': Error: Action 'diff.getBranchChanges' is not callable."), unsupported: true },
    { name: "a phone host's unadvertised command", error: Object.assign(new Error("Unsupported remote command: git.getBranchChanges"), { code: "unsupported_action" }), unsupported: true },
    { name: "a lane with no shared history", error: new Error("This lane shares no history with origin/main."), unsupported: false },
    { name: "a git failure", error: new Error("fatal: bad revision 'origin/main'"), unsupported: false },
  ])("$name → unsupported: $unsupported", ({ error, unsupported }) => {
    expect(isBranchDiffUnsupported(error)).toBe(unsupported);
  });
});

describe("hostSupportsBranchDiff", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("offers Branch for a host that answers or fails on the lane, not for one that refuses the action", async () => {
    const getBranchChanges = vi.fn(async ({ laneId }: { laneId: string }) => {
      if (laneId === "old-host") throw new Error("action_not_callable: Action 'diff.getBranchChanges' is not callable.");
      if (laneId === "no-base") throw new Error("This lane shares no history with origin/main.");
      if (laneId === "web-stub") return null;
      return { baseRef: "origin/main", mergeBase: "abc", files: [], additions: 0, deletions: 0 };
    });
    vi.stubGlobal("window", { ade: { diff: { getBranchChanges } } });

    await expect(hostSupportsBranchDiff("lane-ok")).resolves.toBe(true);
    await expect(hostSupportsBranchDiff("no-base")).resolves.toBe(true);
    await expect(hostSupportsBranchDiff("old-host")).resolves.toBe(false);
    await expect(hostSupportsBranchDiff("web-stub")).resolves.toBe(false);
    // A definite answer is asked once per lane; a null or a failure is asked
    // again, since a reconnect or a fixed base can change it.
    for (const laneId of ["lane-ok", "old-host", "web-stub", "no-base"]) await hostSupportsBranchDiff(laneId);
    const calls = (laneId: string) => getBranchChanges.mock.calls.filter(([args]) => args.laneId === laneId).length;
    expect([calls("lane-ok"), calls("old-host"), calls("web-stub"), calls("no-base")]).toEqual([1, 1, 2, 2]);
  });
});
