import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildPrsRouteSearch,
  parsePrsRouteState,
  prRouteCoordinatesEqual,
  prRouteCoordinatesKey,
  prRouteTargetsEqual,
  readStoredPrsRoute,
  writeStoredPrsRoute,
} from "./prsRouteState";

describe("prsRouteState", () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        clear: () => storage.clear(),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("treats a hash PR route as authoritative over stale outer search params", () => {
    expect(
      parsePrsRouteState({
        search: "?tab=normal&prId=pr-123&laneId=lane-search",
        hash: "#/prs?tab=github",
      }),
    ).toEqual({
      tab: "github",
      laneId: null,
      prId: null,
      prNumber: null,
      repoOwner: null,
      repoName: null,
      eventId: null,
      threadId: null,
      commitSha: null,
      detailTab: null,
      githubSort: null,
    });
  });

  it("reads route state from hash query strings when search params are absent", () => {
    expect(
      parsePrsRouteState({
        search: "",
        hash: "#/prs?tab=normal&laneId=lane-456&prId=pr-789",
      }),
    ).toEqual({
      tab: "normal",
      laneId: "lane-456",
      prId: "pr-789",
      prNumber: null,
      repoOwner: null,
      repoName: null,
      eventId: null,
      threadId: null,
      commitSha: null,
      detailTab: null,
      githubSort: null,
    });
  });

  it("parses deep-link event, thread, commit, and detail tab params", () => {
    expect(
      parsePrsRouteState({
        search: "?tab=normal&prId=pr-1&eventId=evt-99&threadId=thr-12&commitSha=abc123&detailTab=files",
      }),
    ).toEqual({
      tab: "normal",
      laneId: null,
      prId: "pr-1",
      prNumber: null,
      repoOwner: null,
      repoName: null,
      eventId: "evt-99",
      threadId: "thr-12",
      commitSha: "abc123",
      detailTab: "files",
      githubSort: null,
    });
  });

  it("builds search with deep-link params", () => {
    expect(
      buildPrsRouteSearch({
        activeTab: "normal",
        selectedPrId: "pr-1",
        eventId: "evt-5",
        threadId: "thr-3",
        commitSha: "abc",
        detailTab: "checks",
      }),
    ).toBe("?tab=normal&prId=pr-1&eventId=evt-5&threadId=thr-3&commitSha=abc&detailTab=checks");
  });

  it("parses PR number handoff routes", () => {
    const parsed = parsePrsRouteState({ search: "?tab=normal&pr=123&laneId=lane-1" });
    expect(parsed.prNumber).toBe(123);
    expect(parsed.prId).toBeNull();
    expect(parsed.laneId).toBe("lane-1");
  });

  it("keeps repository coordinates with a PR number handoff", () => {
    expect(parsePrsRouteState({
      search: "?tab=normal&pr=123&repoOwner=ade-dev&repoName=ade",
    })).toMatchObject({
      prNumber: 123,
      repoOwner: "ade-dev",
      repoName: "ade",
    });
    expect(buildPrsRouteSearch({
      activeTab: "normal",
      selectedPrId: null,
      selectedPrNumber: 123,
      repoOwner: "ade-dev",
      repoName: "ade",
    })).toBe("?tab=normal&pr=123&repoOwner=ade-dev&repoName=ade");
  });

  it("uses one case-insensitive canonical coordinate identity", () => {
    const uppercase = { prNumber: 123, repoOwner: "ADE-DEV", repoName: "ADE" };
    const lowercase = { prNumber: 123, repoOwner: "ade-dev", repoName: "ade" };

    expect(prRouteCoordinatesKey(uppercase)).toBe("ade-dev/ade#123");
    expect(prRouteCoordinatesEqual(uppercase, lowercase)).toBe(true);
    expect(prRouteTargetsEqual(
      { prId: "pr-123", ...uppercase },
      { prId: "pr-123", ...lowercase },
    )).toBe(true);
  });

  it("stores the last PRs route per project without falling back across projects", () => {
    writeStoredPrsRoute("/prs?tab=normal&prId=project-a", "/tmp/project-a");
    writeStoredPrsRoute("/prs?tab=normal&prId=project-b", "/tmp/project-b");
    writeStoredPrsRoute("/files", "/tmp/project-b");
    writeStoredPrsRoute("/prs?tab=normal&prId=unscoped");

    expect(readStoredPrsRoute("/tmp/project-a")).toBe("/prs?tab=normal&prId=project-a");
    expect(readStoredPrsRoute("/tmp/project-b")).toBe("/prs?tab=normal&prId=project-b");
    expect(readStoredPrsRoute("/tmp/project-c")).toBeNull();
    expect(readStoredPrsRoute()).toBe("/prs?tab=normal&prId=unscoped");
  });
});

describe("parsePrsRouteState tab signals", () => {
  it("keeps legacy prId-only routes on the GitHub view", () => {
    const parsed = parsePrsRouteState({ search: "?prId=pr-123" });
    expect(parsed.prId).toBe("pr-123");
    expect(parsed.tab).toBeNull();
  });

  it.each([
    ["an old Workflows link", "#/prs?tab=workflows&workflow=rebase&laneId=lane-1"],
    ["an unknown tab", "#/prs?tab=bogus"],
  ])("ignores %s in the hash instead of dropping valid search params", (_label, hash) => {
    const parsed = parsePrsRouteState({ search: "?tab=normal&prId=pr-123", hash });
    expect(parsed.tab).toBe("normal");
    expect(parsed.prId).toBe("pr-123");
  });
});
