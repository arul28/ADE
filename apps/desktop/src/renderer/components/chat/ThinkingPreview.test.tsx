/* @vitest-environment jsdom */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { AgentChatEventEnvelope } from "../../../shared/types";
import {
  AgentChatMessageList,
  resetTranscriptCollapseCacheForTests,
  resetTurnFoldMemoryForTests,
} from "./AgentChatMessageList";
import { buildTranscriptEventRowKeys } from "./chatTranscriptRows";
import {
  THINKING_LIVE_MAX_LINES,
  THINKING_PREVIEW_TAIL_CHARS,
  deriveLiveThinkingRowKey,
  formatThinkingElapsed,
  countThinkingFencesBeforeCut,
  thinkingPreviewCut,
  thinkingPreviewTail,
  thoughtDurationSeconds,
} from "./ThinkingPreview";

vi.mock("@lobehub/icons", () => {
  const brand = () => {
    const Component = () => null;
    Object.assign(Component, {
      Avatar: () => null,
      Color: () => null,
      Combine: () => null,
      Text: () => null,
      colorPrimary: "#888",
      title: "stub",
    });
    return Component;
  };
  return {
    Claude: brand(),
    Codex: brand(),
    Cursor: brand(),
    OpenCode: brand(),
    GithubCopilot: brand(),
    Qwen: brand(),
  };
});

const SESSION = "session-thinking";

function at(second: number): string {
  return new Date(Date.UTC(2026, 8, 23, 10, 0, second)).toISOString();
}

function env(second: number, event: AgentChatEventEnvelope["event"]): AgentChatEventEnvelope {
  return { sessionId: SESSION, timestamp: at(second), event };
}

const userMessage = (second: number, turnId = "turn-1") =>
  env(second, { type: "user_message", text: "Why?", turnId } as AgentChatEventEnvelope["event"]);
const reasoning = (second: number, text: string, itemId = "r-1", turnId = "turn-1") =>
  env(second, { type: "reasoning", text, itemId, turnId });
const answer = (second: number, text: string, turnId = "turn-1") =>
  env(second, { type: "text", text, itemId: `text-${second}`, turnId });
const toolCall = (second: number, turnId = "turn-1") =>
  env(second, { type: "tool_call", tool: "functions.exec_command", args: { cmd: "pwd" }, itemId: `tool-${second}`, turnId });
const done = (second: number, turnId = "turn-1") =>
  env(second, { type: "done", turnId, status: "completed" });
const command = (second: number, turnId = "turn-1") =>
  env(second, { type: "command", command: "ade chat note", cwd: "/repo", output: "", itemId: `c-${second}`, turnId, status: "completed", exitCode: 0 });
/** A queued-message lifecycle that did not cancel: kept in the list, draws nothing. */
const lifecycle = (second: number, turnId = "turn-1") =>
  env(second, { type: "command_lifecycle", commandUuid: `cmd-${second}`, status: "completed", turnId });

function list(
  events: AgentChatEventEnvelope[],
  options: { live: boolean; assistantLabel?: string; scrollToRowKeyRequest?: { key: string; requestId: number } },
) {
  return (
    <MemoryRouter>
      <AgentChatMessageList
        events={events}
        sessionId={SESSION}
        showStreamingIndicator={options.live}
        assistantLabel={options.assistantLabel ?? "Claude"}
        scrollToRowKeyRequest={options.scrollToRowKeyRequest}
      />
    </MemoryRouter>
  );
}

const foldButton = () => screen.getByRole("button", { name: /\. (Show|Hide) the work from this turn$/ });
const thoughtButtons = () => screen.queryAllByRole("button", { name: /^Thought/ });

function stubReducedMotion(reduced: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn((query: string) => ({
      matches: reduced && query.includes("prefers-reduced-motion"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    })),
  });
}

const originalMatchMedia = window.matchMedia;

beforeEach(() => {
  resetTranscriptCollapseCacheForTests();
  resetTurnFoldMemoryForTests();
  stubReducedMotion(false);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Object.defineProperty(window, "matchMedia", { configurable: true, writable: true, value: originalMatchMedia });
});

