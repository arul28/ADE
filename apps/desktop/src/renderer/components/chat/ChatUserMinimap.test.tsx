/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  useAppStore.setState({ chatUserMinimapEnabled: originalMinimapEnabled });
});

describe("ChatUserMinimap", () => {
  it("keeps resting and hovered ticks visible against the chat canvas", () => {
    const view = render(
      <ChatUserMinimap
        entries={ENTRIES}
        activeIndex={null}
        onJumpToRow={vi.fn()}
        listWidthPx={960}
        listHeightPx={600}
        listTopViewportPx={0}
        columnWidthPx={720}
      />,
    );

    const rail = screen.getByRole("button", { name: "Jump to message: User message" });
    vi.spyOn(rail, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 100, 24, 400));

    const ticks = [...view.container.querySelectorAll<HTMLElement>("[data-minimap-tick]")];
    const hoveredTick = ticks.at(1);
    expect(ticks).toHaveLength(2);
    expect(hoveredTick?.className).toContain("bg-[var(--color-fg)]/30");

    fireEvent.mouseMove(rail, { clientY: 500 });

    expect(hoveredTick?.className).toContain("bg-[var(--color-fg)]/75");
    expect(hoveredTick?.className).toContain("w-6");
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
        listTopViewportPx={0}
        columnWidthPx={720}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Load earlier message markers" }));

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
        listTopViewportPx={0}
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
        listTopViewportPx={0}
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
        listTopViewportPx={0}
        columnWidthPx={720}
      />,
    );

    const marker = screen.getByRole("button", { name: "Retry loading earlier message markers" });
    expect((marker as HTMLButtonElement).disabled).toBe(true);
    expect(marker.getAttribute("title")).toBe("History page timed out");
  });
});
