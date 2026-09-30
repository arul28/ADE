import { describe, expect, it } from "vitest";

import {
  buildModelMentionDetail,
  formatModelMentionToken,
  modelMentionChipLabel,
  modelMentionEffortLabel,
  modelMentionPermissionLabel,
  parseModelMentionToken,
  parseModelMentions,
  rankComposerModelSuggestions,
  type ComposerModelSuggestion,
} from "./modelMentions";

/**
 * The grammar is the load-bearing half of the feature: the draft, the
 * transcript, and the send-time expansion all re-parse the token, so a token
 * that parses differently than it was written silently names the wrong model.
 */
describe("model mention grammar", () => {
  it.each([
    {
      name: "a bare model id",
      text: "use @model:anthropic/claude-opus-5 now",
      modelId: "anthropic/claude-opus-5",
      effort: null,
      permission: null,
      token: "@model:anthropic/claude-opus-5",
    },
    {
      // The regression this file exists for: an OpenCode id encodes its
      // provider model id, so it contains `%`. Without `%` in the id charset
      // the token truncated at `opencode/openrouter/anthropic`.
      name: "a percent-encoded OpenCode id",
      text: "use @model:opencode/openrouter/anthropic%2Fclaude-opus-4.7?effort=high&perm=full-auto now",
      modelId: "opencode/openrouter/anthropic%2Fclaude-opus-4.7",
      effort: "high",
      permission: "full-auto",
      token: "@model:opencode/openrouter/anthropic%2Fclaude-opus-4.7?effort=high&perm=full-auto",
    },
    {
      name: "only a permission query",
      text: "try @model:acme/rocket-9?perm=plan",
      modelId: "acme/rocket-9",
      effort: null,
      permission: "plan",
      token: "@model:acme/rocket-9?perm=plan",
    },
    {
      // A sentence can end right after a chip; the dot is prose, not the id.
      name: "a trailing sentence period",
      text: "try @model:acme/rocket-9.",
      modelId: "acme/rocket-9",
      effort: null,
      permission: null,
      token: "@model:acme/rocket-9",
    },
  ])("parses $name", ({ text, modelId, effort, permission, token }) => {
    const [mention, ...rest] = parseModelMentions(text);
    expect(rest).toEqual([]);
    expect(mention).toBeDefined();
    expect(mention!.modelId).toBe(modelId);
    expect(mention!.effort).toBe(effort);
    expect(mention!.permission).toBe(permission);
    expect(mention!.token).toBe(token);
    expect(text.slice(mention!.start, mention!.end)).toBe(token);
  });

  it.each([
    { name: "an email-shaped substring", text: "a@model:foo" },
    { name: "a bare prefix", text: "@model:" },
    { name: "a non-model mention", text: "@chat:abc" },
  ])("ignores $name", ({ text }) => {
    expect(parseModelMentions(text)).toEqual([]);
  });

  it("round-trips every parsed mention back to its token", () => {
    const text = "a @model:acme/a%2Fb?effort=low&perm=auto and @model:acme/c";
    const mentions = parseModelMentions(text);
    expect(mentions.map((mention) => formatModelMentionToken(mention))).toEqual([
      "@model:acme/a%2Fb?effort=low&perm=auto",
      "@model:acme/c",
    ]);
    expect(mentions.map((mention) => parseModelMentionToken(mention.token)?.modelId)).toEqual([
      "acme/a%2Fb",
      "acme/c",
    ]);
  });

  it("labels an unknown model from the id's last segment", () => {
    expect(modelMentionChipLabel({ modelId: "acme/x", effort: "high", permission: "plan" }, "acme/x"))
      .toBe("acme/x · High · Plan");
    expect(modelMentionEffortLabel("xhigh")).toBe("Extra high");
    expect(modelMentionPermissionLabel("full-auto")).toBe("Full access");
    expect(modelMentionPermissionLabel(null)).toBe("Default");
  });
});

