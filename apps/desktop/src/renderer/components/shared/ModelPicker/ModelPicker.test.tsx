/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createDynamicCursorCliModelDescriptor,
  createDynamicOpenCodeModelDescriptor,
  type ModelDescriptor,
} from "../../../../shared/modelRegistry";
import type { AgentChatModelCatalog } from "../../../../shared/types";

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

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (options: {
    count: number;
    estimateSize: () => number;
    getItemKey?: (index: number) => string | number;
  }) => {
    const size = options.estimateSize();
    const renderedCount = options.count > 80 ? 36 : options.count;
    return {
      getTotalSize: () => options.count * size,
      getVirtualItems: () => Array.from({ length: renderedCount }, (_, index) => ({
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

const favoriteStore = new Set<string>();
const recentStore: string[] = [];
let authOnlyState = false;
const reasoningByFamilyStore: Record<string, string> = {};
let providerAuthStatusInternal: Record<string, "ok" | "unauthed" | "limited"> = {};
let providerAuthStatusOptions: Array<{ loadStatus?: boolean } | undefined> = [];
let opencodeBinaryInstalledInternal = true;

vi.mock("./useModelFavorites", () => ({
  useModelFavorites: () => ({
    favorites: [...favoriteStore],
    isFavorite: (id: string) => favoriteStore.has(id),
    toggleFavorite: (id: string) => {
      if (favoriteStore.has(id)) favoriteStore.delete(id);
      else favoriteStore.add(id);
    },
  }),
}));

vi.mock("./useModelRecents", () => ({
  useModelRecents: () => ({
    recents: [...recentStore],
    recordUsage: (id: string) => {
      const idx = recentStore.indexOf(id);
      if (idx !== -1) recentStore.splice(idx, 1);
      recentStore.unshift(id);
    },
  }),
}));

vi.mock("./useAuthOnlyFilter", () => ({
  useAuthOnlyFilter: () => ({
    authOnly: authOnlyState,
    toggleAuthOnly: () => {
      authOnlyState = !authOnlyState;
    },
  }),
}));

vi.mock("./usePerSurfaceModelDefaults", () => ({
  usePerSurfaceModelDefaults: () => ({
    defaults: {} as Record<string, string>,
    setDefault: () => {},
    getDefault: () => null,
  }),
}));

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

vi.mock("./useProviderAuthStatus", () => ({
  useProviderAuthStatus: (options?: { loadStatus?: boolean }) => {
    providerAuthStatusOptions.push(options);
    return {
      status: { ...providerAuthStatusInternal },
      opencodeBinaryInstalled: opencodeBinaryInstalledInternal,
      binaryProbed: true,
      loaded: true,
    };
  },
}));

type SearchItem = {
  name: string;
  shortName?: string;
  subProvider?: string;
  family: string;
  providerDisplayName: string;
  isFavorite?: boolean;
};

vi.mock("./modelPickerSearch", () => ({
  scoreModelPickerSearch: (item: SearchItem, query: string): number | null => {
    const q = query.trim().toLowerCase();
    if (!q.length) return 0;
    const hay = `${item.name} ${item.shortName ?? ""} ${item.family}`.toLowerCase();
    return hay.includes(q) ? 0 : null;
  },
}));

vi.mock("./modelOrdering", () => ({
  sortModelItems: <T extends { modelId: string }>(items: T[]): T[] => [...items],
}));

import { composeModelPickerTriggerLabel, ModelPicker } from "./ModelPicker";
import {
  rememberRuntimeCatalog,
  resetModelPickerRuntimeCatalogForTests,
  runtimeCatalogProviderIsFresh,
} from "./runtimeCatalogCache";
import { resetRuntimeCatalogDescriptorCacheForTests } from "./modelCatalog";

const SONNET: ModelDescriptor = {
  id: "anthropic/claude-sonnet-5",
  shortId: "sonnet",
  displayName: "Claude Sonnet 5",
  family: "anthropic",
  authTypes: ["cli-subscription"],
  contextWindow: 200_000,
  maxOutputTokens: 32_000,
  capabilities: { tools: true, vision: true, reasoning: true, streaming: true },
  reasoningTiers: ["low", "medium", "high"],
  color: "#8B5CF6",
  providerRoute: "claude-cli",
  providerModelId: "sonnet",
  cliCommand: "claude",
  isCliWrapped: true,
};

const OPUS: ModelDescriptor = {
  id: "anthropic/claude-opus-4-8",
  shortId: "opus-4.8-1m",
  displayName: "Claude Opus 4.8 1M",
  family: "anthropic",
  authTypes: ["cli-subscription"],
  contextWindow: 1_000_000,
  maxOutputTokens: 128_000,
  capabilities: { tools: true, vision: true, reasoning: true, streaming: true },
  reasoningTiers: ["low", "medium", "high", "xhigh", "max"],
  color: "#D97706",
  providerRoute: "claude-cli",
  providerModelId: "claude-opus-4-8",
  cliCommand: "claude",
  isCliWrapped: true,
};

const GPT: ModelDescriptor = {
  id: "openai/gpt-5.4",
  shortId: "gpt-5.4",
  displayName: "GPT-5.4",
  family: "openai",
  authTypes: ["cli-subscription"],
  contextWindow: 1_000_000,
  maxOutputTokens: 128_000,
  capabilities: { tools: true, vision: true, reasoning: true, streaming: true },
  reasoningTiers: ["low", "medium", "high"],
  color: "#10A37F",
  providerRoute: "codex-cli",
  providerModelId: "gpt-5.4",
  cliCommand: "codex",
  isCliWrapped: true,
};

const FAST_GPT: ModelDescriptor = {
  ...GPT,
  serviceTiers: ["fast"],
};

const FAST_GPT_ALT: ModelDescriptor = {
  ...GPT,
  id: "openai/gpt-5.4-mini",
  shortId: "gpt-5.4-mini",
  displayName: "GPT-5.4 Mini",
  providerModelId: "gpt-5.4-mini",
  serviceTiers: ["fast"],
};

const SLOW_GPT: ModelDescriptor = {
  ...GPT,
  id: "openai/gpt-5.4-thinking",
  shortId: "gpt-5.4-thinking",
  displayName: "GPT-5.4 Thinking",
  providerModelId: "gpt-5.4-thinking",
};

const OPENCODE_MODEL: ModelDescriptor = {
  id: "opencode/anthropic/claude-sonnet-5",
  shortId: "claude-sonnet-5",
  displayName: "Claude Sonnet 5 via OpenCode",
  family: "opencode",
  authTypes: ["api-key"],
  contextWindow: 200_000,
  maxOutputTokens: 32_000,
  capabilities: { tools: true, vision: true, reasoning: true, streaming: true },
  reasoningTiers: ["low", "medium", "high"],
  color: "#D97706",
  providerRoute: "opencode",
  providerModelId: "anthropic/claude-sonnet-5",
  openCodeProviderId: "anthropic",
  openCodeModelId: "claude-sonnet-5",
  isCliWrapped: false,
};

const MODELS: ModelDescriptor[] = [SONNET, OPUS, GPT];

beforeEach(() => {
  favoriteStore.clear();
  recentStore.length = 0;
  authOnlyState = false;
  for (const key of Object.keys(reasoningByFamilyStore)) delete reasoningByFamilyStore[key];
  providerAuthStatusInternal = {};
  providerAuthStatusOptions = [];
  opencodeBinaryInstalledInternal = true;
  resetModelPickerRuntimeCatalogForTests();
  resetRuntimeCatalogDescriptorCacheForTests();
  Object.defineProperty(window, "ade", {
    configurable: true,
    writable: true,
    value: undefined,
  });
});

afterEach(() => {
  cleanup();
});

function renderPicker(overrides: Partial<React.ComponentProps<typeof ModelPicker>> = {}) {
  const onChange = vi.fn();
  const utils = render(
    <ModelPicker
      value={SONNET.id}
      onChange={onChange}
      surfaceKey="test-surface"
      models={MODELS}
      {...overrides}
    />,
  );
  return { ...utils, onChange };
}

// The open picker expands into the full registry, so fast-mode assertions have
// to be scoped to a specific row rather than counted across the list.
async function findModelRow(modelId: string): Promise<HTMLElement> {
  return await waitFor(() => {
    const row = document.querySelector<HTMLElement>(`[data-model-id="${modelId}"]`);
    if (!row) throw new Error(`row not rendered for ${modelId}`);
    return row;
  });
}

describe("composeModelPickerTriggerLabel", () => {
  it("appends Fast only when fast mode is on and the model supports it", () => {
    expect(composeModelPickerTriggerLabel({ model: FAST_GPT, value: FAST_GPT.id, fastMode: true }))
      .toBe(`${FAST_GPT.displayName} Fast`);
    expect(composeModelPickerTriggerLabel({ model: FAST_GPT, value: FAST_GPT.id, fastMode: false }))
      .toBe(FAST_GPT.displayName);
    expect(composeModelPickerTriggerLabel({ model: OPUS, value: OPUS.id, fastMode: true }))
      .toBe(OPUS.displayName);
  });

  it("honours an explicit capability override", () => {
    expect(composeModelPickerTriggerLabel({
      model: OPUS,
      value: OPUS.id,
      fastMode: true,
      fastModeSupported: true,
    })).toBe(`${OPUS.displayName} Fast`);
    expect(composeModelPickerTriggerLabel({
      model: FAST_GPT,
      value: FAST_GPT.id,
      fastMode: true,
      fastModeSupported: false,
    })).toBe(FAST_GPT.displayName);
  });

  it("falls back to the raw value, then to a placeholder, and never suffixes either", () => {
    expect(composeModelPickerTriggerLabel({ model: undefined, value: "vendor/mystery", fastMode: true }))
      .toBe("vendor/mystery");
    expect(composeModelPickerTriggerLabel({ model: undefined, value: "  ", fastMode: true }))
      .toBe("Select model");
  });
});

describe("ModelPicker", () => {
  it("renders the active model on the trigger and opens the popover on click", async () => {
    const user = userEvent.setup();
    renderPicker();

    const trigger = screen.getByRole("button", { name: /Select model/i });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    await user.click(trigger);

    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("listbox", { name: /models/i })).toBeTruthy();
    expect(screen.getAllByRole("option").length).toBeGreaterThan(0);
  });

  it("consumes an open request while disabled without reopening after re-enable", async () => {
    const onOpenRequestHandled = vi.fn();
    const { rerender } = renderPicker({
      disabled: true,
      openRequestKey: 1,
      onOpenRequestHandled,
    });

    await waitFor(() => expect(onOpenRequestHandled).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: /Select model/i }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("listbox", { name: /models/i })).toBeNull();

    rerender(
      <ModelPicker
        value={SONNET.id}
        onChange={vi.fn()}
        surfaceKey="test-surface"
        models={MODELS}
        openRequestKey={undefined}
        onOpenRequestHandled={onOpenRequestHandled}
      />,
    );

    expect(screen.getByRole("button", { name: /Select model/i }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("listbox", { name: /models/i })).toBeNull();
    expect(onOpenRequestHandled).toHaveBeenCalledTimes(1);
  });

  it("respects hidePermissionRail when forwarded", async () => {
    const user = userEvent.setup();
    renderPicker({ hidePermissionRail: true });

    await user.click(screen.getByRole("button", { name: /Select model/i }));

    expect(screen.queryByTestId("model-picker-permission-row")).toBeNull();
  });

  it("closes the popover when Escape is pressed", async () => {
    const user = userEvent.setup();
    renderPicker();

    const trigger = screen.getByRole("button", { name: /Select model/i });
    await user.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    await user.keyboard("{Escape}");

    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("selects a model when its row is clicked", async () => {
    const user = userEvent.setup();
    const { onChange } = renderPicker();

    await user.click(screen.getByRole("button", { name: /Select model/i }));

    const opusRow = screen
      .getAllByRole("option")
      .find((el) => el.getAttribute("data-model-id") === OPUS.id);
    expect(opusRow).toBeDefined();

    await user.click(opusRow!);

    expect(onChange).toHaveBeenCalledWith(OPUS.id);
  });

  it("filters the list by search query", async () => {
    const user = userEvent.setup();
    renderPicker();

    await user.click(screen.getByRole("button", { name: /Select model/i }));

    const input = screen.getByLabelText(/Search models/i) as HTMLInputElement;
    await user.type(input, "opus");

    const visibleIds = screen
      .getAllByRole("option")
      .map((el) => el.getAttribute("data-model-id"));
    expect(visibleIds).toContain(OPUS.id);
    expect(visibleIds).not.toContain(SONNET.id);
  });

  it("filters provided models when constrained to available ids", async () => {
    const user = userEvent.setup();
    renderPicker({
      constrainToAvailableModelIds: true,
      availableModelIds: [SONNET.id],
    });

    await user.click(screen.getByRole("button", { name: /Select model/i }));

    const visibleIds = screen
      .getAllByRole("option")
      .map((el) => el.getAttribute("data-model-id"));
    expect(visibleIds).toContain(SONNET.id);
    expect(visibleIds).not.toContain(OPUS.id);
    expect(visibleIds).not.toContain(GPT.id);
  });

  it("virtualizes large Cursor model catalogs but still searches the full list", async () => {
    const user = userEvent.setup();
    providerAuthStatusInternal = { cursor: "ok" };
    const cursorModels = Array.from({ length: 160 }, (_, index) =>
      createDynamicCursorCliModelDescriptor(
        `cursor-smoke-${index}`,
        `Cursor Smoke Model ${index}`,
        { cursorAvailability: { cli: true, sdk: false } },
      ),
    );
    renderPicker({
      value: cursorModels[0]!.id,
      models: cursorModels,
      availableModelIds: cursorModels.map((model) => model.id),
      constrainToAvailableModelIds: true,
      allowCliOnlyModels: true,
    });

    await user.click(screen.getByRole("button", { name: /Select model/i }));

    const listSizer = document.querySelector('[data-model-picker-virtual-list="true"]') as HTMLDivElement;
    expect(listSizer).toBeTruthy();
    expect(Number.parseFloat(listSizer.style.height)).toBeGreaterThan(6_000);
    expect(screen.getAllByRole("option")).toHaveLength(36);

    await user.type(screen.getByLabelText(/Search models/i), "Model 149");
    const visibleIds = screen
      .getAllByRole("option")
      .map((el) => el.getAttribute("data-model-id"));
    expect(visibleIds).toEqual([cursorModels[149]!.id]);
  });

  it("filters Cursor rows by the current picker mode", async () => {
    const user = userEvent.setup();
    providerAuthStatusInternal = { cursor: "ok" };
    const cliOnly = createDynamicCursorCliModelDescriptor("cli-only", "Cursor CLI Only", {
      cursorAvailability: { cli: true, sdk: false },
    });
    const chatOnly = createDynamicCursorCliModelDescriptor("chat-only", "Cursor Chat Only", {
      cursorAvailability: { cli: false, sdk: true },
    });
    const both = createDynamicCursorCliModelDescriptor("both", "Cursor Both", {
      cursorAvailability: { cli: true, sdk: true },
    });
    const onOpenSignIn = vi.fn();
    const { onChange } = renderPicker({
      value: both.id,
      models: [cliOnly, chatOnly, both],
      availableModelIds: [both.id],
      allowCliOnlyModels: true,
      onOpenSignIn,
    });

    await user.click(screen.getByRole("button", { name: /Select model/i }));

    expect(screen.queryByText("CLI only")).toBeNull();
    expect(screen.queryByText("Chat only")).toBeNull();
    const visibleIds = screen
      .getAllByRole("option")
      .map((el) => el.getAttribute("data-model-id"));
    expect(visibleIds).toContain(cliOnly.id);
    expect(visibleIds).toContain(both.id);
    expect(visibleIds).not.toContain(chatOnly.id);

    const cliOnlyRow = screen
      .getAllByRole("option")
      .find((el) => el.getAttribute("data-model-id") === cliOnly.id)!;
    await user.click(cliOnlyRow);
    expect(onChange).toHaveBeenCalledWith(cliOnly.id);
    expect(onChange).not.toHaveBeenCalledWith(chatOnly.id);
  });

  it("hides Cursor CLI-only rows from chat picking", async () => {
    const user = userEvent.setup();
    providerAuthStatusInternal = { cursor: "ok" };
    const cliOnly = createDynamicCursorCliModelDescriptor("cli-only", "Cursor CLI Only", {
      cursorAvailability: { cli: true, sdk: false },
    });
    const chatOnly = createDynamicCursorCliModelDescriptor("chat-only", "Cursor Chat Only", {
      cursorAvailability: { cli: false, sdk: true },
    });
    const both = createDynamicCursorCliModelDescriptor("both", "Cursor Both", {
      cursorAvailability: { cli: true, sdk: true },
    });
    renderPicker({
      value: both.id,
      models: [cliOnly, chatOnly, both],
      availableModelIds: [chatOnly.id, both.id],
    });

    await user.click(screen.getByRole("button", { name: /Select model/i }));

    expect(screen.queryByText("CLI only")).toBeNull();
    expect(screen.queryByText("Chat only")).toBeNull();
    const visibleIds = screen
      .getAllByRole("option")
      .map((el) => el.getAttribute("data-model-id"));
    expect(visibleIds).toContain(chatOnly.id);
    expect(visibleIds).toContain(both.id);
    expect(visibleIds).not.toContain(cliOnly.id);
  });

  it("toggles favorites when the star button is clicked", async () => {
    const user = userEvent.setup();
    renderPicker();

    await user.click(screen.getByRole("button", { name: /Select model/i }));

    const opusRow = screen
      .getAllByRole("option")
      .find((el) => el.getAttribute("data-model-id") === OPUS.id)!;
    const starButton = opusRow.querySelector("button[aria-pressed]") as HTMLButtonElement;
    expect(starButton).toBeTruthy();
    expect(starButton.getAttribute("aria-pressed")).toBe("false");

    await user.click(starButton);

    expect(favoriteStore.has(OPUS.id)).toBe(true);
  });

  it("does not render popover content when closed", () => {
    renderPicker();
    expect(screen.queryByRole("listbox", { name: /models/i })).toBeNull();
  });

  // Reference act/fireEvent to satisfy "no-unused" linters in the future.
  it("imports act and fireEvent without using them at runtime", () => {
    expect(typeof act).toBe("function");
    expect(typeof fireEvent.click).toBe("function");
  });

  it("shows the model name on the trigger even when compact", () => {
    renderPicker({ compact: true });
    const trigger = screen.getByRole("button", { name: /Select model/i });
    expect(trigger.textContent).toContain(SONNET.displayName);
  });

  it("does not render any reasoning chip on the trigger", () => {
    renderPicker();
    const trigger = screen.getByRole("button", { name: /Select model/i });
    const chip = trigger.querySelector('[data-model-picker-reasoning-chip="true"]');
    expect(chip).toBeNull();
  });

  it("renders a fast affordance only on fast-capable rows, and only when the surface opts in", async () => {
    const user = userEvent.setup();
    const onFastModeChange = vi.fn();
    render(
      <ModelPicker
        value={FAST_GPT.id}
        onChange={vi.fn()}
        surfaceKey="test"
        models={[FAST_GPT, SLOW_GPT]}
        fastMode={false}
        onFastModeChange={onFastModeChange}
      />,
    );
    await user.click(screen.getByRole("button", { name: /Select model/i }));

    const chip = await within(await findModelRow(FAST_GPT.id))
      .findByRole("button", { name: /Fast mode for/i });
    expect(chip.getAttribute("aria-label")).toBe(`Fast mode for ${FAST_GPT.displayName}`);
    expect(chip.getAttribute("aria-pressed")).toBe("false");
    // Same provider rail, no fast service tier — that row stays chip-free.
    expect(
      within(await findModelRow(SLOW_GPT.id)).queryByRole("button", { name: /Fast mode for/i }),
    ).toBeNull();
  });

  it("omits the fast affordance entirely when onFastModeChange is not supplied", async () => {
    const user = userEvent.setup();
    render(
      <ModelPicker
        value={FAST_GPT.id}
        onChange={vi.fn()}
        surfaceKey="test"
        models={[FAST_GPT, SONNET]}
        fastMode
      />,
    );
    await user.click(screen.getByRole("button", { name: /Select model/i }));

    await screen.findAllByRole("option");
    expect(screen.queryByRole("button", { name: /Fast mode for/i })).toBeNull();
    expect(document.querySelector('[data-model-picker-fast-toggle="true"]')).toBeNull();
  });

  it("toggles fast mode without closing the picker or changing the selected model", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const onFastModeChange = vi.fn();
    render(
      <ModelPicker
        value={FAST_GPT.id}
        onChange={onChange}
        surfaceKey="test"
        models={[FAST_GPT, SONNET]}
        fastMode={false}
        onFastModeChange={onFastModeChange}
      />,
    );
    const trigger = screen.getByRole("button", { name: /Select model/i });
    await user.click(trigger);

    const chip = await within(await findModelRow(FAST_GPT.id))
      .findByRole("button", { name: /Fast mode for/i });
    await user.click(chip);

    expect(onFastModeChange).toHaveBeenCalledWith(true);
    expect(onChange).not.toHaveBeenCalled();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });

  it("toggles fast mode from the keyboard", async () => {
    const onFastModeChange = vi.fn();
    render(
      <ModelPicker
        value={FAST_GPT.id}
        onChange={vi.fn()}
        surfaceKey="test"
        models={[FAST_GPT, SONNET]}
        fastMode
        onFastModeChange={onFastModeChange}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Select model/i }));

    const chip = await within(await findModelRow(FAST_GPT.id))
      .findByRole("button", { name: /Fast mode for/i });
    expect(chip.tabIndex).toBe(0);
    chip.focus();
    expect(document.activeElement).toBe(chip);
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    fireEvent.keyDown(chip, { key: "Enter" });
    expect(onFastModeChange).toHaveBeenCalledWith(false);
  });

  it("lights the fast chip only on the selected row", async () => {
    const user = userEvent.setup();
    render(
      <ModelPicker
        value={FAST_GPT.id}
        onChange={vi.fn()}
        surfaceKey="test"
        models={[FAST_GPT, FAST_GPT_ALT]}
        fastMode
        onFastModeChange={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: /Select model/i }));

    const selectedChip = await within(await findModelRow(FAST_GPT.id))
      .findByRole("button", { name: /Fast mode for/i });
    const otherChip = await within(await findModelRow(FAST_GPT_ALT.id))
      .findByRole("button", { name: /Fast mode for/i });
    expect(selectedChip.getAttribute("aria-pressed")).toBe("true");
    expect(otherChip.getAttribute("aria-pressed")).toBe("false");
  });

  it("selects the model and enables fast when the chip is clicked on a non-selected row", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const onFastModeChange = vi.fn();
    render(
      <ModelPicker
        value={FAST_GPT.id}
        onChange={onChange}
        surfaceKey="test"
        models={[FAST_GPT, FAST_GPT_ALT]}
        fastMode={false}
        onFastModeChange={onFastModeChange}
      />,
    );
    await user.click(screen.getByRole("button", { name: /Select model/i }));

    const otherChip = await within(await findModelRow(FAST_GPT_ALT.id))
      .findByRole("button", { name: /Fast mode for/i });
    await user.click(otherChip);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(FAST_GPT_ALT.id, { fastMode: true });
    expect(onFastModeChange).not.toHaveBeenCalled();
  });

  it("turns fast off again when the selected row's chip is clicked twice", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const onFastModeChange = vi.fn();
    const props = {
      value: FAST_GPT.id,
      onChange,
      surfaceKey: "test",
      models: [FAST_GPT, FAST_GPT_ALT],
      onFastModeChange,
    };
    const { rerender } = render(<ModelPicker {...props} fastMode={false} />);
    const trigger = screen.getByRole("button", { name: /Select model/i });
    await user.click(trigger);

    const chip = await within(await findModelRow(FAST_GPT.id))
      .findByRole("button", { name: /Fast mode for/i });
    await user.click(chip);
    expect(onFastModeChange).toHaveBeenLastCalledWith(true);

    rerender(<ModelPicker {...props} fastMode />);
    await user.click(
      await within(await findModelRow(FAST_GPT.id)).findByRole("button", { name: /Fast mode for/i }),
    );

    expect(onFastModeChange).toHaveBeenLastCalledWith(false);
    expect(onChange).not.toHaveBeenCalled();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });

  it("clears a stale fast bit when a different model is picked by a plain row click", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const onFastModeChange = vi.fn();
    render(
      <ModelPicker
        value={FAST_GPT.id}
        onChange={onChange}
        surfaceKey="test"
        models={[FAST_GPT, SLOW_GPT]}
        fastMode
        onFastModeChange={onFastModeChange}
      />,
    );
    await user.click(screen.getByRole("button", { name: /Select model/i }));

    // A model without a fast service tier has no chip at all, and inherits nothing.
    const slowRow = await findModelRow(SLOW_GPT.id);
    expect(within(slowRow).queryByRole("button", { name: /Fast mode for/i })).toBeNull();
    await user.click(slowRow);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(SLOW_GPT.id, { fastMode: false });
    expect(onFastModeChange).not.toHaveBeenCalled();
  });

  it("renders a presentational lightning glyph on the trigger when fast mode is on", async () => {
    const { rerender } = render(
      <ModelPicker
        value={FAST_GPT.id}
        onChange={vi.fn()}
        surfaceKey="test"
        models={[FAST_GPT]}
        fastMode={false}
        onFastModeChange={vi.fn()}
      />,
    );
    const trigger = screen.getByRole("button", { name: /Select model/i });
    expect(trigger.querySelector('[data-model-picker-fast-glyph="true"]')).toBeNull();

    rerender(
      <ModelPicker
        value={FAST_GPT.id}
        onChange={vi.fn()}
        surfaceKey="test"
        models={[FAST_GPT]}
        fastMode
        onFastModeChange={vi.fn()}
      />,
    );
    const glyph = trigger.querySelector('[data-model-picker-fast-glyph="true"]');
    expect(glyph).not.toBeNull();
    expect(glyph?.getAttribute("aria-hidden")).toBe("true");
    // The accessible name stays text-only.
    expect(trigger.getAttribute("aria-label")).toBe(
      `Select model (current: ${FAST_GPT.displayName} Fast)`,
    );
  });

  it("keeps the deprecated sibling chip for surfaces still on onFastModeToggle", async () => {
    const onToggle = vi.fn();
    render(
      <ModelPicker
        value={FAST_GPT.id}
        onChange={vi.fn()}
        surfaceKey="test"
        models={[FAST_GPT, SLOW_GPT]}
        fastModeActive
        onFastModeToggle={onToggle}
      />,
    );
    const trigger = screen.getByRole("button", { name: /Select model/i });
    const legacyChip = screen.getByRole("button", { name: "Fast mode" });
    expect(trigger.contains(legacyChip)).toBe(false);
    // The legacy chip already carries the state, so the label stays unsuffixed.
    expect(trigger.textContent).not.toContain("Fast");
    await userEvent.click(legacyChip);
    expect(onToggle).toHaveBeenCalledWith(false);
  });

  it("suffixes the trigger label with Fast while fast mode is on", () => {
    render(
      <ModelPicker
        value={FAST_GPT.id}
        onChange={vi.fn()}
        surfaceKey="test"
        models={[FAST_GPT, SONNET]}
        fastMode
        onFastModeChange={vi.fn()}
      />,
    );
    const trigger = screen.getByRole("button", { name: /Select model/i });
    expect(trigger.textContent).toContain(`${FAST_GPT.displayName} Fast`);
  });

  it("renders the fast affordance for Cursor runtime models that advertise fast service", async () => {
    providerAuthStatusInternal = { cursor: "ok" };
    const onToggle = vi.fn();
    const cursorFast = createDynamicCursorCliModelDescriptor("composer-2.5", "Composer 2.5", {
      serviceTiers: ["fast"],
      cursorAvailability: { cli: true, sdk: true },
    });
    rememberRuntimeCatalog({
      fetchedAt: "2026-05-29T00:00:00.000Z",
      groups: [{
        key: "cursor",
        displayName: "Cursor",
        providers: [{
          key: "cursor",
          displayName: "Cursor",
          badgeColor: "#8B5CF6",
          modelCount: 1,
          subsections: [{
            key: "cursor",
            label: "Cursor",
            models: [{
              id: cursorFast.id,
              runtimeModelId: cursorFast.providerModelId,
              provider: "cursor",
              providerKey: "cursor",
              groupKey: "cursor",
              displayName: cursorFast.displayName,
              isDefault: true,
              isAvailable: true,
              serviceTiers: cursorFast.serviceTiers,
              cursorAvailability: cursorFast.cursorAvailability,
            }],
          }],
        }],
      }],
    } as AgentChatModelCatalog, { mode: "cached" });
    render(
      <ModelPicker
        value={cursorFast.id}
        onChange={vi.fn()}
        surfaceKey="test"
        models={[cursorFast]}
        fastMode
        onFastModeChange={onToggle}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Select model/i }));

    const fastButton = await screen.findByRole("button", { name: /Fast mode for/i });
    expect(fastButton.getAttribute("aria-pressed")).toBe("true");
    await userEvent.click(fastButton);
    expect(onToggle).toHaveBeenCalledWith(false);
  });

  it("shows Select model on the trigger when value is empty even if recents exist", () => {
    recentStore.unshift(OPUS.id);
    render(
      <ModelPicker
        value=""
        onChange={vi.fn()}
        surfaceKey="test"
        models={MODELS}
      />,
    );
    const trigger = screen.getByRole("button", { name: /Select model/i });
    expect(trigger.textContent).not.toContain(OPUS.displayName);
    expect(trigger.textContent).toMatch(/Select model/i);
  });

  it("shows the correct tooltip on the authOnly toggle and calls toggle on click", async () => {
    const user = userEvent.setup();
    authOnlyState = true;
    renderPicker();
    await user.click(screen.getByRole("button", { name: /Select model/i }));
    const toggle = document.querySelector(
      '[data-model-picker-auth-toggle="true"]',
    ) as HTMLButtonElement;
    expect(toggle).toBeTruthy();
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(toggle.getAttribute("title")).toMatch(/include unauthenticated providers/i);
    await user.click(toggle);
    expect(authOnlyState).toBe(false);
  });

  it("hides unauthed family rows when authOnly is on (using internal status hook)", async () => {
    const user = userEvent.setup();
    authOnlyState = true;
    providerAuthStatusInternal = { anthropic: "ok", openai: "unauthed" };
    renderPicker();
    await user.click(screen.getByRole("button", { name: /Select model/i }));
    const ids = screen
      .getAllByRole("option")
      .map((el) => el.getAttribute("data-model-id"));
    expect(ids).toContain(SONNET.id);
    expect(ids).not.toContain(GPT.id);
  });

  it("uses authenticated direct-provider models when the discovered id list is incomplete", async () => {
    const user = userEvent.setup();
    authOnlyState = true;
    providerAuthStatusInternal = { anthropic: "unauthed", openai: "ok" };
    const { onChange } = renderPicker({
      models: [SONNET],
      availableModelIds: [SONNET.id],
    });

    await user.click(screen.getByRole("button", { name: /Select model/i }));
    await user.click(screen.getByRole("tab", { name: /^OpenAI$/i }));

    const gptRow = await screen.findByRole("option", { name: "GPT-5.4" });
    expect(gptRow.getAttribute("data-model-id")).toBe(GPT.id);
    expect(gptRow.getAttribute("aria-disabled")).toBeNull();
    await user.click(gptRow);
    expect(onChange).toHaveBeenCalledWith(GPT.id);
  });

  it("does not load internal status when the caller supplied auth state", async () => {
    const user = userEvent.setup();
    renderPicker({ providerAuthStatus: { anthropic: "ok" } });

    await user.click(screen.getByRole("button", { name: /Select model/i }));

    expect(document.querySelector('[data-model-picker-content="true"]')).toBeTruthy();
    expect(providerAuthStatusOptions.at(-1)).toEqual({ loadStatus: false });
    expect(
      screen.getAllByRole("option").find((option) => option.getAttribute("data-model-id") === SONNET.id)
        ?.getAttribute("aria-disabled"),
    ).toBeNull();
  });

  it("shows Cursor in the auth-only rail even before Cursor models are discovered", async () => {
    const user = userEvent.setup();
    authOnlyState = true;
    providerAuthStatusInternal = { anthropic: "ok", cursor: "unauthed" };
    renderPicker({ models: MODELS.filter((model) => model.family !== "cursor") });
    await user.click(screen.getByRole("button", { name: /Select model/i }));
    expect(
      document.querySelector('[data-rail-selection="provider:cursor"]'),
    ).toBeTruthy();
  });

  it("loads cached runtime catalog when the picker opens without forcing refresh", async () => {
    const user = userEvent.setup();
    const modelCatalog = vi.fn(async () => ({
      groups: [],
      fetchedAt: "2026-05-18T00:00:00.000Z",
      stale: false,
    }));
    Object.defineProperty(window, "ade", {
      configurable: true,
      writable: true,
      value: {
        agentChat: {
          modelCatalog,
        },
      },
    });

    renderPicker();
    await user.click(screen.getByRole("button", { name: /Select model/i }));

    await waitFor(() => {
      expect(modelCatalog).toHaveBeenCalledWith({ mode: "cached" });
    });
    expect(modelCatalog).not.toHaveBeenCalledWith(
      expect.objectContaining({ mode: "force" }),
    );
  });

  it("renders the Set up banner when the active rail is unauthed and onOpenSignIn is wired", async () => {
    const user = userEvent.setup();
    providerAuthStatusInternal = { anthropic: "unauthed", openai: "unauthed" };
    const onOpenSignIn = vi.fn();
    render(
      <ModelPicker
        value={SONNET.id}
        onChange={vi.fn()}
        surfaceKey="test"
        models={MODELS}
        onOpenSignIn={onOpenSignIn}
      />,
    );
    await user.click(screen.getByRole("button", { name: /Select model/i }));
    const banner = document.querySelector('[data-model-picker-setup-banner="true"]') as HTMLButtonElement;
    expect(banner).toBeTruthy();
    expect(banner.getAttribute("data-provider-family")).toBe("anthropic");
    await user.click(banner);
    expect(onOpenSignIn).toHaveBeenCalledWith("anthropic");
    expect(screen.getByRole("button", { name: /Select model/i }).getAttribute("aria-expanded")).toBe("false");
  });

  it("passes row auth type when opening sign-in for unavailable Anthropic models", async () => {
    const user = userEvent.setup();
    const anthropicApiKeyModel = createDynamicOpenCodeModelDescriptor("", {
      openCodeProviderId: "anthropic",
      openCodeModelId: "claude-sonnet-5",
      displayName: "Claude Sonnet via API key",
    });
    const onOpenSignIn = vi.fn();
    renderPicker({
      value: anthropicApiKeyModel.id,
      models: [anthropicApiKeyModel],
      availableModelIds: [],
      onOpenSignIn,
    });

    await user.click(screen.getByRole("button", { name: /Select model/i }));
    await user.click(screen.getByRole("button", { name: /Sign in/i }));

    expect(anthropicApiKeyModel.family).toBe("anthropic");
    expect(onOpenSignIn).toHaveBeenCalledWith("anthropic", ["api-key"]);
    expect(screen.getByRole("button", { name: /Select model/i }).getAttribute("aria-expanded")).toBe("false");
  });

  it("dims configuration-gated models and routes their click to sign-in even when the family is authed", async () => {
    const user = userEvent.setup();
    // Anthropic family is fully authed, so the family-ready shortcut would
    // otherwise mark every Claude row available. The per-model
    // requiresConfiguration annotation must still dim the gated row.
    providerAuthStatusInternal = { anthropic: "ok" };
    const onOpenSignIn = vi.fn();
    const catalog = {
      groups: [
        {
          key: "claude",
          displayName: "Claude",
          providers: [
            {
              key: "anthropic",
              displayName: "Anthropic",
              badgeColor: "#D97706",
              modelCount: 2,
              subsections: [
                {
                  key: "__default__",
                  label: "",
                  models: [
                    {
                      id: SONNET.id,
                      runtimeModelId: SONNET.id,
                      provider: "anthropic",
                      providerKey: "anthropic",
                      providerId: "anthropic",
                      providerName: "Anthropic",
                      groupKey: "claude",
                      displayName: SONNET.displayName,
                      isDefault: true,
                      isAvailable: true,
                      requiresConfiguration: false,
                      supportsReasoning: true,
                      supportsTools: true,
                    },
                    {
                      id: OPUS.id,
                      runtimeModelId: OPUS.id,
                      provider: "anthropic",
                      providerKey: "anthropic",
                      providerId: "anthropic",
                      providerName: "Anthropic",
                      groupKey: "claude",
                      displayName: OPUS.displayName,
                      isDefault: false,
                      isAvailable: false,
                      requiresConfiguration: true,
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
      fetchedAt: "2026-05-18T00:00:00.000Z",
      stale: false,
    } as unknown as AgentChatModelCatalog;
    const modelCatalog = vi.fn(async () => catalog);
    Object.defineProperty(window, "ade", {
      configurable: true,
      writable: true,
      value: { agentChat: { modelCatalog } },
    });

    const { onChange } = renderPicker({
      value: SONNET.id,
      models: [],
      filter: (m: ModelDescriptor) => m.id === SONNET.id || m.id === OPUS.id,
      onOpenSignIn,
    });
    await user.click(screen.getByRole("button", { name: /Select model/i }));

    await waitFor(() => {
      expect(
        screen.getAllByRole("option").some((el) => el.getAttribute("data-model-id") === OPUS.id),
      ).toBe(true);
    });

    const rows = screen.getAllByRole("option");
    const opusRow = rows.find((el) => el.getAttribute("data-model-id") === OPUS.id)!;
    const sonnetRow = rows.find((el) => el.getAttribute("data-model-id") === SONNET.id)!;

    // Gated row is dimmed (aria-disabled); the available sibling is not.
    expect(opusRow.getAttribute("aria-disabled")).toBe("true");
    expect(sonnetRow.getAttribute("aria-disabled")).toBeNull();

    // Clicking the gated row routes to the settings/connect affordance and does
    // not select the model.
    await user.click(opusRow);
    expect(onOpenSignIn.mock.calls[0]?.[0]).toBe("anthropic");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("excludes configuration-gated models from the auth-only filter", async () => {
    const user = userEvent.setup();
    authOnlyState = true;
    providerAuthStatusInternal = { anthropic: "ok" };
    const gatedOpus = {
      ...OPUS,
      catalogRequiresConfiguration: true,
    } as ModelDescriptor;

    renderPicker({ models: [SONNET, gatedOpus] });
    await user.click(screen.getByRole("button", { name: /Select model/i }));

    const ids = screen.getAllByRole("option").map((row) => row.getAttribute("data-model-id"));
    expect(ids).toContain(SONNET.id);
    expect(ids).not.toContain(OPUS.id);
  });

  it("does not render the Set up banner when the active rail is authed", async () => {
    const user = userEvent.setup();
    providerAuthStatusInternal = { anthropic: "ok", openai: "unauthed" };
    render(
      <ModelPicker
        value={SONNET.id}
        onChange={vi.fn()}
        surfaceKey="test"
        models={MODELS}
        onOpenSignIn={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: /Select model/i }));
    expect(document.querySelector('[data-model-picker-setup-banner="true"]')).toBeNull();
  });

  it("does not render the Set up banner when onOpenSignIn is not provided", async () => {
    const user = userEvent.setup();
    providerAuthStatusInternal = { anthropic: "unauthed" };
    render(
      <ModelPicker
        value={SONNET.id}
        onChange={vi.fn()}
        surfaceKey="test"
        models={MODELS}
      />,
    );
    await user.click(screen.getByRole("button", { name: /Select model/i }));
    expect(document.querySelector('[data-model-picker-setup-banner="true"]')).toBeNull();
  });

  it("keeps empty Cursor discovery retryable when Cursor is connected", async () => {
    const user = userEvent.setup();
    providerAuthStatusInternal = { cursor: "ok" };
    const modelCatalog = vi.fn(async () => ({
      groups: [],
      fetchedAt: "2026-05-18T00:00:00.000Z",
      stale: false,
    }));
    Object.defineProperty(window, "ade", {
      configurable: true,
      writable: true,
      value: {
        agentChat: {
          modelCatalog,
        },
      },
    });

    renderPicker({ onOpenSignIn: vi.fn() });
    await user.click(screen.getByRole("button", { name: /Select model/i }));
    const cursorRail = document.querySelector(
      '[data-rail-selection="provider:cursor"]',
    ) as HTMLButtonElement;
    await user.click(cursorRail);

    await waitFor(() => {
      expect(modelCatalog).toHaveBeenCalledWith({ mode: "refresh-stale", refreshProvider: "cursor", cursorSource: "sdk" });
    });
    expect(await screen.findByText("No Cursor models found")).toBeTruthy();
    expect(screen.queryByText("Connect Cursor")).toBeNull();

    modelCatalog.mockClear();
    await user.click(cursorRail);

    await waitFor(() => {
      expect(modelCatalog).toHaveBeenCalledWith({ mode: "refresh-stale", refreshProvider: "cursor", cursorSource: "sdk" });
    });
  });

  it("does not keep Cursor marked fresh after another refresh drops Cursor rows", () => {
    rememberRuntimeCatalog({
      groups: [{
        key: "cursor",
        displayName: "Cursor",
        providers: [{
          key: "cursor",
          displayName: "Cursor",
          badgeColor: "#60A5FA",
          modelCount: 1,
          subsections: [{
            key: "cursor",
            label: "Cursor",
            models: [{
              id: "cursor/composer-2",
              runtimeModelId: "cursor/composer-2",
              provider: "cursor",
              providerKey: "cursor",
              groupKey: "cursor",
              displayName: "Composer 2",
              isDefault: true,
              isAvailable: true,
              supportsReasoning: true,
              supportsTools: true,
              cursorAvailability: { sdk: true, cli: true },
            }],
          }],
        }],
      }],
      fetchedAt: "2026-05-18T00:00:00.000Z",
    } as any, { mode: "force", refreshProvider: "cursor" });
    expect(runtimeCatalogProviderIsFresh("cursor")).toBe(true);

    rememberRuntimeCatalog({
      groups: [],
      fetchedAt: "2026-05-18T00:00:01.000Z",
    }, { mode: "force", refreshProvider: "opencode" });

    expect(runtimeCatalogProviderIsFresh("cursor")).toBe(false);
  });

  it("does not render inline reasoning chips inside model rows", async () => {
    const user = userEvent.setup();
    recentStore.unshift(SONNET.id);
    reasoningByFamilyStore.anthropic = "low";
    renderPicker();
    await user.click(screen.getByRole("button", { name: /Select model/i }));
    const sonnetRow = screen
      .getAllByRole("option")
      .find((el) => el.getAttribute("data-model-id") === SONNET.id)!;
    const chip = sonnetRow.querySelector('button[aria-label*="Reasoning effort"]');
    expect(chip).toBeNull();
  });

  describe("OpenCode binary gating", () => {
    it("shows a runtime loading empty state instead of setup while OpenCode is refreshing", async () => {
      const user = userEvent.setup();
      providerAuthStatusInternal = { opencode: "unauthed" };
      let resolveRefresh: ((value: { groups: []; fetchedAt: string; stale: false }) => void) | null = null;
      const refreshPromise = new Promise<{ groups: []; fetchedAt: string; stale: false }>((resolve) => {
        resolveRefresh = resolve;
      });
      const modelCatalog = vi.fn((args: { mode?: string }) => {
        if (args.mode === "refresh-stale") return refreshPromise;
        return Promise.resolve({ groups: [], fetchedAt: "2026-05-18T00:00:00.000Z", stale: false });
      });
      Object.defineProperty(window, "ade", {
        configurable: true,
        writable: true,
        value: {
          agentChat: {
            modelCatalog,
          },
        },
      });

      renderPicker({ onOpenSignIn: vi.fn() });
      await user.click(screen.getByRole("button", { name: /Select model/i }));
      await user.click(document.querySelector('[data-rail-selection="provider:opencode"]') as HTMLButtonElement);

      await waitFor(() => {
        expect(document.querySelector('[data-empty-state-mode="runtime-loading"][data-refresh-provider="opencode"]')).toBeTruthy();
      });
      expect(document.querySelector('[data-model-picker-setup-banner="true"]')).toBeNull();

      await act(async () => {
        resolveRefresh?.({ groups: [], fetchedAt: "2026-05-18T00:00:01.000Z", stale: false });
        await refreshPromise;
      });
    });

    it("returns a stale runtime catalog immediately and forces refresh in the background when a runtime rail is selected", async () => {
      const user = userEvent.setup();
      const staleCatalog = { groups: [], fetchedAt: "2026-05-18T00:00:00.000Z", stale: true };
      const freshCatalog = { groups: [], fetchedAt: "2026-05-18T00:00:01.000Z" };
      const modelCatalog = vi.fn(async (args: { mode?: string }) => {
        if (args.mode === "refresh-stale") return staleCatalog;
        return freshCatalog;
      });
      Object.defineProperty(window, "ade", {
        configurable: true,
        writable: true,
        value: {
          agentChat: {
            modelCatalog,
          },
        },
      });

      renderPicker();
      await user.click(screen.getByRole("button", { name: /Select model/i }));
      const opencodeRail = document.querySelector(
        '[data-rail-selection="provider:opencode"]',
      ) as HTMLButtonElement;
      await user.click(opencodeRail);

      await waitFor(() => {
        expect(modelCatalog).toHaveBeenCalledWith({ mode: "refresh-stale", refreshProvider: "opencode" });
      });
      await waitFor(() => {
        expect(modelCatalog).toHaveBeenCalledWith({ mode: "force", refreshProvider: "opencode" });
      });

      modelCatalog.mockClear();
      await user.click(opencodeRail);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(modelCatalog).not.toHaveBeenCalled();
    });

    it("renders a fresh shared runtime catalog immediately on a later picker mount", async () => {
      const user = userEvent.setup();
      const freshCatalog = {
        groups: [
          {
            key: "opencode" as const,
            displayName: "OpenCode",
            providers: [
              {
                key: "anthropic",
                displayName: "Anthropic",
                badgeColor: "#D97706",
                modelCount: 1,
                subsections: [
                  {
                    key: "anthropic",
                    label: "Anthropic",
                    models: [
                      {
                        id: OPENCODE_MODEL.id,
                        runtimeModelId: "claude-sonnet-5",
                        provider: "opencode" as const,
                        providerKey: "opencode",
                        groupKey: "opencode" as const,
                        displayName: OPENCODE_MODEL.displayName,
                        isDefault: false,
                        isAvailable: true,
                        providerId: "anthropic",
                        providerName: "Anthropic",
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
        fetchedAt: "2026-05-18T00:00:00.000Z",
        stale: false,
      };
      const modelCatalog = vi.fn(async () => freshCatalog);
      Object.defineProperty(window, "ade", {
        configurable: true,
        writable: true,
        value: {
          agentChat: {
            modelCatalog,
          },
        },
      });

      const first = renderPicker({ models: undefined });
      await user.click(screen.getByRole("button", { name: /Select model/i }));
      await user.click(document.querySelector('[data-rail-selection="provider:opencode"]') as HTMLButtonElement);
      await waitFor(() => {
        expect(screen.getByText(OPENCODE_MODEL.displayName)).toBeTruthy();
      });
      first.unmount();

      modelCatalog.mockClear();
      renderPicker({ models: undefined });
      await user.click(screen.getByRole("button", { name: /Select model/i }));
      await user.click(document.querySelector('[data-rail-selection="provider:opencode"]') as HTMLButtonElement);

      expect(screen.getByText(OPENCODE_MODEL.displayName)).toBeTruthy();
      expect(modelCatalog).not.toHaveBeenCalledWith(
        expect.objectContaining({ refreshProvider: "opencode" }),
      );
    });

    it("shows the same Install OpenCode copy for opencode, ollama, and lmstudio panes when the binary is missing", async () => {
      const user = userEvent.setup();
      opencodeBinaryInstalledInternal = false;
      renderPicker();
      await user.click(screen.getByRole("button", { name: /Select model/i }));

      const families: Array<"opencode" | "ollama" | "lmstudio"> = ["opencode", "ollama", "lmstudio"];
      const seenTitles = new Set<string>();
      const seenBodies = new Set<string>();
      for (const family of families) {
        const railButton = document.querySelector(
          `[data-rail-selection="provider:${family}"]`,
        ) as HTMLButtonElement | null;
        expect(railButton).toBeTruthy();
        await user.click(railButton!);

        const emptyState = document.querySelector(
          `[data-empty-state-mode="opencode-required"][data-provider-family="${family}"]`,
        );
        expect(emptyState).toBeTruthy();

        const title = emptyState!.querySelector("span")!.textContent;
        seenTitles.add((title ?? "").trim());
        const bodyText = emptyState!.textContent ?? "";
        // Capture the body line (after the title) so we can confirm it follows
        // a consistent pattern across all three panes.
        seenBodies.add(bodyText.includes("Install OpenCode to use") ? "shared-body" : "other");
      }

      // All three panes converge on the same Install OpenCode title.
      expect(seenTitles.size).toBe(1);
      expect([...seenTitles][0]).toBe("Install OpenCode");
      // And the body uses the same "Install OpenCode to use … models." pattern.
      expect(seenBodies).toEqual(new Set(["shared-body"]));
    });

    it("does not render the regular Set up banner for opencode/ollama/lmstudio rails when OpenCode is missing", async () => {
      const user = userEvent.setup();
      opencodeBinaryInstalledInternal = false;
      providerAuthStatusInternal = { opencode: "unauthed" };
      const onOpenSignIn = vi.fn();
      render(
        <ModelPicker
          value={SONNET.id}
          onChange={vi.fn()}
          surfaceKey="test"
          models={MODELS}
          onOpenSignIn={onOpenSignIn}
        />,
      );
      await user.click(screen.getByRole("button", { name: /Select model/i }));
      const opencodeRail = document.querySelector(
        '[data-rail-selection="provider:opencode"]',
      ) as HTMLButtonElement;
      await user.click(opencodeRail);
      expect(document.querySelector('[data-model-picker-setup-banner="true"]')).toBeNull();
    });

    it("closes before opening Settings from the OpenCode-required empty state", async () => {
      const user = userEvent.setup();
      opencodeBinaryInstalledInternal = false;
      const onOpenSignIn = vi.fn();
      render(
        <ModelPicker
          value={SONNET.id}
          onChange={vi.fn()}
          surfaceKey="test"
          models={MODELS}
          onOpenSignIn={onOpenSignIn}
        />,
      );

      const trigger = screen.getByRole("button", { name: /Select model/i });
      await user.click(trigger);
      const opencodeRail = document.querySelector(
        '[data-rail-selection="provider:opencode"]',
      ) as HTMLButtonElement;
      await user.click(opencodeRail);
      await user.click(screen.getByRole("button", { name: /Open Settings/i }));

      expect(onOpenSignIn).toHaveBeenCalledOnce();
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
    });
  });
  // The rail lists Cursor unconditionally so it stays reachable before the
  // catalog refresh streams in — except on Windows on ARM, where @cursor/sdk has
  // no build. See apps/desktop/src/shared/providerPlatformSupport.ts.
  describe("Cursor rail platform gating", () => {
    function setRuntimeTarget(platform: string, arch: string) {
      (globalThis.window as unknown as { ade?: Record<string, unknown> }).ade = {
        ...((globalThis.window as unknown as { ade?: Record<string, unknown> }).ade ?? {}),
        app: { runtimeTarget: { platform, arch } },
      };
    }

    it("omits the Cursor rail on Windows on ARM but keeps every other provider", async () => {
      const user = userEvent.setup();
      setRuntimeTarget("win32", "arm64");
      renderPicker();

      await user.click(screen.getByRole("button", { name: /Select model/i }));

      const rail = document.querySelector('[data-model-picker-rail="true"]')!;
      const keys = Array.from(rail.querySelectorAll("[data-rail-selection]"))
        .map((el) => el.getAttribute("data-rail-selection"));
      expect(keys).not.toContain("provider:cursor");
      expect(keys).toContain("provider:anthropic");
      expect(keys).toContain("provider:openai");
      expect(keys).toContain("provider:factory");
      expect(keys).toContain("provider:opencode");
    });

    it("keeps the Cursor rail on Windows x64 and on macOS", async () => {
      for (const [platform, arch] of [["win32", "x64"], ["darwin", "arm64"]] as const) {
        const user = userEvent.setup();
        setRuntimeTarget(platform, arch);
        renderPicker();

        await user.click(screen.getByRole("button", { name: /Select model/i }));

        const rail = document.querySelector('[data-model-picker-rail="true"]')!;
        const keys = Array.from(rail.querySelectorAll("[data-rail-selection]"))
          .map((el) => el.getAttribute("data-rail-selection"));
        expect(keys, `${platform}-${arch}`).toContain("provider:cursor");
        cleanup();
      }
    });
  });
});
