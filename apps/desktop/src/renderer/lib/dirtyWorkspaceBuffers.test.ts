import { describe, expect, it } from "vitest";
import {
  clearDirtyBuffersForWorkspace,
  getDirtyFileTextForWindow,
  replaceDirtyBuffersForWorkspace,
} from "./dirtyWorkspaceBuffers";

describe("dirtyWorkspaceBuffers", () => {
  it("matches Windows absolute paths case-insensitively with slash normalization", () => {
    replaceDirtyBuffersForWorkspace("C:\\Repo", [
      {
        path: "src\\App.tsx",
        content: "dirty",
        savedContent: "saved",
      },
    ]);

    expect(getDirtyFileTextForWindow("c:/repo/src/app.tsx")).toBe("dirty");
    expect(getDirtyFileTextForWindow("/C:/Repo/src/App.tsx")).toBe("dirty");
    clearDirtyBuffersForWorkspace("c:/repo");
    expect(getDirtyFileTextForWindow("C:\\Repo\\src\\App.tsx")).toBeUndefined();
  });

  it("normalizes dot segments before matching Windows dirty buffers", () => {
    replaceDirtyBuffersForWorkspace("C:\\Repo", [
      {
        path: ".\\src\\nested\\..\\App.tsx",
        content: "dirty",
        savedContent: "saved",
      },
    ]);

    expect(getDirtyFileTextForWindow("C:/Repo/src/App.tsx")).toBe("dirty");
    expect(getDirtyFileTextForWindow("C:/Repo/src/./App.tsx")).toBe("dirty");
    clearDirtyBuffersForWorkspace("C:/Repo/.");
    expect(getDirtyFileTextForWindow("C:/Repo/src/App.tsx")).toBeUndefined();
  });

  it("keeps clean buffers out of the dirty map", () => {
    replaceDirtyBuffersForWorkspace("/repo", [
      {
        path: "src/App.tsx",
        content: "same",
        savedContent: "same",
      },
    ]);

    expect(getDirtyFileTextForWindow("/repo/src/App.tsx")).toBeUndefined();
  });
});
