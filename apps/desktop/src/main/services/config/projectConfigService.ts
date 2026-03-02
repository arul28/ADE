import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import YAML from "yaml";
import cron from "node-cron";
import type {
  AiConfig,
  AiFeatureKey,
  AiTaskRoutingKey,
  AiTaskRoutingRule,
  AutomationAction,
  AutomationActionType,
  AutomationRule,
  AutomationTrigger,
  AutomationTriggerType,
  ConfigAutomationRule,
  ConfigLaneOverlayPolicy,
  ConfigProcessDefinition,
  ConfigProcessReadiness,
  ConfigStackButtonDefinition,
  ConfigTestSuiteDefinition,
  EnvironmentMapping,
  EffectiveProjectConfig,
  LaneOverlayMatch,
  LaneOverlayOverrides,
  LaneOverlayPolicy,
  LaneType,
  ProcessDefinition,
  ProcessReadinessConfig,
  ProjectConfigCandidate,
  ProjectConfigDiff,
  ProjectConfigFile,
  ProjectConfigSnapshot,
  ProjectConfigTrust,
  ProjectConfigValidationIssue,
  ProjectConfigValidationResult,
  ProviderMode,
  StackButtonDefinition,
  TestSuiteDefinition,
  TestSuiteTag
} from "../../../shared/types";
import type { Logger } from "../logging/logger";
import type { AdeDb } from "../state/kvDb";
import { isRecord } from "../shared/utils";

const TRUSTED_SHARED_HASH_KEY = "project_config:trusted_shared_hash";
const VERSION = 1;
const DEFAULT_GRACEFUL_MS = 7000;
const EMPTY_CONTENT_HASH = createHash("sha256").update("").digest("hex");

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean);
  return out;
}

