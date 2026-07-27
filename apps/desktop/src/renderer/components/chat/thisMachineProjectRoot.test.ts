import { describe, expect, it } from "vitest";
import {
  resolveThisMachineProjectRoot,
  THIS_MACHINE_PROJECT_MISSING_MESSAGE,
} from "./thisMachineProjectRoot";
import type { OpenProjectBinding } from "../../../shared/types";

const remoteBinding: Extract<OpenProjectBinding, { kind: "remote" }> = {
  kind: "remote",
  key: "remote:target-1:project-ade",
  targetId: "target-1",
  runtimeName: "MacBook Pro (97)",
  projectId: "project-ade",
  rootPath: "/Users/other/Projects/ADE",
  displayName: "ADE",
};

describe("resolveThisMachineProjectRoot", () => {
  it("uses the bound root when the tab is already local", () => {
    expect(
      resolveThisMachineProjectRoot({
        projectBinding: {
          kind: "local",
          key: "/Users/admin/Projects/ADE",
          rootPath: "/Users/admin/Projects/ADE",
          displayName: "ADE",
        },
        openProjectTabRoots: ["/Users/admin/Projects/other"],
        localProjectRootPath: "/Users/admin/Projects/ADE",
      }),
    ).toEqual({ ok: true, rootPath: "/Users/admin/Projects/ADE" });
  });

  it("refuses a name-only local checkout match", () => {
    expect(
      resolveThisMachineProjectRoot({
        projectBinding: remoteBinding,
        // Insertion order deliberately puts an unrelated repo first.
        openProjectTabRoots: ["/Users/admin/Projects/versic", "/Users/admin/Projects/ADE"],
        localProjectRootPath: null,
      }),
    ).toEqual({ ok: false, message: THIS_MACHINE_PROJECT_MISSING_MESSAGE });
  });

  it("refuses to switch when no local checkout of this repo is open", () => {
    expect(
      resolveThisMachineProjectRoot({
        projectBinding: remoteBinding,
        openProjectTabRoots: ["/Users/admin/Projects/versic"],
        // The store's project root is the BOUND machine's path while remote —
        // it must never be offered as a local counterpart.
        localProjectRootPath: "/Users/other/Projects/ADE",
      }),
    ).toEqual({ ok: false, message: THIS_MACHINE_PROJECT_MISSING_MESSAGE });
  });

  it("never treats the bound machine's own root path as a local checkout", () => {
    expect(
      resolveThisMachineProjectRoot({
        projectBinding: remoteBinding,
        openProjectTabRoots: [remoteBinding.rootPath],
        localProjectRootPath: null,
      }),
    ).toEqual({ ok: false, message: THIS_MACHINE_PROJECT_MISSING_MESSAGE });
  });

  it("falls back to the open local project when there is no binding", () => {
    expect(
      resolveThisMachineProjectRoot({
        projectBinding: null,
        openProjectTabRoots: [],
        localProjectRootPath: "/Users/admin/Projects/ADE",
      }),
    ).toEqual({ ok: true, rootPath: "/Users/admin/Projects/ADE" });
  });
});
