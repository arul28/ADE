import { beforeEach, describe, expect, it } from "vitest";
import type { FileTreeNode, FilesWorkspace } from "../../../../shared/types";
import { appendTreeNodeChildren, replaceTreeNodeChildren } from "../treeHelpers";
import {
  FILES_ROSTER_CACHE_MAX_PROJECTS,
  FILES_TREE_CACHE_NODE_BUDGET,
  filesProjectCacheKey,
  filesTreeCacheKey,
  filesTreeCacheStats,
  pinCachedTree,
  readCachedTree,
  readCachedWorkspaces,
  releaseFilesProjectCaches,
  resetFilesTreeCachesForTests,
  unpinCachedTree,
  writeCachedTree,
  writeCachedWorkspaces,
} from "./filesTreeCache";

function makeTree(dirPath: string, childCount: number): FileTreeNode[] {
  const children: FileTreeNode[] = Array.from({ length: childCount }, (_, i) => ({
    name: `file-${i}.txt`,
    path: `${dirPath}/file-${i}.txt`,
    type: "file",
    changeStatus: null,
  }));
  return [{ name: dirPath, path: dirPath, type: "directory", changeStatus: null, children }];
}

function makeWorkspace(id: string): FilesWorkspace {
  return {
    id,
    kind: "worktree",
    name: id,
    rootPath: `/repo/${id}`,
    laneId: null,
    isReadOnlyByDefault: false,
    mobileReadOnly: true,
  } as FilesWorkspace;
}

