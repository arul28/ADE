/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@lobehub/icons", () => {
  const brand = () => {
    const Component = () => null;
    Object.assign(Component, {
      Avatar: () => null,
      Color: () => null,
      Combine: () => null,
      Text: () => null,
      colorPrimary: "#888",
      title: "stub",
    });
    return Component;
  };
  return {
    Anthropic: brand(),
    Claude: brand(),
    Codex: brand(),
    Cursor: brand(),
    Gemini: brand(),
    Google: brand(),
    Grok: brand(),
    Groq: brand(),
    Kimi: brand(),
    LmStudio: brand(),
    Ollama: brand(),
    OpenAI: brand(),
    OpenCode: brand(),
    OpenRouter: brand(),
    XAI: brand(),
  };
});

const reasoningByFamilyStore: Record<string, string> = {};

vi.mock("./useReasoningByFamily", () => ({
  useReasoningByFamily: () => ({
    byFamily: { ...reasoningByFamilyStore },
    rememberReasoning: (family: string, effort: string | null) => {
      if (effort == null || effort.length === 0) {
        delete reasoningByFamilyStore[family];
      } else {
        reasoningByFamilyStore[family] = effort;
      }
    },
    getReasoningForFamily: (family: string) => reasoningByFamilyStore[family] ?? null,
  }),
}));

import { ReasoningEffortPicker } from "./ReasoningEffortPicker";
import {
  descriptorsFromAgentChatModelCatalog,
  resetRuntimeCatalogDescriptorCacheForTests,
} from "./modelCatalog";
import type { AgentChatModelCatalog } from "../../../../shared/types";

const ANTHROPIC_MODEL_ID = "anthropic/claude-sonnet-4-6";
const OPENCODE_MODEL_ID = "opencode/some-model-without-reasoning";

beforeEach(() => {
  for (const key of Object.keys(reasoningByFamilyStore)) delete reasoningByFamilyStore[key];
  resetRuntimeCatalogDescriptorCacheForTests();
});

afterEach(() => {
  cleanup();
});

