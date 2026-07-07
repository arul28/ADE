/* @vitest-environment jsdom */

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { LaneSummary } from "../../../shared/types";
import { InboundDeeplinkModal } from "./InboundDeeplinkModal";

function makeLane(overrides: Partial<LaneSummary> = {}): LaneSummary {
  return {
    id: "lane-1",
    name: "Feature lane",
    description: null,
    laneType: "worktree",
    baseRef: "main",
    branchRef: "feature/shared",
    worktreePath: "/tmp/feature-shared",
    parentLaneId: null,
    childCount: 0,
    stackDepth: 0,
    parentStatus: null,
    isEditProtected: false,
    status: { dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false },
    color: null,
    icon: null,
    tags: [],
    createdAt: "2026-05-12T20:00:00.000Z",
    archivedAt: null,
    linearIssue: null,
    ...overrides,
  };
}

describe("InboundDeeplinkModal", () => {
  const originalAde = globalThis.window.ade;

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    if (originalAde === undefined) {
      delete (globalThis.window as any).ade;
    } else {
      globalThis.window.ade = originalAde;
    }
  });

  it("imports a branch-only deeplink as a local lane", async () => {
    const importBranch = vi.fn(async () => makeLane({ id: "lane-imported", branchRef: "feature/shared" }));
    globalThis.window.ade = {
      lanes: { importBranch },
    } as any;
    const onLaneOpened = vi.fn();
    const onClose = vi.fn();

    render(
      <InboundDeeplinkModal
        target={{ repoOwner: "acme", repoName: "ade", branch: "origin/feature/shared" }}
        lanes={[]}
        onClose={onClose}
        onLaneOpened={onLaneOpened}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /create lane from branch/i }));

    await waitFor(() => {
      expect(importBranch).toHaveBeenCalledWith({
        branchRef: "origin/feature/shared",
        name: "feature/shared",
      });
    });
    expect(onLaneOpened).toHaveBeenCalledWith("lane-imported");
    expect(onClose).toHaveBeenCalled();
  });

  it("opens an existing lane for a remote-prefixed branch deeplink", async () => {
    globalThis.window.ade = {
      lanes: { importBranch: vi.fn() },
    } as any;
    const onLaneOpened = vi.fn();
    const onClose = vi.fn();

    render(
      <InboundDeeplinkModal
        target={{ repoOwner: "acme", repoName: "ade", branch: "origin/feature/shared" }}
        lanes={[makeLane({ id: "lane-existing", branchRef: "feature/shared" })]}
        onClose={onClose}
        onLaneOpened={onLaneOpened}
      />,
    );

    await waitFor(() => {
      expect(onLaneOpened).toHaveBeenCalledWith("lane-existing");
    });
    expect(onClose).toHaveBeenCalled();
    expect(globalThis.window.ade.lanes.importBranch).not.toHaveBeenCalled();
  });

  it("shows a setup state when no ADE project is open", async () => {
    const importBranch = vi.fn();
    globalThis.window.ade = {
      lanes: { importBranch },
    } as any;

    render(
      <InboundDeeplinkModal
        target={{ repoOwner: "acme", repoName: "ade", branch: "origin/feature/shared" }}
        lanes={[]}
        projectOpen={false}
        onClose={vi.fn()}
        onLaneOpened={vi.fn()}
      />,
    );

    const setupMessage = await screen.findByText("Open the ADE project for acme/ade before creating a lane from this deeplink.");
    expect(setupMessage.textContent).toBe("Open the ADE project for acme/ade before creating a lane from this deeplink.");
    const createButton = screen.getByRole("button", { name: /create lane from branch/i }) as HTMLButtonElement;
    expect(createButton.disabled).toBe(true);
    expect(importBranch).not.toHaveBeenCalled();
  });

  it("offers to open foreign commit links on GitHub when repo envelope is present", () => {
    const openExternal = vi.fn(async () => undefined);
    globalThis.window.ade = {
      app: { openExternal },
    } as any;

    render(
      <InboundDeeplinkModal
        target={{
          kind: "foreign",
          entity: "commit",
          envelope: { repoOwner: "acme", repoName: "ade" },
          original: { kind: "commit", sha: "abc1234", envelope: { repoOwner: "acme", repoName: "ade" } },
        }}
        lanes={[]}
        onClose={vi.fn()}
        onLaneOpened={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /open commit on github/i }));
    expect(openExternal).toHaveBeenCalledWith("https://github.com/acme/ade/commit/abc1234");
  });
});
