import { describe, expect, it } from "vitest";
import { resolveWindowTabRoots } from "./windowTabRootAuthorization";

const normalizeRoot = (rootPath: string) => rootPath.replace(/\/+$/, "");

describe("resolveWindowTabRoots", () => {
  it("does not authorize a renderer-named root the process never opened", () => {
    const { tabRoots, authorizedLocalRoots } = resolveWindowTabRoots({
      rootPaths: ["/opened", "/never-opened"],
      activeRoot: null,
      normalizeRoot,
      isOpenedProjectRoot: (root) => root === "/opened",
    });
    // The tab set is display state and may name anything.
    expect([...tabRoots]).toEqual(["/opened", "/never-opened"]);
    // The authorization set is not: only the opened root joins the window's
    // local runtime scope, so runtimeBridge still refuses "/never-opened".
    expect(authorizedLocalRoots).toEqual(["/opened"]);
  });

  it("normalizes roots, drops blanks, and always includes the active root", () => {
    const { tabRoots, authorizedLocalRoots } = resolveWindowTabRoots({
      rootPaths: ["/opened/", "   ", "/opened"],
      activeRoot: "/active",
      normalizeRoot,
      isOpenedProjectRoot: () => true,
    });
    expect([...tabRoots]).toEqual(["/opened", "/active"]);
    expect(authorizedLocalRoots).toEqual(["/opened", "/active"]);
  });

  it("authorizes nothing when no tab root resolves to an open project", () => {
    const { authorizedLocalRoots } = resolveWindowTabRoots({
      rootPaths: ["/a", "/b"],
      activeRoot: null,
      normalizeRoot,
      isOpenedProjectRoot: () => false,
    });
    expect(authorizedLocalRoots).toEqual([]);
  });
});
