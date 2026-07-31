// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { LaneLinearIssue, LaneSummary } from "../../../shared/types";

function renderWithRouter(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

function makeLane(overrides: Partial<LaneSummary> = {}): LaneSummary {
  return {
    id: "lane-1",
    name: "lane",
    laneType: "worktree",
    baseRef: "origin/main",
    branchRef: "feature/lane",
    worktreePath: "/tmp/lane-1",
    parentLaneId: null,
    childCount: 0,
    stackDepth: 0,
    parentStatus: null,
    isEditProtected: false,
    status: { dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false },
    color: null,
    icon: null,
    tags: [],
    createdAt: "2026-03-23T12:00:00.000Z",
    ...overrides,
  };
}

function makeLinearIssue(overrides: Partial<LaneLinearIssue> = {}): LaneLinearIssue {
  return {
    id: "issue-1",
    identifier: "ADE-123",
    title: "Connect Linear issue dropdown",
    description: "Let PRs link back to Linear.",
    url: "https://linear.app/ade/issue/ADE-123/connect-linear-issue-dropdown",
    projectId: "project-1",
    projectSlug: "ade",
    projectName: "ADE",
    teamId: "team-1",
    teamKey: "ADE",
    teamName: "ADE",
    stateId: "state-1",
    stateName: "In Progress",
    stateType: "started",
    priority: 2,
    priorityLabel: "high",
    labels: ["desktop"],
    assigneeId: "user-1",
    assigneeName: "Arul",
    creatorId: "user-2",
    creatorName: "Annie",
    dueDate: null,
    estimate: null,
    branchName: "ade-123-connect-linear-issue-dropdown",
    createdAt: "2026-05-08T00:00:00.000Z",
    updatedAt: "2026-05-08T00:00:00.000Z",
    ...overrides,
  };
}

const mockLanes: LaneSummary[] = [
  makeLane({
    id: "lane-primary",
    name: "main",
    laneType: "primary",
    branchRef: "main",
    worktreePath: "/tmp/main",
    childCount: 2,
  }),
  makeLane({
    id: "lane-1",
    name: "01 parent lane",
    branchRef: "feature/parent",
    worktreePath: "/tmp/lane-1",
    parentLaneId: "lane-primary",
    stackDepth: 1,
    status: { dirty: false, ahead: 1, behind: 0, remoteBehind: 0, rebaseInProgress: false },
    createdAt: "2026-03-23T12:01:00.000Z",
  }),
  makeLane({
    id: "lane-2",
    name: "02 sibling lane",
    branchRef: "feature/sibling",
    worktreePath: "/tmp/lane-2",
    parentLaneId: "lane-primary",
    stackDepth: 1,
    status: { dirty: false, ahead: 2, behind: 0, remoteBehind: 0, rebaseInProgress: false },
    createdAt: "2026-03-23T12:02:00.000Z",
  }),
  makeLane({
    id: "lane-linear",
    name: "Linear linked lane",
    branchRef: "ade-123-connect-linear-issue-dropdown",
    worktreePath: "/tmp/lane-linear",
    parentLaneId: "lane-primary",
    stackDepth: 1,
    status: { dirty: false, ahead: 3, behind: 0, remoteBehind: 0, rebaseInProgress: false },
    linearIssue: makeLinearIssue(),
    createdAt: "2026-05-08T12:02:00.000Z",
  }),
];

vi.mock("../../state/appStore", () => ({
  useAppStore: (selector: (state: { lanes: LaneSummary[] }) => unknown) => selector({ lanes: mockLanes }),
}));

import { CreatePrModal } from "./CreatePrModal";

describe("CreatePrModal", () => {
  const originalAde = globalThis.window.ade;
  const createFromLane = vi.fn();

  beforeEach(() => {
    createFromLane.mockReset();
    createFromLane.mockResolvedValue({
      id: "pr-1",
      laneId: "lane-1",
      provider: "github",
      number: 1,
      title: "Parent lane",
      body: "",
      state: "open",
      url: "https://example.test/pr/1",
      headBranch: "feature/parent",
      baseBranch: "main",
      mergeable: true,
      draft: false,
      updatedAt: "2026-03-23T12:30:00.000Z",
    });

    globalThis.window.ade = {
      prs: {
        createFromLane,
        listAll: vi.fn().mockResolvedValue([]),
      },
      git: {
        getSyncStatus: vi.fn().mockResolvedValue(null),
        listBranches: vi.fn().mockResolvedValue([
          { name: "main", isCurrent: true, isRemote: false, upstream: "origin/main" },
          { name: "develop", isCurrent: false, isRemote: false, upstream: "origin/develop" },
          { name: "release-9", isCurrent: false, isRemote: false, upstream: null },
        ]),
      },
    } as any;
  });

  afterEach(() => {
    globalThis.window.ade = originalAde;
    cleanup();
  });

  it("lets single-PR creation target a different branch than Primary's current branch", async () => {
    const user = userEvent.setup();
    renderWithRouter(<CreatePrModal open onOpenChange={vi.fn()} />);

    // Select source lane
    const comboboxes = screen.getAllByRole("combobox");
    await user.selectOptions(comboboxes[0]!, "lane-1");

    // Wait for branches to load, then type a different target branch
    await waitFor(() => expect(screen.getByDisplayValue("main")).toBeTruthy());
    const targetInput = screen.getByDisplayValue("main");
    await user.clear(targetInput);
    await user.type(targetInput, "release-9");

    await user.click(screen.getByRole("button", { name: /next step/i }));
    await user.click(screen.getByRole("button", { name: /create pr/i }));

    await waitFor(() => expect(createFromLane).toHaveBeenCalledTimes(1));
    expect(createFromLane).toHaveBeenCalledWith(
      expect.objectContaining({
        laneId: "lane-1",
        baseBranch: "release-9",
      }),
    );
  });

  it("prefills a single PR from the requested lane into the primary branch", async () => {
    renderWithRouter(
      <CreatePrModal
        open
        onOpenChange={vi.fn()}
        initialValues={{ sourceLaneId: "lane-2", target: "primary" }}
      />,
    );

    const sourceSelect = document.querySelector('[data-tour="prs.createModal.source"]') as HTMLSelectElement | null;
    const targetInput = document.querySelector('[data-tour="prs.createModal.base"]') as HTMLInputElement | null;

    await waitFor(() => expect(sourceSelect?.value).toBe("lane-2"));
    expect(targetInput?.value).toBe("main");
  });

  it("defaults the single-PR title from the lane target while keeping Linear in the body", async () => {
    const user = userEvent.setup();
    renderWithRouter(<CreatePrModal open onOpenChange={vi.fn()} />);

    const comboboxes = screen.getAllByRole("combobox");
    await user.selectOptions(comboboxes[0]!, "lane-linear");

    await user.click(screen.getByRole("button", { name: /next step/i }));

    expect(screen.getByDisplayValue("Linear linked lane -> main")).toBeTruthy();
    expect(screen.getByDisplayValue(/Fixes ADE-123/)).toBeTruthy();
    expect(screen.getByText(/PR body will include Fixes ADE-123/i)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /create pr/i }));

    await waitFor(() => expect(createFromLane).toHaveBeenCalledTimes(1));
    expect(createFromLane).toHaveBeenCalledWith(
      expect.objectContaining({
        laneId: "lane-linear",
        title: "Linear linked lane -> main",
        body: expect.stringContaining("Fixes ADE-123"),
        closeLinearIssueOnMerge: true,
      }),
    );
  });

  it("uses a non-closing Linear magic word when close-on-merge is disabled", async () => {
    const user = userEvent.setup();
    renderWithRouter(<CreatePrModal open onOpenChange={vi.fn()} />);

    const comboboxes = screen.getAllByRole("combobox");
    await user.selectOptions(comboboxes[0]!, "lane-linear");
    await user.click(screen.getByRole("button", { name: /next step/i }));
    // Close-on-merge defaults to ON; click to turn it off.
    await user.click(screen.getByRole("checkbox", { name: /close linear issue/i }));

    expect(screen.getByDisplayValue(/Refs ADE-123/)).toBeTruthy();
    expect(screen.getByText(/PR body will include Refs ADE-123/i)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /create pr/i }));

    await waitFor(() => expect(createFromLane).toHaveBeenCalledTimes(1));
    expect(createFromLane).toHaveBeenCalledWith(
      expect.objectContaining({
        laneId: "lane-linear",
        body: expect.stringContaining("Refs ADE-123"),
        closeLinearIssueOnMerge: false,
      }),
    );
  });

  it("warns when the PR target branch differs from the lane base branch", async () => {
    const user = userEvent.setup();
    renderWithRouter(<CreatePrModal open onOpenChange={vi.fn()} />);

    // Select source lane
    const comboboxes = screen.getAllByRole("combobox");
    await user.selectOptions(comboboxes[0]!, "lane-1");

    // Wait for branches to load, then type a different target branch
    await waitFor(() => expect(screen.getByDisplayValue("main")).toBeTruthy());
    const targetInput = screen.getByDisplayValue("main");
    await user.clear(targetInput);
    await user.type(targetInput, "release-9");

    expect(screen.getByText("Check Before Creating PR")).toBeTruthy();
    expect(screen.getByText(/targets release-9, but this lane is based on main/i)).toBeTruthy();
    expect(screen.getByText(/move the lane onto release-9 before creating it/i)).toBeTruthy();
  });

  it("moves a child lane target back to the merged parent PR base", async () => {
    mockLanes.push(makeLane({
      id: "lane-child",
      name: "03 child lane",
      branchRef: "feature/child",
      baseRef: "feature/parent",
      parentLaneId: "lane-1",
      stackDepth: 2,
      createdAt: "2026-03-23T12:03:00.000Z",
    }));
    try {
      (globalThis.window.ade.prs.listAll as any).mockResolvedValue([
        {
          id: "pr-parent",
          laneId: "lane-1",
          projectId: "proj-1",
          repoOwner: "test-owner",
          repoName: "test-repo",
          githubPrNumber: 1,
          githubUrl: "https://example.test/pr/1",
          githubNodeId: null,
          title: "Parent",
          state: "merged",
          baseBranch: "main",
          headBranch: "feature/parent",
          checksStatus: "none",
          reviewStatus: "none",
          additions: 1,
          deletions: 1,
          lastSyncedAt: null,
          createdAt: "2026-03-23T12:00:00.000Z",
          updatedAt: "2026-03-23T12:30:00.000Z",
          creationStrategy: "pr_target",
        },
      ]);

      const user = userEvent.setup();
      renderWithRouter(<CreatePrModal open onOpenChange={vi.fn()} />);

      const comboboxes = screen.getAllByRole("combobox");
      await user.selectOptions(comboboxes[0]!, "lane-child");

      await waitFor(() => expect(screen.getByDisplayValue("main")).toBeTruthy());
      expect(screen.getByText(/The lane this builds on \("01 parent lane"\) has already merged/i)).toBeTruthy();

      await user.click(screen.getByRole("button", { name: /next step/i }));
      await user.click(screen.getByRole("button", { name: /create pr/i }));

      await waitFor(() => expect(createFromLane).toHaveBeenCalledTimes(1));
      expect(createFromLane).toHaveBeenCalledWith(
        expect.objectContaining({
          laneId: "lane-child",
          baseBranch: "main",
        }),
      );
    } finally {
      mockLanes.pop();
    }
  });

});
