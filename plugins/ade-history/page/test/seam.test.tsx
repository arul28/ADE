/**
 * The seam test.
 *
 * The plugin is two programs now: a page that draws, and a child process that
 * holds the `git.*` / `operation.*` / `lane.*` action domains. They are
 * joined by nothing but a list of action ids and their argument shapes — no
 * compiler checks the join, because the page is built separately from the
 * plugin it ships inside, and no type crosses the bridge.
 *
 * So this test walks the product the way a reader does, against a scripted
 * `window.adePlugin` (`fakeBridge.ts`), and asserts the CALLS rather than the
 * pixels: an id the page invokes that the fake does not script throws by name,
 * and an argument shape that drifts fails on the assertion that reads it.
 *
 * The walk: the commits surface's first read → the Activity toggle, which
 * fetches the operation ledger and the chat/CTO supplement → a host
 * `operation` frame that refetches → Open lane, which is a deeplink rather
 * than a renderer route → the older-host path with no `host.subscribe` at all.
 *
 * The second suite is the compiled structure the page tier had drifted from:
 * one toolbar row on commits, a titled pane either side, an empty right pane
 * before anything is chosen, Escape, and one `ui-state` row per placement.
 */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { HistoryPage, HISTORY_HOST_KINDS } from "../src/history/HistoryPage";
import { historyUiStateKey } from "../src/host/uiState";
import {
  SAMPLE_OPERATION,
  installFakeBridge,
  uninstallFakeBridge,
  type FakeBridge,
} from "./fakeBridge";

let root = 0;

function tabContext(overrides: Record<string, unknown> = {}) {
  return {
    subject: null,
    surfaceId: "commits",
    placement: "tab" as const,
    project: { projectId: `project-${root}`, root: `/repo-${root}`, binding: "local" as const },
    ...overrides,
  };
}

let host: FakeBridge;

beforeEach(() => {
  root += 1;
  host = installFakeBridge({
    context: tabContext(),
  });
});

afterEach(() => {
  cleanup();
  uninstallFakeBridge();
});

async function historyPane(): Promise<HTMLElement> {
  return await waitFor(() => {
    const pane = document.querySelector("[data-ade-history-view]");
    if (!pane) throw new Error("The history page has not rendered yet.");
    return pane as HTMLElement;
  });
}

