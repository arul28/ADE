import { describe, expect, it } from "vitest";

import { forgetRecentFile, getRecentFiles, recordRecentFile } from "./recentFiles";

describe("recentFiles", () => {
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
});
