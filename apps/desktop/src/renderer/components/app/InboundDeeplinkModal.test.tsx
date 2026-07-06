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

function makePreflight() {
  return {
    preflight: {
      repoOwner: "acme",
      repoName: "ade",
      githubPrNumber: 123,
      githubUrl: "https://github.com/acme/ade/pull/123",
      title: "Portable deeplinks",
      headBranch: "feature/shared",
      headSha: "abc1234",
      headRepoOwner: "acme",
      headRepoName: "ade",
      remoteBranch: "feature/shared",
      importBranchRef: "origin/feature/shared",
      targetLaneName: "feature/shared",
      baseBranch: "main",
      canCreate: true,
      status: "ready",
      blockingConflict: null,
      blockingConflicts: [],
    },
    lane: null,
    pr: null,
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

  it("renders foreign fallback actions from the envelope only", async () => {
    const openExternal = vi.fn(async () => undefined);
    globalThis.window.ade = {
      app: { openExternal },
    } as any;
    const envelope = {
      repoOwner: "acme",
      repoName: "ade",
      prNumber: 42,
      linearIssue: "ADE-42",
    };
    const linearRequests: any[] = [];
    const onLinearRequest = (event: Event) => {
      linearRequests.push((event as CustomEvent).detail);
    };
    window.addEventListener("ade:linear-issue-quick-view", onLinearRequest);

    render(
      <InboundDeeplinkModal
        target={{
          kind: "foreign",
          entity: "chat",
          envelope,
          original: { kind: "work", sessionId: "session-1", envelope },
        }}
        lanes={[]}
        onClose={vi.fn()}
        onLaneOpened={vi.fn()}
      />,
    );

    expect(screen.getByText("This chat lives in acme/ade on another machine.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open PR #42 on GitHub" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open Linear issue ADE-42" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /create lane from/i })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open PR #42 on GitHub" }));
    expect(openExternal).toHaveBeenCalledWith("https://github.com/acme/ade/pull/42");

    fireEvent.click(screen.getByRole("button", { name: "Open Linear issue ADE-42" }));
    expect(linearRequests[0]).toMatchObject({
      issueIdentifier: "ADE-42",
      source: "deeplink",
    });

    window.removeEventListener("ade:linear-issue-quick-view", onLinearRequest);
  });

  it("uses the existing branch preflight when a foreign branch fallback is selected", async () => {
    const preflightCreateLaneFromPrBranch = vi.fn(async () => makePreflight());
    globalThis.window.ade = {
      prs: { preflightCreateLaneFromPrBranch },
    } as any;
    const envelope = {
      repoOwner: "acme",
      repoName: "ade",
      branch: "feature/shared",
      prNumber: 123,
    };

    render(
      <InboundDeeplinkModal
        target={{
          kind: "foreign",
          entity: "lane",
          envelope,
          original: { kind: "lane", laneId: "lane-missing", envelope },
        }}
        lanes={[]}
        onClose={vi.fn()}
        onLaneOpened={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Create lane from feature/shared" }));

    await waitFor(() => {
      expect(preflightCreateLaneFromPrBranch).toHaveBeenCalledWith({
        repoOwner: "acme",
        repoName: "ade",
        githubPrNumber: 123,
      });
    });
  });

  it("switches projects and re-dispatches the original target", async () => {
    const switchToPath = vi.fn(async () => ({
      rootPath: "/projects/acme-ade",
      displayName: "Acme ADE",
      baseRef: "main",
    }));
    globalThis.window.ade = {
      project: { switchToPath },
    } as any;
    const onDispatchTarget = vi.fn(async () => true);
    const onClose = vi.fn();
    const original = {
      kind: "work" as const,
      sessionId: "session-remote",
      envelope: { repoOwner: "acme", repoName: "ade" },
    };

    render(
      <InboundDeeplinkModal
        target={{
          kind: "switch-project",
          entity: "chat",
          project: { rootPath: "/projects/acme-ade", displayName: "Acme ADE" },
          original,
        }}
        lanes={[]}
        onClose={onClose}
        onLaneOpened={vi.fn()}
        onDispatchTarget={onDispatchTarget}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Switch project and open" }));

    await waitFor(() => {
      expect(switchToPath).toHaveBeenCalledWith("/projects/acme-ade");
      expect(onClose).toHaveBeenCalled();
      expect(onDispatchTarget).toHaveBeenCalledWith(original, {
        suppressUnresolved: true,
        forceLocal: false,
      });
    });
  });
});