describe("the page and the plugin agree on every verb", () => {
  it("opens on commits with the compiled first-read set, then walks activity", async () => {
    render(<HistoryPage context={tabContext()} />);

    await waitFor(() => {
      expect(host.callsTo("invoke:pageLanes").length).toBeGreaterThan(0);
    });
    const pane = await historyPane();
    expect(pane.getAttribute("data-ade-history-view")).toBe("commits");

    await waitFor(() => {
      expect(host.callsTo("invoke:pageCommitGraph").length).toBeGreaterThan(0);
    });
    expect(host.callsTo("invoke:pageCommitGraph")[0]!.args).toMatchObject({
      laneId: "lane-1",
      limit: 120,
    });
    expect(host.callsTo("invoke:pageConflictState").length).toBeGreaterThan(0);

    expect(screen.getByText("Commits")).toBeTruthy();
    expect(screen.getByText("Activity")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByText("Activity"));
    });

    await waitFor(() => {
      expect(document.querySelector('[data-ade-history-view="activity"]')).toBeTruthy();
    });
    await waitFor(() => {
      expect(host.callsTo("invoke:pageOperations").length).toBeGreaterThan(0);
    });
    expect(host.callsTo("invoke:pageOperations")[0]!.args).toMatchObject({ limit: 500 });
    expect(host.callsTo("invoke:pageActivitySupplement").length).toBeGreaterThan(0);
  });

  it("subscribes to lane and operation kinds and refetches when an operation moves", async () => {
    render(<HistoryPage context={tabContext()} />);
    await historyPane();

    await waitFor(() => {
      expect(host.callsTo("host.subscribe").length).toBeGreaterThan(0);
    });
    expect(host.callsTo("host.subscribe")[0]!.args).toMatchObject({
      kinds: [...HISTORY_HOST_KINDS],
    });

    await act(async () => {
      fireEvent.click(screen.getByText("Activity"));
    });
    await waitFor(() => {
      expect(host.callsTo("invoke:pageOperations").length).toBeGreaterThan(0);
    });

    const before = host.callsTo("invoke:pageOperations").length;
    await act(async () => {
      host.emit("host", { kind: "operation", ids: [SAMPLE_OPERATION.id], overflow: false });
    });
    await waitFor(() => {
      expect(host.callsTo("invoke:pageOperations").length).toBeGreaterThan(before);
    });
  });

  it("opens a lane from an event through a deeplink, not a renderer route", async () => {
    render(<HistoryPage context={tabContext()} />);
    await historyPane();

    await act(async () => {
      fireEvent.click(screen.getByText("Activity"));
    });
    await waitFor(() => {
      expect(document.querySelector('[data-ade-history-view="activity"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(screen.getByLabelText("List"));
    });

    const row = await waitFor(() => {
      const node = document.querySelector('[data-ade-history-event="op-1"]');
      if (!node) throw new Error("The activity row has not rendered yet.");
      return node as HTMLElement;
    });
    await act(async () => {
      fireEvent.click(row);
    });

    const openLane = await waitFor(() => {
      const button = document.querySelector('[data-ade-history-open-lane="lane-1"]');
      if (!button) throw new Error("Open Lane has not rendered yet.");
      return button as HTMLElement;
    });
    await act(async () => {
      fireEvent.click(openLane);
    });
    await waitFor(() => {
      expect(host.callsTo("openDeeplink").length).toBeGreaterThan(0);
    });
    expect(host.lastCall("openDeeplink")!.args).toEqual({ url: "ade://lane/lane-1" });
  });

  it("draws the commits surface on an older host that has no host.subscribe", async () => {
    uninstallFakeBridge();
    host = installFakeBridge({
      withoutHost: true,
      context: tabContext(),
    });
    render(<HistoryPage context={tabContext()} />);
    await historyPane();
    expect(host.callsTo("host.subscribe").length).toBe(0);
    expect(screen.getByText("Commits")).toBeTruthy();
    await waitFor(() => {
      expect(host.callsTo("invoke:pageLanes").length).toBeGreaterThan(0);
    });
  });
});

