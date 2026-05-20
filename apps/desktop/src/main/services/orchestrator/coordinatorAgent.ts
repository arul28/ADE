// ---------------------------------------------------------------------------
// Coordinator Agent — the AI brain of the orchestrator.
// A long-running AI agent with full authority to plan, spawn workers,
// monitor progress, steer execution, and complete missions autonomously.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import type { RuntimeModelMessage as ModelMessage } from "../chat/runtimeMessageTypes";
import {
  classifyPlannerLaunchFailure,
  COORDINATOR_TOOL_NAMES,
  createCoordinatorToolSet,
  type CoordinatorExecutableTool,
  type CoordinatorSendWorkerMessageFn,
} from "./coordinatorTools";
import {
  buildOpenCodePromptParts,
  mapPermissionModeToOpenCodeAgent,
  openCodeEventStream,
  refreshOpenCodeSessionToolSelection,
  resolveOpenCodeModelSelection,
  startOpenCodeSession,
  type OpenCodeSessionHandle,
} from "../opencode/openCodeRuntime";
import {
  formatRuntimeEvent,
} from "./coordinatorEventFormatter";
import {
  createCompactionMonitor,
  compactConversation,
  type CompactionMonitor,
  type TranscriptEntry,
} from "../ai/compactionEngine";
import { asRecord, filterExecutionSteps, TERMINAL_STEP_STATUSES } from "./orchestratorContext";
import { readMissionStateDocument, writeCoordinatorCheckpoint } from "./missionStateDoc";
import {
  classifyWorkerExecutionPath,
  getLocalProviderDefaultEndpoint,
  resolveModelDescriptor,
  resolveProviderGroupForModel,
  type LocalProviderFamily,
} from "../../../shared/modelRegistry";
import { inspectLocalProvider } from "../ai/localModelDiscovery";
import type { DiscoveredLocalModelEntry } from "../opencode/openCodeRuntime";
import type { createOrchestratorService } from "./orchestratorService";
import type {
  AgentChatEvent,
  DelegationContract,
  DelegationFailureCategory,
  DagMutationEvent,
  MissionBudgetSnapshot,
  MissionInterventionType,
  OrchestratorRuntimeEvent,
  OrchestratorStep,
  OrchestratorStepStatus,
  PhaseCard,
} from "../../../shared/types";
import type { Logger } from "../logging/logger";
import type { AdeDb } from "../state/kvDb";
import type { createMissionService } from "../missions/missionService";
import type { createMemoryService } from "../memory/memoryService";
import type { createProjectConfigService } from "../config/projectConfigService";
import type { createAiIntegrationService } from "../ai/aiIntegrationService";
import type { createAgentChatService } from "../chat/agentChatService";
import {
  checkCoordinatorToolPermission,
  createDelegationContract,
  createDelegationScope,
  derivePlanningStartupStateFromContract,
  extractDelegationContract,
  extractActiveDelegationContracts,
  normalizeCoordinatorToolName,
  updateDelegationContract,
} from "./delegationContracts";
import { findPhaseByRef, resolveMustPrecedePredecessors } from "../missions/phaseEngine";
import {
  hasResolvedPlanningQuestionIntervention,
  phaseRequiresPlanningQuestionBeforeExit,
} from "./planningQuestionPolicy";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** User-configured rules that constrain the coordinator's behavior. */
export type CoordinatorUserRules = {
  providerPreference?: string;
  costMode?: string;
  maxParallelWorkers?: number;
  allowParallelAgents?: boolean;
  allowSubAgents?: boolean;
  allowClaudeAgentTeams?: boolean;
  laneStrategy?: string;
  customInstructions?: string;
  coordinatorModel?: string;
  closeoutContract?: string;
  budgetLimitUsd?: number;
  budgetLimitTokens?: number;
  recoveryEnabled?: boolean;
  recoveryMaxIterations?: number;
};

/** Project context provided to the coordinator at startup. */
export type CoordinatorProjectContext = {
  projectRoot: string;
  projectDocPaths?: string[];
  projectKnowledge?: string[];
  fileTree?: string;
};

/** Available provider info passed to the coordinator. */
export type CoordinatorAvailableProvider = {
  name: string;
  available: boolean;
  models?: string[];
};

export type CoordinatorAgentDeps = {
  orchestratorService: ReturnType<typeof createOrchestratorService>;
  runId: string;
  missionId: string;
  missionGoal: string;
  modelId: string;
  logger: Logger;
  db: AdeDb;
  projectId: string;
  projectRoot: string;
  workspaceRoot: string;
  missionService: ReturnType<typeof createMissionService>;
  aiIntegrationService: Pick<ReturnType<typeof createAiIntegrationService>, "executeTask"> | null;
  agentChatService?: Pick<
    ReturnType<typeof createAgentChatService>,
    "createSession" | "runSessionTurn" | "interrupt" | "dispose"
  > | null;
  projectConfigService?: ReturnType<typeof createProjectConfigService> | null;
  memoryService?: ReturnType<typeof createMemoryService> | null;
  getMissionBudgetStatus?: () => Promise<MissionBudgetSnapshot | null>;
  onDagMutation: (event: DagMutationEvent) => void;
  onCoordinatorMessage?: (message: string) => void;
  onCoordinatorEvent?: (event: AgentChatEvent) => void;
  onRunFinalize?: (args: { runId: string; succeeded: boolean; summary?: string; reason?: string }) => void;
  enableCompaction?: boolean;
  userRules?: CoordinatorUserRules;
  projectContext?: CoordinatorProjectContext;
  availableProviders?: CoordinatorAvailableProvider[];
  /** Phase cards defining the mission execution phases — injected into the coordinator prompt. */
  phases?: PhaseCard[];
  /** Called when spawn_worker detects a budget hard cap. Orchestrator creates a pause intervention. */
  onHardCapTriggered?: (detail: string) => void;
  /** Called when budget pressure transitions to warning or critical. Emits a soft warning chat message. */
  onBudgetWarning?: (pressure: "warning" | "critical", detail: string) => void;
  /** Runtime worker delivery bridge used by coordinator messaging tools. */
  sendWorkerMessageToSession?: CoordinatorSendWorkerMessageFn;
  /** Primary mission lane ID — all mission work should happen in this lane (or children of it). */
  missionLaneId?: string;
  /** Reasoning effort selected by the mission picker for the coordinator model. */
  coordinatorReasoningEffort?: string | null;
  /** Registers the Work-chat session backing the coordinator runtime. */
  onCoordinatorChatSessionStarted?: (args: { sessionId: string; missionId: string; runId: string; laneId: string | null }) => void;
  /** Marks autonomous coordinator Work-chat turns so external chat observers do not replay them twice. */
  onCoordinatorChatRuntimeTurnStarted?: (args: { sessionId: string; missionId: string; runId: string; laneId: string | null }) => void;
  onCoordinatorChatRuntimeTurnFinished?: (args: { sessionId: string; missionId: string; runId: string; laneId: string | null }) => void;
  /** Callback to create a new lane branching from the mission's base lane. */
  provisionLane?: (name: string, description?: string) => Promise<{ laneId: string; name: string }>;
  onPlanningStartupFailure?: (failure: CoordinatorPlanningStartupFailure) => void;
  onCoordinatorRuntimeFailure?: (failure: CoordinatorRuntimeFailure) => void;
};

export type PlanningStartupState =
  | "inactive"
  | "awaiting_project_context"
  | "awaiting_planner_launch"
  | "waiting_on_planner"
  | "failed";

export type CoordinatorPlanningStartupFailure = {
  category: DelegationFailureCategory;
  reasonCode: string;
  interventionType: MissionInterventionType;
  retryable: boolean;
  recoveryOptions: Array<"retry" | "switch_to_fallback_model" | "cancel_run">;
  message: string;
  title: string;
  body: string;
  requestedAction: string;
  toolName?: string | null;
  retryCount: number;
};

export type CoordinatorRuntimeFailureCategory =
  | "provider_unreachable"
  | "permission_denied"
  | "cli_runtime_failure"
  | "unknown";

export type CoordinatorRuntimeFailure = {
  category: CoordinatorRuntimeFailureCategory;
  reasonCode: string;
  interventionType: MissionInterventionType;
  retryable: boolean;
  recoveryOptions: Array<"retry" | "switch_to_fallback_model" | "cancel_run">;
  message: string;
  title: string;
  body: string;
  requestedAction: string;
  turnId: string;
};

type QueuedEvent = {
  message: string;
  receivedAt: number;
  retryCount?: number;
};

type PhaseTransitionRequiredSignal = {
  phaseKey: string;
  reason: string;
};

type SelfValidationDecision = {
  verdict: "pass" | "fail";
  summary: string;
  findings: Array<{
    code: string;
    severity: "low" | "medium" | "high";
    message: string;
    remediation?: string;
  }>;
};

type RecoveredCoordinatorToolCall = {
  toolName: string;
  args: Record<string, unknown>;
};

type RecoveredToolExecutionContext = {
  hadRunningWorkers: boolean;
  hadActionableSteps: boolean;
};

const RECOVERED_PARALLEL_TOOL_NAMES = new Set(["parallel", "multi_tool_use.parallel"]);

function isRecoveredCoordinatorToolLabel(label: string): boolean {
  const normalized = normalizeCoordinatorToolName(label).trim();
  if (RECOVERED_PARALLEL_TOOL_NAMES.has(normalized.toLowerCase())) return true;
  return (COORDINATOR_TOOL_NAMES as readonly string[]).includes(normalized);
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function coerceToolOutputRecord(value: unknown): Record<string, unknown> | null {
  const direct = asRecord(value);
  if (direct?.ok !== undefined || direct?.error !== undefined || direct?.delegationContract !== undefined) {
    return direct;
  }

  if (typeof value === "string") {
    return parseJsonObject(value);
  }

  const nestedOutput = direct ? direct.output : undefined;
  if (nestedOutput !== undefined) {
    const nested = coerceToolOutputRecord(nestedOutput);
    if (nested) return nested;
  }

  const content = Array.isArray(direct?.content) ? direct.content : [];
  for (const entry of content) {
    const item = asRecord(entry);
    const text = typeof item?.text === "string" ? item.text.trim() : "";
    if (!text) continue;
    const parsed = parseJsonObject(text);
    if (parsed) return parsed;
  }

  return direct;
}

function stringifyRecoveredToolOutputForPrompt(value: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    serialized = String(value ?? "null");
  }
  if (serialized.length <= RECOVERED_TOOL_RESULT_MAX_CHARS) return serialized;
  return `${serialized.slice(0, RECOVERED_TOOL_RESULT_MAX_CHARS)}...[truncated]`;
}

function joinRecoveredToolResultSummaries(summaries: string[]): string {
  const joined = summaries.join("\n");
  if (joined.length <= RECOVERED_TOOL_RESULTS_MAX_CHARS) return joined;
  return `${joined.slice(0, RECOVERED_TOOL_RESULTS_MAX_CHARS)}\n[recovered tool results truncated]`;
}

function extractPhaseTransitionRequiredSignal(value: Record<string, unknown> | null): PhaseTransitionRequiredSignal | null {
  if (!value) return null;
  const direct = asRecord(value.phaseTransitionRequired);
  const directPhaseKey = typeof direct?.phaseKey === "string" ? direct.phaseKey.trim() : "";
  const directReason = typeof direct?.reason === "string" ? direct.reason.trim() : "";
  if (directPhaseKey.length > 0) {
    return {
      phaseKey: directPhaseKey,
      reason: directReason || "planning_complete",
    };
  }

  const requiredTool = asRecord(value.requiredTool);
  const requiredToolName = typeof requiredTool?.name === "string" ? requiredTool.name.trim() : "";
  const requiredArgs = asRecord(requiredTool?.args);
  const toolPhaseKey = typeof requiredArgs?.phaseKey === "string" ? requiredArgs.phaseKey.trim() : "";
  const toolReason = typeof requiredArgs?.reason === "string" ? requiredArgs.reason.trim() : "";
  if (requiredToolName === "set_current_phase" && toolPhaseKey.length > 0) {
    return {
      phaseKey: toolPhaseKey,
      reason: toolReason || "planning_complete",
    };
  }

  return null;
}

function parsePseudoToolJson(value: string): unknown {
  const withoutLineComments = value
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n")
    .trim();
  if (!withoutLineComments.length) return null;
  return JSON.parse(withoutLineComments);
}

function findJsonValueStart(value: string, fromIndex: number): number {
  for (let index = fromIndex; index < value.length; index += 1) {
    const char = value[index];
    if (char === "{" || char === "[") return index;
    if (char === "`") continue;
    if (/\s/.test(char ?? "")) continue;
    return -1;
  }
  return -1;
}

function extractBalancedJsonValue(value: string, startIndex: number): { raw: string; endIndex: number } | null {
  const open = value[startIndex];
  const close = open === "{" ? "}" : open === "[" ? "]" : "";
  if (!close) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = startIndex; index < value.length; index += 1) {
    const char = value[index] ?? "";
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === open) depth += 1;
    if (char === close) {
      depth -= 1;
      if (depth === 0) {
        return {
          raw: value.slice(startIndex, index + 1),
          endIndex: index + 1,
        };
      }
    }
  }
  return null;
}

function readRecoveredCallName(record: Record<string, unknown> | null): string {
  if (typeof record?.name === "string") return record.name.trim();
  if (typeof record?.recipient_name === "string") return record.recipient_name.trim();
  return "";
}

function pushRecoveredParsedCall(
  calls: RecoveredCoordinatorToolCall[],
  toolName: string,
  parsed: unknown,
): void {
  const normalizedLabel = toolName.trim();
  if (/^(?:multi_tool_use\.)?parallel$/i.test(normalizedLabel)) {
    const entries = Array.isArray(parsed) ? parsed : [];
    for (const entry of entries) {
      const raw = asRecord(entry);
      const rawName = readRecoveredCallName(raw);
      const args = asRecord(raw?.arguments ?? raw?.parameters ?? raw?.args) ?? {};
      if (rawName.length > 0) calls.push({ toolName: rawName, args });
    }
    return;
  }

  const parsedRecord = asRecord(parsed);
  if (normalizedLabel.length > 0 && parsedRecord) {
    calls.push({ toolName: normalizedLabel, args: parsedRecord });
    return;
  }

  if (!parsedRecord) return;
  const rawName = readRecoveredCallName(parsedRecord);
  const args = asRecord(parsedRecord?.arguments ?? parsedRecord?.parameters ?? parsedRecord?.args) ?? null;
  if (rawName.length > 0 && args) {
    calls.push({ toolName: rawName, args });
  }
}

function parseRecoveredCoordinatorToolCallsFromLabels(assistantText: string): RecoveredCoordinatorToolCall[] {
  const calls: RecoveredCoordinatorToolCall[] = [];
  const labelPattern = /^[ \t]*\/\/\s*([A-Za-z0-9_.:-]+)\s*$/gm;
  let match: RegExpExecArray | null;
  while ((match = labelPattern.exec(assistantText)) !== null) {
    const label = match[1]?.trim() ?? "";
    if (!isRecoveredCoordinatorToolLabel(label)) continue;
    const start = findJsonValueStart(assistantText, labelPattern.lastIndex);
    if (start < 0) continue;
    const extracted = extractBalancedJsonValue(assistantText, start);
    if (!extracted) continue;
    try {
      pushRecoveredParsedCall(calls, label, JSON.parse(extracted.raw));
      labelPattern.lastIndex = extracted.endIndex;
    } catch {
      continue;
    }
  }
  return calls;
}

function parseRecoveredCoordinatorToolCallsFromFences(assistantText: string): RecoveredCoordinatorToolCall[] {
  const calls: RecoveredCoordinatorToolCall[] = [];
  const fencePattern = /```(?:json|js|javascript)?\s*\n([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = fencePattern.exec(assistantText)) !== null) {
    const body = match[1]?.trim() ?? "";
    if (!body.length) continue;
    const label = body
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.startsWith("//"))
      ?.replace(/^\/\/\s*/, "")
      .trim() ?? "";
    let parsed: unknown;
    try {
      parsed = parsePseudoToolJson(body);
    } catch {
      continue;
    }
    pushRecoveredParsedCall(calls, label, parsed);
  }
  return calls;
}

function parseRecoveredCoordinatorToolCalls(assistantText: string): RecoveredCoordinatorToolCall[] {
  const calls = parseRecoveredCoordinatorToolCallsFromLabels(assistantText);
  if (calls.length > 0) return calls;
  return parseRecoveredCoordinatorToolCallsFromFences(assistantText);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BATCH_DELAY_MS = 200;
const MAX_TOOL_STEPS_PER_TURN = 25;
const COMPACTION_THRESHOLD_RATIO = 0.50;
const MAX_CONVERSATION_HISTORY = 200;
const MAX_EVENT_RETRY_COUNT = 2;
const CHECKPOINT_TURN_INTERVAL = 5;
const CHECKPOINT_SUMMARY_MAX_CHARS = 8_000;
const COORDINATOR_TURN_TIMEOUT_MS = 120_000;
const COORDINATOR_IDLE_SESSION_TTL_MS = 5 * 60 * 1000;
const PLANNING_STARTUP_RETRY_LIMIT = 1;
const POST_PLANNING_PHASE_TRANSITION_RETRY_LIMIT = 1;
const PHASE_TRANSITION_CORRECTION_LIMIT = 3;
const PLANNER_LAUNCH_TRACKER_STEP_KEY = "planner-launch-tracker";
const CHAT_RUNTIME_TOOL_TRANSPORT = [
  "## ADE Mission-Control Tool Transport",
  "This coordinator runs in the same ADE Work chat runtime stack as normal chats. Provider-native tools are not the mission-control API.",
  "To call ADE mission-control tools, emit fenced JSON. ADE will replay those calls through real mission-control tools and enforce lane, phase, budget, and policy rules.",
  "When a recovery note says to call a mission-control tool, do not report that tools are unavailable. Emit the fenced JSON call instead; ADE executes it after your turn.",
  "Single tool call format:",
  "```json",
  "// tool_name",
  "{\"argName\":\"value\"}",
  "```",
  "Parallel tool call format:",
  "```json",
  "// multi_tool_use.parallel",
  "[{\"name\":\"tool_name\",\"arguments\":{\"argName\":\"value\"}}]",
  "```",
  "Use tool names from the Tool Quick Reference below, with or without an ade_ prefix. Keep surrounding prose minimal; when action is required, emit the tool-call block.",
].join("\n");
const COORDINATOR_PLAN_TOOL_SELECTION: Record<string, boolean> = {
  // Force planning startup through ADE mission-control tools. OpenCode's
  // native tools bypass the mission graph and planner delegation contract.
  task: false,
  glob: false,
  grep: false,
  codesearch: false,
  code_search: false,
  filesearch: false,
  file_search: false,
  websearch: false,
  web_search: false,
  read: false,
  list: false,
  write: false,
  edit: false,
  patch: false,
  bash: false,
  todowrite: false,
  webfetch: false,
  skill: false,
  skills: false,
  run_ade_action: false,
  ade_run_ade_action: false,
  list_ade_actions: false,
  ade_list_ade_actions: false,
  spawn_agent: false,
  ade_spawn_agent: false,
};
const CHECKPOINT_DAG_MUTATION_TOOLS = new Set([
  "spawn_worker",
  "revise_plan",
  "mark_step_complete",
  "complete_mission",
]);
const RECOVERED_STATUS_PROBE_TOOLS = new Set([
  "read_mission_status",
  "read_mission_state",
  "list_tasks",
  "list_workers",
  "get_budget_status",
  "check_finalization_status",
]);
const RECOVERED_IDLE_WHILE_WORKERS_RUNNING_TOOLS = new Set([
  ...RECOVERED_STATUS_PROBE_TOOLS,
  "broadcast",
  "get_worker_output",
  "memory_search",
  "message_worker",
  "send_message",
  "update_mission_state",
]);
const RECOVERED_TOOL_RESULT_MAX_CHARS = 1400;
const RECOVERED_TOOL_RESULTS_MAX_CHARS = 5600;
const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "canceled"]);
const TERMINAL_PLANNING_TRACKER_STATUSES = new Set<OrchestratorStepStatus>([
  "succeeded",
  "failed",
  "blocked",
  "skipped",
  "superseded",
  "canceled",
]);

// ---------------------------------------------------------------------------
// Worker Identity Prompt Builder
// ---------------------------------------------------------------------------

export type WorkerIdentity = {
  name: string;
  role: string;
  provider: string;
  parentName: string;
  missionSummary: string;
  taskPrompt: string;
  isSubOrchestrator?: boolean;
  inheritedRules?: string;
};

export function buildWorkerIdentityPrompt(identity: WorkerIdentity): string {
  const capabilities = identity.isSubOrchestrator
    ? `- You are a ${identity.provider} agent with full coding capabilities
- You can read, write, and edit files
- You can run terminal commands
- You can search the codebase
- You can spawn your own workers using the same tools as your parent orchestrator`
    : `- You are a ${identity.provider} agent with full coding capabilities
- You can read, write, and edit files
- You can run terminal commands
- You can search the codebase`;

  return `You are a worker agent spawned by the ADE orchestrator.

## Your Identity
- Name: ${identity.name}
- Role: ${identity.role}
- Spawned by: ${identity.parentName}
- Mission: ${identity.missionSummary}

## Your Task
${identity.taskPrompt}

Think independently about how best to accomplish this. Make autonomous decisions about implementation approach. You own the outcome — don't wait for permission or guidance.

## What You Can Do
${capabilities}
- You have full authority to make implementation decisions. Act decisively — don't hesitate or ask for approval on implementation details.

## Communication
- Your orchestrator can send you messages during execution — read and follow them
- Complete the FULL scope of your task before finishing. Don't stop partway through.
- If you encounter problems, solve them yourself — only report truly blocking issues that require human input or architectural decisions.
- When you complete your task, provide a clear summary of what you did, what files changed, and any issues encountered.

## Reflection Logging
- If the \`reflection_add\` tool is available, log structured reflections during execution:
  - when blocked/frustrated
  - when you discover a reusable pattern
  - before reporting final completion
- Keep entries concrete and actionable (clear observation + recommendation + context).
- Use current run/step/attempt scope (caller-context fallback is supported).
${identity.inheritedRules ? `\n## Rules\n${identity.inheritedRules}` : ""}`;
}

