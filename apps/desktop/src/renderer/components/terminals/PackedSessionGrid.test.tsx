/* @vitest-environment jsdom */

import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PackedSessionGrid } from "./PackedSessionGrid";

const layoutGetMock = vi.fn();
const layoutSetMock = vi.fn();
let mockViewportWidth = 1000;
let mockViewportHeight = 800;

type ResizeObserverRecord = {
  callback: ResizeObserverCallback;
  target: Element | null;
  observer: MockResizeObserver | null;
};

const resizeObservers: ResizeObserverRecord[] = [];

class MockResizeObserver {
  callback: ResizeObserverCallback;
  target: Element | null = null;
  private record: ResizeObserverRecord;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    this.record = { callback, target: null, observer: this };
    resizeObservers.push(this.record);
  }

  observe = (target: Element) => {
    this.target = target;
    this.record.target = target;
    this.callback([
      {
        target,
        contentRect: {
          width: (target as HTMLElement).clientWidth,
          height: (target as HTMLElement).clientHeight,
          top: 0,
          left: 0,
          right: (target as HTMLElement).clientWidth,
          bottom: (target as HTMLElement).clientHeight,
          x: 0,
          y: 0,
          toJSON() {
            return {};
          },
        },
      } as ResizeObserverEntry,
    ], this as unknown as ResizeObserver);
  };

  disconnect = vi.fn();
}

function triggerResizeObservers() {
  for (const observer of resizeObservers) {
    if (!observer.target) continue;
    observer.callback([
      {
        target: observer.target,
        contentRect: {
          width: (observer.target as HTMLElement).clientWidth,
          height: (observer.target as HTMLElement).clientHeight,
          top: 0,
          left: 0,
          right: (observer.target as HTMLElement).clientWidth,
          bottom: (observer.target as HTMLElement).clientHeight,
          x: 0,
          y: 0,
          toJSON() {
            return {};
          },
        },
      } as ResizeObserverEntry,
    ], {} as ResizeObserver);
  }
}

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", MockResizeObserver);
  vi.stubGlobal("PointerEvent", MouseEvent as typeof PointerEvent);
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get() {
      return mockViewportWidth;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() {
      return mockViewportHeight;
    },
  });
});

beforeEach(() => {
  vi.useFakeTimers();
  resizeObservers.length = 0;
  mockViewportWidth = 1000;
  mockViewportHeight = 800;
  layoutGetMock.mockResolvedValue(null);
  layoutSetMock.mockResolvedValue(undefined);
  (window as any).ade = {
    layout: {
      get: layoutGetMock,
      set: layoutSetMock,
    },
  };
});

afterEach(() => {
  vi.clearAllMocks();
  delete (window as any).ade;
  vi.useRealTimers();
});

function buildTiles(count: number, minWidth = 300, minHeight = 220) {
  return Array.from({ length: count }, (_, index) => {
    const label = String(index + 1);
    return {
      id: `tile-${label}`,
      minWidth,
      minHeight,
      header: <div>{label}</div>,
      children: <div>{label} body</div>,
    };
  });
}

function renderGrid(tileCount = 3, minWidth = 300, minHeight = 220) {
  return render(
    <PackedSessionGrid
      layoutId="work:grid:test"
      tiles={buildTiles(tileCount, minWidth, minHeight)}
    />,
  );
}

