import { describe, expect, it } from "vitest";
import {
  clearDirtyBuffersForWorkspace,
  getDirtyFileTextForWindow,
  replaceDirtyBuffersForWorkspace,
  replaceDirtyBufferValuesForWorkspace,
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

  it("replaces dirty buffers from explicit current values", () => {
    replaceDirtyBufferValuesForWorkspace("/repo", [
      { path: "src/App.tsx", content: "dirty app" },
      { path: "/repo/README.md", content: "dirty readme" },
    ]);

    expect(getDirtyFileTextForWindow("/repo/src/App.tsx")).toBe("dirty app");
    expect(getDirtyFileTextForWindow("/repo/README.md")).toBe("dirty readme");

    replaceDirtyBufferValuesForWorkspace("/repo", [
      { path: "src/App.tsx", content: "new dirty app" },
    ]);

    expect(getDirtyFileTextForWindow("/repo/src/App.tsx")).toBe("new dirty app");
    expect(getDirtyFileTextForWindow("/repo/README.md")).toBeUndefined();
  });
});