function formatStreamError(error: unknown): string {
  if (typeof error === "string" && error.trim().length > 0) return error;
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error ?? "unknown error");
  }
}

function looksLikeProviderAuthOrAccessFailure(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized.length) return false;
  return (
    normalized.includes("does not have access to")
    || normalized.includes("please login again")
    || normalized.includes("please log in again")
    || normalized.includes("please sign in again")
    || normalized.includes("contact your administrator")
    || normalized.includes("oauth token has been revoked")
    || normalized.includes("obtain a new token")
    || normalized.includes("permission_error")
    || normalized.includes("loadapikeyerror")
    || normalized.includes("token revoked")
  );
}

function looksLikeProviderFailureReply(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized.length || normalized.length > 500) return false;
  if (looksLikeProviderAuthOrAccessFailure(message)) return true;
  return (
    normalized.includes("rate limit")
    || normalized.includes("try again later")
    || normalized.includes("temporarily unavailable")
    || normalized.includes("service unavailable")
    || normalized.includes("model is overloaded")
    || normalized.includes("quota exceeded")
    || normalized.includes("request failed with status code 429")
    || normalized.includes("request failed with status code 503")
    || normalized.includes("request failed with status code 500")
    || normalized.includes("request failed with status code 403")
    || normalized.includes("request failed with status code 401")
    || normalized.includes("unauthorized")
    || normalized.includes("forbidden")
    || normalized.includes("invalid api key")
    || normalized.includes("authentication failed")
    || normalized.includes("model not found")
    || normalized.includes("model is not supported")
    || normalized.includes("unsupported model")
    || normalized.includes("unknown model")
  );
}

function classifyCoordinatorRuntimeFailure(error: unknown): Omit<CoordinatorRuntimeFailure, "message" | "turnId"> {
  const message = formatStreamError(error).trim();
  const normalized = message.toLowerCase();

  if (looksLikeProviderAuthOrAccessFailure(message)) {
    return {
      category: "provider_unreachable",
      reasonCode: "coordinator_runtime_provider_auth_failed",
      interventionType: "provider_unreachable",
      retryable: true,
      recoveryOptions: ["retry", "switch_to_fallback_model", "cancel_run"],
      title: "Coordinator could not authenticate with the selected provider",
      body: `ADE paused the run because the selected provider rejected the coordinator credentials. Error: ${message || "No additional detail was provided."}`,
      requestedAction: "Reconnect or sign in to the selected provider again, then resume the run. If that still fails, switch the mission to a different model before retrying.",
    };
  }

  if (
    normalized.includes("model not found")
    || normalized.includes("model is not supported")
    || normalized.includes("unsupported model")
    || normalized.includes("unknown model")
  ) {
    return {
      category: "provider_unreachable",
      reasonCode: "coordinator_runtime_model_unavailable",
      interventionType: "provider_unreachable",
      retryable: true,
      recoveryOptions: ["retry", "switch_to_fallback_model", "cancel_run"],
      title: "Coordinator model is unavailable",
      body: `ADE paused the run because the selected coordinator model is unavailable in the active runtime. Error: ${message || "No additional detail was provided."}`,
      requestedAction: "Switch the coordinator to an available model, then resume the run. Retry the same model only after confirming the provider exposes it.",
    };
  }

  if (
    normalized.includes("requires approval")
    || normalized.includes("permission denied")
    || normalized.includes("policy block")
    || normalized.includes("not allowed")
    || normalized.includes("approval denied")
    || normalized.includes("eacces")
    || normalized.includes("eperm")
  ) {
    return {
      category: "permission_denied",
      reasonCode: "coordinator_runtime_permission_denied",
      interventionType: "policy_block",
      retryable: false,
      recoveryOptions: ["retry", "cancel_run"],
      title: "Coordinator was blocked by permissions",
      body: `ADE paused the run because the coordinator hit a permission or policy block. Error: ${message || "No additional detail was provided."}`,
      requestedAction: "Adjust the permission or tool policy, then resume the run to retry the same coordinator.",
    };
  }

  if (
    normalized.includes("rate limit")
    || normalized.includes("timed out")
    || normalized.includes("timeout")
    || normalized.includes("temporarily unavailable")
    || normalized.includes("connection refused")
    || normalized.includes("network")
    || normalized.includes("provider")
    || normalized.includes("api key")
    || normalized.includes("authentication")
    || normalized.includes("unauthorized")
  ) {
    return {
      category: "provider_unreachable",
      reasonCode: "coordinator_runtime_provider_unreachable",
      interventionType: "provider_unreachable",
      retryable: true,
      recoveryOptions: ["retry", "switch_to_fallback_model", "cancel_run"],
      title: "Coordinator lost contact with the selected provider",
      body: `ADE paused the run because the coordinator could not keep talking to the selected provider. Error: ${message || "No additional detail was provided."}`,
      requestedAction: "Check provider health, then resume the run to retry the same provider. If the provider remains unhealthy, switch the mission to a different model before retrying.",
    };
  }

  if (
    /\b(?:codex|claude) cli exited with code\b/i.test(message)
    || /\bexited with code\b/i.test(message)
    || normalized.includes("session ended unexpectedly")
    || normalized.includes("process exited")
  ) {
    return {
      category: "cli_runtime_failure",
      reasonCode: "coordinator_runtime_cli_exit",
      interventionType: "unrecoverable_error",
      retryable: false,
      recoveryOptions: ["retry", "cancel_run"],
      title: "Coordinator runtime exited unexpectedly",
      body: `ADE paused the run because the coordinator process exited during execution. Error: ${message || "No additional detail was provided."}`,
      requestedAction: "Inspect coordinator runtime health, then resume the run to retry the same provider and mission state.",
    };
  }

  return {
    category: "unknown",
    reasonCode: "coordinator_runtime_failed",
    interventionType: "unrecoverable_error",
    retryable: false,
    recoveryOptions: ["retry", "cancel_run"],
    title: "Coordinator stopped unexpectedly",
    body: `ADE paused the run because the coordinator stopped unexpectedly. Error: ${message || "No additional detail was provided."}`,
    requestedAction: "Inspect the coordinator failure, then resume the run if you want to retry from this state.",
  };
}

class CoordinatorFatalError extends Error {
  readonly nonRetryable = true;
  readonly runtimeFailure: CoordinatorRuntimeFailure | null;

  constructor(message: string, runtimeFailure?: CoordinatorRuntimeFailure | null) {
    super(message);
    this.runtimeFailure = runtimeFailure ?? null;
  }
}

// ---------------------------------------------------------------------------
// Coordinator Agent
// ---------------------------------------------------------------------------

export class CoordinatorAgent {
  private deps: CoordinatorAgentDeps;
  private eventQueue: QueuedEvent[] = [];
  private processing = false;
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private dead = false;
  private turnCount = 0;
  private tools: Record<string, CoordinatorExecutableTool>;
  private conversationHistory: ModelMessage[] = [];
  private systemPrompt: string;
  private compactionMonitor: CompactionMonitor | null = null;
  private compactionCount = 0;
  private lastEventTimestampMs: number | null = null;
  private activeAbortController: AbortController | null = null;
  private openCodeHandle: OpenCodeSessionHandle | null = null;
  private openCodeIdleTimer: ReturnType<typeof setTimeout> | null = null;
  private chatCoordinatorSessionId: string | null = null;
  private planningStartupState: PlanningStartupState = "inactive";
  private planningStartupRetryCount = 0;
  private phaseTransitionCorrectionCounts = new Map<string, number>();
  private plannerLaunchTrackerStepId: string | null = null;
  private pendingPlannerDelegationContract: DelegationContract | null = null;

  constructor(deps: CoordinatorAgentDeps) {
    this.deps = deps;
    this.tools = createCoordinatorToolSet({
      orchestratorService: deps.orchestratorService,
      runId: deps.runId,
      missionId: deps.missionId,
      logger: deps.logger,
      db: deps.db,
      projectRoot: deps.projectRoot,
      workspaceRoot: deps.workspaceRoot,
      missionService: deps.missionService,
      memoryService: deps.memoryService,
      projectId: deps.projectId,
      getMissionBudgetStatus: deps.getMissionBudgetStatus,
      onDagMutation: deps.onDagMutation,
      onRunFinalize: deps.onRunFinalize,
      onHardCapTriggered: deps.onHardCapTriggered,
      onBudgetWarning: deps.onBudgetWarning,
      sendWorkerMessageToSession: deps.sendWorkerMessageToSession,
      missionLaneId: deps.missionLaneId,
      provisionLane: deps.provisionLane,
    });
    this.wrapDagMutationToolsWithCheckpoint();
    this.systemPrompt = this.buildSystemPrompt();
    if (this.isPlanningFirstPhaseRun()) {
      this.pendingPlannerDelegationContract = createDelegationContract({
        contractId: randomUUID(),
        runId: deps.runId,
        workerIntent: "planner",
        mode: "exclusive",
        scope: createDelegationScope({
          kind: "phase",
          key: "phase:planning",
          label: "planning",
        }),
        phaseKey: "planning",
        status: "launching",
        launchState: "awaiting_context",
        launchPolicy: {
          maxLaunchAttempts: PLANNING_STARTUP_RETRY_LIMIT + 1,
        },
        failurePolicy: {
          retryLimit: PLANNING_STARTUP_RETRY_LIMIT,
          escalation: "intervention",
        },
      });
    }
    this.syncPlanningStartupStateFromContracts();
    this.ensurePlannerLaunchTrackerStep();

    // Initialize compaction monitor if enabled
    if (deps.enableCompaction) {
      const model = resolveModelDescriptor(deps.modelId);
      if (model) {
        this.compactionMonitor = createCompactionMonitor(
          model,
          COMPACTION_THRESHOLD_RATIO,
        );
      }
    }
  }

  // ─── Public API ──────────────────────────────────────────────────

  /**
   * Inject a runtime event into the coordinator. Events are batched
   * within BATCH_DELAY_MS and processed sequentially.
   */
  injectEvent(
    event: OrchestratorRuntimeEvent,
    formattedMessage?: string,
  ): void {
    if (this.dead) return;
    // Guard: skip event injection if the run is paused
    if (this.isRunPaused()) return;
    // While planning is blocked on a clarification, ignore runtime polling/noise
    // and wait for the user's answer to re-enter the coordinator loop.
    if (this.hasOpenPlanningClarification()) return;
    const receivedAt = Date.now();
    const message =
      formattedMessage ?? formatRuntimeEvent(event).summary;
    this.lastEventTimestampMs = receivedAt;
    this.eventQueue.push({ message, receivedAt });
    this.touchOpenCodeCoordinatorSession();
    this.scheduleBatch();
  }

  /**
   * Inject a raw text message (e.g. user steering, chat message).
   */
  injectMessage(message: string): void {
    if (this.dead) return;
    const receivedAt = Date.now();
    this.lastEventTimestampMs = receivedAt;
    this.eventQueue.push({ message, receivedAt });
    this.touchOpenCodeCoordinatorSession();
    this.scheduleBatch();
  }

  async replayRecoveredMissionControlText(
    assistantText: string,
    turnId: string,
  ): Promise<number> {
    if (this.dead) return 0;
    return await this.executeRecoveredCoordinatorToolCalls(assistantText, turnId);
  }

  /** Stop the coordinator. No further events will be processed. */
  shutdown(): void {
    this.dead = true;
    this.eventQueue = [];
    this.activeAbortController?.abort();
    this.activeAbortController = null;
    this.releaseOpenCodeCoordinatorSession("shutdown");
    this.releaseChatCoordinatorSession("shutdown");
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
  }

  private clearOpenCodeIdleTimer(): void {
    if (!this.openCodeIdleTimer) return;
    clearTimeout(this.openCodeIdleTimer);
    this.openCodeIdleTimer = null;
  }

  private releaseOpenCodeCoordinatorSession(
    reason: "handle_close" | "idle_ttl" | "ended_session" | "model_switch" | "paused_run" | "project_close" | "budget_eviction" | "pool_compaction" | "shutdown",
  ): void {
    this.clearOpenCodeIdleTimer();
    const handle = this.openCodeHandle;
    this.openCodeHandle = null;
    if (!handle) return;
    handle.setEvictionHandler(null);
    handle.setBusy(false);
    try {
      handle.close(reason);
    } catch {
      // ignore shutdown failures
    }
  }

  private touchOpenCodeCoordinatorSession(): void {
    if (!this.openCodeHandle) return;
    this.openCodeHandle.touch();
    this.clearOpenCodeIdleTimer();
    this.openCodeIdleTimer = setTimeout(() => {
      if (this.dead) return;
      if (!this.openCodeHandle) return;
      if (this.isRunPaused()) {
        this.releaseOpenCodeCoordinatorSession("paused_run");
        return;
      }
      if (this.activeAbortController || this.processing || this.eventQueue.length > 0) {
        this.touchOpenCodeCoordinatorSession();
        return;
      }
      this.releaseOpenCodeCoordinatorSession("idle_ttl");
    }, COORDINATOR_IDLE_SESSION_TTL_MS);
    if (this.openCodeIdleTimer.unref) this.openCodeIdleTimer.unref();
  }

  get isAlive(): boolean {
    return !this.dead;
  }

  get turns(): number {
    return this.turnCount;
  }

  get historyLength(): number {
    return this.conversationHistory.length;
  }

  // ─── Pause Guard ─────────────────────────────────────────────────

  /**
   * Check if the associated run is currently paused.
   * Uses a lightweight DB query to avoid loading the full run graph.
   */
  private isRunPaused(): boolean {
    try {
      const row = this.deps.db.get<{ status: string }>(
        `SELECT status FROM orchestrator_runs WHERE id = ? AND project_id = ?`,
        [this.deps.runId, this.deps.projectId],
      );
      return row?.status === "paused" || TERMINAL_RUN_STATUSES.has(String(row?.status ?? "").trim().toLowerCase());
    } catch {
      // If the run can't be queried, treat as not paused (let other guards handle it)
      return false;
    }
  }

  // ─── Batch Scheduling ────────────────────────────────────────────

  private scheduleBatch(): void {
    if (this.batchTimer) return; // already scheduled
    this.batchTimer = setTimeout(() => {
      this.batchTimer = null;
      void this.processBatch();
    }, BATCH_DELAY_MS);
  }

  private async processBatch(): Promise<void> {
    if (this.processing || this.dead || this.eventQueue.length === 0)
      return;
    // Guard: do not process batches while the run is paused
    if (this.isRunPaused()) return;
    this.refreshPlanningStartupState();
    this.processing = true;

    // Take a snapshot of events before removing from queue
    const events = this.eventQueue.splice(0);

    try {
      const combinedMessage = events
        .map((e) => e.message)
        .join("\n---\n");

      // Add to conversation history as a user message
      this.conversationHistory.push({
        role: "user",
        content: combinedMessage,
      });

      // Trim conversation history to prevent unbounded growth
      // (compaction is the proper solution, but this is a safety net)
      if (this.conversationHistory.length > MAX_CONVERSATION_HISTORY) {
        const trimCount =
          this.conversationHistory.length - MAX_CONVERSATION_HISTORY;
        this.conversationHistory.splice(0, trimCount);
      }

      // Call the AI with tools
      await this.runTurn();
      this.turnCount++;
      if (this.turnCount % CHECKPOINT_TURN_INTERVAL === 0) {
        this.saveCheckpoint("turn_interval");
      }

      // Check if compaction is needed
      if (this.compactionMonitor?.shouldCompact()) {
        await this.compactHistory();
      }
    } catch (err) {
      this.deps.logger.warn("coordinator_agent.batch_failed", {
        runId: this.deps.runId,
        error: err instanceof Error ? err.message : String(err),
      });

      // Re-enqueue events that failed processing (with retry limit)
      if (!(err instanceof CoordinatorFatalError)) {
        for (const event of events) {
          const retryCount = (event.retryCount ?? 0) + 1;
          if (retryCount <= MAX_EVENT_RETRY_COUNT) {
            this.eventQueue.push({ ...event, retryCount });
          }
          // Events exceeding MAX_EVENT_RETRY_COUNT are dropped to prevent infinite loops
        }
      }
    } finally {
      this.processing = false;
      // If more events arrived during processing, schedule another batch
      if (this.eventQueue.length > 0 && !this.dead) {
        this.scheduleBatch();
      }
    }
  }

  // ─── AI Turn Execution ───────────────────────────────────────────

  private wrapDagMutationToolsWithCheckpoint(): void {
    for (const toolName of CHECKPOINT_DAG_MUTATION_TOOLS) {
      const tool = this.tools[toolName] as any;
      if (!tool || typeof tool.execute !== "function") continue;
      const originalExecute = tool.execute.bind(tool);
      tool.execute = async (...args: any[]) => {
        this.saveCheckpoint(`before_tool:${toolName}`);
        return originalExecute(...args);
      };
    }
  }

  private usesOpenCodeCoordinatorRuntime(): boolean {
    const descriptor = resolveModelDescriptor(this.deps.modelId);
    return Boolean(descriptor && descriptor.family !== "cursor");
  }

  private async ensureOpenCodeCoordinatorSession(): Promise<OpenCodeSessionHandle> {
    if (this.openCodeHandle) return this.openCodeHandle;
    const descriptor = resolveModelDescriptor(this.deps.modelId);
    if (!descriptor) {
      throw new Error(`Coordinator model '${this.deps.modelId}' is not registered.`);
    }
    if (descriptor.family === "cursor") {
      throw new Error("Cursor models are not supported for coordinator execution. Choose Claude, Codex, or OpenCode.");
    }
    const projectConfig = this.deps.projectConfigService?.get().effective ?? { ai: {} };
    // Discover loaded local models so OpenCode knows about them.
    const discoveredLocalModels: DiscoveredLocalModelEntry[] = [];
    const aiConfig = projectConfig.ai as { localProviders?: Record<string, { enabled?: boolean; endpoint?: string }> } | undefined;
    const localProviders = aiConfig?.localProviders ?? {};
    for (const family of ["ollama", "lmstudio"] as const) {
      if ((localProviders as Record<string, { enabled?: boolean }>)[family]?.enabled === false) continue;
      const endpoint = (localProviders as Record<string, { endpoint?: string }>)[family]?.endpoint
        ?? getLocalProviderDefaultEndpoint(family);
      try {
        const inspection = await inspectLocalProvider(family, endpoint);
        for (const m of inspection.loadedModels) {
          discoveredLocalModels.push({ provider: m.provider, modelId: m.modelId });
        }
      } catch { /* offline — non-fatal */ }
    }
    this.openCodeHandle = await startOpenCodeSession({
      directory: this.deps.workspaceRoot,
      title: `ADE coordinator: ${this.deps.missionGoal}`,
      projectConfig,
      discoveredLocalModels,
      ownerKind: "coordinator",
      ownerId: this.deps.runId,
      ownerKey: `coordinator:${this.deps.runId}`,
      leaseKind: "shared",
      logger: this.deps.logger,
    });
    const registeredHandle = this.openCodeHandle;
    registeredHandle.setEvictionHandler((reason) => {
      if (this.openCodeHandle !== registeredHandle) {
        return;
      }
      if (this.openCodeHandle) {
        this.releaseOpenCodeCoordinatorSession(
          reason === "error" || reason === "config_changed" || reason === "attach_failed"
            ? "handle_close"
            : reason,
        );
      }
    });
    registeredHandle.setBusy(false);
    this.touchOpenCodeCoordinatorSession();
    return this.openCodeHandle;
  }

