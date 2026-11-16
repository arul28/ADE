/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import { filesStatusLine, gitStatusLine } from "../terminals/useWorkToolStatuses";
import type { LaneSummary } from "../../../shared/types";
import { deferredLaneRefreshOptions } from "./AppShell";

describe("deferredLaneRefreshOptions", () => {

  it("keeps the conflict/rebase decorations on the Lanes route only", () => {
    expect(deferredLaneRefreshOptions(false)).toEqual({
      includeStatus: true,
      includeSnapshots: false,
      includeConflictStatus: false,
    });
    expect(deferredLaneRefreshOptions(true)).toEqual({
      includeStatus: true,
      includeSnapshots: true,
      includeConflictStatus: true,
    });
  });
});

describe("Work tool cards on a status-less lane", () => {
  // The shape `includeStatus: false` hands back: every count zeroed, every
  // measured field null. This is what the cards used to be stuck with.
  const statusless = {
    id: "lane-1",
    name: "Primary",
    status: {
      dirty: false,
      ahead: 0,
      behind: 0,
      remoteBehind: -1,
      changedFileCount: 0,
      staged: 0,
      unstaged: 0,
      untracked: 0,
      lastCommitAt: null,
      trackedFileCount: null,
      rebaseInProgress: false,
      headBranchRef: null,
    },
    lastCommitAt: null,
    trackedFileCount: null,
  } as unknown as LaneSummary;

  const measured = {
    ...statusless,
    status: {
      ...statusless.status,
      remoteBehind: 0,
      lastCommitAt: "2026-05-12T05:06:46-04:00",
      trackedFileCount: 3,
    },
    lastCommitAt: "2026-05-12T05:06:46-04:00",
    trackedFileCount: 3,
  } as unknown as LaneSummary;

  it("falls back to Browse / Unpublished without status, and reads real values with it", () => {
    expect(filesStatusLine(statusless).line).toBe("Browse");
    expect(gitStatusLine(statusless).line).toBe("Unpublished");

    expect(filesStatusLine(measured).line).toBe("3 files");
    expect(gitStatusLine(measured).line).not.toBe("Unpublished");
  });
});
