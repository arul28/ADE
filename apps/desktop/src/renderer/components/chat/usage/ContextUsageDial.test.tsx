/* @vitest-environment jsdom */
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { resolveContextCompactControl } from "../../../../shared/contextCompaction";
import { ContextUsageDial, buildContent } from "./ContextUsageDial";
import type { ContextUsageViewModel } from "./contextUsageModel";

function vm(partial: Partial<ContextUsageViewModel>): ContextUsageViewModel {
  return {
    provider: "codex",
    state: "measured",
    contextWindow: 200_000,
    usedTokens: 100_000,
    inputTokens: 100_000,
    outputTokens: 500,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
    totalTokens: null,
    ratio: 0.5,
    windowSource: "runtime",
    ...partial,
  };
}

describe("ContextUsageDial", () => {
  // The popover renders in a portal on document.body, so unmount between tests.
  afterEach(cleanup);

  it("renders the integer percentage inside the ring", () => {
    const { getByText, container } = render(<ContextUsageDial usage={vm({ ratio: 0.52 })} />);
    expect(getByText("52")).toBeTruthy();
    expect(container.querySelector("svg")).toBeTruthy();
  });

  it("hides stale percentages while usage is being recalculated", () => {
    const { getByLabelText, queryByText } = render(
      <ContextUsageDial usage={vm({ ratio: 1, state: "recalculating" })} />,
    );
    expect(queryByText("100")).toBeNull();
    expect(getByLabelText("Context usage: recalculating")).toBeTruthy();
  });

  it("marks an unavailable authoritative reading as unknown", () => {
    const { getByLabelText, getByText } = render(
      <ContextUsageDial usage={vm({ ratio: 1, state: "unknown" })} />,
    );
    expect(getByText("?")).toBeTruthy();
    expect(getByLabelText("Context usage unavailable")).toBeTruthy();
  });

  // Three bands: normal, nearing compaction (from the DISPLAYED 80%), and nearing the limit.
  it("changes its ring colour at the displayed 80% and at 90%", () => {
    const strokeAt = (ratio: number) => {
      const { container, unmount } = render(<ContextUsageDial usage={vm({ ratio })} />);
      const stroke = container.querySelector("circle[stroke-dasharray]")?.getAttribute("stroke");
      unmount();
      return stroke;
    };
    const [normal, rounded, warning, danger] = [0.5, 0.795, 0.85, 0.95].map(strokeAt);
    expect(new Set([normal, warning, danger]).size).toBe(3);
    expect(rounded).toBe(warning);
  });

  it("falls back to a tokens-only readout when the window is unknown", () => {
    const { getByText, container } = render(
      <ContextUsageDial usage={vm({ ratio: null, contextWindow: null, usedTokens: 12_000 })} />,
    );
    expect(getByText("12k")).toBeTruthy();
    expect(container.querySelector("svg")).toBeNull();
  });

  it("renders nothing when there is no usage to show", () => {
    const { container } = render(
      <ContextUsageDial usage={vm({ ratio: null, contextWindow: null, usedTokens: null })} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("exposes the percentage on the accessible label", () => {
    const { container } = render(<ContextUsageDial usage={vm({ ratio: 0.42 })} />);
    expect(container.querySelector('[aria-label="Context usage: 42% full"]')).toBeTruthy();
  });

  it("adds a cache-write breakdown segment after cached when present", () => {
    const content = buildContent(vm({ cacheReadTokens: 4_000, cacheWriteTokens: 2_048 }));
    expect(content.gitCommand).toContain("cache write 2k");
    const cachedIndex = content.gitCommand!.indexOf("cached");
    const cacheWriteIndex = content.gitCommand!.indexOf("cache write");
    expect(cachedIndex).toBeGreaterThanOrEqual(0);
    expect(cacheWriteIndex).toBeGreaterThan(cachedIndex);
  });

  it("omits the cache-write segment when there is no cache-write usage", () => {
    const content = buildContent(vm({ cacheWriteTokens: null }));
    expect(content.gitCommand ?? "").not.toContain("cache write");
  });

  it("opens the details popover without a Compact now action when the provider cannot compact", () => {
    const { getByRole, queryByText } = render(<ContextUsageDial usage={vm({ ratio: 0.82 })} />);
    fireEvent.click(getByRole("button", { name: "Context usage: 82% full" }));
    expect(getByRole("dialog")).toBeTruthy();
    expect(queryByText("Compact now")).toBeNull();
  });

  it("compacts from the popover's Compact now when idle, then closes the popover", () => {
    const onCompact = vi.fn();
    const compact = resolveContextCompactControl({
      provider: "codex",
      state: "measured",
      enabled: true,
    });
    const { getByRole, queryByRole } = render(
      <ContextUsageDial usage={vm({ ratio: 0.82 })} compactControl={compact} onCompact={onCompact} />,
    );
    fireEvent.click(getByRole("button", { name: "Context usage: 82% full. Compact context" }));
    expect(onCompact).not.toHaveBeenCalled();
    fireEvent.click(getByRole("button", { name: "Compact now" }));
    expect(onCompact).toHaveBeenCalledTimes(1);
    expect(queryByRole("dialog")).toBeNull();
    const content = buildContent(vm({ ratio: 0.82 }), undefined, compact);
    expect(content.label).toBe("Compact context");
    expect(content.warning).toContain("compact");
    expect(content.description).toContain("Your visible chat stays");
  });

  it("disables Compact now while a turn is active", () => {
    const onCompact = vi.fn();
    const compact = resolveContextCompactControl({
      provider: "claude",
      state: "measured",
      enabled: true,
      turnActive: true,
    });
    const { getByRole } = render(
      <ContextUsageDial usage={vm({ ratio: 0.4 })} compactControl={compact} onCompact={onCompact} />,
    );
    fireEvent.click(getByRole("button", {
      name: "Context usage: 40% full. Wait for this turn to finish before compacting.",
    }));
    const button = getByRole("button", { name: "Compact now" });
    expect(button).toHaveProperty("disabled", true);
    fireEvent.click(button);
    expect(onCompact).not.toHaveBeenCalled();
  });

  it("hides Compact now while occupancy is not measured", () => {
    const compact = resolveContextCompactControl({
      provider: "pi",
      state: "compacting",
      enabled: true,
    });
    const { getByRole, queryByText } = render(
      <ContextUsageDial usage={vm({ ratio: 1, state: "compacting" })} compactControl={compact} onCompact={vi.fn()} />,
    );
    expect(compact.status).toBe("hidden");
    fireEvent.click(getByRole("button", { name: "Context usage: compacting" }));
    expect(queryByText("Compact now")).toBeNull();
  });

  it("links to the provider's compaction setting only for providers that can compact", () => {
    const { getByRole, queryByText, unmount } = render(<ContextUsageDial usage={vm({ provider: "claude" })} />);
    fireEvent.click(getByRole("button", { name: /^Context usage/ }));
    expect(getByRole("link", { name: "Provider compaction setting" })).toBeTruthy();
    unmount();
    const other = render(<ContextUsageDial usage={vm({ provider: "cursor" })} />);
    fireEvent.click(other.getByRole("button", { name: /^Context usage/ }));
    expect(queryByText("Provider compaction setting")).toBeNull();
  });
});
