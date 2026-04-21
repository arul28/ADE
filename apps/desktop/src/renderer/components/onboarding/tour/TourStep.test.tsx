/* @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TourStep } from "./TourStep";

afterEach(() => cleanup());

function renderStep(overrides: Partial<React.ComponentProps<typeof TourStep>> = {}) {
  const props: React.ComponentProps<typeof TourStep> = {
    step: { target: "#x", title: "Branch Selector", body: "Select your branch.", docUrl: "https://x.test/docs" },
    stepIndex: 2,
    totalSteps: 10,
    targetRect: null,
    missing: false,
    onNext: vi.fn(),
    onPrev: vi.fn(),
    onDismiss: vi.fn(),
    isLast: false,
    ...overrides,
  };
  return { ...render(<TourStep {...props} />), props };
}

describe("TourStep", () => {
  it("renders the title, body and step counter", () => {
    renderStep();
    expect(screen.getByText("Branch Selector")).toBeTruthy();
    expect(screen.getByText(/Select your branch/)).toBeTruthy();
    expect(screen.getByText("3 / 10")).toBeTruthy();
  });

  it("renders Learn more link only when docUrl is provided", () => {
    const openExternal = vi.fn(async () => undefined);
    (globalThis as any).window = (globalThis as any).window ?? {};
    (globalThis.window as any).ade = { app: { openExternal } };

    const { rerender, props } = renderStep({
      step: { target: "#x", title: "t", body: "b" },
    });
    expect(screen.queryByText(/Learn more/)).toBeNull();
    rerender(
      <TourStep
        {...props}
        step={{ target: "#x", title: "t", body: "b", docUrl: "https://y.test/x" }}
      />,
    );
    const link = screen.getByRole("link", { name: /Learn more/ }) as HTMLAnchorElement;
    expect(link.href).toContain("y.test/x");

    // Click routes through the Electron IPC bridge, not an in-app window.open.
    fireEvent.click(link);
    expect(openExternal).toHaveBeenCalledWith("https://y.test/x");
  });

  it("Skip/Back/Next buttons call the right handlers", () => {
    const { props } = renderStep();
    fireEvent.click(screen.getByRole("button", { name: /Skip/i }));
    expect(props.onDismiss).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /Back/i }));
    expect(props.onPrev).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /Next/i }));
    expect(props.onNext).toHaveBeenCalledTimes(1);
  });

  it("Back is disabled on step 0", () => {
    renderStep({ stepIndex: 0 });
    const back = screen.getByRole("button", { name: /Back/i }) as HTMLButtonElement;
    expect(back.disabled).toBe(true);
  });

  it("renders Finish label when isLast is true", () => {
    renderStep({ isLast: true, stepIndex: 9 });
    expect(screen.getByRole("button", { name: /Finish/i })).toBeTruthy();
  });

  it("appends the missing-target note when missing is true", () => {
    renderStep({ missing: true });
    expect(screen.getByText(/isn't on screen right now/i)).toBeTruthy();
  });
});
