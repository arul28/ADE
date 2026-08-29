import { describe, expect, it, vi } from "vitest";

import { getAvailableModels, type ModelDescriptor } from "../../../shared/modelRegistry";
import {
  buildNamingModelCandidates,
  buildSessionIntelligenceModelCandidates,
  deriveDeterministicSessionMetadata,
  isProviderLevelNamingFailure,
  parseGeneratedSessionMetadata,
  runNamingAcrossProviders,
  runSessionMetadataGeneration,
  withSessionModelDescriptors,
} from "./sessionNaming";

// The registry is the source of truth for provider grouping, so the fixtures are
// real descriptors rather than hand-built shapes that could drift from it.
const ALL_MODELS = getAvailableModels([
  { type: "cli-subscription", cli: "codex", authenticated: true, path: "/usr/bin/codex", verified: true },
  { type: "cli-subscription", cli: "claude", authenticated: true, path: "/usr/bin/claude", verified: true },
] as never).filter((descriptor) => !descriptor.deprecated);

function modelsFor(...prefixes: string[]): ModelDescriptor[] {
  return ALL_MODELS.filter((descriptor) => prefixes.some((prefix) => descriptor.id.startsWith(prefix)));
}

const OPENAI_MODELS = modelsFor("openai/");
const ANTHROPIC_MODELS = modelsFor("anthropic/");

describe("isProviderLevelNamingFailure", () => {
  it("condemns the provider when the account itself cannot run the model", () => {
    // The 400 that silently broke every naming call: the CLI is healthy, the
    // account is not entitled, so a sibling model on the same provider is a
    // wasted spawn.
    expect(isProviderLevelNamingFailure(
      new Error(`{"status":400,"message":"The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account."}`),
    )).toBe(true);
    expect(isProviderLevelNamingFailure(new Error("spawn codex ENOENT"))).toBe(true);
    expect(isProviderLevelNamingFailure(new Error("401 unauthorized"))).toBe(true);
  });

  it("does not condemn the provider for a single model lacking a capability", () => {
    // These must still retry a sibling model — condemning the provider here
    // would skip straight to the deterministic slug.
    expect(isProviderLevelNamingFailure(new Error("Image input is not supported for this model"))).toBe(false);
    expect(isProviderLevelNamingFailure(new Error("json schema is not supported by this model"))).toBe(false);
    expect(isProviderLevelNamingFailure(new Error("socket hang up"))).toBe(false);
  });

  it("does not condemn the provider when one model is unavailable", () => {
    // A single retired or unrecognized model says nothing about its siblings.
    expect(isProviderLevelNamingFailure(new Error("model_not_found"))).toBe(false);
    expect(isProviderLevelNamingFailure(new Error("The model `gpt-x` does not exist"))).toBe(false);
    // The binary genuinely being absent is still provider-level.
    expect(isProviderLevelNamingFailure(new Error("codex: command not found"))).toBe(true);
  });
});

describe("buildNamingModelCandidates", () => {
  it("returns only the preferred models that are available, in order", () => {
    const candidates = buildNamingModelCandidates({
      availableModels: ALL_MODELS,
      preferred: [OPENAI_MODELS[0]?.id, OPENAI_MODELS[1]?.id],
    });

    expect(candidates).toEqual([OPENAI_MODELS[0]?.id, OPENAI_MODELS[1]?.id]);
    expect(candidates.some((id) => id.startsWith("anthropic/"))).toBe(false);
  });

  it("does not splice a hardcoded namer from another provider", () => {
    const candidates = buildNamingModelCandidates({
      availableModels: ALL_MODELS,
      preferred: [OPENAI_MODELS[0]?.id],
    });

    expect(candidates).toEqual([OPENAI_MODELS[0]?.id]);
  });

  it("drops unavailable and duplicate preferences instead of attempting them", () => {
    const candidates = buildNamingModelCandidates({
      availableModels: ALL_MODELS,
      preferred: [null, "", "openai/does-not-exist", ANTHROPIC_MODELS[0]?.id, ANTHROPIC_MODELS[0]?.id],
    });

    expect(candidates[0]).toBe(ANTHROPIC_MODELS[0]?.id);
    expect(candidates).not.toContain("openai/does-not-exist");
  });

  it("returns nothing when no preferred model is available", () => {
    expect(buildNamingModelCandidates({ availableModels: [], preferred: ["openai/gpt-5.4-mini"] })).toEqual([]);
  });
});

