import type { JobPayload, LlmGatewayConfig, LlmGatewayResult, PromptTemplate } from "./types";

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function coerceTextContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (typeof entry === "string") return entry;
        if (!entry || typeof entry !== "object") return "";
        const record = entry as Record<string, unknown>;
        const text = record.text;
        return typeof text === "string" ? text : "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

async function callOpenAi(config: LlmGatewayConfig, prompt: PromptTemplate): Promise<LlmGatewayResult> {
  if (!config.openaiApiKey) {
    throw new Error("OPENAI API key is not configured in the hosted secret");
  }

  const startedAt = Date.now();
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.openaiApiKey}`
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user }
      ],
      temperature: 0.2,
      max_tokens: config.maxOutputTokens
    }),
    signal: AbortSignal.timeout(300_000)
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI request failed (${response.status}): ${body}`);
  }

  const json = await response.json() as Record<string, unknown>;
  const choices = Array.isArray(json.choices) ? json.choices : [];
  const firstChoice = (choices[0] ?? null) as Record<string, unknown> | null;
  const message = firstChoice && typeof firstChoice === "object"
    ? (firstChoice.message as Record<string, unknown> | undefined)
    : undefined;
  const text = coerceTextContent(message?.content ?? "");

  if (!text.trim().length) {
    throw new Error("OpenAI returned an empty response");
  }

  const usage = (json.usage ?? {}) as Record<string, unknown>;
  const inputTokens = Number(usage.prompt_tokens ?? estimateTokens(`${prompt.system}\n${prompt.user}`));
  const outputTokens = Number(usage.completion_tokens ?? estimateTokens(text));

  return {
    text,
    provider: "openai",
    model: config.model,
    inputTokens,
    outputTokens,
    latencyMs: Date.now() - startedAt
  };
}

async function callAnthropic(config: LlmGatewayConfig, prompt: PromptTemplate): Promise<LlmGatewayResult> {
  if (!config.anthropicApiKey) {
    throw new Error("Anthropic API key is not configured in the hosted secret");
  }

  const startedAt = Date.now();
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": config.anthropicApiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: config.maxOutputTokens,
      temperature: 0.2,
      system: prompt.system,
      messages: [
        {
          role: "user",
          content: prompt.user
        }
      ]
    }),
    signal: AbortSignal.timeout(300_000)
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Anthropic request failed (${response.status}): ${body}`);
  }

  const json = await response.json() as Record<string, unknown>;
  const content = Array.isArray(json.content) ? json.content : [];
  const text = coerceTextContent(content);

  if (!text.trim().length) {
    throw new Error("Anthropic returned an empty response");
  }

  const usage = (json.usage ?? {}) as Record<string, unknown>;
  const inputTokens = Number(usage.input_tokens ?? estimateTokens(`${prompt.system}\n${prompt.user}`));
  const outputTokens = Number(usage.output_tokens ?? estimateTokens(text));

  return {
    text,
    provider: "anthropic",
    model: config.model,
    inputTokens,
    outputTokens,
    latencyMs: Date.now() - startedAt
  };
}

async function callGemini(config: LlmGatewayConfig, prompt: PromptTemplate): Promise<LlmGatewayResult> {
  if (!config.geminiApiKey) {
    throw new Error("Gemini API key is not configured in the hosted secret");
  }

  const startedAt = Date.now();
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.model)}:generateContent`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": config.geminiApiKey
    },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: prompt.system }]
      },
      contents: [
        {
          role: "user",
          parts: [{ text: prompt.user }]
        }
      ],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: config.maxOutputTokens
      }
    }),
    signal: AbortSignal.timeout(300_000)
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Gemini request failed (${response.status}): ${body}`);
  }

  const json = await response.json() as Record<string, unknown>;
  const candidates = Array.isArray(json.candidates) ? json.candidates : [];
  const firstCandidate = (candidates[0] ?? null) as Record<string, unknown> | null;
  const content = firstCandidate && typeof firstCandidate === "object"
    ? (firstCandidate.content as Record<string, unknown> | undefined)
    : undefined;
  const parts = Array.isArray(content?.parts) ? content.parts : [];
  const text = coerceTextContent(parts);

  if (!text.trim().length) {
    throw new Error("Gemini returned an empty response");
  }

  const usage = (json.usageMetadata ?? {}) as Record<string, unknown>;
  const inputTokens = Number(usage.promptTokenCount ?? estimateTokens(`${prompt.system}\n${prompt.user}`));
  const outputTokens = Number(usage.candidatesTokenCount ?? estimateTokens(text));

  return {
    text,
    provider: "gemini",
    model: config.model,
    inputTokens,
    outputTokens,
    latencyMs: Date.now() - startedAt
  };
}

function callMock(config: LlmGatewayConfig, prompt: PromptTemplate, job: JobPayload): LlmGatewayResult {
  const startedAt = Date.now();
  const lines = [
    `## ${job.type} (mock)` ,
    "",
    "Hosted LLM provider is set to mock mode.",
    "",
    "The following prompt was generated and can be used to validate infrastructure wiring:",
    "",
    "```text",
    prompt.user.slice(0, 6000),
    "```"
  ];

  const text = `${lines.join("\n")}\n`;
  return {
    text,
    provider: "mock",
    model: config.model,
    inputTokens: estimateTokens(`${prompt.system}\n${prompt.user}`),
    outputTokens: estimateTokens(text),
    latencyMs: Date.now() - startedAt
  };
}

export async function runLlmGateway(args: {
  job: JobPayload;
  prompt: PromptTemplate;
  config: LlmGatewayConfig;
}): Promise<LlmGatewayResult> {
  const { config, prompt, job } = args;
  const estimatedInput = estimateTokens(`${prompt.system}\n${prompt.user}`);
  if (estimatedInput > config.maxInputTokens) {
    throw new Error(
      `Input token budget exceeded (${estimatedInput} > ${config.maxInputTokens}) for job ${job.jobId}`
    );
  }

  if (config.provider === "openai") {
    return await callOpenAi(config, prompt);
  }

  if (config.provider === "anthropic") {
    return await callAnthropic(config, prompt);
  }

  if (config.provider === "gemini") {
    return await callGemini(config, prompt);
  }

  return callMock(config, prompt, job);
}