describe("model mention send-time detail", () => {
  const info = { displayName: "Claude Opus 5", provider: "claude", reasoningTiers: ["low", "medium", "high"] };

  it("states the exact ade chat create and handoff flags", () => {
    const detail = buildModelMentionDetail(
      { modelId: "anthropic/claude-opus-5", effort: "high", permission: "full-auto" },
      info,
    );
    expect(detail.attributes).toContainEqual(["provider", "claude"]);
    expect(detail.attributes).toContainEqual(["effort", "high"]);
    // The block names the provider's own mode; the CLI flag stays generic.
    expect(detail.attributes).toContainEqual(["permissions", "bypassPermissions"]);
    expect(detail.hint).toContain("--reasoning-effort high");
    expect(detail.hint).toContain("--permissions full-auto");
    expect(detail.hint).toContain("--effort high");
  });

  it("shell-quotes a model id that is not shell-safe", () => {
    const detail = buildModelMentionDetail(
      { modelId: "opencode/openrouter/anthropic%2Fclaude-opus-4.7", effort: null, permission: null },
      { displayName: "Claude Opus 4.7", provider: "opencode", reasoningTiers: [] },
    );
    expect(detail.hint).toContain("--model 'opencode/openrouter/anthropic%2Fclaude-opus-4.7'");
  });

  it("drops an effort the model does not accept and names it", () => {
    const detail = buildModelMentionDetail(
      { modelId: "anthropic/claude-opus-5", effort: "ultra", permission: "plan" },
      info,
    );
    expect(detail.attributes).toContainEqual(["effort", ""]);
    expect(detail.hint).not.toContain("--reasoning-effort");
    expect(detail.hint).toContain('Ignored from the chip: thinking level "ultra"');
  });

  it("drops an unknown permission mode and names it", () => {
    const detail = buildModelMentionDetail(
      { modelId: "anthropic/claude-opus-5", effort: null, permission: "yolo" },
      info,
    );
    expect(detail.attributes).toContainEqual(["permissions", ""]);
    expect(detail.hint).toContain('permission mode "yolo"');
  });

  it("marks an unknown model unresolved and tells the agent to ask", () => {
    const detail = buildModelMentionDetail({ modelId: "nope/void", effort: null, permission: null }, null);
    expect(detail.attributes).toEqual([["resolved", "false"]]);
    expect(detail.hint.toLowerCase()).toContain("ask the user");
  });
});

describe("model mention ranking", () => {
  const models: ComposerModelSuggestion[] = [
    {
      modelId: "anthropic/claude-opus-5",
      title: "Claude Opus 5",
      subtitle: "Claude Code",
      reasoningTiers: ["low", "medium", "high"],
      defaultEffort: "high",
    },
    {
      modelId: "opencode/opencode-go/deepseek-v4.1-flash",
      title: "DeepSeek V4.1 Flash",
      subtitle: "OpenCode · OpenCode Go",
      reasoningTiers: ["high"],
      defaultEffort: "high",
    },
    {
      modelId: "openai/gpt-5.6-sol",
      title: "GPT-5.6 Sol",
      subtitle: "Codex",
      reasoningTiers: ["low", "medium", "high"],
      defaultEffort: "medium",
    },
  ];

  it("stays quiet until the query can mean a model", () => {
    expect(rankComposerModelSuggestions(models, "d")).toEqual({ rows: [], bestScore: null });
  });

  it("lists every model for a `model` keyword query", () => {
    const ranked = rankComposerModelSuggestions(models, "model");
    // Every model, in the deterministic id-ascending order equal-score rows use.
    expect(ranked.rows.map((model) => model.modelId)).toEqual([
      "anthropic/claude-opus-5",
      "openai/gpt-5.6-sol",
      "opencode/opencode-go/deepseek-v4.1-flash",
    ]);
    expect(ranked.bestScore).toBe(0);
  });

  it.each([
    { query: "de", expected: "opencode/opencode-go/deepseek-v4.1-flash" },
    { query: "opus", expected: "anthropic/claude-opus-5" },
    { query: "sol", expected: "openai/gpt-5.6-sol" },
  ])("puts the model named by $query first", ({ query, expected }) => {
    const ranked = rankComposerModelSuggestions(models, query);
    expect(ranked.bestScore).toBe(1);
    expect(ranked.rows[0]?.modelId).toBe(expected);
  });
});
