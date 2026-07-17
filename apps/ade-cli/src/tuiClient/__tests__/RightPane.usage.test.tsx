import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { RightPane } from "../components/RightPane";
import type { RightPaneContent } from "../types";
import { SpinTickProvider } from "../spinTick";

function renderPane(content: RightPaneContent, width = 48) {
  return render(
    <SpinTickProvider active={false}>
      <RightPane content={content} width={width} />
    </SpinTickProvider>,
  );
}

describe("RightPane usage", () => {
  it("renders a quota window with percent + reset countdown and the session block", () => {
    const resetAt = Math.round(Date.now() / 1000) + 2 * 3600; // 2h out
    const { lastFrame } = renderPane({
      kind: "usage",
      title: "Usage",
      providerStatuses: [{
        id: "claude",
        label: "Claude",
        state: "ok",
        source: "oauth",
        updatedAt: new Date().toISOString(),
      }],
      quotaWindows: [{ id: "rate-limit", label: "Rate limit", percent: 42, resetAt }],
      session: { input: 12_000, output: 3_400, cost: 0.42 },
    });
    const text = lastFrame() ?? "";
    expect(text).toContain("USAGE");
    expect(text).toContain("Claude");
    expect(text).toContain("OAUTH · just now");
    expect(text).toContain("Rate limit");
    expect(text).toContain("42%");
    // Live reset countdown marker.
    expect(text).toContain("↻");
    // Session block.
    expect(text).toContain("This session");
    expect(text).toContain("12.0k");
    expect(text).toContain("3.4k");
    expect(text).toContain("$0.42");
  });

  it("marks carried-forward provider data as stale without hiding quota windows", () => {
    const { lastFrame } = renderPane({
      kind: "usage",
      title: "Usage",
      providerStatuses: [{
        id: "codex",
        label: "Codex",
        state: "stale",
        source: "http",
        updatedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
        message: "Rate limited; retrying soon",
      }],
      quotaWindows: [{ id: "codex:weekly", label: "Codex weekly", percent: 61, resetAt: null }],
      session: null,
    });
    const text = lastFrame() ?? "";
    expect(text).toContain("HTTP · 2m ago");
    expect(text).toContain("STALE · Rate limited; retrying soon");
    expect(text).toContain("Codex weekly");
    expect(text).toContain("61%");
  });

  it("degrades to the session block when quota windows are unavailable", () => {
    const { lastFrame } = renderPane({
      kind: "usage",
      title: "Usage",
      quotaWindows: undefined,
      session: { input: 500, output: 100, cost: 0 },
    });
    const text = lastFrame() ?? "";
    expect(text).toContain("Quota windows unavailable.");
    expect(text).toContain("This session");
    expect(text).toContain("$0.00");
  });

  it("surfaces a terse Codex spending-cap marker when spendControlReached is set", () => {
    const { lastFrame } = renderPane({
      kind: "usage",
      title: "Usage",
      quotaWindows: [{ id: "codex:weekly", label: "Codex weekly", percent: 61, resetAt: null }],
      session: null,
      spendControlReached: true,
    });
    const text = lastFrame() ?? "";
    expect(text).toContain("Codex spending cap reached");
    // Marker must not suppress the rest of the pane.
    expect(text).toContain("Codex weekly");
  });

  it("omits the spending-cap marker when the flag is unset", () => {
    const { lastFrame } = renderPane({
      kind: "usage",
      title: "Usage",
      quotaWindows: [{ id: "codex:weekly", label: "Codex weekly", percent: 61, resetAt: null }],
      session: null,
    });
    expect(lastFrame() ?? "").not.toContain("spending cap reached");
  });

  it("renders a loading state while the snapshot is being fetched", () => {
    const { lastFrame } = renderPane({ kind: "usage", title: "Usage", loading: true });
    expect(lastFrame() ?? "").toContain("Loading usage…");
  });

  it("surfaces an error while keeping the pane title", () => {
    const { lastFrame } = renderPane({
      kind: "usage",
      title: "Usage",
      error: "daemon offline",
      session: { input: 1, output: 2, cost: 3 },
    });
    const text = lastFrame() ?? "";
    expect(text).toContain("USAGE");
    expect(text).toContain("Usage unavailable");
    expect(text).toContain("daemon offline");
  });

  it("renders a near-full window's percent (≥95% danger escalation) with no session", () => {
    const { lastFrame } = renderPane({
      kind: "usage",
      title: "Usage",
      quotaWindows: [{ id: "rate-limit", label: "Rate limit", percent: 97, resetAt: null }],
      session: null,
    });
    const text = lastFrame() ?? "";
    expect(text).toContain("Rate limit");
    expect(text).toContain("97%");
    expect(text).toContain("No session usage yet.");
  });
});
