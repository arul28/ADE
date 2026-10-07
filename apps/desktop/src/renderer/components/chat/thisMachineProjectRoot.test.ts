import { describe, expect, it } from "vitest";
import {
  projectOnOtherMachine,
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

  it("accepts the same absolute checkout path when it belongs to another machine", () => {
    expect(
      resolveThisMachineProjectRoot({
        projectBinding: remoteBinding,
        openProjectTabRoots: [remoteBinding.rootPath],
        localProjectRootPath: null,
        boundRepoOriginUrl: "git@github.com:acme/ADE.git",
        recentProjects: [{
          rootPath: remoteBinding.rootPath,
          displayName: "ADE",
          exists: true,
          lastOpenedAt: "2026-07-27T00:00:00.000Z",
          gitOriginUrl: "https://github.com/acme/ADE.git",
        }],
      }),
    ).toEqual({ ok: true, rootPath: remoteBinding.rootPath });
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

  it("does not trust a matching absolute path without verified origin identity", () => {
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

describe("projectOnOtherMachine", () => {
  const ORIGIN = "git@github.com:arul28/ADE.git";
  const sameRepo = { projectId: "ade-studio", gitOriginUrl: "https://github.com/arul28/ADE" };
  const otherRepo = { projectId: "other", gitOriginUrl: "git@github.com:arul28/other.git" };

  it.each([
    { name: "binds the same repository on that machine", origin: ORIGIN, openTab: "other", projects: [otherRepo, sameRepo], expected: "ade-studio" },
    { name: "falls back to a project of that machine already open in a tab", origin: ORIGIN, openTab: "other", projects: [otherRepo], expected: "other" },
    { name: "never opens an unrelated repository", origin: ORIGIN, openTab: null, projects: [otherRepo], expected: null },
    { name: "takes any project when this window's repository is unknown", origin: null, openTab: null, projects: [otherRepo], expected: "other" },
    { name: "has nothing to bind on a machine with no projects", origin: null, openTab: null, projects: [], expected: null },
  ])("$name", ({ origin, openTab, projects, expected }) => {
    expect(projectOnOtherMachine({
      currentOrigin: origin,
      openTabProjectId: openTab,
      machineProjects: projects,
    })).toBe(expected);
  });
});
