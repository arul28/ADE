/* @vitest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UnifiedModelSelector } from "./UnifiedModelSelector";

describe("UnifiedModelSelector", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders runtime-discovered local models from available ids", async () => {
    const onChange = vi.fn();
    render(
      <UnifiedModelSelector
        value="ollama/qwen2.5-coder:32b"
        onChange={onChange}
        availableModelIds={["ollama/qwen2.5-coder:32b"]}
      />,
    );

    fireEvent.click(screen.getByLabelText("Select model"));

    await waitFor(() => {
      expect(screen.getByRole("listbox")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /Local/i }));

    expect(screen.getByRole("option", { name: /qwen2\.5-coder:32b/i })).toBeTruthy();
  });

  it("filters models with the built-in search field", async () => {
    render(
      <UnifiedModelSelector
        value="openai/gpt-5.4-codex"
        onChange={() => {}}
        availableModelIds={["openai/gpt-5.4-codex", "anthropic/claude-sonnet-4-6"]}
      />,
    );

    fireEvent.click(screen.getByLabelText("Select model"));

    await waitFor(() => {
      expect(screen.getByRole("listbox")).toBeTruthy();
    });

    fireEvent.change(screen.getByPlaceholderText("Search models, ids, aliases..."), {
      target: { value: "sonnet" },
    });

    expect(screen.getByRole("option", { name: /Claude Sonnet 4\.6/i })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /GPT-5\.4 Codex/i })).toBeNull();
  });
});