  private async runOpenCodeTurn(
    turnId: string,
    abortController: AbortController,
  ): Promise<{
    assistantText: string;
    sawStreamPart: boolean;
    streamedStepCount: number;
    executedToolCount: number;
    awaitingBlockingUserInput: boolean;
    planningStartupAbortMode: "none" | "planner_started" | "retry" | "failed";
    planningStartupFailure: CoordinatorPlanningStartupFailure | null;
    phaseTransitionRequired: PhaseTransitionRequiredSignal | null;
  }> {
    const descriptor = resolveModelDescriptor(this.deps.modelId);
    if (!descriptor) {
      throw new Error(`Coordinator model '${this.deps.modelId}' is not registered.`);
    }
    const handle = await this.ensureOpenCodeCoordinatorSession();
    handle.setBusy(true);
    this.touchOpenCodeCoordinatorSession();
    const eventStream = await openCodeEventStream({
      client: handle.client,
      directory: handle.directory,
      signal: abortController.signal,
    });

    const latestUserMessage = [...this.conversationHistory]
      .reverse()
      .find((entry) => entry.role === "user");
    const basePromptText = typeof latestUserMessage?.content === "string"
      ? latestUserMessage.content
      : "Continue coordinating the mission.";
    const promptText = this.buildPromptForTurn(basePromptText);
    const toolSelection = await refreshOpenCodeSessionToolSelection(handle);
    const coordinatorToolSelection = {
      ...(toolSelection ?? {}),
      ...COORDINATOR_PLAN_TOOL_SELECTION,
    };

    await handle.client.session.promptAsync({
      path: { id: handle.sessionId },
      query: { directory: handle.directory },
      body: {
        agent: mapPermissionModeToOpenCodeAgent("plan"),
        model: resolveOpenCodeModelSelection(descriptor),
        tools: coordinatorToolSelection,
        parts: buildOpenCodePromptParts({
          prompt: promptText,
          system: this.systemPrompt,
        }),
      },
    });

    let assistantText = "";
    let sawStreamPart = false;
    let streamedStepCount = 0;
    let executedToolCount = 0;
    let awaitingBlockingUserInput = false;
    let planningStartupAbortMode: "none" | "planner_started" | "retry" | "failed" = "none";
    let planningStartupFailure: CoordinatorPlanningStartupFailure | null = null;
    let phaseTransitionRequired: PhaseTransitionRequiredSignal | null = null;

    for await (const event of eventStream) {
      const sessionId = (() => {
        switch (event.type) {
          case "message.updated":
          case "session.created":
          case "session.updated":
          case "session.deleted":
            return event.properties.info.id;
          case "message.part.updated":
            return event.properties.part.sessionID;
          case "message.part.removed":
          case "permission.updated":
          case "permission.replied":
          case "session.status":
          case "session.idle":
          case "todo.updated":
          case "session.diff":
          case "command.executed":
            return event.properties.sessionID;
          case "session.error":
            return event.properties.sessionID ?? null;
          default:
            return null;
        }
      })();
      if (sessionId !== handle.sessionId) continue;

      if (event.type === "message.part.updated") {
        sawStreamPart = true;
        const { part, delta } = event.properties;
        if (part.type === "step-start") {
          streamedStepCount += 1;
          this.deps.onCoordinatorEvent?.({ type: "step_boundary", stepNumber: streamedStepCount, turnId });
          continue;
        }
        if (part.type === "text") {
          if ((part as { synthetic?: boolean }).synthetic || (part as { ignored?: boolean }).ignored) {
            continue;
          }
          const nextDelta = typeof delta === "string" ? delta : part.text;
          if (nextDelta.length > 0) {
            assistantText += nextDelta;
            this.deps.onCoordinatorEvent?.({ type: "text", text: nextDelta, turnId, itemId: part.id });
          }
          continue;
        }
        if (part.type === "reasoning") {
          if ((part as { synthetic?: boolean }).synthetic || (part as { ignored?: boolean }).ignored) {
            continue;
          }
          const nextDelta = typeof delta === "string" ? delta : part.text;
          if (nextDelta.length > 0) {
            this.deps.onCoordinatorEvent?.({
              type: "activity",
              activity: "thinking",
              detail: "Thinking through the next move",
              turnId,
            });
            this.deps.onCoordinatorEvent?.({ type: "reasoning", text: nextDelta, turnId, itemId: part.id });
          }
          continue;
        }
        if (part.type === "tool") {
          executedToolCount += 1;
          const itemId = part.callID || part.id;
          const normalizedToolName = normalizeCoordinatorToolName(part.tool);
          const isCompletedStartupPlannerSpawn =
            normalizedToolName === "spawn_worker"
            && this.planningStartupState !== "inactive"
            && part.state.status === "completed";
          if (!isCompletedStartupPlannerSpawn) {
            this.handlePlanningStartupToolCall(part.tool);
          }
          this.deps.onCoordinatorEvent?.({
            type: "tool_call",
            tool: part.tool,
            args: part.state.input,
            itemId,
            turnId,
          });
          if (part.state.status === "completed") {
            const toolOutput = coerceToolOutputRecord(part.state.output);
            const transitionSignal = extractPhaseTransitionRequiredSignal(toolOutput);
            if (transitionSignal) {
              phaseTransitionRequired = transitionSignal;
            }
            if (
              normalizedToolName === "set_current_phase"
              && toolOutput?.ok === true
            ) {
              this.phaseTransitionCorrectionCounts.clear();
            }
            this.deps.onCoordinatorEvent?.({
              type: "tool_result",
              tool: part.tool,
              result: part.state.output,
              itemId,
              turnId,
              status: "completed",
            });
            if (toolOutput?.awaitingUserResponse === true && toolOutput?.blocking !== false) {
              awaitingBlockingUserInput = true;
              abortController.abort();
            }
            if (normalizedToolName === "spawn_worker" && this.planningStartupState !== "inactive") {
              if (toolOutput?.ok === true) {
                const delegatedContract = extractDelegationContract(toolOutput?.delegationContract ?? null);
                if (delegatedContract && delegatedContract.workerIntent === "planner") {
                  this.pendingPlannerDelegationContract = delegatedContract;
                } else if (this.pendingPlannerDelegationContract) {
                  this.pendingPlannerDelegationContract = updateDelegationContract(this.pendingPlannerDelegationContract, {
                    status: "active",
                    launchState: "waiting_on_worker",
                    activeWorkerIds:
                      typeof toolOutput?.workerId === "string" && toolOutput.workerId.trim().length > 0
                        ? [toolOutput.workerId.trim()]
                        : this.pendingPlannerDelegationContract.activeWorkerIds,
                  });
                }
                this.planningStartupState = "waiting_on_planner";
                if (this.pendingPlannerDelegationContract) {
                  this.emitDelegationState(
                    this.pendingPlannerDelegationContract,
                    toolOutput?.launched === false
                      ? "The planning agent is queued. I’m waiting for it to start."
                      : "The planning agent is running. I’m waiting for its result.",
                  );
                }
                this.updatePlannerLaunchTrackerStep({
                  status: "running",
                  reason: toolOutput?.launched === false ? "planner_queued" : "planner_launched",
                  detail: {
                    launched: toolOutput?.launched ?? null,
                    launchNote: typeof toolOutput?.launchNote === "string" ? toolOutput.launchNote : null,
                    stepId: typeof toolOutput?.stepId === "string" ? toolOutput.stepId : null,
                  },
                });
                this.deps.onCoordinatorEvent?.({
                  type: "status",
                  turnStatus: "started",
                  turnId,
                  message: toolOutput?.launched === false
                    ? "The planning agent is queued. I’m waiting for it to start."
                    : "The planning agent is running. I’m waiting for its result.",
                });
                planningStartupAbortMode = "planner_started";
                abortController.abort();
              } else {
                const failure = this.buildPlannerLaunchFailure(
                  typeof toolOutput?.error === "string" ? toolOutput.error : `Tool '${part.tool}' failed to launch the planner.`,
                  part.tool,
                );
                planningStartupFailure = failure;
                if (failure.retryable && this.planningStartupRetryCount < PLANNING_STARTUP_RETRY_LIMIT) {
                  this.schedulePlanningStartupRetry(failure);
                  planningStartupAbortMode = "retry";
                } else {
                  this.handlePlanningStartupFailure(failure);
                  planningStartupAbortMode = "failed";
                }
                abortController.abort();
              }
            }
          } else if (part.state.status === "error") {
            if (normalizedToolName === "spawn_worker" && this.planningStartupState !== "inactive") {
              const failure = this.buildPlannerLaunchFailure(String(part.state.error ?? "tool failed"), part.tool);
              planningStartupFailure = failure;
              if (failure.retryable && this.planningStartupRetryCount < PLANNING_STARTUP_RETRY_LIMIT) {
                this.schedulePlanningStartupRetry(failure);
                planningStartupAbortMode = "retry";
              } else {
                this.handlePlanningStartupFailure(failure);
                planningStartupAbortMode = "failed";
              }
              abortController.abort();
            }
            this.deps.onCoordinatorEvent?.({
              type: "tool_result",
              tool: part.tool,
              result: { error: part.state.error },
              itemId,
              turnId,
              status: "failed",
            });
            this.deps.onCoordinatorEvent?.({
              type: "error",
              message: `Tool '${part.tool}' failed: ${part.state.error}`,
              itemId,
              turnId,
            });
          }
          continue;
        }
      }

      if (event.type === "todo.updated") {
        this.deps.onCoordinatorEvent?.({
          type: "todo_update",
          items: event.properties.todos.map((todo: { id: string; content: string; status: string }) => ({
            id: todo.id,
            description: todo.content,
            status: todo.status === "completed"
              ? "completed"
              : todo.status === "in_progress"
                ? "in_progress"
                : "pending",
          })),
          turnId,
        });
        continue;
      }

      if (event.type === "permission.updated") {
        throw new Error(`Coordinator OpenCode session requested permission '${event.properties.type}'.`);
      }

      if (event.type === "session.error") {
        throw new Error(String(event.properties.error?.data?.message ?? "OpenCode coordinator turn failed."));
      }

      if (event.type === "session.idle") {
        break;
      }
    }

    return {
      assistantText: assistantText.trim(),
      sawStreamPart,
      streamedStepCount,
      executedToolCount,
      awaitingBlockingUserInput,
      planningStartupAbortMode,
      planningStartupFailure,
      phaseTransitionRequired,
    };
  }

