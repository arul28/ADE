/* @vitest-environment jsdom */

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TerminalSessionSummary } from "../../../shared/types";
import { NestedDrawers, nestedDrawerOpenMarker } from "./NestedDrawers";

const NOW_MS = Date.parse("2026-09-21T12:00:00.000Z");
const NOW_ISO = "2026-09-21T12:00:00.000Z";

afterEach(cleanup);

function makeSession(overrides: Partial<TerminalSessionSummary> = {}): TerminalSessionSummary {
  return {
    id: "session-1",
    laneId: "lane-1",
    laneName: "Lane 1",
    ptyId: null,
    tracked: true,
    pinned: false,
    goal: null,
    toolType: "codex-chat",
    title: "Subagent",
    status: "running",
    startedAt: NOW_ISO,
    endedAt: null,
    exitCode: null,
    transcriptPath: "",
    headShaStart: null,
    headShaEnd: null,
    lastOutputPreview: null,
    summary: null,
    runtimeState: "idle",
    resumeCommand: null,
    ...overrides,
  };
}

function renderDrawers(subagents: TerminalSessionSummary[], collapsed: boolean) {
  const onToggle = vi.fn();
  const view = render(
    <NestedDrawers
      parentId="parent-1"
      shells={[]}
      subagents={subagents}
      isCollapsed={() => collapsed}
      onToggle={onToggle}
      nowMs={NOW_MS}
      renderChild={(child) => <div data-testid={`child-${child.id}`} />}
    />,
  );
  return { ...view, onToggle };
}

describe("NestedDrawers", () => {
  it("hides the child rows while collapsed and lists them when expanded", () => {
    const children = [makeSession({ id: "child-a" }), makeSession({ id: "child-b" })];
    const { rerender, getByTestId, queryByTestId } = renderDrawers(children, true);
    expect(queryByTestId("child-child-a")).toBeNull();
    expect(queryByTestId("child-child-b")).toBeNull();

    rerender(
      <NestedDrawers
        parentId="parent-1"
        shells={[]}
        subagents={children}
        isCollapsed={() => false}
        onToggle={vi.fn()}
        nowMs={NOW_MS}
        renderChild={(child) => <div data-testid={`child-${child.id}`} />}
      />,
    );
    expect(getByTestId("child-child-a")).toBeTruthy();
    expect(getByTestId("child-child-b")).toBeTruthy();
  });

  it("emits the persisted open marker when the header is clicked", () => {
    const { getByRole, onToggle } = renderDrawers([makeSession()], true);
    fireEvent.click(getByRole("button"));
    expect(onToggle).toHaveBeenCalledWith(nestedDrawerOpenMarker("chat-subagents:parent-1"));
  });

  it.each([
    ["running", makeSession({ id: "busy", status: "running", runtimeState: "running" }), /running/i],
    ["failed", makeSession({ id: "fail", lastTurnFailedAt: NOW_ISO }), /failed/i],
    ["needs you", makeSession({ id: "ask", attentionRequestedAt: NOW_ISO }), /needs you/i],
  ] as const)(
    "names the drawer status (%s) in the header's accessible name",
    (_label, child, statusPattern) => {
      const { getByRole } = renderDrawers([child], true);
      expect(getByRole("button", { name: statusPattern })).toBeTruthy();
    },
  );
});
