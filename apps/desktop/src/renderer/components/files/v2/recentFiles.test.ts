import { afterEach, describe, expect, it, vi } from "vitest";

import { forgetRecentFile, forgetRecentFilesUnder, getRecentFiles, pruneMissingRootRecentFiles, recordRecentFile } from "./recentFiles";

describe("recentFiles", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("removes stale paths without disturbing other recents", () => {
    const sessionKey = "recent-files-test-remove";

    recordRecentFile(sessionKey, "README.md");
    recordRecentFile(sessionKey, "deleted.txt");
    recordRecentFile(sessionKey, "src/index.ts");

    forgetRecentFile(sessionKey, "deleted.txt");

    expect(getRecentFiles(sessionKey)).toEqual(["src/index.ts", "README.md"]);
  });

  it("keeps recents unique and most-recent first", () => {
    const sessionKey = "recent-files-test-order";

    recordRecentFile(sessionKey, "README.md");
    recordRecentFile(sessionKey, "src/index.ts");
    recordRecentFile(sessionKey, "README.md");

    expect(getRecentFiles(sessionKey)).toEqual(["README.md", "src/index.ts"]);
  });

  it("removes a deleted or renamed subtree from recents", () => {
    const sessionKey = "recent-files-test-remove-tree";

    recordRecentFile(sessionKey, "README.md");
    recordRecentFile(sessionKey, "src/index.ts");
    recordRecentFile(sessionKey, "src\\windows.ts");
    recordRecentFile(sessionKey, "src/nested/view.tsx");

    forgetRecentFilesUnder(sessionKey, "src");

    expect(getRecentFiles(sessionKey)).toEqual(["README.md"]);
  });

  it("prunes root-level recents missing from the loaded root tree", () => {
    const sessionKey = "recent-files-test-prune-root";

    recordRecentFile(sessionKey, "README.md");
    recordRecentFile(sessionKey, "deleted.txt");
    recordRecentFile(sessionKey, "src/index.ts");

    const visible = pruneMissingRootRecentFiles(sessionKey, new Set(["README.md"]));

    expect(visible).toEqual(["src/index.ts", "README.md"]);
    expect(getRecentFiles(sessionKey)).toEqual(["src/index.ts", "README.md"]);
  });

  it("keeps nested Windows-style paths while pruning missing root files", () => {
    const sessionKey = "recent-files-test-prune-windows";

    recordRecentFile(sessionKey, "README.md");
    recordRecentFile(sessionKey, "deleted.txt");
    recordRecentFile(sessionKey, "src\\index.ts");

    const visible = pruneMissingRootRecentFiles(sessionKey, new Set(["README.md"]));

    expect(visible).toEqual(["src\\index.ts", "README.md"]);
    expect(getRecentFiles(sessionKey)).toEqual(["src\\index.ts", "README.md"]);
  });

  it("hydrates persisted recents for a fresh session key", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value); },
      },
    });

    values.set("ade.files.recentFiles.recent-files-test-persisted", JSON.stringify(["src/app.ts", "README.md"]));

    expect(getRecentFiles("recent-files-test-persisted")).toEqual(["src/app.ts", "README.md"]);

    recordRecentFile("recent-files-test-write", "package.json");
    expect(values.get("ade.files.recentFiles.recent-files-test-write")).toBe(JSON.stringify(["package.json"]));
  });
});
