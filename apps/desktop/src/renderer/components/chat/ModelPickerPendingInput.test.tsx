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
    suggested: {
      provider: "claude",
      modelId: "claude-sonnet-4-6",
      reasoningEffort: "high",
    },
  };

  it("renders the ModelPicker with the suggested initial model + reasoning", () => {
    render(
      <ChatModelSelectionPendingCard
        metadata={metadata}
        suggested={metadata.suggested!}
        responding={false}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByTestId("orchestration-model-selection-pending-card")).toBeTruthy();
    expect(screen.getByTestId("mock-model-picker").getAttribute("data-current-model"))
      .toBe("claude-sonnet-4-6");
    expect(screen.getByTestId("mock-reasoning-picker").getAttribute("data-current-reasoning"))
      .toBe("high");
  });

  it("calls onConfirm with the resolved ModelSelection on Confirm", () => {
    const onConfirm = vi.fn<[selection: ModelSelection], void>();
    render(
      <ChatModelSelectionPendingCard
        metadata={metadata}
        suggested={metadata.suggested!}
        responding={false}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    // User keeps suggested model, bumps reasoning to xhigh.
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
        suggested={metadata.suggested!}
        responding={false}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("mock-pick-claude-opus"));
    fireEvent.click(screen.getByTestId("orchestration-model-selection-confirm"));
    const args = onConfirm.mock.calls[0]![0];
    expect(args.modelId).toBe("opus[1m]");
    // Both opus[1m] and claude-sonnet-4-6 are claude-family — provider stays "claude".
    expect(args.provider).toBe("claude");
  });

  it("Cancel triggers onCancel", () => {
    const onCancel = vi.fn();
    render(
      <ChatModelSelectionPendingCard
        metadata={metadata}
        suggested={metadata.suggested!}
        responding={false}
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );
    // Buttons rendered by the card include "Cancel" — find by text since
    // the Cancel button is just a normal button.
    const cancelBtn = screen.getByRole("button", { name: "Cancel" });
    fireEvent.click(cancelBtn);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("disables the Confirm button while responding", () => {
    render(
      <ChatModelSelectionPendingCard
        metadata={metadata}
        suggested={metadata.suggested!}
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