function asLaneTypeArray(value: unknown): LaneType[] | undefined {
  const out = asStringArray(value);
  if (!out) return undefined;
  const laneTypes = out.filter((laneType): laneType is LaneType =>
    laneType === "primary" || laneType === "worktree" || laneType === "attached"
  );
  return laneTypes;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asBool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function coerceOrchestratorHookConfig(value: unknown): { command: string; timeoutMs?: number } | null {
  if (typeof value === "string") {
    const command = value.trim();
    return command.length ? { command } : null;
  }
  if (!isRecord(value)) return null;
  const command = asString(value.command)?.trim() ?? "";
  if (!command.length) return null;
  const timeoutMs = asNumber(value.timeoutMs);
  return {
    command,
    ...(timeoutMs != null ? { timeoutMs: Math.max(1_000, Math.floor(timeoutMs)) } : {})
  };
}

function asStringMap(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

function parseReadiness(value: unknown): ConfigProcessReadiness | undefined {
  if (!isRecord(value)) return undefined;
  const type = asString(value.type);
  if (type === "port") {
    return { type, port: asNumber(value.port) };
  }
  if (type === "logRegex") {
    return { type, pattern: asString(value.pattern) };
  }
  if (type === "none") {
    return { type };
  }
  return undefined;
}

function coerceAutomationTrigger(value: unknown): AutomationTrigger | undefined {
  if (!isRecord(value)) return undefined;
  const typeRaw = asString(value.type)?.trim() ?? "";
  const type: AutomationTriggerType | null =
    typeRaw === "session-end" || typeRaw === "commit" || typeRaw === "schedule" || typeRaw === "manual"
      ? (typeRaw as AutomationTriggerType)
      : null;
  if (!type) return undefined;

  const out: AutomationTrigger = { type };
  const cron = asString(value.cron);
  const branch = asString(value.branch);
  if (cron != null) out.cron = cron;
  if (branch != null) out.branch = branch;
  return out;
}

function coerceAutomationAction(value: unknown): AutomationAction | null {
  if (!isRecord(value)) return null;
  const typeRaw = asString(value.type)?.trim() ?? "";
  const type: AutomationActionType | null =
    typeRaw === "update-packs" ||
    typeRaw === "predict-conflicts" ||
    typeRaw === "run-tests" ||
    typeRaw === "run-command"
      ? (typeRaw as AutomationActionType)
      : null;
  if (!type) return null;

  const out: AutomationAction = { type };
  const suiteId = asString(value.suiteId);
  const command = asString(value.command);
  const cwd = asString(value.cwd);
  const condition = asString(value.condition);
  const continueOnFailure = asBool(value.continueOnFailure);
  const timeoutMs = asNumber(value.timeoutMs);
  const retry = asNumber(value.retry);

  if (suiteId != null) out.suiteId = suiteId;
  if (command != null) out.command = command;
  if (cwd != null) out.cwd = cwd;
  if (condition != null) out.condition = condition;
  if (continueOnFailure != null) out.continueOnFailure = continueOnFailure;
  if (timeoutMs != null) out.timeoutMs = timeoutMs;
  if (retry != null) out.retry = retry;

  return out;
}

function coerceAutomationRule(value: unknown): ConfigAutomationRule | null {
  if (!isRecord(value)) return null;
  const id = asString(value.id)?.trim() ?? "";
  const out: ConfigAutomationRule = { id };

  const name = asString(value.name);
  const enabled = asBool(value.enabled);
  const trigger = coerceAutomationTrigger(value.trigger);
  const actions = Array.isArray(value.actions)
    ? value.actions.map(coerceAutomationAction).filter((x): x is AutomationAction => x != null)
    : undefined;

  if (name != null) out.name = name;
  if (enabled != null) out.enabled = enabled;
  if (trigger != null) out.trigger = trigger;
  if (actions != null) out.actions = actions;

  return out;
}

function coerceProcessDef(value: unknown): ConfigProcessDefinition | null {
  if (!isRecord(value)) return null;
  const id = asString(value.id)?.trim() ?? "";
  const out: ConfigProcessDefinition = { id };

  const name = asString(value.name);
  const command = asStringArray(value.command);
  const cwd = asString(value.cwd);
  const env = asStringMap(value.env);
  const autostart = asBool(value.autostart);
  const restart = asString(value.restart);
  const gracefulShutdownMs = asNumber(value.gracefulShutdownMs);
  const dependsOn = asStringArray(value.dependsOn);
  const readiness = parseReadiness(value.readiness);

  if (name != null) out.name = name;
  if (command != null) out.command = command;
  if (cwd != null) out.cwd = cwd;
  if (env != null) out.env = env;
  if (autostart != null) out.autostart = autostart;
  if (restart === "never" || restart === "on_crash" || restart === "on-failure" || restart === "always") out.restart = restart;
  if (gracefulShutdownMs != null) out.gracefulShutdownMs = gracefulShutdownMs;
  if (dependsOn != null) out.dependsOn = dependsOn;
  if (readiness != null) out.readiness = readiness;

  return out;
}

function coerceStackButton(value: unknown): ConfigStackButtonDefinition | null {
  if (!isRecord(value)) return null;
  const id = asString(value.id)?.trim() ?? "";
  const out: ConfigStackButtonDefinition = { id };

  const name = asString(value.name);
  const processIds = asStringArray(value.processIds);
  const startOrder = asString(value.startOrder);

  if (name != null) out.name = name;
  if (processIds != null) out.processIds = processIds;
  if (startOrder === "parallel" || startOrder === "dependency") out.startOrder = startOrder;

  return out;
}

function coerceTestSuite(value: unknown): ConfigTestSuiteDefinition | null {
  if (!isRecord(value)) return null;
  const id = asString(value.id)?.trim() ?? "";
  const out: ConfigTestSuiteDefinition = { id };

  const name = asString(value.name);
  const command = asStringArray(value.command);
  const cwd = asString(value.cwd);
  const env = asStringMap(value.env);
  const timeoutMs = asNumber(value.timeoutMs);
  const tags = asStringArray(value.tags);

  if (name != null) out.name = name;
  if (command != null) out.command = command;
  if (cwd != null) out.cwd = cwd;
  if (env != null) out.env = env;
  if (timeoutMs != null) out.timeoutMs = timeoutMs;
  if (tags != null) {
    out.tags = tags.filter((tag): tag is TestSuiteTag =>
      tag === "unit" || tag === "lint" || tag === "integration" || tag === "e2e" || tag === "custom"
    );
  }

  return out;
}

function coerceEnvironmentMapping(value: unknown): EnvironmentMapping | null {
  if (!isRecord(value)) return null;
  const branch = asString(value.branch)?.trim() ?? "";
  const env = asString(value.env)?.trim() ?? "";
  const color = asString(value.color)?.trim();
  if (!branch || !env) return null;
  const out: EnvironmentMapping = { branch, env };
  if (color) out.color = color;
  return out;
}

function coerceLaneOverlayPolicy(value: unknown): ConfigLaneOverlayPolicy | null {
  if (!isRecord(value)) return null;
  const id = asString(value.id)?.trim() ?? "";
  const out: ConfigLaneOverlayPolicy = { id };

  const name = asString(value.name);
  const enabled = asBool(value.enabled);
  if (name != null) out.name = name;
  if (enabled != null) out.enabled = enabled;

  if (isRecord(value.match)) {
    const match: LaneOverlayMatch = {};
    const laneIds = asStringArray(value.match.laneIds);
    const laneTypes = asLaneTypeArray(value.match.laneTypes);
    const namePattern = asString(value.match.namePattern);
    const branchPattern = asString(value.match.branchPattern);
    const tags = asStringArray(value.match.tags);
    if (laneIds != null) match.laneIds = laneIds;
    if (laneTypes != null) match.laneTypes = laneTypes;
    if (namePattern != null) match.namePattern = namePattern;
    if (branchPattern != null) match.branchPattern = branchPattern;
    if (tags != null) match.tags = tags;
    if (Object.keys(match).length > 0) out.match = match;
  }

  if (isRecord(value.overrides)) {
    const overrides: LaneOverlayOverrides = {};
    const env = asStringMap(value.overrides.env);
    const cwd = asString(value.overrides.cwd);
    const processIds = asStringArray(value.overrides.processIds);
    const testSuiteIds = asStringArray(value.overrides.testSuiteIds);
    if (env != null) overrides.env = env;
    if (cwd != null) overrides.cwd = cwd;
    if (processIds != null) overrides.processIds = processIds;
    if (testSuiteIds != null) overrides.testSuiteIds = testSuiteIds;
    if (Object.keys(overrides).length > 0) out.overrides = overrides;
  }

  return out;
}

const AI_TASK_KEYS: AiTaskRoutingKey[] = [
  "planning",
  "implementation",
  "review",
  "conflict_resolution",
  "narrative",
  "pr_description",
  "terminal_summary",
  "mission_planning",
  "initial_context"
];

const AI_FEATURE_KEYS: AiFeatureKey[] = [
  "narratives",
  "conflict_proposals",
  "pr_descriptions",
  "terminal_summaries",
  "mission_planning",
  "orchestrator",
  "initial_context"
];

function coerceAiTaskRoutingRule(value: unknown): AiTaskRoutingRule | null {
  if (!isRecord(value)) return null;
  const providerRaw = asString(value.provider)?.trim().toLowerCase();
  const provider =
    providerRaw === "auto" || providerRaw === "claude" || providerRaw === "codex"
      ? providerRaw
      : undefined;
  const model = asString(value.model);
  const timeoutMs = asNumber(value.timeoutMs);
  const maxOutputTokens = asNumber(value.maxOutputTokens);
  const temperature = asNumber(value.temperature);

  const out: AiTaskRoutingRule = {};
  if (provider) out.provider = provider;
  if (model != null) out.model = model;
  if (timeoutMs != null) out.timeoutMs = timeoutMs;
  if (maxOutputTokens != null) out.maxOutputTokens = maxOutputTokens;
  if (temperature != null) out.temperature = temperature;

  return Object.keys(out).length ? out : null;
}

function coerceAiConfig(value: unknown): AiConfig | undefined {
  if (!isRecord(value)) return undefined;

  const out: AiConfig = {};
  const mode = asString(value.mode)?.trim();
  if (mode === "guest" || mode === "subscription") {
    out.mode = mode;
  }

  const defaultProvider = asString(value.defaultProvider)?.trim().toLowerCase();
  if (defaultProvider === "auto" || defaultProvider === "claude" || defaultProvider === "codex") {
    out.defaultProvider = defaultProvider;
  }

  const taskRoutingRaw = isRecord(value.taskRouting) ? value.taskRouting : null;
  if (taskRoutingRaw) {
    const routing: Partial<Record<AiTaskRoutingKey, AiTaskRoutingRule>> = {};
    for (const taskKey of AI_TASK_KEYS) {
      const rule = coerceAiTaskRoutingRule(taskRoutingRaw[taskKey]);
      if (rule) routing[taskKey] = rule;
    }
    if (Object.keys(routing).length) out.taskRouting = routing;
  }

  const featuresRaw = isRecord(value.features) ? value.features : null;
  if (featuresRaw) {
    const features: Partial<Record<AiFeatureKey, boolean>> = {};
    for (const key of AI_FEATURE_KEYS) {
      const bool = asBool(featuresRaw[key]);
      if (bool != null) features[key] = bool;
    }
    if (Object.keys(features).length) out.features = features;
  }

  const budgetsRaw = isRecord(value.budgets) ? value.budgets : null;
  if (budgetsRaw) {
    const budgets: NonNullable<AiConfig["budgets"]> = {};
    for (const key of AI_FEATURE_KEYS) {
      const entry = isRecord(budgetsRaw[key]) ? budgetsRaw[key] : null;
      if (!entry) continue;
      const dailyLimit = asNumber(entry.dailyLimit);
      if (dailyLimit == null) continue;
      budgets[key] = { dailyLimit };
    }
    if (Object.keys(budgets).length) out.budgets = budgets;
  }

  const permissionsRaw = isRecord(value.permissions) ? value.permissions : null;
  if (permissionsRaw) {
    const permissions: NonNullable<AiConfig["permissions"]> = {};
    const claude = isRecord(permissionsRaw.claude) ? permissionsRaw.claude : null;
    if (claude) {
      const entry: NonNullable<NonNullable<AiConfig["permissions"]>["claude"]> = {};
      const permissionMode = asString(claude.permissionMode)?.trim();
      if (permissionMode === "default" || permissionMode === "acceptEdits" || permissionMode === "bypassPermissions" || permissionMode === "plan") {
        entry.permissionMode = permissionMode;
      }
      const settingsSources = Array.isArray(claude.settingsSources) ? claude.settingsSources : null;
      if (settingsSources) {
        const normalized = settingsSources
          .map((item) => String(item).trim())
          .filter((item): item is "user" | "project" | "local" => item === "user" || item === "project" || item === "local");
        if (normalized.length) entry.settingsSources = normalized;
      }
      const maxBudgetUsd = asNumber(claude.maxBudgetUsd);
      if (maxBudgetUsd != null && maxBudgetUsd > 0) entry.maxBudgetUsd = maxBudgetUsd;
      const sandbox = asBool(claude.sandbox);
      if (sandbox != null) entry.sandbox = sandbox;
      const dangerouslySkipPermissions = asBool(claude.dangerouslySkipPermissions);
      if (dangerouslySkipPermissions != null) entry.dangerouslySkipPermissions = dangerouslySkipPermissions;
      const allowedTools = asStringArray(claude.allowedTools);
      if (allowedTools?.length) entry.allowedTools = allowedTools;
      if (Object.keys(entry).length) permissions.claude = entry;
    }

    const codex = isRecord(permissionsRaw.codex) ? permissionsRaw.codex : null;
    if (codex) {
      const entry: NonNullable<NonNullable<AiConfig["permissions"]>["codex"]> = {};
      const sandboxPermissions = asString(codex.sandboxPermissions)?.trim();
      if (sandboxPermissions === "read-only" || sandboxPermissions === "workspace-write" || sandboxPermissions === "danger-full-access") {
        entry.sandboxPermissions = sandboxPermissions;
      }
      const approvalMode = asString(codex.approvalMode)?.trim();
      if (
        approvalMode === "untrusted"
        || approvalMode === "on-request"
        || approvalMode === "on-failure"
        || approvalMode === "never"
        || approvalMode === "suggest"
        || approvalMode === "auto-edit"
        || approvalMode === "full-auto"
      ) {
        entry.approvalMode = approvalMode;
      }
      const writablePaths = asStringArray(codex.writablePaths);
      if (writablePaths?.length) entry.writablePaths = writablePaths;
      const commandAllowlist = asStringArray(codex.commandAllowlist);
      if (commandAllowlist?.length) entry.commandAllowlist = commandAllowlist;
      const configPath = asString(codex.configPath);
      if (configPath) entry.configPath = configPath;
      if (Object.keys(entry).length) permissions.codex = entry;
    }

    if (Object.keys(permissions).length) out.permissions = permissions;
  }

  const conflictRaw = isRecord(value.conflictResolution) ? value.conflictResolution : null;
  if (conflictRaw) {
    const conflict: NonNullable<AiConfig["conflictResolution"]> = {};
    const changeTarget = asString(conflictRaw.changeTarget)?.trim();
    if (changeTarget === "target" || changeTarget === "source" || changeTarget === "ai_decides") {
      conflict.changeTarget = changeTarget;
    }
    const postResolution = asString(conflictRaw.postResolution)?.trim();
    if (postResolution === "unstaged" || postResolution === "staged" || postResolution === "commit") {
      conflict.postResolution = postResolution;
    }
    const prBehavior = asString(conflictRaw.prBehavior)?.trim();
    if (prBehavior === "do_nothing" || prBehavior === "open_pr" || prBehavior === "add_to_existing") {
      conflict.prBehavior = prBehavior;
    }
    const autonomy = asString(conflictRaw.autonomy)?.trim();
    if (autonomy === "propose_only" || autonomy === "auto_apply") {
      conflict.autonomy = autonomy;
    }
    const threshold = asNumber(conflictRaw.autoApplyThreshold);
    if (threshold != null) conflict.autoApplyThreshold = threshold;
    if (Object.keys(conflict).length) out.conflictResolution = conflict;
  }

  const orchestratorRaw = isRecord(value.orchestrator) ? value.orchestrator : null;
  if (orchestratorRaw) {
    const orchestrator: NonNullable<AiConfig["orchestrator"]> = {};
    const teammatePlanMode = asString(orchestratorRaw.teammatePlanMode)?.trim();
    if (teammatePlanMode === "off" || teammatePlanMode === "auto" || teammatePlanMode === "required") {
      orchestrator.teammatePlanMode = teammatePlanMode;
    }

    const requirePlanReview = asBool(orchestratorRaw.requirePlanReview);
    if (requirePlanReview != null) orchestrator.requirePlanReview = requirePlanReview;

    const maxParallelWorkers = asNumber(orchestratorRaw.maxParallelWorkers);
    if (maxParallelWorkers != null) orchestrator.maxParallelWorkers = Math.max(1, Math.floor(maxParallelWorkers));

    const defaultMergePolicy = asString(orchestratorRaw.defaultMergePolicy)?.trim();
    if (defaultMergePolicy === "sequential" || defaultMergePolicy === "batch-at-end" || defaultMergePolicy === "per-step") {
      orchestrator.defaultMergePolicy = defaultMergePolicy;
    }

    const defaultConflictHandoff = asString(orchestratorRaw.defaultConflictHandoff)?.trim();
    if (
      defaultConflictHandoff === "auto-resolve" ||
      defaultConflictHandoff === "ask-user" ||
      defaultConflictHandoff === "orchestrator-decides"
    ) {
      orchestrator.defaultConflictHandoff = defaultConflictHandoff;
    }

    const workerHeartbeatIntervalMs = asNumber(orchestratorRaw.workerHeartbeatIntervalMs);
    if (workerHeartbeatIntervalMs != null) orchestrator.workerHeartbeatIntervalMs = Math.max(1_000, Math.floor(workerHeartbeatIntervalMs));

    const workerHeartbeatTimeoutMs = asNumber(orchestratorRaw.workerHeartbeatTimeoutMs);
    if (workerHeartbeatTimeoutMs != null) orchestrator.workerHeartbeatTimeoutMs = Math.max(1_000, Math.floor(workerHeartbeatTimeoutMs));

    const workerIdleTimeoutMs = asNumber(orchestratorRaw.workerIdleTimeoutMs);
    if (workerIdleTimeoutMs != null) orchestrator.workerIdleTimeoutMs = Math.max(1_000, Math.floor(workerIdleTimeoutMs));

    const stepTimeoutDefaultMs = asNumber(orchestratorRaw.stepTimeoutDefaultMs);
    if (stepTimeoutDefaultMs != null) orchestrator.stepTimeoutDefaultMs = Math.max(1_000, Math.floor(stepTimeoutDefaultMs));

    const maxRetriesPerStep = asNumber(orchestratorRaw.maxRetriesPerStep);
    if (maxRetriesPerStep != null) orchestrator.maxRetriesPerStep = Math.max(0, Math.floor(maxRetriesPerStep));

    const contextPressureThreshold = asNumber(orchestratorRaw.contextPressureThreshold);
    if (contextPressureThreshold != null) orchestrator.contextPressureThreshold = Math.max(0.1, Math.min(0.99, contextPressureThreshold));

    const progressiveLoading = asBool(orchestratorRaw.progressiveLoading);
    if (progressiveLoading != null) orchestrator.progressiveLoading = progressiveLoading;

    const maxTotalTokenBudget = asNumber(orchestratorRaw.maxTotalTokenBudget);
    if (maxTotalTokenBudget != null && maxTotalTokenBudget > 0) orchestrator.maxTotalTokenBudget = maxTotalTokenBudget;

    const maxPerStepTokenBudget = asNumber(orchestratorRaw.maxPerStepTokenBudget);
    if (maxPerStepTokenBudget != null && maxPerStepTokenBudget > 0) orchestrator.maxPerStepTokenBudget = maxPerStepTokenBudget;

    const defaultExecutionPolicy = isRecord(orchestratorRaw.defaultExecutionPolicy)
      ? orchestratorRaw.defaultExecutionPolicy
      : null;
    if (defaultExecutionPolicy) {
      orchestrator.defaultExecutionPolicy =
        defaultExecutionPolicy as NonNullable<NonNullable<AiConfig["orchestrator"]>["defaultExecutionPolicy"]>;
    }

    const defaultPlannerProvider = asString(orchestratorRaw.defaultPlannerProvider)?.trim();
    if (defaultPlannerProvider === "auto" || defaultPlannerProvider === "claude" || defaultPlannerProvider === "codex") {
      orchestrator.defaultPlannerProvider = defaultPlannerProvider;
    }

    const autoResolveInterventions = asBool(orchestratorRaw.autoResolveInterventions);
    if (autoResolveInterventions != null) orchestrator.autoResolveInterventions = autoResolveInterventions;

    const interventionConfidenceThreshold = asNumber(orchestratorRaw.interventionConfidenceThreshold);
    if (interventionConfidenceThreshold != null) {
      orchestrator.interventionConfidenceThreshold = Math.max(0, Math.min(1, interventionConfidenceThreshold));
    }

    const hooksRaw = isRecord(orchestratorRaw.hooks) ? orchestratorRaw.hooks : null;
    if (hooksRaw) {
      const hooks: NonNullable<NonNullable<AiConfig["orchestrator"]>["hooks"]> = {};
      const teammateIdle = coerceOrchestratorHookConfig(
        hooksRaw.TeammateIdle ?? hooksRaw.teammateIdle
      );
      if (teammateIdle) hooks.TeammateIdle = teammateIdle;
      const taskCompleted = coerceOrchestratorHookConfig(
        hooksRaw.TaskCompleted ?? hooksRaw.taskCompleted
      );
      if (taskCompleted) hooks.TaskCompleted = taskCompleted;
      if (Object.keys(hooks).length) orchestrator.hooks = hooks;
    }

    if (Object.keys(orchestrator).length) out.orchestrator = orchestrator;
  }

  return Object.keys(out).length ? out : undefined;
}

function mergeAiConfig(sharedAi?: AiConfig, localAi?: AiConfig): AiConfig | undefined {
  if (!sharedAi && !localAi) return undefined;
  const taskRouting: Partial<Record<AiTaskRoutingKey, AiTaskRoutingRule>> = {
    ...(sharedAi?.taskRouting ?? {}),
    ...(localAi?.taskRouting ?? {})
  };
  const features = {
    ...(sharedAi?.features ?? {}),
    ...(localAi?.features ?? {})
  };
  const budgets = {
    ...(sharedAi?.budgets ?? {}),
    ...(localAi?.budgets ?? {})
  };
  const permissions = {
    ...(sharedAi?.permissions ?? {}),
    ...(localAi?.permissions ?? {})
  };
  const conflictResolution = {
    ...(sharedAi?.conflictResolution ?? {}),
    ...(localAi?.conflictResolution ?? {})
  };
  const orchestrator = {
    ...(sharedAi?.orchestrator ?? {}),
    ...(localAi?.orchestrator ?? {})
  };
  const out: AiConfig = {
    mode: localAi?.mode ?? sharedAi?.mode,
    defaultProvider: localAi?.defaultProvider ?? sharedAi?.defaultProvider,
    ...(Object.keys(taskRouting).length ? { taskRouting } : {}),
    ...(Object.keys(features).length ? { features } : {}),
    ...(Object.keys(budgets).length ? { budgets } : {}),
    ...(Object.keys(permissions).length ? { permissions } : {}),
    ...(Object.keys(conflictResolution).length ? { conflictResolution } : {}),
    ...(Object.keys(orchestrator).length ? { orchestrator } : {})
  };
  return Object.keys(out).length ? out : undefined;
}

function coerceConfigFile(value: unknown): ProjectConfigFile {
  if (!isRecord(value)) {
    return { version: VERSION, processes: [], stackButtons: [], testSuites: [], laneOverlayPolicies: [], automations: [] };
  }

  const version = asNumber(value.version) ?? VERSION;
  const processes = Array.isArray(value.processes)
    ? value.processes.map(coerceProcessDef).filter((x): x is ConfigProcessDefinition => x != null)
    : [];
  const stackButtons = Array.isArray(value.stackButtons)
    ? value.stackButtons.map(coerceStackButton).filter((x): x is ConfigStackButtonDefinition => x != null)
    : [];
  const testSuites = Array.isArray(value.testSuites)
    ? value.testSuites.map(coerceTestSuite).filter((x): x is ConfigTestSuiteDefinition => x != null)
    : [];
  const laneOverlayPolicies = Array.isArray(value.laneOverlayPolicies)
    ? value.laneOverlayPolicies.map(coerceLaneOverlayPolicy).filter((x): x is ConfigLaneOverlayPolicy => x != null)
    : [];
  const automations = Array.isArray(value.automations)
    ? value.automations.map(coerceAutomationRule).filter((x): x is ConfigAutomationRule => x != null)
    : [];
  const environments = Array.isArray(value.environments)
    ? value.environments.map(coerceEnvironmentMapping).filter((x): x is EnvironmentMapping => x != null)
    : [];

  const github =
    isRecord(value.github) && (asNumber(value.github.prPollingIntervalSeconds) != null)
      ? {
          ...(asNumber(value.github.prPollingIntervalSeconds) != null
            ? { prPollingIntervalSeconds: asNumber(value.github.prPollingIntervalSeconds) }
            : {})
        }
      : undefined;

  const git =
    isRecord(value.git) && (asBool(value.git.autoRebaseOnHeadChange) != null)
      ? {
          ...(asBool(value.git.autoRebaseOnHeadChange) != null
            ? { autoRebaseOnHeadChange: asBool(value.git.autoRebaseOnHeadChange) }
            : {})
        }
      : undefined;

  const providersRaw = isRecord((value as Record<string, unknown>).providers)
    ? { ...((value as Record<string, unknown>).providers as Record<string, unknown>) }
    : undefined;
  const legacyAi = providersRaw ? coerceAiConfig(providersRaw.ai) : undefined;
  const legacyModeRaw = asString(providersRaw?.mode)?.trim().toLowerCase() ?? "";
  const legacyMode: AiConfig["mode"] | undefined =
    legacyModeRaw === "guest"
      ? "guest"
      : legacyModeRaw === "subscription" || legacyModeRaw === "hosted" || legacyModeRaw === "byok"
        ? "subscription"
        : undefined;

  let ai = coerceAiConfig((value as Record<string, unknown>).ai) ?? legacyAi;
  if (legacyMode != null) {
    ai = {
      ...(ai ?? {}),
      mode: ai?.mode ?? legacyMode
    };
  }

  if (providersRaw) {
    delete providersRaw.mode;
    delete providersRaw.ai;
  }

  return {
    version,
    processes,
    stackButtons,
    testSuites,
    laneOverlayPolicies,
    automations,
    ...(environments.length ? { environments } : {}),
    ...(github ? { github } : {}),
    ...(git ? { git } : {}),
    ...(ai ? { ai } : {}),
    ...(providersRaw && Object.keys(providersRaw).length ? { providers: providersRaw } : {})
  };
}

function readConfigFile(filePath: string): { config: ProjectConfigFile; raw: string } {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw.trim().length) {
      return {
        config: { version: VERSION, processes: [], stackButtons: [], testSuites: [], laneOverlayPolicies: [], automations: [] },
        raw
      };
    }
    const parsed = YAML.parse(raw);
    return { config: coerceConfigFile(parsed), raw };
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      return {
        config: { version: VERSION, processes: [], stackButtons: [], testSuites: [], laneOverlayPolicies: [], automations: [] },
        raw: ""
      };
    }
    throw err;
  }
}

