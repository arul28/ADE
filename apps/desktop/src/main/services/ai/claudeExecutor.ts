import { randomUUID } from "node:crypto";
import { generateText } from "ai";
import { createClaudeCode, type ClaudeCodeSettings } from "ai-sdk-provider-claude-code";
import { unstable_v2_createSession } from "@anthropic-ai/claude-agent-sdk";
import type { CanUseTool, ModelInfo, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentEvent,
  AgentExecutor,
  AgentModelDescriptor,
  ExecutorOpts
} from "./agentExecutor";
import { parseStructuredOutput, withTimeout } from "./utils";

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

function mapPermissionMode(mode: ExecutorOpts["permissions"]["mode"]): ClaudeCodeSettings["permissionMode"] {
  if (mode === "read-only") return "plan";
  if (mode === "edit") return "acceptEdits";
  return "bypassPermissions";
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
  const provider = createClaudeCode();

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

  const execute = (prompt: string, opts: ExecutorOpts): AsyncIterable<AgentEvent> => {
    return {
      async *[Symbol.asyncIterator]() {
        const sessionId = randomUUID();
        const permissionMode = opts.providerConfig?.claude?.permissionMode ?? mapPermissionMode(opts.permissions.mode);
        const sandboxEnabled = opts.providerConfig?.claude?.sandbox;
        const mergedSettings: ClaudeCodeSettings = {
          cwd: opts.cwd,
          permissionMode,
          systemPrompt: opts.systemPrompt,
          settingSources: opts.providerConfig?.claude?.settingSources ?? [],
          allowedTools: opts.permissions.allowedTools,
          disallowedTools: opts.permissions.disallowedTools,
          canUseTool: mapCanUseTool(opts.permissions.canUseTool),
          maxBudgetUsd: opts.providerConfig?.claude?.maxBudgetUsd ?? opts.maxBudgetUsd,
          ...(sandboxEnabled != null ? { sandbox: { enabled: sandboxEnabled } } : {}),
          hooks: opts.providerConfig?.claude?.hooks as ClaudeCodeSettings["hooks"]
        };

        const modelId = resolveClaudeModel(opts.model);

        try {
          const operation = generateText({
            model: provider(modelId as any, mergedSettings),
            system: opts.systemPrompt,
            prompt
          });

          const result = await withTimeout(
            operation,
            opts.timeoutMs,
            `Claude execution timed out after ${opts.timeoutMs}ms.`
          );

          const text = String(result.text ?? "");
          if (text.trim().length > 0) {
            yield { type: "text", content: text } satisfies AgentEvent;
          }

          if (opts.jsonSchema) {
            const structured = parseStructuredOutput(text);
            if (structured != null) {
              yield { type: "structured_output", data: structured } satisfies AgentEvent;
            }
          }

          yield {
            type: "done",
            sessionId,
            provider: "claude",
            model: modelId,
            usage: {
              inputTokens: result.usage?.inputTokens ?? null,
              outputTokens: result.usage?.outputTokens ?? null
            }
          } satisfies AgentEvent;
        } catch (error) {
          yield {
            type: "error",
            message: error instanceof Error ? error.message : String(error)
          } satisfies AgentEvent;
        }
      }
    };
  };

  return {
    provider: "claude",
    execute,
    resume(sessionId: string): AsyncIterable<AgentEvent> {
      return {
        async *[Symbol.asyncIterator]() {
          yield {
            type: "error",
            message: `Claude session resume is not implemented for session '${sessionId}'.`
          } satisfies AgentEvent;
        }
      };
    },
    listModels
  };
}
