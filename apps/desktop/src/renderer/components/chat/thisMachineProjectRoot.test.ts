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

  it("accepts an open local checkout with the same verified git origin", () => {
    expect(
      resolveThisMachineProjectRoot({
        projectBinding: remoteBinding,
        openProjectTabRoots: ["/Users/admin/Projects/ADE"],
        localProjectRootPath: null,
        boundRepoOriginUrl: "git@github.com:acme/ADE.git",
        recentProjects: [{
          rootPath: "/Users/admin/Projects/ADE",
          displayName: "ADE",
          exists: true,
          lastOpenedAt: "2026-07-27T00:00:00.000Z",
          gitOriginUrl: "https://github.com/acme/ADE.git",
        }],
      }),
    ).toEqual({ ok: true, rootPath: "/Users/admin/Projects/ADE" });
  });

  it("rejects an open same-name checkout whose verified origin differs", () => {
    expect(
      resolveThisMachineProjectRoot({
        projectBinding: remoteBinding,
        openProjectTabRoots: ["/Users/admin/Projects/ADE"],
        localProjectRootPath: null,
        boundRepoOriginUrl: "git@github.com:acme/ADE.git",
        recentProjects: [{
          rootPath: "/Users/admin/Projects/ADE",
          displayName: "ADE",
          exists: true,
          lastOpenedAt: "2026-07-27T00:00:00.000Z",
          gitOriginUrl: "git@github.com:other/ADE.git",
        }],
      }),
    ).toEqual({ ok: false, message: THIS_MACHINE_PROJECT_MISSING_MESSAGE });
  });

  it("rejects a missing recent checkout even when its verified origin matches", () => {
    expect(
      resolveThisMachineProjectRoot({
        projectBinding: remoteBinding,
        openProjectTabRoots: ["/Users/admin/Projects/ADE"],
        localProjectRootPath: null,
        boundRepoOriginUrl: "git@github.com:acme/ADE.git",
        recentProjects: [{
          rootPath: "/Users/admin/Projects/ADE",
          displayName: "ADE",
          exists: false,
          lastOpenedAt: "2026-07-27T00:00:00.000Z",
          gitOriginUrl: "https://github.com/acme/ADE.git",
        }],
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
