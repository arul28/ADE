// @vitest-environment jsdom

import React from "react";
import { MemoryRouter } from "react-router-dom";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrAgentPermissionMode } from "../../../../shared/types";
import type { ProviderModelSelector } from "../../shared/ProviderModelSelector";
import { PrResolverLaunchControls } from "./PrResolverLaunchControls";

type ProviderModelSelectorProps = React.ComponentProps<typeof ProviderModelSelector>;

vi.mock("../../shared/ProviderModelSelector", () => ({
  ProviderModelSelector: (props: ProviderModelSelectorProps) => (
    <div>
      <button type="button" onClick={() => props.onChange("anthropic/claude-sonnet-4-6")}>
        Pick Sonnet
      </button>
      <span data-testid="reasoning-effort">{props.reasoningEffort ?? ""}</span>
    </div>
  ),
}));

function renderControls(overrides: {
  modelId?: string;
  reasoningEffort?: string;
  permissionMode?: PrAgentPermissionMode;
  onModelChange?: ReturnType<typeof vi.fn>;
  onReasoningEffortChange?: ReturnType<typeof vi.fn>;
  onPermissionModeChange?: ReturnType<typeof vi.fn>;
} = {}) {
  const props = {
    modelId: overrides.modelId ?? "anthropic/claude-opus-4-7",
    reasoningEffort: overrides.reasoningEffort ?? "high",
    permissionMode: overrides.permissionMode ?? "default",
    onModelChange: overrides.onModelChange ?? vi.fn(),
    onReasoningEffortChange: overrides.onReasoningEffortChange ?? vi.fn(),
    onPermissionModeChange: overrides.onPermissionModeChange ?? vi.fn(),
  };

  render(
    <MemoryRouter>
      <PrResolverLaunchControls {...props} />
    </MemoryRouter>,
  );
  return props;
}

describe("PrResolverLaunchControls", () => {
  beforeEach(() => {
    (window as unknown as { ade?: unknown }).ade = {
      ai: {
        getStatus: vi.fn().mockResolvedValue(null),
      },
    };
  });

  afterEach(() => {
    cleanup();
    delete (window as unknown as { ade?: unknown }).ade;
  });

  it("uses Work-tab Claude permission presets, including ask permissions", async () => {
    const user = userEvent.setup();
    const props = renderControls({
      modelId: "anthropic/claude-opus-4-7",
      permissionMode: "default",
    });

    expect(screen.getByRole("button", { name: "Ask permissions" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Accept edits" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Plan" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Bypass" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Ask permissions" }));
    expect(props.onPermissionModeChange).toHaveBeenCalledWith("default");
  });

  it("uses Work-tab Codex presets, including config.toml", async () => {
    const user = userEvent.setup();
    const props = renderControls({
      modelId: "openai/gpt-5.5",
      permissionMode: "default",
    });

    expect(screen.getByRole("button", { name: "Default permissions" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Plan mode" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Full access" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Custom (config.toml)" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Custom (config.toml)" }));
    expect(props.onPermissionModeChange).toHaveBeenCalledWith("config-toml");
  });

  it("normalizes reasoning and permissions when switching models", async () => {
    const user = userEvent.setup();
    const props = renderControls({
      modelId: "anthropic/claude-opus-4-7",
      reasoningEffort: "xhigh",
      permissionMode: "config-toml",
    });

    await user.click(screen.getByRole("button", { name: "Pick Sonnet" }));

    expect(props.onModelChange).toHaveBeenCalledWith("anthropic/claude-sonnet-4-6");
    expect(props.onReasoningEffortChange).toHaveBeenCalledWith("medium");
    expect(props.onPermissionModeChange).toHaveBeenCalledWith("default");
  });
});
