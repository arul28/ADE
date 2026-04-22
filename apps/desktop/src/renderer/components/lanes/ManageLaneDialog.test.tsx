/* @vitest-environment jsdom */

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ManageLaneDialog } from "./ManageLaneDialog";
import type { LaneSummary } from "../../../shared/types";

vi.mock("border-beam", () => ({
  BorderBeam: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

function makeLane(overrides: Partial<LaneSummary> = {}): LaneSummary {
  return {
    id: "lane-1",
    name: "feature lane",
    laneType: "worktree",
    baseRef: "main",
    branchRef: "ade/feature-lane",
    worktreePath: "/repo/.ade/worktrees/feature-lane",
    attachedRootPath: null,
    parentLaneId: null,
    childCount: 0,
    stackDepth: 0,
    parentStatus: null,
    isEditProtected: false,
    status: {
      dirty: false,
      ahead: 0,
      behind: 0,
      remoteBehind: -1,
      rebaseInProgress: false,
    },
    color: null,
    icon: null,
    tags: [],
    createdAt: "2026-04-21T00:00:00.000Z",
    ...overrides,
  };
}

const baseProps = {
  open: true,
  onOpenChange: vi.fn(),
  managedLane: makeLane(),
  managedLanes: [],
  deleteMode: "local_branch" as const,
  setDeleteMode: vi.fn(),
  deleteRemoteName: "origin",
  setDeleteRemoteName: vi.fn(),
  deleteForce: false,
  setDeleteForce: vi.fn(),
  deleteConfirmText: "delete feature lane",
  setDeleteConfirmText: vi.fn(),
  deletePhrase: "delete feature lane",
  laneActionError: null,
  onAdoptAttached: vi.fn(),
  onArchive: vi.fn(),
  onDelete: vi.fn(),
};

describe("ManageLaneDialog", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows a concrete deleting status and disables delete controls while busy", () => {
    render(
      <ManageLaneDialog
        {...baseProps}
        laneActionBusy
        laneActionKind="delete"
        laneActionStatus="Deleting lane worktree and local branch..."
      />,
    );

    expect(screen.getByRole("status").textContent).toContain("Deleting lane worktree and local branch...");
    expect((screen.getByRole("button", { name: /Deleting/i }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /\+ local branch/i }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByDisplayValue("delete feature lane") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("checkbox", { name: /Force delete/i }) as HTMLInputElement).disabled).toBe(true);
  });

  it("shows concrete archive progress without turning the delete button into deleting state", () => {
    render(
      <ManageLaneDialog
        {...baseProps}
        laneActionBusy
        laneActionKind="archive"
        laneActionStatus="Archiving lane..."
      />,
    );

    expect(screen.getByRole("status").textContent).toContain("Archiving lane...");
    expect(screen.queryByRole("button", { name: /Deleting/i })).toBeNull();
  });

  it("keeps the delete button actionable after confirmation when idle", () => {
    render(
      <ManageLaneDialog
        {...baseProps}
        laneActionBusy={false}
        laneActionStatus={null}
      />,
    );

    expect(screen.queryByRole("status")).toBeNull();
    expect((screen.getByRole("button", { name: /Delete lane/i }) as HTMLButtonElement).disabled).toBe(false);
  });
});
