/* @vitest-environment jsdom */
import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { LaneSummary } from "../../../shared/types";
import { LaneDriftPill } from "./CommitToolbarControls";

afterEach(cleanup);

function lane(overrides: Partial<LaneSummary> = {}): LaneSummary {
  return {
    id: "lane-1",
    laneType: "worktree",
    branchRef: "feature/x",
    baseRef: "main",
    status: {
      ahead: 4,
      behind: 17,
      dirty: false,
      remoteBehind: -1,
      rebaseInProgress: false,
      lastCommitAt: null,
    },
    ...overrides,
  } as LaneSummary;
}

function renderPill(target: LaneSummary | null, stale = false) {
  return render(createElement(MemoryRouter, null, createElement(LaneDriftPill, { lane: target, stale })));
}

function pill(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-testid="history-lane-drift"]');
}

describe("LaneDriftPill", () => {
  it("is absent when the lane's worktree is missing on this machine", () => {
    // The brain reports its 0/0 placeholder for a lane it cannot measure, which
    // must never read as "Even with main".
    const { container } = renderPill(lane({ worktreeAvailable: false }));
    expect(pill(container)).toBeNull();
  });

  it("shows the numbers quietly, never as current, when the status is unmeasured", () => {
    const { container } = renderPill(lane(), true);
    const element = pill(container);
    expect(element).not.toBeNull();
    expect(element?.textContent).toContain("4");
    expect(element?.textContent).toContain("17");
    expect(element?.getAttribute("data-stale")).toBe("true");
    expect(element?.className).toContain("opacity-50");
  });

  it("holds an unmeasured 0/0 place empty rather than reading as even with the base", () => {
    const { container } = renderPill(
      lane({
        status: {
          ahead: 0,
          behind: 0,
          dirty: false,
          remoteBehind: -1,
          rebaseInProgress: false,
          lastCommitAt: null,
        },
      }),
      true,
    );
    const element = pill(container);
    expect(element).not.toBeNull();
    expect(element?.className).toContain("invisible");
    expect(element?.getAttribute("aria-hidden")).toBe("true");
  });
});