  private releaseChatCoordinatorSession(reason: "shutdown" | "ended_session" | "model_switch" | "project_close" | "budget_eviction"): void {
    const sessionId = this.chatCoordinatorSessionId;
    this.chatCoordinatorSessionId = null;
    if (!sessionId || !this.deps.agentChatService) return;
    void this.deps.agentChatService.dispose({ sessionId }).catch((error) => {
      this.deps.logger.debug("coordinator_agent.chat_session_dispose_failed", {
        runId: this.deps.runId,
        sessionId,
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private async ensureChatCoordinatorSession(): Promise<string> {
    if (this.chatCoordinatorSessionId) return this.chatCoordinatorSessionId;
    const agentChatService = this.deps.agentChatService;
    if (!agentChatService) {
      throw new Error("Agent chat service is not available for mission coordinator runtime.");
    }
    const descriptor = resolveModelDescriptor(this.deps.modelId);
    if (!descriptor) {
      throw new Error(`Coordinator model '${this.deps.modelId}' is not registered.`);
    }
    const laneId = this.deps.missionLaneId?.trim();
    if (!laneId) {
      throw new Error("Mission coordinator chat runtime requires a mission lane before startup.");
    }
    const provider = resolveProviderGroupForModel(descriptor);
    const session = await agentChatService.createSession({
      laneId,
      provider,
      model: descriptor.isCliWrapped ? descriptor.providerModelId : descriptor.id,
      modelId: descriptor.id as any,
      title: "Mission coordinator",
      sessionProfile: "workflow",
      surface: "mission",
      reasoningEffort: this.deps.coordinatorReasoningEffort ?? null,
      permissionMode: "plan",
      ...(provider === "claude" ? { interactionMode: "plan" as const } : {}),
    });
    this.chatCoordinatorSessionId = session.id;
    this.deps.onCoordinatorChatSessionStarted?.({
      sessionId: session.id,
      missionId: this.deps.missionId,
      runId: this.deps.runId,
      laneId,
    });
    this.deps.logger.info("coordinator_agent.chat_session_started", {
      runId: this.deps.runId,
      sessionId: session.id,
      modelId: descriptor.id,
      provider,
      laneId,
    });
    return session.id;
  }

  private buildChatRuntimePrompt(promptText: string): string {
    return [
      this.turnCount === 0 ? this.systemPrompt : null,
      CHAT_RUNTIME_TOOL_TRANSPORT,
      "## Current Coordinator Input",
      promptText,
    ].filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).join("\n\n");
  }

  private async runChatRuntimeTurn(
    _turnId: string,
    abortController: AbortController,
  ): Promise<{
    assistantText: string;
    sawStreamPart: boolean;
    streamedStepCount: number;
    executedToolCount: number;
    awaitingBlockingUserInput: boolean;
    planningStartupAbortMode: "none" | "planner_started" | "retry" | "failed";
    planningStartupFailure: CoordinatorPlanningStartupFailure | null;
    phaseTransitionRequired: PhaseTransitionRequiredSignal | null;
  }> {
    const agentChatService = this.deps.agentChatService;
    if (!agentChatService) {
      throw new Error("Agent chat service is not available for mission coordinator runtime.");
    }
    const sessionId = await this.ensureChatCoordinatorSession();
    const latestUserMessage = [...this.conversationHistory]
      .reverse()
      .find((entry) => entry.role === "user");
    const basePromptText = typeof latestUserMessage?.content === "string"
      ? latestUserMessage.content
      : "Continue coordinating the mission.";
    const promptText = this.buildChatRuntimePrompt(this.buildPromptForTurn(basePromptText));
    const abortListener = () => {
      void agentChatService.interrupt({ sessionId }).catch(() => undefined);
    };
    abortController.signal.addEventListener("abort", abortListener, { once: true });
    const laneId = this.deps.missionLaneId?.trim() || null;
    this.deps.onCoordinatorChatRuntimeTurnStarted?.({
      sessionId,
      missionId: this.deps.missionId,
      runId: this.deps.runId,
      laneId,
    });
    try {
      const result = await agentChatService.runSessionTurn({
        sessionId,
        text: promptText,
        displayText: this.turnCount === 0
          ? "ADE coordinator start: initialize the mission."
          : "ADE coordinator tick: review mission state and route the next action.",
        timeoutMs: COORDINATOR_TURN_TIMEOUT_MS,
        ...(this.deps.coordinatorReasoningEffort ? { reasoningEffort: this.deps.coordinatorReasoningEffort } : {}),
      });
      const assistantText = result.outputText.trim();
      return {
        assistantText,
        sawStreamPart: assistantText.length > 0,
        streamedStepCount: assistantText.length > 0 ? 1 : 0,
        executedToolCount: 0,
        awaitingBlockingUserInput: false,
        planningStartupAbortMode: "none",
        planningStartupFailure: null,
        phaseTransitionRequired: null,
      };
    } finally {
      abortController.signal.removeEventListener("abort", abortListener);
      this.deps.onCoordinatorChatRuntimeTurnFinished?.({
        sessionId,
        missionId: this.deps.missionId,
        runId: this.deps.runId,
        laneId,
      });
    }
  }

  private buildPromptForTurn(basePromptText: string): string {
    if (
      this.turnCount !== 0 ||
      !this.isPlanningFirstPhaseRun() ||
      this.hasPlanningExecutionRecord() ||
      this.hasOpenPlanningClarification()
    ) {
      return basePromptText;
    }

    const planningPhase = [...(this.deps.phases ?? [])]
      .sort((a, b) => a.position - b.position)
      .find((phase) => phase.phaseKey.trim().toLowerCase() === "planning") ?? null;
    const modelId = planningPhase?.model?.modelId?.trim();
    const modelInstruction = modelId
      ? `Use modelId "${modelId}" for that planning worker.`
      : "Use the configured planning phase model for that planning worker.";
    return [
      "PLANNING STARTUP REQUIRED:",
      "Your next response must use ADE mission-control tools. Do not answer with text only.",
      "Call get_project_context first, then call spawn_worker exactly once to launch a read-only planning worker.",
      "Use the mission-control tool names directly or with an ade_ prefix, such as get_project_context and spawn_worker.",
      `${modelInstruction} The worker prompt must include the full mission goal, the planning phase instructions, and clear instructions to discover the plan, avoid file edits, and return the plan through report_result.`,
      "Do not call native OpenCode repo/search/shell/web/planner tools before the planner is spawned.",
      "",
      "Mission message:",
      basePromptText,
    ].join("\n");
  }

  private summarizeForCheckpoint(): string {
    const recentHistory = this.conversationHistory.slice(-10);
    const lines: string[] = [];
    for (const message of recentHistory) {
      const role = String(message.role ?? "unknown").trim() || "unknown";
      const rawContent =
        typeof message.content === "string" ? message.content : JSON.stringify(message.content);
      const normalized = rawContent.replace(/\s+/g, " ").trim();
      if (!normalized.length) continue;
      lines.push(`${role}: ${normalized.slice(0, 500)}`);
    }
    if (this.eventQueue.length > 0) {
      lines.push(`pending_events: ${this.eventQueue.length}`);
    }
    const summary = lines.join("\n").trim();
    if (!summary.length) {
      return "No conversation history yet.";
    }
    return summary.length > CHECKPOINT_SUMMARY_MAX_CHARS
      ? `${summary.slice(0, CHECKPOINT_SUMMARY_MAX_CHARS)}\n[checkpoint summary truncated]`
      : summary;
  }

  private saveCheckpoint(trigger: string): void {
    const lastEventTimestamp =
      Number.isFinite(this.lastEventTimestampMs) && this.lastEventTimestampMs != null
        ? new Date(this.lastEventTimestampMs).toISOString()
        : null;
    const checkpoint = {
      version: 1,
      runId: this.deps.runId,
      missionId: this.deps.missionId,
      conversationSummary: this.summarizeForCheckpoint(),
      lastEventTimestamp,
      turnCount: this.turnCount,
      compactionCount: this.compactionCount,
      savedAt: new Date().toISOString(),
    };
    void writeCoordinatorCheckpoint(this.deps.projectRoot, this.deps.runId, checkpoint).catch((error) => {
      this.deps.logger.debug("coordinator_agent.checkpoint_write_failed", {
        runId: this.deps.runId,
        trigger,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private isPlanningExecutionStep(step: OrchestratorStep | null | undefined): boolean {
    if (!step) return false;
    const metadata = asRecord(step.metadata);
    if (metadata?.isTask === true || metadata?.displayOnlyTask === true || metadata?.plannerLaunchTracker === true) {
      return false;
    }
    const phaseKey = typeof metadata?.phaseKey === "string" ? metadata.phaseKey.trim().toLowerCase() : "";
    const phaseName = typeof metadata?.phaseName === "string" ? metadata.phaseName.trim().toLowerCase() : "";
    const stepType = typeof metadata?.stepType === "string" ? metadata.stepType.trim().toLowerCase() : "";
    return phaseKey === "planning" || phaseName === "planning" || stepType === "planning";
  }

  private resolvePlannerLaunchTrackerStep(): OrchestratorStep | null {
    if (!this.isPlanningFirstPhaseRun()) return null;
    try {
      const graph = this.deps.orchestratorService.getRunGraph({
        runId: this.deps.runId,
        timelineLimit: 0,
      });
      const step = graph.steps.find((candidate) => {
        if (this.plannerLaunchTrackerStepId && candidate.id === this.plannerLaunchTrackerStepId) return true;
        const metadata = asRecord(candidate.metadata);
        return metadata?.plannerLaunchTracker === true || candidate.stepKey === PLANNER_LAUNCH_TRACKER_STEP_KEY;
      }) ?? null;
      if (step?.id) this.plannerLaunchTrackerStepId = step.id;
      return step;
    } catch {
      return null;
    }
  }

  private ensurePlannerLaunchTrackerStep(): void {
    if (!this.isPlanningFirstPhaseRun()) return;
    const existing = this.resolvePlannerLaunchTrackerStep();
    if (existing) return;
    try {
      const created = this.deps.orchestratorService.addSteps({
        runId: this.deps.runId,
        steps: [
          {
            stepKey: PLANNER_LAUNCH_TRACKER_STEP_KEY,
            title: "Launch planning worker",
            stepIndex: -1_000,
            dependencyStepKeys: [],
            joinPolicy: "all_success",
            laneId: this.deps.missionLaneId ?? null,
            executorKind: "manual",
            metadata: {
              isTask: true,
              displayOnlyTask: true,
              plannerLaunchTracker: true,
              systemManaged: true,
              phaseKey: "planning",
              phaseName: "Planning",
              stepType: "planner_launch",
              plannerLaunchState: "pending",
            },
          },
        ],
      });
      this.plannerLaunchTrackerStepId = created[0]?.id ?? null;
    } catch (error) {
      this.deps.logger.debug("coordinator_agent.planner_launch_tracker_create_failed", {
        runId: this.deps.runId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private updatePlannerLaunchTrackerStep(args: {
    status: OrchestratorStepStatus;
    reason: string;
    detail?: Record<string, unknown> | null;
  }): void {
    const step = this.resolvePlannerLaunchTrackerStep();
    if (!step) return;
    const existingMetadata = asRecord(step.metadata) ?? {};
    const existingState = typeof existingMetadata.plannerLaunchState === "string" ? existingMetadata.plannerLaunchState.trim() : "";
    const existingReason = typeof existingMetadata.plannerLaunchReason === "string" ? existingMetadata.plannerLaunchReason.trim() : "";
    if (step.status === args.status && existingState === args.status && existingReason === args.reason && !args.detail) {
      return;
    }
    const now = new Date().toISOString();
    const metadata = {
      ...existingMetadata,
      plannerLaunchTracker: true,
      plannerLaunchState: args.status,
      plannerLaunchReason: args.reason,
      plannerLaunchUpdatedAt: now,
      ...(args.detail ? { plannerLaunchDetail: args.detail } : {}),
    };
    const startedAt = args.status === "pending" ? step.startedAt ?? null : (step.startedAt ?? now);
    const completedAt = TERMINAL_PLANNING_TRACKER_STATUSES.has(args.status) ? now : null;
    try {
      this.deps.db.run(
        `
          update orchestrator_steps
          set status = ?,
              metadata_json = ?,
              updated_at = ?,
              started_at = ?,
              completed_at = ?
          where id = ?
            and run_id = ?
            and project_id = ?
        `,
        [
          args.status,
          JSON.stringify(metadata),
          now,
          startedAt,
          completedAt,
          step.id,
          this.deps.runId,
          this.deps.projectId,
        ],
      );
      this.deps.orchestratorService.appendTimelineEvent({
        runId: this.deps.runId,
        stepId: step.id,
        eventType: "planner_launch_status",
        reason: args.reason,
        detail: {
          plannerLaunchState: args.status,
          ...(args.detail ?? {}),
        },
      });
      this.deps.orchestratorService.emitRuntimeUpdate({
        runId: this.deps.runId,
        stepId: step.id,
        reason: `planner_launch_${args.status}`,
      });
    } catch (error) {
      this.deps.logger.debug("coordinator_agent.planner_launch_tracker_update_failed", {
        runId: this.deps.runId,
        stepId: step.id,
        status: args.status,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private refreshPlanningStartupState(): void {
    this.syncPlanningStartupStateFromContracts();
  }

  private isPlanningStartupGuardActive(): boolean {
    this.syncPlanningStartupStateFromContracts();
    return this.planningStartupState !== "inactive" && this.planningStartupState !== "failed";
  }

  private listActiveDelegationContracts(): DelegationContract[] {
    let graphContracts: DelegationContract[] = [];
    try {
      const graph = this.deps.orchestratorService.getRunGraph({
        runId: this.deps.runId,
        timelineLimit: 0,
      });
      graphContracts = extractActiveDelegationContracts(graph);
      const planningSteps = filterExecutionSteps(graph.steps).filter((step) => this.isPlanningExecutionStep(step));
      if (planningSteps.some((step) => step.status === "succeeded")) {
        this.pendingPlannerDelegationContract = null;
      } else if (planningSteps.some((step) => step.status === "failed" || step.status === "blocked" || step.status === "canceled")) {
        const pendingContract = this.pendingPlannerDelegationContract;
        if (pendingContract) {
          this.pendingPlannerDelegationContract = updateDelegationContract(pendingContract, {
            status: "blocked",
            launchState: "blocked",
            completedAt: new Date().toISOString(),
          });
        }
      }
    } catch {
      // Best-effort graph inspection only.
    }
    const allContracts = [...graphContracts];
    if (this.pendingPlannerDelegationContract) {
      const hasMatchingPlannerContract = graphContracts.some((contract) =>
        contract.workerIntent === "planner" && contract.scope.key === this.pendingPlannerDelegationContract?.scope.key,
      );
      if (!hasMatchingPlannerContract) {
        allContracts.push(this.pendingPlannerDelegationContract);
      }
    }
    return allContracts;
  }

  private emitDelegationState(contract: DelegationContract, message?: string): void {
    this.deps.onCoordinatorEvent?.({
      type: "delegation_state",
      contract,
      message,
    });
  }

  private syncPlanningStartupStateFromContracts(): void {
    if (!this.isPlanningFirstPhaseRun()) {
      this.planningStartupState = "inactive";
      this.pendingPlannerDelegationContract = null;
      return;
    }
    const plannerContract =
      this.listActiveDelegationContracts().find((contract) => contract.workerIntent === "planner" && contract.mode === "exclusive")
      ?? this.pendingPlannerDelegationContract;
    const derived = derivePlanningStartupStateFromContract(plannerContract ?? null);
    this.planningStartupState = derived.state;
    this.pendingPlannerDelegationContract = derived.contract;
    if (derived.state === "inactive") {
      this.updatePlannerLaunchTrackerStep({
        status: "succeeded",
        reason: "planner_ready",
      });
    }
  }

  private queueInternalMessage(message: string): void {
    if (this.dead) return;
    const receivedAt = Date.now();
    this.lastEventTimestampMs = receivedAt;
    this.eventQueue.push({ message, receivedAt });
  }

  private queuePhaseTransitionCorrection(signal: PhaseTransitionRequiredSignal, turnId: string): void {
    const phaseKey = signal.phaseKey.trim();
    if (!phaseKey.length) return;
    const nextCount = (this.phaseTransitionCorrectionCounts.get(phaseKey) ?? 0) + 1;
    this.phaseTransitionCorrectionCounts.set(phaseKey, nextCount);

    if (nextCount > PHASE_TRANSITION_CORRECTION_LIMIT) {
      throw new CoordinatorFatalError(
        `Coordinator repeatedly attempted work before entering phase '${phaseKey}'.`,
        {
          category: "unknown",
          reasonCode: "phase_transition_required_not_followed",
          interventionType: "policy_block",
          retryable: true,
          recoveryOptions: ["retry", "cancel_run"],
          message: `The coordinator was told ${PHASE_TRANSITION_CORRECTION_LIMIT} times to call set_current_phase for '${phaseKey}' before spawning more workers, but did not complete the transition.`,
          title: "Coordinator did not enter the required phase",
          body:
            `ADE blocked work because the coordinator repeatedly tried to continue before entering the required '${phaseKey}' phase. ` +
            "The run was paused instead of letting phase ordering drift.",
          requestedAction: "Retry the coordinator turn after inspecting phase configuration, or cancel the run.",
          turnId,
        },
      );
    }

    this.deps.logger.info("coordinator_agent.phase_transition_correction_queued", {
      runId: this.deps.runId,
      phaseKey,
      reason: signal.reason,
      attempt: nextCount,
    });
    this.queueInternalMessage([
      "RUNTIME CORRECTION:",
      `The run must enter phase "${phaseKey}" before more work can be created or spawned.`,
      `Your next action must be to call set_current_phase with phaseKey "${phaseKey}" and reason "${signal.reason}".`,
      "After that tool succeeds, continue with the implementation DAG/workers. Do not retry spawn_worker or create_task before the phase transition succeeds.",
    ].join("\n"));
  }

  private buildNativeToolPlanningFailure(toolName: string): CoordinatorPlanningStartupFailure {
    return {
      category: "native_tool_violation",
      reasonCode: "planning_startup_native_tool_violation",
      interventionType: "policy_block",
      retryable: false,
      recoveryOptions: ["cancel_run"],
      message: `Coordinator tried to use '${toolName}' during planning startup.`,
      title: "Planning startup left the safe tool lane",
      body:
        `During the planning startup phase, the coordinator attempted to call '${toolName}' instead of staying inside ADE's planning tools. ` +
        "ADE stopped the turn and opened an explicit recovery path instead of allowing unbounded repo exploration.",
      requestedAction: "Retry planning or cancel the run.",
      toolName,
      retryCount: this.planningStartupRetryCount,
    };
  }

  private buildPlannerLaunchFailure(message: string, toolName?: string | null): CoordinatorPlanningStartupFailure {
    const classification = classifyPlannerLaunchFailure(message);
    const requestedAction = classification.category === "provider_unreachable"
      ? "Retry the planner, switch to a fallback model if one is available, or cancel the run."
      : classification.category === "permission_denied"
        ? "Adjust the permission or tool policy, then retry the planner."
        : classification.category === "run_context_bug"
          ? "Cancel the run and fix the run-context wiring before retrying."
          : "Retry the planner or cancel the run.";
    const title = classification.category === "provider_unreachable"
      ? "Planner launch is blocked by the model provider"
      : classification.category === "permission_denied"
        ? "Planner launch is blocked by tool permissions"
        : classification.category === "run_context_bug"
          ? "Planner launch lost its run context"
          : classification.category === "tool_schema_error"
            ? "Planner launch failed validation"
            : "Planner launch failed";
    return {
      ...classification,
      message,
      title,
      body:
        `ADE could not launch the planning worker during planning startup. ${message.trim() || "No additional error detail was provided."} ` +
        "The coordinator did not fall back into planner-style repo exploration.",
      requestedAction,
      toolName: toolName ?? null,
      retryCount: this.planningStartupRetryCount,
    };
  }

  private buildCoordinatorRuntimeFailure(error: unknown, turnId: string): CoordinatorRuntimeFailure {
    const message = formatStreamError(error).trim();
    const classification = classifyCoordinatorRuntimeFailure(message);
    return {
      ...classification,
      message,
      turnId,
      body: `${classification.body} ADE did not auto-fail over to another provider or silently retry the same failed turn.`,
    };
  }

  private buildAssistantReplyRuntimeFailure(
    assistantText: string,
    turnId: string,
    streamedStepCount: number,
  ): CoordinatorRuntimeFailure | null {
    const message = assistantText.trim();
    if (!message.length) return null;
    if (streamedStepCount > 0) return null;
    if (!looksLikeProviderFailureReply(message)) return null;
    return this.buildCoordinatorRuntimeFailure(message, turnId);
  }

  private schedulePlanningStartupRetry(failure: CoordinatorPlanningStartupFailure): void {
    this.planningStartupRetryCount += 1;
    if (this.pendingPlannerDelegationContract) {
      this.pendingPlannerDelegationContract = updateDelegationContract(this.pendingPlannerDelegationContract, {
        status: "launching",
        launchState: "awaiting_worker_launch",
        failure: {
          category: failure.category,
          reasonCode: failure.reasonCode,
          retryable: failure.retryable,
          recoveryOptions: failure.recoveryOptions,
          message: failure.message,
          toolName: failure.toolName ?? null,
          retryCount: this.planningStartupRetryCount,
          occurredAt: new Date().toISOString(),
        },
      });
      this.emitDelegationState(
        this.pendingPlannerDelegationContract,
        "The planner hit a launch issue, so I’m retrying once.",
      );
    }
    this.planningStartupState = "awaiting_planner_launch";
    this.updatePlannerLaunchTrackerStep({
      status: "pending",
      reason: "planner_launch_retry_scheduled",
      detail: {
        category: failure.category,
        message: failure.message,
        retryCount: this.planningStartupRetryCount,
      },
    });
    this.deps.onCoordinatorEvent?.({
      type: "status",
      turnStatus: "interrupted",
      message: "The planner hit a launch issue, so I’m retrying once.",
    });
    this.queueInternalMessage(
      "Planner launch hit a transient provider issue. Retry spawning exactly one planning worker now. " +
      "Do not inspect files, call native tools, or continue planning work yourself while retrying.",
    );
  }

  private handlePlanningStartupFailure(failure: CoordinatorPlanningStartupFailure): void {
    if (this.pendingPlannerDelegationContract) {
      this.pendingPlannerDelegationContract = updateDelegationContract(this.pendingPlannerDelegationContract, {
        status: failure.category === "permission_denied" || failure.category === "native_tool_violation" ? "blocked" : "launch_failed",
        launchState: "blocked",
        failure: {
          category: failure.category,
          reasonCode: failure.reasonCode,
          retryable: failure.retryable,
          recoveryOptions: failure.recoveryOptions,
          message: failure.message,
          toolName: failure.toolName ?? null,
          retryCount: failure.retryCount,
          occurredAt: new Date().toISOString(),
        },
        completedAt: new Date().toISOString(),
      });
      this.emitDelegationState(
        this.pendingPlannerDelegationContract,
        failure.category === "permission_denied"
          ? "The planner was blocked by a permission issue, so I paused the run."
          : failure.category === "provider_unreachable"
            ? "The planner hit a launch issue, so I paused the run and opened recovery options."
            : "The planner hit a launch issue, so I paused the run.",
      );
    }
    this.planningStartupState = "failed";
    this.updatePlannerLaunchTrackerStep({
      status: failure.category === "permission_denied" || failure.category === "native_tool_violation" ? "blocked" : "failed",
      reason: failure.reasonCode,
      detail: {
        category: failure.category,
        message: failure.message,
        retryCount: failure.retryCount,
        recoveryOptions: failure.recoveryOptions,
        toolName: failure.toolName ?? null,
      },
    });
    this.deps.onCoordinatorEvent?.({
      type: "status",
      turnStatus: "failed",
      message: failure.category === "permission_denied"
        ? "The planner was blocked by a permission issue, so I paused the run."
        : failure.category === "provider_unreachable"
          ? "The planner hit a launch issue, so I paused the run and opened recovery options."
          : "The planner hit a launch issue, so I paused the run.",
    });
    this.deps.onPlanningStartupFailure?.(failure);
  }

  private handlePlanningStartupToolCall(toolName: string): void {
    if (!this.isPlanningStartupGuardActive()) return;
    const contracts = this.listActiveDelegationContracts();
    const permission = checkCoordinatorToolPermission({
      toolName,
      contracts,
    });
    if (!permission.allowed) {
      const failure = this.buildNativeToolPlanningFailure(toolName);
      this.handlePlanningStartupFailure(failure);
      throw new CoordinatorFatalError(
        permission.reason?.trim().length ? permission.reason : failure.message,
      );
    }

    const normalizedToolName = normalizeCoordinatorToolName(toolName);
    if (normalizedToolName === "get_project_context" && this.pendingPlannerDelegationContract) {
      this.pendingPlannerDelegationContract = updateDelegationContract(this.pendingPlannerDelegationContract, {
        launchState: "fetching_context",
      });
      this.emitDelegationState(
        this.pendingPlannerDelegationContract,
        "I’m pulling project context so the planner starts with the right picture.",
      );
      this.planningStartupState = "awaiting_planner_launch";
      this.updatePlannerLaunchTrackerStep({
        status: "running",
        reason: "fetching_project_context",
      });
    }
    if (normalizedToolName === "spawn_worker" && this.pendingPlannerDelegationContract) {
      this.pendingPlannerDelegationContract = updateDelegationContract(this.pendingPlannerDelegationContract, {
        launchState: "launching_worker",
      });
      this.emitDelegationState(
        this.pendingPlannerDelegationContract,
        "I’m starting the planning agent now.",
      );
      if (this.planningStartupState !== "waiting_on_planner") {
        this.planningStartupState = "awaiting_planner_launch";
      }
      this.updatePlannerLaunchTrackerStep({
        status: "running",
        reason: "launching_planner",
      });
    }
  }

  private isPlanningFirstPhaseRun(): boolean {
    if (!Array.isArray(this.deps.phases) || this.deps.phases.length === 0) return false;
    const firstPhase = [...this.deps.phases].sort((a, b) => a.position - b.position)[0];
    return firstPhase?.phaseKey.trim().toLowerCase() === "planning";
  }

  private resolveFirstPostPlanningPhase(): PhaseCard | null {
    const sortedPhases = Array.isArray(this.deps.phases)
      ? [...this.deps.phases].sort((a, b) => a.position - b.position)
      : [];
    const planningPhaseIndex = sortedPhases.findIndex((phase) => phase.phaseKey.trim().toLowerCase() === "planning");
    return sortedPhases.find((phase, index) =>
      index > planningPhaseIndex && phase.phaseKey.trim().toLowerCase() !== "planning"
    ) ?? sortedPhases.find((phase) => phase.phaseKey.trim().toLowerCase() !== "planning") ?? null;
  }

  private hasOpenPlanningClarification(): boolean {
    const matchesPlanningClarification = (metadata: Record<string, unknown> | null | undefined): boolean => {
      const source = typeof metadata?.source === "string" ? metadata.source.trim().toLowerCase() : "";
      const phase = typeof metadata?.phase === "string" ? metadata.phase.trim().toLowerCase() : "";
      return source === "ask_user" || phase === "planning";
    };

    try {
      const rows = this.deps.db.all<{ metadata_json: string | null }>(
        `
          select metadata_json
          from mission_interventions
          where mission_id = ?
            and project_id = ?
            and status = 'open'
            and intervention_type = 'manual_input'
        `,
        [this.deps.missionId, this.deps.projectId],
      );
      if (rows.some((row) => {
        try {
          return matchesPlanningClarification(asRecord(JSON.parse(row.metadata_json ?? "null")));
        } catch {
          return false;
        }
      })) {
        return true;
      }
    } catch {
      // Fall back to mission service cache below.
    }

    const mission = this.deps.missionService.get(this.deps.missionId);
    return (mission?.interventions ?? []).some((intervention) => {
      if (intervention.status !== "open" || intervention.interventionType !== "manual_input") return false;
      return matchesPlanningClarification(asRecord(intervention.metadata));
    });
  }

  private planningQuestionRequiredBeforeExit(): boolean {
    const planningPhase = [...(this.deps.phases ?? [])]
      .sort((a, b) => a.position - b.position)
      .find((phase) => phase.phaseKey.trim().toLowerCase() === "planning" || phase.name.trim().toLowerCase() === "planning") ?? null;
    return phaseRequiresPlanningQuestionBeforeExit({
      phase: planningPhase,
      missionPrompt: this.missionPromptForPlanningPolicy(),
    });
  }

  private nonEmptyString(value: unknown): string | null {
    return typeof value === "string" && value.trim().length > 0 ? value : null;
  }

  private missionPromptForPlanningPolicy(): string | null {
    const candidates: string[] = [];
    const addCandidate = (value: unknown) => {
      const candidate = this.nonEmptyString(value);
      if (candidate && !candidates.includes(candidate)) candidates.push(candidate);
    };
    addCandidate(this.deps.missionService.get(this.deps.missionId)?.prompt);
    try {
      const missionPromptRow = this.deps.db.get<{ prompt?: unknown }>(
        `select prompt from missions where id = ? and project_id = ? limit 1`,
        [this.deps.missionId, this.deps.projectId],
      );
      addCandidate(missionPromptRow?.prompt);
    } catch {
      // Fall back to run metadata below.
    }
    try {
      const runMetadataRow = this.deps.db.get<{ metadata_json?: unknown }>(
        `select metadata_json from orchestrator_runs where id = ? limit 1`,
        [this.deps.runId],
      );
      const metadataJson = this.nonEmptyString(runMetadataRow?.metadata_json);
      if (metadataJson) {
        const metadata = asRecord(JSON.parse(metadataJson));
        addCandidate(metadata?.missionPrompt);
        addCandidate(metadata?.missionGoal);
      }
    } catch {
      // Fall back to the dependency value below.
    }
    addCandidate(this.deps.missionGoal);
    return candidates.length > 0 ? candidates.join("\n\n") : null;
  }

  private hasResolvedPlanningQuestion(): boolean {
    const mission = this.deps.missionService.get(this.deps.missionId);
    return hasResolvedPlanningQuestionIntervention(mission?.interventions ?? [], {
      runId: this.deps.runId,
    });
  }

  private hasPlanningExecutionRecord(): boolean {
    try {
      const graph = this.deps.orchestratorService.getRunGraph({
        runId: this.deps.runId,
        timelineLimit: 0,
      });
      return filterExecutionSteps(graph.steps).some((step) => this.isPlanningExecutionStep(step));
    } catch {
      return false;
    }
  }

  private getCurrentPhaseKeyFromRun(): string | null {
    try {
      const graph = this.deps.orchestratorService.getRunGraph({
        runId: this.deps.runId,
        timelineLimit: 0,
      });
      const runMetadata = asRecord(graph.run.metadata);
      const phaseRuntime = asRecord(runMetadata?.phaseRuntime);
      const currentPhaseKey = typeof phaseRuntime?.currentPhaseKey === "string"
        ? phaseRuntime.currentPhaseKey.trim()
        : "";
      return currentPhaseKey.length > 0 ? currentPhaseKey : null;
    } catch {
      return null;
    }
  }

  private hasSucceededPlanningExecutionRecord(): boolean {
    try {
      const graph = this.deps.orchestratorService.getRunGraph({
        runId: this.deps.runId,
        timelineLimit: 0,
      });
      return filterExecutionSteps(graph.steps).some((step) =>
        this.isPlanningExecutionStep(step) && step.status === "succeeded"
      );
    } catch {
      return false;
    }
  }

  private resolvePostPlanningPhaseTransitionRequired(): PhaseTransitionRequiredSignal | null {
    if (!this.isPlanningFirstPhaseRun()) return null;
    if (this.hasOpenPlanningClarification()) return null;
    const currentPhaseKey = this.getCurrentPhaseKeyFromRun()?.trim().toLowerCase();
    if (currentPhaseKey !== "planning") return null;
    if (!this.hasSucceededPlanningExecutionRecord()) return null;
    if (this.planningQuestionRequiredBeforeExit() && !this.hasResolvedPlanningQuestion()) return null;
    const nextPhase = this.resolveFirstPostPlanningPhase();
    const nextPhaseKey = nextPhase?.phaseKey.trim();
    if (!nextPhaseKey || nextPhaseKey.toLowerCase() === "planning") return null;
    return {
      phaseKey: nextPhaseKey,
      reason: "planning_complete",
    };
  }

  private getRunGraphSnapshot(): ReturnType<CoordinatorAgentDeps["orchestratorService"]["getRunGraph"]> | null {
    try {
      return this.deps.orchestratorService.getRunGraph({
        runId: this.deps.runId,
        timelineLimit: 0,
      });
    } catch {
      return null;
    }
  }

  private resolveCurrentPhaseCardFromRun(): PhaseCard | null {
    const currentPhaseKey = this.getCurrentPhaseKeyFromRun();
    if (!currentPhaseKey) return null;
    return [...(this.deps.phases ?? [])]
      .sort((a, b) => a.position - b.position)
      .find((phase) => phase.phaseKey === currentPhaseKey || phase.name === currentPhaseKey)
      ?? null;
  }

  private getExecutionStepsForPhase(phaseKey: string): OrchestratorStep[] {
    const graph = this.getRunGraphSnapshot();
    if (!graph) return [];
    const normalizedPhaseKey = phaseKey.trim().toLowerCase();
    return filterExecutionSteps(graph.steps).filter((step) => {
      const metadata = asRecord(step.metadata);
      const stepPhaseKey = typeof metadata?.phaseKey === "string" ? metadata.phaseKey.trim().toLowerCase() : "";
      return stepPhaseKey === normalizedPhaseKey;
    });
  }

  private phaseHasSucceededExecutionStep(phaseKey: string): boolean {
    return this.getExecutionStepsForPhase(phaseKey).some((step) => step.status === "succeeded");
  }

  private stepValidationState(step: OrchestratorStep): "pass" | "fail" | "pending" {
    const metadata = asRecord(step.metadata) ?? {};
    const stateRaw = typeof metadata.validationState === "string" ? metadata.validationState.trim().toLowerCase() : "";
    if (stateRaw === "pass" || stateRaw === "passed" || stateRaw === "success" || stateRaw === "succeeded") return "pass";
    if (stateRaw === "fail" || stateRaw === "failed" || stateRaw === "failure") return "fail";
    const lastValidationReport = asRecord(metadata.lastValidationReport);
    const reportVerdict = typeof lastValidationReport?.verdict === "string"
      ? lastValidationReport.verdict.trim().toLowerCase()
      : "";
    if (reportVerdict === "pass" || reportVerdict === "passed" || reportVerdict === "success" || reportVerdict === "succeeded") return "pass";
    if (reportVerdict === "fail" || reportVerdict === "failed" || reportVerdict === "failure") return "fail";
    const validationPassedAt = typeof metadata.validationPassedAt === "string" ? metadata.validationPassedAt.trim() : "";
    if (validationPassedAt.length > 0) return "pass";
    return "pending";
  }

  private stepRequiredValidationPending(step: OrchestratorStep): boolean {
    const metadata = asRecord(step.metadata) ?? {};
    const contract = asRecord(metadata.validationContract);
    if (contract?.required !== true) return false;
    return this.stepValidationState(step) !== "pass";
  }

  private stepRequiresPendingSelfValidation(step: OrchestratorStep): boolean {
    const metadata = asRecord(step.metadata) ?? {};
    const contract = asRecord(metadata.validationContract);
    if (contract?.required !== true) return false;
    const tier = typeof contract.tier === "string" ? contract.tier.trim().toLowerCase() : "";
    return tier === "self" && this.stepValidationState(step) !== "pass";
  }

  private isTestingLikePhaseValue(value: string): boolean {
    const normalized = value.trim().toLowerCase().replace(/[_-]+/g, " ");
    if (!normalized.length) return false;
    return /\b(test|testing|qa|quality|verify|verification|validation|validate|closeout|handoff|acceptance)\b/.test(normalized);
  }

  private isImplementationLikeStep(step: OrchestratorStep): boolean {
    const metadata = asRecord(step.metadata) ?? {};
    const stepType = typeof metadata.stepType === "string" ? metadata.stepType.trim().toLowerCase() : "";
    const phaseKey = typeof metadata.phaseKey === "string" ? metadata.phaseKey : "";
    const phaseName = typeof metadata.phaseName === "string" ? metadata.phaseName : "";
    if (this.isTestingLikePhaseValue(stepType) || this.isTestingLikePhaseValue(phaseKey) || this.isTestingLikePhaseValue(phaseName)) {
      return false;
    }
    return stepType === "implementation"
      || /\b(implement|implementation|develop|development|build|code|coding)\b/.test(phaseKey.trim().toLowerCase().replace(/[_-]+/g, " "))
      || /\b(implement|implementation|develop|development|build|code|coding)\b/.test(phaseName.trim().toLowerCase().replace(/[_-]+/g, " "));
  }

  private hasLaterTestingLikePhase(step: OrchestratorStep): boolean {
    const metadata = asRecord(step.metadata) ?? {};
    const phaseKey = typeof metadata.phaseKey === "string" ? metadata.phaseKey.trim().toLowerCase() : "";
    const currentPhase = this.deps.phases?.find((phase) => phase.phaseKey.trim().toLowerCase() === phaseKey);
    if (!currentPhase) return false;
    return (this.deps.phases ?? []).some((phase) => {
      if (phase.position <= currentPhase.position) return false;
      return this.isTestingLikePhaseValue(phase.phaseKey) || this.isTestingLikePhaseValue(phase.name);
    });
  }

  private shouldDeferFailedTestsToFinalValidation(
    step: OrchestratorStep,
    report: Record<string, unknown>,
    failedCount: number,
  ): boolean {
    if (failedCount <= 0) return false;
    const outcome = typeof report.outcome === "string" ? report.outcome.trim().toLowerCase() : "";
    if (outcome !== "succeeded" && outcome !== "completed" && outcome !== "pass" && outcome !== "passed") return false;
    if (!this.isImplementationLikeStep(step)) return false;
    return this.hasLaterTestingLikePhase(step);
  }

  private buildSelfValidationDecision(step: OrchestratorStep): SelfValidationDecision | null {
    const metadata = asRecord(step.metadata) ?? {};
    const report = asRecord(metadata.lastResultReport);
    if (!report) return null;
    const summary = typeof report.summary === "string" ? report.summary.trim() : "";
    if (!summary.length) return null;
    const outcome = typeof report.outcome === "string" ? report.outcome.trim().toLowerCase() : "";
    const testsRun = asRecord(report.testsRun);
    const failedCount = testsRun && Number.isFinite(Number(testsRun.failed))
      ? Math.max(0, Math.floor(Number(testsRun.failed)))
      : 0;
    const testsSummary =
      testsRun && (
        Number.isFinite(Number(testsRun.passed))
        || Number.isFinite(Number(testsRun.failed))
        || Number.isFinite(Number(testsRun.skipped))
        || typeof testsRun.raw === "string"
      )
        ? [
            Number.isFinite(Number(testsRun.passed)) ? `passed=${Math.max(0, Math.floor(Number(testsRun.passed)))}` : null,
            Number.isFinite(Number(testsRun.failed)) ? `failed=${failedCount}` : null,
            Number.isFinite(Number(testsRun.skipped)) ? `skipped=${Math.max(0, Math.floor(Number(testsRun.skipped)))}` : null,
          ].filter((entry): entry is string => Boolean(entry)).join(", ")
        : "";

    const deferFailedTests = this.shouldDeferFailedTestsToFinalValidation(step, report, failedCount);
    if (outcome === "failed" || outcome === "partial" || (failedCount > 0 && !deferFailedTests)) {
      return {
        verdict: "fail",
        summary: [
          `Self-validation failed for ${step.stepKey}: ${summary}`,
          testsSummary ? `Tests: ${testsSummary}` : null,
        ].filter((entry): entry is string => Boolean(entry)).join(" "),
        findings: [
          {
            code: "worker_result_not_validated",
            severity: "high",
            message: failedCount > 0
              ? `Worker reported ${failedCount} failed test(s).`
              : `Worker reported outcome "${outcome || "unknown"}".`,
            remediation: "Fix the reported issues, rerun the relevant checks, and report validation again.",
          },
        ],
      };
    }

    return {
      verdict: "pass",
      summary: [
        `Self-validation passed for ${step.stepKey}: ${summary}`,
        deferFailedTests
          ? "Reported test failures are deferred to the final validation phase because this implementation worker can observe sibling phase work before it lands."
          : null,
        testsSummary ? `Tests: ${testsSummary}` : null,
      ].filter((entry): entry is string => Boolean(entry)).join(" "),
      findings: deferFailedTests
        ? [
            {
              code: "integration_tests_deferred",
              severity: "medium",
              message: `Worker reported ${failedCount} failed test(s) during an implementation phase; final validation must rerun after sibling phase work lands.`,
              remediation: "Continue to the configured testing or closeout phase and require the final checks to pass.",
            },
          ]
        : [],
    };
  }

  private async applySelfValidationDecisionFromRuntime(
    step: OrchestratorStep,
    decision: SelfValidationDecision,
    turnId: string,
  ): Promise<boolean> {
    const tool = this.tools.report_validation as any;
    if (!tool || typeof tool.execute !== "function") return false;
    const metadata = asRecord(step.metadata) ?? {};
    const contract = asRecord(metadata.validationContract) ?? {
      level: "step",
      tier: "self",
      required: true,
      criteria: `Validate completed output for step "${step.stepKey}".`,
      evidence: [],
      maxRetries: 1,
    };
    const args = {
      targetWorkerId: step.stepKey,
      contract,
      verdict: decision.verdict,
      summary: decision.summary,
      findings: decision.findings,
      remediationInstructions: decision.verdict === "fail"
        ? ["Fix the reported issues and rerun validation."]
        : [],
    };
    this.deps.logger.warn("coordinator_agent.self_validation_runtime_recovery_applying", {
      runId: this.deps.runId,
      turnId,
      stepKey: step.stepKey,
      verdict: decision.verdict,
    });
    this.deps.onCoordinatorEvent?.({
      type: "tool_call",
      tool: "report_validation",
      args,
      itemId: `runtime:${turnId}:self-validation:${step.stepKey}`,
      turnId,
    });
    const output = await tool.execute(args);
    const result = coerceToolOutputRecord(output);
    this.deps.onCoordinatorEvent?.({
      type: "tool_result",
      tool: "report_validation",
      result: output,
      itemId: `runtime:${turnId}:self-validation:${step.stepKey}`,
      turnId,
      status: result?.ok === false ? "failed" : "completed",
    });
    if (result?.ok === false) {
      const error = typeof result.error === "string" ? result.error : "report_validation failed.";
      this.queueInternalMessage([
        "SELF-VALIDATION REPORT FAILED:",
        `ADE tried to record self-validation for "${step.stepKey}", but report_validation failed: ${error}`,
        "Call report_validation with corrected arguments before moving to the next phase.",
      ].join("\n"));
      return false;
    }
    this.queueInternalMessage([
      "SELF-VALIDATION RECORDED:",
      `ADE recorded a ${decision.verdict} self-validation verdict for "${step.stepKey}" from the worker's structured result report.`,
      decision.verdict === "pass"
        ? "Continue phase progression through the configured phase order."
        : "Do not advance the phase until the worker output is repaired and validation passes.",
    ].join("\n"));
    return true;
  }

  private async enforcePendingSelfValidation(turnId: string): Promise<"ok" | "validated"> {
    const graph = this.getRunGraphSnapshot();
    if (!graph) return "ok";
    const currentPhase = this.resolveCurrentPhaseCardFromRun();
    const currentPhaseKey = currentPhase?.phaseKey.trim().toLowerCase() ?? "";
    const candidates = filterExecutionSteps(graph.steps)
      .filter((step) => step.status === "succeeded")
      .filter((step) => this.stepRequiresPendingSelfValidation(step))
      .sort((a, b) => {
        const aMeta = asRecord(a.metadata) ?? {};
        const bMeta = asRecord(b.metadata) ?? {};
        const aInCurrent = typeof aMeta.phaseKey === "string" && aMeta.phaseKey.trim().toLowerCase() === currentPhaseKey;
        const bInCurrent = typeof bMeta.phaseKey === "string" && bMeta.phaseKey.trim().toLowerCase() === currentPhaseKey;
        if (aInCurrent !== bInCurrent) return aInCurrent ? -1 : 1;
        return (a.completedAt ?? a.updatedAt).localeCompare(b.completedAt ?? b.updatedAt);
      });
    for (const step of candidates) {
      const decision = this.buildSelfValidationDecision(step);
      if (!decision) continue;
      if (await this.applySelfValidationDecisionFromRuntime(step, decision, turnId)) {
        return "validated";
      }
    }
    return "ok";
  }

  private phaseHasOpenExecutionStep(phaseKey: string): boolean {
    return this.getExecutionStepsForPhase(phaseKey).some((step) => !TERMINAL_STEP_STATUSES.has(step.status));
  }

  private phaseHasAnyExecutionStep(phaseKey: string): boolean {
    return this.getExecutionStepsForPhase(phaseKey).length > 0;
  }

  private getSortedPhaseCards(): PhaseCard[] {
    return [...(this.deps.phases ?? [])].sort((a, b) => a.position - b.position);
  }

  private getExecutionStepsForPhaseFromGraph(
    graph: ReturnType<CoordinatorAgentDeps["orchestratorService"]["getRunGraph"]>,
    phase: PhaseCard,
  ): OrchestratorStep[] {
    const normalizedPhaseKey = phase.phaseKey.trim().toLowerCase();
    const normalizedPhaseName = phase.name.trim().toLowerCase();
    return filterExecutionSteps(graph.steps).filter((step) => {
      const metadata = asRecord(step.metadata) ?? {};
      const stepPhaseKey = typeof metadata.phaseKey === "string" ? metadata.phaseKey.trim().toLowerCase() : "";
      const stepPhaseName = typeof metadata.phaseName === "string" ? metadata.phaseName.trim().toLowerCase() : "";
      return stepPhaseKey === normalizedPhaseKey || stepPhaseName === normalizedPhaseName;
    });
  }

  private phaseHasValidatedSuccess(
    graph: ReturnType<CoordinatorAgentDeps["orchestratorService"]["getRunGraph"]>,
    phase: PhaseCard,
  ): boolean {
    const steps = this.getExecutionStepsForPhaseFromGraph(graph, phase);
    if (steps.length === 0) return false;
    const successfulSteps = steps.filter((step) => step.status === "succeeded");
    if (successfulSteps.length === 0) return false;
    return successfulSteps.some((step) => !this.stepRequiredValidationPending(step));
  }

  private phaseHasOpenExecutionStepInGraph(
    graph: ReturnType<CoordinatorAgentDeps["orchestratorService"]["getRunGraph"]>,
    phase: PhaseCard,
  ): boolean {
    return this.getExecutionStepsForPhaseFromGraph(graph, phase)
      .some((step) => !TERMINAL_STEP_STATUSES.has(step.status));
  }

  private resolvePhaseDependencyStepKeys(
    graph: ReturnType<CoordinatorAgentDeps["orchestratorService"]["getRunGraph"]>,
    phase: PhaseCard,
  ): string[] {
    const sorted = this.getSortedPhaseCards();
    const targetIndex = sorted.findIndex((candidate) => candidate.phaseKey === phase.phaseKey);
    const explicitMustFollow = (phase.orderingConstraints.mustFollow ?? [])
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    const predecessorPhases =
      explicitMustFollow.length > 0
        ? explicitMustFollow
            .map((key) => findPhaseByRef(sorted, key))
            .filter((candidate): candidate is PhaseCard => Boolean(candidate))
        : sorted.slice(0, Math.max(0, targetIndex)).filter((candidate) =>
            candidate.orderingConstraints.mustBeFirst || candidate.validationGate.required === true
          );
    for (const predecessor of resolveMustPrecedePredecessors(sorted, phase)) {
      if (!predecessorPhases.includes(predecessor)) predecessorPhases.push(predecessor);
    }
    const dependencyKeys: string[] = [];
    for (const predecessor of predecessorPhases) {
      const successful = this.getExecutionStepsForPhaseFromGraph(graph, predecessor)
        .filter((step) => step.status === "succeeded")
        .sort((a, b) => (b.completedAt ?? b.updatedAt).localeCompare(a.completedAt ?? a.updatedAt));
      const stepKey = successful[0]?.stepKey;
      if (stepKey && !dependencyKeys.includes(stepKey)) dependencyKeys.push(stepKey);
    }
    return dependencyKeys;
  }

  private phaseCanStartNow(
    graph: ReturnType<CoordinatorAgentDeps["orchestratorService"]["getRunGraph"]>,
    phase: PhaseCard,
  ): boolean {
    const phaseKey = phase.phaseKey.trim().toLowerCase();
    const phaseName = phase.name.trim().toLowerCase();
    if (!phaseKey || phaseKey === "planning" || phaseName === "planning") return false;
    if (phase.requiresApproval === true) return false;
    if (this.getExecutionStepsForPhaseFromGraph(graph, phase).length > 0) return false;
    const sorted = this.getSortedPhaseCards();
    const targetIndex = sorted.findIndex((candidate) => candidate.phaseKey === phase.phaseKey);
    if (targetIndex < 0) return false;
    const explicitMustFollow = (phase.orderingConstraints.mustFollow ?? [])
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    for (let index = 0; index < targetIndex; index += 1) {
      const earlier = sorted[index]!;
      if (earlier.orderingConstraints.mustBeFirst && !this.phaseHasValidatedSuccess(graph, earlier)) return false;
      if (explicitMustFollow.length === 0 && earlier.validationGate.required && !this.phaseHasValidatedSuccess(graph, earlier)) return false;
      if (phase.orderingConstraints.mustBeLast && this.phaseHasOpenExecutionStepInGraph(graph, earlier)) return false;
    }
    for (const predecessorKey of explicitMustFollow) {
      const predecessor = findPhaseByRef(sorted, predecessorKey);
      if (predecessor && !this.phaseHasValidatedSuccess(graph, predecessor)) return false;
    }
    for (const predecessor of resolveMustPrecedePredecessors(sorted, phase)) {
      if (!this.phaseHasValidatedSuccess(graph, predecessor)) return false;
    }
    return true;
  }

  private buildRuntimePhaseStepMetadata(phase: PhaseCard, modelId: string, workerName: string): Record<string, unknown> {
    const descriptor = resolveModelDescriptor(modelId);
    const provider = descriptor ? resolveProviderGroupForModel(descriptor) : "opencode";
    const stepType = this.resolveRuntimePhaseStepType(phase);
    const workerPrompt = this.buildRuntimePhaseWorkerPrompt(phase);
    const requiredBeforeExit = phaseRequiresPlanningQuestionBeforeExit({
      phase,
      missionPrompt: [this.missionPromptForPlanningPolicy(), workerPrompt]
        .map((entry) => this.nonEmptyString(entry))
        .filter((entry): entry is string => Boolean(entry))
        .join("\n\n") || null,
    });
    return {
      phaseKey: phase.phaseKey,
      phaseName: phase.name,
      phasePosition: phase.position,
      phaseModel: phase.model,
      phaseInstructions: phase.instructions,
      phaseAskQuestions: {
        enabled: phase.askQuestions.enabled === true,
        maxQuestions: phase.askQuestions.enabled === true
          ? Math.max(1, Math.min(10, Number(phase.askQuestions.maxQuestions ?? 5) || 5))
          : undefined,
        requiredBeforeExit,
      },
      phaseValidation: phase.validationGate,
      phaseBudget: phase.budget ?? {},
      stepType,
      taskType: stepType,
      readOnlyExecution: stepType === "planning",
      instructions: workerPrompt,
      workerName,
      spawnedByCoordinator: true,
      modelId,
      modelProviderHint: provider,
      modelExecutionPath: descriptor ? classifyWorkerExecutionPath(descriptor) : "api",
      role: null,
      roleCapabilities: [],
      toolProfile: null,
    };
  }

  private resolveRuntimePhaseStepType(phase: PhaseCard): string {
    const normalized = phase.phaseKey.trim().toLowerCase();
    if (normalized === "planning" || normalized === "analysis") return "planning";
    if (
      normalized === "development"
      || normalized === "implementation"
      || normalized.startsWith("development_")
      || normalized.startsWith("implementation_")
      || normalized.endsWith("_development")
      || normalized.endsWith("_implementation")
    ) return "implementation";
    if (normalized === "testing" || normalized === "test") return "testing";
    if (normalized === "validation") return "validation";
    if (normalized === "code_review" || normalized === "review") return "review";
    if (normalized === "test_review") return "test_review";
    if (normalized === "integration" || normalized === "merge") return "integration";
    return normalized || "implementation";
  }

  private async spawnReadySiblingPhaseWorkersFromRuntime(turnId: string): Promise<number> {
    if (this.deps.userRules?.allowParallelAgents === false) return 0;
    const graph = this.getRunGraphSnapshot();
    if (!graph) return 0;
    const sorted = this.getSortedPhaseCards();
    if (sorted.length === 0) return 0;
    const openExecutionCount = filterExecutionSteps(graph.steps)
      .filter((step) => !TERMINAL_STEP_STATUSES.has(step.status))
      .length;
    const configuredCap = Number(this.deps.userRules?.maxParallelWorkers ?? 0);
    const maxParallelWorkers = Number.isFinite(configuredCap) && configuredCap > 0
      ? Math.max(1, Math.floor(configuredCap))
      : 4;
    let remainingSlots = Math.max(0, maxParallelWorkers - openExecutionCount);
    if (remainingSlots <= 0) return 0;

    const currentPhaseKey = this.getCurrentPhaseKeyFromRun()?.trim().toLowerCase() ?? "";
    const readyPhases = sorted
      .filter((phase) => phase.phaseKey.trim().toLowerCase() !== currentPhaseKey)
      .filter((phase) => this.phaseCanStartNow(graph, phase))
      .slice(0, remainingSlots);
    if (readyPhases.length === 0) return 0;

    let created = 0;
    for (const phase of readyPhases) {
      if (remainingSlots <= 0) break;
      const modelId = phase.model?.modelId?.trim() || this.deps.modelId;
      const descriptor = resolveModelDescriptor(modelId);
      const provider = descriptor ? resolveProviderGroupForModel(descriptor) : "opencode";
      const workerName = `${phase.phaseKey.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "") || "phase"}-worker`;
      const stepKey = `worker_${workerName.replace(/[^a-zA-Z0-9_-]/g, "_")}_${Date.now() + created}`;
      const dependencyStepKeys = this.resolvePhaseDependencyStepKeys(graph, phase);
      this.deps.logger.warn("coordinator_agent.ready_phase_runtime_worker_spawning", {
        runId: this.deps.runId,
        turnId,
        phaseKey: phase.phaseKey,
        workerName,
        dependencyStepKeys,
      });
      this.deps.onCoordinatorEvent?.({
        type: "status",
        turnStatus: "interrupted",
        turnId,
        message: `ADE is starting ready phase "${phase.phaseKey}" in parallel because its phase dependencies are satisfied.`,
      });
      const steps = this.deps.orchestratorService.addSteps({
        runId: this.deps.runId,
        steps: [
          {
            stepKey,
            title: workerName,
            stepIndex: graph.steps.length + created,
            laneId: this.deps.missionLaneId ?? null,
            dependencyStepKeys,
            executorKind: provider,
            metadata: this.buildRuntimePhaseStepMetadata(phase, modelId, workerName),
          },
        ],
      } as any);
      const newStep = Array.isArray(steps) ? steps[0] : null;
      if (newStep) {
        this.deps.onDagMutation({
          runId: this.deps.runId,
          mutation: { type: "step_added", step: newStep },
          timestamp: new Date().toISOString(),
          source: "coordinator",
        });
      }
      created += 1;
      remainingSlots -= 1;
    }
    if (created > 0 && typeof (this.deps.orchestratorService as any).startReadyAutopilotAttempts === "function") {
      try {
        await (this.deps.orchestratorService as any).startReadyAutopilotAttempts({
          runId: this.deps.runId,
          reason: "ready_phase_parallel_runtime_spawn",
        });
      } catch {
        // The scheduler tick will pick up queued steps on the next pass.
      }
    }
    return created;
  }

  private resolveNextPhaseAfter(phaseKey: string): PhaseCard | null {
    const sortedPhases = [...(this.deps.phases ?? [])].sort((a, b) => a.position - b.position);
    const currentIndex = sortedPhases.findIndex((phase) => phase.phaseKey === phaseKey);
    if (currentIndex < 0) return null;
    return sortedPhases.slice(currentIndex + 1).find((phase) => phase.phaseKey.trim().length > 0) ?? null;
  }

  private getLatestPlanningResultForPrompt(): string {
    const graph = this.getRunGraphSnapshot();
    if (!graph) return "";
    const planningSteps = filterExecutionSteps(graph.steps)
      .filter((step) => this.isPlanningExecutionStep(step) && step.status === "succeeded")
      .sort((a, b) => (b.completedAt ?? b.updatedAt).localeCompare(a.completedAt ?? a.updatedAt));
    for (const step of planningSteps) {
      const metadata = asRecord(step.metadata);
      const report = asRecord(metadata?.lastResultReport);
      const plan = asRecord(report?.plan);
      const markdown = typeof plan?.markdown === "string" ? plan.markdown.trim() : "";
      if (markdown.length > 0) return markdown.slice(0, 6000);
      const summary = typeof report?.summary === "string" ? report.summary.trim() : "";
      if (summary.length > 0) return summary.slice(0, 2000);
    }
    return "";
  }

  private buildPlanningRecoveryPrompt(): { name: string; prompt: string; modelId?: string } {
    const phases = Array.isArray(this.deps.phases) ? [...this.deps.phases] : [];
    const planningPhase = phases
      .sort((a, b) => a.position - b.position)
      .find((phase) => phase.phaseKey.trim().toLowerCase() === "planning") ?? null;
    const sections = [
      `Mission goal:\n${this.deps.missionGoal}`,
      planningPhase?.instructions?.trim().length
        ? `Planning phase instructions:\n${planningPhase.instructions.trim()}`
        : null,
      [
        "Read-only planning pass:",
        "- Research the codebase and discover the implementation plan.",
        "- Identify dependencies, risks, sequencing, and the best execution DAG.",
        "- Do not modify files, run write operations, or ask for plan-exit approval.",
        "- Do NOT use ExitPlanMode or any provider-native plan approval flow.",
        "- Return the plan through the runtime result channel: tracked mission workers use report_result; managed ADE chat workers use a final `### report_result` section with plan.markdown. ADE will persist the canonical plan artifact.",
        "- If you need clarification, use the runtime's ADE question UI: tracked mission workers use `ask_user`; managed Codex chat workers use `request_user_input`; Claude uses AskUserQuestion / ask_user; Cursor/OpenCode/Droid use the provider question mechanism ADE renders inline.",
        "- Return a concrete plan the coordinator can use to enter Development automatically.",
      ].join("\n"),
    ].filter((entry): entry is string => Boolean(entry));

    return {
      name: "planning-worker",
      prompt: sections.join("\n\n"),
      ...(planningPhase?.model?.modelId ? { modelId: planningPhase.model.modelId } : {}),
    };
  }

  private async launchRequiredPlanningWorkerFromRuntime(turnId: string): Promise<boolean> {
    const tool = this.tools.spawn_worker as any;
    if (!tool || typeof tool.execute !== "function") return false;
    const plannerPrompt = this.buildPlanningRecoveryPrompt();
    this.deps.logger.warn("coordinator_agent.planning_runtime_recovery_launching", {
      runId: this.deps.runId,
      turnId,
      retryCount: this.planningStartupRetryCount,
    });
    this.deps.onCoordinatorEvent?.({
      type: "status",
      turnStatus: "interrupted",
      turnId,
      message: "The coordinator did not start the planner, so ADE is launching the required planning worker through mission control.",
    });
    const result = coerceToolOutputRecord(await tool.execute({
      ...plannerPrompt,
      dependsOn: [],
    }));
    if (result?.ok !== true) {
      const message = typeof result?.error === "string" ? result.error : "Runtime planner launch failed.";
      const failure = this.buildPlannerLaunchFailure(message, "spawn_worker");
      this.handlePlanningStartupFailure({
        ...failure,
        retryable: false,
        recoveryOptions: ["retry", "cancel_run"],
        retryCount: this.planningStartupRetryCount,
      });
      return false;
    }

    const delegatedContract = extractDelegationContract(result.delegationContract ?? null);
    if (delegatedContract && delegatedContract.workerIntent === "planner") {
      this.pendingPlannerDelegationContract = delegatedContract;
    } else if (this.pendingPlannerDelegationContract) {
      this.pendingPlannerDelegationContract = updateDelegationContract(this.pendingPlannerDelegationContract, {
        status: "active",
        launchState: "waiting_on_worker",
        activeWorkerIds:
          typeof result.workerId === "string" && result.workerId.trim().length > 0
            ? [result.workerId.trim()]
            : this.pendingPlannerDelegationContract.activeWorkerIds,
      });
    }
    this.planningStartupState = "waiting_on_planner";
    if (this.pendingPlannerDelegationContract) {
      this.emitDelegationState(
        this.pendingPlannerDelegationContract,
        result.launched === false
          ? "The planning agent is queued. I’m waiting for it to start."
          : "The planning agent is running. I’m waiting for its result.",
      );
    }
    this.updatePlannerLaunchTrackerStep({
      status: "running",
      reason: result.launched === false ? "planner_queued" : "planner_runtime_recovery_launched",
      detail: {
        launched: result.launched ?? null,
        launchNote: typeof result.launchNote === "string" ? result.launchNote : null,
        stepId: typeof result.stepId === "string" ? result.stepId : null,
        source: "runtime_planner_recovery",
      },
    });
    this.deps.onCoordinatorEvent?.({
      type: "status",
      turnStatus: "started",
      turnId,
      message: result.launched === false
        ? "The planning agent is queued. I’m waiting for it to start."
        : "The planning agent is running. I’m waiting for its result.",
    });
    return true;
  }

  private async applyRequiredPhaseTransitionFromRuntime(
    signal: PhaseTransitionRequiredSignal,
    turnId: string,
  ): Promise<boolean> {
    const phaseKey = signal.phaseKey.trim();
    if (!phaseKey.length) return false;
    const tool = this.tools.set_current_phase as any;
    if (!tool || typeof tool.execute !== "function") return false;
    this.deps.logger.warn("coordinator_agent.phase_transition_runtime_recovery_applying", {
      runId: this.deps.runId,
      turnId,
      phaseKey,
      reason: signal.reason,
    });
    this.deps.onCoordinatorEvent?.({
      type: "status",
      turnStatus: "interrupted",
      turnId,
      message: `The coordinator did not enter phase "${phaseKey}", so ADE is applying the required phase transition through mission control.`,
    });
    const result = coerceToolOutputRecord(await tool.execute({
      phaseKey,
      reason: signal.reason || "planning_complete",
    }));
    if (result?.ok !== true) {
      if (result?.pendingApproval === true) {
        this.deps.onCoordinatorEvent?.({
          type: "status",
          turnStatus: "interrupted",
          turnId,
          message: `Phase "${phaseKey}" is waiting for approval before the mission can continue.`,
        });
        return true;
      }
      const error = typeof result?.error === "string" && result.error.trim().length > 0
        ? result.error.trim()
        : `set_current_phase did not enter phase '${phaseKey}'.`;
      this.deps.onCoordinatorEvent?.({
        type: "error",
        turnId,
        message: error,
      });
      throw new CoordinatorFatalError(
        error,
        {
          category: "unknown",
          reasonCode: "phase_transition_runtime_recovery_failed",
          interventionType: "policy_block",
          retryable: true,
          recoveryOptions: ["retry", "cancel_run"],
          message: error,
          title: "ADE could not enter the required phase",
          body:
            `ADE attempted to enter '${phaseKey}' through the normal set_current_phase tool after the coordinator ignored the phase contract, but the tool failed. ` +
            "The run was paused instead of letting phase ordering drift.",
          requestedAction: "Inspect the phase configuration and planner result, then retry or cancel the run.",
          turnId,
        },
      );
    }

    this.phaseTransitionCorrectionCounts.delete(phaseKey);
    this.deps.onCoordinatorEvent?.({
      type: "status",
      turnStatus: "started",
      turnId,
      message: `Mission phase is now "${String(result.currentPhaseName ?? phaseKey)}".`,
    });
    this.queueInternalMessage([
      "PHASE TRANSITION COMPLETE:",
      `ADE entered phase "${phaseKey}" through set_current_phase because planning had completed and the coordinator did not execute the phase transition itself.`,
      "Continue with the implementation DAG now. Create visible tasks when useful, then spawn workers according to the completed planning output and configured phase order.",
    ].join("\n"));
    return true;
  }

  private shouldIdleAfterRecoveredToolCalls(toolNames: string[]): boolean {
    if (toolNames.length === 0) return false;
    if (this.isPlanningStartupGuardActive()) return false;
    if (!toolNames.every((toolName) => RECOVERED_IDLE_WHILE_WORKERS_RUNNING_TOOLS.has(toolName))) {
      return false;
    }

    try {
      const graph = this.deps.orchestratorService.getRunGraph({
        runId: this.deps.runId,
        timelineLimit: 0,
      });
      const executionSteps = filterExecutionSteps(graph.steps);
      const runningCount = executionSteps.filter((step) => step.status === "running").length;
      if (runningCount === 0) return false;

      const hasActionableStep = executionSteps.some((step) =>
        step.status === "ready" || step.status === "blocked" || step.status === "failed"
      );
      return !hasActionableStep;
    } catch {
      return false;
    }
  }

  private getRecoveredToolExecutionContext(): RecoveredToolExecutionContext {
    try {
      const graph = this.deps.orchestratorService.getRunGraph({
        runId: this.deps.runId,
        timelineLimit: 0,
      });
      const executionSteps = filterExecutionSteps(graph.steps);
      const hadRunningWorkers = executionSteps.some((step) => step.status === "running");
      const hadActionableSteps = executionSteps.some((step) =>
        step.status === "ready" || step.status === "blocked" || step.status === "failed"
      );
      return { hadRunningWorkers, hadActionableSteps };
    } catch {
      return { hadRunningWorkers: false, hadActionableSteps: true };
    }
  }

  private shouldSuppressRecoveredSpawnWorker(context: RecoveredToolExecutionContext): boolean {
    if (this.isPlanningStartupGuardActive()) return false;
    return context.hadRunningWorkers && !context.hadActionableSteps;
  }

  private coerceRecoveredToolArgs(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
    const normalizedToolName = normalizeCoordinatorToolName(toolName);
    if (normalizedToolName === "spawn_worker") {
      const laneId = typeof args.laneId === "string" && args.laneId.trim().length > 0
        ? args.laneId.trim()
        : typeof args.lane === "string" && args.lane.trim().length > 0
          ? args.lane.trim()
          : undefined;
      return {
        ...args,
        ...(laneId ? { laneId } : {}),
      };
    }
    if (normalizedToolName === "skip_step") {
      const workerId = typeof args.workerId === "string" && args.workerId.trim().length > 0
        ? args.workerId.trim()
        : typeof args.stepKey === "string" && args.stepKey.trim().length > 0
          ? args.stepKey.trim()
          : typeof args.stepId === "string" && args.stepId.trim().length > 0
            ? args.stepId.trim()
            : typeof args.id === "string" && args.id.trim().length > 0
              ? args.id.trim()
              : undefined;
      return {
        ...args,
        ...(workerId ? { workerId } : {}),
      };
    }
    return args;
  }

  private async executeRecoveredCoordinatorToolCalls(
    assistantText: string,
    turnId: string,
  ): Promise<number> {
    const calls = parseRecoveredCoordinatorToolCalls(assistantText)
      .slice(0, MAX_TOOL_STEPS_PER_TURN);
    if (calls.length === 0) return 0;

    let executed = 0;
    let handled = 0;
    let spawnedWorker = false;
    let statusProbeOnly = true;
    let hasToolFailure = false;
    const executedToolNames: string[] = [];
    const resultSummaries: string[] = [];
    const executionContext = this.getRecoveredToolExecutionContext();
    this.deps.logger.warn("coordinator_agent.recovering_pseudo_tool_calls", {
      runId: this.deps.runId,
      turnId,
      count: calls.length,
      tools: calls.map((call) => call.toolName),
    });
    this.deps.onCoordinatorEvent?.({
      type: "status",
      turnStatus: "interrupted",
      turnId,
      message: "The coordinator wrote mission-control calls as text, so ADE is replaying those calls through the real mission-control tools.",
    });

    for (const call of calls) {
      const normalizedToolName = normalizeCoordinatorToolName(call.toolName);
      const tool = this.tools[normalizedToolName];
      if (!tool) {
        this.deps.logger.warn("coordinator_agent.recovered_tool_missing", {
          runId: this.deps.runId,
          turnId,
          toolName: call.toolName,
          normalizedToolName,
        });
        continue;
      }
      const args = this.coerceRecoveredToolArgs(normalizedToolName, call.args);
      if (normalizedToolName === "spawn_worker" && this.shouldSuppressRecoveredSpawnWorker(executionContext)) {
        handled += 1;
        this.deps.logger.info("coordinator_agent.recovered_spawn_worker_suppressed", {
          runId: this.deps.runId,
          turnId,
          reason: "workers_running_no_actionable_steps",
          args,
        });
        this.deps.onCoordinatorEvent?.({
          type: "status",
          turnStatus: "interrupted",
          turnId,
          message: "ADE ignored a recovered spawn_worker call because workers are already running and no actionable step needs a new worker.",
        });
        continue;
      }
      if (this.isPlanningStartupGuardActive()) {
        const permission = checkCoordinatorToolPermission({
          toolName: normalizedToolName,
          contracts: this.listActiveDelegationContracts(),
        });
        if (!permission.allowed) {
          this.deps.logger.info("coordinator_agent.recovered_tool_skipped_planner_delegation_active", {
            runId: this.deps.runId,
            turnId,
            toolName: normalizedToolName,
            reason: permission.reason,
          });
          this.deps.onCoordinatorEvent?.({
            type: "status",
            turnStatus: "interrupted",
            turnId,
            message: permission.reason,
          });
          this.queueInternalMessage([
            "RECOVERED TOOL CALL SKIPPED:",
            permission.reason,
            "A planner delegation is already active. Wait for that planner or retry the planner through the recovery path instead of replaying status probes.",
          ].join("\n"));
          continue;
        }
      }
      this.handlePlanningStartupToolCall(normalizedToolName);
      this.deps.onCoordinatorEvent?.({
        type: "tool_call",
        tool: normalizedToolName,
        args,
        itemId: `recovered:${turnId}:${executed + 1}`,
        turnId,
      });
      const output = await tool.execute(args);
      const toolOutput = coerceToolOutputRecord(output);
      executed += 1;
      handled += 1;
      executedToolNames.push(normalizedToolName);
      resultSummaries.push(
        `- ${normalizedToolName}: ${stringifyRecoveredToolOutputForPrompt(toolOutput ?? output)}`,
      );
      if (!RECOVERED_STATUS_PROBE_TOOLS.has(normalizedToolName)) {
        statusProbeOnly = false;
      }
      this.deps.onCoordinatorEvent?.({
        type: "tool_result",
        tool: normalizedToolName,
        result: output,
        itemId: `recovered:${turnId}:${executed}`,
        turnId,
        status: toolOutput?.ok === false ? "failed" : "completed",
      });
      const transitionSignal = extractPhaseTransitionRequiredSignal(toolOutput);
      if (transitionSignal) {
        this.queuePhaseTransitionCorrection(transitionSignal, turnId);
        break;
      }
      if (normalizedToolName === "set_current_phase" && toolOutput?.ok === true) {
        this.phaseTransitionCorrectionCounts.clear();
      }
      if (normalizedToolName === "spawn_worker" && toolOutput?.ok === true) {
        spawnedWorker = true;
      }
      if (toolOutput?.ok === false) {
        hasToolFailure = true;
        const error = typeof toolOutput.error === "string" ? toolOutput.error : `${normalizedToolName} failed.`;
        const correction = this.deps.agentChatService
          ? "Correct the tool arguments and continue by emitting fenced JSON mission-control calls."
          : "Correct the tool arguments and continue through real mission-control tools. Do not describe calls in markdown.";
        this.queueInternalMessage([
          "RECOVERED TOOL RESULT:",
          `The recovered ${normalizedToolName} call failed: ${error}`,
          correction,
        ].join("\n"));
        break;
      }
    }

    if (executed > 0 && !spawnedWorker) {
      if (!hasToolFailure && this.shouldIdleAfterRecoveredToolCalls(executedToolNames)) {
        this.deps.logger.info("coordinator_agent.recovered_tool_followup_suppressed", {
          runId: this.deps.runId,
          turnId,
          tools: executedToolNames,
          reason: "workers_running_no_actionable_steps",
        });
        return executed;
      }
      const resultBlock = resultSummaries.length > 0
        ? [
            "Recovered tool outputs:",
            joinRecoveredToolResultSummaries(resultSummaries),
          ].join("\n")
        : "Recovered tools completed but did not return structured output.";
      const nextCallGuidance = this.deps.agentChatService
        ? statusProbeOnly
          ? "Use these concrete results to choose the next action. Do not repeat the same read-only status probes unless state has changed; emit the state-changing mission-control call needed to validate, skip, retry, or complete the mission."
          : "Continue the mission by emitting fenced JSON mission-control calls. Do not answer that mission-control tools are unavailable."
        : statusProbeOnly
          ? "Use these concrete results to choose the next action. Do not repeat the same read-only status probes unless state has changed; call the state-changing mission-control tool needed to validate, skip, retry, or complete the mission."
          : "Continue the mission using actual tool calls now. Do not describe tool calls in markdown/code fences.";
      this.queueInternalMessage([
        "RECOVERED TOOL CALLS EXECUTED:",
        "ADE replayed the coordinator's text-formatted mission-control calls through the real tools.",
        resultBlock,
        nextCallGuidance,
      ].join("\n"));
    }
    return handled;
  }

  private buildRuntimePhaseWorkerPrompt(phase: PhaseCard): string {
    const plannerOutput = this.getLatestPlanningResultForPrompt();
    return [
      `Mission goal:\n${this.deps.missionGoal}`,
      `Active phase: ${phase.name} (${phase.phaseKey})`,
      phase.instructions.trim().length > 0
        ? `Phase instructions:\n${phase.instructions.trim()}`
        : null,
      plannerOutput.trim().length > 0
        ? `Planning output to follow:\n${plannerOutput.trim()}`
        : null,
      [
        "Execution protocol:",
        "- Work only in the mission lane worktree.",
        "- Make the concrete code/doc/test changes required by this phase.",
        "- Use the existing project style and package scripts.",
        "- If this phase owns only part of the mission, do not finish the whole mission; report your phase result.",
        "- Before exiting, call report_result with outcome, summary, filesChanged, and testsRun when applicable.",
      ].join("\n"),
    ].filter((section): section is string => Boolean(section)).join("\n\n");
  }

  private async spawnRequiredPhaseWorkerFromRuntime(
    phase: PhaseCard,
    turnId: string,
  ): Promise<boolean> {
    const tool = this.tools.spawn_worker as any;
    if (!tool || typeof tool.execute !== "function") return false;
    const workerName = `${phase.phaseKey.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "") || "phase"}-worker`;
    this.deps.logger.warn("coordinator_agent.active_phase_runtime_worker_spawning", {
      runId: this.deps.runId,
      turnId,
      phaseKey: phase.phaseKey,
      workerName,
    });
    this.deps.onCoordinatorEvent?.({
      type: "status",
      turnStatus: "interrupted",
      turnId,
      message: `The coordinator did not start work for phase "${phase.phaseKey}", so ADE is starting the configured phase worker through mission control.`,
    });
    const result = coerceToolOutputRecord(await tool.execute({
      name: workerName,
      modelId: phase.model?.modelId,
      prompt: this.buildRuntimePhaseWorkerPrompt(phase),
    }));
    this.deps.onCoordinatorEvent?.({
      type: "tool_result",
      tool: "spawn_worker",
      result,
      itemId: `runtime:${turnId}:spawn:${phase.phaseKey}`,
      turnId,
      status: result?.ok === false ? "failed" : "completed",
    });
    if (result?.ok !== true) {
      const transitionSignal = extractPhaseTransitionRequiredSignal(result);
      if (transitionSignal) {
        this.queuePhaseTransitionCorrection(transitionSignal, turnId);
        return true;
      }
      const error = typeof result?.error === "string" ? result.error : `Could not start worker for phase '${phase.phaseKey}'.`;
      this.queueInternalMessage([
        "RUNTIME PHASE WORKER FAILED:",
        error,
        "Correct the phase/task state and continue with real mission-control tools.",
      ].join("\n"));
      return true;
    }
    return true;
  }

  private async enforceActivePhaseProgress(turnId: string): Promise<"ok" | "transitioned" | "worker_started"> {
    const currentPhase = this.resolveCurrentPhaseCardFromRun();
    const currentPhaseKey = currentPhase?.phaseKey.trim() ?? "";
    if (!currentPhase || !currentPhaseKey || currentPhaseKey.toLowerCase() === "planning") return "ok";

    const currentPhaseHasAnyWork = this.phaseHasAnyExecutionStep(currentPhaseKey);
    const currentPhaseHasOpenWork = this.phaseHasOpenExecutionStep(currentPhaseKey);
    if (currentPhaseHasAnyWork || currentPhaseHasOpenWork) {
      const startedSiblingCount = await this.spawnReadySiblingPhaseWorkersFromRuntime(turnId);
      if (startedSiblingCount > 0) return "worker_started";
    }

    if (this.phaseHasSucceededExecutionStep(currentPhaseKey)) {
      const validatedBlockedStep = this.getExecutionStepsForPhase(currentPhaseKey)
        .filter((step) => step.status === "succeeded")
        .find((step) => this.stepRequiredValidationPending(step));
      if (validatedBlockedStep) {
        await this.enforcePendingSelfValidation(turnId);
        return "ok";
      }
      const nextPhase = this.resolveNextPhaseAfter(currentPhaseKey);
      if (!nextPhase) return "ok";
      if (await this.applyRequiredPhaseTransitionFromRuntime({
        phaseKey: nextPhase.phaseKey,
        reason: `${currentPhaseKey}_complete`,
      }, turnId)) {
        return "transitioned";
      }
      return "ok";
    }

    if (!currentPhaseHasAnyWork && !currentPhaseHasOpenWork) {
      if (await this.spawnRequiredPhaseWorkerFromRuntime(currentPhase, turnId)) {
        await this.spawnReadySiblingPhaseWorkersFromRuntime(turnId);
        return "worker_started";
      }
    }
    return "ok";
  }

  private buildRuntimeCompletionSummary(
    graph: ReturnType<CoordinatorAgentDeps["orchestratorService"]["getRunGraph"]>,
  ): string {
    const executionSteps = filterExecutionSteps(graph.steps);
    const completed = executionSteps
      .filter((step) => step.status === "succeeded")
      .sort((a, b) => (b.completedAt ?? b.updatedAt).localeCompare(a.completedAt ?? a.updatedAt));
    for (const step of completed) {
      const report = asRecord(asRecord(step.metadata)?.lastResultReport);
      const summary = typeof report?.summary === "string" ? report.summary.trim() : "";
      if (summary.length > 0) return summary.slice(0, 2000);
    }
    const labels = completed
      .slice(0, 8)
      .map((step) => step.title?.trim() || step.stepKey)
      .filter((entry) => entry.length > 0);
    return labels.length > 0
      ? `All tracked mission work completed: ${labels.join(", ")}.`
      : "All tracked mission work completed.";
  }

  private async enforceMissionCompletionFromRuntime(turnId: string): Promise<"ok" | "completed"> {
    const graph = this.getRunGraphSnapshot();
    if (!graph) return "ok";
    const executionSteps = filterExecutionSteps(graph.steps);
    if (executionSteps.length === 0) return "ok";
    if (executionSteps.some((step) => !TERMINAL_STEP_STATUSES.has(step.status))) return "ok";
    const pendingValidation = executionSteps.some((step) =>
      step.status === "succeeded" && this.stepRequiredValidationPending(step)
    );
    if (pendingValidation) return "ok";

    const currentPhase = this.resolveCurrentPhaseCardFromRun();
    const currentPhaseKey = currentPhase?.phaseKey.trim() ?? "";
    const currentPhaseName = currentPhase?.name.trim().toLowerCase() ?? "";
    if (currentPhaseKey.toLowerCase() === "planning" || currentPhaseName === "planning") return "ok";
    if (currentPhaseKey.length > 0 && this.resolveNextPhaseAfter(currentPhaseKey)) return "ok";

    const tool = this.tools.complete_mission as any;
    if (!tool || typeof tool.execute !== "function") return "ok";
    const summary = this.buildRuntimeCompletionSummary(graph);
    this.deps.logger.warn("coordinator_agent.runtime_completion_applying", {
      runId: this.deps.runId,
      turnId,
      stepCount: executionSteps.length,
    });
    this.deps.onCoordinatorEvent?.({
      type: "tool_call",
      tool: "complete_mission",
      args: { summary },
      itemId: `runtime:${turnId}:complete-mission`,
      turnId,
    });
    const output = await tool.execute({ summary });
    const result = coerceToolOutputRecord(output);
    this.deps.onCoordinatorEvent?.({
      type: "tool_result",
      tool: "complete_mission",
      result: output,
      itemId: `runtime:${turnId}:complete-mission`,
      turnId,
      status: result?.ok === false ? "failed" : "completed",
    });
    if (result?.ok === true) {
      return "completed";
    }
    const error = typeof result?.error === "string" && result.error.trim().length > 0
      ? result.error.trim()
      : "complete_mission did not finalize the run.";
    this.queueInternalMessage([
      "MISSION COMPLETION BLOCKED:",
      error,
      "Inspect the reported blockers, add or validate any missing work, then call complete_mission again.",
    ].join("\n"));
    return "ok";
  }

  private async enforcePostPlanningPhaseTransition(turnId: string): Promise<"ok" | "retry_scheduled" | "transitioned"> {
    const signal = this.resolvePostPlanningPhaseTransitionRequired();
    if (!signal) return "ok";
    const phaseKey = signal.phaseKey.trim();
    const correctionCount = this.phaseTransitionCorrectionCounts.get(phaseKey) ?? 0;
    if (correctionCount < POST_PLANNING_PHASE_TRANSITION_RETRY_LIMIT) {
      this.deps.logger.warn("coordinator_agent.post_planning_phase_watchdog_triggered", {
        runId: this.deps.runId,
        turnId,
        phaseKey,
        reason: "planning_completed_but_phase_not_advanced",
      });
      this.queuePhaseTransitionCorrection(signal, turnId);
      return "retry_scheduled";
    }
    if (await this.applyRequiredPhaseTransitionFromRuntime(signal, turnId)) {
      return "transitioned";
    }
    this.queuePhaseTransitionCorrection(signal, turnId);
    return "retry_scheduled";
  }

  private async enforcePlanningFirstTurnDelegation(turnId: string): Promise<"ok" | "retry_scheduled" | "planner_started"> {
    if (this.turnCount > this.planningStartupRetryCount) return "ok";
    if (!this.isPlanningFirstPhaseRun()) return "ok";
    if (this.hasPlanningExecutionRecord()) return "ok";
    if (this.hasOpenPlanningClarification()) return "ok";

    this.deps.logger.warn("coordinator_agent.planning_watchdog_triggered", {
      runId: this.deps.runId,
      turnId,
      reason: "first_turn_did_not_spawn_planner",
    });
    if (this.planningStartupRetryCount < PLANNING_STARTUP_RETRY_LIMIT) {
      this.planningStartupRetryCount += 1;
      this.planningStartupState = "awaiting_project_context";
      if (this.pendingPlannerDelegationContract) {
        this.pendingPlannerDelegationContract = updateDelegationContract(this.pendingPlannerDelegationContract, {
          status: "launching",
          launchState: "awaiting_context",
          failure: {
            category: "unknown",
            reasonCode: "planner_not_started_retry_scheduled",
            retryable: true,
            recoveryOptions: ["retry", "cancel_run"],
            message: "The coordinator did not create the planning worker on the first attempt, so ADE is retrying the startup turn once.",
            toolName: null,
            retryCount: this.planningStartupRetryCount,
            occurredAt: new Date().toISOString(),
          },
        });
        this.emitDelegationState(
          this.pendingPlannerDelegationContract,
          "The coordinator did not start the planner, so I’m retrying the startup turn once.",
        );
      }
      this.updatePlannerLaunchTrackerStep({
        status: "pending",
        reason: "planner_not_started_retry_scheduled",
        detail: {
          retryCount: this.planningStartupRetryCount,
        },
      });
      this.deps.onCoordinatorEvent?.({
        type: "status",
        turnStatus: "interrupted",
        turnId,
        message: "The coordinator did not start the planner, so I’m retrying the startup turn once.",
      });
      this.queueInternalMessage([
        "PLANNING STARTUP RETRY REQUIRED:",
        "Your previous response did not create the required planning worker.",
        "Your next response must use ADE mission-control tools only.",
        "Call get_project_context first, then call spawn_worker exactly once to launch the read-only planning worker.",
        "Use get_project_context and spawn_worker directly, or with an ade_ prefix if ADE asks for one.",
        "Do not answer with text, do not use native OpenCode tools, and do not do coordinator-side analysis before the planner is running.",
      ].join("\n"));
      return "retry_scheduled";
    }

    if (await this.launchRequiredPlanningWorkerFromRuntime(turnId)) {
      return "planner_started";
    }
    this.deps.onCoordinatorEvent?.({
      type: "error",
      turnId,
      message:
        "Coordinator first turn did not create the planning worker. ADE stopped planning and opened an explicit failure instead of silently spawning a replacement planner.",
    });
    const failure: CoordinatorPlanningStartupFailure = {
      category: "unknown",
      reasonCode: "planner_not_started",
      interventionType: "failed_step",
      retryable: false,
      recoveryOptions: ["retry", "cancel_run"],
      message: "The coordinator did not spawn the required planning worker on its first turn.",
      title: "Planner was never started",
      body: "The coordinator did not spawn the required planning worker on its first turn, so ADE stopped instead of silently starting a replacement planner.",
      requestedAction: "Decide whether to retry planning explicitly or cancel this run.",
      toolName: null,
      retryCount: this.planningStartupRetryCount,
    };
    this.handlePlanningStartupFailure(failure);
    throw new CoordinatorFatalError("Planning watchdog stopped the run because the planner was never started.");
  }

  private async runTurn(): Promise<void> {
    const runtimeKind = this.deps.agentChatService ? "agent_chat" : "opencode";
    if (!this.deps.agentChatService && !this.usesOpenCodeCoordinatorRuntime()) {
      throw new CoordinatorFatalError(
        `Coordinator model '${this.deps.modelId}' is not supported by the provider-owned runtime.`,
      );
    }
    const abortController = new AbortController();
    this.activeAbortController = abortController;
    const timeoutHandle = setTimeout(() => abortController.abort(), COORDINATOR_TURN_TIMEOUT_MS);
    let awaitingBlockingUserInput = false;
    let planningStartupAbortMode: "none" | "planner_started" | "retry" | "failed" = "none";
    let planningStartupFailure: CoordinatorPlanningStartupFailure | null = null;

    this.deps.logger.info("coordinator_agent.turn_started", {
      runId: this.deps.runId,
      modelId: this.deps.modelId,
      runtime: runtimeKind,
      historyLength: this.conversationHistory.length,
      timeoutMs: COORDINATOR_TURN_TIMEOUT_MS,
    });
    const turnId = `coord-turn-${this.turnCount + 1}`;
    this.deps.onCoordinatorEvent?.({
      type: "status",
      turnStatus: "started",
      turnId,
    });

    try {
      const runtimeResult = this.deps.agentChatService
        ? await this.runChatRuntimeTurn(turnId, abortController)
        : await this.runOpenCodeTurn(turnId, abortController);
      const assistantText = runtimeResult.assistantText;
      const sawStreamPart = runtimeResult.sawStreamPart;
      const streamedStepCount = runtimeResult.streamedStepCount;
      const executedToolCount = runtimeResult.executedToolCount;
      awaitingBlockingUserInput = runtimeResult.awaitingBlockingUserInput;
      planningStartupAbortMode = runtimeResult.planningStartupAbortMode;
      planningStartupFailure = runtimeResult.planningStartupFailure;
      const phaseTransitionRequired = runtimeResult.phaseTransitionRequired;

      if (planningStartupAbortMode === "planner_started") {
        this.deps.logger.info("coordinator_agent.planner_started_waiting", {
          runId: this.deps.runId,
        });
        return;
      }
      if (planningStartupAbortMode === "retry") {
        this.deps.logger.info("coordinator_agent.planner_launch_retry_scheduled", {
          runId: this.deps.runId,
          retryCount: this.planningStartupRetryCount,
          error: planningStartupFailure?.message ?? null,
        });
        return;
      }
      if (planningStartupAbortMode === "failed") {
        throw new CoordinatorFatalError(planningStartupFailure?.message ?? "Planner launch failed during planning startup.");
      }
      if (awaitingBlockingUserInput) {
        this.deps.onCoordinatorEvent?.({
          type: "status",
          turnStatus: "interrupted",
          turnId,
        });
        this.deps.logger.info("coordinator_agent.turn_waiting_on_user", {
          runId: this.deps.runId,
          modelId: this.deps.modelId,
          turnId,
        });
        return;
      }

      const assistantReplyFailure = this.buildAssistantReplyRuntimeFailure(
        assistantText,
        turnId,
        streamedStepCount,
      );
      if (assistantReplyFailure) {
        throw new CoordinatorFatalError(assistantReplyFailure.message, assistantReplyFailure);
      }

      if (executedToolCount === 0) {
        const recoveredToolCount = await this.executeRecoveredCoordinatorToolCalls(assistantText, turnId);
        if (recoveredToolCount > 0) {
          if (assistantText.trim()) {
            this.conversationHistory.push({ role: "assistant", content: assistantText });
          }
          const planningStartupEnforcement = await this.enforcePlanningFirstTurnDelegation(turnId);
          if (planningStartupEnforcement !== "ok") {
            return;
          }
          return;
        }
      }

      const planningStartupEnforcement = await this.enforcePlanningFirstTurnDelegation(turnId);
      if (planningStartupEnforcement === "retry_scheduled") {
        return;
      }
      if (planningStartupEnforcement === "planner_started") {
        return;
      }

      if (assistantText.trim()) {
        this.conversationHistory.push({ role: "assistant", content: assistantText });
      }

      // Notify the facade about coordinator messages (for chat display)
      if (assistantText.trim() && this.deps.onCoordinatorMessage) {
        this.deps.onCoordinatorMessage(assistantText.trim());
      }
      this.deps.onCoordinatorEvent?.({
        type: "done",
        turnId,
        status: "completed",
        modelId: this.deps.modelId as any,
      });

      this.deps.logger.info("coordinator_agent.turn_completed", {
        runId: this.deps.runId,
        modelId: this.deps.modelId,
        runtime: runtimeKind,
        sawStreamPart,
        assistantTextLength: assistantText.trim().length,
      });
      if (phaseTransitionRequired) {
        this.queuePhaseTransitionCorrection(phaseTransitionRequired, turnId);
        return;
      }
      const selfValidation = await this.enforcePendingSelfValidation(turnId);
      if (selfValidation !== "ok") {
        return;
      }
      const postPlanningPhaseTransition = await this.enforcePostPlanningPhaseTransition(turnId);
      if (postPlanningPhaseTransition !== "ok") {
        return;
      }
      const activePhaseProgress = await this.enforceActivePhaseProgress(turnId);
      if (activePhaseProgress !== "ok") {
        return;
      }
      const missionCompletion = await this.enforceMissionCompletionFromRuntime(turnId);
      if (missionCompletion !== "ok") {
        return;
      }
    } catch (error) {
      const aborted = abortController.signal.aborted;
      if (aborted && awaitingBlockingUserInput) {
        this.deps.onCoordinatorEvent?.({
          type: "status",
          turnStatus: "interrupted",
          turnId,
        });
        this.deps.logger.info("coordinator_agent.turn_waiting_on_user", {
          runId: this.deps.runId,
          modelId: this.deps.modelId,
          turnId,
        });
        return;
      }
      if (aborted && planningStartupAbortMode === "planner_started") {
        this.deps.logger.info("coordinator_agent.turn_waiting_on_planner", {
          runId: this.deps.runId,
          turnId,
        });
        return;
      }
      if (aborted && planningStartupAbortMode === "retry") {
        this.deps.logger.info("coordinator_agent.turn_restarted_for_planner_retry", {
          runId: this.deps.runId,
          turnId,
          retryCount: this.planningStartupRetryCount,
        });
        return;
      }
      if (aborted && planningStartupAbortMode === "failed") {
        throw new CoordinatorFatalError(planningStartupFailure?.message ?? "Planner launch failed during planning startup.");
      }
      this.deps.onCoordinatorEvent?.({
        type: "status",
        turnStatus: aborted ? "interrupted" : "failed",
        turnId,
      });
      this.deps.onCoordinatorEvent?.({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
        turnId,
      });
      this.deps.logger.warn("coordinator_agent.turn_failed", {
        runId: this.deps.runId,
        modelId: this.deps.modelId,
        runtime: runtimeKind,
        timeoutMs: COORDINATOR_TURN_TIMEOUT_MS,
        aborted,
        error: error instanceof Error ? error.message : String(error),
      });
      if (error instanceof CoordinatorFatalError) {
        if (!aborted && error.runtimeFailure) {
          this.shutdown();
          this.deps.onCoordinatorRuntimeFailure?.(error.runtimeFailure);
        }
        throw error;
      }
      if (!aborted) {
        const runtimeFailure = this.buildCoordinatorRuntimeFailure(error, turnId);
        this.shutdown();
        this.deps.onCoordinatorRuntimeFailure?.(runtimeFailure);
        throw new CoordinatorFatalError(runtimeFailure.message, runtimeFailure);
      }
      throw error;
    } finally {
      this.openCodeHandle?.setBusy(false);
      this.touchOpenCodeCoordinatorSession();
      if (this.activeAbortController === abortController) {
        this.activeAbortController = null;
      }
      clearTimeout(timeoutHandle);
    }
  }

  // ─── Compaction ──────────────────────────────────────────────────

  private async compactHistory(): Promise<void> {
    try {
      if (!this.deps.aiIntegrationService) {
        this.deps.logger.warn("coordinator.compaction_skipped", {
          runId: this.deps.runId,
          reason: "missing_ai_integration_service",
        });
        return;
      }

      const now = Date.now();
      const count = this.conversationHistory.length;
      const entries: TranscriptEntry[] = this.conversationHistory.map(
        (m, i) => ({
          role: m.role as "user" | "assistant",
          content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
          timestamp: new Date(now - (count - 1 - i) * 1000).toISOString(),
        }),
      );

      const result = await compactConversation({
        messages: entries,
        modelId: this.deps.modelId,
        aiIntegrationService: this.deps.aiIntegrationService,
      });

      const stateDoc = await readMissionStateDocument({
        projectRoot: this.deps.projectRoot,
        runId: this.deps.runId,
      });

      const serializedState =
        stateDoc
          ? JSON.stringify(stateDoc, null, 2)
          : JSON.stringify(
              {
                schemaVersion: 1,
                runId: this.deps.runId,
                note: "Mission state document is not available yet."
              },
              null,
              2
            );

      this.conversationHistory = [
        {
          role: "user",
          content: [
            `[CONTEXT COMPACTION]`,
            `Original mission: ${this.deps.missionGoal}`,
            ``,
            `Previous conversation summary:`,
            result.summary,
            ``,
            `Current mission state (structured, authoritative):`,
            serializedState,
            ``,
            `The mission state document above is the source of truth for what has been`,
            `completed, what decisions were made, and what issues are active. Use it to`,
            `orient yourself after this context compaction.`,
            ``,
            `Continue managing the mission.`
          ].join("\n"),
        },
      ];

      this.compactionCount += 1;
      this.saveCheckpoint("compaction");

      this.deps.logger.info("coordinator_agent.compaction_complete", {
        runId: this.deps.runId,
        previousTokens: result.previousTokenCount,
        newTokens: result.newTokenCount,
        factsExtracted: result.factsExtracted.length,
      });
    } catch (err) {
      this.deps.logger.debug("coordinator_agent.compaction_failed", {
        runId: this.deps.runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ─── System Prompt ───────────────────────────────────────────────

  private buildSystemPrompt(): string {
    const rules = this.deps.userRules;
    const ctx = this.deps.projectContext;
    const providers = this.deps.availableProviders;

    // Build user rules section (includes budget/recovery/PR/model constraints)
    let rulesSection = "";
    if (rules) {
      const ruleLines: string[] = [];
      if (rules.providerPreference) ruleLines.push(`- Provider preference: ${rules.providerPreference}`);
      if (rules.costMode) ruleLines.push(`- Cost mode: ${rules.costMode}`);
      if (rules.maxParallelWorkers != null) ruleLines.push(`- Maximum parallel workers: ${rules.maxParallelWorkers}`);
      if (rules.allowParallelAgents != null) ruleLines.push(`- Parallel agents: ${rules.allowParallelAgents ? "enabled" : "disabled (run work sequentially)"}`);
      if (rules.allowSubAgents != null) ruleLines.push(`- Sub-agents: ${rules.allowSubAgents ? "enabled" : "disabled (do not use nested delegation)"}`);
      if (rules.allowClaudeAgentTeams != null) ruleLines.push(`- Claude native agent teams: ${rules.allowClaudeAgentTeams ? "enabled" : "disabled"}`);
      if (rules.laneStrategy) ruleLines.push(`- Lane strategy: ${rules.laneStrategy}`);
      if (rules.customInstructions) ruleLines.push(`- Custom instructions: ${rules.customInstructions}`);
      if (rules.coordinatorModel) ruleLines.push(`- Coordinator model: ${rules.coordinatorModel} (your model — user selected this, do not change)`);
      if (rules.closeoutContract) ruleLines.push(`- Closeout contract: ${rules.closeoutContract}`);
      if (rules.budgetLimitUsd != null) ruleLines.push(`- Budget limit: $${rules.budgetLimitUsd.toFixed(2)} USD (HARD LIMIT — do not exceed)`);
      if (rules.budgetLimitTokens != null) ruleLines.push(`- Token budget limit: ${rules.budgetLimitTokens.toLocaleString()} tokens (HARD LIMIT)`);
      if (rules.recoveryEnabled != null) ruleLines.push(`- Recovery loops: ${rules.recoveryEnabled ? `enabled (max ${rules.recoveryMaxIterations ?? 3} iterations)` : "disabled — do not retry failed quality gates"}`);
      if (ruleLines.length > 0) {
        rulesSection = `\n## Rules (from user configuration — MUST follow)\nThese settings were chosen by the user. You operate WITHIN these boundaries.\n${ruleLines.join("\n")}`;
      }
    }

    // Build phases section — user-defined guardrails on WHAT work happens
    let phasesSection = "";
    const phases = this.deps.phases;
    const sortedPhases = phases && phases.length > 0
      ? [...phases].sort((a, b) => a.position - b.position)
      : [];
    const planningPhaseIndex = sortedPhases.findIndex((phase) => phase.phaseKey.trim().toLowerCase() === "planning");
    const firstPostPlanningPhase = sortedPhases.find((phase, index) =>
      index > planningPhaseIndex && phase.phaseKey.trim().toLowerCase() !== "planning"
    ) ?? sortedPhases.find((phase) => phase.phaseKey.trim().toLowerCase() !== "planning") ?? null;
    const firstPostPlanningPhaseKey = firstPostPlanningPhase?.phaseKey.trim() || "development";
    const firstPostPlanningPhaseName = firstPostPlanningPhase?.name.trim() || "Development";
    const missionPromptForPlanningPolicy = this.missionPromptForPlanningPolicy();
    if (sortedPhases.length > 0) {
      const phaseLines = sortedPhases
        .map((p, i) => {
          const parts: string[] = [];
          const customTag = p.isCustom ? "[CUSTOM] " : "";
          parts.push(`${i + 1}. ${customTag}${p.name.toUpperCase()} (model: ${p.model.modelId})`);
          if (p.description) parts.push(`   Description: ${p.description}`);
          if (p.instructions) parts.push(`   Instructions: ${p.instructions}`);
          if (p.validationGate.tier !== "none") parts.push(`   Validation: ${p.validationGate.tier.replace("-", " ")} ${p.validationGate.required ? "(required)" : "(optional)"}`);
          if (p.askQuestions.enabled) {
            const requiredBeforeExit = phaseRequiresPlanningQuestionBeforeExit({
              phase: p,
              missionPrompt: missionPromptForPlanningPolicy,
            });
            const requiredText = requiredBeforeExit
              ? "must ask at least one blocking question before finalizing this phase"
              : "may ask clarification questions when needed";
            parts.push(
              `   Ask Questions: enabled (${requiredText}${p.askQuestions.maxQuestions == null ? ", unlimited follow-up rounds allowed" : `, max ${Math.max(0, Math.min(10, Number.isFinite(Number(p.askQuestions.maxQuestions)) ? Number(p.askQuestions.maxQuestions) : 5))} questions`})`
            );
          } else {
            parts.push("   Ask Questions: disabled");
          }
          if (p.orderingConstraints.mustBeFirst) parts.push(`   Ordering: must be first`);
          if (p.orderingConstraints.mustBeLast) parts.push(`   Ordering: must be last`);
          if (p.orderingConstraints.canLoop) parts.push(`   Loop: can repeat${p.orderingConstraints.loopTarget ? ` (back to ${p.orderingConstraints.loopTarget})` : ""}`);
          return parts.join("\n");
        });
      phasesSection = `\n## Mission Phases (execute in order)\nThese phases define WHAT work happens. You decide HOW — how many workers, what prompts, what approach.\nQuestion rules per phase govern the ACTIVE PHASE OWNER for that phase:
- If Ask Questions is enabled, the worker actively executing that phase may open blocking clarification questions through ADE's inline question UI when needed.
- If the Planning phase says questions are required before exit, the planning worker must open a blocking ADE question before returning a successful plan.
- Additional question rounds are allowed up to the phase max question limit, or without a cap when the planning phase is explicitly configured for unlimited clarifications. Avoid trivial or low-value questions.
- If Ask Questions is disabled, do not ask questions in that phase; proceed with reasonable assumptions.
- The question tool is transport/UI plumbing, not ownership. Coordinator should not ask planning, development, or validation questions on behalf of a worker unless there is no responsible phase worker yet and the mission cannot even be framed.
- When asking, bundle ALL related questions into a single call/card. Use structured questions with optional multiple-choice options, context, default assumptions, and impact descriptions.\n${phaseLines.join("\n")}`;
    }

    // Build planning phase guidance
    let planningPhaseSection = "";
    if (sortedPhases.some(p => p.phaseKey === "planning")) {
      planningPhaseSection = `\n## Planning Startup Contract (hard gate)
The first coordinator turn of a mission whose first phase is Planning must create the planner through ADE mission-control tools:
- Do not reply with text only on the first turn.
- First call get_project_context, using the ade_ prefix only if ADE asks for it.
- Then call spawn_worker exactly once, using the ade_ prefix only if needed.
- The planning worker must be read-only, must receive the full mission goal and planning phase instructions, and must return the plan through the runtime result channel (report_result for tracked mission workers, final ### report_result for managed ADE chat workers).
- Do not call native OpenCode repo/search/shell/web/planner tools before the planner exists. Runtime pauses the run on those startup violations.

## Planning Phase Protocol
When you enter the Planning phase (your first phase), follow this protocol:
1. IF the Planning phase has askQuestions enabled:
   - Spawn the planning worker first. The planner owns planning clarification.
   - If the planner needs clarification, it should use its ADE question UI itself, then stop. Do NOT ask planning questions on the planner's behalf just because a question tool exists.
   - While a planner-owned question is open, do not spawn additional planning workers or continue planning actions.
2. Start the Planning phase immediately:
   - Your first turn must be: get_project_context, then spawn ONE planning worker.
   - Do NOT spend the first turn doing coordinator-side repo exploration, shell work, or file-by-file analysis.
   - Before the planner starts, avoid read_file/search_files unless the mission explicitly names a specific file or integration point that materially changes the planner brief.
3. Spawn ONE planning worker with a rich research prompt that includes the full mission goal and the planning phase instructions
   - The planning prompt must ask the worker to DISCOVER the plan.
   - Do NOT hand the planning worker a pre-written implementation plan, exact edit list, commit message, or "confirm this plan" instructions.
4. The planning worker should have READ-ONLY focus \u2014 its job is to research the codebase, not write code
5. Wait for the planning worker to complete, then read its output via get_worker_output
6. After reading the planner output, call memory_search with 2-3 key terms from the mission goal. This surfaces past gotchas, architectural decisions, and repeatable patterns the planner may not have known about. One quick search is enough — do not delay. Incorporate any relevant results into the worker briefs you write in step 9.
7. Do NOT create a separate display-only planning task for the planner itself. The planning worker IS the planning phase execution record.
8. After the planning worker finishes, call set_current_phase with phaseKey "${firstPostPlanningPhaseKey}" before creating implementation tasks or spawning code-changing workers.
9. Once you are in ${firstPostPlanningPhaseName}, use the research findings to build the implementation DAG via create_task:
   - Create tasks with proper dependsOn relationships reflecting real code dependencies
   - Set parallelism based on the planner\u2019s analysis of independent workstreams
   - Each task should be scoped for ONE worker in ONE session
   - The DAG is visible to the user in real-time \u2014 structure it clearly
   - create_task is for user-visible implementation work breakdown, not for the planning worker itself.
   - When you later spawn_worker, dependsOn should reference EXECUTABLE prerequisite workers, not just display-only task cards
10. Never spawn a code-changing worker while the run is still in the Planning phase. Planning workers must stay read-only; transition phases first.
11. Then begin execution in the configured phase order (spawn workers, delegate tasks, and continue phase-by-phase).

If the Planning phase is NOT in your phase list, skip straight to building tasks from the mission prompt and your own codebase analysis.`;
    }

    // Build available workers section
    let workersSection = `\n## Available Workers
You can spawn these types of workers:
- Provider worker (tool: spawn_worker) — choose model per worker with \`modelId\`; CLI models run as tracked subprocess sessions and API/local models run as bounded in-process workers.
- Prefer CLI workers when you expect follow-up steering, mid-flight messaging, or iterative back-and-forth.
- Prefer API/local workers for bounded one-shot tasks that can succeed from a single prompt without live coordination.`;
    if (providers?.length) {
      const available = providers.filter((p) => p.available).map((p) => p.name);
      if (available.length > 0) {
        workersSection += `\n\nCurrently available providers: ${available.join(", ")}`;
      }
    }

    // Build project context section
    let projectSection = "";
    if (ctx) {
      projectSection = `\n## Project Context\nProject root: ${ctx.projectRoot}`;
      if (ctx.projectDocPaths && ctx.projectDocPaths.length > 0) {
        projectSection += "\n\nLikely project docs (read these directly if relevant):";
        for (const docPath of ctx.projectDocPaths.slice(0, 40)) {
          projectSection += `\n- ${docPath}`;
        }
      }
      if (ctx.projectKnowledge && ctx.projectKnowledge.length > 0) {
        projectSection += "\n\nProject memory highlights:";
        for (const line of ctx.projectKnowledge.slice(0, 12)) {
          projectSection += `\n- ${line}`;
        }
      }
      if (ctx.fileTree) {
        projectSection += `\n\nFile structure:\n${ctx.fileTree}`;
      }
    }

    return `You are ADE's mission lead for a software engineering mission. You have a team of AI workers you can spawn, steer, and shut down through ADE's mission-control tools. You receive a mission from the user. You deliver the completed mission. Everything in between is your job.

## Your Role

You are the persistent brain. Workers are disposable hands.

Your conversation persists across the entire mission — you accumulate context, track what's been tried, remember what failed and why. Workers get fresh sessions with a clean prompt, do their assigned work, and shut down. You are the continuity. When a worker dies, its work product remains in the codebase but its context is gone — YOUR context is what carries the mission forward.

You are NOT a repo-editing worker. You are the mission lead who owns phase state, worker spawning, runtime judgment, and final completion. In normal operation, workers inspect the repo, edit code, and run commands. You keep the mission aligned and delegated. The difference between you and a dumb orchestrator is that you THINK before you act and EVALUATE after each step.

## Your Mission
${this.deps.missionGoal}

Run ID: ${this.deps.runId}
Mission ID: ${this.deps.missionId}
${rulesSection}

## Enforcement & Constraints

### Phase Ordering
Phase ordering is enforced by spawn_worker — if it rejects a spawn due to phase ordering violations, adapt your plan to respect the configured phase sequence. Do not attempt to bypass phase gates.

### Validation Tiers
Validation is a runtime contract, not advisory behavior:
- Runtime enforces required validation gates and phase transitions.
- Dedicated required validation is auto-spawned by runtime; do not try to simulate sampling behavior.
- If validation is missing, runtime will block progression and emit explicit contract-unfulfilled events.
- For self-check phases, you must still evaluate output and call report_validation with a verdict.

### Sub-Agent Delegation
Use delegate_to_subagent when a parent worker's task naturally decomposes into child subtasks that benefit from parallel execution under the same parent context. Use spawn_worker for independent top-level work. delegate_to_subagent creates a dependency on the parent and inherits its lane.
Use delegate_parallel to spawn a batch of sibling child tasks under one parent in a single call. Use it when N subtasks are known upfront and can run concurrently in that parent's lane.
Do not use delegate_parallel for separate-lane workstreams; first call provision_lane for each separate lane, then call spawn_worker with the returned laneId for each top-level worker.
Sub-agent status updates and completion summaries are automatically pushed back to the parent worker context. Do not poll get_worker_output just to check heartbeat/progress.

### Hard Constraints
These flags are enforced deterministically by the tools — violations are rejected, not warned:
- **allowParallelAgents**: When false, spawn workers sequentially (one at a time).
- **allowSubAgents**: When false, delegate_to_subagent is disabled. Use spawn_worker instead.
- **allowClaudeAgentTeams**: When false, Claude CLI-native sub-agent patterns are blocked.

### Approval Model
- Mission runs do NOT use provider-native approval prompts. Do not rely on ExitPlanMode or any out-of-band provider approval flow.
- If you need user input, use ADE's question UI during Planning only. Outside Planning, continue with the best reasonable assumption unless runtime opens its own intervention.
${phasesSection}${planningPhaseSection}
${workersSection}
${projectSection}

## Autonomy Boundaries

You are autonomous WITHIN user-configured settings. This means:

**You DECIDE (tactical autonomy):**
- Task decomposition and dependency ordering
- Worker prompts and instructions
- Retry strategy when things fail
- Parallelism level (within configured limits)
- Quality judgment — is a worker's output good enough?
- Course correction — when to change approach
- When to escalate to the user vs. handle it yourself

**You FOLLOW (user constraints — never override):**
- Which execution phases are enabled (development, testing, validation, code review) — skip disabled phases, run enabled ones
- Model selection — use the configured coordinator and worker models
- Closeout contract — finish with a single result lane that contains the consolidated mission changes; use ADE's internal integration lane when multiple worker lanes must be joined
- Budget limits — hard caps on cost/tokens are guardrails, not suggestions
- Model selection — use available model IDs as configured
- Thinking budgets / reasoning effort — respect per-model settings

If the user disabled testing, do NOT spawn test workers. If the user set a specific worker model, use THAT model. Do not open or land external GitHub PRs during mission closeout. You decide HOW to accomplish the mission — the user decides WHAT constraints you operate under.

## Scope Awareness — Right-Size Your Approach

Match your approach to the mission's actual complexity:

**ONE worker suffices when:**
- Task touches fewer than 20 files that are logically connected
- Changes are sequential (each depends on the previous)
- Total context fits comfortably in a single agent session
- No file-level conflicts possible between parallel edits
- Planner signals low complexity, low uncertainty, and little meaningful parallelism

**MULTIPLE workers when:**
- Genuinely independent workstreams exist (e.g., frontend + backend + tests)
- Different expertise needed (e.g., DB migration + API changes + UI updates)
- Context would overflow a single agent's window
- Work can meaningfully proceed in parallel without coordination overhead

**Same-lane parallelism (workers share one worktree):**
- Use when parallel tasks touch NON-OVERLAPPING files
- Workers can edit different files concurrently in the same worktree
- Commits must be serialized — only one worker commits at a time
- If ANY file overlap is possible, use separate lanes instead

**Separate lanes (each worker gets its own worktree):**
- Use when tasks might touch overlapping files
- Use for large, isolated workstreams that benefit from clean git history
- Each lane is a fresh git worktree branching from the base — cheap to create
- Lanes merge back into a single mission result lane during closeout

Do NOT overcomplicate simple tasks. A one-file bug fix does not need 3 workers, 5 milestones, and a validation gate. If planning is enabled and the task is tiny, default to one planning worker, one implementation worker on the mission lane, and one validator only if validation is enabled or the change is genuinely risky. Read the code, understand the scope, and scale your approach accordingly. The overhead of coordination should never exceed the cost of the work itself.

## Lane Management Rules

**CRITICAL: Never assign workers to the base lane.** All mission work happens in mission-created lanes.

When the mission starts, a primary mission lane is automatically created for you. Use it for:
- Sequential tasks that build on each other
- Simple missions that don't need parallelism

For parallel workstreams, create additional lanes with \`provision_lane\`:
- Group sequential tasks into shared lanes
- Create separate lanes for independent workstreams that might touch overlapping files
- Same-lane parallelism is allowed when workers touch non-overlapping files
- When you provision a separate lane, pass that laneId into spawn_worker so the worker actually runs in the intended lane

After workers complete, use \`get_worker_output\` to check which files were modified.

## How You Work

### 1. Understand Before Planning
Before creating a single task, build your own understanding:
- If Planning is enabled, do only the minimum coordinator-side prep needed to brief the planning worker.
- Required startup behavior in Planning is: call get_project_context, then spawn the planner immediately.
- Do NOT use the coordinator for a mini research pass before the planner starts.
- Only use read_file/search_files before planner spawn when the mission explicitly points at a specific file, path, or integration hotspot that would materially improve the planning brief.
- Identify the key unknowns, constraints, and hotspots the planner should investigate.
- Do NOT do deep repo research, exact implementation scoping, or file-by-file edit planning while still in Planning. That belongs to the planning worker.
- Once the planner returns, use its findings to build the implementation DAG and write precise worker prompts.
- If Planning is disabled, then you must do the codebase analysis yourself before spawning implementation workers.

### 2. Decompose Into Tasks With Dependencies
Break the mission into tasks that represent real work units:
- Use create_task to build a visible DAG with dependency ordering
- Group tasks into logical milestones — validate at each milestone before proceeding
- Identify which tasks are truly independent (can run in parallel) vs. which must be serial
- Each task should be scoped so ONE worker can complete it in ONE session

### 3. Spawn Workers With Rich Context
Each worker gets a fresh session with no prior knowledge. Your prompt IS their entire world:
- Be SPECIFIC: file paths, function names, exact changes needed, patterns to follow
- Provide CONTEXT: why this change matters, how it fits the mission, what other workers are doing
- Define DONE: what files should change, what tests should pass, what "complete" looks like
- Warn about PITFALLS: things you've learned from previous workers or from reading the code
- Set dependsOn so workers don't start until their prerequisites are met

Workers are disposable — they do their job and shut down. Don't expect them to know anything you haven't told them.

### 4. Monitor, Evaluate, Decide
This is where you earn your keep. When a worker completes:
- Call get_worker_output to read what it produced
- EVALUATE the output yourself — does it meet the acceptance criteria you defined?
- If the work is solid: mark_step_complete and move to the next task
- If the work is poor: mark_step_failed, then DECIDE — retry with better instructions? Spawn a different approach? Skip if non-critical?
- For critical milestones, spawn a dedicated validator worker to review accumulated changes
- Never use stop_worker as a cleanup step after reading output. stop_worker is destructive and cancels the attempt.

When a worker is running:
- If get_worker_output says the worker is still running, that is NOT a completion signal. Wait, steer it with send_message, or let it finish on its own.
- Do NOT busy-poll running workers. After spawning a worker, give it breathing room; avoid repeated get_worker_output calls more than roughly every 15-20 seconds unless a fresh runtime event suggests something changed.
- Planning/research workers may stay quiet for a while before they report back. Do not cancel a planning worker solely because its terminal output is quiet.
- If events suggest it's drifting, use send_message to course-correct in real time
- Always check send_message/message_worker/broadcast response fields (delivered, method, reason) before assuming a worker saw your guidance
- method: "steer" with delivered: false means the message is queued and will only be seen after the worker's current turn completes
- Only use stop_worker when you are intentionally ABANDONING the current attempt because it is stuck, looping, or irrecoverably off-track. Do not use stop_worker for normal completion.
- If it's stuck or going in circles, stop_worker with an explicit cancellation reason and then spawn a replacement with better context
- Use read_mission_status to get the full DAG picture before making decisions

### 5. Handle Failures Like a Senior Engineer
When a worker fails:
1. Read the error with get_worker_output — understand what actually went wrong
2. Simple mistake (wrong path, missing import)? retry_step with the specific fix
3. Wrong approach? Spawn a NEW worker with a fundamentally different strategy
4. Missing prerequisite? Reorder — handle the prerequisite first, then retry
5. Same task failed 3 times? STOP. Change your entire approach or escalate to the user
6. Never leave a failure unaddressed. Diagnose and act in the same turn.

When you retry, always tell the worker: what was tried before, why it failed, and what to do differently. Workers start cold — they don't know about previous attempts unless you tell them.

### 6. Course-Correct the Plan
Your initial plan is a hypothesis. Adjust it as you learn:
- If a worker's output reveals your plan has a flaw, use revise_plan to restructure
- If two workers are producing conflicting changes, stop one and clarify ownership
- Be willing to abandon sunk work — a bad approach at 80% is worse than a good approach at 0%
- When using revise_plan, always provide explicit dependencyPatches — the runtime will NOT auto-rewire dependencies

### 6.5 Persist Mission Memory
Quality bar: "Would a developer joining this project find this useful on their first day?" If not, do not save it.

ALWAYS save (memory_add) when you:
- Discover a convention that is NOT documented anywhere in the codebase or docs
- Make or observe a decision with non-obvious reasoning (e.g., "chose X over Y because Z")
- Hit a pitfall that other developers or future missions would hit too
- Find a pattern that contradicts what the code structure would suggest

DO NOT save:
- File paths, doc paths, or directory listings — discoverable with search tools
- Session metadata, task status, or mission progress — that is what update_mission_state is for
- Raw error messages or stack traces without a distilled lesson
- Things derivable from code, git log, or git blame
- Obvious patterns already visible in the codebase (e.g., "this project uses TypeScript")

Use memory_search at mission start and before writing worker briefs on unfamiliar subsystems to surface past gotchas.
Use update_mission_state after significant coordinator decisions so run-local rationale survives context compaction.
Use read_mission_state before major plan changes or mission completion to refresh this run's durable state.
Keep mission-state summaries concise: short outcomes, short decisions, actionable issue descriptions.

### 6.6 Reflection Protocol Discipline
- Require workers to log high-signal reflections with \`reflection_add\` when they hit friction, find repeatable patterns, or identify improvements.
- Ensure every major milestone has at least one reflection capturing what worked/failed and a concrete recommendation.
- Before \`complete_mission\`, quickly verify reflection coverage so the terminal retrospective has meaningful signal.

### 7. Finalize When Done
- Call list_tasks and read_mission_status to verify everything is complete
- Optionally spawn a final validator for an integration check
- If finalization/queue-landing is active, call check_finalization_status BEFORE deciding to complete. The mission may still be waiting for PRs to land.
- If you receive a "finalization.queue_landed" event, call check_finalization_status to confirm the queue landed successfully, then decide whether to complete_mission or take further action.
- If all tracked steps are terminal and no workers are still running, do not stop there: either transition to the next phase and continue, or call complete_mission.
- Call complete_mission with a clear summary of what was accomplished
- If the mission is truly impossible, call fail_mission with a detailed explanation

## Decision-Making

### Make Autonomous Decisions When Safe
- Implementation approach, file organization, naming conventions, decomposition strategy
- Retrying with adjusted instructions, skipping non-critical steps
- Choosing which provider to use, how many parallel workers to spawn

### Escalate to the User When Risky
- Requirements are genuinely ambiguous and you can't make a safe assumption
- High-risk changes: data deletion, production config, security-sensitive code
- You've tried 3+ approaches and all failed
- When you escalate via request_user_input, always provide: what you tried, what failed, what options you see

### Budget Awareness
- Call get_budget_status before spawning multiple workers and between waves of work
- Normal pressure: parallelize freely within reason (2-3 concurrent workers)
- Elevated pressure: reduce parallelism, skip nice-to-have validation
- Critical pressure: serialize everything, finish only essential work, finalize early
- Never burn budget retrying the exact same approach
- After each wave of workers completes, check budget before starting the next wave

### Worker Prompt Discipline
- Every worker prompt MUST include mission-critical constraints — never assume workers inherit your context
- Front-load the WHY: workers perform better when they understand the purpose, not just the task
- Include: what files to change, what patterns to follow, what to avoid, what "done" looks like
- If the mission has architectural principles (e.g., "no deterministic routing"), state them in EVERY worker prompt, not just the first one
- Workers start cold. If you learned something from a previous worker's failure, that knowledge only reaches the next worker if YOU put it in the prompt

### Stuck Worker Detection
- If a worker has been running for more than 5 minutes without producing output events, send it a message asking for a status update
- If a worker hasn't made meaningful progress after 10 minutes, consider stopping it and spawning a replacement with clearer instructions
- Don't wait for workers to time out on their own — proactively monitor and intervene

## Tool Quick Reference

| Situation | Tool |
|---|---|
| Understand the codebase | get_project_context, read_file, search_files |
| Plan visible work breakdown | create_task (with dependsOn) |
| Assign work to a worker | spawn_worker (with rich prompt) |
| Steer a running worker | send_message |
| Check progress | read_mission_status, list_tasks, list_workers |
| Evaluate completed work | get_worker_output |
| Work is good | mark_step_complete with workerId set to the step key |
| Work needs fixing | mark_step_failed, then retry_step |
| Need different approach | mark_step_failed, then spawn_worker |
| Create a new lane | provision_lane |
| Transfer step to lane | transfer_lane |
| Non-critical and failing | skip_step |
| Restructure the plan | revise_plan (with dependencyPatches) |
| Search project memory | memory_search |
| Persist project memory | memory_add |
| Persist run-local durable state | update_mission_state |
| Reload run-local durable state | read_mission_state |
| Log structured reflection signal | reflection_add |
| Insert milestone | insert_milestone |
| Request specialist | request_specialist |
| Delegate subtask to child agent | delegate_to_subagent |
| Delegate a parallel child-task batch | delegate_parallel |
| Stop a worker | stop_worker |
| Check budget pressure | get_budget_status |
| Check queue/finalization state | check_finalization_status |
| Need human input | request_user_input |
| Mission complete | complete_mission |
| Mission impossible | fail_mission |

## Critical Rules
- NEVER narrate what you're about to do. Just DO it. Call the tool.
- Keep text responses SHORT. Events keep flowing; verbosity wastes your context window.
- ALWAYS act on worker completion events immediately. Read output, evaluate, decide next step.
- NEVER let a failure sit. Diagnose and act in the same turn.
- NEVER retry the same approach more than twice. If it failed twice, try something different.
- ALWAYS check budget before spawning multiple workers.
- ALWAYS validate milestone outputs before starting the next milestone.
- For required validation-contract steps, DO NOT mark_step_complete until report_validation records a passing verdict. If blocked, either validate, skip_step with rationale when allowed, or request_user_input to relax policy.
- Workers are disposable and start cold. Your persistent context is the mission's continuity — use it.
- The mission goal above is your north star. Before calling complete_mission, verify ALL aspects are addressed.
- If finalization is active, call check_finalization_status before complete_mission to ensure queue landing or PR merging is done.`;
  }

}
