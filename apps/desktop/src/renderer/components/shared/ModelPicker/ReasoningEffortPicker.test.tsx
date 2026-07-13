/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

  it("renders the GPT-5.6 Ultra tier with a multi-agent usage warning", async () => {
    const user = userEvent.setup();
    render(
      <ReasoningEffortPicker
        modelId="openai/gpt-5.6-sol"
        reasoningEffort="ultra"
        onChange={vi.fn()}
      />,
    );

    const trigger = screen.getByRole("button", { name: /Reasoning effort/i });
    expect(trigger.textContent).toContain("ULTRA");
    await user.click(trigger);

    expect(screen.getAllByRole("radio")).toHaveLength(6);
    expect(screen.getByRole("radio", { name: "Max" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Light" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Ultra" })).toBeTruthy();
    expect(screen.getByText(/automatically delegates work to multiple agents/i)).toBeTruthy();
  });

  it("labels GPT-5.6 low effort as Light", () => {
    render(
      <ReasoningEffortPicker
        modelId="openai/gpt-5.6-sol"
        reasoningEffort="low"
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: /Reasoning effort/i }).textContent).toContain("LIGHT");
  });

  it("clamps a remembered Ultra effort when switching to Luna", () => {
    reasoningByFamilyStore.openai = "ultra";
    render(
      <ReasoningEffortPicker
        modelId="openai/gpt-5.6-luna"
        reasoningEffort={null}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: /Reasoning effort/i }).textContent).toContain("MED");
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
    expect(track!.style.getPropertyValue("--reasoning-slider-thumb-position")).toContain("68%");
    expect(onChange).not.toHaveBeenCalled();

    firePointer("pointerup", 236);

    expect(track!.hasAttribute("data-dragging")).toBe(false);
    expect(track!.style.getPropertyValue("--reasoning-slider-thumb-position")).toContain("60%");
    expect(releasePointerCapture).toHaveBeenCalledWith(7);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("xhigh");
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
    expect(onChange).toHaveBeenCalledWith("xhigh");
    expect(track!.style.getPropertyValue("--reasoning-slider-thumb-position")).toContain("60%");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });

  it("uses the complete tier palette as a progressive fill gradient", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <ReasoningEffortPicker
        modelId="openai/gpt-5.6-sol"
        reasoningEffort="ultra"
        onChange={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: /Reasoning effort/i }));

    const track = container.ownerDocument.querySelector<HTMLElement>("[data-reasoning-slider-track]");
    const fill = container.ownerDocument.querySelector<HTMLElement>("[data-reasoning-slider-fill]");
    const gradient = track?.style.getPropertyValue("--reasoning-progressive-gradient") ?? "";
    expect(gradient).toContain("linear-gradient");
    expect(gradient).toContain("52 211 153");
    expect(gradient).toContain("34 211 238");
    expect(gradient).toContain("96 165 250");
    expect(gradient).toContain("167 139 250");
    expect(gradient).toContain("192 132 252");
    expect(fill?.className).toContain("ade-reasoning-slider-fill-max");
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
