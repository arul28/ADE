import { describe, expect, it, vi } from "vitest";

import { deeplinkToNavigationTarget, handleDeeplinkUrl } from "./protocolHandler";

const UUID = "550e8400-e29b-41d4-a716-446655440000";

describe("deeplinkToNavigationTarget", () => {
  it("maps lane targets", () => {
    expect(deeplinkToNavigationTarget({ kind: "lane", laneId: UUID })).toEqual({
      kind: "lane",
      laneId: UUID,
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

describe("handleDeeplinkUrl", () => {
  it("dispatches valid URLs", () => {
    const dispatch = vi.fn();
    const log = vi.fn();
    handleDeeplinkUrl(`ade://lane/${UUID}`, "test", dispatch, log);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { kind: "lane", laneId: UUID },
        source: "deeplink:test",
      }),
    );
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
