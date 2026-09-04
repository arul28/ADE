import { describe, expect, it, vi } from "vitest";

import {
  BACKGROUND_UTILITY_CLAUDE_MODEL_ID,
  BACKGROUND_UTILITY_CODEX_MODEL_ID,
  BACKGROUND_UTILITY_CURSOR_MODEL_ID,
} from "../../../shared/backgroundUtilityModel";
import { getAvailableModels, type ModelDescriptor } from "../../../shared/modelRegistry";
import {
  buildNamingModelCandidates,
  buildSessionIntelligenceModelCandidates,
  buildSessionMetadataPrompt,
  buildSessionMetadataSystemPrompt,
  clipFromEnd,
  deriveDeterministicSessionMetadata,
  extractLatestAssistantParagraphs,
  isProviderLevelNamingFailure,
  parseGeneratedSessionMetadata,
  runNamingAcrossProviders,
  runSessionMetadataGeneration,
  SESSION_METADATA_SYSTEM_PROMPT,
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
  it("uses the cheap ADE-provider helper first and the session model second", () => {
    expect(buildSessionIntelligenceModelCandidates({
      availableModels: ALL_MODELS,
      provider: "claude",
      sessionModelId: OPENAI_MODELS[0]?.id,
    })).toEqual([BACKGROUND_UTILITY_CLAUDE_MODEL_ID, OPENAI_MODELS[0]?.id]);
    expect(buildSessionIntelligenceModelCandidates({
      availableModels: ALL_MODELS,
      provider: "codex",
      sessionModelId: ANTHROPIC_MODELS[0]?.id,
    })).toEqual([BACKGROUND_UTILITY_CODEX_MODEL_ID, ANTHROPIC_MODELS[0]?.id]);
  });

  it("does not spawn a Claude helper for OpenCode-wrapped Anthropic", () => {
    expect(buildSessionIntelligenceModelCandidates({
      availableModels: ALL_MODELS,
      provider: "opencode",
      sessionModelId: ANTHROPIC_MODELS[0]?.id,
    })).toEqual([ANTHROPIC_MODELS[0]?.id]);
  });

  it("injects Composer 2.5 for Cursor even when the auth snapshot has no Cursor inventory", () => {
    expect(buildSessionIntelligenceModelCandidates({
      availableModels: [],
      provider: "cursor",
      sessionModelId: "cursor/grok-4-5",
    })).toEqual([BACKGROUND_UTILITY_CURSOR_MODEL_ID, "cursor/grok-4-5"]);
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
      provider: "claude",
      sessionModel: "sonnet",
    })).toEqual([BACKGROUND_UTILITY_CLAUDE_MODEL_ID, "anthropic/claude-sonnet-5"]);
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

  it("reports the last attempt failure so the caller can name the real cause", async () => {
    const candidates = buildNamingModelCandidates({
      availableModels: ALL_MODELS,
      preferred: [OPENAI_MODELS[0]?.id, ANTHROPIC_MODELS[0]?.id],
    });

    const { result, lastFailure } = await runNamingAcrossProviders<string>(candidates, {
      run: async (descriptor) => {
        throw new Error(`no route for ${descriptor.id}`);
      },
      onFailure: vi.fn(),
    });

    expect(result).toBeNull();
    expect(lastFailure).toEqual({
      modelId: candidates[1],
      error: `no route for ${candidates[1]}`,
    });
  });

  it("clears the last failure once a later candidate answers", async () => {
    let attempts = 0;
    const { result, lastFailure } = await runNamingAcrossProviders<string>(
      buildNamingModelCandidates({
        availableModels: ALL_MODELS,
        preferred: [OPENAI_MODELS[0]?.id, ANTHROPIC_MODELS[0]?.id],
      }),
      {
        run: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("transient");
          return "Second Model Wins";
        },
        onFailure: vi.fn(),
      },
    );

    expect(result).toBe("Second Model Wins");
    expect(lastFailure).toBeNull();
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

describe("session metadata context helpers", () => {
  it("clips from the end so the latest work survives the prompt cap", () => {
    expect(clipFromEnd("abcdefghij", 4)).toBe("…(earlier omitted)\nghij");
    expect(clipFromEnd("short", 40)).toBe("short");
  });

  it("takes the last two or three assistant paragraphs for the status line", () => {
    expect(extractLatestAssistantParagraphs([
      { role: "user", text: "fix login" },
      { role: "assistant", text: "First look.\n\nOpened the auth store.\n\nWired the fallback and the tests are running." },
    ])).toBe("First look.\n\nOpened the auth store.\n\nWired the fallback and the tests are running.");
    expect(extractLatestAssistantParagraphs([
      { role: "assistant", text: "Intro.\n\nHunk one.\n\nHunk two.\n\nCurrently rebasing onto main." },
    ], 3)).toBe("Hunk one.\n\nHunk two.\n\nCurrently rebasing onto main.");
  });

  it("labels lane threads and git work as the sources for each field", () => {
    const prompt = buildSessionMetadataPrompt({
      provider: "cursor",
      chatModel: "grok-4.6",
      currentLaneName: "Old lane",
      currentChatTitle: "Old title",
      requestedFields: ["title", "laneName", "statusLine"],
      threadTranscript: "User: fix login\nAssistant: Wired the fallback.",
      latestAssistantParagraphs: "Wired the fallback.",
      laneThreads: "- Fix login (this thread)\n- Review auth tests",
      laneWorkVersusRemote: "Compared to origin/main:\nChanged files:\nM apps/desktop/src/auth.ts",
    });
    expect(prompt).toContain("source for chatTitle");
    expect(prompt).toContain("User: fix login");
    expect(prompt).toContain("source for statusLine");
    expect(prompt).toContain("Wired the fallback.");
    expect(prompt).toContain("source for laneName, together with git work");
    expect(prompt).toContain("Review auth tests");
    expect(prompt).toContain("Work on this lane that differs from remote");
    expect(prompt).toContain("apps/desktop/src/auth.ts");
  });

  it("sends a lean status-only prompt even when a full transcript and git dump are passed", () => {
    const prompt = buildSessionMetadataPrompt({
      provider: "cursor",
      chatModel: "grok-4.6",
      currentLaneName: "Auth fallback",
      currentChatTitle: "Desktop auth fallback",
      currentStatusLine: "Opened the auth store",
      worktreeName: "start-ctonext-skill-session-lane",
      requestedFields: ["statusLine"],
      goal: "should not appear",
      summary: "should not appear either",
      originalRequest: "start skill using aws other",
      threadTranscript: "User: rewrite every naming prompt\nAssistant: Looked at executeTask first.",
      latestAssistantParagraphs: "Wired the fallback and the tests are running.",
      laneThreads: "- Fix login (this thread)\n- Review auth tests",
      laneWorkVersusRemote: "Compared to origin/main:\nChanged files:\nM apps/desktop/src/auth.ts",
    });
    expect(prompt).toContain("long-running coding thread");
    expect(prompt).toContain("Users manage many threads");
    expect(prompt).toContain("Lane name: Auth fallback");
    expect(prompt).toContain("Worktree: start-ctonext-skill-session-lane");
    expect(prompt).toContain("Chat title: Desktop auth fallback");
    expect(prompt).toContain("Wired the fallback and the tests are running.");
    expect(prompt).toContain("Repeat the current chatTitle and laneName unchanged");
    expect(prompt).not.toContain("rewrite every naming prompt");
    expect(prompt).not.toContain("Review auth tests");
    expect(prompt).not.toContain("apps/desktop/src/auth.ts");
    expect(prompt).not.toContain("start skill using aws other");
    expect(prompt).not.toContain("source for chatTitle");
  });

  it("sends this thread's transcript for a title-only refresh and omits git work", () => {
    const prompt = buildSessionMetadataPrompt({
      provider: "cursor",
      chatModel: "grok-4.6",
      currentLaneName: "Auth fallback",
      currentChatTitle: "Old title",
      requestedFields: ["title"],
      threadTranscript: "User: fix login\nAssistant: Wired the fallback.",
      latestAssistantParagraphs: "Wired the fallback.",
      laneThreads: "- Review auth tests",
      laneWorkVersusRemote: "Compared to origin/main:\nChanged files:\nM apps/desktop/src/auth.ts",
    });
    expect(prompt).toContain("source for chatTitle");
    expect(prompt).toContain("User: fix login");
    expect(prompt).toContain("Repeat these current values unchanged: laneName, statusLine.");
    expect(prompt).not.toContain("source for statusLine");
    expect(prompt).not.toContain("Review auth tests");
    expect(prompt).not.toContain("differs from remote");
  });
});

describe("buildSessionMetadataSystemPrompt", () => {
  it("keeps the all-three namer instructions when every field is requested", () => {
    expect(buildSessionMetadataSystemPrompt(["title", "laneName", "statusLine"]))
      .toBe(SESSION_METADATA_SYSTEM_PROMPT);
    expect(buildSessionMetadataSystemPrompt()).toBe(SESSION_METADATA_SYSTEM_PROMPT);
  });

  it("tells a status-only namer to copy the current title and lane name", () => {
    const systemPrompt = buildSessionMetadataSystemPrompt(["statusLine"]);
    expect(systemPrompt).toContain("Users scan many threads at once");
    expect(systemPrompt).toContain("Write new values for: statusLine.");
    expect(systemPrompt).toContain("Copy these current values unchanged: chatTitle, laneName.");
    expect(systemPrompt).toContain("Derive this only from the latest assistant output");
    expect(systemPrompt).not.toContain("every thread in this lane");
    expect(systemPrompt).not.toContain("full conversation transcript");
  });
});
