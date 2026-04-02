/* @vitest-environment jsdom */

import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PackedSessionGrid } from "./PackedSessionGrid";

const layoutGetMock = vi.fn();
const layoutSetMock = vi.fn();

type ResizeObserverRecord = {
  callback: ResizeObserverCallback;
  target: Element | null;
};

const resizeObservers: ResizeObserverRecord[] = [];

class MockResizeObserver {
  callback: ResizeObserverCallback;
  target: Element | null = null;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    resizeObservers.push({ callback, target: null });
  }

  observe = (target: Element) => {
    this.target = target;
    resizeObservers[resizeObservers.length - 1]!.target = target;
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
      return 1000;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() {
      return 800;
    },
  });
});

beforeEach(() => {
  vi.useFakeTimers();
  resizeObservers.length = 0;
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

function renderGrid() {
  return render(
    <PackedSessionGrid
      layoutId="work:grid:test"
      tiles={[
        { id: "one", minWidth: 300, minHeight: 220, header: <div>one</div>, children: <div>one body</div> },
        { id: "two", minWidth: 300, minHeight: 220, header: <div>two</div>, children: <div>two body</div> },
        { id: "three", minWidth: 300, minHeight: 220, header: <div>three</div>, children: <div>three body</div> },
      ]}
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

    const first = container.querySelector('[data-grid-tile-id="one"]');
    const second = container.querySelector('[data-grid-tile-id="two"]');
    const third = container.querySelector('[data-grid-tile-id="three"]');

    expect(first?.getAttribute("data-grid-col-start")).toBe("1");
    expect(second?.getAttribute("data-grid-col-start")).toBe("2");
    expect(third?.getAttribute("data-grid-col-start")).toBe("3");
    expect(first?.getAttribute("data-grid-row-start")).toBe("1");
    expect(second?.getAttribute("data-grid-row-start")).toBe("1");
    expect(third?.getAttribute("data-grid-row-start")).toBe("1");
  });

  it("persists resized spans and clamps width growth to the available columns", async () => {
    const { container } = renderGrid();

    await act(async () => {
      await vi.runAllTimersAsync();
    });
    triggerResizeObservers();
    layoutSetMock.mockClear();

    const handle = container.querySelector('[data-grid-tile-id="one"] [data-grid-resize-handle="se"]');
    expect(handle).toBeTruthy();

    fireEvent.pointerDown(handle!, { clientX: 0, clientY: 0 });
    fireEvent.pointerMove(window, { clientX: 4000, clientY: 500 });
    fireEvent.pointerUp(window);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    const lastCall = layoutSetMock.mock.calls.at(-1);
    expect(lastCall?.[0]).toBe("work:grid:test");
    expect(lastCall?.[1]).toMatchObject({
      "one:col": 3,
      "one:row": 3,
    });
  });
});