describe("the compiled structure", () => {
  it("titles both panes and flips the titles with the surface", async () => {
    render(<HistoryPage context={tabContext()} />);
    await historyPane();

    expect(document.querySelector('[data-ade-history-pane-title="Commit graph"]')).toBeTruthy();
    expect(document.querySelector('[data-ade-history-pane-title="Commit"]')).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByText("Activity"));
    });
    await waitFor(() => {
      expect(document.querySelector('[data-ade-history-pane-title="Timeline"]')).toBeTruthy();
    });
    expect(document.querySelector('[data-ade-history-pane-title="Event detail"]')).toBeTruthy();
    expect(document.querySelector('[data-ade-history-pane-title="Commit graph"]')).toBeNull();
  });

  it("says the right pane is empty rather than drawing a blank column", async () => {
    render(<HistoryPage context={tabContext()} />);
    await historyPane();
    expect(screen.getByText("No commit selected")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByText("Activity"));
    });
    await waitFor(() => {
      expect(screen.getByText("No operation selected")).toBeTruthy();
    });
  });

  it("keeps the commits toolbar to one row: the toggle, the lane and the git menu", async () => {
    render(<HistoryPage context={tabContext()} />);
    await historyPane();

    expect(screen.getByLabelText("Lane")).toBeTruthy();
    // The view-mode, scope, search and filter controls belong to Activity. On
    // commits they were never drawn, and a second row would push the DAG down.
    expect(screen.queryByLabelText("List")).toBeNull();
    expect(screen.queryByText("Filter")).toBeNull();
    expect(screen.queryByLabelText("Export activity history")).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByText("Activity"));
    });
    await waitFor(() => {
      expect(screen.getByLabelText("List")).toBeTruthy();
    });
    expect(screen.getByText("Filter")).toBeTruthy();
  });

  it("closes the detail on Escape", async () => {
    render(<HistoryPage context={tabContext()} />);
    await historyPane();

    await act(async () => {
      fireEvent.click(screen.getByText("Activity"));
    });
    await waitFor(() => {
      expect(document.querySelector('[data-ade-history-view="activity"]')).toBeTruthy();
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText("List"));
    });
    const row = await waitFor(() => {
      const node = document.querySelector('[data-ade-history-event="op-1"]');
      if (!node) throw new Error("The activity row has not rendered yet.");
      return node as HTMLElement;
    });
    await act(async () => {
      fireEvent.click(row);
    });
    await waitFor(() => {
      expect(document.querySelector('[data-ade-history-open-lane="lane-1"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    await waitFor(() => {
      expect(screen.getByText("No operation selected")).toBeTruthy();
    });
  });

  it("returns to the commit graph on the G H chord", async () => {
    render(<HistoryPage context={tabContext()} />);
    await historyPane();

    await act(async () => {
      fireEvent.click(screen.getByText("Activity"));
    });
    await waitFor(() => {
      expect(document.querySelector('[data-ade-history-view="activity"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.keyDown(window, { key: "g" });
      fireEvent.keyDown(window, { key: "h" });
    });
    await waitFor(() => {
      expect(document.querySelector('[data-ade-history-view="commits"]')).toBeTruthy();
    });
  });

  it("writes one ui-state row per placement, so three placements do not fight", async () => {
    const paneContext = tabContext({ placement: "pane" as const });
    render(<HistoryPage context={paneContext} />);
    await historyPane();

    await act(async () => {
      fireEvent.click(screen.getByText("Activity"));
    });
    await waitFor(() => {
      expect(host.callsTo("collections.put").length).toBeGreaterThan(0);
    });

    const paneKey = historyUiStateKey(paneContext.project.root, "pane");
    const tabKey = historyUiStateKey(paneContext.project.root, "tab");
    expect(paneKey).not.toBe(tabKey);
    const written = new Set(host.callsTo("collections.put").map((call) => call.args.key));
    expect(written.has(paneKey)).toBe(true);
    expect(written.has(tabKey)).toBe(false);
    expect(host.lastCall("collections.get")!.args.key).toBe(paneKey);
  });

  it("reopens on the surface and event the reader left, when the host asked for neither", async () => {
    const context = tabContext();
    host.collections.set(
      `ui-state/${historyUiStateKey(context.project.root, "tab")}`,
      { surface: "activity", selectedEventId: SAMPLE_OPERATION.id, detailPx: 400 },
    );

    render(<HistoryPage context={context} />);
    await waitFor(() => {
      expect(document.querySelector('[data-ade-history-view="activity"]')).toBeTruthy();
    });
    await waitFor(() => {
      expect(document.querySelector('[data-ade-history-open-lane="lane-1"]')).toBeTruthy();
    });
  });

  it("runs no timer on the activity ledger — the operation frame is the refresh", async () => {
    // A RUNNING operation is the case the compiled poll existed for, and the
    // one the guest kept forever: `active` is hard-true for a page, so the 4s
    // interval never stood down. Anything less than a running row would assert
    // nothing at all.
    uninstallFakeBridge();
    host = installFakeBridge({
      context: tabContext(),
      operations: [{ ...SAMPLE_OPERATION, status: "running", endedAt: null }],
    });
    render(<HistoryPage context={tabContext()} />);
    await historyPane();
    await act(async () => {
      fireEvent.click(screen.getByText("Activity"));
    });
    await waitFor(() => {
      expect(host.callsTo("invoke:pageOperations").length).toBeGreaterThan(0);
    });

    const settled = host.callsTo("invoke:pageOperations").length;
    vi.useFakeTimers();
    try {
      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });
      expect(host.callsTo("invoke:pageOperations").length).toBe(settled);
    } finally {
      vi.useRealTimers();
    }
  });
});