describe("deriveLiveThinkingRowKey", () => {
  const row = (key: string, type: string, second: number, turnId: string | null = "turn-1") => ({
    key,
    timestamp: at(second),
    event: { type, turnId },
  });

  it("picks the newest reasoning row of the active turn", () => {
    expect(deriveLiveThinkingRowKey([row("u", "user_message", 0), row("r", "reasoning", 2)], "turn-1")).toBe("r");
  });

  it("returns null once any other row follows the thought", () => {
    expect(deriveLiveThinkingRowKey([row("r", "reasoning", 2), row("t", "text", 3)], "turn-1")).toBeNull();
    expect(deriveLiveThinkingRowKey([row("r", "reasoning", 2), row("w", "work_log_group", 3)], "turn-1")).toBeNull();
  });

  it("keeps a phase-merged thought live only while it is newer than the merged work", () => {
    // thought → tool → thought merges to [Thought, Work]; the thought row's
    // timestamp is its latest fragment.
    expect(deriveLiveThinkingRowKey([row("r", "reasoning", 9), row("w", "work_log_group", 5)], "turn-1")).toBe("r");
    expect(deriveLiveThinkingRowKey([row("r", "reasoning", 9), row("w", "work_log_group", 9)], "turn-1")).toBeNull();
  });

  it("ignores a reasoning row that belongs to another turn", () => {
    expect(deriveLiveThinkingRowKey([row("r", "reasoning", 2, "turn-old")], "turn-1")).toBeNull();
    expect(deriveLiveThinkingRowKey([], "turn-1")).toBeNull();
  });
});

describe("thinking helpers", () => {
  it("formats elapsed and finished-thought durations", () => {
    expect(formatThinkingElapsed(0)).toBe("0s");
    expect(formatThinkingElapsed(12.9)).toBe("12s");
    expect(formatThinkingElapsed(65)).toBe("1m 05s");
    expect(thoughtDurationSeconds(at(0), at(12))).toBe(12);
    // A single chunk (no start) or a sub-second span has no real duration.
    expect(thoughtDurationSeconds(undefined, at(12))).toBeNull();
    expect(thoughtDurationSeconds(at(3), at(3))).toBeNull();
  });

  it("keeps the tail of a long thought on a paragraph boundary and reopens a cut fence", () => {
    expect(thinkingPreviewTail("short")).toBe("short");
    const head = "x".repeat(THINKING_PREVIEW_TAIL_CHARS);
    const tail = thinkingPreviewTail(`${head}\n\nsecond paragraph`);
    expect(tail).toBe("second paragraph");
    const fenced = thinkingPreviewTail(`\`\`\`ts\n${head}\n\nconst a = 1;`);
    expect(fenced.startsWith("```\n")).toBe(true);
    expect(fenced.endsWith("const a = 1;")).toBe(true);
  });

  it("moves the unbroken live-thinking cut in fixed steps and counts cached fences by offset", () => {
    const before = "x".repeat(10_000);
    expect(thinkingPreviewCut(before)).toBe(thinkingPreviewCut(`${before}y`));
    expect(countThinkingFencesBeforeCut([10, 40, 90], 40)).toBe(2);
  });
});

