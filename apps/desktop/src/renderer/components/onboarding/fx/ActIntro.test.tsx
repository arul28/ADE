/* @vitest-environment jsdom */

import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ActIntro } from "./ActIntro";

// Force reduced-motion to false so auto-advance timers run.
beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("ActIntro", () => {
  it("renders title and subtitle", () => {
    render(
      <ActIntro
        title="Act One"
        subtitle="The beginning"
        variant="orbit"
        durationMs={3000}
      />,
    );
    expect(screen.getByText(/Act/)).toBeTruthy();
    expect(screen.getByText("The beginning")).toBeTruthy();
    expect(screen.getByText(/Press Esc/)).toBeTruthy();
  });

  it("calls onComplete after durationMs elapses", () => {
    const onComplete = vi.fn();
    render(
      <ActIntro
        title="Act One"
        variant="orbit"
        durationMs={1500}
        onComplete={onComplete}
      />,
    );
    expect(onComplete).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1499);
    });
    expect(onComplete).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("calls onSkip when Escape is pressed", () => {
    const onSkip = vi.fn();
    render(
      <ActIntro
        title="Act One"
        variant="drift"
        durationMs={10000}
        onSkip={onSkip}
      />,
    );
    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(onSkip).toHaveBeenCalledTimes(1);
  });
});
