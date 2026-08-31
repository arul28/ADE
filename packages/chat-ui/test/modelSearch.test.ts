import { describe, expect, it } from "vitest";

import type { ModelDescriptor, ProviderStatus } from "../src/sdkTypes";
import {
  groupModelsByProvider,
  isModelSelectable,
  isProviderUsable,
  scoreModelSearch,
} from "../src/models/modelSearch";

const statuses: ProviderStatus[] = [
  { id: "claude", displayName: "Claude", installed: true, authenticated: true },
  { id: "codex", displayName: "Codex", installed: true, authenticated: false },
  { id: "opencode", displayName: "OpenCode", installed: false, authenticated: false },
];

const models: ModelDescriptor[] = [
  { id: "claude-opus", providerId: "claude", displayName: "Opus" },
  { id: "claude-sonnet", providerId: "claude", displayName: "Sonnet" },
  { id: "codex-gpt", providerId: "codex", displayName: "GPT-5 Codex", aliases: ["gpt5"] },
  { id: "opencode-mix", providerId: "opencode", displayName: "Mixed", available: false },
];

describe("scoreModelSearch", () => {
  const item = { displayName: "GPT-5 Codex", providerId: "codex", aliases: ["gpt5"] };

  it("scores an empty query as neutral", () => {
    expect(scoreModelSearch(item, "")).toBe(0);
  });

  it("matches a prefix better than a late substring", () => {
    const prefix = scoreModelSearch({ displayName: "sonnet", providerId: "claude" }, "son")!;
    const late = scoreModelSearch({ displayName: "claude sonnet", providerId: "claude" }, "son")!;
    expect(prefix).toBeLessThan(late);
  });

  it("matches on aliases and provider name", () => {
    expect(scoreModelSearch(item, "gpt5")).not.toBeNull();
    expect(scoreModelSearch(item, "codex")).not.toBeNull();
  });

  it("requires every token to hit something", () => {
    expect(scoreModelSearch(item, "codex zzzz")).toBeNull();
  });

  it("returns null when nothing matches", () => {
    expect(scoreModelSearch(item, "qqqq")).toBeNull();
  });
});

describe("isProviderUsable / isModelSelectable", () => {
  it("requires both installed and authenticated", () => {
    expect(isProviderUsable(statuses[0])).toBe(true);
    expect(isProviderUsable(statuses[1])).toBe(false);
    expect(isProviderUsable(statuses[2])).toBe(false);
    expect(isProviderUsable(null)).toBe(false);
  });

  it("marks available:false models unselectable even on a ready provider", () => {
    expect(isModelSelectable({ ...models[0]!, available: false }, statuses[0])).toBe(false);
    expect(isModelSelectable(models[0]!, statuses[0])).toBe(true);
  });
});

describe("groupModelsByProvider", () => {
  it("groups by provider in the order the statuses arrived", () => {
    const groups = groupModelsByProvider({ models, statuses });
    expect(groups.map((group) => group.providerId)).toEqual(["claude", "codex", "opencode"]);
    expect(groups[0]!.models.map((model) => model.id)).toEqual(["claude-opus", "claude-sonnet"]);
  });

  it("marks unauthed and uninstalled providers disabled", () => {
    const groups = groupModelsByProvider({ models, statuses });
    expect(groups.map((group) => group.enabled)).toEqual([true, false, false]);
  });

  it("still lists providers that only appear in the model catalog", () => {
    const groups = groupModelsByProvider({
      models: [...models, { id: "x", providerId: "ghost", displayName: "Ghost" }],
      statuses,
    });
    const ghost = groups.find((group) => group.providerId === "ghost");
    expect(ghost).toBeDefined();
    expect(ghost!.providerLabel).toBe("ghost");
    expect(ghost!.enabled).toBe(false);
  });

  it("drops groups with no matching models when searching", () => {
    const groups = groupModelsByProvider({ models, statuses, query: "sonnet" });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.models.map((model) => model.id)).toEqual(["claude-sonnet"]);
  });

  it("keeps catalog order for equally scored models", () => {
    const groups = groupModelsByProvider({ models, statuses, query: "" });
    expect(groups[0]!.models.map((model) => model.id)).toEqual(["claude-opus", "claude-sonnet"]);
  });
});
