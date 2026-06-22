import { describe, expect, it } from "vitest";
import {
  hasLoadedDirectoryChildren,
  isUnavailableGitDecorationsError,
  loadedDirectoryChildrenCount,
  parentPathForFileChange,
  replaceTreeNodeChildren,
} from "./treeHelpers";

describe("isUnavailableGitDecorationsError", () => {
  it("matches optional remote git decoration action availability failures", () => {
    expect(
      isUnavailableGitDecorationsError(
        new Error(
          "Error invoking remote method 'ade.remoteRuntime.callAction': Error: Action 'file.refreshGitDecorations' is not callable.",
        ),
      ),
    ).toBe(true);
    expect(
      isUnavailableGitDecorationsError(
        new Error("Action 'file.refreshGitDecorations' is not exposed through ADE actions."),
      ),
    ).toBe(true);
  });

  it("does not hide unrelated Files errors", () => {
    expect(isUnavailableGitDecorationsError(new Error("ENOENT: no such file or directory"))).toBe(false);
    expect(isUnavailableGitDecorationsError(new Error("Action 'file.readFile' is not callable."))).toBe(false);
  });
});

describe("file tree change refresh helpers", () => {
  it("resolves changed paths to the directory that needs a scoped reload", () => {
    expect(parentPathForFileChange("README.md")).toBe("");
    expect(parentPathForFileChange("marketing/fastlane-brand-profile.md")).toBe("marketing");
    expect(parentPathForFileChange("src/routes/app/page.tsx")).toBe("src/routes/app");
    expect(parentPathForFileChange("src\\routes\\app\\page.tsx")).toBe("src/routes/app");
  });

  it("only treats directories with loaded children as refreshable", () => {
    const tree = [
      {
        name: "marketing",
        path: "marketing",
        type: "directory" as const,
        children: [
          {
            name: "existing.md",
            path: "marketing/existing.md",
            type: "file" as const,
          },
        ],
      },
      {
        name: "src",
        path: "src",
        type: "directory" as const,
      },
    ];

    expect(hasLoadedDirectoryChildren(tree, "")).toBe(true);
    expect(hasLoadedDirectoryChildren(tree, "marketing")).toBe(true);
    expect(hasLoadedDirectoryChildren(tree, "src")).toBe(false);
    expect(hasLoadedDirectoryChildren(tree, "missing")).toBe(false);
    expect(loadedDirectoryChildrenCount(tree, "")).toBe(2);
    expect(loadedDirectoryChildrenCount(tree, "marketing")).toBe(1);
    expect(loadedDirectoryChildrenCount(tree, "src")).toBe(0);
    expect(loadedDirectoryChildrenCount(tree, "missing")).toBe(0);
  });

  it("preserves loaded descendant folders during a scoped directory refresh", () => {
    const tree = [
      {
        name: "marketing",
        path: "marketing",
        type: "directory" as const,
        children: [
          {
            name: "assets",
            path: "marketing/assets",
            type: "directory" as const,
            children: [
              {
                name: "logo.png",
                path: "marketing/assets/logo.png",
                type: "file" as const,
              },
            ],
            childrenTruncated: true,
            loadMoreOffset: 2000,
          },
          {
            name: "old.md",
            path: "marketing/old.md",
            type: "file" as const,
          },
        ],
      },
    ];

    const refreshed = replaceTreeNodeChildren(tree, "marketing", [
      {
        name: "assets",
        path: "marketing/assets",
        type: "directory" as const,
      },
      {
        name: "new.md",
        path: "marketing/new.md",
        type: "file" as const,
      },
    ]);

    expect(refreshed[0].children?.map((node) => node.path)).toEqual(["marketing/assets", "marketing/new.md"]);
    const assets = refreshed[0].children?.find((node) => node.path === "marketing/assets");
    expect(assets?.children?.map((node) => node.path)).toEqual(["marketing/assets/logo.png"]);
    expect(assets?.childrenTruncated).toBe(true);
    expect(assets?.loadMoreOffset).toBe(2000);
  });
});
