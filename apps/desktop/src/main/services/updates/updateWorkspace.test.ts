import { describe, expect, it } from "vitest";

import { selectUpdateWorkspaceRestore } from "./updateWorkspace";

const normalize = (value: string) => value;
const isRepo = (value: string) => value !== "/missing";

describe("selectUpdateWorkspaceRestore", () => {
  it.each([
    {
      name: "a normal launch",
      restoreRequested: false,
      explicitLaunch: false,
      saved: { localRoots: ["/repo"], activeLocalRoot: "/repo" },
      expected: { localRoots: [], activeLocalRoot: null },
    },
    {
      name: "an explicit project launch",
      restoreRequested: true,
      explicitLaunch: true,
      saved: { localRoots: ["/repo"], activeLocalRoot: "/repo" },
      expected: { localRoots: [], activeLocalRoot: null },
    },
    {
      name: "an update relaunch",
      restoreRequested: true,
      explicitLaunch: false,
      saved: { localRoots: ["/a", "/missing", "/a"], activeLocalRoot: "/missing" },
      expected: { localRoots: ["/a"], activeLocalRoot: "/a" },
    },
    {
      name: "an update relaunch whose active path differs only by case",
      restoreRequested: true,
      explicitLaunch: false,
      saved: { localRoots: ["/Repo"], activeLocalRoot: "/repo" },
      expected: { localRoots: ["/Repo"], activeLocalRoot: "/Repo" },
    },
  ])("$name", ({ restoreRequested, explicitLaunch, saved, expected }) => {
    expect(selectUpdateWorkspaceRestore({
      restoreRequested,
      explicitLaunch,
      saved,
      normalizeProjectPath: normalize,
      isLikelyRepoRoot: isRepo,
    })).toEqual(expected);
  });
});
