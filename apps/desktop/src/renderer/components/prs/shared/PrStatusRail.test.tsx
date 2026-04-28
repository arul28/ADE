// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { PrStatusRail } from "./PrStatusRail";
import type { PrCheck, PrDeployment } from "../../../../shared/types/prs";

afterEach(cleanup);

function makeCheck(overrides: Partial<PrCheck> = {}): PrCheck {
  return {
    name: "ci / test",
    status: "completed",
    conclusion: "success",
    detailsUrl: "https://example.com/runs/1",
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    completedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeDeployment(overrides: Partial<PrDeployment> = {}): PrDeployment {
  return {
    id: "dep-1",
    environment: "preview",
    state: "success",
    description: "Deployed preview",
    environmentUrl: "https://preview.example.com",
    logUrl: "https://vercel.com/inspector",
    sha: null,
    ref: null,
    creator: "vercel[bot]",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("PrStatusRail", () => {
  it("renders the three sections with empty messages when data is absent", () => {
    render(
      <PrStatusRail
        checks={[]}
        deployments={[]}
        mergeState={{
          mergeable: "unknown",
          hasConflicts: false,
          approvals: 0,
          requiredApprovals: null,
          failingChecks: 0,
          pendingChecks: 0,
          githubUrl: null,
        }}
        onOpenLog={() => {}}
        onOpenExternal={() => {}}
      />,
    );
    expect(screen.getByText(/No checks have reported/i)).toBeTruthy();
    expect(screen.getByText(/No active deployments/i)).toBeTruthy();
  });

  it("groups checks by provider and triggers onOpenLog when logs button is clicked", () => {
    const openLog = vi.fn();
    render(
      <PrStatusRail
        checks={[
          makeCheck({ name: "ci/lint" }),
          makeCheck({ name: "codeql-analysis" }),
          makeCheck({ name: "greptile-review" }),
        ]}
        deployments={[]}
        mergeState={{
          mergeable: "clean",
          hasConflicts: false,
          approvals: 2,
          requiredApprovals: 1,
          failingChecks: 0,
          pendingChecks: 0,
          githubUrl: "https://github.com/example/repo/pull/1",
        }}
        onOpenLog={openLog}
        onOpenExternal={() => {}}
      />,
    );
    expect(screen.getAllByTestId("pr-status-rail-check-row")).toHaveLength(3);
    const btns = screen.getAllByLabelText(/View logs/);
    fireEvent.click(btns[0]!);
    expect(openLog).toHaveBeenCalled();
  });

  it("renders deployment cards when deployments are present", () => {
    render(
      <PrStatusRail
        checks={[]}
        deployments={[makeDeployment(), makeDeployment({ id: "dep-2", environment: "staging" })]}
        mergeState={{
          mergeable: "clean",
          hasConflicts: false,
          approvals: 0,
          requiredApprovals: null,
          failingChecks: 0,
          pendingChecks: 0,
          githubUrl: null,
        }}
        onOpenLog={() => {}}
        onOpenExternal={() => {}}
      />,
    );
    expect(screen.getAllByTestId("pr-deployment-card")).toHaveLength(2);
  });

  it("opens merge page externally when Merge on GitHub is clicked", () => {
    const openExternal = vi.fn();
    render(
      <PrStatusRail
        checks={[]}
        deployments={[]}
        mergeState={{
          mergeable: "clean",
          hasConflicts: false,
          approvals: 1,
          requiredApprovals: 1,
          failingChecks: 0,
          pendingChecks: 0,
          githubUrl: "https://github.com/example/repo/pull/1",
        }}
        onOpenLog={() => {}}
        onOpenExternal={openExternal}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Merge on GitHub/i }));
    expect(openExternal).toHaveBeenCalledWith("https://github.com/example/repo/pull/1");
  });
});