describe("filesTreeCache", () => {
  beforeEach(() => {
    resetFilesTreeCachesForTests();
  });

  it("derives binding-qualified project cache keys for local and remote bindings", () => {
    expect(filesProjectCacheKey({ kind: "local" }, "/repo")).toBe("local::/repo");
    expect(filesProjectCacheKey(null, "/repo")).toBe("local::/repo");
    expect(filesProjectCacheKey({ kind: "remote", targetId: "host-1" }, "/repo")).toBe("remote:host-1::/repo");
  });

  it("accounts nodes and estimated bytes per cached tree", () => {
    const key = filesTreeCacheKey("local::/repo", "ws-1");
    writeCachedTree(key, makeTree("dir", 100));
    const stats = filesTreeCacheStats();
    expect(stats.entries).toBe(1);
    expect(stats.nodes).toBe(101); // directory + 100 children
    expect(stats.estimatedBytes).toBeGreaterThan(101 * 96);
    expect(readCachedTree(key)).toHaveLength(1);
  });

  it("re-accounts an overwritten key instead of double-counting", () => {
    const key = filesTreeCacheKey("local::/repo", "ws-1");
    writeCachedTree(key, makeTree("dir", 100));
    writeCachedTree(key, makeTree("dir", 10));
    const stats = filesTreeCacheStats();
    expect(stats.entries).toBe(1);
    expect(stats.nodes).toBe(11);
  });

  it("stays consistent through structural-sharing tree updates (no stale memo)", () => {
    const key = filesTreeCacheKey("local::/repo", "ws-1");
    const tree = makeTree("dir", 50);
    writeCachedTree(key, tree);
    const grown = appendTreeNodeChildren(tree, "dir", makeTree("dir2", 0).concat(
      Array.from({ length: 25 }, (_, i) => ({
        name: `extra-${i}.txt`,
        path: `dir/extra-${i}.txt`,
        type: "file" as const,
        changeStatus: null,
      })),
    ), null);
    writeCachedTree(key, grown);
    // 1 dir + 50 originals + 1 "dir2" node + 25 extras
    expect(filesTreeCacheStats().nodes).toBe(77);
    const replaced = replaceTreeNodeChildren(grown, "dir", makeTree("inner", 3), null);
    writeCachedTree(key, replaced);
    // replace keeps loaded descendants only for dirs it re-lists; here children
    // become the "inner" directory node (with 3 children) = 1 dir + 4 nodes
    expect(filesTreeCacheStats().nodes).toBe(5);
  });

  it("evicts least-recently-used unpinned trees once over the node budget", () => {
    const perTreeNodes = 60_001;
    const keys = ["a", "b", "c"].map((ws) => filesTreeCacheKey("local::/repo", ws));
    writeCachedTree(keys[0]!, makeTree("dir-a", perTreeNodes - 1));
    writeCachedTree(keys[1]!, makeTree("dir-b", perTreeNodes - 1));
    // Touch "a" so "b" is the least recently used.
    readCachedTree(keys[0]!);
    writeCachedTree(keys[2]!, makeTree("dir-c", perTreeNodes - 1));
    const stats = filesTreeCacheStats();
    expect(stats.nodes).toBeLessThanOrEqual(FILES_TREE_CACHE_NODE_BUDGET);
    expect(readCachedTree(keys[1]!)).toBeUndefined(); // LRU evicted
    expect(readCachedTree(keys[0]!)).toBeDefined();
    expect(readCachedTree(keys[2]!)).toBeDefined();
  });

  it("never evicts pinned (mounted) trees, even over budget; unpin re-applies the budget", () => {
    const big = FILES_TREE_CACHE_NODE_BUDGET; // each tree alone exceeds the budget
    const pinned = filesTreeCacheKey("local::/repo", "mounted");
    const idle = filesTreeCacheKey("local::/repo", "idle");
    pinCachedTree(pinned);
    writeCachedTree(pinned, makeTree("dir-mounted", big));
    expect(readCachedTree(pinned)).toBeDefined();

    writeCachedTree(idle, makeTree("dir-idle", 10));
    // The idle entry is the only unpinned candidate and the pinned tree keeps
    // us over budget, so the idle entry is sacrificed.
    expect(readCachedTree(idle)).toBeUndefined();
    expect(readCachedTree(pinned)).toBeDefined();

    unpinCachedTree(pinned);
    writeCachedTree(idle, makeTree("dir-idle", 10));
    // With the pin gone the oversized tree is evictable.
    expect(readCachedTree(pinned)).toBeUndefined();
    expect(readCachedTree(idle)).toBeDefined();
  });

  it("refcounts pins across multiple mounted workbenches", () => {
    const key = filesTreeCacheKey("local::/repo", "shared");
    pinCachedTree(key);
    pinCachedTree(key);
    writeCachedTree(key, makeTree("dir", FILES_TREE_CACHE_NODE_BUDGET));
    unpinCachedTree(key);
    expect(readCachedTree(key)).toBeDefined(); // still pinned by the second mount
    unpinCachedTree(key);
    expect(readCachedTree(key)).toBeUndefined(); // last unpin re-applies the budget
  });

  it("releases a project's trees and roster on project-surface eviction, keeping pinned trees", () => {
    const projectKey = "local::/repo";
    const otherProject = "local::/other";
    const pinnedKey = filesTreeCacheKey(projectKey, "mounted");
    const idleKey = filesTreeCacheKey(projectKey, "idle");
    const otherKey = filesTreeCacheKey(otherProject, "ws");
    writeCachedWorkspaces(projectKey, [makeWorkspace("mounted")]);
    writeCachedWorkspaces(otherProject, [makeWorkspace("ws")]);
    pinCachedTree(pinnedKey);
    writeCachedTree(pinnedKey, makeTree("dir-a", 5));
    writeCachedTree(idleKey, makeTree("dir-b", 5));
    writeCachedTree(otherKey, makeTree("dir-c", 5));

    releaseFilesProjectCaches(projectKey);
    expect(readCachedTree(idleKey)).toBeUndefined();
    expect(readCachedTree(pinnedKey)).toBeDefined();
    expect(readCachedWorkspaces(projectKey)).toHaveLength(1); // roster kept: project still mounted somewhere
    expect(readCachedTree(otherKey)).toBeDefined();

    unpinCachedTree(pinnedKey);
    releaseFilesProjectCaches(projectKey);
    expect(readCachedTree(pinnedKey)).toBeUndefined();
    expect(readCachedWorkspaces(projectKey)).toHaveLength(0);
    expect(readCachedWorkspaces(otherProject)).toHaveLength(1);
  });

  it("bounds the workspace roster cache by project count (LRU)", () => {
    for (let i = 0; i < FILES_ROSTER_CACHE_MAX_PROJECTS + 3; i++) {
      writeCachedWorkspaces(`local::/repo-${i}`, [makeWorkspace(`ws-${i}`)]);
    }
    expect(filesTreeCacheStats().rosterProjects).toBe(FILES_ROSTER_CACHE_MAX_PROJECTS);
    expect(readCachedWorkspaces("local::/repo-0")).toHaveLength(0); // oldest evicted
    expect(readCachedWorkspaces(`local::/repo-${FILES_ROSTER_CACHE_MAX_PROJECTS + 2}`)).toHaveLength(1);
  });

  it("keeps trees under budget untouched (no gratuitous eviction)", () => {
    const keys = Array.from({ length: 8 }, (_, i) => filesTreeCacheKey("local::/repo", `ws-${i}`));
    for (const key of keys) writeCachedTree(key, makeTree("dir", 500));
    for (const key of keys) expect(readCachedTree(key)).toBeDefined();
    expect(filesTreeCacheStats().entries).toBe(8);
  });
});
