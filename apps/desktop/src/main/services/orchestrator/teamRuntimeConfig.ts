/**
 * teamRuntimeConfig.ts
 *
 * Team runtime configuration: template parsing, policy flags, role definitions,
 * team runtime config resolution and normalization.
 *
 * Extracted from aiOrchestratorService.ts — pure refactor, no behavior changes.
 */

import type {
  OrchestratorContext,
} from "./orchestratorContext";
import {
  isRecord,
} from "./orchestratorContext";
import type {
  TeamTemplate,
  TeamRuntimeConfig,
  RoleDefinition,
  MissionPolicyFlags,
  MissionAgentRuntimeConfig,
  ModelConfig,
} from "../../../shared/types";
import { getErrorMessage } from "../shared/utils";

// ── Constants ────────────────────────────────────────────────────

export const DEFAULT_MISSION_POLICY_FLAGS: MissionPolicyFlags = {
  clarificationMode: "auto_if_uncertain",
  maxClarificationQuestions: 5,
  strictTdd: false,
  requireValidatorPass: true,
  maxParallelWorkers: 4,
  riskApprovalMode: "confirm_high_risk"
};

export const REQUIRED_TEAM_CAPABILITIES = ["coordinator", "planner", "validator"] as const;

export const DEFAULT_TEAM_TEMPLATE: TeamTemplate = {
  id: "default-autonomy-template",
  name: "Autonomous Team",
  roles: [
    {
      name: "coordinator",
      description: "Mission lead that plans, delegates, and decides recovery strategy.",
      capabilities: ["coordinator", "planner"],
      defaultModel: { provider: "claude", modelId: "anthropic/claude-sonnet-4-6", thinkingLevel: "high" },
      maxInstances: 1,
      toolProfile: {
        allowedTools: [
          "spawn_worker",
          "request_specialist",
          "revise_plan",
          "retry_step",
          "skip_step",
          "read_mission_status",
          "message_worker",
          "read_file",
          "search_files",
          "get_project_context",
          "report_status",
          "report_result",
          "report_validation",
          "update_tool_profiles",
          "transfer_lane"
        ]
      }
    },
    {
      name: "implementer",
      description: "Executes implementation tasks and reports structured progress/results.",
      capabilities: ["implementation"],
      defaultModel: { provider: "codex", modelId: "openai/gpt-5.3-codex", thinkingLevel: "medium" },
      maxInstances: 12
    },
    {
      name: "validator",
      description: "Validates outputs at gates and returns actionable remediation guidance.",
      capabilities: ["validator", "review", "testing"],
      defaultModel: { provider: "claude", modelId: "anthropic/claude-sonnet-4-6", thinkingLevel: "medium" },
      maxInstances: 4
    }
  ],
  policyDefaults: DEFAULT_MISSION_POLICY_FLAGS,
  constraints: {
    maxWorkers: 20,
    requiredRoles: [...REQUIRED_TEAM_CAPABILITIES]
  }
};

// ── Agent runtime flag normalization ─────────────────────────────

/** Normalize optional boolean agent runtime flags to concrete booleans (default true). */
export function normalizeAgentRuntimeFlags(
  raw: Partial<MissionAgentRuntimeConfig> | undefined | null
): MissionAgentRuntimeConfig {
  return {
    allowParallelAgents: raw?.allowParallelAgents !== false,
    allowSubAgents: raw?.allowSubAgents !== false,
    allowClaudeAgentTeams: raw?.allowClaudeAgentTeams !== false,
  };
}

// ── Pure Parsing Functions ────────────────────────────────────────

