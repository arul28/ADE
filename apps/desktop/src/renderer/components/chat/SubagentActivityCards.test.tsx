/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BackgroundJobLine, SubagentResultCard, SubagentSpawnCard, SubagentStoppedGroupCard } from "./SubagentActivityCards";
import type {
  BackgroundJobGroupRenderEvent,
  SubagentResultCardRenderEvent,
  SubagentSpawnAnchorRenderEvent,
  SubagentStoppedGroupEvent,
} from "./chatTranscriptRows";

// The provider mark renders the host's tool logo. Stub it so the test can
// assert WHICH tool type was derived without depending on lobe icon internals.
vi.mock("../terminals/ToolLogos", () => ({
  ToolLogo: ({ toolType }: { toolType?: string | null }) => (
    <span data-testid="tool-logo" data-tool-type={toolType ?? ""} />
  ),
}));

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
    taskId: null,
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

  it("stops a running native subagent without navigating", () => {
    const onStop = vi.fn();
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    render(
      <SubagentSpawnCard
        event={spawnEvent({
          childSessionId: null,
          spawnKind: null,
          agentType: "Explore",
          taskId: "task-explore-1",
        })}
        onStop={onStop}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Stop Wave 2 UI" }));
    expect(onStop).toHaveBeenCalledWith("task-explore-1");
    const navEvent = dispatchSpy.mock.calls
      .map(([evt]) => evt)
      .find((evt): evt is CustomEvent => evt instanceof CustomEvent && evt.type === "ade:work:select-session");
    expect(navEvent).toBeUndefined();
  });

  it("wears the owning runtime's provider mark on the bottom line", () => {
    const { container } = render(<SubagentSpawnCard event={spawnEvent()} provider="opencode" />);
    const mark = container.querySelector("[data-subagent-provider]");
    expect(mark?.getAttribute("data-subagent-provider")).toBe("opencode");
    // The same tool-type mapping the Work session rows use.
    expect(screen.getByTestId("tool-logo").getAttribute("data-tool-type")).toBe("opencode-chat");
  });

  it("renders no provider mark when the runtime is unknown", () => {
    const { container } = render(<SubagentSpawnCard event={spawnEvent()} provider={null} />);
    expect(container.querySelector("[data-subagent-provider]")).toBeNull();
    expect(screen.queryByTestId("tool-logo")).toBeNull();
  });
});

