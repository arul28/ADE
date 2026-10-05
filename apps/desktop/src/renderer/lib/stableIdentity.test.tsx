/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { memoWithLatestHandlers, useLatestCallback } from "./stableIdentity";

afterEach(() => cleanup());

describe("memoWithLatestHandlers", () => {
  it("skips a render when only handlers change, calls the latest one, and keeps an absent handler absent", () => {
    let renders = 0;
    const Card = memoWithLatestHandlers(function Card({ label, onPick }: { label: string; onPick?: (label: string) => void }) {
      renders += 1;
      return (
        <div>
          <span>{label}</span>
          {onPick ? <button type="button" onClick={() => onPick(label)}>pick</button> : null}
        </div>
      );
    });
    const first = vi.fn();
    const latest = vi.fn();

    const view = render(<Card label="chat-a" onPick={first} />);
    expect(renders).toBe(1);

    // A parent re-render with a fresh inline handler and the same data.
    view.rerender(<Card label="chat-a" onPick={latest} />);
    expect(renders).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "pick" }));
    expect(latest).toHaveBeenCalledWith("chat-a");
    expect(first).not.toHaveBeenCalled();

    // The handler going away is a real change: the control it gates goes too.
    view.rerender(<Card label="chat-a" />);
    expect(renders).toBe(2);
    expect(screen.queryByRole("button", { name: "pick" })).toBeNull();

    view.rerender(<Card label="chat-b" onPick={latest} />);
    expect(renders).toBe(3);
    expect(screen.getByText("chat-b")).toBeTruthy();
  });
});

describe("useLatestCallback", () => {
  it("keeps one identity, always calls the latest function, and is undefined while the function is", () => {
    const first = vi.fn((value: number) => value + 1);
    const latest = vi.fn((value: number) => value * 10);
    const { result, rerender } = renderHook(
      ({ fn }: { fn?: (value: number) => number }) => useLatestCallback(fn),
      { initialProps: { fn: first as ((value: number) => number) | undefined } },
    );
    const stable = result.current;
    expect(stable?.(1)).toBe(2);

    rerender({ fn: latest });
    expect(result.current).toBe(stable);
    expect(result.current?.(2)).toBe(20);
    expect(first).toHaveBeenCalledTimes(1);

    rerender({ fn: undefined });
    expect(result.current).toBeUndefined();
    rerender({ fn: first });
    expect(result.current).toBe(stable);
  });
});
