export type AgentProvider = "claude" | "codex" | "cursor" | "droid";

export type AgentPermissionMode = "read-only" | "edit" | "full-auto";

export type AgentSandboxLevel = "strict" | "workspace" | "unrestricted";

export type AgentToolInvocation = {
  name: string;
  args: unknown;
};

export type ClaudeProviderOverrides = {
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan";
  settingSources?: Array<"user" | "project" | "local">;
  hooks?: Record<string, unknown>;
  sandbox?: boolean;
  maxBudgetUsd?: number;
};

export type CodexProviderOverrides = {
  approvalMode?: "untrusted" | "on-request" | "on-failure" | "never";
  sandboxPermissions?: "read-only" | "workspace-write" | "danger-full-access";
  writablePaths?: string[];
  commandAllowlist?: string[];
};

export type ExecutorOpts = {
  cwd: string;
  systemPrompt?: string;
  jsonSchema?: unknown;
  model?: string;
  reasoningEffort?: string;
  timeoutMs: number;
  maxBudgetUsd?: number;
  oneShot?: boolean;
  permissions: {
    mode: AgentPermissionMode;
    allowedTools?: string[];
    disallowedTools?: string[];
    canUseTool?: (invocation: AgentToolInvocation) => boolean | Promise<boolean>;
    sandboxLevel?: AgentSandboxLevel;
  };
  providerConfig?: {
    claude?: ClaudeProviderOverrides;
    codex?: CodexProviderOverrides;
  };
};

export type AgentEvent =
  | { type: "text"; content: string }
  | { type: "activity"; activity: "thinking" | "editing_file" | "running_command" | "searching" | "reading" | "tool_calling"; detail?: string }
  | { type: "step_boundary"; stepNumber: number }
  | { type: "tool_call"; name: string; args: unknown }
  | { type: "tool_result"; name: string; result: unknown }
  | { type: "structured_output"; data: unknown }
  | { type: "error"; message: string }
  | {
      type: "done";
      sessionId: string;
      modelId?: string;
      usage?: {
        inputTokens?: number | null;
        outputTokens?: number | null;
      };
      model?: string | null;
      provider?: AgentProvider;
    };

export type AgentModelDescriptor = {
  id: string;
  label: string;
  description?: string;
};

export interface AgentExecutor {
  readonly provider: AgentProvider;
  execute(prompt: string, opts: ExecutorOpts): AsyncIterable<AgentEvent>;
  resume(sessionId: string, prompt: string, opts: ExecutorOpts): AsyncIterable<AgentEvent>;
  listModels?(): Promise<AgentModelDescriptor[]>;
}

// Re-export unified executor types for callers migrating to the new path.
export type { UnifiedExecutorOpts } from "./unifiedExecutor";
