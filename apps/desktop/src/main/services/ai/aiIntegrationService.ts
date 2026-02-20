import { randomUUID } from "node:crypto";
import type { Logger } from "../logging/logger";
import type { AdeDb } from "../state/kvDb";
import type { createProjectConfigService } from "../config/projectConfigService";
import type { AgentModelDescriptor, AgentProvider, ExecutorOpts } from "./agentExecutor";
import { createClaudeExecutor } from "./claudeExecutor";
import { createCodexExecutor } from "./codexExecutor";
import { commandExists } from "./utils";

export type AiTaskType =
  | "planning"
  | "implementation"
  | "review"
  | "conflict_resolution"
  | "narrative"
  | "pr_description"
  | "terminal_summary"
  | "mission_planning"
  | "initial_context";

export type AiFeatureKey =
  | "narratives"
  | "conflict_proposals"
  | "pr_descriptions"
  | "terminal_summaries"
  | "mission_planning"
  | "orchestrator"
  | "initial_context";

export type AiProviderMode = "guest" | "subscription";

export type AiIntegrationStatus = {
  mode: AiProviderMode;
  availableProviders: {
    claude: boolean;
    codex: boolean;
  };
  models: {
    claude: AgentModelDescriptor[];
    codex: AgentModelDescriptor[];
  };
};

export type ExecuteAiTaskArgs = {
  feature: AiFeatureKey;
  taskType: AiTaskType;
  prompt: string;
  cwd: string;
  provider?: AgentProvider;
  jsonSchema?: unknown;
  systemPrompt?: string;
  timeoutMs?: number;
  model?: string;
  permissionMode?: ExecutorOpts["permissions"]["mode"];
  oneShot?: boolean;
};

export type ExecuteAiTaskResult = {
  text: string;
  structuredOutput: unknown;
  provider: AgentProvider;
  model: string | null;
  sessionId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number;
};

type RuntimeTaskDefaults = {
  provider: AgentProvider;
  model: string;
  timeoutMs: number;
  permissionMode: ExecutorOpts["permissions"]["mode"];
};

const TASK_DEFAULTS: Record<AiTaskType, RuntimeTaskDefaults> = {
  planning: {
    provider: "claude",
    model: "sonnet",
    timeoutMs: 45_000,
    permissionMode: "read-only"
  },
  implementation: {
    provider: "codex",
    model: "gpt-5.3-codex",
    timeoutMs: 120_000,
    permissionMode: "edit"
  },
  review: {
    provider: "claude",
    model: "sonnet",
    timeoutMs: 30_000,
    permissionMode: "read-only"
  },
  conflict_resolution: {
    provider: "claude",
    model: "sonnet",
    timeoutMs: 60_000,
    permissionMode: "read-only"
  },
  narrative: {
    provider: "claude",
    model: "haiku",
    timeoutMs: 45_000,
    permissionMode: "read-only"
  },
  pr_description: {
    provider: "claude",
    model: "haiku",
    timeoutMs: 30_000,
    permissionMode: "read-only"
  },
  terminal_summary: {
    provider: "claude",
    model: "haiku",
    timeoutMs: 20_000,
    permissionMode: "read-only"
  },
  mission_planning: {
    provider: "claude",
    model: "sonnet",
    timeoutMs: 45_000,
    permissionMode: "read-only"
  },
  initial_context: {
    provider: "claude",
    model: "sonnet",
    timeoutMs: 45_000,
    permissionMode: "read-only"
  }
};

const CODEX_FALLBACK_MODELS: AgentModelDescriptor[] = [
  { id: "gpt-5.3-codex", label: "gpt-5.3-codex" },
  { id: "gpt-5.2-codex", label: "gpt-5.2-codex" },
  { id: "gpt-5.1-codex-max", label: "gpt-5.1-codex-max" },
  { id: "codex-mini-latest", label: "codex-mini-latest" },
  { id: "o4-mini", label: "o4-mini" },
  { id: "o3", label: "o3" }
];

type ClaudeProviderConfig = NonNullable<NonNullable<ExecutorOpts["providerConfig"]>["claude"]>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function toStringOrNull(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length ? text : null;
}

