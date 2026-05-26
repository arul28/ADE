import { describe, expect, it, vi } from "vitest";
import type { AppNavigationRequest } from "../../../shared/types";
import { selectWindowForProjectNavigation } from "./projectNavigationWindowSelection";

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
