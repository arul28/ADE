import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildPrsRouteSearch,
  parsePrsRouteState,
  prRouteCoordinatesEqual,
  prRouteCoordinatesKey,
  prRouteTargetsEqual,
  readStoredPrsRoute,
  resolvePrsActiveTab,
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
        hash: "#/prs?tab=workflows&workflow=integration",
      }),
    ).toEqual({
      tab: "workflows",
      workflowTab: "integration",
      laneId: null,
      prId: null,
      prNumber: null,
      repoOwner: null,
      repoName: null,
      eventId: null,
      threadId: null,
      commitSha: null,
      detailTab: null,
    });
  });

  it("reads route state from hash query strings when search params are absent", () => {
    expect(
      parsePrsRouteState({
        search: "",
        hash: "#/prs?tab=workflows&workflow=rebase&laneId=lane-456&prId=pr-789",
      }),
    ).toEqual({
      tab: "workflows",
      workflowTab: "rebase",
      laneId: "lane-456",
      prId: "pr-789",
      prNumber: null,
      repoOwner: null,
      repoName: null,
      eventId: null,
      threadId: null,
      commitSha: null,
      detailTab: null,
    });
  });

  it("parses deep-link event, thread, commit, and detail tab params", () => {
    expect(
      parsePrsRouteState({
        search: "?tab=normal&prId=pr-1&eventId=evt-99&threadId=thr-12&commitSha=abc123&detailTab=files",
      }),
    ).toEqual({
      tab: "normal",
      workflowTab: null,
      laneId: null,
      prId: "pr-1",
      prNumber: null,
      repoOwner: null,
      repoName: null,
      eventId: "evt-99",
      threadId: "thr-12",
      commitSha: "abc123",
      detailTab: "files",
    });
  });

  it("builds search with deep-link params", () => {
    expect(
      buildPrsRouteSearch({
        activeTab: "normal",
        selectedPrId: "pr-1",
        selectedRebaseItemId: null,
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
      selectedRebaseItemId: null,
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

  it("builds normal and workflow route searches with the expected ids", () => {
    expect(
      buildPrsRouteSearch({
        activeTab: "normal",
        selectedPrId: "pr-123",
        selectedRebaseItemId: "lane-ignored",
      }),
    ).toBe("?tab=normal&prId=pr-123");

    expect(
      buildPrsRouteSearch({
        activeTab: "rebase",
        selectedPrId: "pr-123",
        selectedRebaseItemId: "lane-456",
      }),
    ).toBe("?tab=workflows&workflow=rebase&laneId=lane-456");
  });

  it("stores the last PRs route per project without falling back across projects", () => {
    writeStoredPrsRoute("/prs?tab=normal&prId=project-a", "/tmp/project-a");
    writeStoredPrsRoute("/prs?tab=normal&prId=project-b", "/tmp/project-b");
    writeStoredPrsRoute("/files", "/tmp/project-b");
    writeStoredPrsRoute("/prs?tab=workflows&workflow=integration");

    expect(readStoredPrsRoute("/tmp/project-a")).toBe("/prs?tab=normal&prId=project-a");
    expect(readStoredPrsRoute("/tmp/project-b")).toBe("/prs?tab=normal&prId=project-b");
    expect(readStoredPrsRoute("/tmp/project-c")).toBeNull();
    expect(readStoredPrsRoute()).toBe("/prs?tab=workflows&workflow=integration");
  });
});

describe("resolvePrsActiveTab", () => {
  it("routes a stale tab=normal + hash workflow=rebase to the rebase workflow", () => {
    const parsed = parsePrsRouteState({
      search: "?tab=normal",
      hash: "#/prs?tab=workflows&workflow=rebase&laneId=lane-1",
    });
    const resolved = resolvePrsActiveTab(parsed);
    expect(resolved.isWorkflowRoute).toBe(true);
    expect(resolved.effectiveWorkflow).toBe("rebase");
    expect(resolved.activeTab).toBe("rebase");
  });

  it("falls back to integration when tab=workflows has no workflow param", () => {
    const parsed = parsePrsRouteState({ search: "?tab=workflows" });
    const resolved = resolvePrsActiveTab(parsed);
    expect(resolved.isWorkflowRoute).toBe(true);
    expect(resolved.effectiveWorkflow).toBeNull();
    expect(resolved.activeTab).toBe("integration");
  });

  it("keeps tab=normal on the normal tab when no workflow signal is present", () => {
    const parsed = parsePrsRouteState({ search: "?tab=normal&prId=pr-1" });
    const resolved = resolvePrsActiveTab(parsed);
    expect(resolved.isWorkflowRoute).toBe(false);
    expect(resolved.activeTab).toBe("normal");
  });

  it("returns normal when the route has no tab or workflow signal", () => {
    const parsed = parsePrsRouteState({ search: "" });
    const resolved = resolvePrsActiveTab(parsed);
    expect(resolved.isWorkflowRoute).toBe(false);
    expect(resolved.activeTab).toBe("normal");
  });

  it("keeps legacy prId-only routes on the normal PR surface", () => {
    const parsed = parsePrsRouteState({ search: "?prId=pr-123" });
    const resolved = resolvePrsActiveTab(parsed);
    expect(parsed.prId).toBe("pr-123");
    expect(parsed.tab).toBeNull();
    expect(resolved.isWorkflowRoute).toBe(false);
    expect(resolved.activeTab).toBe("normal");
  });

  it("prefers the hash workflow over a stale outer search workflow (BrowserRouter mock mode)", () => {
    // Outer URL like `/?tab=workflows&workflow=integration#/prs?tab=workflows&workflow=rebase`
    // In BrowserRouter mock mode the outer search is stale; the inner hash is the
    // current in-app location and must win.
    const parsed = parsePrsRouteState({
      search: "?tab=workflows&workflow=integration",
      hash: "#/prs?tab=workflows&workflow=rebase",
    });
    expect(parsed.workflowTab).toBe("rebase");
    const resolved = resolvePrsActiveTab(parsed);
    expect(resolved.isWorkflowRoute).toBe(true);
    expect(resolved.effectiveWorkflow).toBe("rebase");
    expect(resolved.activeTab).toBe("rebase");
  });

  it("keeps hash lane ids with the hash workflow when outer search is stale", () => {
    const parsed = parsePrsRouteState({
      search: "?tab=workflows&workflow=rebase&laneId=old",
      hash: "#/prs?tab=workflows&workflow=rebase&laneId=new",
    });
    expect(parsed.workflowTab).toBe("rebase");
    expect(parsed.laneId).toBe("new");
  });

  it("defaults a bare hash workflows route to integration even when outer search says normal", () => {
    const parsed = parsePrsRouteState({
      search: "?tab=normal",
      hash: "#/prs?tab=workflows",
    });
    const resolved = resolvePrsActiveTab(parsed);
    expect(parsed.tab).toBe("workflows");
    expect(resolved.isWorkflowRoute).toBe(true);
    expect(resolved.activeTab).toBe("integration");
  });

  it("ignores invalid hash route signals instead of dropping valid search params", () => {
    const parsed = parsePrsRouteState({
      search: "?tab=normal&prId=pr-123",
      hash: "#/prs?tab=bogus",
    });
    const resolved = resolvePrsActiveTab(parsed);
    expect(parsed.tab).toBe("normal");
    expect(parsed.prId).toBe("pr-123");
    expect(resolved.isWorkflowRoute).toBe(false);
    expect(resolved.activeTab).toBe("normal");
  });
});
