/**
 * Tests for ChatChannelList component.
 *
 * Validates the rendering of channels, section labels, status dots,
 * unread badges, and collapsed state.
 */
/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import type { Channel } from "./ChatChannelList";
import { ChatChannelList } from "./ChatChannelList";

afterEach(() => {
  cleanup();
});

function makeChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: "ch-1",
    kind: "worker",
    label: "Worker 1",
    fullLabel: "Worker 1",
    threadId: "thread-1",
    sessionId: null,
    status: "active",
    stepKey: null,
    attemptId: null,
    unreadCount: 0,
    phaseLabel: null,
    ...overrides,
  };
}

const orchestratorChannel: Channel = makeChannel({
  id: "ch-orch",
  kind: "orchestrator",
  label: "Orchestrator",
  fullLabel: "Orchestrator",
  status: "active",
  unreadCount: 3,
});

describe("ChatChannelList", () => {
  it("renders the 'Mission Feed' global channel", () => {
    render(createElement(ChatChannelList, {
      channels: [],
      orchestratorChannel: null,
      teammateChannels: [],
      activeWorkerChannels: [],
      completedWorkerChannels: [],
      selectedChannelId: "global",
      completedCollapsed: false,
      workerStatusDot: () => "#22C55E",
      onSelectChannel: vi.fn(),
      onToggleCompletedCollapsed: vi.fn(),
    }));

    expect(screen.getByText("Mission Feed")).toBeTruthy();
  });

  it("renders orchestrator section when orchestratorChannel is provided", () => {
    render(createElement(ChatChannelList, {
      channels: [orchestratorChannel],
      orchestratorChannel,
      teammateChannels: [],
      activeWorkerChannels: [],
      completedWorkerChannels: [],
      selectedChannelId: "global",
      completedCollapsed: false,
      workerStatusDot: () => "#22C55E",
      onSelectChannel: vi.fn(),
      onToggleCompletedCollapsed: vi.fn(),
    }));

    expect(screen.getByText("ORCHESTRATOR")).toBeTruthy();
    expect(screen.getByText("Orchestrator")).toBeTruthy();
  });

  it("renders unread badge with count for orchestrator", () => {
    render(createElement(ChatChannelList, {
      channels: [orchestratorChannel],
      orchestratorChannel,
      teammateChannels: [],
      activeWorkerChannels: [],
      completedWorkerChannels: [],
      selectedChannelId: "global",
      completedCollapsed: false,
      workerStatusDot: () => "#22C55E",
      onSelectChannel: vi.fn(),
      onToggleCompletedCollapsed: vi.fn(),
    }));

    expect(screen.getByText("3")).toBeTruthy();
  });

  it("renders teammate channels when provided", () => {
    const teammate = makeChannel({
      id: "ch-team",
      kind: "teammate",
      label: "Team A",
      status: "active",
    });
    render(createElement(ChatChannelList, {
      channels: [teammate],
      orchestratorChannel: null,
      teammateChannels: [teammate],
      activeWorkerChannels: [],
      completedWorkerChannels: [],
      selectedChannelId: "global",
      completedCollapsed: false,
      workerStatusDot: () => "#22C55E",
      onSelectChannel: vi.fn(),
      onToggleCompletedCollapsed: vi.fn(),
    }));

    expect(screen.getByText("TEAMMATES")).toBeTruthy();
    expect(screen.getByText("Team A")).toBeTruthy();
  });

  it("renders active worker channels", () => {
    const worker = makeChannel({
      id: "ch-w1",
      kind: "worker",
      label: "Planner",
      status: "active",
      phaseLabel: "Planning",
    });
    render(createElement(ChatChannelList, {
      channels: [worker],
      orchestratorChannel: null,
      teammateChannels: [],
      activeWorkerChannels: [worker],
      completedWorkerChannels: [],
      selectedChannelId: "global",
      completedCollapsed: false,
      workerStatusDot: () => "#22C55E",
      onSelectChannel: vi.fn(),
      onToggleCompletedCollapsed: vi.fn(),
    }));

    expect(screen.getByText("ACTIVE")).toBeTruthy();
    expect(screen.getByText("Planner")).toBeTruthy();
    expect(screen.getByText("Planning")).toBeTruthy();
  });

  it("renders completed section with count and respects collapsed state", () => {
    const completed = makeChannel({
      id: "ch-c1",
      kind: "worker",
      label: "Done Worker",
      status: "closed",
    });
    const onToggle = vi.fn();

    render(createElement(ChatChannelList, {
      channels: [completed],
      orchestratorChannel: null,
      teammateChannels: [],
      activeWorkerChannels: [],
      completedWorkerChannels: [completed],
      selectedChannelId: "global",
      completedCollapsed: true,
      workerStatusDot: () => "#6b7280",
      onSelectChannel: vi.fn(),
      onToggleCompletedCollapsed: onToggle,
    }));

    // Should show the collapsed button with count
    const completedButton = screen.getByText(/COMPLETED \(1\)/);
    expect(completedButton).toBeTruthy();
    // Worker should NOT be visible when collapsed
    expect(screen.queryByText("Done Worker")).toBeNull();

    // Click to toggle
    fireEvent.click(completedButton);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("shows 'No worker channels yet' when only global channel exists", () => {
    render(createElement(ChatChannelList, {
      channels: [makeChannel({ id: "global", kind: "global" })],
      orchestratorChannel: null,
      teammateChannels: [],
      activeWorkerChannels: [],
      completedWorkerChannels: [],
      selectedChannelId: "global",
      completedCollapsed: false,
      workerStatusDot: () => "#22C55E",
      onSelectChannel: vi.fn(),
      onToggleCompletedCollapsed: vi.fn(),
    }));

    expect(screen.getByText("No worker channels yet")).toBeTruthy();
  });

  it("calls onSelectChannel when a channel button is clicked", () => {
    const onSelect = vi.fn();
    render(createElement(ChatChannelList, {
      channels: [orchestratorChannel],
      orchestratorChannel,
      teammateChannels: [],
      activeWorkerChannels: [],
      completedWorkerChannels: [],
      selectedChannelId: "global",
      completedCollapsed: false,
      workerStatusDot: () => "#22C55E",
      onSelectChannel: onSelect,
      onToggleCompletedCollapsed: vi.fn(),
    }));

    fireEvent.click(screen.getByText("Orchestrator"));
    expect(onSelect).toHaveBeenCalledWith("ch-orch");
  });
});
