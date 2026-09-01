/* @vitest-environment jsdom */

import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenProjectBinding } from "../../../shared/types";
import { rootAppStoreApi } from "../../state/appStore";
import { resetBuiltinSurfacePlugins, seedBuiltinSurfacePlugins } from "../../../test/builtinSurfaces";
import { laneFixture, laneLinearIssueFixture } from "../../../test/laneFixture";
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

const foreignLane = laneFixture({
  id: "lane-remote",
  name: "Remote lane",
  branchRef: "refs/heads/ade-321",
  worktreePath: "/tmp/lane-remote",
  linearIssue: laneLinearIssueFixture({
    id: "issue-2",
    identifier: "ADE-321",
    title: "Copy from a foreign lane",
    url: "https://linear.app/ade/issue/ADE-321/copy-from-a-foreign-lane",
    stateName: "Todo",
    stateType: "unstarted",
    priority: 0,
    priorityLabel: "none",
    branchName: "ade-321",
  }),
});

// Spelled out rather than cast: a foreign lane's menu is reached through a
// remote binding, and the fields it resolves `Open in…` from are exactly the
// ones a cast would let go missing.
const binding: OpenProjectBinding = {
  kind: "remote",
  key: "machine-b:/project",
  targetId: "machine-b",
  runtimeName: "machine-b",
  projectId: "project-1",
  rootPath: "/project",
  displayName: "Project",
};

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
    // The cast covers the rest of the preload API this menu never touches; the
    // one member it does touch is typed against the real signature, so a change
    // there is a compile error here rather than a spy called with the wrong
    // arguments and nobody noticing.
    const writeClipboardText: typeof window.ade.app.writeClipboardText = vi.fn(
      async () => {},
    );
    globalThis.window.ade = { app: { writeClipboardText } } as never;
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
