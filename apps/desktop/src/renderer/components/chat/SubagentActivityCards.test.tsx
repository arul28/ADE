/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  SUBAGENT_CARD_CHROME,
  SubagentCardGrid,
  SubagentResultCard,
  SubagentSpawnCard,
  SubagentStoppedGroupCard,
  subagentCardGridCellClass,
} from "./SubagentActivityCards";
import { subagentCardGridSpan } from "./chatTranscriptRows";
import type {
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
    provider: null,
    background: false,
    status: "running",
    statusLine: null,
    lastToolName: null,
    toolCount: null,
    startedAt: "2026-07-14T10:00:00.000Z",
    childSessionId: "child-abc",
    spawnKind: "subagent",
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

  it("titles a Codex agent by its name, not its path, and drops the identity pill", () => {
    const { container } = render(
      <SubagentSpawnCard
        event={spawnEvent({
          description: "/root/desktop_scan",
          agentType: "/root/desktop_scan",
          label: "/root/desktop_scan",
          childSessionId: null,
          spawnKind: null,
          taskId: "thread-1",
        })}
        onStop={() => undefined}
      />,
    );
    expect(container.querySelector("[data-subagent-name]")?.textContent).toBe("Desktop scan");
    expect(screen.getAllByText("Desktop scan")).toHaveLength(1);
    expect(container.textContent).not.toContain("/root/");
    expect(container.textContent).toMatch(/^Desktop scanrunning/);
    expect(container.querySelector("[data-subagent-glyph-status]")?.getAttribute("data-subagent-glyph-status")).toBe("running");
    expect(screen.getByRole("button", { name: "Stop Desktop scan" })).toBeTruthy();
  });

  it("opens a runtime-native agent's transcript from the card, but not from Stop", () => {
    const onOpenTranscript = vi.fn();
    const onStop = vi.fn();
    render(
      <SubagentSpawnCard
        event={spawnEvent({ childSessionId: null, spawnKind: null, agentType: "Explore", taskId: "task-1" })}
        onOpenTranscript={onOpenTranscript}
        onStop={onStop}
      />,
    );
    fireEvent.click(screen.getByText("Wave 2 UI"));
    expect(onOpenTranscript).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Stop Wave 2 UI" }));
    expect(onStop).toHaveBeenCalledWith("task-1");
    expect(onOpenTranscript).toHaveBeenCalledTimes(1);
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

  it("renders settled metadata beside the result summary", () => {
    render(<SubagentResultCard event={resultEvent({ spawnKind: "subagent" })} />);
    expect(screen.queryByText("SUBAGENT")).toBeNull();
    expect(screen.getByTitle(/subagent/)).toBeTruthy();
    expect(screen.getByText("Kickoff turn finished.")).toBeTruthy();
  });

  it("navigates to the spawned chat once the card has settled", () => {
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
    expect(screen.getByTitle(/peer · ran for/)).toBeTruthy();
    expect(screen.queryByText("View transcript")).toBeNull();
  });

  it("keeps Chat Info for a runtime-native result, through the card instead of a text link", () => {
    const onViewTranscript = vi.fn();
    const { container } = render(<SubagentResultCard event={resultEvent()} onViewTranscript={onViewTranscript} />);
    expect(container.textContent).not.toMatch(/view transcript/i);

    fireEvent.click(screen.getByRole("button", { name: "View Wave 2 UI transcript" }));
    expect(onViewTranscript).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("Kickoff turn finished."));
    expect(onViewTranscript).toHaveBeenCalledTimes(2);
  });

  it("lays a finished card out like the running one: badge on the glyph, name, one line, counts", () => {
    const { container } = render(
      <SubagentResultCard
        event={resultEvent({ description: "/root/desktop_scan", agentType: "/root/desktop_scan", toolUseCount: 12 })}
        provider="codex"
      />,
    );
    const card = container.querySelector("[data-subagent-card]")!;
    expect(card.getAttribute("data-subagent-card")).toBe("result");
    expect(card.getAttribute("data-subagent-status")).toBe("completed");
    // The check sits ON the glyph, not beside the title.
    const glyph = card.querySelector("[data-subagent-glyph-status]")!;
    expect(glyph.getAttribute("data-subagent-glyph-status")).toBe("completed");
    expect(glyph.querySelector("[role='img']")?.getAttribute("aria-label")).toBe("Finished");
    expect(card.querySelector("[data-subagent-name]")?.textContent).toBe("Desktop scan");
    expect(container.textContent).not.toContain("/root/");
    // On the card's face: one result line and how long it took.
    expect(card.querySelector("[data-subagent-overview]")?.textContent).toBe("Kickoff turn finished.");
    expect(container.textContent).toContain("1m");
    // The rest of the facts are the card's tooltip, not three lines of type.
    expect(card.getAttribute("title")).toContain("ran for 1m");
    expect(card.getAttribute("title")).toContain("12 tools");
    expect(card.querySelector("[data-subagent-provider]")?.getAttribute("data-subagent-provider")).toBe("codex");
    // No text link and no identity pill.
    expect(container.textContent).not.toMatch(/view transcript/i);
    expect(screen.getAllByText("Desktop scan")).toHaveLength(1);
  });

  it("badges a failure red, says what broke on the card, and keeps the rest in the tooltip", () => {
    const onViewTranscript = vi.fn();
    const { container } = render(
      <SubagentResultCard
        event={resultEvent({ status: "failed", summaryPreview: "Build broke", error: "Build broke\nstack line" })}
        onViewTranscript={onViewTranscript}
      />,
    );
    expect(container.querySelector("[data-subagent-glyph-status] [role='img']")?.getAttribute("aria-label")).toBe("Failed");
    expect(container.textContent).toContain("failed");
    const card = container.querySelector("[data-subagent-card]")!;
    // A failure's own message IS its line, never hidden behind a disclosure.
    expect(card.querySelector("[data-subagent-overview]")?.textContent).toBe("Build broke");
    expect(card.getAttribute("title")).toContain("stack line");
    expect(screen.queryByRole("button", { name: /Details/ })).toBeNull();
    // Nothing on the card takes over the chat by accident.
    expect(onViewTranscript).not.toHaveBeenCalled();
  });

  it("hides an all-zero diff-stat summary and keeps one with any change", () => {
    const zero = render(<SubagentResultCard event={resultEvent({ summaryPreview: "+0 −0 · 0 files" })} />);
    expect(zero.container.querySelector("[data-subagent-overview]")?.textContent).toBe("");
    expect(zero.container.textContent).not.toContain("0 files");
    expect(zero.container.textContent).toContain("1m");
    zero.unmount();

    for (const summary of ["+3 −0 · 1 files", "+0 −2 · 1 files", "+0 −0 · 1 files"]) {
      const view = render(<SubagentResultCard event={resultEvent({ summaryPreview: summary })} />);
      expect(view.container.querySelector("[data-subagent-overview]")?.textContent).toBe(summary);
      view.unmount();
    }
  });

  it("shows a markdown report as one line of plain prose", () => {
    const { container } = render(
      <SubagentResultCard event={resultEvent({ summaryPreview: "## ADE Summary\n\n**ADE** is a unified workspace:\n- across `macOS`\n- and [iOS](https://ade.dev/ios)" })} />,
    );
    const overview = container.querySelector("[data-subagent-overview]");
    expect(overview?.textContent).toBe("ADE Summary: ADE is a unified workspace: across macOS; and iOS");
    // The full prose is the card's own summary, not a markdown document.
    expect(container.textContent).not.toMatch(/[*#`]/);
  });

  it("hides an all-zero diff-stat summary on a stopped card and falls back to its outcome", () => {
    const { container } = render(
      <SubagentResultCard
        event={resultEvent({ status: "stopped", summaryPreview: "+0 −0 · 0 files", stopSource: "user", resultLanded: false })}
      />,
    );
    expect(container.querySelector("[data-subagent-overview]")?.textContent).toBe("you interrupted · work lost");
    expect(container.textContent).not.toContain("0 files");
  });

  it("badges a stopped agent neutral on the same layout", () => {
    const { container } = render(
      <SubagentResultCard event={resultEvent({ status: "stopped", summaryPreview: null, stopSource: "user" })} />,
    );
    const glyph = container.querySelector("[data-subagent-glyph-status]")!;
    expect(glyph.getAttribute("data-subagent-glyph-status")).toBe("stopped");
    expect(glyph.querySelector("[role='img']")?.getAttribute("aria-label")).toBe("Stopped");
    // The badge says "stopped"; the card says who did it and whether work survived.
    expect(container.querySelector("[data-subagent-overview]")?.textContent).toBe("you interrupted · work lost");
    expect(container.querySelector("[data-subagent-card]")?.getAttribute("title"))
      .toContain("stopped · you interrupted · ran for 1m");
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
    ["unknown", null, "work lost"],
  ] as const)("names the stop source on a lone stopped card (%s)", (stopSource, stopReason, expected) => {
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
    expect(container.querySelector("[data-subagent-overview]")?.textContent).toContain(expected);
  });

  it("keeps a stopped agent's own report as its line, stop source in the tooltip", () => {
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
    expect(container.querySelector("[data-subagent-overview]")?.textContent).toBe("Kickoff turn finished.");
    expect(container.querySelector("[data-subagent-card]")?.getAttribute("title")).toContain("the ADE brain restarted");
  });

  it("fills a stopped card with no report with its activity, its stopper and the work's fate", () => {
    const { container } = render(
      <SubagentResultCard
        event={resultEvent({
          status: "stopped",
          summaryPreview: "Stopped: the ADE brain restarted",
          stopSource: "system",
          stopReason: "the ADE brain restarted",
          lastActivity: "Reading authRouter.ts",
          resultLanded: false,
        })}
      />,
    );
    // The stop sentence restates the status line; it is never the body.
    expect(container.querySelector("[data-subagent-overview]")?.textContent)
      .toBe("Reading authRouter.ts · the ADE brain restarted · work lost");
  });

  it("says who stopped it and whether the work survived when there is no activity either", () => {
    const { container } = render(
      <SubagentResultCard
        event={resultEvent({ status: "stopped", summaryPreview: "Interrupted", stopSource: "user", resultLanded: false })}
      />,
    );
    expect(container.querySelector("[data-subagent-overview]")?.textContent).toBe("you interrupted · work lost");
  });
});

describe("subagent card chrome", () => {
  it("gives a running card the same container as a settled one", () => {
    const running = render(<SubagentSpawnCard event={spawnEvent({ spawnKind: null, childSessionId: null })} />);
    const runningFrame = running.container.querySelector("[data-subagent-card]") as HTMLElement;
    expect(runningFrame.getAttribute("data-subagent-status")).toBe("running");
    for (const cls of SUBAGENT_CARD_CHROME.split(" ")) expect([...runningFrame.classList]).toContain(cls);
    const runningClasses = runningFrame.className;
    running.unmount();

    const settled = render(
      <SubagentResultCard
        event={{
          type: "subagent_result_card",
          agentKey: "child-abc",
          description: "Wave 2 UI",
          status: "completed",
          summaryPreview: "Done.",
          error: null,
          stopSource: "unknown",
          stopReason: null,
          lastActivity: null,
          resultLanded: false,
          startedAt: "2026-07-14T10:00:00.000Z",
          endedAt: "2026-07-14T10:01:00.000Z",
          durationMs: 60_000,
          totalTokens: null,
          toolUseCount: null,
          worktreeBranch: null,
          worktreePath: null,
          parentLabel: null,
          childSessionId: null,
          spawnKind: null,
        }}
      />,
    );
    const settledFrame = settled.container.querySelector("[data-subagent-card]") as HTMLElement;
    // Border, background, radius, padding: identical frames, only state differs.
    expect(settledFrame.className).toBe(runningClasses);
  });

  it("keeps spawned-chat kind in the card's quiet facts, not on its face", () => {
    const { container } = render(<SubagentSpawnCard event={spawnEvent({ spawnKind: "subagent" })} />);
    const frame = container.querySelector("[data-subagent-card]") as HTMLElement;
    expect(frame.getAttribute("title")).toContain("subagent");
    expect(frame.textContent).not.toContain("subagent");
  });
});

describe("SubagentCardGrid", () => {
  const spansAt = (count: number, columns: number) =>
    Array.from({ length: count }, (_, index) => subagentCardGridSpan(index, count, columns));

  it("fills rows of three, and a short last row shares the full width", () => {
    // Spans are out of six tracks: 2 = a third, 3 = a half, 6 = full width.
    expect(spansAt(3, 3)).toEqual([2, 2, 2]);
    expect(spansAt(4, 3)).toEqual([2, 2, 2, 6]);
    expect(spansAt(5, 3)).toEqual([2, 2, 2, 3, 3]);
    expect(spansAt(7, 3)).toEqual([2, 2, 2, 2, 2, 2, 6]);
    expect(spansAt(1, 3)).toEqual([6]);
    expect(spansAt(2, 3)).toEqual([3, 3]);
  });

  it("applies the same fill rule at the two- and one-column fallbacks", () => {
    expect(spansAt(3, 2)).toEqual([3, 3, 6]);
    expect(spansAt(5, 2)).toEqual([3, 3, 3, 3, 6]);
    expect(spansAt(4, 2)).toEqual([3, 3, 3, 3]);
    expect(spansAt(3, 1)).toEqual([6, 6, 6]);
  });

  it("maps each span to a container-query class at the estimate's breakpoints", () => {
    // Fifth of five: full width at one and two columns (5 % 2 leaves it alone), a half at three.
    expect(subagentCardGridCellClass(4, 5).split(" ")).toEqual([
      "col-span-6",
      "@min-[472px]:col-span-6",
      "@min-[712px]:col-span-3",
    ]);
    expect(subagentCardGridCellClass(0, 5).split(" ")).toEqual([
      "col-span-6",
      "@min-[472px]:col-span-3",
      "@min-[712px]:col-span-2",
    ]);
  });

  it("draws its members keyed in one six-track container grid, and never remounts a card when one joins", () => {
    const members = ["a", "b", "c", "d"].map((key) => ({ key: `subagent-spawn:${key}` }));
    const view = render(
      <SubagentCardGrid members={members} renderCard={(member) => <span data-card>{member.key}</span>} />,
    );
    const grid = view.container.querySelector("[data-subagent-card-grid]") as HTMLElement;
    expect(grid.getAttribute("data-subagent-card-count")).toBe("4");
    expect([...grid.classList]).toContain("@container");
    expect([...grid.classList]).toContain("grid-cols-6");
    expect([...grid.classList]).toContain("items-stretch");
    const cells = () => [...grid.querySelectorAll("[data-subagent-card-key]")] as HTMLElement[];
    expect(cells().map((cell) => cell.getAttribute("data-subagent-card-key"))).toEqual(members.map((member) => member.key));
    // 4 cards: the fourth is full width under three thirds.
    expect(cells()[3]!.className).toContain("@min-[712px]:col-span-6");

    const firstCard = view.container.querySelector("[data-card]");
    const joined = [...members, { key: "subagent-spawn:e" }];
    view.rerender(<SubagentCardGrid members={joined} renderCard={(member) => <span data-card>{member.key}</span>} />);
    // Same DOM node: only the span classes changed.
    expect(view.container.querySelector("[data-card]")).toBe(firstCard);
    expect(cells()[3]!.className).toContain("@min-[712px]:col-span-3");
    expect(cells()[4]!.className).toContain("@min-[712px]:col-span-3");
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
      memberKeys: ["subagent-result:a", "subagent-result:b", "subagent-result:c"],
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

  it("shows markdown titles and activity as plain text", () => {
    const { container } = render(
      <SubagentStoppedGroupCard
        event={groupEvent("interrupt", {
          items: [
            { agentKey: "a", title: "**Explore** auth", lastActivity: "## Reading `authRouter.ts`", resultLanded: false },
            { agentKey: "b", title: "Explore sync flow", lastActivity: null, resultLanded: true },
            { agentKey: "c", title: "Explore the UI", lastActivity: null, resultLanded: false },
          ],
        })}
      />,
    );
    expect(container.textContent).toContain("Explore auth · Reading authRouter.ts");
    expect(container.textContent).not.toMatch(/[*#`]/);
    expect(screen.getByTitle("Explore auth — Reading authRouter.ts")).toBeTruthy();
  });

  it("shows each agent's last activity and whether its report landed", () => {
    const { container } = render(
      <SubagentStoppedGroupCard
        event={groupEvent("interrupt", { stopSource: "system", stopReason: "the ADE brain restarted" })}
      />,
    );
    expect(container.textContent).toContain("Explore auth flow · reading authRouter.ts");
    // Each row names whether that agent's work survived.
    expect(screen.getByTitle("Explore auth flow — reading authRouter.ts").textContent).toContain("work lost");
    expect(screen.getByTitle("Explore sync flow").textContent).toContain("report landed");
  });
});