function toCanonicalYaml(config: ProjectConfigFile): string {
  const normalized: ProjectConfigFile = {
    version: VERSION,
    processes: config.processes ?? [],
    stackButtons: config.stackButtons ?? [],
    testSuites: config.testSuites ?? [],
    laneOverlayPolicies: config.laneOverlayPolicies ?? [],
    automations: config.automations ?? [],
    ...(config.environments ? { environments: config.environments } : {}),
    ...(config.github ? { github: config.github } : {}),
    ...(config.git ? { git: config.git } : {}),
    ...(config.ai ? { ai: config.ai } : {}),
    ...(config.providers ? { providers: config.providers } : {})
  };
  return YAML.stringify(normalized, { indent: 2 });
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function createDefId(projectId: string, key: string): string {
  return `${projectId}:${key}`;
}

function mergeById<T extends { id: string }>(base: T[] = [], local: T[] = [], merge: (a: T, b: T) => T): T[] {
  const out: T[] = [];
  const indexById = new Map<string, number>();

  for (const entry of base) {
    const id = (entry.id ?? "").trim();
    if (!id) continue;
    if (indexById.has(id)) continue;
    indexById.set(id, out.length);
    out.push(entry);
  }

  for (const entry of local) {
    const id = (entry.id ?? "").trim();
    if (!id) continue;
    const idx = indexById.get(id);
    if (idx == null) {
      indexById.set(id, out.length);
      out.push(entry);
      continue;
    }
    out[idx] = merge(out[idx]!, entry);
  }

  return out;
}

function resolveReadiness(readiness: ConfigProcessReadiness | undefined): ProcessReadinessConfig {
  if (!readiness) return { type: "none" };
  if (readiness.type === "port") return { type: "port", port: Number(readiness.port ?? 0) };
  if (readiness.type === "logRegex") return { type: "logRegex", pattern: readiness.pattern ?? "" };
  return { type: "none" };
}

function resolveEffectiveConfig(shared: ProjectConfigFile, local: ProjectConfigFile): EffectiveProjectConfig {
  const mergedProcesses = mergeById(shared.processes ?? [], local.processes ?? [], (base, over) => ({
    ...base,
    ...over,
    ...(base.env || over.env ? { env: { ...(base.env ?? {}), ...(over.env ?? {}) } } : {}),
    ...(over.readiness != null ? { readiness: over.readiness } : base.readiness != null ? { readiness: base.readiness } : {}),
    ...(over.dependsOn != null ? { dependsOn: over.dependsOn } : base.dependsOn != null ? { dependsOn: base.dependsOn } : {})
  }));

  const mergedStackButtons = mergeById(shared.stackButtons ?? [], local.stackButtons ?? [], (base, over) => ({
    ...base,
    ...over,
    ...(over.processIds != null ? { processIds: over.processIds } : base.processIds != null ? { processIds: base.processIds } : {})
  }));

  const mergedSuites = mergeById(shared.testSuites ?? [], local.testSuites ?? [], (base, over) => ({
    ...base,
    ...over,
    ...(base.env || over.env ? { env: { ...(base.env ?? {}), ...(over.env ?? {}) } } : {})
  }));

  const mergedLaneOverlayPolicies = mergeById(
    shared.laneOverlayPolicies ?? [],
    local.laneOverlayPolicies ?? [],
    (base, over) => ({
      ...base,
      ...over,
      ...(base.match || over.match ? { match: { ...(base.match ?? {}), ...(over.match ?? {}) } } : {}),
      ...(base.overrides || over.overrides
        ? { overrides: { ...(base.overrides ?? {}), ...(over.overrides ?? {}) } }
        : {})
    })
  );

  const mergedAutomations = mergeById(shared.automations ?? [], local.automations ?? [], (base, over) => ({
    ...base,
    ...over,
    ...(over.trigger != null ? { trigger: over.trigger } : base.trigger != null ? { trigger: base.trigger } : {}),
    ...(over.actions != null ? { actions: over.actions } : base.actions != null ? { actions: base.actions } : {})
  }));

  const processes: ProcessDefinition[] = mergedProcesses.map((entry) => ({
    id: entry.id.trim(),
    name: entry.name?.trim() ?? "",
    command: (entry.command ?? []).map((c) => c.trim()).filter(Boolean),
    cwd: entry.cwd?.trim() ?? "",
    env: entry.env ?? {},
    autostart: entry.autostart ?? false,
    restart: entry.restart ?? "never",
    gracefulShutdownMs: entry.gracefulShutdownMs ?? DEFAULT_GRACEFUL_MS,
    dependsOn: (entry.dependsOn ?? []).map((d) => d.trim()).filter(Boolean),
    readiness: resolveReadiness(entry.readiness)
  }));

  const stackButtons: StackButtonDefinition[] = mergedStackButtons.map((entry) => ({
    id: entry.id.trim(),
    name: entry.name?.trim() ?? "",
    processIds: (entry.processIds ?? []).map((id) => id.trim()).filter(Boolean),
    startOrder: entry.startOrder ?? "parallel"
  }));

  const testSuites: TestSuiteDefinition[] = mergedSuites.map((entry) => ({
    id: entry.id.trim(),
    name: entry.name?.trim() ?? "",
    command: (entry.command ?? []).map((c) => c.trim()).filter(Boolean),
    cwd: entry.cwd?.trim() ?? "",
    env: entry.env ?? {},
    timeoutMs: entry.timeoutMs ?? null,
    tags: entry.tags ?? []
  }));

  const laneOverlayPolicies: LaneOverlayPolicy[] = mergedLaneOverlayPolicies.map((entry) => ({
    id: entry.id.trim(),
    name: entry.name?.trim() ?? entry.id.trim(),
    enabled: entry.enabled ?? true,
    match: {
      ...(entry.match?.laneIds ? { laneIds: entry.match.laneIds.map((v) => v.trim()).filter(Boolean) } : {}),
      ...(entry.match?.laneTypes ? { laneTypes: entry.match.laneTypes } : {}),
      ...(entry.match?.namePattern ? { namePattern: entry.match.namePattern.trim() } : {}),
      ...(entry.match?.branchPattern ? { branchPattern: entry.match.branchPattern.trim() } : {}),
      ...(entry.match?.tags ? { tags: entry.match.tags.map((v) => v.trim()).filter(Boolean) } : {})
    },
    overrides: {
      ...(entry.overrides?.env ? { env: entry.overrides.env } : {}),
      ...(entry.overrides?.cwd ? { cwd: entry.overrides.cwd.trim() } : {}),
      ...(entry.overrides?.processIds ? { processIds: entry.overrides.processIds.map((v) => v.trim()).filter(Boolean) } : {}),
      ...(entry.overrides?.testSuiteIds ? { testSuiteIds: entry.overrides.testSuiteIds.map((v) => v.trim()).filter(Boolean) } : {})
    }
  }));

  const automations: AutomationRule[] = mergedAutomations.map((entry) => ({
    id: entry.id.trim(),
    name: entry.name?.trim() ?? entry.id.trim(),
    trigger: {
      type: entry.trigger?.type ?? "manual",
      ...(entry.trigger?.cron ? { cron: entry.trigger.cron.trim() } : {}),
      ...(entry.trigger?.branch ? { branch: entry.trigger.branch.trim() } : {})
    },
    actions: (entry.actions ?? []).map((action) => ({
      type: action.type,
      ...(action.suiteId ? { suiteId: action.suiteId.trim() } : {}),
      ...(action.command ? { command: action.command } : {}),
      ...(action.cwd ? { cwd: action.cwd.trim() } : {}),
      ...(action.condition ? { condition: action.condition.trim() } : {}),
      ...(action.continueOnFailure != null ? { continueOnFailure: action.continueOnFailure } : {}),
      ...(action.timeoutMs != null ? { timeoutMs: action.timeoutMs } : {}),
      ...(action.retry != null ? { retry: action.retry } : {})
    })),
    enabled: entry.enabled ?? true
  }));

  const mergedProviders = shared.providers || local.providers
    ? {
      ...(shared.providers ?? {}),
      ...(local.providers ?? {})
    }
    : undefined;

  const mergedGithub = shared.github || local.github
    ? {
        ...(shared.github ?? {}),
        ...(local.github ?? {})
      }
    : undefined;

  const mergedGit = shared.git || local.git
    ? {
        ...(shared.git ?? {}),
        ...(local.git ?? {})
      }
    : undefined;

  const mergedAi = mergeAiConfig(shared.ai, local.ai);

  const environments = [...(shared.environments ?? []), ...(local.environments ?? [])];

  const legacyModeRaw = typeof mergedProviders?.mode === "string" ? String(mergedProviders.mode).trim().toLowerCase() : "";
  const aiModeRaw = typeof mergedAi?.mode === "string" ? String(mergedAi.mode).trim().toLowerCase() : "";
  const providerMode: ProviderMode = (() => {
    const resolved = aiModeRaw || legacyModeRaw;
    if (resolved === "guest") return "guest";
    if (resolved === "subscription" || resolved === "hosted" || resolved === "byok") return "subscription";
    return "guest";
  })();

  const effectiveAi = mergedAi
    ? {
        ...mergedAi,
        mode: providerMode
      }
    : undefined;

  return {
    version: VERSION,
    processes,
    stackButtons,
    testSuites,
    laneOverlayPolicies,
    automations,
    ...(environments.length ? { environments } : {}),
    providerMode,
    ...(mergedGithub ? { github: mergedGithub } : {}),
    git: {
      autoRebaseOnHeadChange: mergedGit?.autoRebaseOnHeadChange ?? false
    },
    ...(effectiveAi ? { ai: effectiveAi } : {}),
    ...(mergedProviders ? { providers: mergedProviders } : {})
  };
}

function validateDuplicateIds(
  values: Array<{ id: string }>,
  sectionPath: string,
  issues: ProjectConfigValidationIssue[],
  fileLabel: "shared" | "local"
) {
  const seen = new Set<string>();
  for (let i = 0; i < values.length; i++) {
    const id = (values[i]?.id ?? "").trim();
    if (!id) continue;
    if (seen.has(id)) {
      issues.push({ path: `${fileLabel}.${sectionPath}[${i}].id`, message: `Duplicate id '${id}'` });
      continue;
    }
    seen.add(id);
  }
}

function isDirectory(absPath: string): boolean {
  try {
    return fs.statSync(absPath).isDirectory();
  } catch {
    return false;
  }
}

function validateProcessCycles(processes: ProcessDefinition[], issues: ProjectConfigValidationIssue[]) {
  const byId = new Map(processes.map((p) => [p.id, p] as const));
  const visited = new Set<string>();
  const inStack = new Set<string>();

  const dfs = (id: string): boolean => {
    if (inStack.has(id)) return true;
    if (visited.has(id)) return false;

    visited.add(id);
    inStack.add(id);

    const proc = byId.get(id);
    if (proc) {
      for (const dep of proc.dependsOn) {
        if (!byId.has(dep)) continue;
        if (dfs(dep)) return true;
      }
    }

    inStack.delete(id);
    return false;
  };

  for (const id of byId.keys()) {
    if (dfs(id)) {
      issues.push({ path: "effective.processes", message: `Cyclic dependsOn graph detected around '${id}'` });
      return;
    }
  }
}

function validateEffectiveConfig(
  effective: EffectiveProjectConfig,
  projectRoot: string,
  shared: ProjectConfigFile,
  local: ProjectConfigFile
): ProjectConfigValidationResult {
  const issues: ProjectConfigValidationIssue[] = [];

  validateDuplicateIds(shared.processes ?? [], "processes", issues, "shared");
  validateDuplicateIds(local.processes ?? [], "processes", issues, "local");
  validateDuplicateIds(shared.stackButtons ?? [], "stackButtons", issues, "shared");
  validateDuplicateIds(local.stackButtons ?? [], "stackButtons", issues, "local");
  validateDuplicateIds(shared.testSuites ?? [], "testSuites", issues, "shared");
  validateDuplicateIds(local.testSuites ?? [], "testSuites", issues, "local");
  validateDuplicateIds(shared.laneOverlayPolicies ?? [], "laneOverlayPolicies", issues, "shared");
  validateDuplicateIds(local.laneOverlayPolicies ?? [], "laneOverlayPolicies", issues, "local");
  validateDuplicateIds(shared.automations ?? [], "automations", issues, "shared");
  validateDuplicateIds(local.automations ?? [], "automations", issues, "local");

  const prPoll = effective.github?.prPollingIntervalSeconds;
  if (prPoll != null) {
    if (!Number.isFinite(prPoll) || prPoll <= 0) {
      issues.push({ path: "effective.github.prPollingIntervalSeconds", message: "prPollingIntervalSeconds must be > 0" });
    } else if (prPoll < 5 || prPoll > 300) {
      issues.push({ path: "effective.github.prPollingIntervalSeconds", message: "prPollingIntervalSeconds must be between 5 and 300" });
    }
  }

  if (effective.environments?.length) {
    for (const [idx, mapping] of effective.environments.entries()) {
      const p = `effective.environments[${idx}]`;
      if (!mapping.branch.trim()) issues.push({ path: `${p}.branch`, message: "Environment mapping branch is required" });
      if (!mapping.env.trim()) issues.push({ path: `${p}.env`, message: "Environment mapping env is required" });
      if (mapping.color != null && mapping.color.trim().length) {
        const color = mapping.color.trim();
        if (!/^#[0-9a-fA-F]{6}$/.test(color)) {
          issues.push({ path: `${p}.color`, message: "Environment color must be a hex string like #22c55e" });
        }
      }
    }
  }

  const processIds = new Set<string>();
  for (const [idx, proc] of effective.processes.entries()) {
    const p = `effective.processes[${idx}]`;

    if (!proc.id) {
      issues.push({ path: `${p}.id`, message: "Process id is required" });
    } else if (processIds.has(proc.id)) {
      issues.push({ path: `${p}.id`, message: `Duplicate process id '${proc.id}'` });
    } else {
      processIds.add(proc.id);
    }

    if (!proc.name) issues.push({ path: `${p}.name`, message: "Process name is required" });
    if (!proc.command.length) issues.push({ path: `${p}.command`, message: "Process command must be a non-empty argv array" });
    if (!proc.cwd) issues.push({ path: `${p}.cwd`, message: "Process cwd is required" });
    if (!Number.isFinite(proc.gracefulShutdownMs) || proc.gracefulShutdownMs <= 0) {
      issues.push({ path: `${p}.gracefulShutdownMs`, message: "gracefulShutdownMs must be > 0" });
    }

    const absCwd = path.isAbsolute(proc.cwd) ? proc.cwd : path.join(projectRoot, proc.cwd);
    if (proc.cwd && !isDirectory(absCwd)) {
      issues.push({ path: `${p}.cwd`, message: `cwd does not exist: ${proc.cwd}` });
    }

    if (proc.readiness.type === "port") {
      if (!Number.isInteger(proc.readiness.port) || proc.readiness.port < 1 || proc.readiness.port > 65535) {
        issues.push({ path: `${p}.readiness.port`, message: "Port readiness requires a valid port (1-65535)" });
      }
    }

    if (proc.readiness.type === "logRegex") {
      if (!proc.readiness.pattern) {
        issues.push({ path: `${p}.readiness.pattern`, message: "logRegex readiness requires a pattern" });
      } else {
        try {
          // Validate regex syntax once during config validation.
          new RegExp(proc.readiness.pattern);
        } catch {
          issues.push({ path: `${p}.readiness.pattern`, message: "Invalid readiness regex pattern" });
        }
      }
    }
  }

  for (const [idx, proc] of effective.processes.entries()) {
    const p = `effective.processes[${idx}]`;
    for (const dep of proc.dependsOn) {
      if (!processIds.has(dep)) {
        issues.push({ path: `${p}.dependsOn`, message: `Unknown dependency '${dep}'` });
      }
    }
  }

  validateProcessCycles(effective.processes, issues);

  const stackIds = new Set<string>();
  for (const [idx, stack] of effective.stackButtons.entries()) {
    const p = `effective.stackButtons[${idx}]`;

    if (!stack.id) {
      issues.push({ path: `${p}.id`, message: "Stack button id is required" });
    } else if (stackIds.has(stack.id)) {
      issues.push({ path: `${p}.id`, message: `Duplicate stack button id '${stack.id}'` });
    } else {
      stackIds.add(stack.id);
    }

    if (!stack.name) issues.push({ path: `${p}.name`, message: "Stack button name is required" });

    for (const processId of stack.processIds) {
      if (!processIds.has(processId)) {
        issues.push({ path: `${p}.processIds`, message: `Unknown process id '${processId}'` });
      }
    }
  }

  const suiteIds = new Set<string>();
  for (const [idx, suite] of effective.testSuites.entries()) {
    const p = `effective.testSuites[${idx}]`;

    if (!suite.id) {
      issues.push({ path: `${p}.id`, message: "Test suite id is required" });
    } else if (suiteIds.has(suite.id)) {
      issues.push({ path: `${p}.id`, message: `Duplicate test suite id '${suite.id}'` });
    } else {
      suiteIds.add(suite.id);
    }

    if (!suite.name) issues.push({ path: `${p}.name`, message: "Test suite name is required" });
    if (!suite.command.length) issues.push({ path: `${p}.command`, message: "Test suite command must be a non-empty argv array" });
    if (!suite.cwd) issues.push({ path: `${p}.cwd`, message: "Test suite cwd is required" });

    const absCwd = path.isAbsolute(suite.cwd) ? suite.cwd : path.join(projectRoot, suite.cwd);
    if (suite.cwd && !isDirectory(absCwd)) {
      issues.push({ path: `${p}.cwd`, message: `cwd does not exist: ${suite.cwd}` });
    }

    if (suite.timeoutMs != null && (!Number.isFinite(suite.timeoutMs) || suite.timeoutMs <= 0)) {
      issues.push({ path: `${p}.timeoutMs`, message: "timeoutMs must be > 0 when provided" });
    }
  }

  const overlayIds = new Set<string>();
  for (const [idx, policy] of effective.laneOverlayPolicies.entries()) {
    const p = `effective.laneOverlayPolicies[${idx}]`;
    if (!policy.id) {
      issues.push({ path: `${p}.id`, message: "Lane overlay policy id is required" });
      continue;
    }
    if (overlayIds.has(policy.id)) {
      issues.push({ path: `${p}.id`, message: `Duplicate lane overlay policy id '${policy.id}'` });
    } else {
      overlayIds.add(policy.id);
    }
    if (!policy.name) {
      issues.push({ path: `${p}.name`, message: "Lane overlay policy name is required" });
    }
    const overrideCwd = policy.overrides.cwd;
    if (overrideCwd) {
      const absCwd = path.isAbsolute(overrideCwd) ? overrideCwd : path.join(projectRoot, overrideCwd);
      if (!isDirectory(absCwd)) {
        issues.push({ path: `${p}.overrides.cwd`, message: `cwd override does not exist: ${overrideCwd}` });
      }
    }
    for (const processId of policy.overrides.processIds ?? []) {
      if (!processIds.has(processId)) {
        issues.push({ path: `${p}.overrides.processIds`, message: `Unknown process id '${processId}'` });
      }
    }
    for (const suiteId of policy.overrides.testSuiteIds ?? []) {
      if (!suiteIds.has(suiteId)) {
        issues.push({ path: `${p}.overrides.testSuiteIds`, message: `Unknown test suite id '${suiteId}'` });
      }
    }
  }

  const automationIds = new Set<string>();
  for (const [idx, rule] of effective.automations.entries()) {
    const p = `effective.automations[${idx}]`;

    if (!rule.id) {
      issues.push({ path: `${p}.id`, message: "Automation id is required" });
      continue;
    }
    if (automationIds.has(rule.id)) {
      issues.push({ path: `${p}.id`, message: `Duplicate automation id '${rule.id}'` });
    } else {
      automationIds.add(rule.id);
    }

    if (!rule.name) issues.push({ path: `${p}.name`, message: "Automation name is required" });

    // Disabled rules are allowed to be incomplete (e.g. local toggles that refer to missing shared rules).
    if (!rule.enabled) continue;

    const triggerType = rule.trigger?.type;
    if (triggerType !== "session-end" && triggerType !== "commit" && triggerType !== "schedule" && triggerType !== "manual") {
      issues.push({ path: `${p}.trigger.type`, message: "Invalid trigger type" });
    }

    if (triggerType === "schedule") {
      const expr = (rule.trigger?.cron ?? "").trim();
      if (!expr) {
        issues.push({ path: `${p}.trigger.cron`, message: "Schedule trigger requires cron" });
      } else if (!cron.validate(expr)) {
        issues.push({ path: `${p}.trigger.cron`, message: `Invalid cron expression '${expr}'` });
      }
    }

    if (!rule.actions.length) {
      issues.push({ path: `${p}.actions`, message: "Enabled automation must have at least one action" });
      continue;
    }

    for (let actionIdx = 0; actionIdx < rule.actions.length; actionIdx += 1) {
      const action = rule.actions[actionIdx]!;
      const ap = `${p}.actions[${actionIdx}]`;
      const type = action.type as AutomationActionType;

      if (
        type !== "update-packs" &&
        type !== "predict-conflicts" &&
        type !== "run-tests" &&
        type !== "run-command"
      ) {
        issues.push({ path: `${ap}.type`, message: `Unknown action type '${String((action as any).type)}'` });
        continue;
      }

      if (type === "run-tests") {
        const suiteId = (action.suiteId ?? "").trim();
        if (!suiteId) {
          issues.push({ path: `${ap}.suiteId`, message: "run-tests requires suiteId" });
        } else if (!suiteIds.has(suiteId)) {
          issues.push({ path: `${ap}.suiteId`, message: `Unknown suiteId '${suiteId}'` });
        }
      }

      if (type === "run-command") {
        const command = (action.command ?? "").trim();
        if (!command) {
          issues.push({ path: `${ap}.command`, message: "run-command requires command" });
        }
      }

      if (action.timeoutMs != null && (!Number.isFinite(action.timeoutMs) || action.timeoutMs <= 0)) {
        issues.push({ path: `${ap}.timeoutMs`, message: "timeoutMs must be > 0 when provided" });
      }
      if (action.retry != null && (!Number.isFinite(action.retry) || action.retry < 0)) {
        issues.push({ path: `${ap}.retry`, message: "retry must be >= 0 when provided" });
      }
    }
  }

  return {
    ok: issues.length === 0,
    issues
  };
}

function trustError(sharedHash: string): Error {
  const err = new Error(
    `ADE_TRUST_REQUIRED: Shared config changed and must be confirmed before execution (sharedHash=${sharedHash})`
  );
  (err as Error & { code?: string }).code = "ADE_TRUST_REQUIRED";
  return err;
}

function invalidConfigError(validation: ProjectConfigValidationResult): Error {
  const first = validation.issues[0];
  const msg = first ? `${first.path}: ${first.message}` : "Unknown config validation failure";
  const err = new Error(`ADE_CONFIG_INVALID: ${msg}`);
  (err as Error & { code?: string }).code = "ADE_CONFIG_INVALID";
  return err;
}

export function createProjectConfigService({
  projectRoot,
  adeDir,
  projectId,
  db,
  logger
}: {
  projectRoot: string;
  adeDir: string;
  projectId: string;
  db: AdeDb;
  logger: Logger;
}) {
  const sharedPath = path.join(adeDir, "ade.yaml");
  const localPath = path.join(adeDir, "local.yaml");

  let lastSeenSharedHash: string | null = null;
  let lastSeenLocalHash: string | null = null;

  const getTrustedSharedHash = (): string | null => db.getJson<string>(TRUSTED_SHARED_HASH_KEY);

  const setTrustedSharedHash = (hash: string) => {
    db.setJson(TRUSTED_SHARED_HASH_KEY, hash);
  };

  const buildTrust = ({ sharedHash, localHash }: { sharedHash: string; localHash: string }): ProjectConfigTrust => {
    const approvedSharedHash = getTrustedSharedHash();
    return {
      sharedHash,
      localHash,
      approvedSharedHash,
      requiresSharedTrust: approvedSharedHash == null ? sharedHash !== EMPTY_CONTENT_HASH : approvedSharedHash !== sharedHash
    };
  };

  const syncSnapshots = (effective: EffectiveProjectConfig) => {
    const now = new Date().toISOString();

    db.run("delete from process_definitions where project_id = ?", [projectId]);
    db.run("delete from stack_buttons where project_id = ?", [projectId]);
    db.run("delete from test_suites where project_id = ?", [projectId]);

    for (const proc of effective.processes) {
      db.run(
        `
          insert into process_definitions(
            id, project_id, key, name, command_json, cwd, env_json, autostart,
            restart_policy, graceful_shutdown_ms, depends_on_json, readiness_json, updated_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          createDefId(projectId, `proc:${proc.id}`),
          projectId,
          proc.id,
          proc.name,
          JSON.stringify(proc.command),
          proc.cwd,
          JSON.stringify(proc.env),
          proc.autostart ? 1 : 0,
          proc.restart,
          proc.gracefulShutdownMs,
          JSON.stringify(proc.dependsOn),
          JSON.stringify(proc.readiness),
          now
        ]
      );
    }

    for (const stack of effective.stackButtons) {
      db.run(
        `
          insert into stack_buttons(
            id, project_id, key, name, process_keys_json, start_order, updated_at
          ) values (?, ?, ?, ?, ?, ?, ?)
        `,
        [
          createDefId(projectId, `stack:${stack.id}`),
          projectId,
          stack.id,
          stack.name,
          JSON.stringify(stack.processIds),
          stack.startOrder,
          now
        ]
      );
    }

    for (const suite of effective.testSuites) {
      db.run(
        `
          insert into test_suites(
            id, project_id, key, name, command_json, cwd, env_json, timeout_ms, tags_json, updated_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          createDefId(projectId, `suite:${suite.id}`),
          projectId,
          suite.id,
          suite.name,
          JSON.stringify(suite.command),
          suite.cwd,
          JSON.stringify(suite.env),
          suite.timeoutMs,
          JSON.stringify(suite.tags),
          now
        ]
      );
    }
  };

  const buildSnapshotFromFiles = (
    shared: ProjectConfigFile,
    local: ProjectConfigFile,
    hashes: { sharedHash: string; localHash: string },
    options: { persistSnapshots: boolean }
  ): ProjectConfigSnapshot => {
    const effective = resolveEffectiveConfig(shared, local);
    const validation = validateEffectiveConfig(effective, projectRoot, shared, local);
    const trust = buildTrust(hashes);

    if (options.persistSnapshots && validation.ok) {
      syncSnapshots(effective);
    }

    return {
      shared,
      local,
      effective,
      validation,
      trust,
      paths: { sharedPath, localPath }
    };
  };

  const readSnapshotFromDisk = (): ProjectConfigSnapshot => {
    fs.mkdirSync(adeDir, { recursive: true });

    const sharedFile = readConfigFile(sharedPath);
    const localFile = readConfigFile(localPath);

    const sharedHash = hashContent(sharedFile.raw);
    const localHash = hashContent(localFile.raw);

    return buildSnapshotFromFiles(sharedFile.config, localFile.config, { sharedHash, localHash }, { persistSnapshots: true });
  };

  const validateCandidate = (shared: ProjectConfigFile, local: ProjectConfigFile): ProjectConfigValidationResult => {
    const sharedHash = hashContent(toCanonicalYaml(shared));
    const localHash = hashContent(toCanonicalYaml(local));
    const snapshot = buildSnapshotFromFiles(shared, local, { sharedHash, localHash }, { persistSnapshots: false });
    return snapshot.validation;
  };

  return {
    get(): ProjectConfigSnapshot {
      const snapshot = readSnapshotFromDisk();
      lastSeenSharedHash = snapshot.trust.sharedHash;
      lastSeenLocalHash = snapshot.trust.localHash;
      return snapshot;
    },

    validate(candidate: ProjectConfigCandidate): ProjectConfigValidationResult {
      const shared = coerceConfigFile(candidate.shared);
      const local = coerceConfigFile(candidate.local);
      return validateCandidate(shared, local);
    },

    save(candidate: ProjectConfigCandidate): ProjectConfigSnapshot {
      const shared = coerceConfigFile(candidate.shared);
      const local = coerceConfigFile(candidate.local);
      const validation = validateCandidate(shared, local);
      if (!validation.ok) {
        throw invalidConfigError(validation);
      }

      const sharedYaml = toCanonicalYaml(shared);
      const localYaml = toCanonicalYaml(local);

      fs.mkdirSync(path.dirname(sharedPath), { recursive: true });
      fs.writeFileSync(sharedPath, sharedYaml, "utf8");
      fs.writeFileSync(localPath, localYaml, "utf8");

      const sharedHash = hashContent(sharedYaml);
      setTrustedSharedHash(sharedHash);

      logger.info("projectConfig.save", {
        sharedPath,
        localPath,
        sharedHash,
        sharedProcesses: shared.processes?.length ?? 0,
        localProcesses: local.processes?.length ?? 0
      });

      const snapshot = readSnapshotFromDisk();
      lastSeenSharedHash = snapshot.trust.sharedHash;
      lastSeenLocalHash = snapshot.trust.localHash;
      return snapshot;
    },

    diffAgainstDisk(): ProjectConfigDiff {
      const snapshot = readSnapshotFromDisk();
      const sharedChanged = lastSeenSharedHash != null ? snapshot.trust.sharedHash !== lastSeenSharedHash : false;
      const localChanged = lastSeenLocalHash != null ? snapshot.trust.localHash !== lastSeenLocalHash : false;
      return {
        sharedChanged,
        localChanged,
        sharedHash: snapshot.trust.sharedHash,
        localHash: snapshot.trust.localHash,
        approvedSharedHash: snapshot.trust.approvedSharedHash,
        requiresSharedTrust: snapshot.trust.requiresSharedTrust
      };
    },

    confirmTrust({ sharedHash }: { sharedHash?: string } = {}): ProjectConfigTrust {
      const snapshot = readSnapshotFromDisk();
      if (sharedHash && sharedHash !== snapshot.trust.sharedHash) {
        throw new Error("Shared hash mismatch while confirming trust");
      }

      setTrustedSharedHash(snapshot.trust.sharedHash);
      logger.info("projectConfig.confirmTrust", { sharedHash: snapshot.trust.sharedHash });
      return {
        ...snapshot.trust,
        approvedSharedHash: snapshot.trust.sharedHash,
        requiresSharedTrust: false
      };
    },

    getEffective(): EffectiveProjectConfig {
      const snapshot = readSnapshotFromDisk();
      lastSeenSharedHash = snapshot.trust.sharedHash;
      lastSeenLocalHash = snapshot.trust.localHash;
      if (!snapshot.validation.ok) {
        throw invalidConfigError(snapshot.validation);
      }
      return snapshot.effective;
    },

    getExecutableConfig(): EffectiveProjectConfig {
      const snapshot = readSnapshotFromDisk();
      lastSeenSharedHash = snapshot.trust.sharedHash;
      lastSeenLocalHash = snapshot.trust.localHash;
      if (!snapshot.validation.ok) {
        throw invalidConfigError(snapshot.validation);
      }
      if (snapshot.trust.requiresSharedTrust) {
        throw trustError(snapshot.trust.sharedHash);
      }
      return snapshot.effective;
    }
  };
}
