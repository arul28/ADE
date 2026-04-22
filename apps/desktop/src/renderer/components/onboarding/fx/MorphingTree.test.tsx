/* @vitest-environment jsdom */

import React, { createRef } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MorphingTree, type MorphingTreeHandle } from "./MorphingTree";

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: true, // reduced motion ON so prune is instant
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

describe("MorphingTree", () => {
  it("renders the primary label", () => {
    const { container } = render(<MorphingTree primaryLabel="primary" />);
    expect(container.textContent).toContain("primary");
  });

  it("grows and prunes branches via imperative handle", () => {
    const ref = createRef<MorphingTreeHandle>();
    const { container } = render(<MorphingTree ref={ref} primaryLabel="primary" />);
    expect(ref.current).not.toBeNull();

    act(() => {
      ref.current!.growBranch("test-lane");
    });
    expect(container.textContent).toContain("test-lane");

    act(() => {
      ref.current!.pruneBranch("test-lane");
      // Reduced motion path removes immediately, but guard with timer flush too.
      vi.advanceTimersByTime(700);
    });
    expect(container.textContent).not.toContain("test-lane");
  });
});
