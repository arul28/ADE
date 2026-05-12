/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentChatEventEnvelope } from "../../../shared/types";
import type { ChatSubagentSnapshot } from "./chatExecutionSummary";
import { ChatSubagentsPanel } from "./ChatSubagentsPanel";

vi.mock("motion/react", () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  },
}));

const snapshot: ChatSubagentSnapshot = {
  taskId: "task-1",
  description: "Audit chat renderer",
  status: "running",
  startedAt: "2026-05-12T00:00:00.000Z",
  updatedAt: "2026-05-12T00:00:10.000Z",
  summary: "Inspecting the transcript",
  lastToolName: "rg",
  background: true,
  usage: { durationMs: 10_000, toolUses: 2, totalTokens: 1234 },
};

function buildTimelineEvents(count = 0): AgentChatEventEnvelope[] {
  const events: AgentChatEventEnvelope[] = [{
    sessionId: "session-1",
    timestamp: "2026-05-12T00:00:00.000Z",
    event: {
      type: "subagent_started",
      taskId: "task-1",
      description: "Audit chat renderer",
      background: true,
    },
  }];

  for (let index = 0; index < count; index += 1) {
    events.push({
      sessionId: "session-1",
      timestamp: `2026-05-12T00:00:${String(index + 1).padStart(2, "0")}.000Z`,
      event: {
        type: "subagent_progress",
        taskId: "task-1",
        summary: `Progress ${index}`,
        lastToolName: "rg",
      },
    });
  }

  return events;
}

describe("ChatSubagentsPanel", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("toggles the drawer, opens detail, and returns to the list", () => {
    render(
      <ChatSubagentsPanel
        snapshots={[snapshot]}
        events={buildTimelineEvents(2)}
      />,
    );

    const trigger = screen.getByRole("button", { name: /Subagents/i });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: /Audit chat renderer/i })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Audit chat renderer/i }));
    expect(screen.getByText("task-1")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Back/i }));
    expect(screen.getByRole("button", { name: /Audit chat renderer/i })).toBeTruthy();
  });

  it("shows hidden timeline events and copies the subagent id", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(
      <ChatSubagentsPanel
        snapshots={[snapshot]}
        events={buildTimelineEvents(25)}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Subagents/i }));
    fireEvent.click(screen.getByRole("button", { name: /Audit chat renderer/i }));

    expect(screen.queryByText("Progress 0")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Show .* earlier events/i }));
    expect(screen.getByText("Progress 0")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Copy id/i }));
    expect(writeText).toHaveBeenCalledWith("task-1");
  });
});
