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
});