describe("buildSessionIntelligenceModelCandidates", () => {
  it("uses the setting first and the session model second", () => {
    expect(buildSessionIntelligenceModelCandidates({
      availableModels: ALL_MODELS,
      settingModelId: ANTHROPIC_MODELS[0]?.id,
      sessionModelId: OPENAI_MODELS[0]?.id,
    })).toEqual([ANTHROPIC_MODELS[0]?.id, OPENAI_MODELS[0]?.id]);
  });

  it("keeps the session model even when the auth snapshot is empty", () => {
    const sessionModelId = OPENAI_MODELS[0]?.id;
    expect(sessionModelId).toBeTruthy();
    expect(withSessionModelDescriptors([], [sessionModelId]).map((descriptor) => descriptor.id)).toEqual([sessionModelId]);
    expect(buildSessionIntelligenceModelCandidates({
      availableModels: [],
      sessionModelId,
    })).toEqual([sessionModelId]);
  });

  it("resolves a session-model alias onto its canonical id", () => {
    expect(buildSessionIntelligenceModelCandidates({
      availableModels: ALL_MODELS,
      sessionModel: "sonnet",
    })).toEqual(["anthropic/claude-sonnet-5"]);
    expect(buildSessionIntelligenceModelCandidates({
      availableModels: [],
      sessionModel: "sonnet",
    })).toEqual(["anthropic/claude-sonnet-5"]);
    expect(buildSessionIntelligenceModelCandidates({
      availableModels: ALL_MODELS,
      settingModelId: "anthropic/claude-sonnet-5",
      sessionModel: "sonnet",
    })).toEqual(["anthropic/claude-sonnet-5"]);
  });
});

