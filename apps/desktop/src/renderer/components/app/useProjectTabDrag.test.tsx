/* @vitest-environment jsdom */

import { act, cleanup, renderHook } from "@testing-library/react";
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { __resetHostedWebZoomForTests, applyHostedWebZoom } from "../../lib/webZoom";
import { PROJECT_TAB_KEY_ATTR, useProjectTabDrag } from "./useProjectTabDrag";

function rectOf(left: number, top: number, width: number, height: number) {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) };
}

/**
 * Three 100 layout-px tabs with a 4 layout-px gap, drawn at `zoom`: every rect
 * is `zoom` times its layout size, as under the hosted web zoom.
 */
function zoomedStrip(zoom: number) {
  const strip = document.createElement("div");
  document.body.appendChild(strip);
  strip.getBoundingClientRect = () => rectOf(0, 10, 3 * 104 * zoom, 30);
  const tabs = ["a", "b", "c"].map((key, index) => {
    const tab = document.createElement("div");
    tab.setAttribute(PROJECT_TAB_KEY_ATTR, key);
    strip.appendChild(tab);
    tab.getBoundingClientRect = () => rectOf(index * 104 * zoom, 10, 100 * zoom, 30);
    return tab;
  });
  return { strip, tabs };
}

function pointerEvent(type: string, init: { pointerId: number; clientX: number; clientY: number }) {
  return Object.assign(new Event(type), {
    pointerId: init.pointerId,
    clientX: init.clientX,
    clientY: init.clientY,
    screenX: init.clientX,
    screenY: init.clientY,
  });
}

/**
 * Drags tab `a` right past the midpoint of `b` and reads the translate the
 * neighbour `b` is given, which is the shift the gap of the strip must match.
 */
function neighbourShiftAfterDrag(zoom: number) {
  applyHostedWebZoom(zoom);
  const { strip, tabs } = zoomedStrip(zoom);
  const stripRef = { current: strip } as RefObject<HTMLElement | null>;
  const { result } = renderHook(() =>
    useProjectTabDrag({
      stripRef,
      canTearOff: false,
      onReorder: vi.fn(),
      onTearOff: vi.fn(),
      onTearOffMove: vi.fn(),
      onTearOffEnd: vi.fn(),
    }),
  );
  const down = {
    button: 0,
    pointerId: 1,
    clientX: 20 * zoom,
    clientY: 25,
    currentTarget: tabs[0],
    target: tabs[0],
  } as unknown as ReactPointerEvent<HTMLElement>;
  act(() => {
    result.current.onTabPointerDown(down, "a");
  });
  // Screen-space move: far enough to pass the midpoint of `b` (its screen centre sits at 169.4 at zoom 1.1).
  act(() => {
    window.dispatchEvent(pointerEvent("pointermove", { pointerId: 1, clientX: 20 * zoom + 130 * zoom, clientY: 25 }));
  });
  return result.current.tabDragStyle("b")?.transform;
}

describe("project tab drag neighbour shift", () => {
  afterEach(() => {
    cleanup();
    __resetHostedWebZoomForTests();
    document.body.innerHTML = "";
  });

  it("shifts the neighbour by the tab and gap in layout px under the hosted zoom", () => {
    // 100 layout px tab + 4 layout px gap = 104. The unconverted screen width gave
    // 114 here, which renders as 125.4 screen px at 1.1x instead of 114.4.
    expect(neighbourShiftAfterDrag(1.1)).toBe("translateX(-104px)");
  });

  it("is unchanged at zoom 1, as in Electron", () => {
    expect(neighbourShiftAfterDrag(1)).toBe("translateX(-104px)");
  });
});
