import { randomUUID } from "node:crypto";
import { query, unstable_v2_createSession } from "@anthropic-ai/claude-agent-sdk";
import type { CanUseTool, ModelInfo, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentEvent,
  AgentExecutor,
  AgentModelDescriptor,
  ExecutorOpts
} from "./agentExecutor";
import { parseStructuredOutput } from "./utils";

const CLAUDE_MODEL_ALIASES = new Set(["opus", "sonnet", "haiku"]);
const CLAUDE_FULL_ID_TO_ALIAS: Record<string, "opus" | "sonnet" | "haiku"> = {
  "claude-opus-4-6": "opus",
  "claude-sonnet-4-6": "sonnet",
  "claude-haiku-4-5-20251001": "haiku"
};

const DEFAULT_CLAUDE_MODELS: AgentModelDescriptor[] = [
  { id: "opus", label: "Opus", description: "Highest reasoning quality" },
  { id: "sonnet", label: "Sonnet", description: "Balanced default" },
  { id: "haiku", label: "Haiku", description: "Fast and low-cost" }
];

function resolveClaudeModel(model: string | undefined): string {
  const requested = String(model ?? "").trim();
  if (!requested) return "sonnet";
  const normalized = requested.toLowerCase();
  if (CLAUDE_MODEL_ALIASES.has(normalized)) return normalized;
  return CLAUDE_FULL_ID_TO_ALIAS[normalized] ?? requested;
}

function mapPermissionMode(mode: ExecutorOpts["permissions"]["mode"]): "plan" | "acceptEdits" | "bypassPermissions" {
  if (mode === "read-only") return "plan";
  if (mode === "edit") return "acceptEdits";
  return "bypassPermissions";
}

function mapEffort(reasoningEffort: string | undefined): "low" | "medium" | "high" | "max" | undefined {
  if (reasoningEffort === "low" || reasoningEffort === "medium" || reasoningEffort === "high" || reasoningEffort === "max") {
    return reasoningEffort;
  }
  return undefined;
}

function toNullableNumber(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function mapCanUseTool(canUseTool: ExecutorOpts["permissions"]["canUseTool"]): CanUseTool | undefined {
  if (!canUseTool) return undefined;

  return async (toolName, input): Promise<PermissionResult> => {
    const approved = await canUseTool({
      name: toolName,
      args: input
    });

    if (approved) return { behavior: "allow" };
    return {
      behavior: "deny",
      message: `Tool '${toolName}' blocked by ADE policy.`,
      interrupt: false
    };
  };
}

export function createClaudeExecutor(): AgentExecutor {
  const listModels = async (): Promise<AgentModelDescriptor[]> => {
    try {
      const session = unstable_v2_createSession({
        model: "sonnet",
        permissionMode: "plan"
      }) as unknown as {
        supportedModels?: () => Promise<ModelInfo[]>;
        close: () => void;
      };

      try {
        if (typeof session.supportedModels !== "function") {
          return DEFAULT_CLAUDE_MODELS;
        }

        const discovered = await session.supportedModels();
        const models: AgentModelDescriptor[] = [];
        for (const entry of discovered) {
          const id = String(entry.value ?? "").trim();
          if (!id) continue;
          const label = String(entry.displayName ?? entry.value ?? id).trim() || id;
          const description = String(entry.description ?? "").trim();
          models.push({
            id,
            label,
            ...(description.length ? { description } : {})
          });
        }

        if (models.length > 0) return models;
      } finally {
        session.close();
      }
    } catch {
      // Fallback handled below.
    }

    return DEFAULT_CLAUDE_MODELS;
  };

  const runClaudeQuery = (args: {
    prompt: string;
    opts: ExecutorOpts;
    resumeSessionId?: string;
  }): AsyncIterable<AgentEvent> => {
    const { prompt, opts, resumeSessionId } = args;
    return {
      async *[Symbol.asyncIterator]() {
        const permissionMode = opts.providerConfig?.claude?.permissionMode ?? mapPermissionMode(opts.permissions.mode);
        const abortController = new AbortController();
        const timeoutMs = Math.max(1_000, Math.floor(opts.timeoutMs || 0));
        const timeoutHandle = setTimeout(() => abortController.abort(), timeoutMs);
        const modelId = resolveClaudeModel(opts.model);
        let resolvedSessionId = resumeSessionId ?? randomUUID();
        let inputTokens: number | null = null;
        let outputTokens: number | null = null;
        let finalText = "";
        let structuredOutput: unknown = null;

        const queryHandle = query({
          prompt,
          options: {
            model: modelId,
            ...(resumeSessionId ? { resume: resumeSessionId } : {}),
            permissionMode,
            effort: mapEffort(opts.reasoningEffort),
            outputFormat: opts.jsonSchema ? { type: "json_schema", schema: opts.jsonSchema as Record<string, unknown> } : undefined,
            cwd: opts.cwd,
            systemPrompt: opts.systemPrompt,
            settingSources: opts.providerConfig?.claude?.settingSources ?? [],
            allowedTools: opts.permissions.allowedTools,
            disallowedTools: opts.permissions.disallowedTools,
            canUseTool: mapCanUseTool(opts.permissions.canUseTool),
            maxBudgetUsd: opts.providerConfig?.claude?.maxBudgetUsd ?? opts.maxBudgetUsd,
            abortController
          }
        });

        try {
          for await (const message of queryHandle) {
            if (typeof message?.session_id === "string" && message.session_id.trim().length > 0) {
              resolvedSessionId = message.session_id;
            }

            if (message.type !== "result") {
              continue;
            }

            inputTokens = toNullableNumber(message.usage?.inputTokens);
            outputTokens = toNullableNumber(message.usage?.outputTokens);

            if (message.subtype !== "success") {
              const errorText = Array.isArray(message.errors) && message.errors.length > 0
                ? message.errors.join("; ")
                : `Claude query failed with subtype '${message.subtype}'.`;
              yield {
                type: "error",
                message: errorText
              } satisfies AgentEvent;
              return;
            }

            finalText = typeof message.result === "string" ? message.result : "";
            structuredOutput = message.structured_output ?? null;
          }

          if (finalText.trim().length > 0) {
            yield { type: "text", content: finalText } satisfies AgentEvent;
          }

          if (opts.jsonSchema) {
            if (structuredOutput != null) {
              yield { type: "structured_output", data: structuredOutput } satisfies AgentEvent;
            } else {
              const parsed = parseStructuredOutput(finalText);
              if (parsed != null) {
                yield { type: "structured_output", data: parsed } satisfies AgentEvent;
              }
            }
          }

          yield {
            type: "done",
            sessionId: resolvedSessionId,
            provider: "claude",
            model: modelId,
            usage: {
              inputTokens,
              outputTokens
            }
          } satisfies AgentEvent;
        } catch (error) {
          const message = abortController.signal.aborted
            ? `Claude execution timed out after ${timeoutMs}ms.`
            : error instanceof Error ? error.message : String(error);
          yield {
            type: "error",
            message
          } satisfies AgentEvent;
        } finally {
          clearTimeout(timeoutHandle);
          queryHandle.close();
        }
      }
    };
  };

  const execute = (prompt: string, opts: ExecutorOpts): AsyncIterable<AgentEvent> => {
    return runClaudeQuery({ prompt, opts });
  };

  return {
    provider: "claude",
    execute,
    resume(sessionId: string, prompt: string, opts: ExecutorOpts): AsyncIterable<AgentEvent> {
      return runClaudeQuery({
        prompt,
        opts,
        resumeSessionId: sessionId
      });
    },
    listModels
  };
}
