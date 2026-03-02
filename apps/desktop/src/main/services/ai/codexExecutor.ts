import { randomUUID } from "node:crypto";
import {
  type ApprovalMode,
  type CodexOptions,
  type SandboxMode,
  type ThreadItem,
  type ThreadOptions,
  type TurnOptions,
  type Usage
} from "@openai/codex-sdk";
import type {
  AgentEvent,
  AgentExecutor,
  AgentModelDescriptor,
  ExecutorOpts
} from "./agentExecutor";
import { parseStructuredOutput } from "./utils";

const DEFAULT_CODEX_MODELS: AgentModelDescriptor[] = [
  { id: "gpt-5.3-codex", label: "gpt-5.3-codex" },
  { id: "gpt-5.3-codex-spark", label: "gpt-5.3-codex-spark" },
  { id: "gpt-5.2-codex", label: "gpt-5.2-codex" },
  { id: "gpt-5.1-codex-max", label: "gpt-5.1-codex-max" },
  { id: "codex-mini-latest", label: "codex-mini-latest" },
  { id: "o4-mini", label: "o4-mini" },
  { id: "o3", label: "o3" }
];

type CodexOverrides = NonNullable<NonNullable<ExecutorOpts["providerConfig"]>["codex"]>;
type CodexSdkModule = typeof import("@openai/codex-sdk");

let codexSdkPromise: Promise<CodexSdkModule> | null = null;

function loadCodexSdk(): Promise<CodexSdkModule> {
  if (!codexSdkPromise) {
    // Keep a native dynamic import at runtime so CJS output can load the ESM-only SDK.
    const dynamicImport = new Function("specifier", "return import(specifier)") as
      (specifier: string) => Promise<CodexSdkModule>;
    codexSdkPromise = dynamicImport("@openai/codex-sdk");
  }
  return codexSdkPromise;
}

async function createCodexClient(options?: CodexOptions): Promise<InstanceType<CodexSdkModule["Codex"]>> {
  const sdk = await loadCodexSdk();
  return new sdk.Codex(options);
}

function mapSandbox(mode: ExecutorOpts["permissions"]["mode"]): SandboxMode {
  if (mode === "read-only") return "read-only";
  if (mode === "edit") return "workspace-write";
  return "danger-full-access";
}

function mapApproval(mode: ExecutorOpts["permissions"]["mode"]): ApprovalMode {
  if (mode === "read-only") return "untrusted";
  if (mode === "edit") return "on-request";
  return "never";
}

