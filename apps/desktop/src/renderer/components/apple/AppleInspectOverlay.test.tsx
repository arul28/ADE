/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IosScreenElement } from "../../../shared/types/iosSimulator";
import { AppleInspectOverlay } from "./AppleInspectOverlay";
import type { IosSimulatorSnapshotElement } from "./appleInspectGeometry";

afterEach(cleanup);

function element(
  overrides: Partial<IosScreenElement> & Pick<IosScreenElement, "id" | "frame">,
): IosSimulatorSnapshotElement {
  const frame = overrides.frame;
  return {
    source: "accessibility",
    layer: "accessibility",
    label: null,
    value: null,
    role: null,
    elementType: null,
    identifier: null,
    pixelFrame: { x: frame.x * 3, y: frame.y * 3, width: frame.width * 3, height: frame.height * 3 },
    componentId: null,
    sourceFile: null,
    sourceLine: null,
    metadata: {},
    ...overrides,
    frame,
  };
}

const SCREEN = element({ id: "screen", role: "application", frame: { x: 0, y: 0, width: 390, height: 844 } });
const BUTTON = element({
  id: "sign-in",
  role: "button",
  label: "Sign in",
  identifier: "signInButton",
  frame: { x: 100, y: 400, width: 120, height: 44 },
});

/** The presenter's mapping. Halved, so "device points" and "CSS pixels" cannot be confused. */
const deviceToView = (point: { x: number; y: number }) => ({ x: point.x / 2, y: point.y / 2 });

function renderOverlay(overrides: Partial<React.ComponentProps<typeof AppleInspectOverlay>> = {}) {
  const props: React.ComponentProps<typeof AppleInspectOverlay> = {
    elements: [SCREEN, BUTTON],
    deviceToView,
    hoveredRef: null,
    selectedRef: null,
    onHover: vi.fn(),
    onSelect: vi.fn(),
    ...overrides,
  };
  const view = render(<AppleInspectOverlay {...props} />);
  return { ...props, ...view };
}

describe("AppleInspectOverlay (round 4 §A4)", () => {
  it("draws one frame for each inspectable element", () => {
    const { container } = renderOverlay();
    const frames = container.querySelectorAll("[data-testid='apple-inspect-overlay'] > div");
    expect(frames.length).toBe(2);
  });

  it("draws nothing at all while the presenter cannot map", () => {
    const { container } = renderOverlay({ deviceToView: null });
    expect(container.querySelector("[data-testid='apple-inspect-overlay']")).toBeNull();
  });

  it("opens the card on the picked frame, with the element's details", () => {
    renderOverlay({ selectedRef: "sign-in" });
    const card = screen.getByTestId("apple-inspect-card");
    expect(card.textContent).toContain("Sign in");
    expect(card.textContent).toContain("signInButton");
    expect(card.textContent).toContain("button");
  });

  it("carries exactly §A4's two verbs, and hands back the element", () => {
    const onInsertIntoChat = vi.fn();
    const onCopy = vi.fn();
    renderOverlay({ selectedRef: "sign-in", onInsertIntoChat, onCopy });
    fireEvent.click(screen.getByTestId("apple-inspect-card-insert"));
    fireEvent.click(screen.getByTestId("apple-inspect-card-copy"));
    expect(onInsertIntoChat).toHaveBeenCalledWith(BUTTON);
    expect(onCopy).toHaveBeenCalledWith(BUTTON);
  });

  it("disables a verb the host cannot honour rather than dropping the click", () => {
    renderOverlay({ selectedRef: "sign-in" });
    expect(screen.getByTestId("apple-inspect-card-insert").hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("apple-inspect-card-copy").hasAttribute("disabled")).toBe(true);
  });

  it("closes the card on Escape, and on the card's own ✕", () => {
    const onSelect = vi.fn();
    renderOverlay({ selectedRef: "sign-in", onSelect });
    fireEvent.keyDown(screen.getByTestId("apple-inspect-overlay"), { key: "Escape" });
    expect(onSelect).toHaveBeenCalledWith(null);
    onSelect.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Close inspect details" }));
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it("picks the smallest frame under the click", () => {
    const props = renderOverlay();
    const overlay = screen.getByTestId("apple-inspect-overlay");
    overlay.getBoundingClientRect = () => new DOMRect(0, 0, 195, 422);
    fireEvent.click(overlay, { clientX: 60, clientY: 205 });
    expect(props.onSelect).toHaveBeenCalledWith("sign-in");
  });
});