export function toClampedToolProfileMap(value: unknown): TeamRuntimeConfig["toolProfiles"] {
  if (!isRecord(value)) return undefined;
  const out: Record<string, { allowedTools: string[]; blockedTools?: string[]; mcpServers?: string[]; notes?: string }> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!isRecord(raw)) continue;
    const allowedTools = Array.isArray(raw.allowedTools)
      ? raw.allowedTools.map((entry) => String(entry ?? "").trim()).filter((entry) => entry.length > 0)
      : [];
    if (!allowedTools.length) continue;
    const blockedTools = Array.isArray(raw.blockedTools)
      ? raw.blockedTools.map((entry) => String(entry ?? "").trim()).filter((entry) => entry.length > 0)
      : undefined;
    const mcpServers = Array.isArray(raw.mcpServers)
      ? raw.mcpServers.map((entry) => String(entry ?? "").trim()).filter((entry) => entry.length > 0)
      : undefined;
    out[key] = {
      allowedTools,
      ...(blockedTools && blockedTools.length > 0 ? { blockedTools } : {}),
      ...(mcpServers && mcpServers.length > 0 ? { mcpServers } : {}),
      ...(typeof raw.notes === "string" && raw.notes.trim().length > 0 ? { notes: raw.notes.trim() } : {})
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function parsePolicyFlags(value: unknown): MissionPolicyFlags | undefined {
  if (!isRecord(value)) return undefined;
  const maxQuestions = Number(value.maxClarificationQuestions);
  const maxParallelWorkers = Number(value.maxParallelWorkers);
  return {
    clarificationMode:
      value.clarificationMode === "always" ||
      value.clarificationMode === "auto_if_uncertain" ||
      value.clarificationMode === "off"
        ? value.clarificationMode
        : undefined,
    maxClarificationQuestions: Number.isFinite(maxQuestions) ? Math.max(1, Math.min(20, Math.floor(maxQuestions))) : undefined,
    strictTdd: typeof value.strictTdd === "boolean" ? value.strictTdd : undefined,
    requireValidatorPass: typeof value.requireValidatorPass === "boolean" ? value.requireValidatorPass : undefined,
    maxParallelWorkers: Number.isFinite(maxParallelWorkers) ? Math.max(1, Math.min(32, Math.floor(maxParallelWorkers))) : undefined,
    riskApprovalMode:
      value.riskApprovalMode === "auto" ||
      value.riskApprovalMode === "confirm_high_risk" ||
      value.riskApprovalMode === "confirm_all"
        ? value.riskApprovalMode
        : undefined
  };
}

export function parseRoleDefinition(value: unknown): RoleDefinition | null {
  if (!isRecord(value)) return null;
  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!name.length) return null;
  const description = typeof value.description === "string" ? value.description.trim() : "";
  const capabilities = Array.isArray(value.capabilities)
    ? value.capabilities.map((entry) => String(entry ?? "").trim()).filter((entry) => entry.length > 0)
    : [];
  const defaultModel = isRecord(value.defaultModel) ? value.defaultModel : null;
  const provider = defaultModel?.provider === "claude" || defaultModel?.provider === "codex" ? defaultModel.provider : null;
  const modelId = typeof defaultModel?.modelId === "string" ? defaultModel.modelId.trim() : "";
  if (!provider || !modelId.length) return null;
  const maxInstancesRaw = Number(value.maxInstances);
  return {
    name,
    description: description.length ? description : `${name} role`,
    capabilities,
    defaultModel: {
      provider,
      modelId,
      ...(defaultModel?.thinkingLevel && typeof defaultModel.thinkingLevel === "string"
        ? { thinkingLevel: defaultModel.thinkingLevel as ModelConfig["thinkingLevel"] }
        : {})
    },
    ...(Number.isFinite(maxInstancesRaw) && maxInstancesRaw > 0
      ? { maxInstances: Math.max(1, Math.min(100, Math.floor(maxInstancesRaw))) }
      : {})
  };
}

export function parseTeamTemplate(value: unknown): TeamTemplate | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === "string" && value.id.trim().length > 0
    ? value.id.trim()
    : DEFAULT_TEAM_TEMPLATE.id;
  const name = typeof value.name === "string" && value.name.trim().length > 0
    ? value.name.trim()
    : DEFAULT_TEAM_TEMPLATE.name;
  const roles = Array.isArray(value.roles)
    ? value.roles.map((entry) => parseRoleDefinition(entry)).filter((entry): entry is RoleDefinition => !!entry)
    : [];
  const constraints = isRecord(value.constraints) ? value.constraints : null;
  const maxWorkersRaw = Number(constraints?.maxWorkers);
  const requiredRoles = Array.isArray(constraints?.requiredRoles)
    ? constraints.requiredRoles.map((entry) => String(entry ?? "").trim()).filter((entry) => entry.length > 0)
    : [...REQUIRED_TEAM_CAPABILITIES];
  return {
    id,
    name,
    roles: roles.length > 0 ? roles : DEFAULT_TEAM_TEMPLATE.roles,
    policyDefaults: {
      ...DEFAULT_MISSION_POLICY_FLAGS,
      ...(parsePolicyFlags(value.policyDefaults) ?? {})
    },
    constraints: {
      maxWorkers: Number.isFinite(maxWorkersRaw) ? Math.max(1, Math.min(100, Math.floor(maxWorkersRaw))) : DEFAULT_TEAM_TEMPLATE.constraints.maxWorkers,
      requiredRoles
    }
  };
}

