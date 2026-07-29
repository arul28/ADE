import { describe, expect, it, vi } from "vitest";

import type { AppNavigationRequest } from "../../../shared/types";
import { deeplinkToNavigationTarget, handleDeeplinkUrl } from "./protocolHandler";
import { selectWindowForProjectNavigation } from "./projectNavigationWindowSelection";
import {
  dispatchOwnerAwareNavigation,
  ownerNavigationFailureCopy,
} from "./ownerAwareNavigation";

const UUID = "550e8400-e29b-41d4-a716-446655440000";

describe("deeplinkToNavigationTarget", () => {
  it("maps lane targets", () => {
    expect(deeplinkToNavigationTarget({ kind: "lane", laneId: UUID })).toEqual({
      kind: "lane",
      laneId: UUID,
      envelope: null,
    });
  });

  it("maps session targets to the Work route", () => {
    expect(deeplinkToNavigationTarget({ kind: "session", sessionId: "session-1", laneId: UUID })).toEqual({
      kind: "work",
      sessionId: "session-1",
      laneId: UUID,
      envelope: null,
      event: null,
      offset: null,
    });
  });

  it("preserves exact session ownership for main-process routing", () => {
    expect(deeplinkToNavigationTarget({
      kind: "session",
      sessionId: "session-1",
      ownership: {
        accountMachineKey: "machine-b",
        projectId: "project-b",
      },
    })).toEqual({
      kind: "work",
      sessionId: "session-1",
      laneId: null,
      envelope: null,
      event: null,
      offset: null,
      ownership: {
        accountMachineKey: "machine-b",
        projectId: "project-b",
      },
    });
  });

  it("maps file targets", () => {
    expect(deeplinkToNavigationTarget({ kind: "file", path: "src/app.ts", line: 12, laneId: UUID })).toEqual({
      kind: "file",
      path: "src/app.ts",
      line: 12,
      laneId: UUID,
    });
  });

  it("maps commit targets", () => {
    expect(deeplinkToNavigationTarget({ kind: "commit", sha: "abc1234", laneId: UUID })).toEqual({
      kind: "commit",
      sha: "abc1234",
      laneId: UUID,
      envelope: null,
    });
  });

  it("maps artifact targets", () => {
    expect(deeplinkToNavigationTarget({ kind: "artifact", artifactId: "artifact-1" })).toEqual({
      kind: "artifact",
      artifactId: "artifact-1",
      envelope: null,
    });
  });

  it("maps pr targets with repo identity", () => {
    expect(
      deeplinkToNavigationTarget({
        kind: "pr",
        repoOwner: "a",
        repoName: "b",
        prNumber: 42,
      }),
    ).toEqual({
      kind: "pr",
      prNumber: 42,
      repoOwner: "a",
      repoName: "b",
    });
  });

  it("maps branch targets with optional pr number", () => {
    expect(
      deeplinkToNavigationTarget({
        kind: "branch",
        repoOwner: "a",
        repoName: "b",
        branch: "feat-x",
        prNumber: 7,
      }),
    ).toEqual({
      kind: "branch",
      repoOwner: "a",
      repoName: "b",
      branch: "feat-x",
      prNumber: 7,
    });
  });

  it("maps branch targets without pr number", () => {
    expect(
      deeplinkToNavigationTarget({
        kind: "branch",
        repoOwner: "a",
        repoName: "b",
        branch: "feat-x",
      }),
    ).toEqual({
      kind: "branch",
      repoOwner: "a",
      repoName: "b",
      branch: "feat-x",
      prNumber: null,
    });
  });
});

function ownedRequest(accountMachineKey = "machine-b"): AppNavigationRequest {
  return {
    source: "deeplink:open-url",
    target: {
      kind: "work",
      sessionId: "session-1",
      ownership: {
        accountMachineKey,
        projectId: "project-1",
      },
    },
  };
}

function ownerNavigationDependencies() {
  return {
    getLocalMachineKey: vi.fn(() => "machine-a"),
    resolveLocalProjectRoot: vi.fn(
      (_projectId: string): string | null => "/projects/one",
    ),
    deliverLocal: vi.fn(async () => undefined),
    findRemote: vi.fn((): unknown | null => null),
    openRemote: vi.fn(async () => ({ windowId: 2 })),
    deliverRemote: vi.fn(async () => undefined),
  };
}

