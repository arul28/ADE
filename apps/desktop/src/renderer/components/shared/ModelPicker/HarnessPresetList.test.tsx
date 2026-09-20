/* @vitest-environment jsdom */

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelPickerContent } from "./ModelPickerContent";
import { useAppStore } from "../../../state/appStore";
import {
  HARNESS_PRESET_SUBAGENT_INHERIT,
  type HarnessPreset,
} from "../../../../shared/harnessPresets";
import { MODEL_REGISTRY } from "../../../../shared/modelRegistry";

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (options: { count: number; estimateSize: () => number; getItemKey?: (index: number) => string | number }) => {
    const size = options.estimateSize();
    return {
      getTotalSize: () => options.count * size,
      getVirtualItems: () =>
        Array.from({ length: Math.min(options.count, 20) }, (_, index) => ({
          index,
          key: options.getItemKey?.(index) ?? index,
          start: index * size,
          size,
        })),
      measureElement: vi.fn(),
      scrollToIndex: vi.fn(),
    };
  },
}));

function preset(overrides: Partial<HarnessPreset> = {}): HarnessPreset {
  return {
    id: "hp_1",
    name: "Opus on work",
    harness: "claude",
    source: { kind: "account", provider: "claude", instanceId: "claude-work" },
    model: "anthropic/claude-opus-5",
    subagentModel: HARNESS_PRESET_SUBAGENT_INHERIT,
    agentOverrides: {},
    permissionMode: "plan",
    accentColor: "#d97757",
    logo: { kind: "ade" },
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
    ...overrides,
  };
}

function setPresets(presets: HarnessPreset[]) {
  act(() => {
    useAppStore.getState().setHarnessPresets(presets);
  });
}

function renderPicker(onSelect = vi.fn()) {
  const result = render(
    <ModelPickerContent
      value="anthropic/claude-haiku-4-5"
      models={MODEL_REGISTRY.filter((model) => model.family === "anthropic")}
      isAvailable={() => true}
      onSelect={onSelect}
      onRequestClose={() => undefined}
    />,
  );
  return { ...result, onSelect };
}

function openHarnessesTab() {
  fireEvent.click(screen.getByRole("tab", { name: "Custom" }));
}

beforeEach(() => {
  setPresets([]);
});

afterEach(() => {
  cleanup();
  setPresets([]);
  vi.restoreAllMocks();
});