describe("SubagentResultCard", () => {
  function resultEvent(overrides: Partial<SubagentResultCardRenderEvent> = {}): SubagentResultCardRenderEvent {
    return {
      type: "subagent_result_card",
      agentKey: "child-abc",
      description: "Wave 2 UI",
      status: "completed",
      summaryPreview: "Kickoff turn finished.",
      error: null,
      stopSource: "unknown",
      stopReason: null,
      lastActivity: null,
      resultLanded: false,
      startedAt: "2026-07-14T10:00:00.000Z",
      endedAt: "2026-07-14T10:01:00.000Z",
      durationMs: 60_000,
      totalTokens: null,
      toolUseCount: 2,
      worktreeBranch: null,
      worktreePath: null,
      parentLabel: null,
      childSessionId: null,
      spawnKind: null,
      ...overrides,
    };
  }

  it("navigates to the spawned chat after the spawn card is dropped", () => {
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    render(
      <SubagentResultCard
        event={resultEvent({ childSessionId: "child-abc", spawnKind: "peer" })}
        laneId="lane-1"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /open/i }));

    const navEvent = dispatchSpy.mock.calls
      .map(([evt]) => evt)
      .find((evt): evt is CustomEvent => evt instanceof CustomEvent && evt.type === "ade:work:select-session");
    expect(navEvent).toBeTruthy();
    expect(navEvent!.detail).toEqual({ sessionId: "child-abc", laneId: "lane-1" });
    expect(screen.getByText("PEER")).toBeTruthy();
    expect(screen.queryByText("View transcript")).toBeNull();
  });

  it("keeps Chat Info for a runtime-native result", () => {
    const onViewTranscript = vi.fn();
    render(<SubagentResultCard event={resultEvent()} onViewTranscript={onViewTranscript} />);
    fireEvent.click(screen.getByRole("button", { name: /View transcript/i }));
    expect(onViewTranscript).toHaveBeenCalledTimes(1);
  });

  it("wears the owning runtime's provider mark beside the counters", () => {
    const { container } = render(<SubagentResultCard event={resultEvent()} provider="claude" />);
    expect(container.querySelector("[data-subagent-provider]")?.getAttribute("data-subagent-provider")).toBe("claude");
    expect(screen.getByTestId("tool-logo").getAttribute("data-tool-type")).toBe("claude-chat");
  });

  it("renders the provider mark even when the result has no counters", () => {
    const { container } = render(
      <SubagentResultCard event={resultEvent({ toolUseCount: null, totalTokens: null })} provider="codex" />,
    );
    expect(container.querySelector("[data-subagent-provider]")?.getAttribute("data-subagent-provider")).toBe("codex");
  });

  it.each([
    ["user", null, "you interrupted"],
    ["system", "the ADE brain restarted", "the ADE brain restarted"],
    ["foreign-brain", "another ADE brain took over this chat", "another ADE brain took over this chat"],
    ["provider", "the provider ended the turn", "the provider ended the turn"],
    ["unknown", null, "stopped"],
  ] as const)("uses the stop source in the lone card headline (%s)", (stopSource, stopReason, expected) => {
    const { container } = render(
      <SubagentResultCard
        event={resultEvent({
          description: null,
          status: "stopped",
          summaryPreview: null,
          stopSource,
          stopReason,
        })}
      />,
    );
    expect(container.textContent).toContain(expected);
  });

  it("shows the stopped agent's last activity and report outcome", () => {
    const { container } = render(
      <SubagentResultCard
        event={resultEvent({
          status: "stopped",
          stopSource: "system",
          stopReason: "the ADE brain restarted",
          lastActivity: "Writing the report",
          resultLanded: true,
        })}
      />,
    );
    expect(container.textContent).toContain("the ADE brain restarted");
    expect(container.textContent).not.toContain("report landed");
    expect(container.textContent).not.toContain("work lost");
  });
});

