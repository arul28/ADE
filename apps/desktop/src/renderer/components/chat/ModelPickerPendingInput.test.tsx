/* @vitest-environment jsdom */

/**
 * Pending-input slot tests for `kind: "model_selection"`. The card renders
 * the in-house ModelPicker, captures the user's selection, and surfaces it
 * back through the composer's `onApproval` callback as
 * `answers.selection = JSON.stringify(modelSelection)` so the pane can
 * forward it to `agentChat.respondToInput`. See `goal.md` §10.9 + §13 +
 * §17 step 6.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChatModelSelectionPendingCard } from "./ChatModelSelectionPendingCard";
import type {
  ModelSelection,
  OrchestrationModelSelectionMetadata,
} from "../../../shared/types/orchestration";

// The ModelPicker mounts a Radix popover and reads from a real DOM API
// (`window.ade.agentChat.modelCatalog`). We stub the bridge so the picker
// renders deterministically without hitting IPC.
vi.mock("../shared/ModelPicker/ModelPicker", () => ({
  ModelPicker: ({ value, onChange }: { value: string; onChange: (id: string) => void }) => (
    <div data-testid="mock-model-picker" data-current-model={value}>
      <button data-testid="mock-pick-claude-sonnet" onClick={() => onChange("claude-sonnet-4-6")}>
        Pick claude-sonnet-4-6
      </button>
      <button data-testid="mock-pick-claude-opus" onClick={() => onChange("opus[1m]")}>
        Pick opus[1m]
      </button>
      <button data-testid="mock-pick-ollama" onClick={() => onChange("ollama/llama3.1")}>
        Pick ollama/llama3.1
      </button>
    </div>
  ),
}));

vi.mock("../shared/ModelPicker/ReasoningEffortPicker", () => ({
  ReasoningEffortPicker: ({
    reasoningEffort,
    onChange,
  }: {
    reasoningEffort: string | null;
    onChange: (next: string | null) => void;
  }) => (
    <div data-testid="mock-reasoning-picker" data-current-reasoning={reasoningEffort ?? ""}>
      <button data-testid="mock-pick-xhigh" onClick={() => onChange("xhigh")}>xhigh</button>
    </div>
  ),
}));

afterEach(() => {
  cleanup();
});

describe("ChatModelSelectionPendingCard", () => {
  const metadata: OrchestrationModelSelectionMetadata = {
    role: "worker",
    tag: "web-ui",
    workDescription: "Build the settings page and wire the save flow.",
    filesHint: ["src/renderer/components/SettingsPage.tsx", "src/main/services/settings.ts"],
    dependsOn: ["backend"],
  };

  it("renders the agent briefing and starts with no model pre-selected", () => {
    render(
      <ChatModelSelectionPendingCard
        metadata={metadata}
        responding={false}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByTestId("orchestration-model-selection-pending-card")).toBeTruthy();
    // Briefing: role · tag chip + work description + a touched-file chip.
    expect(screen.getByTestId("orchestration-model-selection-agent-chip").textContent ?? "")
      .toContain("web-ui");
    expect(screen.getByText(/Build the settings page/)).toBeTruthy();
    expect(screen.getByText("src/renderer/components/SettingsPage.tsx")).toBeTruthy();
    expect(screen.getByText("Files it touches")).toBeTruthy();
    expect(screen.getByText("Runs after")).toBeTruthy();
    expect(screen.getByText("backend")).toBeTruthy();
    // No recommended model — picker starts empty and confirm is disabled.
    expect(screen.getByTestId("mock-model-picker").getAttribute("data-current-model")).toBe("");
    const confirmBtn = screen.getByTestId("orchestration-model-selection-confirm") as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);
  });

  it("resets local picker state when a different request arrives", () => {
    const { rerender } = render(
      <ChatModelSelectionPendingCard
        metadata={metadata}
        responding={false}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("mock-pick-claude-sonnet"));
    fireEvent.click(screen.getByTestId("mock-pick-xhigh"));
    expect(screen.getByTestId("mock-model-picker").getAttribute("data-current-model")).toBe(
      "claude-sonnet-4-6",
    );
    expect(screen.getByTestId("mock-reasoning-picker").getAttribute("data-current-reasoning")).toBe(
      "xhigh",
    );

    rerender(
      <ChatModelSelectionPendingCard
        metadata={{
          ...metadata,
          tag: "backend",
          workDescription: "Implement the persistence path.",
          filesHint: ["src/main/services/settings.ts"],
          dependsOn: ["planning"],
        }}
        responding={false}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByTestId("mock-model-picker").getAttribute("data-current-model")).toBe("");
    expect(screen.getByTestId("mock-reasoning-picker").getAttribute("data-current-reasoning")).toBe("");
    const confirmBtn = screen.getByTestId("orchestration-model-selection-confirm") as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);
  });

  it("calls onConfirm with the model the user picks from scratch", () => {
    const onConfirm = vi.fn<[selection: ModelSelection], void>();
    render(
      <ChatModelSelectionPendingCard
        metadata={metadata}
        responding={false}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("mock-pick-claude-sonnet"));
    fireEvent.click(screen.getByTestId("mock-pick-xhigh"));
    fireEvent.click(screen.getByTestId("orchestration-model-selection-confirm"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm.mock.calls[0]![0]).toMatchObject({
      provider: "claude",
      modelId: "claude-sonnet-4-6",
      reasoningEffort: "xhigh",
    });
  });

  it("infers the provider from the picked model family", () => {
    const onConfirm = vi.fn<[selection: ModelSelection], void>();
    render(
      <ChatModelSelectionPendingCard
        metadata={metadata}
        responding={false}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("mock-pick-claude-opus"));
    fireEvent.click(screen.getByTestId("orchestration-model-selection-confirm"));
    const args = onConfirm.mock.calls[0]![0];
    expect(args.modelId).toBe("opus[1m]");
    expect(args.provider).toBe("claude");
  });

  it("routes local runtime catalog picks through OpenCode", () => {
    const onConfirm = vi.fn<[selection: ModelSelection], void>();
    render(
      <ChatModelSelectionPendingCard
        metadata={metadata}
        responding={false}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("mock-pick-ollama"));
    fireEvent.click(screen.getByTestId("orchestration-model-selection-confirm"));
    const args = onConfirm.mock.calls[0]![0];
    expect(args.modelId).toBe("ollama/llama3.1");
    expect(args.provider).toBe("opencode");
  });

  it("caps dependency chips with an overflow marker", () => {
    render(
      <ChatModelSelectionPendingCard
        metadata={{
          ...metadata,
          dependsOn: ["one", "two", "three", "four", "five", "six", "seven"],
        }}
        responding={false}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText("one")).toBeTruthy();
    expect(screen.queryByText("seven")).toBeNull();
    expect(screen.getByText("+1")).toBeTruthy();
  });

  it("Cancel triggers onCancel", () => {
    const onCancel = vi.fn();
    render(
      <ChatModelSelectionPendingCard
        metadata={metadata}
        responding={false}
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );
    const cancelBtn = screen.getByRole("button", { name: "Cancel" });
    fireEvent.click(cancelBtn);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("disables the confirm button while responding", () => {
    render(
      <ChatModelSelectionPendingCard
        metadata={metadata}
        responding={true}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const confirmBtn = screen.getByTestId("orchestration-model-selection-confirm") as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);
    expect(confirmBtn.textContent ?? "").toMatch(/Submitting/i);
  });

  it("falls back to default state when metadata is null", () => {
    const onConfirm = vi.fn<[selection: ModelSelection], void>();
    render(
      <ChatModelSelectionPendingCard
        metadata={null}
        responding={false}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    // No initial model → confirm disabled until user picks one.
    const confirmBtn = screen.getByTestId("orchestration-model-selection-confirm") as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);
    fireEvent.click(screen.getByTestId("mock-pick-claude-sonnet"));
    fireEvent.click(confirmBtn);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm.mock.calls[0]![0].modelId).toBe("claude-sonnet-4-6");
  });
});