describe("owner-aware navigation", () => {
  it("routes a local owner to its exact project instead of the focused window", async () => {
    const deps = ownerNavigationDependencies();
    await expect(dispatchOwnerAwareNavigation(ownedRequest("machine-a"), deps))
      .resolves.toBe(true);
    expect(deps.resolveLocalProjectRoot).toHaveBeenCalledWith("project-1");
    expect(deps.deliverLocal).toHaveBeenCalledWith(
      "/projects/one",
      ownedRequest("machine-a"),
    );
    expect(deps.openRemote).not.toHaveBeenCalled();
  });

  it("reuses an exact remote owner or opens that machine and project", async () => {
    const deps = ownerNavigationDependencies();
    const existing = { windowId: 7 };
    deps.findRemote.mockReturnValueOnce(existing);
    await dispatchOwnerAwareNavigation(ownedRequest(), deps);
    expect(deps.deliverRemote).toHaveBeenNthCalledWith(1, existing, ownedRequest());
    expect(deps.openRemote).not.toHaveBeenCalled();

    deps.findRemote.mockReturnValueOnce(null);
    await dispatchOwnerAwareNavigation(ownedRequest(), deps);
    expect(deps.openRemote).toHaveBeenCalledWith("machine-b", "project-1");
    expect(deps.deliverRemote).toHaveBeenNthCalledWith(
      2,
      { windowId: 2 },
      ownedRequest(),
    );
  });

  it("does not intercept ordinary machine-unscoped deeplinks", async () => {
    const deps = ownerNavigationDependencies();
    await expect(dispatchOwnerAwareNavigation({
      source: "deeplink:open-url",
      target: { kind: "pr", repoOwner: "openai", repoName: "ade", prNumber: 42 },
    }, deps)).resolves.toBe(false);
    expect(deps.deliverLocal).not.toHaveBeenCalled();
    expect(deps.deliverRemote).not.toHaveBeenCalled();
  });

  it("fails closed when the exact owning local project is unavailable", async () => {
    const deps = ownerNavigationDependencies();
    deps.resolveLocalProjectRoot.mockReturnValue(null);
    await expect(dispatchOwnerAwareNavigation(ownedRequest("machine-a"), deps))
      .rejects.toThrow("Project project-1 is no longer available");
    expect(deps.deliverLocal).not.toHaveBeenCalled();
    expect(deps.deliverRemote).not.toHaveBeenCalled();
  });

  it.each([
    {
      error: "Remote ADE service 1.2.41 does not support machine projects.",
      title: "Update the owning ADE machine",
      recovery: "Update and restart ADE on that host",
    },
    {
      error: "Connection timed out.",
      title: "Owning machine unavailable",
      recovery: "Reconnect that machine from Connections",
    },
    {
      error: "Project project-1 is no longer available on this ADE machine.",
      title: "Project no longer available",
      recovery: "Open or restore the project on that machine",
    },
  ])("provides actionable recovery copy for $title", ({ error, title, recovery }) => {
    const copy = ownerNavigationFailureCopy(new Error(error));
    expect(copy.title).toBe(title);
    expect(copy.detail).toContain(error);
    expect(copy.detail).toContain(recovery);
  });
});

describe("handleDeeplinkUrl", () => {
  it("dispatches valid URLs", () => {
    const dispatch = vi.fn();
    const log = vi.fn();
    handleDeeplinkUrl(`ade://lane/${UUID}`, "test", dispatch, log);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { kind: "lane", laneId: UUID, envelope: null },
        source: "deeplink:test",
      }),
    );
  });

  it("dispatches owner-scoped Attention links with exact routing metadata", () => {
    const dispatch = vi.fn();
    handleDeeplinkUrl(
      "ade://pr/openai/ade/42?tab=checks&accountMachineKey=machine-b&projectId=project-b",
      "test",
      dispatch,
    );
    expect(dispatch).toHaveBeenCalledWith({
      source: "deeplink:test",
      target: {
        kind: "pr",
        prNumber: 42,
        repoOwner: "openai",
        repoName: "ade",
        detailTab: "checks",
        ownership: {
          accountMachineKey: "machine-b",
          projectId: "project-b",
        },
      },
    });
  });

  it("logs and skips dispatching invalid URLs", () => {
    const dispatch = vi.fn();
    const log = vi.fn();
    handleDeeplinkUrl("ade://lane/not-a-uuid", "test", dispatch, log);
    expect(dispatch).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "deeplink.parse_failed",
      expect.objectContaining({ source: "test" }),
    );
  });

  it("dispatches https mirror URLs", () => {
    const dispatch = vi.fn();
    handleDeeplinkUrl(
      "https://ade-app.dev/open?type=branch&repo=a/b&branch=feat",
      "test",
      dispatch,
    );
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { kind: "branch", repoOwner: "a", repoName: "b", branch: "feat", prNumber: null },
      }),
    );
  });

  it("still dispatches legacy https mirror URLs", () => {
    const dispatch = vi.fn();
    handleDeeplinkUrl(
      "https://ade.app/open?type=branch&repo=a/b&branch=feat",
      "test",
      dispatch,
    );
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { kind: "branch", repoOwner: "a", repoName: "b", branch: "feat", prNumber: null },
      }),
    );
  });
});

