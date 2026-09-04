/**
 * The seam test.
 *
 * The plugin is two programs now: a page that draws, and a child process that
 * holds the `lane.*` / `git.*` / `pr.*` / `conflicts.*` action domains. They are
 * joined by nothing but a list of action ids and their argument shapes — no
 * compiler checks the join, because the page is built separately from the
 * plugin it ships inside, and no type crosses the bridge.
 *
 * So this test walks the product the way a reader does, against a scripted
 * `window.adePlugin` (`fakeBridge.ts`), and asserts the CALLS rather than the
 * pixels: an id the page invokes that the fake does not script throws by name,
 * and an argument shape that drifts fails on the assertion that reads it.
 *
 * The walk: the canvas's first read → the four view-mode buttons → a host
 * `lane` frame that refetches → a contributed node listed over `sockets` → the
 * older-host path with no `sockets` at all → the phone list's lane press, which
 * is a deeplink rather than a renderer route.
 */

import React from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { WorkspaceGraph } from "../src/components/WorkspaceGraph";
import { GRAPH_HOST_KINDS } from "../src/lib/useGraphData";
import {
  CHILD_LANE,
  installFakeBridge,
  uninstallFakeBridge,
  type FakeBridge,
} from "./fakeBridge";

function tabContext(overrides: Record<string, unknown> = {}) {
  return {
    subject: null,
    surfaceId: "graph",
    placement: "tab" as const,
    project: { projectId: "project-1", root: "/repo", binding: "local" as const },
    ...overrides,
  };
}

let host: FakeBridge;

beforeEach(() => {
  host = installFakeBridge();
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1280 });
});

afterEach(() => {
  cleanup();
  uninstallFakeBridge();
});

async function canvas(): Promise<HTMLElement> {
  return await waitFor(() => {
    const pane = document.querySelector('[data-ade-graph-view="canvas"]');
    if (!pane) throw new Error("The graph canvas has not rendered yet.");
    return pane as HTMLElement;
  });
}

describe("the page and the plugin agree on every verb", () => {
  it("opens with the compiled first-read set and draws the four view modes", async () => {
    render(<WorkspaceGraph context={tabContext()} />);

    await waitFor(() => {
      expect(host.callsTo("invoke:pageLanes").length).toBeGreaterThan(0);
    });
    expect(host.callsTo("invoke:pagePrs").length).toBeGreaterThan(0);
    expect(host.callsTo("invoke:pageProposals").length).toBeGreaterThan(0);
    expect(host.callsTo("invoke:pageProjectConfig").length).toBeGreaterThan(0);
    expect(host.callsTo("invoke:pageGraphState").length).toBeGreaterThan(0);
    expect(host.callsTo("invoke:pageSyncStatuses").length).toBeGreaterThan(0);
    expect(host.callsTo("invoke:pageAutoRebaseStatuses").length).toBeGreaterThan(0);
    expect(host.callsTo("invoke:pageConflictAssessment").length).toBeGreaterThan(0);
    expect(host.callsTo("invoke:pageOperations").length).toBeGreaterThan(0);
    expect(host.callsTo("invoke:pageOperations")[0]!.args).toMatchObject({ limit: 150 });

    const pane = await canvas();
    expect(pane.getAttribute("data-ade-graph-view")).toBe("canvas");
    expect(screen.getByText("Overview")).toBeTruthy();
    expect(screen.getByText("Dependencies")).toBeTruthy();
    expect(screen.getByText("Conflict Risk")).toBeTruthy();
    expect(screen.getByText("Activity")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByText("Conflict Risk"));
    });
    expect(screen.getByText("Conflict Risk")).toBeTruthy();
  });

  it("subscribes to the four host kinds and refetches lanes when one moves", async () => {
    render(<WorkspaceGraph context={tabContext()} />);
    await canvas();

    await waitFor(() => {
      expect(host.callsTo("host.subscribe").length).toBeGreaterThan(0);
    });
    expect(host.callsTo("host.subscribe")[0]!.args).toMatchObject({
      kinds: GRAPH_HOST_KINDS,
    });

    const before = host.callsTo("invoke:pageLanes").length;
    await act(async () => {
      host.emit("host", { kind: "lane", ids: [CHILD_LANE.id], overflow: false });
    });
    await waitFor(() => {
      expect(host.callsTo("invoke:pageLanes").length).toBeGreaterThan(before);
    });
  });

  it("lists contributed graph nodes over bridge.sockets, and draws without them on an older host", async () => {
    host = installFakeBridge({
      socketEntries: [
        {
          socketId: "tracker:node:lane-feature",
          pluginId: "tracker",
          socket: "graph-node",
          label: "ADE-1",
          icon: "kanban",
          data: { entityKind: "lane", entityId: "lane-feature", label: "ADE-1" },
        },
      ],
    });
    render(<WorkspaceGraph context={tabContext()} />);
    await canvas();
    await waitFor(() => {
      expect(host.callsTo("sockets.list").length).toBeGreaterThan(0);
    });
    expect(host.callsTo("sockets.list")[0]!.args).toMatchObject({ socket: "graph-node" });

    cleanup();
    uninstallFakeBridge();
    host = installFakeBridge({ withoutSockets: true });
    render(<WorkspaceGraph context={tabContext()} />);
    await canvas();
    expect(host.callsTo("sockets.list").length).toBe(0);
    expect(screen.getByText("Overview")).toBeTruthy();
  });

  it("opens a lane from the phone list through a deeplink, not a renderer route", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 390 });
    render(
      <WorkspaceGraph
        context={tabContext({ placement: "pane" })}
      />,
    );

    const list = await waitFor(() => {
      const pane = document.querySelector('[data-ade-graph-view="phone-list"]');
      if (!pane) throw new Error("The phone list has not rendered yet.");
      return pane as HTMLElement;
    });
    expect(list.querySelector('[data-lane-id="lane-feature"]')).toBeTruthy();

    await act(async () => {
      fireEvent.click(list.querySelector('[data-lane-id="lane-feature"]') as HTMLElement);
    });
    await waitFor(() => {
      expect(host.callsTo("openDeeplink").length).toBe(1);
    });
    expect(host.lastCall("openDeeplink")!.args).toEqual({ url: "ade://lane/lane-feature" });
  });
});
