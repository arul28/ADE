/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReviewLaunchModelControls } from "./ReviewLaunchModelControls";

vi.mock("./ModelPicker/ModelPicker", () => ({
  ModelPicker: ({ onChange }: { onChange: (modelId: string) => void }) => (
    <button type="button" onClick={() => onChange("openai/gpt-5.6-luna")}>Pick Luna</button>
  ),
}));

vi.mock("./ModelPicker/ReasoningEffortPicker", () => ({
  ReasoningEffortPicker: ({ reasoningEffort }: { reasoningEffort: string | null }) => (
    <span data-testid="effort">{reasoningEffort}</span>
  ),
}));

afterEach(() => {
  cleanup();
  delete (window as unknown as { ade?: unknown }).ade;
});

describe("ReviewLaunchModelControls", () => {
  it("clamps Sol Ultra to Luna's medium default when the model changes", () => {
    (window as unknown as { ade: unknown }).ade = {
      ai: { getStatus: vi.fn().mockResolvedValue(null) },
    };
    const onModelChange = vi.fn();
    const onReasoningEffortChange = vi.fn();
    render(
      <ReviewLaunchModelControls
        modelId="openai/gpt-5.6-sol"
        reasoningEffort="ultra"
        onModelChange={onModelChange}
        onReasoningEffortChange={onReasoningEffortChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Pick Luna" }));

    expect(onModelChange).toHaveBeenCalledTimes(1);
    expect(onModelChange).toHaveBeenCalledWith("openai/gpt-5.6-luna");
    expect(onReasoningEffortChange).toHaveBeenCalledTimes(1);
    expect(onReasoningEffortChange).toHaveBeenCalledWith("medium");
  });
});
