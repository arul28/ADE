/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useAppStore } from "../../state/appStore";
import { ChatUserMinimap } from "./ChatUserMinimap";
import type { ChatUserMinimapSourceEntry } from "./chatUserMinimap.logic";

const ENTRIES: readonly ChatUserMinimapSourceEntry[] = [
  {
    rowIndex: 0,
    key: "first",
    rowKey: "first",
    preview: "First checkpoint",
    fullUserOrdinal: 0,
    assistantPreview: "Acknowledged.",
    turnOutcome: null,
  },
  {
    rowIndex: 2,
    key: "second",
    rowKey: "second",
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
});
