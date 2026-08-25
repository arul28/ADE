/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CursorCloudFleetEntry, CursorCloudFleetResult } from "../../../shared/types";
import { CursorCloudFleetModal } from "./CursorCloudFleetModal";

const originalAde = globalThis.window.ade;

function entry(overrides: Partial<CursorCloudFleetEntry> & { agentId: string }): CursorCloudFleetEntry {
  return {
    agent: {
      agentId: overrides.agentId,
      name: `Agent ${overrides.agentId}`,
      summary: "summary text",
      repos: ["https://github.com/acme/ade"],
      webUrl: `https://cursor.com/agents?id=${overrides.agentId}`,
    },
    latestRunId: null,
    branch: null,
    prUrl: null,
    modelId: null,
    ownership: { sessionId: null, sessionTitle: null, laneId: null, laneName: null, linearIssueId: null },
    matchedBy: "repo",
    ...overrides,
  };
}

function fleetResult(items: CursorCloudFleetResult["items"]): CursorCloudFleetResult {
  return { items, relayState: "ready", lastEventAt: null, fetchedAt: new Date().toISOString() };
}

function installAdeMocks(overrides?: {
  fleet?: () => Promise<CursorCloudFleetResult>;
}) {
  globalThis.window.ade = {
    ai: {
      cursorCloudFleet: overrides?.fleet ?? vi.fn().mockResolvedValue(fleetResult([])),
      cursorCloudListRuns: vi.fn().mockResolvedValue({ items: [] }),
      cursorCloudGetUsage: vi.fn().mockResolvedValue({ agentId: "x", cost: null }),
      cursorCloudCancelRun: vi.fn().mockResolvedValue(undefined),
      cursorCloudOpenChat: vi.fn().mockResolvedValue({ sessionId: "s1" }),
      cursorCloudResolveLane: vi.fn().mockResolvedValue({ laneId: "lane-1", laneName: "Lane 1", created: false }),
      cursorCloudPullIntoLane: vi.fn().mockResolvedValue({
        status: "pulled", laneId: "lane-1", laneName: "Lane 1", sessionId: "s1", mergedBranch: "cursor/a",
      }),
      onCursorCloudFleetEvent: vi.fn(() => () => undefined),
    },
  } as any;
}

describe("CursorCloudFleetModal", () => {
  beforeEach(() => {
    installAdeMocks();
  });

  afterEach(() => {
    cleanup();
    if (originalAde === undefined) {
      delete (globalThis.window as any).ade;
    } else {
      globalThis.window.ade = originalAde;
    }
  });

  it("renders an honest key-missing state instead of 'no agents'", async () => {
    installAdeMocks({
      fleet: vi.fn().mockRejectedValue(new Error("Add a Cursor API key in Settings.")),
    });
    render(<CursorCloudFleetModal projectRoot="/p" projectName="ADE" onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText(/connect cursor first/i)).toBeTruthy();
    });
    expect(screen.queryByText(/no cloud agents/i)).toBeNull();
  });

  it("renders a fetch failure with retry instead of the empty state", async () => {
    installAdeMocks({
      fleet: vi.fn().mockRejectedValue(new Error("cursor api is down")),
    });
    render(<CursorCloudFleetModal projectRoot="/p" projectName="ADE" onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText(/could not load your cloud agents/i)).toBeTruthy();
    });
    expect(screen.getByText("Retry")).toBeTruthy();
  });

  it("renders the empty fleet as its own state", async () => {
    render(<CursorCloudFleetModal projectRoot="/p" projectName="ADE" onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText(/no cloud agents for this project/i)).toBeTruthy();
    });
    expect(screen.queryByText(/retry/i)).toBeNull();
  });

  it("groups finished rows under their owning lane and active runs on top", async () => {
    installAdeMocks({
      fleet: vi.fn().mockResolvedValue(fleetResult([
        entry({ agentId: "a-run", runStatus: "running" }),
        entry({
          agentId: "a-linked",
          agent: {
            agentId: "a-linked", name: "Linked agent", summary: "", repos: ["https://github.com/acme/ade"],
            status: "finished",
          },
          ownership: { sessionId: "s1", sessionTitle: null, laneId: "lane-1", laneName: "Perf lane", linearIssueId: "ADE-9" },
        }),
        entry({ agentId: "a-unlinked", agent: { agentId: "a-unlinked", name: "Stray", summary: "", repos: ["https://github.com/acme/ade"], status: "error" } }),
      ])),
    });
    render(<CursorCloudFleetModal projectRoot="/p" projectName="ADE" onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText("Active runs (1)")).toBeTruthy();
    });
    expect(screen.getAllByText(/perf lane/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/unlinked/i)).toBeTruthy();
    expect(screen.getByText("Linked agent")).toBeTruthy();
    expect(screen.getByText("Stray")).toBeTruthy();
  });

  it("stops an active run through the dedicated stop endpoint", async () => {
    const stopRun = vi.fn().mockResolvedValue({ stopped: true });
    installAdeMocks({
      fleet: vi.fn().mockResolvedValue(fleetResult([
        entry({ agentId: "a-run", runStatus: "running" }),
      ])),
    });
    (globalThis.window.ade as any).ai.cursorCloudStopRun = stopRun;
    render(<CursorCloudFleetModal projectRoot="/p" projectName="ADE" onClose={vi.fn()} />);
    const stop = await screen.findByRole("button", { name: /^stop$/i });
    fireEvent.click(stop);
    await waitFor(() => {
      expect(stopRun).toHaveBeenCalledWith("a-run");
    });
  });

  it("hides archived rows until the toggle is used", async () => {
    installAdeMocks({
      fleet: vi.fn().mockResolvedValue(fleetResult([
        entry({ agentId: "a-live" }),
        entry({ agentId: "a-dead", agent: { agentId: "a-dead", name: "Old one", summary: "", repos: [], archived: true } }),
      ])),
    });
    render(<CursorCloudFleetModal projectRoot="/p" projectName="ADE" onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText("Agent a-live")).toBeTruthy();
    });
    expect(screen.queryByText("Old one")).toBeNull();
    fireEvent.click(screen.getByText(/show archived \(1\)/i));
    expect(screen.getByText("Old one")).toBeTruthy();
  });

  it("opens unlinked agents by resolving their lane first", async () => {
    const resolveLane = vi.fn().mockResolvedValue({ laneId: "lane-x", laneName: "X", created: true });
    const openChat = vi.fn().mockResolvedValue({ sessionId: "s2" });
    installAdeMocks({
      fleet: vi.fn().mockResolvedValue(fleetResult([
        entry({ agentId: "a-open" }),
      ])),
    });
    (globalThis.window.ade as any).ai.cursorCloudResolveLane = resolveLane;
    (globalThis.window.ade as any).ai.cursorCloudOpenChat = openChat;
    const onClose = vi.fn();
    render(<CursorCloudFleetModal projectRoot="/proj" projectName="ADE" onClose={onClose} />);
    const open = await screen.findByRole("button", { name: /^open$/i });
    fireEvent.click(open);
    await waitFor(() => {
      expect(resolveLane).toHaveBeenCalledWith("a-open");
      expect(openChat).toHaveBeenCalledWith(expect.objectContaining({ cloudAgentId: "a-open", laneId: "lane-x" }));
      expect(onClose).toHaveBeenCalled();
    });
  });
});
