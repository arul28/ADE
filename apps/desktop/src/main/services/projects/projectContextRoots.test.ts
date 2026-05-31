import { describe, expect, it } from "vitest";
import { collectRootsBoundToWindows } from "./projectContextRoots";

describe("collectRootsBoundToWindows", () => {
  it("includes pending and in-flight init roots so rebalance cannot evict mid-open", () => {
    const roots = collectRootsBoundToWindows({
      windowProjectRoots: ["/old-repo"],
      windowProjectTabRoots: [new Set(["/old-repo"])],
      windowPendingProjectRoots: [new Map([["/new-repo", 1]])],
      projectInitPromises: ["/warming-repo"],
    });

    expect([...roots].sort()).toEqual(["/new-repo", "/old-repo", "/warming-repo"].sort());
  });

  it("deduplicates the same root across binding sources", () => {
    const roots = collectRootsBoundToWindows({
      windowProjectRoots: ["/repo"],
      windowProjectTabRoots: [new Set(["/repo"])],
      windowPendingProjectRoots: [new Map([["/repo", 2]])],
      projectInitPromises: ["/repo"],
    });

    expect(roots.size).toBe(1);
    expect(roots.has("/repo")).toBe(true);
  });
});