describe("BackgroundJobLine", () => {
  const group = (
    overrides: Partial<BackgroundJobGroupRenderEvent> = {},
  ): BackgroundJobGroupRenderEvent => ({
    type: "background_job_group",
    count: 8,
    label: "wait for desktop agents",
    agentKeys: Array.from({ length: 8 }, (_, index) => `bg-${index + 1}`),
    startedAt: "2026-08-06T10:00:00.000Z",
    status: "running",
    ...overrides,
  } as BackgroundJobGroupRenderEvent);

  it("renders a folded run as one line with a multiplier", () => {
    render(<BackgroundJobLine event={group()} sessionEnded />);
    expect(screen.getByText(/wait for desktop agents ×8/)).toBeTruthy();
  });

  it("keeps the same working open affordance on a group", () => {
    const onOpen = vi.fn();
    render(<BackgroundJobLine event={group()} sessionEnded onOpenBackgroundJobs={onOpen} />);

    fireEvent.click(screen.getByRole("button", { name: /open/i }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("shows no multiplier for a single job", () => {
    render(
      <BackgroundJobLine
        event={{
          type: "background_job_line",
          agentKey: "bg-1",
          label: "npm install",
          startedAt: "2026-08-06T10:00:00.000Z",
          status: "running",
        }}
        sessionEnded
      />,
    );
    expect(screen.getByText(/npm install/).textContent).not.toContain("×");
  });

  it("stops a running job by provider task id", () => {
    const onStop = vi.fn();
    render(
      <BackgroundJobLine
        event={{
          type: "background_job_line",
          agentKey: "bg-1",
          label: "npm install",
          startedAt: "2026-08-06T10:00:00.000Z",
          status: "running",
          taskId: "bg-1",
        }}
        onStop={onStop}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /stop npm install/i }));
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onStop).toHaveBeenCalledWith("bg-1");
  });
});

describe("SubagentStoppedGroupCard", () => {
  function groupEvent(
    cause: SubagentStoppedGroupEvent["cause"],
    overrides: Partial<SubagentStoppedGroupEvent> = {},
  ): SubagentStoppedGroupEvent {
    return {
      type: "subagent_stopped_group",
      cause,
      stopSource: "user",
      stopReason: null,
      count: 3,
      items: [
        { agentKey: "a", title: "Explore auth flow", lastActivity: "reading authRouter.ts", resultLanded: false },
        { agentKey: "b", title: "Explore sync flow", lastActivity: null, resultLanded: true },
        { agentKey: "c", title: "Explore the UI", lastActivity: null, resultLanded: false },
      ],
      ...overrides,
    };
  }

  it("names the cause in the head row so a limit never reads as an interrupt", () => {
    const { container } = render(<SubagentStoppedGroupCard event={groupEvent("usage_limit")} />);
    expect(container.textContent).toContain("3 agents stopped · usage limit");
    expect(container.textContent).not.toContain("interrupted");
  });

  it("keeps the interrupt wording for an interrupt", () => {
    const { container } = render(<SubagentStoppedGroupCard event={groupEvent("interrupt")} />);
    expect(container.textContent).toContain("3 agents stopped when you interrupted");
  });

  it("lists each folded agent behind the expander", () => {
    render(<SubagentStoppedGroupCard event={groupEvent("usage_limit")} />);
    // Expanded by default up to a handful of agents.
    expect(screen.getByTitle("Explore sync flow")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { expanded: true }));
    expect(screen.queryByTitle("Explore sync flow")).toBeNull();
  });

  it("does not offer jump-to-start when the list omits a scroller (folded rows are gone)", () => {
    render(<SubagentStoppedGroupCard event={groupEvent("interrupt")} />);
    expect(screen.queryByRole("button", { name: "Explore auth flow jump to start" })).toBeNull();
    expect(screen.getByTitle(/Explore auth flow/u)).toBeTruthy();
  });

  it("blames an ADE brain restart on the restart, not on the reader", () => {
    const { container } = render(
      <SubagentStoppedGroupCard
        event={groupEvent("interrupt", { stopSource: "system", stopReason: "the ADE brain restarted" })}
      />,
    );
    expect(container.textContent).toContain("3 agents stopped: the ADE brain restarted");
    expect(container.textContent).not.toContain("when you interrupted");
  });

  it("names a sibling brain takeover as a takeover", () => {
    const { container } = render(
      <SubagentStoppedGroupCard
        event={groupEvent("interrupt", {
          stopSource: "foreign-brain",
          stopReason: "another ADE brain took over this chat",
        })}
      />,
    );
    expect(container.textContent).toContain("3 agents stopped: another ADE brain took over this chat");
    expect(container.textContent).not.toContain("when you interrupted");
  });

  it("names a provider-ended turn as the provider's doing", () => {
    const { container } = render(
      <SubagentStoppedGroupCard
        event={groupEvent("interrupt", { stopSource: "provider", stopReason: "the provider ended the turn" })}
      />,
    );
    expect(container.textContent).toContain("3 agents stopped: the provider ended the turn");
  });

  it("claims nothing at all when a legacy event carries no source or reason", () => {
    const { container } = render(
      <SubagentStoppedGroupCard event={groupEvent("interrupt", { stopSource: "unknown", stopReason: null })} />,
    );
    expect(container.textContent).toContain("3 agents stopped");
    expect(container.textContent).not.toContain("when you interrupted");
  });

  it("shows each agent's last activity and whether its report landed", () => {
    const { container } = render(
      <SubagentStoppedGroupCard
        event={groupEvent("interrupt", { stopSource: "system", stopReason: "the ADE brain restarted" })}
      />,
    );
    expect(container.textContent).toContain("Explore auth flow · reading authRouter.ts");
    expect(container.textContent).not.toContain("work lost");
    expect(container.textContent).not.toContain("outcome");
  });
});
