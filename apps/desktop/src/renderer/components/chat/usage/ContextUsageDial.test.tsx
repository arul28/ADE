/* @vitest-environment jsdom */
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
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

  it("uses the sky color below 70%", () => {
    const { container } = render(<ContextUsageDial usage={vm({ ratio: 0.5 })} />);
    expect(container.querySelector('circle[stroke="#38bdf8"]')).toBeTruthy();
  });

  it("uses the rose color when nearing the limit", () => {
    const { container } = render(<ContextUsageDial usage={vm({ ratio: 0.95 })} />);
    expect(container.querySelector('circle[stroke="#fb7185"]')).toBeTruthy();
  });

  it("uses amber when the displayed percentage rounds up to 80", () => {
    const { container } = render(<ContextUsageDial usage={vm({ ratio: 0.795 })} />);
    expect(container.querySelector('circle[stroke="#fbbf24"]')).toBeTruthy();
  });

  it("falls back to a tokens-only readout when the window is unknown", () => {
    const { getByText, container } = render(
      <ContextUsageDial usage={vm({ ratio: null, contextWindow: null, usedTokens: 12_000 })} />,
    );
    expect(getByText("12.0k")).toBeTruthy();
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
    expect(content.gitCommand).toContain("cache write 2.0k");
    const cachedIndex = content.gitCommand!.indexOf("cached");
    const cacheWriteIndex = content.gitCommand!.indexOf("cache write");
    expect(cachedIndex).toBeGreaterThanOrEqual(0);
    expect(cacheWriteIndex).toBeGreaterThan(cachedIndex);
  });

  it("omits the cache-write segment when there is no cache-write usage", () => {
    const content = buildContent(vm({ cacheWriteTokens: null }));
    expect(content.gitCommand ?? "").not.toContain("cache write");
  });

  it("keeps the meter read-only without a compact action", () => {
    const { container } = render(<ContextUsageDial usage={vm({ ratio: 0.82 })} />);
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector('[aria-label="Context usage: 82% full"]')).toBeTruthy();
  });

  it("tells an idle Claude/Codex/Pi dial to compact on click", () => {
    const onCompact = vi.fn();
    const compact = resolveContextCompactControl({
      provider: "codex",
      state: "measured",
      enabled: true,
    });
    const { getByRole } = render(
      <ContextUsageDial usage={vm({ ratio: 0.82 })} compactControl={compact} onCompact={onCompact} />,
    );
    const button = getByRole("button", { name: "Context usage: 82% full. Compact context" });
    fireEvent.click(button);
    expect(onCompact).toHaveBeenCalledTimes(1);
    const content = buildContent(vm({ ratio: 0.82 }), undefined, compact);
    expect(content.label).toBe("Compact context");
    expect(content.warning).toContain("click to compact");
    expect(content.description).toContain("Your visible chat stays");
  });

  it("disables compact while a turn is active", () => {
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
    const button = getByRole("button", {
      name: "Context usage: 40% full. Wait for this turn to finish before compacting.",
    });
    expect(button).toHaveProperty("disabled", true);
    fireEvent.click(button);
    expect(onCompact).not.toHaveBeenCalled();
  });

  it("hides the compact action while occupancy is not measured", () => {
    const compact = resolveContextCompactControl({
      provider: "pi",
      state: "compacting",
      enabled: true,
    });
    const { container } = render(
      <ContextUsageDial usage={vm({ ratio: 1, state: "compacting" })} compactControl={compact} onCompact={vi.fn()} />,
    );
    expect(compact.status).toBe("hidden");
    expect(container.querySelector("button")).toBeNull();
  });
});
