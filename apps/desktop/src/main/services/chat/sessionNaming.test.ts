import { describe, expect, it, vi } from "vitest";

import { getAvailableModels, type ModelDescriptor } from "../../../shared/modelRegistry";
import {
  buildNamingModelCandidates,
  isProviderLevelNamingFailure,
  runNamingAcrossProviders,
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
});

describe("buildNamingModelCandidates", () => {
  it("always reaches a different provider so a single-provider outage cannot end naming", () => {
    const candidates = buildNamingModelCandidates({
      availableModels: ALL_MODELS,
      preferred: [OPENAI_MODELS[0]?.id, OPENAI_MODELS[1]?.id],
    });

    expect(candidates.slice(0, 2)).toEqual([OPENAI_MODELS[0]?.id, OPENAI_MODELS[1]?.id]);
    expect(candidates.some((id) => id.startsWith("anthropic/"))).toBe(true);
    expect(new Set(candidates).size).toBe(candidates.length);
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

    expect(result).toBe("Rename Naming Fallback");
    expect(attempted.filter((id) => id.startsWith("openai/"))).toHaveLength(1);
    expect(attempted.at(-1)?.startsWith("anthropic/")).toBe(true);
    expect(attemptCount).toBe(2);
    expect(selectedModelId).toBe(attempted.at(-1));
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure.mock.calls[0]![0]).toMatchObject({ providerLevelFailure: true });
  });

  it("advances to the next candidate when a model answers unusably", async () => {
    const attempted: string[] = [];
    const { result } = await runNamingAcrossProviders<string>(
      buildNamingModelCandidates({ availableModels: ALL_MODELS, preferred: [OPENAI_MODELS[0]?.id] }),
      {
        run: async (descriptor) => {
          attempted.push(descriptor.id);
          return attempted.length === 1 ? null : "Second Model Wins";
        },
        onFailure: vi.fn(),
      },
    );

    expect(attempted.length).toBeGreaterThan(1);
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
