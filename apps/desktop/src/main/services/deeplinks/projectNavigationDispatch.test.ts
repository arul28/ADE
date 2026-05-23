import { describe, expect, it, vi } from "vitest";
import type { AppNavigationRequest } from "../../../shared/types";

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
    const dispatchAppNavigationForProjectRoot = null;

    const request: AppNavigationRequest = {
      target: { kind: "lane", laneId: "lane-1" },
      source: "deeplink:sync:ios",
    };

    const dispatchSyncDeeplink = (req: AppNavigationRequest) => {
      if (dispatchAppNavigationForProjectRoot) {
        dispatchAppNavigationForProjectRoot("/projects/beta", req);
        return;
      }
      focusedDispatch(req);
    };

    dispatchSyncDeeplink(request);

    expect(focusedDispatch).toHaveBeenCalledWith(request);
  });
});