describe("live thinking preview in the transcript", () => {
  it("shows the preview only on the live turn's newest, streaming reasoning row", () => {
    render(list([userMessage(0), reasoning(1, "Checking both imports before editing.")], { live: true }));

    const preview = screen.getByTestId("thinking-preview");
    expect(within(preview).getByTestId("thinking-heading").textContent).toBe("Claude is thinking");
    expect(within(preview).getByTestId("thinking-preview-card").textContent).toContain("Checking both imports before editing.");
    expect(screen.queryByText("Thought")).toBeNull();
  });

  it("falls back to plain 'Thinking' when no provider label is known", () => {
    render(list([userMessage(0), reasoning(1, "Hmm.")], { live: true, assistantLabel: "Assistant" }));
    expect(screen.getByTestId("thinking-heading").textContent).toBe("Thinking");
  });

  it("ticks the timer once per second from the thought's first fragment", () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date(at(4)));
    render(list([
      userMessage(0),
      reasoning(1, "First, "),
      reasoning(2, "then more."),
    ], { live: true }));

    expect(screen.getByTestId("thinking-elapsed").textContent).toBe("·3s");
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByTestId("thinking-elapsed").textContent).toBe("·4s");
    // Merged fragments render as one preview.
    expect(screen.getAllByTestId("thinking-preview")).toHaveLength(1);
    expect(screen.getByTestId("thinking-preview-card").textContent).toContain("First, then more.");
  });

  it("collapses to a Thought row when assistant text follows", () => {
    const view = render(list([userMessage(0), reasoning(1, "Planning.")], { live: true }));
    expect(screen.getByTestId("thinking-preview")).toBeTruthy();

    view.rerender(list([userMessage(0), reasoning(1, "Planning."), answer(3, "Here is the answer.")], { live: true }));

    expect(screen.queryByTestId("thinking-preview")).toBeNull();
    expect(screen.getByText("Thought")).toBeTruthy();
    // Same row, different presentation: the reasoning row key did not move.
    expect(document.querySelectorAll("[data-chat-row-key*=':reasoning:']")).toHaveLength(1);
  });

  it("collapses when a tool starts after the thought, even though tool rows are not drawn", () => {
    render(list([userMessage(0), reasoning(1, "Let me look."), toolCall(2)], { live: true }));
    expect(screen.queryByTestId("thinking-preview")).toBeNull();
    expect(screen.getByText("Thought")).toBeTruthy();
  });

  it("keeps a phase-merged thought live while its newest fragment follows the tool", () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date(at(10)));
    render(list([
      userMessage(0),
      reasoning(1, "Look first.", "r-1"),
      toolCall(2),
      reasoning(6, "Now decide.", "r-2"),
    ], { live: true }));

    const card = screen.getByTestId("thinking-preview-card");
    expect(card.textContent).toContain("Look first.");
    expect(card.textContent).toContain("Now decide.");
    // The timer counts the current thinking run, not the tool time before it.
    expect(screen.getByTestId("thinking-elapsed").textContent).toBe("·4s");
  });

  it("collapses when the turn ends and never previews a historical turn", () => {
    const view = render(list([userMessage(0), reasoning(1, "Planning.")], { live: true }));
    expect(screen.getByTestId("thinking-preview")).toBeTruthy();

    view.rerender(list([userMessage(0), reasoning(1, "Planning."), done(2)], { live: false }));
    expect(screen.queryByTestId("thinking-preview")).toBeNull();

    cleanup();
    render(list([userMessage(0), reasoning(1, "Old thought.")], { live: false }));
    expect(screen.queryByTestId("thinking-preview")).toBeNull();
    expect(screen.getByText("Thought")).toBeTruthy();
  });

  it("opens a collapsed Thought row into the grey block, with its measured duration", () => {
    render(list([
      userMessage(0),
      reasoning(1, "Weighing options."),
      reasoning(13, " Picked the second."),
      answer(14, "Done."),
    ], { live: true }));

    expect(screen.queryByTestId("thought-block")).toBeNull();
    expect(screen.getByText("for 12s")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Thought/ }));

    const block = screen.getByTestId("thought-block");
    expect(block.textContent).toContain("Weighing options. Picked the second.");
    expect(block.className).toContain("ade-thinking-card");
    // Full height: no fixed-height preview card or fades once opened.
    expect(screen.queryByTestId("thinking-preview-card")).toBeNull();
  });

  it("expands the live card to the full text on click and keeps it expanded while streaming", () => {
    const view = render(list([userMessage(0), reasoning(1, "Step one.")], { live: true }));

    fireEvent.click(screen.getByTestId("thinking-preview-card"));
    expect(screen.queryByTestId("thinking-preview-card")).toBeNull();
    expect(screen.getByTestId("thought-block").textContent).toContain("Step one.");

    view.rerender(list([userMessage(0), reasoning(1, "Step one."), reasoning(2, " Step two.")], { live: true }));
    expect(screen.queryByTestId("thinking-preview-card")).toBeNull();
    expect(screen.getByTestId("thought-block").textContent).toContain("Step one. Step two.");

    fireEvent.click(screen.getByTestId("thought-block"));
    expect(screen.getByTestId("thinking-preview-card")).toBeTruthy();
  });

  it("drops the shimmer, spinner and smooth scrolling under prefers-reduced-motion", () => {
    render(list([userMessage(0), reasoning(1, "Moving.")], { live: true }));
    expect(screen.getByTestId("thinking-heading").className).toContain("ade-thinking-shimmer");
    expect(screen.getByTestId("thinking-preview-scroll").className).toContain("ade-thinking-live-smooth");
    cleanup();

    stubReducedMotion(true);
    render(list([userMessage(0), reasoning(1, "Still.")], { live: true }));
    expect(screen.getByTestId("thinking-heading").className).not.toContain("ade-thinking-shimmer");
    expect(screen.getByTestId("thinking-spinner").getAttribute("class") ?? "").not.toContain("animate-spin");
    expect(screen.getByTestId("thinking-preview-scroll").className).not.toContain("ade-thinking-live-smooth");
  });

  it("draws the live thought as a compact block that grows to a four-line cap, not a fixed-height card", () => {
    render(list([userMessage(0), reasoning(1, "One line.")], { live: true }));

    const block = screen.getByTestId("thinking-preview-card");
    const viewport = screen.getByTestId("thinking-preview-scroll");
    // No grey box and no fixed height: a one-line thought is a one-line block.
    expect(block.className).not.toContain("ade-thinking-card");
    expect(block.className).not.toMatch(/(^|\s)h-\[/);
    expect(viewport.className).toContain("ade-thinking-live-viewport");
    expect(viewport.getAttribute("data-max-lines")).toBe(String(THINKING_LIVE_MAX_LINES));
    // The thought's own size and leading, so `1lh` is one line of its text.
    expect(viewport.className).toContain("leading-[1.65]");
    expect(within(viewport).getByText("One line.").closest(".ade-thought-text")).toBeTruthy();

    // The cap and the top fade live in the stylesheet (receipt for the rule).
    const css = readFileSync(join(__dirname, "../../index.css"), "utf8");
    expect(css).toMatch(/\.ade-thinking-live-viewport \{\s*max-height: calc\(4 \* 1lh\);\s*overflow: hidden;/);
    expect(css).toMatch(/\.ade-thinking-live-viewport\[data-overflowing="true"\] \{[^}]*mask-image: linear-gradient\(to bottom, transparent/);
  });

  it("follows the tail with at most one scroll write per frame and fades older lines once they overflow", () => {
    const frames: FrameRequestCallback[] = [];
    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const caf = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    try {
      const events = [userMessage(0), reasoning(1, "Line one.")];
      const view = render(list(events, { live: true }));
      const viewport = screen.getByTestId("thinking-preview-scroll");
      let top = 0;
      let writes = 0;
      Object.defineProperty(viewport, "scrollHeight", { configurable: true, get: () => 200 });
      Object.defineProperty(viewport, "clientHeight", { configurable: true, get: () => 80 });
      Object.defineProperty(viewport, "scrollTop", {
        configurable: true,
        get: () => top,
        set: (value: number) => {
          writes += 1;
          top = value;
        },
      });

      // Two store deltas inside one frame.
      view.rerender(list([...events, reasoning(2, " Line two.")], { live: true }));
      view.rerender(list([...events, reasoning(2, " Line two."), reasoning(3, " Line three.")], { live: true }));
      act(() => {
        for (const frame of frames.splice(0)) frame(performance.now());
      });

      expect(writes).toBe(1);
      expect(top).toBe(120);
      expect(viewport.dataset.overflowing).toBe("true");
    } finally {
      raf.mockRestore();
      caf.mockRestore();
    }
  });

  it("joins reasoning fragments with a quiet gap instead of a rule, live and opened", () => {
    const joined = "Reading the README.\n\n---\n\nThe summary is ready.";
    const view = render(list([userMessage(0), reasoning(1, joined)], { live: true }));
    const live = screen.getByTestId("thinking-preview-card");
    expect(live.querySelector("hr")).toBeNull();
    expect(live.querySelectorAll("[data-thought-fragment-gap]")).toHaveLength(1);

    view.rerender(list([userMessage(0), reasoning(1, joined), answer(3, "Done.")], { live: true }));
    fireEvent.click(screen.getByRole("button", { name: /^Thought/ }));
    const block = screen.getByTestId("thought-block");
    expect(block.textContent).toContain("Reading the README.");
    expect(block.textContent).toContain("The summary is ready.");
    expect(block.querySelector("hr")).toBeNull();
    expect(block.querySelectorAll("[data-thought-fragment-gap]")).toHaveLength(1);
  });

  it("renders folded Thought rows collapsed, opening to the grey block inside the open fold", () => {
    render(list([
      userMessage(0),
      reasoning(1, "Folded reasoning."),
      answer(3, "Interim note."),
      reasoning(4, "Second thought."),
      answer(5, "Final answer."),
      done(6),
    ], { live: false }));

    expect(screen.queryByText("Thought")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Worked for/ }));

    // The interim text between them is drawn, so the two thoughts stay apart.
    const thoughts = thoughtButtons();
    expect(thoughts).toHaveLength(2);
    expect(screen.queryByTestId("thinking-preview")).toBeNull();
    fireEvent.click(thoughts[0]!);
    expect(screen.getByTestId("thought-block").textContent).toContain("Folded reasoning.");
  });
});

