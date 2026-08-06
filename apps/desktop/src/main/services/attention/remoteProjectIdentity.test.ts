import { describe, expect, it } from "vitest";

import {
  matchRemoteProjectByRootPath,
  remoteProjectRootPathsMatch,
} from "./remoteProjectIdentity";

describe("remoteProjectRootPathsMatch", () => {
  it("ignores trailing separators and redundant segments", () => {
    expect(remoteProjectRootPathsMatch("/Users/arul/ADE/", "/Users/arul/ADE")).toBe(true);
    expect(remoteProjectRootPathsMatch("/Users/arul/x/../ADE", "/Users/arul/ADE")).toBe(true);
  });

  it("matches the owning machine's Windows spellings regardless of this host", () => {
    expect(remoteProjectRootPathsMatch("C:\\Users\\arul\\ADE", "c:/users/arul/ade")).toBe(true);
    expect(remoteProjectRootPathsMatch("\\\\server\\share\\repo\\", "\\\\server\\share\\repo"))
      .toBe(true);
  });

  it("rejects different projects and empty input", () => {
    expect(remoteProjectRootPathsMatch("/Users/arul/ADE", "/Users/arul/ADE-old")).toBe(false);
    expect(remoteProjectRootPathsMatch("", "/Users/arul/ADE")).toBe(false);
    expect(remoteProjectRootPathsMatch(null, undefined)).toBe(false);
  });
});

describe("matchRemoteProjectByRootPath", () => {
  const candidates = [
    { projectId: "project_a", rootPath: "/Users/arul/Projects/ADE" },
    { projectId: "project_b", rootPath: "/Users/arul/Projects/Other" },
  ];

  it("resolves an exact root path", () => {
    expect(matchRemoteProjectByRootPath(candidates, "/Users/arul/Projects/ADE/"))
      .toMatchObject({ projectId: "project_a" });
  });

  it("accepts a case-folded match when it is the only one", () => {
    expect(matchRemoteProjectByRootPath(candidates, "/users/arul/projects/ade"))
      .toMatchObject({ projectId: "project_a" });
  });

  it("refuses to guess between siblings that differ only by case", () => {
    const ambiguous = [
      { projectId: "project_a", rootPath: "/srv/ADE" },
      { projectId: "project_b", rootPath: "/srv/ade" },
    ];
    // An exact spelling still wins outright…
    expect(matchRemoteProjectByRootPath(ambiguous, "/srv/ade"))
      .toMatchObject({ projectId: "project_b" });
    // …but a spelling that matches neither exactly resolves to nothing rather
    // than opening whichever repo happened to be listed first.
    expect(matchRemoteProjectByRootPath(ambiguous, "/srv/AdE")).toBeNull();
  });

  it("returns null without a root path to match", () => {
    expect(matchRemoteProjectByRootPath(candidates, "")).toBeNull();
    expect(matchRemoteProjectByRootPath(candidates, null)).toBeNull();
    expect(matchRemoteProjectByRootPath([], "/Users/arul/Projects/ADE")).toBeNull();
  });
});