describe("ReasoningEffortPicker", () => {
  it("renders nothing when the model has no reasoning tiers", () => {
    const { container } = render(
      <ReasoningEffortPicker
        modelId={OPENCODE_MODEL_ID}
        reasoningEffort={null}
        onChange={vi.fn()}
      />,
    );
    expect(container.querySelector('[data-reasoning-effort-picker-trigger="true"]')).toBeNull();
  });

  it("renders nothing when modelId is empty", () => {
    const { container } = render(
      <ReasoningEffortPicker
        modelId=""
        reasoningEffort={null}
        onChange={vi.fn()}
      />,
    );
    expect(container.querySelector('[data-reasoning-effort-picker-trigger="true"]')).toBeNull();
  });

  it("shows the current effort as a chip on the trigger", () => {
    render(
      <ReasoningEffortPicker
        modelId={ANTHROPIC_MODEL_ID}
        reasoningEffort="high"
        onChange={vi.fn()}
      />,
    );
    const trigger = screen.getByRole("button", { name: /Reasoning effort/i });
    expect(trigger.textContent).toContain("HI");
  });

  it("falls back to the family-remembered effort when none is provided", () => {
    reasoningByFamilyStore.anthropic = "medium";
    render(
      <ReasoningEffortPicker
        modelId={ANTHROPIC_MODEL_ID}
        reasoningEffort={null}
        onChange={vi.fn()}
      />,
    );
    const trigger = screen.getByRole("button", { name: /Reasoning effort/i });
    expect(trigger.textContent).toContain("MED");
  });

  it("opens the popover and lists the model's reasoning tiers on click", async () => {
    const user = userEvent.setup();
    render(
      <ReasoningEffortPicker
        modelId={ANTHROPIC_MODEL_ID}
        reasoningEffort="medium"
        onChange={vi.fn()}
      />,
    );
    const trigger = screen.getByRole("button", { name: /Reasoning effort/i });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    await user.click(trigger);

    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const group = screen.getByRole("radiogroup", { name: /Reasoning effort/i });
    expect(group).toBeTruthy();
    const radios = screen.getAllByRole("radio");
    expect(radios.length).toBeGreaterThan(0);
  });

  it("uses cached runtime catalog reasoning tiers for dynamic runtime models", () => {
    const catalog: AgentChatModelCatalog = {
      fetchedAt: new Date().toISOString(),
      groups: [
        {
          key: "droid",
          displayName: "Droid",
          providers: [
            {
              key: "factory",
              displayName: "Factory",
              badgeColor: "#60A5FA",
              modelCount: 1,
              subsections: [
                {
                  key: "factory",
                  label: "Factory",
                  models: [
                    {
                      id: "droid/gpt-5.4",
                      runtimeModelId: "droid/gpt-5.4",
                      provider: "droid",
                      providerKey: "factory",
                      groupKey: "droid",
                      displayName: "GPT-5.4",
                      isDefault: true,
                      isAvailable: true,
                      reasoningEfforts: [{ effort: "max", description: "Max" }],
                      supportsReasoning: true,
                      supportsTools: true,
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    descriptorsFromAgentChatModelCatalog(catalog);

    render(
      <ReasoningEffortPicker
        modelId="droid/gpt-5.4"
        reasoningEffort="max"
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: /Reasoning effort/i }).textContent).toContain("MAX");
  });

  it("calls onChange and persists the tier when a tier is selected", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ReasoningEffortPicker
        modelId={ANTHROPIC_MODEL_ID}
        reasoningEffort="low"
        onChange={onChange}
      />,
    );
    await user.click(screen.getByRole("button", { name: /Reasoning effort/i }));

    const radios = screen.getAllByRole("radio");
    const high = radios.find((el) => el.textContent?.includes("High"));
    expect(high).toBeTruthy();
    await user.click(high!);

    expect(onChange).toHaveBeenCalledWith("high");
    expect(reasoningByFamilyStore.anthropic).toBe("high");
  });

  it("clears the effort when the active tier is clicked again", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    reasoningByFamilyStore.anthropic = "medium";
    render(
      <ReasoningEffortPicker
        modelId={ANTHROPIC_MODEL_ID}
        reasoningEffort="medium"
        onChange={onChange}
      />,
    );
    await user.click(screen.getByRole("button", { name: /Reasoning effort/i }));
    const radios = screen.getAllByRole("radio");
    const medium = radios.find((el) => el.getAttribute("aria-checked") === "true");
    expect(medium).toBeTruthy();
    await user.click(medium!);
    expect(onChange).toHaveBeenCalledWith(null);
    expect(reasoningByFamilyStore.anthropic).toBeUndefined();
  });

  it("does not open the popover when disabled", async () => {
    const user = userEvent.setup();
    render(
      <ReasoningEffortPicker
        modelId={ANTHROPIC_MODEL_ID}
        reasoningEffort="medium"
        onChange={vi.fn()}
        disabled
      />,
    );
    const trigger = screen.getByRole("button", { name: /Reasoning effort/i });
    await user.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("ignores family defaults when useFamilyDefaults is false", async () => {
    reasoningByFamilyStore.anthropic = "high";
    const onChange = vi.fn();
    render(
      <ReasoningEffortPicker
        modelId={ANTHROPIC_MODEL_ID}
        reasoningEffort={null}
        onChange={onChange}
        useFamilyDefaults={false}
      />,
    );
    const trigger = screen.getByRole("button", { name: /Reasoning effort/i });
    expect(trigger.textContent).toContain("AUTO");

    const user = userEvent.setup();
    await user.click(trigger);
    const radios = screen.getAllByRole("radio");
    const low = radios.find((el) => el.textContent?.includes("Low"));
    expect(low).toBeTruthy();
    await user.click(low!);

    expect(onChange).toHaveBeenCalledWith("low");
    expect(reasoningByFamilyStore.anthropic).toBe("high");
  });
});