describe("PackedSessionGrid", () => {
  it("lays out three tiles evenly across the first row on a wide surface", async () => {
    const { container } = renderGrid();

    await act(async () => {
      await vi.runAllTimersAsync();
    });
    triggerResizeObservers();

    const first = container.querySelector('[data-grid-tile-id="tile-1"]');
    const second = container.querySelector('[data-grid-tile-id="tile-2"]');
    const third = container.querySelector('[data-grid-tile-id="tile-3"]');

    expect(first?.getAttribute("data-grid-slot-start")).toBe("1");
    expect(second?.getAttribute("data-grid-slot-start")).toBe("2");
    expect(third?.getAttribute("data-grid-slot-start")).toBe("3");
    expect(first?.getAttribute("data-grid-row-start")).toBe("1");
    expect(second?.getAttribute("data-grid-row-start")).toBe("1");
    expect(third?.getAttribute("data-grid-row-start")).toBe("1");
  });

  it("uses a balanced 3x2 layout for six wide chat tiles instead of leaving a sparse last row", async () => {
    mockViewportWidth = 2200;
    mockViewportHeight = 1200;
    const { container } = renderGrid(6, 440, 340);

    await act(async () => {
      await vi.runAllTimersAsync();
    });
    triggerResizeObservers();

    expect(container.querySelector('[data-grid-tile-id="tile-1"]')?.getAttribute("data-grid-slot-start")).toBe("1");
    expect(container.querySelector('[data-grid-tile-id="tile-2"]')?.getAttribute("data-grid-slot-start")).toBe("2");
    expect(container.querySelector('[data-grid-tile-id="tile-3"]')?.getAttribute("data-grid-slot-start")).toBe("3");
    expect(container.querySelector('[data-grid-tile-id="tile-4"]')?.getAttribute("data-grid-slot-start")).toBe("1");
    expect(container.querySelector('[data-grid-tile-id="tile-5"]')?.getAttribute("data-grid-slot-start")).toBe("2");
    expect(container.querySelector('[data-grid-tile-id="tile-6"]')?.getAttribute("data-grid-slot-start")).toBe("3");
    expect(container.querySelector('[data-grid-tile-id="tile-4"]')?.getAttribute("data-grid-row-start")).toBe("4");
  });

  it("uses three columns for five wide chat tiles instead of collapsing into a single stack", async () => {
    mockViewportWidth = 2200;
    mockViewportHeight = 1200;
    const { container } = renderGrid(5, 440, 340);

    await act(async () => {
      await vi.runAllTimersAsync();
    });
    triggerResizeObservers();

    expect(container.querySelector('[data-grid-tile-id="tile-1"]')?.getAttribute("data-grid-slot-start")).toBe("1");
    expect(container.querySelector('[data-grid-tile-id="tile-2"]')?.getAttribute("data-grid-slot-start")).toBe("2");
    expect(container.querySelector('[data-grid-tile-id="tile-3"]')?.getAttribute("data-grid-slot-start")).toBe("3");
    expect(container.querySelector('[data-grid-tile-id="tile-4"]')?.getAttribute("data-grid-slot-start")).toBe("1");
    expect(container.querySelector('[data-grid-tile-id="tile-5"]')?.getAttribute("data-grid-slot-start")).toBe("2");
    expect(container.querySelector('[data-grid-tile-id="tile-4"]')?.getAttribute("data-grid-row-start")).toBe("4");
    expect(container.querySelector('[data-grid-tile-id="tile-5"]')?.getAttribute("data-grid-row-start")).toBe("4");
  });

  it("persists resized spans and clamps width growth to the available columns", async () => {
    const { container } = renderGrid();

    await act(async () => {
      await vi.runAllTimersAsync();
    });
    triggerResizeObservers();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    layoutSetMock.mockClear();

    const handle = container.querySelector('[data-grid-tile-id="tile-1"] [data-grid-resize-handle="e"]');
    expect(handle).toBeTruthy();

    fireEvent.pointerDown(handle!, { clientX: 0, clientY: 0 });
    fireEvent.pointerMove(window, { clientX: 4000, clientY: 500 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    expect(layoutSetMock).not.toHaveBeenCalled();

    fireEvent.pointerUp(window);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    expect(layoutSetMock).toHaveBeenCalledTimes(1);
    const lastCall = layoutSetMock.mock.calls.at(-1);
    expect(lastCall?.[0]).toBe("work:grid:test");
    expect(lastCall?.[1]).toMatchObject({
      "tile-1:colStart": 1,
      "tile-1:colSpan": 13,
      "tile-1:col": 13,
      "tile-2:colStart": 14,
      "tile-2:colSpan": 11,
    });
  });

  it("keeps the dragged edge anchored when resizing from the west", async () => {
    const { container } = renderGrid(2, 300, 220);

    await act(async () => {
      await vi.runAllTimersAsync();
    });
    triggerResizeObservers();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    layoutSetMock.mockClear();

    const tile = container.querySelector('[data-grid-tile-id="tile-2"]');
    const handle = container.querySelector('[data-grid-tile-id="tile-2"] [data-grid-resize-handle="w"]');
    expect(tile).toBeTruthy();
    expect(handle).toBeTruthy();
    expect(tile?.getAttribute("data-grid-col-start")).toBe("13");
    expect(tile?.getAttribute("data-grid-col-end")).toBe("24");

    fireEvent.pointerDown(handle!, { clientX: 0, clientY: 0 });
    fireEvent.pointerMove(window, { clientX: -42, clientY: 0 });
    fireEvent.pointerUp(window);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    expect(layoutSetMock).toHaveBeenCalledTimes(1);
    const lastCall = layoutSetMock.mock.calls.at(-1);
    expect(lastCall?.[1]).toMatchObject({
      "tile-1:colSpan": 11,
      "tile-1:col": 11,
      "tile-2:colStart": 12,
      "tile-2:colSpan": 13,
      "tile-2:col": 13,
    });
    expect(container.querySelector('[data-grid-tile-id="tile-2"]')?.getAttribute("data-grid-col-start")).toBe("12");
    expect(container.querySelector('[data-grid-tile-id="tile-2"]')?.getAttribute("data-grid-col-end")).toBe("24");
  });
});
