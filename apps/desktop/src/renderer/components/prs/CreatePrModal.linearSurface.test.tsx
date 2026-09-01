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
 * The Create-PR modal's Linear card AND the policy it governed, against the
 * plugin that owns Linear.
 *
 * The card is ADE's own close-on-merge control. `ade-linear` ships a
 * `moveToDoneOnMerge` setting and a `close_issue_on_merge` automation step, so
 * on a machine that has the plugin two controls would govern one policy and the
 * user would have no way to tell which one the PR obeyed.
 *
 * Hiding the card is only half of that, and the half that is easy to get wrong:
 * the closing behaviour lives in the body's magic word (`Fixes` closes, `Refs`
 * links) and in the `closeLinearIssueOnMerge` argument, which `prService` reads
 * as true unless it is explicitly false. So the cases below assert the CREATED
 * PAYLOAD, not just what is on screen — a hidden card with `Fixes` and a
 * missing argument is exactly the bug this pair exists to catch.
 *
 * What must NOT move is the REFERENCE itself. Linear reads it to link the pull
 * request — Linear's feature, not ADE's — and the main process writes it into
 * every body from the lane's issue links regardless. Superseded changes its
 * form, never its presence.
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
  return user;
}

const createFromLane = vi.fn();

describe("the Create-PR Linear card and the ade-linear plugin", () => {
  beforeEach(() => {
    createFromLane.mockReset();
    createFromLane.mockResolvedValue({
      id: "pr-1",
      laneId: "lane-linear",
      provider: "github",
      number: 1,
      title: "Linear linked lane -> main",
      body: "",
      state: "open",
      url: "https://example.test/pr/1",
      headBranch: "ade-123-connect-linear-issue-dropdown",
      baseBranch: "main",
      mergeable: true,
      draft: false,
      updatedAt: "2026-05-08T12:30:00.000Z",
    });
    globalThis.window.ade = {
      prs: { createFromLane, listAll: vi.fn().mockResolvedValue([]) },
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

  it("keeps the Linear reference in the body when the card is hidden, in its non-closing form", async () => {
    // The reference is not an ADE surface. Linear reads it to link the PR, and
    // `prService.applyIssuePrLinkage` writes it into the created body anyway —
    // so dropping it here would only stop the textarea showing the truth. What
    // does change is the magic word: closing is ADE's policy, and the plugin
    // owns it now, so the preview says `Refs` and not `Fixes`.
    seedBuiltinSurfacePlugins(["linear"]);

    await openOnLinearLane();
    await waitFor(() => expect(screen.getByDisplayValue(/Refs ADE-123/)).toBeTruthy());
    expect(screen.queryByDisplayValue(/Fixes ADE-123/)).toBeNull();
  });

  /**
   * The pair that proves the hidden card took its behaviour with it.
   *
   * Both cases drive the same lane through Create and read the argument the
   * modal actually hands `prs.createFromLane`. The plugin-absent case is the
   * regression fence: the unplugged app must keep the closing body and the
   * `true` argument it has always sent, byte for byte.
   */
  it("sends the closing form on a machine without the plugin", async () => {
    const user = await openOnLinearLane();

    await waitFor(() => expect(screen.getByDisplayValue(/Fixes ADE-123/)).toBeTruthy());
    await user.click(screen.getByRole("button", { name: /create pr/i }));

    await waitFor(() => expect(createFromLane).toHaveBeenCalledTimes(1));
    const args = createFromLane.mock.calls[0]![0] as { body: string; closeLinearIssueOnMerge?: boolean };
    // The whole body: the reference line, nothing else. `ensureLinearPrReference`
    // rewrites the matched line in place and the trailing newline goes with it.
    expect(args.body).toBe("Fixes ADE-123");
    expect(args.closeLinearIssueOnMerge).toBe(true);
  });

  it("sends the non-closing form, explicitly, once ade-linear is installed", async () => {
    // `false` is sent rather than omitted on purpose: `prService.createFromLane`
    // reads a missing `closeLinearIssueOnMerge` as true, so silence would leave
    // ADE closing the issue behind a card the user can no longer see.
    seedBuiltinSurfacePlugins(["linear"]);

    const user = await openOnLinearLane();

    await waitFor(() => expect(screen.getByDisplayValue(/Refs ADE-123/)).toBeTruthy());
    await user.click(screen.getByRole("button", { name: /create pr/i }));

    await waitFor(() => expect(createFromLane).toHaveBeenCalledTimes(1));
    const args = createFromLane.mock.calls[0]![0] as { body: string; closeLinearIssueOnMerge?: boolean };
    expect(args.body).toBe("Refs ADE-123");
    expect(args.body).not.toContain("Fixes");
    expect(args.closeLinearIssueOnMerge).toBe(false);
  });
});
