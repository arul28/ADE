import { describe, expect, it } from "vitest";
import type { GitBranchSummary } from "./types";
import {
  remoteLaneBaseCandidate,
  resolveDefaultRemoteLaneBase,
  selectRemoteLaneBaseRef,
} from "./defaultRemoteLaneBase";

function branch(overrides: Partial<GitBranchSummary> & { name: string }): GitBranchSummary {
  return {
    isCurrent: false,
    isRemote: false,
    upstream: null,
    ...overrides,
  };
}

describe("remoteLaneBaseCandidate", () => {
  it("maps local names and head refs to origin-qualified refs", () => {
    expect(remoteLaneBaseCandidate("main")).toBe("origin/main");
    expect(remoteLaneBaseCandidate("refs/heads/develop")).toBe("origin/develop");
    expect(remoteLaneBaseCandidate("origin/main")).toBe("origin/main");
    expect(remoteLaneBaseCandidate("refs/remotes/origin/main")).toBe("origin/main");
  });

  it("returns empty for blanks and bare SHAs", () => {
    expect(remoteLaneBaseCandidate("")).toBe("");
    expect(remoteLaneBaseCandidate(null)).toBe("");
    expect(remoteLaneBaseCandidate("a".repeat(40))).toBe("");
  });
});

describe("selectRemoteLaneBaseRef", () => {
  const branches = [
    branch({ name: "main", isCurrent: true, upstream: "origin/main" }),
    branch({ name: "origin/main", isRemote: true }),
    branch({ name: "origin/develop", isRemote: true }),
  ];

  it("prefers the local base branch's upstream", () => {
    expect(selectRemoteLaneBaseRef({ branches, primaryBaseRef: "main" })).toBe("origin/main");
  });

  it("falls back to origin/<base> when no upstream is configured", () => {
    const noUpstream = [
      branch({ name: "develop" }),
      branch({ name: "origin/develop", isRemote: true }),
    ];
    expect(selectRemoteLaneBaseRef({ branches: noUpstream, primaryBaseRef: "develop" })).toBe("origin/develop");
  });

  it("returns null when the remote ref does not exist (unfetched / no remote)", () => {
    const localOnly = [branch({ name: "main", isCurrent: true })];
    expect(selectRemoteLaneBaseRef({ branches: localOnly, primaryBaseRef: "main" })).toBeNull();
  });
});

describe("resolveDefaultRemoteLaneBase", () => {
  const branches = [
    branch({ name: "main", isCurrent: true, upstream: "origin/main" }),
    branch({ name: "origin/main", isRemote: true }),
  ];

  it("resolves the remote ref after fetching", async () => {
    let fetched = false;
    const result = await resolveDefaultRemoteLaneBase({
      newLaneBaseSource: "remote",
      primaryBaseRef: "main",
      fetchRemote: async () => {
        fetched = true;
      },
      listBranches: async () => branches,
    });
    expect(fetched).toBe(true);
    expect(result).toBe("origin/main");
  });

  it("skips resolution entirely for the local source", async () => {
    const result = await resolveDefaultRemoteLaneBase({
      newLaneBaseSource: "local",
      primaryBaseRef: "main",
      fetchRemote: async () => {
        throw new Error("must not fetch");
      },
      listBranches: async () => branches,
    });
    expect(result).toBeNull();
  });

  it("does not stall on a hung fetch (bounded by the timeout)", async () => {
    const result = await resolveDefaultRemoteLaneBase({
      newLaneBaseSource: "remote",
      primaryBaseRef: "main",
      fetchRemote: () => new Promise(() => {}),
      listBranches: async () => branches,
      fetchTimeoutMs: 20,
    });
    expect(result).toBe("origin/main");
  });

  it("resolves null when listing branches fails", async () => {
    const result = await resolveDefaultRemoteLaneBase({
      newLaneBaseSource: "remote",
      primaryBaseRef: "main",
      fetchRemote: async () => {},
      listBranches: async () => {
        throw new Error("boom");
      },
    });
    expect(result).toBeNull();
  });
});