describe("model picker custom tab", () => {
  it("puts Custom above Favorites and Recents in the rail", () => {
    renderPicker();
    const rail = document.querySelector('[data-model-picker-rail="true"]') as HTMLElement;
    const labels = Array.from(rail.querySelectorAll('[role="tab"]')).map((node) => node.getAttribute("aria-label"));
    expect(labels.slice(0, 3)).toEqual(["Custom", "Favorites", "Recents"]);
  });

  /**
   * The rail's own mark, not the app's. The tab used to wear the ADE logo,
   * which read as "ADE the product" beside nine vendor marks.
   */
  it("marks the Custom tab with the Custom mark, at the provider logos' size", () => {
    renderPicker();
    const tab = screen.getByRole("tab", { name: "Custom" });
    const mark = tab.querySelector("[data-custom-mark]");
    expect(mark).toBeTruthy();
    expect(mark!.getAttribute("width")).toBe("18");
  });

  /** Same shape as a provider's model row: mark, name, a chip, one subtitle. */
  it("shows one row per preset, drawn like a model row", () => {
    setPresets([preset(), preset({ id: "hp_2", name: "Haiku sweeps", model: "anthropic/claude-haiku-4-5" })]);
    renderPicker();
    openHarnessesTab();

    expect(screen.getByText("Opus on work")).toBeTruthy();
    expect(screen.getByText("Haiku sweeps")).toBeTruthy();
    const row = document.querySelector('[data-harness-preset-row="hp_1"]') as HTMLElement;
    // The agent is a chip beside the name; the model is the subtitle. Neither
    // is the old "Claude Code · Claude Opus 5" run-on string.
    expect(row.textContent).toContain("Claude Code");
    expect(row.textContent).toContain("Claude Opus 5");
    expect(screen.queryByText("Claude Code · Claude Opus 5")).toBeNull();
  });

  it("keeps the preset's details behind the arrow until it is opened", () => {
    setPresets([preset({ subagentModel: "anthropic/claude-haiku-4-5", agentOverrides: { explore: "anthropic/claude-haiku-4-5" } })]);
    renderPicker();
    openHarnessesTab();

    expect(document.querySelector('[data-harness-preset-details="hp_1"]')).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Show details for Opus on work/ }));

    const details = document.querySelector('[data-harness-preset-details="hp_1"]') as HTMLElement;
    expect(details.textContent).toContain("Claude Code account");
    expect(details.textContent).toContain("Claude Haiku 4.5");
    expect(details.textContent).toContain("Explore: Claude Haiku 4.5");
    expect(details.textContent).toContain("Plan mode");
    // Labelled and logo-carrying, not a plain-text dump: each model line names
    // the role it plays and carries the mark of whose model it is.
    expect(details.querySelector('[data-preset-agent="claude"]')).toBeTruthy();
    expect(details.querySelector('[data-preset-model="main"]')?.textContent).toContain("Main");
    expect(details.querySelector('[data-preset-model="subagents"]')?.textContent).toContain("Subagents");
  });

  it("returns the preset id alongside the model when a row is chosen", () => {
    setPresets([preset()]);
    const { onSelect } = renderPicker();
    openHarnessesTab();

    fireEvent.click(screen.getByRole("option", { name: /Opus on work/ }));
    expect(onSelect).toHaveBeenCalledWith("anthropic/claude-opus-5", { fastMode: false, presetId: "hp_1" });
  });

  it("filters presets by name as you search", () => {
    setPresets([preset(), preset({ id: "hp_2", name: "Haiku sweeps", model: "anthropic/claude-haiku-4-5" })]);
    renderPicker();
    openHarnessesTab();

    fireEvent.change(screen.getByLabelText("Search custom setups"), { target: { value: "sweeps" } });
    expect(screen.queryByText("Opus on work")).toBeNull();
    expect(screen.getByText("Haiku sweeps")).toBeTruthy();
  });

  it("names the account a preset launches on, like the settings table does", async () => {
    (window as unknown as { ade?: unknown }).ade = {
      providerInstances: {
        list: async () => [
          { id: "claude-work", provider: "claude", label: "Work", isDefault: true, signedIn: true },
        ],
      },
    };
    setPresets([preset()]);
    renderPicker();
    openHarnessesTab();
    fireEvent.click(screen.getByRole("button", { name: /Show details for Opus on work/ }));

    const details = document.querySelector('[data-harness-preset-details="hp_1"]') as HTMLElement;
    await waitFor(() => expect(details.textContent).toContain("Claude Code account · Work"));
    delete (window as unknown as { ade?: unknown }).ade;
  });

  it("hides the model catalog's auth filter on a tab that lists no models", () => {
    setPresets([preset()]);
    renderPicker();
    expect(document.querySelector('[data-model-picker-auth-toggle="true"]')).not.toBeNull();
    openHarnessesTab();
    expect(document.querySelector('[data-model-picker-auth-toggle="true"]')).toBeNull();
    expect(screen.getByRole("listbox").getAttribute("aria-label")).toBe("Custom");
  });

  it("walks preset rows with the arrow keys and opens details with ArrowRight", () => {
    setPresets([preset(), preset({ id: "hp_2", name: "Haiku sweeps", model: "anthropic/claude-haiku-4-5" })]);
    renderPicker();
    openHarnessesTab();

    const list = screen.getByRole("listbox");
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(document.activeElement?.getAttribute("data-harness-preset-select")).toBe("hp_1");
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(document.activeElement?.getAttribute("data-harness-preset-select")).toBe("hp_2");
    fireEvent.keyDown(list, { key: "ArrowUp" });
    expect(document.activeElement?.getAttribute("data-harness-preset-select")).toBe("hp_1");

    expect(document.querySelector('[data-harness-preset-details="hp_1"]')).toBeNull();
    fireEvent.keyDown(list, { key: "ArrowRight" });
    expect(document.querySelector('[data-harness-preset-details="hp_1"]')).not.toBeNull();
    fireEvent.keyDown(list, { key: "ArrowLeft" });
    expect(document.querySelector('[data-harness-preset-details="hp_1"]')).toBeNull();
  });

  it("points an empty list at the settings page that fills it", () => {
    renderPicker();
    openHarnessesTab();
    expect(screen.getByText("Nothing custom yet")).toBeTruthy();
    expect(screen.getByText("Settings › Providers › Custom")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add a custom setup" })).toBeNull();
  });

  /**
   * The CTA existed but nothing ever passed a handler, so the empty state
   * always degraded to inert breadcrumb text.
   */
  it("offers Add a custom setup when the host can navigate, and calls back on click", () => {
    const onOpenHarnessSettings = vi.fn();
    render(
      <ModelPickerContent
        value="anthropic/claude-haiku-4-5"
        models={MODEL_REGISTRY.filter((model) => model.family === "anthropic")}
        isAvailable={() => true}
        onSelect={vi.fn()}
        onRequestClose={() => undefined}
        onOpenHarnessSettings={onOpenHarnessSettings}
      />,
    );
    openHarnessesTab();

    const cta = screen.getByRole("button", { name: "Add a custom setup" });
    expect(screen.queryByText("Settings › Providers › Custom")).toBeNull();
    // The guidance sentence stays, under the button.
    const empty = document.querySelector("[data-harness-preset-empty]") as HTMLElement;
    const order = Array.from(empty.children).map((node) => node.textContent);
    expect(order.indexOf("Add a custom setup"))
      .toBeLessThan(order.findIndex((text) => text?.startsWith("Save an agent")));

    fireEvent.click(cta);
    expect(onOpenHarnessSettings).toHaveBeenCalledTimes(1);
  });
});
