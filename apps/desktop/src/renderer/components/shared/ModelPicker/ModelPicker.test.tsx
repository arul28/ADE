/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ModelDescriptor } from "../../../../shared/modelRegistry";

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

const favoriteStore = new Set<string>();
const recentStore: string[] = [];
let authOnlyState = false;
const reasoningByFamilyStore: Record<string, string> = {};
let providerAuthStatusInternal: Record<string, "ok" | "unauthed" | "limited"> = {};

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
  useProviderAuthStatus: () => ({
    status: { ...providerAuthStatusInternal },
    loaded: true,
  }),
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

import { ModelPicker } from "./ModelPicker";

const SONNET: ModelDescriptor = {
  id: "anthropic/claude-sonnet-4-6",
  shortId: "sonnet",
  displayName: "Claude Sonnet 4.6",
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
  id: "anthropic/claude-opus-4-7",
  shortId: "opus",
  displayName: "Claude Opus 4.7",
  family: "anthropic",
  authTypes: ["cli-subscription"],
  contextWindow: 200_000,
  maxOutputTokens: 128_000,
  capabilities: { tools: true, vision: true, reasoning: true, streaming: true },
  reasoningTiers: ["low", "medium", "high"],
  color: "#D97706",
  providerRoute: "claude-cli",
  providerModelId: "claude-opus-4-7",
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

const MODELS: ModelDescriptor[] = [SONNET, OPUS, GPT];

beforeEach(() => {
  favoriteStore.clear();
  recentStore.length = 0;
  authOnlyState = false;
  for (const key of Object.keys(reasoningByFamilyStore)) delete reasoningByFamilyStore[key];
  providerAuthStatusInternal = {};
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

  it("renders the fast-mode toggle outside the trigger when supported", async () => {
    const onToggle = vi.fn();
    const FAST: ModelDescriptor = {
      ...GPT,
      serviceTiers: ["fast"],
    };
    render(
      <ModelPicker
        value={FAST.id}
        onChange={vi.fn()}
        surfaceKey="test"
        models={[FAST, SONNET]}
        fastModeActive={false}
        onFastModeToggle={onToggle}
      />,
    );
    const fastButton = screen.getByRole("button", { name: /Fast mode/i });
    expect(fastButton.getAttribute("data-model-picker-fast-toggle")).toBe("true");
    const trigger = screen.getByRole("button", { name: /Select model/i });
    expect(trigger.contains(fastButton)).toBe(false);
    await userEvent.click(fastButton);
    expect(onToggle).toHaveBeenCalledWith(true);
    // Clicking fast did NOT open the popover
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("falls back trigger display to most-recent when value is empty", () => {
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
    expect(trigger.textContent).toContain(OPUS.displayName);
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
    expect(onOpenSignIn).toHaveBeenCalledOnce();
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
});