/**
 * Regression guard for iOS sync deeplink routing: navigation must target the
 * sync-host project window, not the globally focused window.
 */
describe("project-scoped deeplink dispatch contract", () => {
  it("prefers project-root dispatch over focused-window dispatch for sync:ios", () => {
    const focusedDispatch = vi.fn();
    const projectDispatch = vi.fn();
    let dispatchAppNavigationForProjectRoot:
      | ((targetProjectRoot: string, request: AppNavigationRequest) => void)
      | null = projectDispatch;

    const projectRoot = "/projects/beta";
    const request: AppNavigationRequest = {
      target: { kind: "lane", laneId: "lane-in-beta" },
      source: "deeplink:sync:ios",
    };

    const dispatchSyncDeeplink = (req: AppNavigationRequest) => {
      if (dispatchAppNavigationForProjectRoot) {
        dispatchAppNavigationForProjectRoot(projectRoot, req);
        return;
      }
      focusedDispatch(req);
    };

    dispatchSyncDeeplink(request);

    expect(projectDispatch).toHaveBeenCalledWith(projectRoot, request);
    expect(focusedDispatch).not.toHaveBeenCalled();
  });

  it("falls back to focused-window dispatch when project dispatch is unavailable", () => {
    const focusedDispatch = vi.fn();
    const getProjectDispatch = ():
      | ((targetProjectRoot: string, request: AppNavigationRequest) => void)
      | null => null;

    const request: AppNavigationRequest = {
      target: { kind: "lane", laneId: "lane-1" },
      source: "deeplink:sync:ios",
    };

    const dispatchSyncDeeplink = (req: AppNavigationRequest) => {
      const projectDispatch = getProjectDispatch();
      if (projectDispatch) {
        projectDispatch("/projects/beta", req);
        return;
      }
      focusedDispatch(req);
    };

    dispatchSyncDeeplink(request);

    expect(focusedDispatch).toHaveBeenCalledWith(request);
  });

  it("activates an existing project tab before opening a duplicate window", async () => {
    const activeProjectRoots = new Map<number, string | null>([[1, "/projects/alpha"]]);
    const openProjectTabRoots = new Map<number, Set<string>>([
      [1, new Set(["/projects/alpha", "/projects/beta"])],
    ]);
    const activateProjectTab = vi.fn((windowId: number, root: string) => {
      activeProjectRoots.set(windowId, root);
    });
    const openWindow = vi.fn(async (root: string) => {
      activeProjectRoots.set(2, root);
      openProjectTabRoots.set(2, new Set([root]));
      return 2;
    });

    const deliverToProject = async (targetProjectRoot: string): Promise<number> => {
      const selection = selectWindowForProjectNavigation(
        targetProjectRoot,
        [...activeProjectRoots].map(([id, root]) => ({
          id,
          activeProjectRoot: root,
          openProjectRoots: openProjectTabRoots.get(id) ?? new Set<string>(),
        })),
      );
      if (selection) {
        if (selection.activateProjectRoot) {
          activateProjectTab(selection.windowId, targetProjectRoot);
        }
        return selection.windowId;
      }
      return await openWindow(targetProjectRoot);
    };

    await expect(deliverToProject("/projects/beta")).resolves.toBe(1);
    expect(activateProjectTab).toHaveBeenCalledWith(1, "/projects/beta");
    expect(openWindow).not.toHaveBeenCalled();
  });
});
