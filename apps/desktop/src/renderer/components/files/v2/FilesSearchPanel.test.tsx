// @vitest-environment jsdom

import React, { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FilesQuickOpenItem, FilesSearchTextMatch } from "../../../../shared/types";
import {
  FilesSearchPanel,
  getFilesSearchIncludeIgnored,
  resetFilesSearchPreferencesForTests,
  type FilesSearchPanelProps,
} from "./FilesSearchPanel";

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

type SearchArgs = { workspaceId: string; query: string; limit?: number; includeIgnored?: boolean };

const quickOpen = vi.fn<[SearchArgs, unknown?], Promise<FilesQuickOpenItem[]>>();
const searchText = vi.fn<[SearchArgs, unknown?], Promise<FilesSearchTextMatch[]>>();

beforeEach(() => {
  vi.useFakeTimers();
  resetFilesSearchPreferencesForTests();
  localStorage.clear();
  quickOpen.mockReset();
  searchText.mockReset();
  quickOpen.mockResolvedValue([]);
  searchText.mockResolvedValue([]);
  (window as unknown as { ade: unknown }).ade = { files: { quickOpen, searchText } };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** Flush debounce timers and any promise continuations they scheduled. */
async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
  });
}

function renderPanel(overrides: Partial<FilesSearchPanelProps> = {}) {
  const props: FilesSearchPanelProps = {
    workspaceId: "ws-1",
    query: "button",
    onQueryChange: vi.fn(),
    onOpen: vi.fn(),
    onDismiss: vi.fn(),
    variant: "sidebar",
    ...overrides,
  };
  const view = render(<FilesSearchPanel {...props} />);
  return { props, view };
}

describe("FilesSearchPanel result freshness", () => {
  it("renders file-name results before content results arrive", async () => {
    quickOpen.mockResolvedValue([{ path: "src/Button.tsx", score: 1 }]);
    const contents = deferred<FilesSearchTextMatch[]>();
    searchText.mockReturnValue(contents.promise);

    renderPanel();

    await advance(130);

    expect(screen.getByText("Button.tsx")).toBeTruthy();
    expect(searchText).not.toHaveBeenCalled();
    // The content request has not even been issued yet: names are on screen
    // while the longer content debounce is still pending.
    expect(screen.getByText("Searching inside files…")).toBeTruthy();
  });

  it("keeps name results on screen while a slow content search finishes", async () => {
    quickOpen.mockResolvedValue([{ path: "src/Button.tsx", score: 1 }]);
    const contents = deferred<FilesSearchTextMatch[]>();
    searchText.mockReturnValue(contents.promise);

    renderPanel();
    await advance(300);
    expect(screen.getByText("Button.tsx")).toBeTruthy();

    await act(async () => {
      contents.resolve([{ path: "src/other.ts", line: 12, column: 3, preview: "const button = 1;" }]);
      await Promise.resolve();
    });

    expect(screen.getByText("Button.tsx")).toBeTruthy();
    expect(screen.getByText("const button = 1;")).toBeTruthy();
  });

  it("tells apart still-searching from no matches", async () => {
    const names = deferred<FilesQuickOpenItem[]>();
    quickOpen.mockReturnValue(names.promise);
    searchText.mockReturnValue(deferred<FilesSearchTextMatch[]>().promise);

    renderPanel();
    await advance(300);
    expect(screen.getByText("Searching…")).toBeTruthy();

    await act(async () => {
      names.resolve([]);
      await Promise.resolve();
    });
    // Contents are still outstanding, so this is not yet an honest "no matches".
    expect(screen.getByText("Searching…")).toBeTruthy();
  });

  it("reports no matches once both requests have answered", async () => {
    renderPanel();
    await advance(300);
    expect(screen.getByText("No matches")).toBeTruthy();
  });

  it("issues no requests for an empty query", async () => {
    renderPanel({ query: "   " });
    await advance(400);
    expect(quickOpen).not.toHaveBeenCalled();
    expect(searchText).not.toHaveBeenCalled();
  });
});

describe("FilesSearchPanel ignored-files toggle", () => {
  it("defaults to off and flips the argument sent to both searches", async () => {
    renderPanel();
    await advance(300);

    expect(quickOpen.mock.calls[0]?.[0]?.includeIgnored).toBe(false);
    expect(searchText.mock.calls[0]?.[0]?.includeIgnored).toBe(false);

    const toggle = screen.getByLabelText("Include ignored files");
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    await act(async () => { fireEvent.click(toggle); });
    await advance(300);

    expect(screen.getByLabelText("Include ignored files").getAttribute("aria-checked")).toBe("true");
    expect(quickOpen.mock.calls.at(-1)?.[0]?.includeIgnored).toBe(true);
    expect(searchText.mock.calls.at(-1)?.[0]?.includeIgnored).toBe(true);
  });

  it("persists the toggle as one preference, not one entry per lane", async () => {
    renderPanel();
    await act(async () => { fireEvent.click(screen.getByLabelText("Include ignored files")); });

    // How the user searches, not a property of a lane — and a per-workspace key
    // left a localStorage entry behind for every lane ever searched.
    expect(getFilesSearchIncludeIgnored()).toBe(true);
    expect(localStorage.getItem("ade.files.search.includeIgnored")).toBe("1");
    // No per-lane key: those accumulated one entry per lane ever searched.
    expect(localStorage.getItem("ade.files.search.includeIgnored:ws-1")).toBeNull();

    cleanup();
    resetFilesSearchPreferencesForTests();
    renderPanel();
    expect(screen.getByLabelText("Include ignored files").getAttribute("aria-checked")).toBe("true");
  });
});

