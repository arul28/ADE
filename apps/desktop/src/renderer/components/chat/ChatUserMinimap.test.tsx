/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useAppStore } from "../../state/appStore";
import { ChatUserMinimap } from "./ChatUserMinimap";
import type { ChatUserMinimapSourceEntry } from "./chatUserMinimap.logic";

const ENTRIES: readonly ChatUserMinimapSourceEntry[] = [
  {
    rowIndex: 0,
    key: "first",
    preview: "First checkpoint",
    fullUserOrdinal: 0,
    assistantPreview: "Acknowledged.",
    turnOutcome: null,
  },
  {
    rowIndex: 2,
    key: "second",
    preview: "Second checkpoint",
    fullUserOrdinal: 1,
    assistantPreview: "Shipped it.",
    turnOutcome: null,
  },
];

const originalMinimapEnabled = useAppStore.getState().chatUserMinimapEnabled;

beforeEach(() => {
  useAppStore.setState({ chatUserMinimapEnabled: true });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  useAppStore.setState({ chatUserMinimapEnabled: originalMinimapEnabled });
});

describe("ChatUserMinimap", () => {
  it("keeps every tick at the same weight while preserving hover color", () => {
    const view = render(
      <ChatUserMinimap
        entries={ENTRIES}
        activeIndex={null}
        onJumpToRow={vi.fn()}
        listWidthPx={960}
        listHeightPx={600}
        columnWidthPx={720}
      />,
    );

    const rail = screen.getByRole("button", { name: "Jump to message: User message" });
    vi.spyOn(rail, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 100, 24, 400));

    const ticks = [...view.container.querySelectorAll<HTMLElement>("[data-minimap-tick]")];
    const hoveredTick = ticks.at(1);
    expect(ticks).toHaveLength(2);
    expect(hoveredTick?.className).toContain("bg-[var(--color-fg)]/30");
    expect(ticks.every((tick) => tick.className.includes("left-0"))).toBe(true);
    expect(ticks.every((tick) => tick.className.includes("h-0.5"))).toBe(true);
    expect(ticks.every((tick) => tick.className.includes("w-2"))).toBe(true);

    fireEvent.mouseMove(rail, { clientY: 500 });

    expect(hoveredTick?.className).toContain("bg-[var(--color-fg)]/75");
    expect(hoveredTick?.className).toContain("w-2");
  });

  it("uses the normal geometry for failed, interrupted, and queued ticks", () => {
    const entries: readonly ChatUserMinimapSourceEntry[] = [
      { ...ENTRIES[0]!, turnOutcome: "failed" },
      { ...ENTRIES[1]!, turnOutcome: "interrupted" },
      { ...ENTRIES[1]!, key: "queued", fullUserOrdinal: 1, kind: "queued", turnOutcome: null },
    ];
    const view = render(
      <ChatUserMinimap
        entries={entries}
        activeIndex={null}
        onJumpToRow={vi.fn()}
        listWidthPx={960}
        listHeightPx={600}
        columnWidthPx={720}
      />,
    );

    const ticks = [...view.container.querySelectorAll<HTMLElement>("[data-minimap-tick]")];
    expect(ticks).toHaveLength(3);
    expect(ticks.every((tick) => (
      tick.className.includes("left-0")
      && tick.className.includes("h-0.5")
      && tick.className.includes("w-2")
      && !tick.className.includes("rotate-45")
    ))).toBe(true);
    expect(ticks[0]?.className).toContain("bg-red-400/80");
    expect(ticks[1]?.className).toContain("bg-amber-400/70");
    expect(ticks[2]?.className).toContain("bg-cyan-300/70");
  });

  it("does not draw a guide line between the history ticks", () => {
    render(
      <ChatUserMinimap
        entries={ENTRIES}
        activeIndex={null}
        onJumpToRow={vi.fn()}
        listWidthPx={960}
        listHeightPx={600}
        columnWidthPx={720}
      />,
    );

    const rail = screen.getByRole("button", { name: "Jump to message: User message" });
    expect(rail.children).toHaveLength(2);
    expect([...rail.children].every((child) => child.hasAttribute("data-minimap-tick"))).toBe(true);
  });

  it("briefly previews and highlights a keyboard-selected tick", () => {
    vi.useFakeTimers();
    render(
      <ChatUserMinimap
        entries={ENTRIES}
        activeIndex={0}
        onJumpToRow={vi.fn()}
        listWidthPx={960}
        listHeightPx={600}
        columnWidthPx={720}
        keyboardFocusIndex={1}
        keyboardFocusRequestId={7}
      />,
    );

    expect(screen.getByTestId("chat-user-minimap").querySelector("[data-minimap-preview]")?.textContent)
      .toContain("Second checkpoint");
    expect(screen.getAllByTestId("chat-user-minimap")[0]?.querySelectorAll("[data-minimap-tick]")[1]?.className)
      .toContain("bg-[var(--chat-accent)]");

    act(() => vi.advanceTimersByTime(901));

    expect(document.querySelector("[data-minimap-preview]")).toBeNull();
  });

  it("clears the keyboard preview when history navigation is reset", () => {
    const view = render(
      <ChatUserMinimap
        entries={ENTRIES}
        activeIndex={0}
        onJumpToRow={vi.fn()}
        listWidthPx={960}
        listHeightPx={600}
        columnWidthPx={720}
        keyboardFocusIndex={1}
        keyboardFocusRequestId={7}
      />,
    );

    expect(screen.getByTestId("chat-user-minimap").querySelector("[data-minimap-preview]"))
      .not.toBeNull();

    view.rerender(
      <ChatUserMinimap
        entries={ENTRIES}
        activeIndex={0}
        onJumpToRow={vi.fn()}
        listWidthPx={960}
        listHeightPx={600}
        columnWidthPx={720}
        keyboardFocusIndex={null}
        keyboardFocusRequestId={null}
      />,
    );

    expect(document.querySelector("[data-minimap-preview]")).toBeNull();
  });

  it("keeps the paging marker visible and stateful before the loaded cutoff", () => {
    const onLoadOlderHistory = vi.fn();
    const view = render(
      <ChatUserMinimap
        entries={[]}
        activeIndex={null}
        onJumpToRow={vi.fn()}
        hasOlderHistory
        onLoadOlderHistory={onLoadOlderHistory}
        listWidthPx={960}
        listHeightPx={600}
        columnWidthPx={720}
      />,
    );

    const continuationMarker = screen.getByRole("button", { name: "Load earlier message markers" });
    expect(continuationMarker.textContent).toBe("↑");
    expect(continuationMarker.querySelectorAll("span")).toHaveLength(1);

    fireEvent.click(continuationMarker);

    expect(onLoadOlderHistory).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("chat-user-minimap")).toBeTruthy();
    expect(document.querySelectorAll("[data-minimap-tick]")).toHaveLength(0);

    view.rerender(
      <ChatUserMinimap
        entries={ENTRIES.slice(0, 1)}
        activeIndex={0}
        onJumpToRow={vi.fn()}
        hasOlderHistory
        loadingOlderHistory
        onLoadOlderHistory={vi.fn()}
        listWidthPx={960}
        listHeightPx={600}
        columnWidthPx={720}
      />,
    );

    const marker = screen.getByRole("button", { name: "Loading earlier message markers" });
    expect(marker.hasAttribute("disabled")).toBe(true);
    expect(marker.getAttribute("title")).toBe("Earlier messages are available");
    expect(screen.getByTestId("chat-user-minimap")).toBeTruthy();
  });

  it("forwards interactive retry intent while keeping the paging error visible during loading", () => {
    const onLoadOlderHistory = vi.fn();
    const onRetryOlderHistory = vi.fn();
    const view = render(
      <ChatUserMinimap
        entries={ENTRIES}
        activeIndex={0}
        onJumpToRow={vi.fn()}
        hasOlderHistory
        olderHistoryError="History page timed out"
        onLoadOlderHistory={onLoadOlderHistory}
        onRetryOlderHistory={onRetryOlderHistory}
        listWidthPx={960}
        listHeightPx={600}
        columnWidthPx={720}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Retry loading earlier message markers" }));

    expect(onRetryOlderHistory).toHaveBeenCalledTimes(1);
    expect(onLoadOlderHistory).not.toHaveBeenCalled();

    view.rerender(
      <ChatUserMinimap
        entries={ENTRIES}
        activeIndex={0}
        onJumpToRow={vi.fn()}
        hasOlderHistory
        loadingOlderHistory
        olderHistoryError="History page timed out"
        onLoadOlderHistory={onLoadOlderHistory}
        onRetryOlderHistory={onRetryOlderHistory}
        listWidthPx={960}
        listHeightPx={600}
        columnWidthPx={720}
      />,
    );

    const marker = screen.getByRole("button", { name: "Retry loading earlier message markers" });
    expect((marker as HTMLButtonElement).disabled).toBe(true);
    expect(marker.getAttribute("title")).toBe("History page timed out");
  });
});
