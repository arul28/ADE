import { describe, expect, it } from "vitest";
import type { GitBranchSummary, GitCommitSummary } from "../../../shared/types";
import { filterCommitsForSearch } from "./historySearch";

function commit(
  sha: string,
  subject: string,
  authorName: string,
  parents: string[] = [],
  pushed = true,
): GitCommitSummary {
  return {
    sha,
    shortSha: sha.slice(0, 7),
    parents,
    authorName,
    authoredAt: "2026-05-22T00:00:00Z",
    subject,
    pushed,
  };
}

function branch(name: string, sha: string): GitBranchSummary {
  return {
    name,
    isCurrent: false,
    isRemote: false,
    upstream: null,
    lastCommitSha: sha,
  };
}

describe("filterCommitsForSearch", () => {
  const merge = commit("a111111111", "Merge feature graph", "Ari", ["b2", "c3"]);
  const fix = commit("b222222222", "Fix history search", "Sam", ["d4"], false);
  const docs = commit("c333333333", "Document activity export", "Lee", ["d4"]);
  const commits = [merge, fix, docs];
  const refsBySha = new Map([
    [merge.sha, [branch("main", merge.sha)]],
    [fix.sha, [branch("feature/history", fix.sha)]],
  ]);

  it("matches scoped message, author, commit, and branch queries", () => {
    expect(filterCommitsForSearch(commits, refsBySha, "message:search")).toEqual([fix]);
    expect(filterCommitsForSearch(commits, refsBySha, "author:lee")).toEqual([docs]);
    expect(filterCommitsForSearch(commits, refsBySha, "commit:b222")).toEqual([fix]);
    expect(filterCommitsForSearch(commits, refsBySha, "branch:feature/history")).toEqual([fix]);
  });

  it("matches git-style type filters and combines tokens", () => {
    expect(filterCommitsForSearch(commits, refsBySha, "is:merge")).toEqual([merge]);
    expect(filterCommitsForSearch(commits, refsBySha, "is:unpushed history")).toEqual([fix]);
    expect(filterCommitsForSearch(commits, refsBySha, "is:pushed history")).toEqual([]);
  });
});
