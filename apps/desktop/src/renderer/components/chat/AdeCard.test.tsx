/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AdeCard } from "./AdeCard";
import { ADE_NAVIGATE_TARGET_EVENT } from "../../lib/openExternal";
import { describeAdeCard, type AdeCardPayload } from "../../../shared/adeCard";

function card(over: Partial<AdeCardPayload> = {}): AdeCardPayload {
  return {
    cardId: "run-42",
    variant: "proof_artifact",
    state: "terminal",
    title: "Cloud artifacts pulled",
    fallbackText: "3 cloud artifacts pulled into the lane",
    ...over,
  };
}

describe("AdeCard", () => {
  afterEach(() => cleanup());

  it("renders fallbackText plus the deeplink for a variant this build does not know", () => {
    render(
      <AdeCard
        card={card({
          variant: "future_ci",
          title: "CI failed",
          fallbackText: "CI failed · 20 passed · 1 failed",
          navTarget: { kind: "pr", repoOwner: "arul28", repoName: "ADE", prNumber: 916 },
        })}
      />,
    );

    // The whole point of the degradation contract: never a blank row.
    expect(screen.getByText("CI failed · 20 passed · 1 failed")).toBeTruthy();
    expect(screen.getByText(/^ade:\/\//)).toBeTruthy();
    // The rich chrome must NOT render for an unknown variant.
    expect(screen.queryByText("CI failed")).toBeNull();
  });

  it("substitutes a generated description when an unknown-variant card ships an empty fallbackText", () => {
    const payload = card({ variant: "totally_new", fallbackText: "   ", subtitle: "run-42" });
    render(<AdeCard card={payload} />);

    const described = describeAdeCard(payload);
    expect(described.length).toBeGreaterThan(0);
    expect(screen.getByText(described)).toBeTruthy();
  });

  it("renders metrics, rows and a progress bar for a known variant", () => {
    render(
      <AdeCard
        card={card({
          subtitle: "run-42",
          metrics: [{ label: "files", value: "3", tone: "accent" }],
          rows: [{ icon: "file", text: "report.md", detail: ".ade/artifacts/report.md" }],
          progress: { passed: 3, failed: 0, running: 0, queued: 0 },
        })}
      />,
    );

    expect(screen.getByText("Cloud artifacts pulled")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.getByText("files")).toBeTruthy();
    expect(screen.getByText("report.md")).toBeTruthy();
    expect(screen.getByText(".ade/artifacts/report.md")).toBeTruthy();
  });

  it("dispatches the shared app-navigation event when a card with a navTarget is clicked", () => {
    const listener = vi.fn();
    window.addEventListener(ADE_NAVIGATE_TARGET_EVENT, listener);
    try {
      render(
        <AdeCard
          card={card({ navTarget: { kind: "file", path: ".ade/artifacts/report.md", laneId: "lane-1" } })}
        />,
      );
      fireEvent.click(screen.getByRole("button"));
      expect(listener).toHaveBeenCalledTimes(1);
      const detail = (listener.mock.calls[0]![0] as CustomEvent).detail;
      expect(detail.target).toEqual({ kind: "file", path: ".ade/artifacts/report.md", laneId: "lane-1" });
    } finally {
      window.removeEventListener(ADE_NAVIGATE_TARGET_EVENT, listener);
    }
  });

  it("fires the action without also navigating the card", () => {
    const onAction = vi.fn();
    const listener = vi.fn();
    window.addEventListener(ADE_NAVIGATE_TARGET_EVENT, listener);
    try {
      render(
        <AdeCard
          card={card({
            navTarget: { kind: "file", path: ".ade/artifacts/report.md" },
            actions: [{ id: "open-lane", label: "Open lane", kind: "primary" }],
          })}
          onAction={onAction}
        />,
      );
      fireEvent.click(screen.getByText("Open lane"));
      expect(onAction).toHaveBeenCalledWith("open-lane");
      expect(listener).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(ADE_NAVIGATE_TARGET_EVENT, listener);
    }
  });

  it("does not treat a nested action's keyboard event as whole-card navigation", () => {
    const onAction = vi.fn();
    const listener = vi.fn();
    window.addEventListener(ADE_NAVIGATE_TARGET_EVENT, listener);
    try {
      render(
        <AdeCard
          card={card({
            navTarget: { kind: "file", path: ".ade/artifacts/report.md" },
            actions: [{ id: "inspect", label: "Inspect", kind: "primary" }],
          })}
          onAction={onAction}
        />,
      );
      fireEvent.keyDown(screen.getByText("Inspect"), { key: "Enter" });
      expect(listener).not.toHaveBeenCalled();
      expect(onAction).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(ADE_NAVIGATE_TARGET_EVENT, listener);
    }
  });

  it("treats the reserved open action as card navigation", () => {
    const onAction = vi.fn();
    const listener = vi.fn();
    window.addEventListener(ADE_NAVIGATE_TARGET_EVENT, listener);
    try {
      render(
        <AdeCard
          card={card({
            navTarget: { kind: "pr", repoOwner: "arul28", repoName: "ADE", prNumber: 916 },
            actions: [{ id: "open", label: "Review merge", kind: "primary" }],
          })}
          onAction={onAction}
        />,
      );
      fireEvent.click(screen.getByText("Review merge"));
      expect(listener).toHaveBeenCalledTimes(1);
      expect(onAction).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(ADE_NAVIGATE_TARGET_EVENT, listener);
    }
  });

  it("never renders a red failure tone — failures are amber (house policy)", () => {
    const { container } = render(
      <AdeCard
        card={card({
          title: "CI failed",
          metrics: [{ label: "failed", value: "1", tone: "warning" }],
          rows: [{ icon: "fail", text: "test-desktop (2)", tone: "warning" }],
          progress: { passed: 20, failed: 1, running: 0, queued: 0 },
        })}
      />,
    );

    const markup = container.innerHTML;
    expect(markup).not.toMatch(/\b(?:text|bg|border)-(?:red|rose)-/);
    expect(markup).toMatch(/amber/);
  });
});
