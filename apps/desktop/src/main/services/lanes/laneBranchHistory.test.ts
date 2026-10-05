import { describe, expect, it } from "vitest";
import { parseReflogBranchVisits, selectLaneHistoryBranches } from "./laneBranchHistory";

/**
 * `git reflog show --date=unix --format=%gd%x09%gs HEAD` prints
 * `HEAD@{<unix-seconds>}\t<subject>`. The parser is the only place the raw git
 * text is interpreted, and every branch profile depends on it.
 */
describe("parseReflogBranchVisits", () => {
  it("reads both sides of a checkout as verbatim branch names with epoch millis", () => {
    const visits = parseReflogBranchVisits(
      "HEAD@{1700000000}\tcheckout: moving from main to feature/follow-up",
    );

    expect(visits).toEqual([
      { branchRef: "feature/follow-up", atMs: 1_700_000_000_000 },
      { branchRef: "main", atMs: 1_700_000_000_000 },
    ]);
  });

  it("reads the destination of a branch rename", () => {
    const visits = parseReflogBranchVisits(
      "HEAD@{1700000005}\tBranch: renamed refs/heads/old-name to refs/heads/new-name",
    );

    // `refname:short` form, so it can be compared against the local-branch list.
    expect(visits).toEqual([
      { branchRef: "new-name", atMs: 1_700_000_005_000 },
    ]);
  });

  it("keeps detached-checkout targets verbatim so the branch filter can reject them", () => {
    // A detached checkout of origin/main or a SHA is not a branch name; the
    // parser must not guess one, or a lane would claim the base branch.
    const visits = parseReflogBranchVisits(
      "HEAD@{1700000010}\tcheckout: moving from feature/x to 9f2c1ab",
    );

    expect(visits.map((visit) => visit.branchRef)).toEqual(["9f2c1ab", "feature/x"]);
  });

  it.each([
    { name: "a line with no tab", line: "HEAD@{1700000000} checkout: moving from a to b" },
    { name: "a non-numeric selector", line: "HEAD@{garbage}\tcheckout: moving from a to b" },
    { name: "a subject with no checkout or rename", line: "HEAD@{1700000000}\tcommit: add a file" },
    { name: "an empty line", line: "" },
  ])("ignores $name", ({ line }) => {
    expect(parseReflogBranchVisits(line)).toEqual([]);
  });

  it("tolerates CRLF line endings", () => {
    const visits = parseReflogBranchVisits(
      "HEAD@{1700000000}\tcheckout: moving from main to feature/x\r\n",
    );

    expect(visits).toEqual([
      { branchRef: "feature/x", atMs: 1_700_000_000_000 },
      { branchRef: "main", atMs: 1_700_000_000_000 },
    ]);
  });
});

describe("selectLaneHistoryBranches", () => {
  const localBranches = new Set(["main", "feature/one", "feature/two", "feature/stale"]);
  const none = new Set<string>();

  it("keeps the newest visit per local branch, newest first", () => {
    const selected = selectLaneHistoryBranches({
      visits: [
        { branchRef: "feature/one", atMs: 1_700_000_010_000 },
        { branchRef: "feature/two", atMs: 1_700_000_020_000 },
        { branchRef: "feature/one", atMs: 1_700_000_030_000 },
      ],
      laneCreatedAtMs: 1_700_000_000_000,
      localBranches,
      excludedBranches: none,
    });

    expect(selected).toEqual([
      { branchRef: "feature/one", lastVisitedAtMs: 1_700_000_030_000 },
      { branchRef: "feature/two", lastVisitedAtMs: 1_700_000_020_000 },
    ]);
  });

  it("drops visits to names that are not real local branches", () => {
    const selected = selectLaneHistoryBranches({
      visits: [
        { branchRef: "origin/main", atMs: 1_700_000_010_000 },
        { branchRef: "9f2c1ab", atMs: 1_700_000_011_000 },
        { branchRef: "feature/one", atMs: 1_700_000_012_000 },
      ],
      laneCreatedAtMs: 1_700_000_000_000,
      localBranches,
      excludedBranches: none,
    });

    expect(selected.map((visit) => visit.branchRef)).toEqual(["feature/one"]);
  });

  it("drops base branches and branches another lane records", () => {
    const selected = selectLaneHistoryBranches({
      visits: [
        { branchRef: "main", atMs: 1_700_000_010_000 },
        { branchRef: "feature/two", atMs: 1_700_000_011_000 },
        { branchRef: "feature/one", atMs: 1_700_000_012_000 },
      ],
      laneCreatedAtMs: 1_700_000_000_000,
      localBranches,
      excludedBranches: new Set(["main", "feature/two"]),
    });

    expect(selected.map((visit) => visit.branchRef)).toEqual(["feature/one"]);
  });

  it("ignores visits from before the lane existed", () => {
    // An adopted worktree brings its whole reflog with it; only branches the
    // lane itself checked out are its history.
    const selected = selectLaneHistoryBranches({
      visits: [
        { branchRef: "feature/stale", atMs: 1_600_000_000_000 },
        { branchRef: "feature/one", atMs: 1_700_000_010_000 },
      ],
      laneCreatedAtMs: 1_699_000_000_000,
      localBranches,
      excludedBranches: none,
    });

    expect(selected.map((visit) => visit.branchRef)).toEqual(["feature/one"]);
  });
});
