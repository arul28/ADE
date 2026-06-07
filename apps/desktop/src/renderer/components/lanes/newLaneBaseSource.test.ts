import { describe, expect, it, vi } from "vitest";
import {
  effectiveNewLaneBaseSource,
  fetchNewLaneBaseBranches,
  listNewLaneBaseOptions,
  remoteNewLaneBaseFallback,
  selectDefaultNewLaneBaseRef,
} from "./newLaneBaseSource";
import type { LaneBranchOption } from "./laneUtils";

const branches: LaneBranchOption[] = [
  { name: "main", isCurrent: true, isRemote: false, upstream: "origin/main" },
  { name: "feature/local", isCurrent: false, isRemote: false, upstream: null },
  { name: "origin/release", isCurrent: false, isRemote: true, upstream: null },
];

describe("newLaneBaseSource", () => {
  it("defaults the effective setting to remote", () => {
    expect(effectiveNewLaneBaseSource(null)).toBe("remote");
    expect(effectiveNewLaneBaseSource({ local: {}, effective: { git: { autoRebaseOnHeadChange: false, newLaneBaseSource: "local" } } } as any)).toBe("local");
  });

  it("selects the upstream ref when remote bases are enabled", () => {
    expect(selectDefaultNewLaneBaseRef({
      branches,
      source: "remote",
      primaryBaseRef: "main",
    })).toBe("origin/main");
  });

  it("prefers a remote-only primary base before the current branch upstream", () => {
    expect(selectDefaultNewLaneBaseRef({
      branches,
      source: "remote",
      primaryBaseRef: "release",
    })).toBe("origin/release");
  });

  it("uses a matching remote ref when the local primary has no upstream", () => {
    expect(selectDefaultNewLaneBaseRef({
      branches: [
        { name: "main", isCurrent: true, isRemote: false, upstream: null },
        { name: "origin/main", isCurrent: false, isRemote: true, upstream: null },
      ],
      source: "remote",
      primaryBaseRef: "main",
    })).toBe("origin/main");
  });

  it("does not synthesize a remote ref for local-only repositories", () => {
    expect(selectDefaultNewLaneBaseRef({
      branches: [
        { name: "main", isCurrent: true, isRemote: false, upstream: null },
      ],
      source: "remote",
      primaryBaseRef: "main",
    })).toBe("");
  });

  it("preserves a discovered non-origin remote primary base", () => {
    expect(selectDefaultNewLaneBaseRef({
      branches: [
        ...branches,
        { name: "upstream/release", isCurrent: false, isRemote: true, upstream: null },
      ],
      source: "remote",
      primaryBaseRef: "upstream/release",
    })).toBe("upstream/release");
  });

  it("selects the local branch when local bases are enabled", () => {
    expect(selectDefaultNewLaneBaseRef({
      branches,
      source: "local",
      primaryBaseRef: "main",
    })).toBe("main");
  });

  it("lists local branch upstreams plus remote-only branches for remote bases", () => {
    expect(listNewLaneBaseOptions(branches, "remote").map((option) => option.ref)).toEqual([
      "origin/main",
      "origin/release",
    ]);
  });

  it("builds a remote fallback from the primary base ref without rewriting existing remote refs", () => {
    expect(remoteNewLaneBaseFallback("main")).toBe("origin/main");
    expect(remoteNewLaneBaseFallback("refs/heads/feature/x")).toBe("origin/feature/x");
    expect(remoteNewLaneBaseFallback("refs/remotes/origin/main")).toBe("origin/main");
    expect(remoteNewLaneBaseFallback("origin/main")).toBe("origin/main");
    expect(remoteNewLaneBaseFallback("0123456789abcdef0123456789abcdef01234567")).toBe("");
  });

  it("lists branches without fetching when local bases are enabled", async () => {
    const fetchRemoteBranches = vi.fn(() => new Promise<void>(() => {}));
    const listBranches = vi.fn().mockResolvedValue(branches);

    await expect(fetchNewLaneBaseBranches({
      source: "local",
      fetchRemoteBranches,
      listBranches,
      fetchTimeoutMs: 1,
    })).resolves.toBe(branches);

    expect(fetchRemoteBranches).not.toHaveBeenCalled();
    expect(listBranches).toHaveBeenCalledTimes(1);
  });

  it("bounds remote fetch before listing branches", async () => {
    const fetchRemoteBranches = vi.fn(() => new Promise<void>(() => {}));
    const listBranches = vi.fn().mockResolvedValue(branches);

    await expect(fetchNewLaneBaseBranches({
      source: "remote",
      fetchRemoteBranches,
      listBranches,
      fetchTimeoutMs: 1,
    })).resolves.toBe(branches);

    expect(fetchRemoteBranches).toHaveBeenCalledTimes(1);
    expect(listBranches).toHaveBeenCalledTimes(1);
  });
});
