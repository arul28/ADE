/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SubagentSpawnCard } from "./SubagentActivityCards";
import type { SubagentSpawnAnchorRenderEvent } from "./chatTranscriptRows";

function spawnEvent(overrides: Partial<SubagentSpawnAnchorRenderEvent> = {}): SubagentSpawnAnchorRenderEvent {
  return {
    type: "subagent_spawn_anchor",
    agentKey: "child-abc",
    description: "Wave 2 UI",
    agentType: "claude",
    background: false,
    status: "running",
    statusLine: null,
    lastToolName: null,
    toolCount: null,
    startedAt: "2026-07-14T10:00:00.000Z",
    endedAt: null,
    childSessionId: "child-abc",
    spawnKind: "subagent",
    resultSummary: null,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SubagentSpawnCard", () => {
  it("navigates to the spawned chat on click when a child session id is present", () => {
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    render(<SubagentSpawnCard event={spawnEvent()} laneId="lane-1" />);

    fireEvent.click(screen.getByRole("button", { name: /Wave 2 UI/ }));

    const navEvent = dispatchSpy.mock.calls
      .map(([evt]) => evt)
      .find((evt): evt is CustomEvent => evt instanceof CustomEvent && evt.type === "ade:work:select-session");
    expect(navEvent).toBeTruthy();
    expect(navEvent!.detail).toEqual({ sessionId: "child-abc", laneId: "lane-1" });
  });

  it("renders the type chip and result summary once finished", () => {
    render(
      <SubagentSpawnCard
        event={spawnEvent({ status: "completed", endedAt: "2026-07-14T10:05:00.000Z", resultSummary: "Kickoff turn finished." })}
      />,
    );

    expect(screen.getByText("SUBAGENT")).toBeTruthy();
    expect(screen.getByText("Kickoff turn finished.")).toBeTruthy();
  });

  it("does not navigate for a runtime-native subagent (no child session id)", () => {
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    render(
      <SubagentSpawnCard
        event={spawnEvent({ childSessionId: null, spawnKind: null, agentType: "Explore" })}
      />,
    );

    // No navigable button wrapper — the card is a plain div.
    expect(screen.queryByRole("button", { name: /Wave 2 UI/ })).toBeNull();
    const navEvent = dispatchSpy.mock.calls
      .map(([evt]) => evt)
      .find((evt): evt is CustomEvent => evt instanceof CustomEvent && evt.type === "ade:work:select-session");
    expect(navEvent).toBeUndefined();
    expect(screen.queryByText("SUBAGENT")).toBeNull();
  });
});
