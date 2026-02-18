import type { ProviderMode } from "../../../shared/types";
import type { Logger } from "../logging/logger";
import type { createProjectConfigService } from "../config/projectConfigService";
import { redactSecrets } from "../../utils/redaction";

type ByokProvider = "openai" | "anthropic" | "gemini";

type ByokConfig = {
  provider: ByokProvider;
  model: string;
  apiKey: string;
};

type PromptTemplate = {
  system: string;
  user: string;
};

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asPrettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function parseConfidence(text: string): number | null {
  const match = text.match(/confidence\s*[:=]\s*([0-9]+(?:\.[0-9]+)?)(%?)/i);
  if (!match) return null;
  const raw = Number(match[1]);
  if (!Number.isFinite(raw)) return null;
  const isPercent = match[2] === "%";
  const confidence = isPercent ? raw / 100 : raw;
  if (confidence < 0 || confidence > 1) return null;
  return confidence;
}

function normalizeGeminiModel(model: string): string {
  const normalized = model.trim();
  if (!normalized) {
    throw new Error("BYOK Gemini model is missing. Set a valid Gemini model such as gemini-1.5-flash-latest.");
  }

  const withoutPrefix = normalized.startsWith("models/") ? normalized.slice("models/".length) : normalized;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(withoutPrefix) || !withoutPrefix.startsWith("gemini-")) {
    throw new Error("BYOK Gemini model should start with 'gemini-' (for example, gemini-1.5-flash-latest).");
  }

  return withoutPrefix;
}

function extractDiffPatch(text: string): string {
  const fence = text.match(/```diff\s*\n([\s\S]*?)\n```/i);
  if (fence?.[1]) return fence[1].trim() + "\n";
  return "";
}

function stripDiffFence(text: string): string {
  return text.replace(/```diff\s*\n[\s\S]*?\n```/gi, "").trim();
}

function buildPromptTemplate(kind: "narrative" | "pr-description" | "conflict", params: unknown): PromptTemplate {
  if (kind === "narrative") {
    return {
      system:
        "You are ADE's narrative writer. Produce concise, developer-facing markdown. Avoid marketing language. Never invent file names or commands.",
      user: [
        "Generate a lane narrative for this ADE lane context.",
        "Focus on what changed, risks, open questions, and recommended next checks.",
        "",
        "Return markdown with sections:",
        "## Summary",
        "## Key Changes",
        "## Risks",
        "## Suggested Next Steps",
        "",
        "Context JSON:",
        asPrettyJson(params)
      ].join("\\n")
    };
  }

  if (kind === "pr-description") {
    return {
      system:
        "You are ADE's PR drafting assistant. Return clear markdown that can be pasted into GitHub. Keep statements factual and tied to provided data.",
      user: [
        "Draft a PR description from this ADE project/lane context.",
        "",
        "Return markdown with sections:",
        "## Summary",
        "## What Changed",
        "## Validation",
        "## Risks",
        "",
        "Context JSON:",
        asPrettyJson(params)
      ].join("\\n")
    };
  }

  return {
    system:
      "You are ADE's conflict resolution assistant. Output a concise explanation plus a unified diff patch when possible. If resolution is uncertain, be explicit.",
    user: [
      "Generate a conflict resolution proposal.",
      "",
      "Return markdown with sections:",
      "## Resolution Strategy",
      "## Confidence",
      "## Patch",
      "",
      "Include a fenced code block with language 'diff' for the patch.",
      "",
      "Context JSON:",
      asPrettyJson(params)
    ].join("\\n")
  };
}

function parseByokConfig(providerMode: ProviderMode, rawProviders: unknown): ByokConfig {
  if (providerMode !== "byok") {
    throw new Error("BYOK provider mode is not enabled.");
  }

  const providers = isRecord(rawProviders) ? rawProviders : {};
  const byok = isRecord(providers.byok) ? providers.byok : {};

  const providerRaw = asString(byok.provider).trim().toLowerCase();
  if (providerRaw !== "openai" && providerRaw !== "anthropic" && providerRaw !== "gemini") {
    throw new Error("BYOK provider is invalid. Supported providers are: openai, anthropic, gemini.");
  }
  const provider = providerRaw as ByokProvider;

  const model = asString(byok.model).trim();
  const nextModel =
    provider === "gemini"
      ? normalizeGeminiModel(model)
      : model;

  const apiKey = asString(byok.apiKey).trim();

  if (!apiKey) throw new Error("BYOK API key is missing. Set it in Settings → Provider Mode (BYOK).");
  if (!nextModel) throw new Error("BYOK model is missing. Set it in Settings → Provider Mode (BYOK).");

  return {
    provider,
    model: nextModel,
    apiKey
  };
}

