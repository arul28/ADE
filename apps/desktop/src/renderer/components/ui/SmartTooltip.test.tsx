/* @vitest-environment jsdom */

import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SmartTooltip } from "./SmartTooltip";
import { useAppStore } from "../../state/appStore";

// vi.useFakeTimers is set per-test so the HOVER_DELAY can be bypassed deterministically.

function renderTooltip(content: React.ComponentProps<typeof SmartTooltip>["content"]) {
  return render(
    <SmartTooltip content={content} forceEnabled>
      <button>target</button>
    </SmartTooltip>,
  );
}

describe("SmartTooltip", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("does not render the docs link when docUrl is absent", () => {
    vi.useFakeTimers();
    renderTooltip({ label: "Push", description: "Upload commits" });

    fireEvent.mouseEnter(screen.getByText("target").parentElement as HTMLElement);
    act(() => {
      vi.runAllTimers();
    });

    expect(screen.getByRole("tooltip")).toBeTruthy();
    expect(screen.queryByText(/Learn more/)).toBeNull();
  });

  it("renders a Learn more link when docUrl is provided and routes clicks through the IPC bridge", () => {
    vi.useFakeTimers();
    const openExternal = vi.fn(async () => undefined);
    (globalThis as any).window = (globalThis as any).window ?? {};
    (globalThis.window as any).ade = { app: { openExternal } };

    renderTooltip({
      label: "Push",
      description: "Upload commits",
      docUrl: "https://example.test/docs/lanes/overview",
    });

    fireEvent.mouseEnter(screen.getByText("target").parentElement as HTMLElement);
    act(() => {
      vi.runAllTimers();
    });

    const link = screen.getByRole("link", { name: /Learn more/ }) as HTMLAnchorElement;
    expect(link.href).toContain("/docs/lanes/overview");

    fireEvent.click(link);
    expect(openExternal).toHaveBeenCalledWith("https://example.test/docs/lanes/overview");
  });

  it("keeps a docs tooltip open when keyboard focus moves into the portal link", () => {
    vi.useFakeTimers();
    renderTooltip({
      label: "Push",
      description: "Upload commits",
      docUrl: "https://example.test/docs/lanes/overview",
    });

    const triggerWrapper = screen.getByText("target").parentElement as HTMLElement;
    fireEvent.focus(triggerWrapper);
    act(() => {
      vi.runOnlyPendingTimers();
    });

    const link = screen.getByRole("link", { name: /Learn more/ });
    fireEvent.blur(triggerWrapper, { relatedTarget: link });
    fireEvent.focus(link, { relatedTarget: triggerWrapper });
    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(screen.getByRole("link", { name: /Learn more/ })).toBeTruthy();
  });

  it("enables pointer-events only when docUrl is provided", () => {
    vi.useFakeTimers();
    const { rerender } = render(
      <SmartTooltip content={{ label: "A", description: "B" }} forceEnabled>
        <button>t1</button>
      </SmartTooltip>,
    );
    fireEvent.mouseEnter(screen.getByText("t1").parentElement as HTMLElement);
    act(() => {
      vi.runAllTimers();
    });
    const tt1 = screen.getByRole("tooltip") as HTMLElement;
    expect(tt1.style.pointerEvents).toBe("none");

    rerender(
      <SmartTooltip
        content={{ label: "A", description: "B", docUrl: "https://example.test/x" }}
        forceEnabled
      >
        <button>t1</button>
      </SmartTooltip>,
    );
    // Re-open to pick up the new content.
    fireEvent.mouseLeave(screen.getByText("t1").parentElement as HTMLElement);
    act(() => {
      vi.runAllTimers();
    });
    fireEvent.mouseEnter(screen.getByText("t1").parentElement as HTMLElement);
    act(() => {
      vi.runAllTimers();
    });
    const tt2 = screen.getByRole("tooltip") as HTMLElement;
    expect(tt2.style.pointerEvents).toBe("auto");
  });

  it("respects the global smartTooltipsEnabled setting when forceEnabled is not passed", () => {
    vi.useFakeTimers();
    useAppStore.setState({ smartTooltipsEnabled: false });
    render(
      <SmartTooltip content={{ label: "Push", description: "desc" }}>
        <button>disabled-target</button>
      </SmartTooltip>,
    );
    fireEvent.mouseEnter(screen.getByText("disabled-target").parentElement as HTMLElement);
    act(() => {
      vi.runAllTimers();
    });
    expect(screen.queryByRole("tooltip")).toBeNull();
    useAppStore.setState({ smartTooltipsEnabled: true });
  });
});
