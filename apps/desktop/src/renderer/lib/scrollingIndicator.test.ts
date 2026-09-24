/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installScrollingIndicator, SCROLLING_ATTRIBUTE } from "./scrollingIndicator";

describe("installScrollingIndicator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    installScrollingIndicator();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("marks a scrolling element and clears the mark after scrolling stops", () => {
    const list = document.createElement("div");
    document.body.appendChild(list);

    list.dispatchEvent(new Event("scroll"));
    expect(list.hasAttribute(SCROLLING_ATTRIBUTE)).toBe(true);

    // Each scroll event pushes the clear back.
    vi.advanceTimersByTime(600);
    list.dispatchEvent(new Event("scroll"));
    vi.advanceTimersByTime(600);
    expect(list.hasAttribute(SCROLLING_ATTRIBUTE)).toBe(true);

    vi.advanceTimersByTime(300);
    expect(list.hasAttribute(SCROLLING_ATTRIBUTE)).toBe(false);
  });
});