async function callOpenai(args: {
  apiKey: string;
  model: string;
  system: string;
  user: string;
  maxOutputTokens: number;
}): Promise<string> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${args.apiKey}`
    },
    body: JSON.stringify({
      model: args.model,
      messages: [
        { role: "system", content: args.system },
        { role: "user", content: args.user }
      ],
      temperature: 0.2,
      max_tokens: args.maxOutputTokens
    })
  });

  const json = (await res.json().catch(() => null)) as any;
  if (!res.ok) {
    const message = typeof json?.error?.message === "string" ? json.error.message : `OpenAI API error (${res.status})`;
    throw new Error(message);
  }

  const text = asString(json?.choices?.[0]?.message?.content);
  if (!text.trim()) throw new Error("OpenAI returned empty content.");
  return text;
}

async function callAnthropic(args: {
  apiKey: string;
  model: string;
  system: string;
  user: string;
  maxOutputTokens: number;
}): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": args.apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: args.model,
      system: args.system,
      max_tokens: args.maxOutputTokens,
      messages: [{ role: "user", content: args.user }]
    })
  });

  const json = (await res.json().catch(() => null)) as any;
  if (!res.ok) {
    const message = asString(json?.error?.message) || `Anthropic API error (${res.status})`;
    throw new Error(message);
  }

  const parts = Array.isArray(json?.content) ? json.content : [];
  const text = parts.map((p: any) => asString(p?.text)).join("").trim();
  if (!text.trim()) throw new Error("Anthropic returned empty content.");
  return text;
}

async function callGemini(args: {
  apiKey: string;
  model: string;
  system: string;
  user: string;
  maxOutputTokens: number;
}): Promise<string> {
  // Gemini API expects model name like "gemini-1.5-pro-latest" in the path.
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(args.model)}:generateContent?key=${encodeURIComponent(args.apiKey)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      systemInstruction: {
        role: "system",
        parts: [{ text: args.system }]
      },
      contents: [
        {
          role: "user",
          parts: [{ text: args.user }]
        }
      ],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: args.maxOutputTokens
      }
    })
  });

  const json = (await res.json().catch(() => null)) as any;
  if (!res.ok) {
    const message = asString(json?.error?.message) || `Gemini API error (${res.status})`;
    throw new Error(message);
  }

  const candidates = Array.isArray(json?.candidates) ? json.candidates : [];
  const parts = Array.isArray(candidates?.[0]?.content?.parts) ? candidates[0].content.parts : [];
  const text = parts.map((p: any) => asString(p?.text)).join("").trim();
  if (!text.trim()) throw new Error("Gemini returned empty content.");
  return text;
}

export function createByokLlmService({
  logger,
  projectConfigService
}: {
  logger: Logger;
  projectConfigService: ReturnType<typeof createProjectConfigService>;
}) {
  const generateText = async ({
    kind,
    params,
    maxOutputTokens
  }: {
    kind: "narrative" | "pr-description" | "conflict";
    params: unknown;
    maxOutputTokens: number;
  }): Promise<{ text: string; provider: ByokProvider; model: string }> => {
    const snapshot = projectConfigService.get().effective;
    const cfg = parseByokConfig(snapshot.providerMode ?? "guest", snapshot.providers);

    const prompt = buildPromptTemplate(kind, params);
    const redactedUser = redactSecrets(prompt.user);

    try {
      const text =
        cfg.provider === "openai"
          ? await callOpenai({
              apiKey: cfg.apiKey,
              model: cfg.model,
              system: prompt.system,
              user: redactedUser,
              maxOutputTokens
            })
          : cfg.provider === "anthropic"
            ? await callAnthropic({
                apiKey: cfg.apiKey,
                model: cfg.model,
                system: prompt.system,
                user: redactedUser,
                maxOutputTokens
              })
            : await callGemini({
                apiKey: cfg.apiKey,
                model: cfg.model,
                system: prompt.system,
                user: redactedUser,
                maxOutputTokens
              });

      return { text, provider: cfg.provider, model: cfg.model };
    } catch (error) {
      logger.warn("byok.llm_failed", {
        provider: cfg.provider,
        model: cfg.model,
        kind,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  };

  return {
    async generateLaneNarrative(args: {
      laneId: string;
      packBody: string;
    }): Promise<{ narrative: string; rawContent: string; provider: ByokProvider; model: string; confidence: number | null }> {
      const params = {
        laneId: args.laneId,
        packBody: args.packBody
      };
      const result = await generateText({ kind: "narrative", params, maxOutputTokens: 900 });
      return {
        narrative: result.text.trim() + "\n",
        rawContent: result.text,
        provider: result.provider,
        model: result.model,
        confidence: parseConfidence(result.text)
      };
    },

    async draftPrDescription(args: { laneId: string; prContext: unknown }): Promise<{ body: string; rawContent: string; provider: ByokProvider; model: string; confidence: number | null }> {
      const result = await generateText({ kind: "pr-description", params: args.prContext, maxOutputTokens: 1200 });
      return {
        body: result.text.trim() + "\n",
        rawContent: result.text,
        provider: result.provider,
        model: result.model,
        confidence: parseConfidence(result.text)
      };
    },

    async proposeConflictResolution(args: { laneId: string; peerLaneId: string | null; conflictContext: unknown }): Promise<{ diffPatch: string; explanation: string; rawContent: string; provider: ByokProvider; model: string; confidence: number | null }> {
      const params = {
        laneId: args.laneId,
        peerLaneId: args.peerLaneId,
        ...((isRecord(args.conflictContext) ? args.conflictContext : {}) as Record<string, unknown>)
      };
      const result = await generateText({ kind: "conflict", params, maxOutputTokens: 1600 });
      const diffPatch = extractDiffPatch(result.text);
      const explanation = stripDiffFence(result.text) || result.text.trim();
      return {
        diffPatch,
        explanation,
        rawContent: result.text,
        provider: result.provider,
        model: result.model,
        confidence: parseConfidence(result.text)
      };
    }
  };
}