describe("runNamingAcrossProviders", () => {
  it("skips the rest of a condemned provider without spending an attempt on it", async () => {
    const attempted: string[] = [];
    const onFailure = vi.fn();
    const candidates = buildNamingModelCandidates({
      availableModels: ALL_MODELS,
      preferred: [OPENAI_MODELS[0]?.id, OPENAI_MODELS[1]?.id],
    });

    const { result, attemptCount, selectedModelId } = await runNamingAcrossProviders<string>(candidates, {
      run: async (descriptor) => {
        attempted.push(descriptor.id);
        if (descriptor.id.startsWith("openai/")) {
          throw new Error("The model is not supported when using Codex with a ChatGPT account.");
        }
        return "Rename Naming Fallback";
      },
      onFailure,
    });

    expect(result).toBeNull();
    expect(attempted.filter((id) => id.startsWith("openai/"))).toHaveLength(1);
    expect(attempted.some((id) => id.startsWith("anthropic/"))).toBe(false);
    expect(attemptCount).toBe(1);
    expect(selectedModelId).toBe(attempted[0]);
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure.mock.calls[0]![0]).toMatchObject({ providerLevelFailure: true });
  });

  it("advances to the next candidate when a model answers unusably", async () => {
    const attempted: string[] = [];
    const { result } = await runNamingAcrossProviders<string>(
      buildNamingModelCandidates({
        availableModels: ALL_MODELS,
        preferred: [OPENAI_MODELS[0]?.id, ANTHROPIC_MODELS[0]?.id],
      }),
      {
        run: async (descriptor) => {
          attempted.push(descriptor.id);
          return attempted.length === 1 ? null : "Second Model Wins";
        },
        onFailure: vi.fn(),
      },
    );

    expect(attempted.length).toBe(2);
    expect(result).toBe("Second Model Wins");
  });

  it("stops without adopting anything once shouldStop flips", async () => {
    let renamedByUser = false;
    const onFailure = vi.fn();

    const { result, attemptCount } = await runNamingAcrossProviders<string>(
      buildNamingModelCandidates({ availableModels: ALL_MODELS, preferred: [OPENAI_MODELS[0]?.id] }),
      {
        shouldStop: () => renamedByUser,
        run: async () => {
          renamedByUser = true;
          return "Title The User Never Wanted";
        },
        onFailure,
      },
    );

    expect(result).toBeNull();
    expect(attemptCount).toBe(1);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("gives up after three attempts instead of walking the whole registry", async () => {
    const attempted: string[] = [];
    const { result, attemptCount } = await runNamingAcrossProviders<string>(
      ALL_MODELS.map((descriptor) => descriptor.id),
      {
        run: async (descriptor) => {
          attempted.push(descriptor.id);
          throw new Error("socket hang up");
        },
        onFailure: vi.fn(),
      },
    );

    expect(result).toBeNull();
    expect(attemptCount).toBe(3);
    expect(attempted).toHaveLength(3);
  });
});

const normalizeTitle = (value: string): string | null => {
  const words = value.trim().split(/\s+/u).filter(Boolean);
  return words.length >= 2 ? words.slice(0, 6).join(" ") : null;
};
const normalizeStatusLine = (value: string): string | null => {
  const summary = value.trim().replace(/\s+/g, " ");
  return summary.length ? summary.slice(0, 72) : null;
};

describe("parseGeneratedSessionMetadata", () => {
  it("keeps the three naming fields when the model adds extra keys", () => {
    expect(parseGeneratedSessionMetadata({
      raw: {
        chatTitle: "Wire Rag Search",
        laneName: "Search Answer Path",
        statusLine: "Sources show before generate",
        notes: "Grok likes to annotate",
      },
      normalizeTitle,
      normalizeStatusLine,
    })).toEqual({
      chatTitle: "Wire Rag Search",
      laneName: "Search Answer Path",
      statusLine: "Sources show before generate",
    });
  });

  it("accepts a partial object and fenced JSON with surrounding prose", () => {
    expect(parseGeneratedSessionMetadata({
      raw: { chatTitle: "Wire Rag Search" },
      normalizeTitle,
      normalizeStatusLine,
    })).toEqual({
      chatTitle: "Wire Rag Search",
      laneName: null,
      statusLine: null,
    });

    expect(parseGeneratedSessionMetadata({
      raw: [
        "Sure, here is the metadata:",
        "```json",
        JSON.stringify({
          chatTitle: "Wire Rag Search",
          laneName: "Search Answer Path",
          statusLine: "Sources show before generate",
        }),
        "```",
      ].join("\n"),
      normalizeTitle,
      normalizeStatusLine,
    })).toEqual({
      chatTitle: "Wire Rag Search",
      laneName: "Search Answer Path",
      statusLine: "Sources show before generate",
    });
  });
});

describe("deriveDeterministicSessionMetadata", () => {
  it("prefers the conversation summary over the original kickoff prompt", () => {
    expect(deriveDeterministicSessionMetadata({
      seeds: [
        "Wired project aiSummary into RAG excerpts so Cmd+K answers from the overview",
        "start skill using aws other",
      ],
      normalizeTitle,
      normalizeStatusLine,
    })).toMatchObject({
      chatTitle: expect.stringMatching(/wired/i),
      laneName: expect.stringMatching(/wired/i),
      statusLine: expect.stringMatching(/aiSummary|RAG|Cmd/i),
    });
  });
});

describe("runSessionMetadataGeneration", () => {
  it("still reaches a JSON-capable namer when the chat model answers unusably", async () => {
    const attempted: string[] = [];
    const { result } = await runSessionMetadataGeneration({
      candidateModelIds: [OPENAI_MODELS[0]!.id, ANTHROPIC_MODELS[0]!.id],
      cwd: "/tmp",
      prompt: "Refresh this chat",
      runPrompt: async ({ modelId }) => {
        attempted.push(modelId);
        if (modelId.startsWith("openai/")) {
          return { text: "I named it. Hope that helps!" };
        }
        return {
          text: JSON.stringify({
            chatTitle: "Wire Rag Search",
            laneName: "Search Answer Path",
            statusLine: "Sources show before generate",
          }),
        };
      },
      normalizeTitle,
      normalizeStatusLine,
      onFailure: vi.fn(),
    });

    expect(attempted[0]?.startsWith("openai/")).toBe(true);
    expect(attempted.some((id) => id.startsWith("anthropic/"))).toBe(true);
    expect(result).toEqual({
      chatTitle: "Wire Rag Search",
      laneName: "Search Answer Path",
      statusLine: "Sources show before generate",
    });
  });
});