function toNumber(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function toText(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function mapToolItem(item: ThreadItem): AgentEvent[] {
  if (item.type === "command_execution") {
    const events: AgentEvent[] = [{ type: "tool_call", name: "command", args: { command: item.command } }];
    if (item.status === "completed" || item.status === "failed") {
      events.push({
        type: "tool_result",
        name: "command",
        result: {
          status: item.status,
          output: item.aggregated_output,
          exitCode: item.exit_code ?? null
        }
      });
    }
    return events;
  }

  if (item.type === "mcp_tool_call") {
    const events: AgentEvent[] = [{
      type: "tool_call",
      name: item.tool,
      args: item.arguments
    }];

    if (item.status === "completed" || item.status === "failed") {
      events.push({
        type: "tool_result",
        name: item.tool,
        result: item.status === "completed" ? item.result : item.error
      });
    }

    return events;
  }

  if (item.type === "file_change") {
    return [
      {
        type: "tool_result",
        name: "file_change",
        result: {
          status: item.status,
          changes: item.changes
        }
      }
    ];
  }

  return [];
}

function buildCodexConfig(overrides: CodexOverrides | undefined): CodexOptions["config"] {
  if (!overrides) return undefined;

  const config: NonNullable<CodexOptions["config"]> = {};
  const writablePaths = (overrides.writablePaths ?? []).map((entry) => String(entry).trim()).filter(Boolean);
  if (writablePaths.length) {
    config["sandbox_workspace_write.writable_roots"] = writablePaths;
  }

  const commandAllowlist = (overrides.commandAllowlist ?? []).map((entry) => String(entry).trim()).filter(Boolean);
  if (commandAllowlist.length) {
    config["tools.shell.allowlist"] = commandAllowlist;
  }

  return Object.keys(config).length ? config : undefined;
}

export function createCodexExecutor(): AgentExecutor {
  const listModels = async (): Promise<AgentModelDescriptor[]> => DEFAULT_CODEX_MODELS;

  const execute = (prompt: string, opts: ExecutorOpts): AsyncIterable<AgentEvent> => {
    return {
      async *[Symbol.asyncIterator]() {
        const codexConfig = buildCodexConfig(opts.providerConfig?.codex);
        const codex = await createCodexClient({
          ...(codexConfig ? { config: codexConfig } : {})
        });

        const codexOverrides = opts.providerConfig?.codex;
        const sandboxMode = codexOverrides?.sandboxPermissions ?? mapSandbox(opts.permissions.mode);
        const approvalPolicy = codexOverrides?.approvalMode ?? mapApproval(opts.permissions.mode);

        const threadOptions: ThreadOptions = {
          model: opts.model,
          sandboxMode,
          approvalPolicy,
          workingDirectory: opts.cwd,
          skipGitRepoCheck: false,
          ...(codexOverrides?.writablePaths?.length
            ? { additionalDirectories: codexOverrides.writablePaths }
            : {})
        };

        const thread = codex.startThread(threadOptions);
        const turnOptions: TurnOptions = {
          ...(opts.jsonSchema ? { outputSchema: opts.jsonSchema } : {})
        };

        const abortController = new AbortController();
        const timeout = Math.max(1_000, Math.floor(opts.timeoutMs || 0));
        const timeoutHandle = setTimeout(() => abortController.abort(), timeout);

        let sessionId: string = randomUUID();
        let usage: Usage | null = null;
        let finalText = "";

        try {
          const streamed = await thread.runStreamed(prompt, {
            ...turnOptions,
            signal: abortController.signal
          });

          for await (const event of streamed.events) {
            if (event.type === "thread.started") {
              sessionId = event.thread_id;
              continue;
            }

            if (event.type === "item.started" || event.type === "item.updated" || event.type === "item.completed") {
              const item = event.item;

              if (item.type === "agent_message") {
                const nextText = toText(item.text);
                if (nextText.length > finalText.length) {
                  const delta = nextText.slice(finalText.length);
                  if (delta.trim().length > 0) {
                    yield { type: "text", content: delta } satisfies AgentEvent;
                  }
                }
                finalText = nextText;
              }

              for (const mapped of mapToolItem(item)) {
                yield mapped;
              }

              continue;
            }

            if (event.type === "turn.completed") {
              usage = event.usage;
              continue;
            }

            if (event.type === "turn.failed") {
              yield {
                type: "error",
                message: event.error.message || "Codex turn failed."
              } satisfies AgentEvent;
            }

            if (event.type === "error") {
              yield {
                type: "error",
                message: event.message || "Codex stream failed."
              } satisfies AgentEvent;
            }
          }

          if (opts.jsonSchema) {
            const structured = parseStructuredOutput(finalText);
            if (structured != null) {
              yield { type: "structured_output", data: structured } satisfies AgentEvent;
            }
          }

          yield {
            type: "done",
            sessionId,
            provider: "codex",
            model: opts.model ?? null,
            usage: {
              inputTokens: toNumber(usage?.input_tokens),
              outputTokens: toNumber(usage?.output_tokens)
            }
          } satisfies AgentEvent;
        } catch (error) {
          yield {
            type: "error",
            message: error instanceof Error ? error.message : String(error)
          } satisfies AgentEvent;
        } finally {
          clearTimeout(timeoutHandle);
        }
      }
    };
  };

  return {
    provider: "codex",
    execute,
    resume(sessionId: string, prompt: string, opts: ExecutorOpts): AsyncIterable<AgentEvent> {
      return {
        async *[Symbol.asyncIterator]() {
          const codex = await createCodexClient();
          const thread = codex.resumeThread(sessionId, {
            model: opts.model,
            sandboxMode: opts.providerConfig?.codex?.sandboxPermissions ?? "workspace-write",
            approvalPolicy: opts.providerConfig?.codex?.approvalMode ?? "on-request"
          });

          try {
            const turn = await thread.run(prompt, {
              ...(opts.jsonSchema ? { outputSchema: opts.jsonSchema } : {})
            });

            if (turn.finalResponse.trim().length) {
              yield { type: "text", content: turn.finalResponse } satisfies AgentEvent;
            }

            yield {
              type: "done",
              sessionId: thread.id ?? sessionId,
              provider: "codex",
              model: opts.model ?? null,
              usage: {
                inputTokens: toNumber(turn.usage?.input_tokens),
                outputTokens: toNumber(turn.usage?.output_tokens)
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
    },
    listModels
  };
}
