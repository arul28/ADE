import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { RightPane } from "../components/RightPane";
import type { ProviderReadinessRow, RightPaneContent, SetupPaneRow } from "../types";

const setupRows: SetupPaneRow[] = [
  { kind: "provider", label: "Provider", value: "Codex", cyclable: true },
  { kind: "model", label: "Model", value: "GPT-5.5", cyclable: true, detail: "5 available" },
  { kind: "reasoning", label: "Reasoning", value: "medium", cyclable: true, detail: "low, medium, high" },
  { kind: "permission", label: "Permissions", value: "default", cyclable: true },
  { kind: "codex-fast", label: "Fast mode", value: "off", cyclable: true, detail: "Codex service tier" },
  { kind: "refresh-status", label: "Refresh status", value: "run", detail: "checks provider auth/runtime state" },
  { kind: "open-settings", label: "Full settings", value: "open desktop", detail: "Settings > AI Providers" },
];

const providerRows: ProviderReadinessRow[] = [
  { provider: "codex", label: "Codex", status: "ready", detail: "ready at /usr/local/bin/codex", modelCount: 6 },
  { provider: "claude", label: "Claude", status: "ready", detail: "ready at /usr/local/bin/claude", modelCount: 4 },
  { provider: "cursor", label: "Cursor", status: "unknown", detail: "API key store not yet readable", modelCount: 0 },
  { provider: "droid", label: "Droid", status: "unavailable", detail: "no Factory Droid CLI or FACTORY_API_KEY", modelCount: 0 },
  { provider: "opencode", label: "OpenCode", status: "ready", detail: "user-installed · 0 shared runtime", modelCount: 4442 },
];

function content(overrides: Partial<Extract<RightPaneContent, { kind: "model-setup" }>> = {}): RightPaneContent {
  return {
    kind: "model-setup",
    rows: setupRows,
    providerRows,
    activeProvider: "codex",
    checkedAt: "2026-05-09T19:57:09.000Z",
    desktopAttached: true,
    ...overrides,
  };
}

function renderModelSetup(selectedIndex: number, overrides: Partial<Extract<RightPaneContent, { kind: "model-setup" }>> = {}): string {
  const result = render(
    <RightPane content={content(overrides)} selectedIndex={selectedIndex} focused />,
  );
  return result.lastFrame() ?? "";
}

describe("RightPane model-setup", () => {
  it("renders MODEL and PROVIDERS section headers", () => {
    const frame = renderModelSetup(0);
    expect(frame).toContain("MODEL");
    expect(frame).toContain("PROVIDERS");
  });

  it("shows ‹ › chevron on cyclable setup rows and ↵ on action rows", () => {
    const frame = renderModelSetup(0);
    expect(frame).toContain("‹ ›");
    expect(frame).toContain("↵");
  });

  it("renders all five providers with their brand glyphs", () => {
    const frame = renderModelSetup(0);
    expect(frame).toContain("◇ Codex");
    expect(frame).toContain("◆ Claude");
    expect(frame).toContain("▲ Cursor");
    expect(frame).toContain("▣ Droid");
    expect(frame).toContain("◈ OpenCode");
  });

  it("collapses provider detail when no provider row is selected", () => {
    const frame = renderModelSetup(0);
    expect(frame).not.toContain("4 models");
    expect(frame).not.toContain("/usr/local/bin/claude");
  });

  it("expands provider detail when its row is selected", () => {
    const claudeIndex = setupRows.length + 1;
    const frame = renderModelSetup(claudeIndex);
    expect(frame).toContain("4 models");
    expect(frame).toContain("/usr/local/bin/claude");
  });

  it("renders the footer with checked time and key hints", () => {
    const frame = renderModelSetup(0);
    expect(frame).toContain("19:57:09");
    expect(frame).toContain("↑↓");
    expect(frame).toContain("←→");
    expect(frame).toContain("enter");
  });

  it("marks the active provider in the providers list", () => {
    const frame = renderModelSetup(0);
    expect(frame).toMatch(/◇ Codex.*active/);
  });
});
