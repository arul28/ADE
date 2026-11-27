/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";

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
    GithubCopilot: brand(),
    Google: brand(),
    Grok: brand(),
    Groq: brand(),
    Kimi: brand(),
    LmStudio: brand(),
    Ollama: brand(),
    OpenAI: brand(),
    OpenCode: brand(),
    OpenRouter: brand(),
    Qwen: brand(),
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

const ANTHROPIC_MODEL_ID = "anthropic/claude-sonnet-5";
const OPENCODE_MODEL_ID = "opencode/some-model-without-reasoning";

beforeEach(() => {
  for (const key of Object.keys(reasoningByFamilyStore)) delete reasoningByFamilyStore[key];
  resetRuntimeCatalogDescriptorCacheForTests();
});

afterEach(() => {
  cleanup();
});

describe("ReasoningEffortPicker", () => {
  it("rolls the effort label in the change direction", async () => {
    const user = userEvent.setup();
    function ControlledPicker() {
      const [effort, setEffort] = useState<string | null>("medium");
      return (
        <ReasoningEffortPicker
          modelId={ANTHROPIC_MODEL_ID}
          reasoningEffort={effort}
          onChange={setEffort}
        />
      );
    }

    const { container } = render(<ControlledPicker />);
    const trigger = screen.getByRole("button", { name: /Reasoning effort/i });
    await user.click(trigger);

    const effortLabel = () => container.ownerDocument.querySelector<HTMLElement>(".ade-reasoning-effort-word");
    expect(effortLabel()?.getAttribute("data-direction")).toBe("idle");

    await user.click(screen.getByRole("radio", { name: "High" }));
    expect(effortLabel()?.textContent).toBe("High");
    expect(effortLabel()?.getAttribute("data-direction")).toBe("up");

    await user.click(screen.getByRole("radio", { name: "Low" }));
    expect(effortLabel()?.textContent).toBe("Low");
    expect(effortLabel()?.getAttribute("data-direction")).toBe("down");
  });

  it.each<[string, string]>([
    ["the model has no reasoning tiers", OPENCODE_MODEL_ID],
    ["there is no model", ""],
  ])("renders nothing when %s", (_label, modelId) => {
    const { container } = render(
      <ReasoningEffortPicker modelId={modelId} reasoningEffort={null} onChange={vi.fn()} />,
    );
    expect(container.querySelector('[data-reasoning-effort-picker-trigger="true"]')).toBeNull();
  });

  // The trigger shows the effort a send would use: the chat's own, else the
  // family's remembered one, clamped to what the model offers.
  it.each<[string, string, string | null, string | null, string]>([
    ["the chat's own effort", ANTHROPIC_MODEL_ID, "high", null, "High"],
    ["the family-remembered effort when the chat has none", ANTHROPIC_MODEL_ID, null, "medium", "Med"],
    ["a remembered Ultra clamped on a model without it (Luna)", "openai/gpt-5.6-luna", null, "ultra", "Med"],
  ])("shows %s on the trigger", (_label, modelId, reasoningEffort, remembered, chip) => {
    if (remembered) reasoningByFamilyStore[modelId.split("/")[0]!] = remembered;
    render(<ReasoningEffortPicker modelId={modelId} reasoningEffort={reasoningEffort} onChange={vi.fn()} />);
    expect(within(screen.getByRole("button", { name: /Reasoning effort/i })).getAllByText(chip, { exact: true }).length).toBeGreaterThan(0);
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

    expect(within(screen.getByRole("button", { name: /Reasoning effort/i })).getAllByText("Max", { exact: true }).length).toBeGreaterThan(0);
  });

  it("renders the GPT-5.6 Ultra tier with a multi-agent usage warning", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <ReasoningEffortPicker
        modelId="openai/gpt-5.6-sol"
        reasoningEffort="ultra"
        onChange={vi.fn()}
      />,
    );

    const trigger = screen.getByRole("button", { name: /Reasoning effort/i });
    expect(within(trigger).getAllByText("Ultra", { exact: true }).length).toBeGreaterThan(0);
    await user.click(trigger);

    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(6);
    expect(radios.map((radio) => radio.getAttribute("aria-label"))).toEqual([
      "Light",
      "Medium",
      "High",
      "Extra High",
      "Max",
      "Ultra",
    ]);
    expect(screen.getByRole("radio", { name: "Light" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Ultra" })).toBeTruthy();
    expect(screen.getByText(/automatically delegates work across multiple agents/i)).toBeTruthy();
    expect(trigger.getAttribute("data-reasoning-ultra")).toBe("true");
    expect(container.querySelector(".ade-reasoning-effort-trigger-ultra")).toBeTruthy();
    expect(screen.getByText(/automatically delegates work across multiple agents/i).getAttribute("data-reasoning-ultra-warning")).toBe("true");
  });

  it("gives Claude Ultracode the top-tier visual treatment and workflow warning", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <ReasoningEffortPicker
        modelId="anthropic/claude-fable-5-1"
        reasoningEffort="ultracode"
        onChange={vi.fn()}
      />,
    );

    const trigger = screen.getByRole("button", { name: /Reasoning effort/i });
    expect(within(trigger).getAllByText("Ultra", { exact: true }).length).toBeGreaterThan(0);
    expect(trigger.getAttribute("data-reasoning-ultra")).toBe("true");
    expect(container.querySelector(".ade-reasoning-effort-trigger-ultra")).toBeTruthy();

    await user.click(trigger);

    expect(screen.getByRole("radio", { name: "Ultracode" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText(/automatically delegates work across multiple agents/i)).toBeTruthy();
    expect(screen.getByText(/automatically delegates work across multiple agents/i).getAttribute("data-reasoning-ultra-warning")).toBe("true");
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
    const trigger = screen.getByRole("button", { name: /Reasoning effort/i });
    await user.click(trigger);

    const radios = screen.getAllByRole("radio");
    const high = radios.find((el) => el.textContent?.includes("High"));
    expect(high).toBeTruthy();
    await user.click(high!);

    expect(onChange).toHaveBeenCalledWith("high");
    expect(reasoningByFamilyStore.anthropic).toBe("high");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    await user.keyboard("{Escape}");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("previews pointer movement smoothly, captures the drag, and snaps once on release", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { container } = render(
      <ReasoningEffortPicker
        modelId="openai/gpt-5.6-sol"
        reasoningEffort="medium"
        onChange={onChange}
      />,
    );
    const trigger = screen.getByRole("button", { name: /Reasoning effort/i });
    await user.click(trigger);

    const track = container.ownerDocument.querySelector<HTMLElement>("[data-reasoning-slider-track]");
    expect(track).toBeTruthy();
    Object.defineProperty(track!, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        left: 100,
        right: 300,
        top: 0,
        bottom: 18,
        width: 200,
        height: 18,
        x: 100,
        y: 0,
        toJSON: () => ({}),
      }),
    });
    const setPointerCapture = vi.fn();
    const releasePointerCapture = vi.fn();
    Object.defineProperties(track!, {
      setPointerCapture: { configurable: true, value: setPointerCapture },
      hasPointerCapture: { configurable: true, value: vi.fn(() => true) },
      releasePointerCapture: { configurable: true, value: releasePointerCapture },
    });
    const firePointer = (type: "pointerdown" | "pointermove" | "pointerup", clientX: number) => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX });
      Object.defineProperty(event, "pointerId", { value: 7 });
      fireEvent(track!, event);
    };

    firePointer("pointerdown", 120);
    expect(setPointerCapture).toHaveBeenCalledWith(7);
    firePointer("pointermove", 236);

    expect(track!.getAttribute("data-dragging")).toBe("true");
    expect(onChange).not.toHaveBeenCalled();

    firePointer("pointerup", 236);

    expect(track!.hasAttribute("data-dragging")).toBe(false);
    expect(releasePointerCapture).toHaveBeenCalledWith(7);
    expect(onChange).toHaveBeenCalledTimes(1);
    // Six equal segments over a 200px track: 136px in (68%) is the fifth, "max".
    expect(onChange).toHaveBeenCalledWith("max");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });

  it("drags from the current thumb tick without a trailing click toggling it", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { container } = render(
      <ReasoningEffortPicker
        modelId="openai/gpt-5.6-sol"
        reasoningEffort="medium"
        onChange={onChange}
      />,
    );
    const trigger = screen.getByRole("button", { name: /Reasoning effort/i });
    await user.click(trigger);

    const track = container.ownerDocument.querySelector<HTMLElement>("[data-reasoning-slider-track]");
    const currentTick = screen.getByRole("radio", { name: "Medium" });
    expect(track).toBeTruthy();
    Object.defineProperty(track!, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        left: 100,
        right: 300,
        top: 0,
        bottom: 18,
        width: 200,
        height: 18,
        x: 100,
        y: 0,
        toJSON: () => ({}),
      }),
    });
    const setPointerCapture = vi.fn();
    Object.defineProperties(track!, {
      setPointerCapture: { configurable: true, value: setPointerCapture },
      hasPointerCapture: { configurable: true, value: vi.fn(() => true) },
      releasePointerCapture: { configurable: true, value: vi.fn() },
    });
    const firePointer = (target: Element, type: "pointerdown" | "pointermove" | "pointerup", clientX: number) => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX });
      Object.defineProperty(event, "pointerId", { value: 8 });
      fireEvent(target, event);
    };

    firePointer(currentTick, "pointerdown", 150);
    expect(setPointerCapture).not.toHaveBeenCalled();
    firePointer(track!, "pointermove", 236);
    expect(setPointerCapture).toHaveBeenCalledWith(8);
    firePointer(track!, "pointerup", 236);
    fireEvent.click(currentTick);

    expect(onChange).toHaveBeenCalledTimes(1);
    // Six equal segments over a 200px track: 136px in (68%) is the fifth, "max".
    expect(onChange).toHaveBeenCalledWith("max");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps keyboard tier changes open", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ReasoningEffortPicker
        modelId={ANTHROPIC_MODEL_ID}
        reasoningEffort="medium"
        onChange={onChange}
      />,
    );
    const trigger = screen.getByRole("button", { name: /Reasoning effort/i });
    await user.click(trigger);
    const active = screen.getAllByRole("radio").find((radio) => radio.getAttribute("aria-checked") === "true");
    expect(active).toBeTruthy();

    fireEvent.keyDown(active!, { key: "ArrowRight" });

    expect(onChange).toHaveBeenCalledWith("high");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
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
    expect(within(trigger).getAllByText("Auto", { exact: true }).length).toBeGreaterThan(0);

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
