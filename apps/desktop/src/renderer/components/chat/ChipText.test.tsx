/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { LaneSummary } from "../../../shared/types";
import { useAppStore } from "../../state/appStore";
import { ChipText } from "./ChipText";
import { resetChipPreviewCacheForTesting } from "./chipPreviewStore";

const LANE_ID = "25f280a4-9c1b-4f2e-8a77-1d5c0b3e6a44";

function laneChipText(): string {
  return `look at ade://lane/${LANE_ID}`;
}

describe("ChipText", () => {
  beforeEach(() => {
    resetChipPreviewCacheForTesting();
  });

  afterEach(() => {
    cleanup();
    useAppStore.setState({ lanes: [] });
    delete (window as unknown as { ade?: unknown }).ade;
  });

  it("renders the raw label first and swaps in the resolved title", async () => {
    const deferred: { release?: (value: unknown) => void } = {};
    const resolveSmartLinkPreview = vi.fn(() => new Promise((resolve) => {
      deferred.release = resolve;
    }));
    (window as unknown as { ade: unknown }).ade = { agentChat: { resolveSmartLinkPreview } };

    render(<ChipText text="see https://example.com/post for details" />);

    // First paint is synchronous from the raw label — a message never waits on
    // the network to appear.
    expect(screen.getByText("https://example.com/post")).toBeTruthy();

    deferred.release?.({
      url: "https://example.com/post",
      provider: "generic",
      kind: "web_page",
      label: "https://example.com/post",
      title: "Release notes",
      iconDataUrl: "data:image/png;base64,AAAB",
    });

    await waitFor(() => expect(screen.getByText("Release notes")).toBeTruthy());
    expect(screen.queryByText("https://example.com/post")).toBeNull();
    const icon = document.querySelector("img");
    expect(icon?.getAttribute("src")).toBe("data:image/png;base64,AAAB");
  });

  it("keeps the raw label when the preview adds nothing", async () => {
    const resolveSmartLinkPreview = vi.fn().mockResolvedValue(null);
    (window as unknown as { ade: unknown }).ade = { agentChat: { resolveSmartLinkPreview } };

    render(<ChipText text="https://example.com/plain" />);
    await waitFor(() => expect(resolveSmartLinkPreview).toHaveBeenCalledTimes(1));
    expect(screen.getByText("https://example.com/plain")).toBeTruthy();
  });

  it("never asks the runtime about chips that resolve locally", async () => {
    const resolveSmartLinkPreview = vi.fn();
    (window as unknown as { ade: unknown }).ade = { agentChat: { resolveSmartLinkPreview } };

    render(<ChipText text="@chat:abc123 and ade://lane/25f280a4-9c1b-4f2e-8a77-1d5c0b3e6a44" />);
    await waitFor(() => expect(screen.getByText("Lane 25f280a4")).toBeTruthy());
    expect(resolveSmartLinkPreview).not.toHaveBeenCalled();
  });

  it("leaves a message with no chips as plain text", () => {
    const { container } = render(<ChipText text="just words" className="prose" />);
    expect(container.textContent).toBe("just words");
    expect(container.querySelector("span")).toBeNull();
  });

  it("shows a lane hover card on focus and hides it on Escape", async () => {
    useAppStore.setState({
      lanes: [{ id: LANE_ID, name: "Composer chips", branchRef: "ade/composer-chips" } as LaneSummary],
    });

    render(<ChipText text={laneChipText()} />);
    const chip = screen.getByRole("button");

    // Focus, not hover: the card must be reachable by keyboard, and focusing
    // the trigger never moves focus into the card itself.
    fireEvent.focus(chip);
    await waitFor(() => expect(screen.getByRole("tooltip")).toBeTruthy());
    expect(screen.getByRole("tooltip").textContent).toContain("Composer chips");
    expect(screen.getByRole("tooltip").textContent).toContain("ade/composer-chips");
    expect(document.activeElement).not.toBe(screen.getByRole("tooltip"));

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  });

  it("shows no card at all when the lane is unknown", async () => {
    render(<ChipText text={laneChipText()} />);
    fireEvent.focus(screen.getByRole("button"));
    // The card resolves to nothing rather than to an error state.
    await waitFor(() => expect(screen.getByRole("button")).toBeTruthy());
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});
