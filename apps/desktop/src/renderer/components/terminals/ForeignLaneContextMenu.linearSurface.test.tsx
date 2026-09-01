/* @vitest-environment jsdom */

import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LaneSummary, OpenProjectBinding } from "../../../shared/types";
import { rootAppStoreApi } from "../../state/appStore";
import { resetBuiltinSurfacePlugins, seedBuiltinSurfacePlugins } from "../../../test/builtinSurfaces";
import { ForeignLaneContextMenu } from "./ForeignLaneContextMenu";

/**
 * The second copy of "Copy Linear Issue Link" — the menu for a lane that lives
 * on another machine.
 *
 * It is a separate component from `buildLaneMenuGroups` and shares none of its
 * wiring, which is exactly why it needs its own cases: the row was duplicated
 * once and a gate applied to one copy only would leave the other as the Linear
 * entry point the plugin is supposed to own.
 *
 * The surface belongs to THIS machine. A lane owned elsewhere changes nothing:
 * the question is which Linear UI the person reading this menu has.
 */

const COPY_LINEAR = "Copy Linear Issue Link";

const foreignLane = {
  id: "lane-remote",
  name: "Remote lane",
  laneType: "worktree",
  baseRef: "main",
  branchRef: "refs/heads/ade-321",
  worktreePath: "/tmp/lane-remote",
  parentLaneId: null,
  childCount: 0,
  stackDepth: 0,
  parentStatus: null,
  isEditProtected: false,
  status: { dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false },
  color: null,
  icon: null,
  tags: [],
  createdAt: "2026-07-10T10:00:00.000Z",
  linearIssue: {
    id: "issue-2",
    identifier: "ADE-321",
    title: "Copy from a foreign lane",
    description: null,
    url: "https://linear.app/ade/issue/ADE-321/copy-from-a-foreign-lane",
    projectId: null,
    projectSlug: null,
    projectName: null,
    teamId: "team-1",
    teamKey: "ADE",
    teamName: "ADE",
    stateId: "state-1",
    stateName: "Todo",
    stateType: "unstarted",
    priority: 0,
    priorityLabel: "none",
    labels: [],
    assigneeId: null,
    assigneeName: null,
    creatorId: null,
    creatorName: null,
    dueDate: null,
    estimate: null,
    branchName: "ade-321",
    createdAt: "2026-07-10T10:00:00.000Z",
    updatedAt: "2026-07-10T10:00:00.000Z",
  },
} as unknown as LaneSummary;

const binding: OpenProjectBinding = {
  kind: "remote",
  key: "machine-b:/project",
  rootPath: "/project",
} as unknown as OpenProjectBinding;

function renderMenu() {
  render(
    <ForeignLaneContextMenu
      lane={foreignLane}
      binding={binding}
      machineName="machine-b"
      online
      x={10}
      y={10}
      onClose={vi.fn()}
      onStartChat={vi.fn()}
      onManage={vi.fn()}
      onOpenInLanes={vi.fn()}
    />,
  );
}

describe("the foreign lane menu and the Linear surface", () => {
  beforeEach(() => {
    rootAppStoreApi.setState({ installedPlugins: [], pluginsLoaded: false });
    globalThis.window.ade = { app: { writeClipboardText: vi.fn() } } as never;
  });

  afterEach(() => {
    cleanup();
    resetBuiltinSurfacePlugins();
  });

  it("offers the row on a machine without the plugin", async () => {
    renderMenu();
    await waitFor(() => expect(screen.getByText(COPY_LINEAR)).toBeTruthy());
  });

  it("offers the row while the plugin registry has not resolved", async () => {
    Object.defineProperty(window, "ade", {
      configurable: true,
      writable: true,
      value: { ...(window as never as { ade?: Record<string, unknown> }).ade, plugins: {} },
    });
    rootAppStoreApi.setState({ installedPlugins: [], pluginsLoaded: false });

    renderMenu();
    await waitFor(() => expect(screen.getByText(COPY_LINEAR)).toBeTruthy());
  });

  it("drops the row once ade-linear is installed", async () => {
    seedBuiltinSurfacePlugins(["linear"]);

    renderMenu();
    // "Copy branch name" proves the menu drew its copy rows at all, so an
    // absent Linear row is the gate and not an empty render.
    await waitFor(() => expect(screen.getByText("Copy branch name")).toBeTruthy());
    expect(screen.queryByText(COPY_LINEAR)).toBeNull();
  });
});
