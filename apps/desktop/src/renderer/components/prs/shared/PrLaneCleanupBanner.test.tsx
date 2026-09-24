/* @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LaneSummary } from "../../../../shared/types";
import { PrLaneCleanupBanner } from "./PrLaneCleanupBanner";

const pr = {
  id: "pr-1",
  state: "merged" as const,
  headBranch: "feature/ready",
  baseBranch: "main",
};

function lane(overrides: Partial<LaneSummary> = {}): LaneSummary {
  return {
    id: "lane-1",
    name: "Feature lane",
    laneType: "worktree",
    baseRef: "main",
    branchRef: "feature/ready",
    worktreePath: "/tmp/feature-ready",
    parentLaneId: null,
    childCount: 0,
    stackDepth: 0,
    parentStatus: null,
    isEditProtected: false,
    status: { dirty: false } as LaneSummary["status"],
    color: null,
    icon: null,
    tags: [],
    createdAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

afterEach(cleanup);

describe("PrLaneCleanupBanner", () => {
  it("uses an inline warning banner for the Primary branch mismatch flow", () => {
    render(
      <PrLaneCleanupBanner
        pr={pr}
        lane={lane({ laneType: "primary", branchRef: "main", name: "Primary" })}
        onNavigate={vi.fn()}
      />,
    );

    const title = screen.getByText("PR is linked to Primary, but its branch is separate");
    const banner = title.closest('[data-banner-layout="inline"]');
    expect(banner?.getAttribute("data-notice-tone")).toBe("warning");
    expect(screen.getByText("ADE will not delete the Primary lane. You can clean up the PR branch instead.")).toBeTruthy();
    expect(screen.getByText("merged")).toBeTruthy();
  });

  it("uses the shared success banner and preserves the lane navigation action", () => {
    const onNavigate = vi.fn();
    render(<PrLaneCleanupBanner pr={pr} lane={lane({ status: { dirty: true } as LaneSummary["status"] })} onNavigate={onNavigate} />);

    const banner = screen.getByText("Manage Lane: Feature lane").closest('[data-banner-layout="inline"]');
    expect(banner?.getAttribute("data-notice-tone")).toBe("success");
    expect(screen.getByText("PR merged")).toBeTruthy();
    expect(screen.getByText("dirty")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "View in Lanes" }));
    expect(onNavigate).toHaveBeenCalledWith("/lanes?laneId=lane-1");
  });
});
