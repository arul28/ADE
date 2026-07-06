import { describe, expect, it, vi } from "vitest";

import { deeplinkToNavigationTarget, handleDeeplinkUrl } from "./protocolHandler";

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

  it("preserves session anchors and envelope", () => {
    expect(
      deeplinkToNavigationTarget({
        kind: "session",
        sessionId: "session-1",
        laneId: UUID,
        event: 41,
        envelope: { repoOwner: "a", repoName: "b", branch: "feat-x" },
      }),
    ).toEqual({
      kind: "work",
      sessionId: "session-1",
      laneId: UUID,
      envelope: { repoOwner: "a", repoName: "b", branch: "feat-x" },
      event: 41,
      offset: null,
    });
  });

  it("maps file targets", () => {
    expect(
      deeplinkToNavigationTarget({ kind: "file", path: "src/app.ts", line: 12, laneId: UUID }),
    ).toEqual({
      kind: "file",
      path: "src/app.ts",
      line: 12,
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
        target: { kind: "lane", laneId: UUID, envelope: null },
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