describe("adjacent Thought rows merge into one", () => {
  // Transcript 85fa4037 (Cursor, Grok 4.7): thought, answer, tool, thought, the
  // same answer again. An open fold hides the tool and the repeated answer.
  const repeated = "I'm Grok 4.7.";
  const grokTurn = () => [
    userMessage(0),
    reasoning(1, "The user is asking what model I am.", "r-1"),
    answer(2, repeated),
    command(3),
    reasoning(4, "The note was set.", "r-2"),
    answer(5, repeated),
    done(6),
  ];

  it("draws one Thought row and one grey block in an open fold", () => {
    render(list(grokTurn(), { live: false }));
    fireEvent.click(foldButton());

    const thoughts = thoughtButtons();
    expect(thoughts).toHaveLength(1);
    // Neither member had a measured span, so the merged row shows none.
    expect(thoughts[0]!.textContent).not.toContain("for ");
    fireEvent.click(thoughts[0]!);
    const blocks = screen.getAllByTestId("thought-block");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.textContent).toContain("The user is asking what model I am.");
    expect(blocks[0]!.textContent).toContain("The note was set.");
    expect(blocks[0]!.querySelector("hr")).toBeNull();
  });

  it("keeps the first member's row key and lands a jump to a merged member on it", async () => {
    const events = grokTurn();
    const keys = buildTranscriptEventRowKeys(events);
    const firstKey = keys[1]!;
    const secondKey = keys[4]!;
    const view = render(list(events, { live: false }));
    expect(foldButton().getAttribute("aria-expanded")).toBe("false");

    view.rerender(list(events, { live: false, scrollToRowKeyRequest: { key: secondKey, requestId: 1 } }));
    await waitFor(() => {
      const row = document.querySelector(`[data-chat-row-key="${firstKey}"]`);
      expect(row?.getAttribute("data-chat-anchored-row")).toBe("true");
    });
    expect(foldButton().getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector(`[data-chat-row-key="${secondKey}"]`)).toBeNull();
  });

  it("merges finished thoughts in an unfolded live turn and sums their measured durations", () => {
    const thoughtA = [reasoning(1, "Look first.", "r-1"), reasoning(3, " Then compare.", "r-1")];
    const thoughtB = [reasoning(5, "Decide.", "r-2"), reasoning(8, " Pick one.", "r-2")];
    const view = render(list([userMessage(0), ...thoughtA, lifecycle(4), ...thoughtB], { live: true }));

    // The live thought joins the finished one above it: one row, drawing the
    // live preview, under the run's first key.
    const rowKeyOf = (element: Element) => element.closest("[data-chat-row-key]")?.getAttribute("data-chat-row-key");
    const liveRowKey = rowKeyOf(screen.getByTestId("thinking-preview"));
    expect(thoughtButtons()).toHaveLength(0);

    view.rerender(list([userMessage(0), ...thoughtA, lifecycle(4), ...thoughtB, answer(9, "Here.")], { live: true }));
    expect(screen.queryByTestId("thinking-preview")).toBeNull();
    const thoughts = thoughtButtons();
    expect(thoughts).toHaveLength(1);
    // Settling keeps the same drawn row: nothing remounts.
    expect(rowKeyOf(thoughts[0]!)).toBe(liveRowKey);
    // 2s + 3s: every member has a measured span.
    expect(thoughts[0]!.textContent).toContain("for 5s");
    fireEvent.click(thoughts[0]!);
    expect(screen.getByTestId("thought-block").textContent).toContain("Look first. Then compare.");
    expect(screen.getByTestId("thought-block").textContent).toContain("Decide. Pick one.");
  });
});