export function missingRequiredCapabilities(template: TeamTemplate): string[] {
  const roleNames = new Set(template.roles.map((role) => role.name.toLowerCase()));
  const roleCapabilities = new Set(
    template.roles.flatMap((role) => role.capabilities.map((capability) => capability.toLowerCase()))
  );
  const required = template.constraints.requiredRoles.length
    ? template.constraints.requiredRoles
    : [...REQUIRED_TEAM_CAPABILITIES];
  const missing: string[] = [];
  for (const requiredEntry of required) {
    const normalized = requiredEntry.toLowerCase();
    if (roleNames.has(normalized)) continue;
    if (roleCapabilities.has(normalized)) continue;
    missing.push(requiredEntry);
  }
  return missing;
}

// ── Context-dependent Functions ──────────────────────────────────

/** Resolve team runtime config from mission launch metadata */
export function resolveMissionTeamRuntime(
  ctx: OrchestratorContext,
  missionId: string
): TeamRuntimeConfig | null {
  try {
    const row = ctx.db.get<{ metadata_json: string | null }>(
      "select metadata_json from missions where id = ? limit 1",
      [missionId]
    );
    if (row?.metadata_json) {
      const metadata = JSON.parse(row.metadata_json);
      const launch = isRecord(metadata.launch) ? metadata.launch : null;
      const teamRuntime = launch && isRecord(launch.teamRuntime) ? launch.teamRuntime : null;
      if (teamRuntime && teamRuntime.enabled === true) {
        const parsedTemplate = parseTeamTemplate(teamRuntime.template);
        const template = parsedTemplate ?? DEFAULT_TEAM_TEMPLATE;
        const missing = missingRequiredCapabilities(template);
        if (missing.length > 0) {
          throw new Error(`teamRuntime template missing required roles/capabilities: ${missing.join(", ")}`);
        }
        const teammateCount = typeof teamRuntime.teammateCount === "number"
          ? Math.max(0, Math.min(20, Math.floor(teamRuntime.teammateCount)))
          : 2;
        const boundedTeammateCount = Math.min(teammateCount, Math.max(0, template.constraints.maxWorkers - 1));
        return {
          enabled: true,
          targetProvider: (teamRuntime.targetProvider === "claude" || teamRuntime.targetProvider === "codex") ? teamRuntime.targetProvider : "auto",
          teammateCount: boundedTeammateCount,
          ...normalizeAgentRuntimeFlags(teamRuntime as Partial<MissionAgentRuntimeConfig>),
          template,
          toolProfiles: toClampedToolProfileMap(teamRuntime.toolProfiles),
          mcpServerAllowlist: Array.isArray(teamRuntime.mcpServerAllowlist)
            ? (teamRuntime.mcpServerAllowlist as unknown[])
                .map((entry: unknown) => String(entry ?? "").trim())
                .filter((entry) => entry.length > 0)
            : undefined,
          policyOverrides: parsePolicyFlags(teamRuntime.policyOverrides)
        };
      }
    }
  } catch (error) {
    ctx.logger.warn("ai_orchestrator.team_runtime_config_invalid", {
      missionId,
      error: getErrorMessage(error)
    });
    throw error;
  }
  return null;
}

export function normalizeTeamRuntimeConfig(_missionId: string, config: TeamRuntimeConfig): TeamRuntimeConfig {
  if (!config.enabled) return config;
  const template = parseTeamTemplate(config.template) ?? DEFAULT_TEAM_TEMPLATE;
  const missing = missingRequiredCapabilities(template);
  if (missing.length > 0) {
    throw new Error(`teamRuntime template missing required roles/capabilities: ${missing.join(", ")}`);
  }
  const teammateCount = Math.max(
    0,
    Math.min(
      20,
      Math.min(
        Number.isFinite(Number(config.teammateCount)) ? Math.floor(Number(config.teammateCount)) : 2,
        Math.max(0, template.constraints.maxWorkers - 1)
      )
    )
  );
  const policyOverrides = {
    ...DEFAULT_MISSION_POLICY_FLAGS,
    ...(config.policyOverrides ?? {})
  };
  return {
    ...config,
    targetProvider:
      config.targetProvider === "claude" || config.targetProvider === "codex" || config.targetProvider === "auto"
        ? config.targetProvider
        : "auto",
    teammateCount,
    ...normalizeAgentRuntimeFlags(config),
    template,
    policyOverrides
  };
}
