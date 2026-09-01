// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { LaneLinearIssue, LaneSummary } from "../../../shared/types";
import { rootAppStoreApi } from "../../state/appStore";
import { resetBuiltinSurfacePlugins, seedBuiltinSurfacePlugins } from "../../../test/builtinSurfaces";

/**
 * The Create-PR modal's Linear card, against the plugin that owns Linear.
 *
 * The card is ADE's own close-on-merge control. `ade-linear` ships a
 * `moveToDoneOnMerge` setting and a `close_issue_on_merge` automation step, so
 * on a machine that has the plugin two controls would govern one policy and the
 * user would have no way to tell which one the PR obeyed.
 *
 * What must NOT move is the magic word in the PR body. It is what Linear itself
 * reads to link the pull request — Linear's feature, not ADE's — and the main
 * process writes it into every body from the lane's issue links regardless. So
 * each case below asserts the body as well as the card, in both directions.
 */

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

const linearIssue: LaneLinearIssue = {
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
};

const mockLanes: LaneSummary[] = [
  makeLane({ id: "lane-primary", name: "main", laneType: "primary", branchRef: "main", worktreePath: "/tmp/main" }),
  makeLane({
    id: "lane-linear",
    name: "Linear linked lane",
    branchRef: "ade-123-connect-linear-issue-dropdown",
    worktreePath: "/tmp/lane-linear",
    parentLaneId: "lane-primary",
    stackDepth: 1,
    linearIssue,
    createdAt: "2026-05-08T12:02:00.000Z",
  }),
];

// Spread over the real module: the gate reads the ROOT store, and a mock that
// publishes only `useAppStore` leaves `useBuiltinSurfaceVisible` with nothing.
vi.mock("../../state/appStore", async () => {
  const actual = await vi.importActual<typeof import("../../state/appStore")>("../../state/appStore");
  return {
    ...actual,
    useAppStore: (selector: (state: { lanes: LaneSummary[] }) => unknown) => selector({ lanes: mockLanes }),
  };
});

import { CreatePrModal } from "./CreatePrModal";

const CARD_COPY = /PR body will include/i;
const CHECKBOX = /close linear issue when this pr merges/i;

/** Open the modal on the Linear-linked lane and step through to the form. */
async function openOnLinearLane() {
  const user = userEvent.setup();
  render(
    <MemoryRouter>
      <CreatePrModal open onOpenChange={vi.fn()} />
    </MemoryRouter>,
  );
  const comboboxes = screen.getAllByRole("combobox");
  await user.selectOptions(comboboxes[0]!, "lane-linear");
  await user.click(screen.getByRole("button", { name: /next step/i }));
}

describe("the Create-PR Linear card and the ade-linear plugin", () => {
  beforeEach(() => {
    globalThis.window.ade = {
      prs: { createFromLane: vi.fn(), listAll: vi.fn().mockResolvedValue([]) },
      git: {
        getSyncStatus: vi.fn().mockResolvedValue(null),
        listBranches: vi.fn().mockResolvedValue([
          { name: "main", isCurrent: true, isRemote: false, upstream: "origin/main" },
        ]),
      },
    } as never;
  });

  afterEach(() => {
    cleanup();
    resetBuiltinSurfacePlugins();
  });

  it("draws the card on a machine without the plugin", async () => {
    await openOnLinearLane();
    await waitFor(() => expect(screen.getByText(CARD_COPY)).toBeTruthy());
    expect(screen.getByRole("checkbox", { name: CHECKBOX })).toBeTruthy();
    expect(screen.getByDisplayValue(/Fixes ADE-123/)).toBeTruthy();
  });

  it("draws the card while the plugin registry has not resolved", async () => {
    // A host that publishes plugins but has not loaded the registry yet. Linear
    // is superseded, so the compiled card stays until a plugin positively takes
    // it — anything else would blink ADE's own integration off on every start.
    Object.defineProperty(window, "ade", {
      configurable: true,
      writable: true,
      value: { ...(window as never as { ade: Record<string, unknown> }).ade, plugins: {} },
    });
    rootAppStoreApi.setState({ installedPlugins: [], pluginsLoaded: false });

    await openOnLinearLane();
    await waitFor(() => expect(screen.getByText(CARD_COPY)).toBeTruthy());
    expect(screen.getByRole("checkbox", { name: CHECKBOX })).toBeTruthy();
  });

  it("hides the card once ade-linear is installed", async () => {
    seedBuiltinSurfacePlugins(["linear"]);

    await openOnLinearLane();
    await waitFor(() => expect(screen.getByRole("button", { name: /create pr/i })).toBeTruthy());
    expect(screen.queryByText(CARD_COPY)).toBeNull();
    expect(screen.queryByRole("checkbox", { name: CHECKBOX })).toBeNull();
    expect(screen.queryByText("ADE-123")).toBeNull();
  });

  it("keeps the Linear magic word in the body when the card is hidden", async () => {
    // The reference is not an ADE surface. Linear reads it to link the PR, and
    // `prService.applyIssuePrLinkage` writes it into the created body anyway —
    // so dropping it here would only stop the textarea showing the truth.
    seedBuiltinSurfacePlugins(["linear"]);

    await openOnLinearLane();
    await waitFor(() => expect(screen.getByDisplayValue(/Fixes ADE-123/)).toBeTruthy());
  });
});