function toNumberOrNull(value: unknown): number | null {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function toPositiveNumberOrUndefined(value: unknown): number | undefined {
  const num = toNumberOrNull(value);
  return num != null && num > 0 ? num : undefined;
}

function toTextPreview(value: string, maxChars = 800): string {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}…`;
}

function toJsonPreview(value: unknown, maxChars = 800): string | null {
  if (value == null) return null;
  try {
    return toTextPreview(JSON.stringify(value), maxChars);
  } catch {
    return toTextPreview(String(value), maxChars);
  }
}

function startOfDayIso(now = new Date()): string {
  const utc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0);
  return new Date(utc).toISOString();
}

function extractTaskRouting(snapshot: ReturnType<ReturnType<typeof createProjectConfigService>["get"]>): Record<string, unknown> {
  if (isRecord(snapshot.effective.ai) && isRecord(snapshot.effective.ai.taskRouting)) {
    return snapshot.effective.ai.taskRouting;
  }

  // Backward compatibility for older config shape.
  const providers = isRecord(snapshot.effective.providers) ? snapshot.effective.providers : {};
  const legacyAi = isRecord(providers.ai) ? providers.ai : {};
  if (isRecord(legacyAi.taskRouting)) {
    return legacyAi.taskRouting;
  }

  return {};
}

function extractAiConfig(snapshot: ReturnType<ReturnType<typeof createProjectConfigService>["get"]>): Record<string, unknown> {
  if (isRecord(snapshot.effective.ai)) return snapshot.effective.ai;
  const providers = isRecord(snapshot.effective.providers) ? snapshot.effective.providers : {};
  const legacyAi = isRecord(providers.ai) ? providers.ai : {};
  return legacyAi;
}

function extractTaskOverride(snapshot: ReturnType<ReturnType<typeof createProjectConfigService>["get"]>, taskType: AiTaskType): Record<string, unknown> {
  const routing = extractTaskRouting(snapshot);
  return isRecord(routing[taskType]) ? (routing[taskType] as Record<string, unknown>) : {};
}

function mapClaudePermission(mode: string | null): ExecutorOpts["permissions"]["mode"] {
  if (mode === "acceptEdits") return "edit";
  if (mode === "bypassPermissions") return "full-auto";
  return "read-only";
}

function mapCodexPermission(args: {
  sandboxPermissions: string | null;
  approvalMode: string | null;
}): ExecutorOpts["permissions"]["mode"] {
  if (args.sandboxPermissions === "danger-full-access" || args.approvalMode === "never") return "full-auto";
  if (args.sandboxPermissions === "workspace-write" || args.approvalMode === "on-request" || args.approvalMode === "on-failure") {
    return "edit";
  }
  return "read-only";
}

function parseClaudeSettingSources(value: unknown): Array<"user" | "project" | "local"> | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized = value.filter(
    (entry): entry is "user" | "project" | "local" =>
      entry === "user" || entry === "project" || entry === "local"
  );
  return normalized.length > 0 ? normalized : undefined;
}

export function createAiIntegrationService(args: {
  db: AdeDb;
  logger: Logger;
  projectConfigService: ReturnType<typeof createProjectConfigService>;
}) {
  const { db, logger, projectConfigService } = args;

  const executors = {
    claude: createClaudeExecutor(),
    codex: createCodexExecutor()
  };

  const getAvailability = () => ({
    claude: commandExists("claude"),
    codex: commandExists("codex")
  });

  const getMode = (): AiProviderMode => {
    const snapshot = projectConfigService.get();
    return snapshot.effective.providerMode === "subscription" ? "subscription" : "guest";
  };

  const getFeatureFlag = (feature: AiFeatureKey): boolean => {
    const snapshot = projectConfigService.get();
    const aiConfig = extractAiConfig(snapshot);
    const features = isRecord(aiConfig.features) ? aiConfig.features : {};
    const value = features[feature];
    return value == null ? true : Boolean(value);
  };

  const getDailyBudgetLimit = (feature: AiFeatureKey): number | null => {
    const snapshot = projectConfigService.get();
    const aiConfig = extractAiConfig(snapshot);
    const budgets = isRecord(aiConfig.budgets) ? aiConfig.budgets : {};
    const entry = isRecord(budgets[feature]) ? (budgets[feature] as Record<string, unknown>) : {};

    const daily = toNumberOrNull(entry.dailyLimit) ?? toNumberOrNull(entry.daily_limit);
    if (daily == null || daily <= 0) return null;
    return daily;
  };

  const countDailyUsage = (feature: AiFeatureKey): number => {
    const row = db.get<{ count: number }>(
      `
        select count(*) as count
        from ai_usage_log
        where feature = ?
          and timestamp >= ?
          and success = 1
      `,
      [feature, startOfDayIso()]
    );

    return Number(row?.count ?? 0);
  };

  const checkBudget = (feature: AiFeatureKey): void => {
    const limit = getDailyBudgetLimit(feature);
    if (limit == null) return;

    const used = countDailyUsage(feature);
    if (used >= limit) {
      throw new Error(`Daily AI budget reached for '${feature}' (${used}/${limit}).`);
    }
  };

  const logUsage = (args: {
    feature: AiFeatureKey;
    provider: AgentProvider;
    model: string | null;
    inputTokens: number | null;
    outputTokens: number | null;
    durationMs: number;
    success: boolean;
    sessionId: string | null;
  }) => {
    db.run(
      `
        insert into ai_usage_log(
          id,
          timestamp,
          feature,
          provider,
          model,
          input_tokens,
          output_tokens,
          duration_ms,
          success,
          session_id
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        randomUUID(),
        new Date().toISOString(),
        args.feature,
        args.provider,
        args.model,
        args.inputTokens,
        args.outputTokens,
        Math.max(0, Math.floor(args.durationMs)),
        args.success ? 1 : 0,
        args.sessionId
      ]
    );
  };

  const resolveProviderForTask = (taskType: AiTaskType, providerHint?: AgentProvider | null): AgentProvider => {
    const snapshot = projectConfigService.get();
    const defaults = TASK_DEFAULTS[taskType];
    const override = extractTaskOverride(snapshot, taskType);

    const preferred = providerHint ?? toStringOrNull(override.provider);
    const normalizedPreferred = preferred?.toLowerCase() ?? "";

    const availability = getAvailability();

    const preferredProvider =
      normalizedPreferred === "claude" || normalizedPreferred === "codex"
        ? (normalizedPreferred as AgentProvider)
        : defaults.provider;

    if (preferredProvider === "claude" && availability.claude) return "claude";
    if (preferredProvider === "codex" && availability.codex) return "codex";
    if (availability.claude) return "claude";
    if (availability.codex) return "codex";

    throw new Error("No compatible AI CLI provider detected. Install and authenticate Claude Code and/or Codex.");
  };

  const buildExecutorOpts = (args: {
    taskType: AiTaskType;
    provider: AgentProvider;
    cwd: string;
    model?: string;
    timeoutMs?: number;
    systemPrompt?: string;
    jsonSchema?: unknown;
    permissionMode?: ExecutorOpts["permissions"]["mode"];
    oneShot?: boolean;
  }): ExecutorOpts => {
    const snapshot = projectConfigService.get();
    const defaults = TASK_DEFAULTS[args.taskType];
    const taskOverride = extractTaskOverride(snapshot, args.taskType);
    const aiConfig = extractAiConfig(snapshot);

    const model =
      toStringOrNull(args.model) ??
      toStringOrNull(taskOverride.model) ??
      defaults.model;

    const timeoutMs =
      toNumberOrNull(args.timeoutMs) ??
      toNumberOrNull(taskOverride.timeoutMs) ??
      toNumberOrNull(taskOverride.timeout_ms) ??
      defaults.timeoutMs;

    const permissions = isRecord(aiConfig.permissions) ? (aiConfig.permissions as Record<string, unknown>) : {};
    const claudePermissions = isRecord(permissions.claude) ? (permissions.claude as Record<string, unknown>) : {};
    const codexPermissions = isRecord(permissions.codex) ? (permissions.codex as Record<string, unknown>) : {};

    const permissionMode = (() => {
      if (args.permissionMode) return args.permissionMode;
      if (args.provider === "claude") {
        return mapClaudePermission(toStringOrNull(claudePermissions.permissionMode) ?? toStringOrNull(claudePermissions.permission_mode));
      }
      return mapCodexPermission({
        sandboxPermissions: toStringOrNull(codexPermissions.sandboxPermissions) ?? toStringOrNull(codexPermissions.sandbox_permissions),
        approvalMode: toStringOrNull(codexPermissions.approvalMode) ?? toStringOrNull(codexPermissions.approval_mode)
      });
    })();

    const claudeMaxBudgetUsd =
      toPositiveNumberOrUndefined(claudePermissions.maxBudgetUsd) ??
      toPositiveNumberOrUndefined(claudePermissions.max_budget_usd);

    return {
      cwd: args.cwd,
      model,
      timeoutMs: Math.max(1_000, Math.floor(timeoutMs)),
      systemPrompt: args.systemPrompt,
      jsonSchema: args.jsonSchema,
      oneShot: args.oneShot,
      maxBudgetUsd: claudeMaxBudgetUsd,
      permissions: {
        mode: permissionMode,
        allowedTools: undefined,
        disallowedTools: undefined
      },
      providerConfig: {
        claude: {
          permissionMode: toStringOrNull(claudePermissions.permissionMode) as ClaudeProviderConfig["permissionMode"],
          settingSources:
            parseClaudeSettingSources(claudePermissions.settingSources) ??
            parseClaudeSettingSources(claudePermissions.settings_sources),
          sandbox: claudePermissions.sandbox === true,
          maxBudgetUsd: claudeMaxBudgetUsd
        },
        codex: {
          approvalMode:
            (toStringOrNull(codexPermissions.approvalMode) ?? toStringOrNull(codexPermissions.approval_mode)) as
              | "untrusted"
              | "on-request"
              | "on-failure"
              | "never"
              | undefined,
          sandboxPermissions:
            (toStringOrNull(codexPermissions.sandboxPermissions) ?? toStringOrNull(codexPermissions.sandbox_permissions)) as
              | "read-only"
              | "workspace-write"
              | "danger-full-access"
              | undefined,
          writablePaths: Array.isArray(codexPermissions.writablePaths)
            ? codexPermissions.writablePaths.map((entry) => String(entry))
            : Array.isArray(codexPermissions.writable_paths)
              ? codexPermissions.writable_paths.map((entry) => String(entry))
              : [],
          commandAllowlist: Array.isArray(codexPermissions.commandAllowlist)
            ? codexPermissions.commandAllowlist.map((entry) => String(entry))
            : Array.isArray(codexPermissions.command_allowlist)
              ? codexPermissions.command_allowlist.map((entry) => String(entry))
              : []
        }
      }
    };
  };

  const executeTask = async (args: ExecuteAiTaskArgs): Promise<ExecuteAiTaskResult> => {
    const requestId = randomUUID();
    if (getMode() === "guest") {
      logger.warn("ai.task.skipped_guest_mode", {
        requestId,
        taskType: args.taskType,
        feature: args.feature
      });
      throw new Error("No AI provider is available. Install and authenticate Claude Code and/or Codex CLI.");
    }

    if (!getFeatureFlag(args.feature)) {
      logger.warn("ai.task.skipped_feature_disabled", {
        requestId,
        taskType: args.taskType,
        feature: args.feature
      });
      throw new Error(`AI feature '${args.feature}' is disabled in settings.`);
    }

    checkBudget(args.feature);

    const provider = resolveProviderForTask(args.taskType, args.provider ?? null);
    const executor = executors[provider];
    const opts = buildExecutorOpts({
      taskType: args.taskType,
      provider,
      cwd: args.cwd,
      model: args.model,
      timeoutMs: args.timeoutMs,
      systemPrompt: args.systemPrompt,
      jsonSchema: args.jsonSchema,
      permissionMode: args.permissionMode,
      oneShot: args.oneShot
    });

    logger.info("ai.task.begin", {
      requestId,
      taskType: args.taskType,
      feature: args.feature,
      provider,
      model: opts.model ?? null,
      timeoutMs: opts.timeoutMs,
      permissionMode: opts.permissions.mode,
      oneShot: opts.oneShot === true,
      hasJsonSchema: opts.jsonSchema != null,
      promptChars: args.prompt.length,
      promptPreview: toTextPreview(args.prompt),
      claude: provider === "claude"
        ? {
            permissionMode: opts.providerConfig?.claude?.permissionMode ?? null,
            settingSources: opts.providerConfig?.claude?.settingSources ?? [],
            sandbox: opts.providerConfig?.claude?.sandbox ?? null,
            maxBudgetUsd: opts.providerConfig?.claude?.maxBudgetUsd ?? null
          }
        : null,
      codex: provider === "codex"
        ? {
            sandboxPermissions: opts.providerConfig?.codex?.sandboxPermissions ?? null,
            approvalMode: opts.providerConfig?.codex?.approvalMode ?? null,
            writablePaths: opts.providerConfig?.codex?.writablePaths?.length ?? 0,
            commandAllowlist: opts.providerConfig?.codex?.commandAllowlist?.length ?? 0
          }
        : null
    });

    const startedAt = Date.now();
    let sessionId: string | null = null;
    let resolvedModel: string | null = opts.model ?? null;
    let inputTokens: number | null = null;
    let outputTokens: number | null = null;
    let text = "";
    let structuredOutput: unknown = null;

    try {
      for await (const event of executor.execute(args.prompt, opts)) {
        if (event.type === "text") {
          text += event.content;
          continue;
        }
        if (event.type === "structured_output") {
          structuredOutput = event.data;
          continue;
        }
        if (event.type === "error") {
          throw new Error(event.message || "AI execution failed.");
        }
        if (event.type === "done") {
          sessionId = event.sessionId;
          resolvedModel = event.model ?? resolvedModel;
          inputTokens = toNumberOrNull(event.usage?.inputTokens ?? null);
          outputTokens = toNumberOrNull(event.usage?.outputTokens ?? null);
        }
      }

      const durationMs = Date.now() - startedAt;
      logUsage({
        feature: args.feature,
        provider,
        model: resolvedModel,
        inputTokens,
        outputTokens,
        durationMs,
        success: true,
        sessionId
      });

      logger.info("ai.task.done", {
        requestId,
        taskType: args.taskType,
        feature: args.feature,
        provider,
        model: resolvedModel,
        sessionId,
        durationMs,
        inputTokens,
        outputTokens,
        textChars: text.length,
        textPreview: toTextPreview(text),
        structuredOutputPreview: toJsonPreview(structuredOutput)
      });

      return {
        text,
        structuredOutput,
        provider,
        model: resolvedModel,
        sessionId,
        inputTokens,
        outputTokens,
        durationMs
      };
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      logUsage({
        feature: args.feature,
        provider,
        model: resolvedModel,
        inputTokens,
        outputTokens,
        durationMs,
        success: false,
        sessionId
      });

      logger.warn("ai.task.failed", {
        requestId,
        taskType: args.taskType,
        provider,
        feature: args.feature,
        model: resolvedModel,
        sessionId,
        durationMs,
        inputTokens,
        outputTokens,
        partialTextChars: text.length,
        partialTextPreview: toTextPreview(text),
        structuredOutputPreview: toJsonPreview(structuredOutput),
        promptChars: args.prompt.length,
        promptPreview: toTextPreview(args.prompt),
        error: error instanceof Error ? error.message : String(error)
      });

      throw error;
    }
  };

  const listModels = async (provider: AgentProvider): Promise<AgentModelDescriptor[]> => {
    const executor = executors[provider];
    if (!executor.listModels) {
      return provider === "codex" ? CODEX_FALLBACK_MODELS : [];
    }

    try {
      const models = await executor.listModels();
      if (models.length) return models;
    } catch {
      // fallback below
    }

    return provider === "codex" ? CODEX_FALLBACK_MODELS : [];
  };

  return {
    getMode,

    getStatus: async (): Promise<AiIntegrationStatus> => {
      const availability = getAvailability();
      return {
        mode: getMode(),
        availableProviders: availability,
        models: {
          claude: availability.claude ? await listModels("claude") : [],
          codex: availability.codex ? await listModels("codex") : CODEX_FALLBACK_MODELS
        }
      };
    },

    executeTask,

    listModels,

    getFeatureFlag,

    getDailyUsage(feature: AiFeatureKey): number {
      return countDailyUsage(feature);
    },

    getDailyBudgetLimit,

    getAvailability,

    // Backward-compatible convenience methods used by migrated services.
    async generateNarrative(args: {
      laneId: string;
      cwd: string;
      prompt: string;
      timeoutMs?: number;
      model?: string;
    }): Promise<ExecuteAiTaskResult> {
      return await executeTask({
        feature: "narratives",
        taskType: "narrative",
        prompt: args.prompt,
        cwd: args.cwd,
        timeoutMs: args.timeoutMs,
        model: args.model,
        permissionMode: "read-only",
        oneShot: true
      });
    },

    async requestConflictProposal(args: {
      laneId: string;
      cwd: string;
      prompt: string;
      timeoutMs?: number;
      model?: string;
      jsonSchema?: unknown;
    }): Promise<ExecuteAiTaskResult> {
      return await executeTask({
        feature: "conflict_proposals",
        taskType: "conflict_resolution",
        prompt: args.prompt,
        cwd: args.cwd,
        timeoutMs: args.timeoutMs,
        model: args.model,
        jsonSchema: args.jsonSchema,
        permissionMode: "read-only",
        oneShot: true
      });
    },

    async draftPrDescription(args: {
      laneId: string;
      cwd: string;
      prompt: string;
      timeoutMs?: number;
      model?: string;
    }): Promise<ExecuteAiTaskResult> {
      return await executeTask({
        feature: "pr_descriptions",
        taskType: "pr_description",
        prompt: args.prompt,
        cwd: args.cwd,
        timeoutMs: args.timeoutMs,
        model: args.model,
        permissionMode: "read-only",
        oneShot: true
      });
    },

    async summarizeTerminal(args: {
      cwd: string;
      prompt: string;
      timeoutMs?: number;
      model?: string;
      jsonSchema?: unknown;
    }): Promise<ExecuteAiTaskResult> {
      return await executeTask({
        feature: "terminal_summaries",
        taskType: "terminal_summary",
        prompt: args.prompt,
        cwd: args.cwd,
        timeoutMs: args.timeoutMs,
        model: args.model,
        jsonSchema: args.jsonSchema,
        permissionMode: "read-only",
        oneShot: true
      });
    },

    async planMission(args: {
      cwd: string;
      prompt: string;
      timeoutMs?: number;
      model?: string;
      provider?: AgentProvider;
      jsonSchema?: unknown;
    }): Promise<ExecuteAiTaskResult> {
      return await executeTask({
        feature: "mission_planning",
        taskType: "mission_planning",
        prompt: args.prompt,
        cwd: args.cwd,
        provider: args.provider,
        timeoutMs: args.timeoutMs,
        model: args.model,
        jsonSchema: args.jsonSchema,
        permissionMode: "read-only",
        oneShot: true
      });
    },

    async generateInitialContext(args: {
      cwd: string;
      prompt: string;
      timeoutMs?: number;
      model?: string;
      provider?: AgentProvider;
      jsonSchema?: unknown;
    }): Promise<ExecuteAiTaskResult> {
      return await executeTask({
        feature: "initial_context",
        taskType: "initial_context",
        prompt: args.prompt,
        cwd: args.cwd,
        provider: args.provider,
        timeoutMs: args.timeoutMs,
        model: args.model,
        jsonSchema: args.jsonSchema,
        permissionMode: "read-only",
        oneShot: true
      });
    }
  };
}