describe("FilesSearchPanel forwarding", () => {
  it("forwards the pin to both searches", async () => {
    const pin = { kind: "local", key: "k1", rootPath: "/repo", displayName: "repo" } as const;
    renderPanel({ pin });
    await advance(300);

    expect(quickOpen.mock.calls[0]?.[1]).toBe(pin);
    expect(searchText.mock.calls[0]?.[1]).toBe(pin);
  });
});

describe("FilesSearchPanel dismissal", () => {
  it("clears the query and dismisses on Escape", async () => {
    const { props } = renderPanel();
    await advance(300);

    fireEvent.keyDown(screen.getByTestId("files-search-panel"), { key: "Escape" });

    expect(props.onQueryChange).toHaveBeenCalledWith("");
    expect(props.onDismiss).toHaveBeenCalled();
  });

  it("clears the query and dismisses from the close button", async () => {
    const { props } = renderPanel();
    await advance(300);

    fireEvent.click(screen.getByLabelText("Close search"));

    expect(props.onQueryChange).toHaveBeenCalledWith("");
    expect(props.onDismiss).toHaveBeenCalled();
  });
});

describe("FilesSearchPanel keyboard navigation", () => {
  it("walks from the file list into the content hits and opens with a line", async () => {
    quickOpen.mockResolvedValue([
      { path: "src/Button.tsx", score: 2 },
      { path: "src/ButtonGroup.tsx", score: 1 },
    ]);
    searchText.mockResolvedValue([
      { path: "src/theme.ts", line: 12, column: 3, preview: "button base" },
      { path: "src/theme.ts", line: 40, column: 1, preview: "button hover" },
    ]);

    const { props } = renderPanel();
    await advance(300);

    const panel = screen.getByTestId("files-search-panel");
    // 0 -> 1 -> 2 crosses out of the file list and into the first content hit.
    fireEvent.keyDown(panel, { key: "ArrowDown" });
    fireEvent.keyDown(panel, { key: "ArrowDown" });
    fireEvent.keyDown(panel, { key: "Enter" });

    expect(props.onOpen).toHaveBeenCalledWith("src/theme.ts", 12);
    // The sidebar keeps its results so several hits can be opened in a row.
    expect(props.onDismiss).not.toHaveBeenCalled();
  });

  it("opens a file-name hit without a line and clamps at the top", async () => {
    quickOpen.mockResolvedValue([{ path: "src/Button.tsx", score: 1 }]);

    const { props } = renderPanel();
    await advance(300);

    const panel = screen.getByTestId("files-search-panel");
    fireEvent.keyDown(panel, { key: "ArrowUp" });
    fireEvent.keyDown(panel, { key: "Enter" });

    expect(props.onOpen).toHaveBeenCalledWith("src/Button.tsx");
  });

  it("responds to keys typed in the explorer header search field", async () => {
    quickOpen.mockResolvedValue([
      { path: "src/Button.tsx", score: 2 },
      { path: "src/ButtonGroup.tsx", score: 1 },
    ]);

    const onOpen = vi.fn();
    const onDismiss = vi.fn();
    function Harness() {
      const [query, setQuery] = useState("button");
      return (
        <div>
          <input aria-label="Search files" data-files-search-field="1" value={query} onChange={(e) => setQuery(e.target.value)} />
          <FilesSearchPanel
            workspaceId="ws-1"
            query={query}
            onQueryChange={setQuery}
            onOpen={onOpen}
            onDismiss={onDismiss}
            variant="sidebar"
          />
        </div>
      );
    }

    render(<Harness />);
    await advance(300);

    const field = screen.getByLabelText("Search files");
    fireEvent.keyDown(field, { key: "ArrowDown" });
    fireEvent.keyDown(field, { key: "Enter" });

    expect(onOpen).toHaveBeenCalledWith("src/ButtonGroup.tsx");
  });
});

describe("FilesSearchPanel overlay variant", () => {
  it("renders its own field and dismisses after opening a result", async () => {
    quickOpen.mockResolvedValue([{ path: "src/Button.tsx", score: 1 }]);
    const { props } = renderPanel({ variant: "overlay" });
    await advance(300);

    expect(screen.getByLabelText("Search files")).toBeTruthy();
    expect(screen.getByLabelText("Include ignored files")).toBeTruthy();

    fireEvent.click(screen.getByText("Button.tsx"));

    expect(props.onOpen).toHaveBeenCalledWith("src/Button.tsx");
    expect(props.onDismiss).toHaveBeenCalled();
  });
});
