import path from "node:path";
import { executableTool as tool, type ExecutableTool as Tool } from "./executableTool";
import { z } from "zod";
import { getModelById, resolveModelDescriptor, resolveChatProviderForDescriptor } from "../../../../shared/modelRegistry";
import type {
  AgentChatCreateArgs,
  AgentChatInterruptArgs,
  AgentChatSendArgs,
  AgentChatSession,
  AgentChatSessionSummary,
  AgentStatus,
  AgentUpsertInput,
  AutomationRuleSummary,
  AutomationRun,
  AutomationRunListArgs,
  CtoTriggerAgentWakeupArgs,
  LinearWorkflowConfig,
  OperatorNavigationSuggestion,
  TestRunSummary,
  TestSuiteDefinition,
} from "../../../../shared/types";
import type {
  ConvergenceRuntimeState,
  ConvergenceStatus,
  IssueInventoryItem,
  IssueSource,
  PipelineSettings,
  PrCheck,
  PrComment,
  PrReviewThread,
  PrSummary,
} from "../../../../shared/types/prs";
import { DEFAULT_PIPELINE_SETTINGS } from "../../../../shared/types/prs";
import type { IssueTracker } from "../../cto/issueTracker";
import type { createLinearDispatcherService } from "../../cto/linearDispatcherService";
import type { createWorkerAgentService } from "../../cto/workerAgentService";
import type { createWorkerHeartbeatService } from "../../cto/workerHeartbeatService";
import type { createFlowPolicyService } from "../../cto/flowPolicyService";
import type { createFileService } from "../../files/fileService";
import type { createLaneService } from "../../lanes/laneService";
import type { createMissionService } from "../../missions/missionService";
import type { createAiOrchestratorService } from "../../orchestrator/aiOrchestratorService";
import type { createIssueInventoryService } from "../../prs/issueInventoryService";
import { computeConvergenceStatus, detectSource, extractSeverity } from "../../prs/issueInventoryService";
import { launchPrIssueResolutionChat } from "../../prs/prIssueResolver";
import type { createPrService } from "../../prs/prService";
import { isNoisyIssueComment, mapPermissionMode } from "../../prs/resolverUtils";
import type { createProcessService } from "../../processes/processService";
import type { createSessionService } from "../../sessions/sessionService";
import type { createCtoStateService } from "../../cto/ctoStateService";
import { getErrorMessage, nowIso, parseIsoToEpoch } from "../../shared/utils";

export interface CtoOperatorToolDeps {
  currentSessionId: string;
  defaultLaneId: string;
  defaultModelId?: string | null;
  defaultReasoningEffort?: string | null;
  resolveExecutionLane: (args: {
    requestedLaneId?: string | null;
    purpose: string;
    freshLaneName?: string | null;
    freshLaneDescription?: string | null;
  }) => Promise<string>;
  laneService: ReturnType<typeof createLaneService>;
  missionService?: ReturnType<typeof createMissionService> | null;
  aiOrchestratorService?: ReturnType<typeof createAiOrchestratorService> | null;
  workerAgentService?: ReturnType<typeof createWorkerAgentService> | null;
  workerHeartbeatService?: ReturnType<typeof createWorkerHeartbeatService> | null;
  linearDispatcherService?: ReturnType<typeof createLinearDispatcherService> | null;
  flowPolicyService?: ReturnType<typeof createFlowPolicyService> | null;
  prService?: ReturnType<typeof createPrService> | null;
  issueInventoryService?: ReturnType<typeof createIssueInventoryService> | null;
  fileService?: ReturnType<typeof createFileService> | null;
  processService?: ReturnType<typeof createProcessService> | null;
  sessionService: Pick<ReturnType<typeof createSessionService>, "updateMeta">;
  testService?: {
    listSuites: () => TestSuiteDefinition[];
    run: (args: { laneId: string; suiteId: string }) => Promise<TestRunSummary>;
    stop: (args: { runId: string }) => void;
    listRuns: (args?: { laneId?: string; suiteId?: string; limit?: number }) => TestRunSummary[];
    getLogTail: (args: { runId: string; maxBytes?: number }) => string;
  } | null;
  ptyService?: {
    create: (args: { laneId: string; title?: string; cols?: number; rows?: number; tracked?: boolean; startupCommand?: string }) => Promise<{ ptyId: string; sessionId: string }>;
  } | null;
  automationService?: {
    list: () => AutomationRuleSummary[];
    triggerManually: (args: { id: string; dryRun?: boolean }) => Promise<AutomationRun>;
    listRuns: (args?: AutomationRunListArgs) => AutomationRun[];
  } | null;
  gitService?: {
    getSyncStatus: (args: { laneId: string }) => Promise<any>;
    commit: (args: any) => Promise<any>;
    push: (args: any) => Promise<any>;
    pull: (args: { laneId: string }) => Promise<any>;
    fetch: (args: { laneId: string }) => Promise<any>;
    listRecentCommits: (args: { laneId: string; limit?: number }) => Promise<any[]>;
    listBranches: (args: any) => Promise<any[]>;
    checkoutBranch: (args: any) => Promise<any>;
    stashPush: (args: any) => Promise<any>;
    stashPop: (args: any) => Promise<any>;
    listStashes: (args: { laneId: string }) => Promise<any[]>;
    getConflictState: (args: { laneId: string }) => Promise<any>;
    rebaseContinue: (args: { laneId: string }) => Promise<any>;
    rebaseAbort: (args: { laneId: string }) => Promise<any>;
    mergeAbort: (args: { laneId: string }) => Promise<any>;
  } | null;
  conflictService?: {
    getLaneStatus: (args: any) => Promise<any>;
    getRiskMatrix: () => Promise<any[]>;
    simulateMerge: (args: any) => Promise<any>;
    runPrediction: (args?: any) => Promise<any>;
    listProposals: (args: { laneId: string }) => Promise<any[]>;
    requestProposal: (args: any) => Promise<any>;
    applyProposal: (args: any) => Promise<any>;
    undoProposal: (args: any) => Promise<any>;
  } | null;
  contextDocService?: {
    getStatus: () => any;
    generateDocs: (args: any) => Promise<any>;
  } | null;
  steerChat?: (args: { sessionId: string; instruction: string }) => Promise<{ steerId: string; queued: boolean }>;
  cancelSteer?: (args: { sessionId: string }) => Promise<void>;
  handoffChat?: (args: { sessionId: string; targetIdentityKey?: string; reason?: string }) => Promise<any>;
  listSubagents?: (args: { sessionId: string }) => Promise<any[]>;
  approveToolUse?: (args: { sessionId: string; toolUseId: string; decision: "accept" | "accept_for_session" | "decline" | "cancel" }) => Promise<void>;
  computerUseArtifactBrokerService?: {
    listArtifacts: (args?: any) => any[];
    updateArtifactReview: (args: any) => any;
  } | null;
  workerBudgetService?: {
    getBudgetSnapshot: (args: { monthKey?: string }) => any;
    listCostEvents: (args: { agentId: string; monthKey?: string; limit?: number }) => any[];
  } | null;
  missionBudgetService?: {
    getMissionBudgetStatus: (args: { missionId: string }) => Promise<any>;
  } | null;
  issueTracker?: IssueTracker | null;
  ctoStateService?: Pick<ReturnType<typeof createCtoStateService>, "getSessionLogs" | "getSubordinateActivityLogs"> | null;
  listChats: (laneId?: string, options?: { includeIdentity?: boolean; includeAutomation?: boolean }) => Promise<AgentChatSessionSummary[]>;
  getChatStatus: (sessionId: string) => Promise<AgentChatSessionSummary | null>;
  getChatTranscript: (args: {
    sessionId: string;
    limit?: number;
    maxChars?: number;
  }) => Promise<{
    sessionId: string;
    entries: Array<{
      role: "user" | "assistant";
      text: string;
      timestamp: string;
      turnId?: string;
    }>;
    truncated: boolean;
    totalEntries: number;
  }>;
  createChat: (args: AgentChatCreateArgs) => Promise<AgentChatSession>;
  updateChatSession: (args: {
    sessionId: string;
    title?: string | null;
  }) => Promise<AgentChatSession>;
  previewSessionToolNames: (args: {
    laneId: string;
    sessionProfile?: AgentChatCreateArgs["sessionProfile"];
  }) => string[];
  sendChatMessage: (args: AgentChatSendArgs) => Promise<void>;
  interruptChat: (args: AgentChatInterruptArgs) => Promise<void>;
  resumeChat: (args: { sessionId: string }) => Promise<AgentChatSession>;
  disposeChat: (args: { sessionId: string }) => Promise<void>;
  ensureCtoSession: (args: {
    laneId: string;
    modelId?: string | null;
    reasoningEffort?: string | null;
    reuseExisting?: boolean;
  }) => Promise<AgentChatSession>;
}

const ACTIVE_LINEAR_RUN_STATUSES = new Set([
  "queued",
  "in_progress",
  "waiting_for_target",
  "waiting_for_pr",
  "awaiting_human_review",
  "awaiting_delegation",
  "retry_wait",
]);

function deriveChatProvider(args: { modelId?: string | null }): { provider: AgentChatCreateArgs["provider"]; model: string } {
  const descriptor = args.modelId ? getModelById(args.modelId) : null;
  if (!descriptor) {
    return { provider: "opencode", model: args.modelId?.trim() || "" };
  }
  return resolveChatProviderForDescriptor(descriptor);
}

function buildIssueBrief(issue: Awaited<ReturnType<IssueTracker["fetchIssueById"]>>): string {
  if (!issue) return "Linear issue not found.";
  return [
    `${issue.identifier}: ${issue.title}`,
    "",
    issue.description?.trim() || "No description provided.",
    "",
    `Project: ${issue.projectSlug || "unknown"}`,
    `State: ${issue.stateName || "unknown"}`,
    `Priority: ${issue.priorityLabel || "unknown"}`,
    `Labels: ${issue.labels.join(", ") || "none"}`,
    `Assignee: ${issue.assigneeName || "unassigned"}`,
    issue.url ? `URL: ${issue.url}` : "",
  ].filter((line) => line.length > 0).join("\n");
}

function summarizeWorkerStatus(status: AgentStatus): string {
  switch (status) {
    case "active":
    case "running":
      return "Worker is active.";
    case "paused":
      return "Worker is paused.";
    default:
      return "Worker is idle.";
  }
}

function buildNavigationSuggestion(args: {
  surface: OperatorNavigationSuggestion["surface"];
  laneId?: string | null;
  sessionId?: string | null;
  missionId?: string | null;
}): OperatorNavigationSuggestion {
  const laneId = args.laneId?.trim() || null;
  const sessionId = args.sessionId?.trim() || null;
  const missionId = args.missionId?.trim() || null;
  if (args.surface === "work") {
    const search = new URLSearchParams();
    if (laneId) search.set("laneId", laneId);
    if (sessionId) search.set("sessionId", sessionId);
    const query = search.toString();
    return {
      surface: "work",
      label: "Open in Work",
      href: `/work${query ? `?${query}` : ""}`,
      laneId,
      sessionId,
    };
  }
  if (args.surface === "missions") {
    const search = new URLSearchParams();
    if (missionId) search.set("missionId", missionId);
    if (laneId) search.set("laneId", laneId);
    const query = search.toString();
    return {
      surface: "missions",
      label: "Open mission",
      href: `/missions${query ? `?${query}` : ""}`,
      laneId,
      missionId,
    };
  }
  if (args.surface === "cto") {
    return {
      surface: "cto",
      label: "Open CTO",
      href: "/cto",
      laneId,
      sessionId,
    };
  }
  const search = new URLSearchParams();
  if (laneId) search.set("laneId", laneId);
  if (sessionId) search.set("sessionId", sessionId);
  const query = search.toString();
  return {
    surface: "lanes",
    label: "Open lane",
    href: `/lanes${query ? `?${query}` : ""}`,
    laneId,
    sessionId,
  };
}

function buildNavigationPayload(
  suggestion: OperatorNavigationSuggestion | null,
  includeSuggestions = true,
): {
  navigation?: OperatorNavigationSuggestion;
  navigationSuggestions?: OperatorNavigationSuggestion[];
} {
  if (!includeSuggestions || !suggestion) return {};
  return {
    navigation: suggestion,
    navigationSuggestions: [suggestion],
  };
}

function resolveWorkspaceIdForLane(
  deps: Pick<CtoOperatorToolDeps, "fileService" | "defaultLaneId">,
  args: { workspaceId?: string | null; laneId?: string | null },
): string {
  if (!deps.fileService) {
    throw new Error("File service is not available.");
  }
  const allWorkspaces = deps.fileService.listWorkspaces({ includeArchived: true });
  const explicitWorkspaceId = args.workspaceId?.trim() || "";
  if (explicitWorkspaceId) {
    const workspace = allWorkspaces.find((entry) => entry.id === explicitWorkspaceId) ?? null;
    if (!workspace) throw new Error(`Workspace not found: ${explicitWorkspaceId}`);
    return workspace.id;
  }
  const laneId = args.laneId?.trim() || deps.defaultLaneId;
  // Prefer active workspaces; fall back to archived only if no active match.
  const activeWorkspaces = deps.fileService.listWorkspaces({ includeArchived: false });
  const laneWorkspace =
    activeWorkspaces.find((entry) => entry.laneId === laneId) ??
    allWorkspaces.find((entry) => entry.laneId === laneId) ??
    null;
  if (laneWorkspace) return laneWorkspace.id;
  throw new Error(`Workspace not found for lane ${laneId}.`);
}

function extractSeverityFromText(text: string | null | undefined): IssueInventoryItem["severity"] {
  return extractSeverity(String(text ?? ""));
}

function truncateForHeadline(text: string, max = 140): string {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function summarizeInventoryItems(items: IssueInventoryItem[], maxRounds: number): ConvergenceStatus {
  return computeConvergenceStatus(items, maxRounds);
}

function buildFallbackInventoryItems(args: {
  prId: string;
  checks: PrCheck[];
  reviewThreads: PrReviewThread[];
  comments: PrComment[];
}): IssueInventoryItem[] {
  const items: IssueInventoryItem[] = [];
  const timestamp = nowIso();

  for (const thread of args.reviewThreads) {
    const latestComment = thread.comments.at(-1) ?? null;
    const headlineSource = latestComment?.body?.trim() || thread.comments[0]?.body?.trim() || thread.path || `Review thread ${thread.id}`;
    const body = thread.comments
      .map((entry) => entry.body?.trim() || "")
      .filter(Boolean)
      .join("\n\n")
      .trim() || null;
    const author = latestComment?.author ?? null;
    const source: IssueSource = detectSource(author);
    items.push({
      id: `transient-thread-${thread.id}`,
      prId: args.prId,
      source,
      type: "review_thread",
      externalId: `review-thread:${thread.id}`,
      state: thread.isResolved || thread.isOutdated ? "fixed" : "new",
      round: 0,
      filePath: thread.path,
      line: thread.line,
      severity: extractSeverityFromText(body ?? headlineSource),
      headline: truncateForHeadline(headlineSource),
      body,
      author,
      url: thread.url,
      dismissReason: null,
      agentSessionId: null,
      threadCommentCount: thread.comments.length,
      threadLatestCommentId: latestComment?.id ?? null,
      threadLatestCommentAuthor: latestComment?.author ?? null,
      threadLatestCommentAt: latestComment?.createdAt ?? null,
      threadLatestCommentSource: source,
      createdAt: thread.createdAt ?? timestamp,
      updatedAt: thread.updatedAt ?? thread.createdAt ?? timestamp,
    });
  }

  for (const comment of args.comments) {
    if (comment.source !== "issue") continue;
    if (isNoisyIssueComment(comment)) continue;
    const source = detectSource(comment.author);
    if (source !== "human") continue;
    const body = comment.body?.trim() || null;
    items.push({
      id: `transient-comment-${comment.id}`,
      prId: args.prId,
      source,
      type: "issue_comment",
      externalId: `issue-comment:${comment.id}`,
      state: "new",
      round: 0,
      filePath: comment.path,
      line: comment.line,
      severity: extractSeverityFromText(body),
      headline: body ? truncateForHeadline(body) : `Issue comment by ${comment.author}`,
      body,
      author: comment.author,
      url: comment.url,
      dismissReason: null,
      agentSessionId: null,
      threadCommentCount: null,
      threadLatestCommentId: null,
      threadLatestCommentAuthor: null,
      threadLatestCommentAt: null,
      threadLatestCommentSource: null,
      createdAt: comment.createdAt ?? timestamp,
      updatedAt: comment.updatedAt ?? comment.createdAt ?? timestamp,
    });
  }

  for (const check of args.checks) {
    if (check.conclusion !== "failure") continue;
    const timestampValue = check.completedAt ?? check.startedAt ?? timestamp;
    items.push({
      id: `transient-check-${check.name}-${timestampValue}`,
      prId: args.prId,
      source: "unknown",
      type: "check_failure",
      externalId: `check:${check.name}`,
      state: "new",
      round: 0,
      filePath: null,
      line: null,
      severity: "major",
      headline: `Check failed: ${check.name}`,
      body: check.detailsUrl ? `Details: ${check.detailsUrl}` : null,
      author: null,
      url: check.detailsUrl,
      dismissReason: null,
      agentSessionId: null,
      threadCommentCount: null,
      threadLatestCommentId: null,
      threadLatestCommentAuthor: null,
      threadLatestCommentAt: null,
      threadLatestCommentSource: null,
      createdAt: timestampValue,
      updatedAt: timestampValue,
    });
  }

  return items;
}

function mapInventoryItemView(item: IssueInventoryItem) {
  const {
    threadLatestCommentId,
    threadLatestCommentAuthor,
    threadLatestCommentAt,
    threadLatestCommentSource,
    ...rest
  } = item;
  return {
    ...rest,
    latestComment: threadLatestCommentId
      ? {
          id: threadLatestCommentId,
          author: threadLatestCommentAuthor ?? null,
          at: threadLatestCommentAt ?? null,
          source: threadLatestCommentSource ?? null,
        }
      : null,
  };
}

function buildRuntimePatch(input: {
  autoConvergeEnabled?: boolean | null;
  autoConverge?: boolean | null;
  status?: ConvergenceRuntimeState["status"];
  pollerStatus?: ConvergenceRuntimeState["pollerStatus"];
  currentRound?: number | null;
  activeSessionId?: string | null;
  activeLaneId?: string | null;
  activeHref?: string | null;
  pauseReason?: string | null;
  errorMessage?: string | null;
  lastStartedAt?: string | null;
  lastPolledAt?: string | null;
  lastPausedAt?: string | null;
  lastStoppedAt?: string | null;
}): Partial<ConvergenceRuntimeState> {
  const patch: Partial<ConvergenceRuntimeState> = {};
  const autoConvergeEnabled = input.autoConvergeEnabled ?? input.autoConverge;
  if (autoConvergeEnabled != null) patch.autoConvergeEnabled = autoConvergeEnabled;
  if (input.currentRound != null) patch.currentRound = input.currentRound;

  const nullableFields = [
    "status", "pollerStatus", "activeSessionId", "activeLaneId", "activeHref",
    "pauseReason", "errorMessage", "lastStartedAt", "lastPolledAt", "lastPausedAt", "lastStoppedAt",
  ] as const;
  for (const key of nullableFields) {
    if (input[key] !== undefined) {
      (patch as Record<string, unknown>)[key] = input[key];
    }
  }
  return patch;
}

async function loadPrConvergenceContext(
  deps: Pick<CtoOperatorToolDeps, "prService" | "issueInventoryService">,
  prId: string,
): Promise<{
  pr: PrSummary;
  status: Awaited<ReturnType<NonNullable<CtoOperatorToolDeps["prService"]>["getStatus"]>>;
  runtime: ConvergenceRuntimeState | null;
  pipelineSettings: PipelineSettings;
  inventory: { items: IssueInventoryItem[]; summary: ConvergenceStatus };
  persistedInventory: boolean;
}> {
  if (!deps.prService) throw new Error("PR service is not available.");
  const pr = deps.prService.listAll().find((entry) => entry.id === prId) ?? null;
  if (!pr) throw new Error(`PR not found: ${prId}`);

  const [status, checks, reviewThreads, comments] = await Promise.all([
    deps.prService.getStatus(prId),
    deps.prService.getChecks(prId),
    deps.prService.getReviewThreads(prId),
    deps.prService.getComments(prId),
  ]);

  if (deps.issueInventoryService) {
    const snapshot = deps.issueInventoryService.syncFromPrData(prId, checks, reviewThreads, comments);
    return {
      pr,
      status,
      runtime: deps.issueInventoryService.getConvergenceRuntime(prId),
      pipelineSettings: deps.issueInventoryService.getPipelineSettings(prId),
      inventory: {
        items: snapshot.items,
        summary: snapshot.convergence,
      },
      persistedInventory: true,
    };
  }

  const items = buildFallbackInventoryItems({ prId, checks, reviewThreads, comments });
  return {
    pr,
    status,
    runtime: null,
    pipelineSettings: { ...DEFAULT_PIPELINE_SETTINGS },
    inventory: {
      items,
      summary: summarizeInventoryItems(items, DEFAULT_PIPELINE_SETTINGS.maxRounds),
    },
    persistedInventory: false,
  };
}

export function createCtoOperatorTools(deps: CtoOperatorToolDeps): Record<string, Tool> {
  const tools: Record<string, Tool> = {};

  const getLinearPolicy = (): LinearWorkflowConfig | null => deps.flowPolicyService?.getPolicy() ?? null;

  const loadIssue = async (issueId: string) => {
    if (!deps.issueTracker) return null;
    return deps.issueTracker.fetchIssueById(issueId);
  };

  const routeIssueToCto = async (args: {
    issueId: string;
    laneId?: string;
    reuseExisting?: boolean;
  }) => {
    if (!deps.issueTracker) return { success: false as const, error: "Linear issue tracker is not available." };
    const issue = await loadIssue(args.issueId);
    if (!issue) return { success: false as const, error: `Issue not found: ${args.issueId}` };
    const session = await deps.ensureCtoSession({
      laneId: args.laneId?.trim() || deps.defaultLaneId,
      modelId: deps.defaultModelId,
      reasoningEffort: deps.defaultReasoningEffort,
      reuseExisting: args.reuseExisting,
    });
    if (session.id !== deps.currentSessionId) {
      await deps.sendChatMessage({
        sessionId: session.id,
        text: `New Linear issue context:\n\n${buildIssueBrief(issue)}`,
      });
    }
    return {
      success: true as const,
      sessionId: session.id,
      ...buildNavigationPayload(buildNavigationSuggestion({
        surface: "cto",
        laneId: session.laneId,
        sessionId: session.id,
      })),
      reusedCurrentSession: session.id === deps.currentSessionId,
      issue: {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        url: issue.url,
      },
    };
  };

  const routeIssueToMission = async (args: {
    issueId: string;
    laneId?: string;
    launch?: boolean;
    runMode?: "autopilot" | "manual";
  }) => {
    if (!deps.issueTracker || !deps.missionService) {
      return { success: false as const, error: "Mission routing services are not available." };
    }
    const issue = await loadIssue(args.issueId);
    if (!issue) return { success: false as const, error: `Issue not found: ${args.issueId}` };
    try {
      const mission = deps.missionService.create({
        title: `${issue.identifier}: ${issue.title}`,
        prompt: buildIssueBrief(issue),
        laneId: args.laneId?.trim() || deps.defaultLaneId,
        autostart: false,
        launchMode: args.runMode ?? "autopilot",
      });
      let run: unknown = null;
      if ((args.launch ?? true) && deps.aiOrchestratorService) {
        run = await deps.aiOrchestratorService.startMissionRun({
          missionId: mission.id,
          runMode: args.runMode ?? "autopilot",
          autopilotOwnerId: "cto-linear-route",
          defaultRetryLimit: 1,
          metadata: {
            launchSource: "cto_operator_tools.routeLinearIssueToMission",
            linearIssueId: issue.id,
            linearIssueIdentifier: issue.identifier,
          },
        });
      }
      return {
        success: true as const,
        mission,
        run,
        ...buildNavigationPayload(buildNavigationSuggestion({
          surface: "missions",
          laneId: mission.laneId ?? (args.laneId?.trim() || deps.defaultLaneId),
          missionId: mission.id,
        })),
      };
    } catch (error) {
      return { success: false as const, error: getErrorMessage(error) };
    }
  };

  const routeIssueToWorker = async (args: {
    issueId: string;
    agentId: string;
    taskKey?: string;
  }) => {
    if (!deps.issueTracker || !deps.workerHeartbeatService) {
      return { success: false as const, error: "Worker routing services are not available." };
    }
    const agentId = args.agentId.trim();
    if (!agentId.length) {
      return { success: false as const, error: "agentId is required to route a workflow run to a worker." };
    }
    const issue = await loadIssue(args.issueId);
    if (!issue) return { success: false as const, error: `Issue not found: ${args.issueId}` };
    try {
      const result = await deps.workerHeartbeatService.triggerWakeup({
        agentId,
        reason: "assignment",
        issueKey: issue.identifier,
        taskKey: args.taskKey?.trim() || issue.identifier,
        prompt: buildIssueBrief(issue),
        context: {
          linearIssueId: issue.id,
          linearIssueIdentifier: issue.identifier,
          linearIssueUrl: issue.url,
        },
      });
      return { success: true as const, ...result };
    } catch (error) {
      return { success: false as const, error: getErrorMessage(error) };
    }
  };

  tools.listLanes = tool({
    description: "List all ADE lanes with their status (dirty, ahead/behind, rebase state), branch info, and metadata. Use this to understand what work is happening across the project and choose where to open work.",
    inputSchema: z.object({
      includeArchived: z.boolean().optional().default(false),
    }),
    execute: async ({ includeArchived }) => {
      const lanes = await deps.laneService.list({ includeArchived });
      return {
        success: true,
        count: lanes.length,
        lanes: lanes.map((lane) => ({
          id: lane.id,
          name: lane.name,
          branchRef: lane.branchRef,
          parentLaneId: lane.parentLaneId,
          worktreePath: lane.worktreePath,
          childCount: lane.childCount,
          status: lane.status,
        })),
      };
    },
  });

  tools.inspectLane = tool({
    description: "Inspect one ADE lane by ID to understand its branch, worktree, and git state.",
    inputSchema: z.object({
      laneId: z.string(),
    }),
    execute: async ({ laneId }) => {
      const lanes = await deps.laneService.list({ includeArchived: true });
      const lane = lanes.find((entry) => entry.id === laneId.trim()) ?? null;
      if (!lane) {
        return { success: false, error: `Lane not found: ${laneId}` };
      }
      return {
        success: true,
        lane,
        ...buildNavigationPayload(buildNavigationSuggestion({
          surface: "lanes",
          laneId: lane.id,
        })),
      };
    },
  });

  tools.createLane = tool({
    description: "Create a new ADE lane for isolated work.",
    inputSchema: z.object({
      name: z.string(),
      description: z.string().optional(),
      parentLaneId: z.string().optional(),
    }),
    execute: async ({ name, description, parentLaneId }) => {
      try {
        const lane = await deps.laneService.create({ name, description, parentLaneId });
        return {
          success: true,
          lane,
          ...buildNavigationPayload(buildNavigationSuggestion({
            surface: "lanes",
            laneId: lane.id,
          })),
        };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.listChats = tool({
    description: "List ADE chat sessions so you can supervise active work and persistent identity threads.",
    inputSchema: z.object({
      laneId: z.string().optional(),
      includeIdentity: z.boolean().optional().default(true),
    }),
    execute: async ({ laneId, includeIdentity }) => {
      const chats = await deps.listChats(laneId?.trim() || undefined, {
        includeIdentity,
        includeAutomation: false,
      });
      return { success: true, count: chats.length, chats };
    },
  });

  tools.spawnChat = tool({
    description:
      "Create a native ADE work chat session — the primary way to launch an AI agent in ADE. " +
      "IMPORTANT: Always pass modelId when the user specifies a model. Use the full model ID " +
      "(e.g. 'anthropic/claude-opus-4-6' for Opus, 'anthropic/claude-sonnet-4-6' for Sonnet, " +
      "'anthropic/claude-haiku-4-5' for Haiku, 'openai/gpt-5.4-codex' for GPT-5.4). " +
      "If no modelId is passed, the CTO's default model preference is used. " +
      "Set initialPrompt to seed the chat with a task description — the agent will begin working immediately. " +
      "This creates a full ADE chat with UI, streaming, tool approval, and service integration. " +
      "Use this when the user asks for 'a chat' or 'an agent'. If they explicitly want a terminal or CLI tool, use createTerminal instead.",
    inputSchema: z.object({
      laneId: z.string().optional().describe("Lane to run in. Defaults to CTO's lane. A new lane is auto-created if needed."),
      modelId: z.string().optional().describe("Full model ID (e.g. 'anthropic/claude-sonnet-4-6'). MUST be set when user specifies a model."),
      reasoningEffort: z.string().nullable().optional().describe("Reasoning effort: 'low', 'medium', 'high', 'max' (opus), 'xhigh' (openai)."),
      title: z.string().optional().describe("Display title for the chat session."),
      initialPrompt: z.string().optional().describe("Task description to seed the chat. The agent starts working immediately."),
      openInUi: z.boolean().optional().default(true).describe("Whether to open the chat in the ADE UI."),
    }),
    execute: async ({ laneId, modelId, reasoningEffort, title, initialPrompt, openInUi }) => {
      try {
        // Resolve model: supports full IDs (anthropic/claude-sonnet-4-6), short IDs (sonnet), and aliases (opus)
        const rawModelId = modelId?.trim() || null;
        const descriptor = rawModelId ? resolveModelDescriptor(rawModelId) : null;
        const selectedModelId = descriptor?.id ?? rawModelId ?? deps.defaultModelId ?? null;
        const resolved = deriveChatProvider({ modelId: selectedModelId });
        const executionLaneId = await deps.resolveExecutionLane({
          requestedLaneId: laneId?.trim() || undefined,
          purpose: title?.trim() || "implementation chat",
          freshLaneName: title?.trim() || "implementation chat",
          freshLaneDescription: "Dedicated implementation lane launched from the CTO coordinator chat.",
        });
        const session = await deps.createChat({
          laneId: executionLaneId,
          provider: resolved.provider,
          model: resolved.model,
          ...(selectedModelId ? { modelId: selectedModelId } : {}),
          reasoningEffort: reasoningEffort ?? deps.defaultReasoningEffort ?? null,
          surface: "work",
          sessionProfile: "workflow",
        });
        if (title?.trim()) {
          await deps.updateChatSession({
            sessionId: session.id,
            title: title.trim(),
          });
        }
        if (initialPrompt?.trim()) {
          await deps.sendChatMessage({
            sessionId: session.id,
            text: initialPrompt.trim(),
          });
        }
        return {
          success: true,
          openInUi,
          sessionId: session.id,
          laneId: session.laneId,
          requestedTitle: title?.trim() || null,
          ...buildNavigationPayload(buildNavigationSuggestion({
            surface: "work",
            laneId: session.laneId,
            sessionId: session.id,
          }), openInUi),
          provider: session.provider,
          model: session.model,
          modelId: session.modelId ?? null,
        };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.sendChatMessage = tool({
    description: "Send a message to an ADE chat session you are supervising.",
    inputSchema: z.object({
      sessionId: z.string().trim().min(1),
      text: z.string().trim().min(1),
    }),
    execute: async ({ sessionId, text }) => {
      try {
        await deps.sendChatMessage({ sessionId, text });
        return { success: true, sessionId };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.interruptChat = tool({
    description: "Interrupt a running ADE chat turn.",
    inputSchema: z.object({
      sessionId: z.string().trim().min(1),
    }),
    execute: async ({ sessionId }) => {
      try {
        await deps.interruptChat({ sessionId });
        return { success: true, sessionId };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.resumeChat = tool({
    description: "Resume a previously ended ADE chat session so it can continue work.",
    inputSchema: z.object({
      sessionId: z.string().trim().min(1),
    }),
    execute: async ({ sessionId }) => {
      try {
        const session = await deps.resumeChat({ sessionId });
        return {
          success: true,
          sessionId: session.id,
          laneId: session.laneId,
          status: session.status,
          ...buildNavigationPayload(buildNavigationSuggestion({
            surface: "work",
            laneId: session.laneId,
            sessionId: session.id,
          })),
        };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.endChat = tool({
    description: "End and archive an ADE chat session.",
    inputSchema: z.object({
      sessionId: z.string().trim().min(1),
    }),
    execute: async ({ sessionId }) => {
      try {
        await deps.disposeChat({ sessionId });
        return { success: true, sessionId };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.getChatStatus = tool({
    description: "Get the current status for an ADE chat session.",
    inputSchema: z.object({
      sessionId: z.string().trim().min(1),
    }),
    execute: async ({ sessionId }) => {
      const session = await deps.getChatStatus(sessionId);
      if (!session) return { success: false, error: `Chat not found: ${sessionId}` };
      return { success: true, session };
    },
  });

  tools.getChatTranscript = tool({
    description: "Read recent user and assistant turns for an ADE chat session without focusing the UI.",
    inputSchema: z.object({
      sessionId: z.string(),
      limit: z.number().int().positive().max(100).optional().default(20),
      maxChars: z.number().int().positive().max(40000).optional().default(8000),
    }),
    execute: async ({ sessionId, limit, maxChars }) => {
      try {
        const transcript = await deps.getChatTranscript({ sessionId, limit, maxChars });
        return {
          success: true,
          ...transcript,
          count: transcript.entries.length,
        };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.listMissions = tool({
    description: "List ADE missions so you can supervise orchestrated work.",
    inputSchema: z.object({
      laneId: z.string().optional(),
      status: z.enum(["active", "in_progress", "queued", "planning", "intervention_required", "completed", "failed", "canceled"]).optional(),
    }),
    execute: async ({ laneId, status }) => {
      if (!deps.missionService) return { success: false, error: "Mission service is not available." };
      const missions = deps.missionService.list({
        ...(laneId?.trim() ? { laneId: laneId.trim() } : {}),
        ...(status ? { status } : {}),
      });
      return { success: true, count: missions.length, missions };
    },
  });

  tools.startMission = tool({
    description: "Create a mission and optionally launch it through the orchestrator.",
    inputSchema: z.object({
      prompt: z.string(),
      title: z.string().optional(),
      laneId: z.string().optional(),
      priority: z.enum(["urgent", "high", "normal", "low"]).optional(),
      launch: z.boolean().optional().default(true),
      runMode: z.enum(["autopilot", "manual"]).optional().default("autopilot"),
    }),
    execute: async ({ prompt, title, laneId, priority, launch, runMode }) => {
      if (!deps.missionService) return { success: false, error: "Mission service is not available." };
      try {
        const executionLaneId = await deps.resolveExecutionLane({
          requestedLaneId: laneId?.trim() || undefined,
          purpose: title?.trim() || "mission",
          freshLaneName: title?.trim() || "mission",
          freshLaneDescription: "Dedicated mission lane launched from the CTO coordinator chat.",
        });
        const mission = deps.missionService.create({
          prompt,
          ...(title?.trim() ? { title: title.trim() } : {}),
          laneId: executionLaneId,
          ...(priority ? { priority } : {}),
          autostart: false,
          launchMode: runMode,
        });
        let run: unknown = null;
        if (launch && deps.aiOrchestratorService) {
          run = await deps.aiOrchestratorService.startMissionRun({
            missionId: mission.id,
            runMode,
            autopilotOwnerId: "cto-operator-tools",
            defaultRetryLimit: 1,
            metadata: {
              launchSource: "cto_operator_tools.startMission",
            },
          });
        }
        return {
          success: true,
          mission,
          run,
          ...buildNavigationPayload(buildNavigationSuggestion({
            surface: "missions",
            laneId: mission.laneId ?? executionLaneId,
            missionId: mission.id,
          })),
        };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.getMissionStatus = tool({
    description: "Get mission detail so you can inspect steps, artifacts, and interventions.",
    inputSchema: z.object({
      missionId: z.string(),
    }),
    execute: async ({ missionId }) => {
      if (!deps.missionService) return { success: false, error: "Mission service is not available." };
      const mission = deps.missionService.get(missionId);
      if (!mission) return { success: false, error: `Mission not found: ${missionId}` };
      return {
        success: true,
        mission,
        ...buildNavigationPayload(buildNavigationSuggestion({
          surface: "missions",
          laneId: mission.laneId ?? null,
          missionId: mission.id,
        })),
      };
    },
  });

  tools.updateMission = tool({
    description: "Apply stable mission edits such as title, prompt, lane, priority, status, or outcome summary.",
    inputSchema: z.object({
      missionId: z.string(),
      title: z.string().optional(),
      prompt: z.string().optional(),
      laneId: z.string().nullable().optional(),
      status: z.enum(["queued", "planning", "in_progress", "intervention_required", "completed", "failed", "canceled"]).optional(),
      priority: z.enum(["urgent", "high", "normal", "low"]).optional(),
      outcomeSummary: z.string().nullable().optional(),
    }),
    execute: async ({ missionId, title, prompt, laneId, status, priority, outcomeSummary }) => {
      if (!deps.missionService) return { success: false, error: "Mission service is not available." };
      try {
        const mission = deps.missionService.update({
          missionId,
          ...(title !== undefined ? { title } : {}),
          ...(prompt !== undefined ? { prompt } : {}),
          ...(laneId !== undefined ? { laneId } : {}),
          ...(status ? { status } : {}),
          ...(priority ? { priority } : {}),
          ...(outcomeSummary !== undefined ? { outcomeSummary } : {}),
        });
        return {
          success: true,
          mission,
          ...buildNavigationPayload(buildNavigationSuggestion({
            surface: "missions",
            laneId: mission.laneId ?? null,
            missionId: mission.id,
          })),
        };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.launchMissionRun = tool({
    description: "Launch or relaunch orchestration for an existing mission.",
    inputSchema: z.object({
      missionId: z.string(),
      runMode: z.enum(["autopilot", "manual"]).optional().default("autopilot"),
      plannerProvider: z.enum(["claude", "codex", "deterministic"]).optional(),
    }),
    execute: async ({ missionId, runMode, plannerProvider }) => {
      if (!deps.missionService || !deps.aiOrchestratorService) {
        return { success: false, error: "Mission runtime services are not available." };
      }
      const mission = deps.missionService.get(missionId);
      if (!mission) return { success: false, error: `Mission not found: ${missionId}` };
      try {
        const run = await deps.aiOrchestratorService.startMissionRun({
          missionId,
          runMode,
          autopilotOwnerId: "cto-operator-tools",
          defaultRetryLimit: 1,
          ...(plannerProvider ? { plannerProvider } : {}),
          metadata: {
            launchSource: "cto_operator_tools.launchMissionRun",
          },
        });
        return {
          success: true,
          mission,
          run,
          ...buildNavigationPayload(buildNavigationSuggestion({
            surface: "missions",
            laneId: mission.laneId ?? null,
            missionId: mission.id,
          })),
        };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.resolveMissionIntervention = tool({
    description: "Resolve an open mission intervention with an explicit status and resolution kind.",
    inputSchema: z.object({
      missionId: z.string(),
      interventionId: z.string(),
      status: z.enum(["resolved", "dismissed"]),
      resolutionKind: z.enum(["answer_provided", "accept_defaults", "skip_question", "cancel_run"]).nullable().optional(),
      note: z.string().nullable().optional(),
    }),
    execute: async ({ missionId, interventionId, status, resolutionKind, note }) => {
      if (!deps.missionService) return { success: false, error: "Mission service is not available." };
      try {
        const intervention = deps.missionService.resolveIntervention({
          missionId,
          interventionId,
          status,
          resolutionKind: resolutionKind ?? null,
          note: note ?? null,
        });
        return { success: true, intervention };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.getMissionRunView = tool({
    description: "Read the orchestrator-backed mission runtime summary.",
    inputSchema: z.object({
      missionId: z.string(),
      runId: z.string().nullable().optional(),
    }),
    execute: async ({ missionId, runId }) => {
      if (!deps.aiOrchestratorService) return { success: false, error: "Mission runtime service is not available." };
      try {
        const view = await deps.aiOrchestratorService.getRunView({
          missionId,
          runId: runId?.trim() || null,
        });
        if (!view) return { success: false, error: `Mission run view not found for mission ${missionId}.` };
        return { success: true, view };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.getMissionLogs = tool({
    description: "Read bounded mission logs across timeline, runtime, chat, outputs, and interventions.",
    inputSchema: z.object({
      missionId: z.string(),
      runId: z.string().nullable().optional(),
      channels: z.array(z.enum(["timeline", "runtime", "chat", "outputs", "reflections", "retrospectives", "interventions"])).optional(),
      cursor: z.string().nullable().optional(),
      limit: z.number().int().positive().max(500).optional().default(100),
    }),
    execute: async ({ missionId, runId, channels, cursor, limit }) => {
      if (!deps.aiOrchestratorService) return { success: false, error: "Mission runtime service is not available." };
      try {
        const logs = await deps.aiOrchestratorService.getMissionLogs({
          missionId,
          runId: runId?.trim() || null,
          ...(channels?.length ? { channels } : {}),
          cursor: cursor?.trim() || null,
          limit,
        });
        return { success: true, ...logs };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.listMissionWorkerDigests = tool({
    description: "List worker runtime digests for a mission so the CTO can supervise delegated execution.",
    inputSchema: z.object({
      missionId: z.string(),
      runId: z.string().nullable().optional(),
      stepId: z.string().nullable().optional(),
      attemptId: z.string().nullable().optional(),
      laneId: z.string().nullable().optional(),
      limit: z.number().int().positive().max(200).optional().default(50),
    }),
    execute: async ({ missionId, runId, stepId, attemptId, laneId, limit }) => {
      if (!deps.aiOrchestratorService) return { success: false, error: "Mission runtime service is not available." };
      try {
        const digests = deps.aiOrchestratorService.listWorkerDigests({
          missionId,
          runId: runId?.trim() || null,
          stepId: stepId?.trim() || null,
          attemptId: attemptId?.trim() || null,
          laneId: laneId?.trim() || null,
          limit,
        });
        return { success: true, count: digests.length, digests };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.steerMission = tool({
    description: "Send a follow-up directive into a live mission run without opening raw coordinator internals.",
    inputSchema: z.object({
      missionId: z.string(),
      directive: z.string(),
      priority: z.enum(["suggestion", "instruction", "override"]).optional().default("instruction"),
      targetStepKey: z.string().nullable().optional(),
      interventionId: z.string().nullable().optional(),
      resolutionKind: z.enum(["answer_provided", "accept_defaults", "skip_question", "cancel_run"]).nullable().optional(),
    }),
    execute: async ({ missionId, directive, priority, targetStepKey, interventionId, resolutionKind }) => {
      if (!deps.aiOrchestratorService) return { success: false, error: "Mission runtime service is not available." };
      try {
        const result = deps.aiOrchestratorService.steerMission({
          missionId,
          directive,
          priority,
          targetStepKey: targetStepKey?.trim() || null,
          interventionId: interventionId?.trim() || null,
          resolutionKind: resolutionKind ?? null,
        });
        return { success: true, result };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.listWorkers = tool({
    description: "List worker agents in the CTO org.",
    inputSchema: z.object({
      includeDeleted: z.boolean().optional().default(false),
    }),
    execute: async ({ includeDeleted }) => {
      if (!deps.workerAgentService) return { success: false, error: "Worker service is not available." };
      const workers = deps.workerAgentService.listAgents({ includeDeleted });
      return { success: true, count: workers.length, workers };
    },
  });

  tools.createWorker = tool({
    description: "Create a worker agent in the CTO org.",
    inputSchema: z.object({
      name: z.string(),
      role: z.enum(["engineer", "qa", "designer", "devops", "researcher", "general"]).default("engineer"),
      title: z.string().optional(),
      reportsTo: z.string().nullable().optional(),
      capabilities: z.array(z.string()).optional(),
      adapterType: z.enum(["claude-local", "codex-local", "openclaw-webhook", "process"]).default("claude-local"),
      modelId: z.string().optional(),
      budgetMonthlyCents: z.number().int().nonnegative().optional(),
    }),
    execute: async ({ name, role, title, reportsTo, capabilities, adapterType, modelId, budgetMonthlyCents }) => {
      if (!deps.workerAgentService) return { success: false, error: "Worker service is not available." };
      try {
        const adapterConfig: AgentUpsertInput["adapterConfig"] = modelId?.trim() ? { modelId: modelId.trim() } : {};
        const worker = deps.workerAgentService.saveAgent({
          name,
          role,
          ...(title?.trim() ? { title: title.trim() } : {}),
          reportsTo: reportsTo?.trim() || null,
          capabilities: capabilities?.map((entry) => entry.trim()).filter(Boolean) ?? [],
          adapterType,
          adapterConfig,
          budgetMonthlyCents,
        });
        return { success: true, worker };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.updateWorkerStatus = tool({
    description: "Change a worker agent status.",
    inputSchema: z.object({
      agentId: z.string(),
      status: z.enum(["idle", "active", "paused", "running"]),
    }),
    execute: async ({ agentId, status }) => {
      if (!deps.workerAgentService) return { success: false, error: "Worker service is not available." };
      deps.workerAgentService.setAgentStatus(agentId, status);
      return { success: true, agentId, status };
    },
  });

  tools.wakeWorker = tool({
    description: "Wake a worker agent with a manual task prompt.",
    inputSchema: z.object({
      agentId: z.string(),
      prompt: z.string(),
      taskKey: z.string().nullable().optional(),
      issueKey: z.string().nullable().optional(),
    }),
    execute: async ({ agentId, prompt, taskKey, issueKey }) => {
      if (!deps.workerHeartbeatService) return { success: false, error: "Worker heartbeat service is not available." };
      try {
        const result = await deps.workerHeartbeatService.triggerWakeup({
          agentId,
          reason: "manual",
          prompt,
          taskKey: taskKey?.trim() || null,
          issueKey: issueKey?.trim() || null,
        } satisfies CtoTriggerAgentWakeupArgs);
        return { success: true, ...result };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.getWorkerStatus = tool({
    description: "Inspect a worker agent, including its memory and recent runs.",
    inputSchema: z.object({
      agentId: z.string(),
    }),
    execute: async ({ agentId }) => {
      if (!deps.workerAgentService) return { success: false, error: "Worker service is not available." };
      const worker = deps.workerAgentService.getAgent(agentId, { includeDeleted: true });
      if (!worker) return { success: false, error: `Worker not found: ${agentId}` };
      const recentRuns = deps.workerHeartbeatService?.listRuns({ agentId, limit: 10 }) ?? [];
      const coreMemory = deps.workerAgentService.getCoreMemory(agentId);
      return {
        success: true,
        worker,
        statusSummary: summarizeWorkerStatus(worker.status),
        coreMemory,
        recentRuns,
      };
    },
  });

  tools.listPullRequests = tool({
    description: "List ADE-managed pull requests so the CTO can inspect active review state.",
    inputSchema: z.object({
      refresh: z.boolean().optional().default(true),
    }),
    execute: async ({ refresh }) => {
      if (!deps.prService) return { success: false, error: "PR service is not available." };
      try {
        const prs = refresh ? await deps.prService.refresh() : deps.prService.listAll();
        return { success: true, count: prs.length, prs };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.getPullRequestStatus = tool({
    description: "Inspect pull request status, checks, reviews, and comments through ADE's PR service.",
    inputSchema: z.object({
      prId: z.string().trim().min(1),
      includeChecks: z.boolean().optional().default(true),
      includeReviews: z.boolean().optional().default(true),
      includeComments: z.boolean().optional().default(false),
    }),
    execute: async ({ prId, includeChecks, includeReviews, includeComments }) => {
      if (!deps.prService) return { success: false, error: "PR service is not available." };
      try {
        const summary = deps.prService.listAll().find((entry) => entry.id === prId) ?? null;
        const [status, checks, reviews, comments] = await Promise.all([
          deps.prService.getStatus(prId),
          includeChecks ? deps.prService.getChecks(prId) : Promise.resolve([]),
          includeReviews ? deps.prService.getReviews(prId) : Promise.resolve([]),
          includeComments ? deps.prService.getComments(prId) : Promise.resolve([]),
        ]);
        return {
          success: true,
          prId,
          summary,
          status,
          checks,
          reviews,
          comments,
        };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.commentOnPullRequest = tool({
    description: "Post a comment to a pull request through ADE's PR service.",
    inputSchema: z.object({
      prId: z.string().trim().min(1),
      body: z.string().trim().min(1),
    }),
    execute: async ({ prId, body }) => {
      if (!deps.prService) return { success: false, error: "PR service is not available." };
      try {
        const comment = await deps.prService.addComment({ prId, body });
        return { success: true, comment };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.updatePullRequestTitle = tool({
    description: "Update a pull request title through ADE's PR service.",
    inputSchema: z.object({
      prId: z.string().trim().min(1),
      title: z.string().trim().min(1),
    }),
    execute: async ({ prId, title }) => {
      if (!deps.prService) return { success: false, error: "PR service is not available." };
      try {
        await deps.prService.updateTitle({ prId, title });
        return { success: true, prId, title };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.updatePullRequestBody = tool({
    description: "Update a pull request body through ADE's PR service.",
    inputSchema: z.object({
      prId: z.string().trim().min(1),
      body: z.string().min(1),
    }),
    execute: async ({ prId, body }) => {
      if (!deps.prService) return { success: false, error: "PR service is not available." };
      try {
        await deps.prService.updateDescription({ prId, body });
        return { success: true, prId };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.getPullRequestConvergence = tool({
    description: "Read the persisted PR convergence runtime, pipeline settings, and issue inventory summary for a pull request.",
    inputSchema: z.object({
      prId: z.string().trim().min(1),
    }),
    execute: async ({ prId }) => {
      if (!deps.prService) return { success: false, error: "PR service is not available." };
      try {
        const context = await loadPrConvergenceContext(deps, prId);
        return {
          success: true,
          pr: context.pr,
          status: context.status,
          runtime: context.runtime,
          pipelineSettings: context.pipelineSettings,
          persistedInventory: context.persistedInventory,
          inventory: {
            summary: context.inventory.summary,
            items: context.inventory.items.map(mapInventoryItemView),
          },
          ...(context.runtime?.activeSessionId ? buildNavigationPayload(buildNavigationSuggestion({
            surface: "work",
            laneId: context.runtime.activeLaneId ?? context.pr.laneId,
            sessionId: context.runtime.activeSessionId,
          })) : {}),
        };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.updatePullRequestConvergencePipeline = tool({
    description: "Edit the persisted PR convergence pipeline settings for auto-merge and round handling.",
    inputSchema: z.object({
      prId: z.string().trim().min(1),
      autoMerge: z.boolean().optional(),
      mergeMethod: z.enum(["merge", "squash", "rebase", "repo_default"]).optional(),
      maxRounds: z.number().int().positive().max(20).optional(),
      onRebaseNeeded: z.enum(["pause", "auto_rebase"]).optional(),
    }),
    execute: async ({ prId, autoMerge, mergeMethod, maxRounds, onRebaseNeeded }) => {
      if (!deps.issueInventoryService) {
        return { success: false, error: "Issue inventory service is not available." };
      }
      try {
        const patch = Object.fromEntries(
          Object.entries({ autoMerge, mergeMethod, maxRounds, onRebaseNeeded })
            .filter(([, v]) => v !== undefined),
        );
        if (Object.keys(patch).length === 0) {
          return { success: false, error: "No pipeline fields were provided." };
        }
        deps.issueInventoryService.savePipelineSettings(prId, patch);
        return {
          success: true,
          prId,
          pipelineSettings: deps.issueInventoryService.getPipelineSettings(prId),
        };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.updatePullRequestConvergenceRuntime = tool({
    description: "Edit the persisted PR convergence runtime object that tracks status, session, and polling state.",
    inputSchema: z.object({
      prId: z.string().trim().min(1),
      autoConvergeEnabled: z.boolean().optional(),
      autoConverge: z.boolean().optional(),
      status: z.enum(["idle", "launching", "running", "polling", "paused", "converged", "merged", "failed", "cancelled", "stopped"]).optional(),
      pollerStatus: z.enum(["idle", "scheduled", "polling", "waiting_for_checks", "waiting_for_comments", "paused", "stopped"]).optional(),
      currentRound: z.number().int().min(0).optional(),
      activeSessionId: z.string().nullable().optional(),
      activeLaneId: z.string().nullable().optional(),
      activeHref: z.string().nullable().optional(),
      pauseReason: z.string().nullable().optional(),
      errorMessage: z.string().nullable().optional(),
      lastStartedAt: z.string().nullable().optional(),
      lastPolledAt: z.string().nullable().optional(),
      lastPausedAt: z.string().nullable().optional(),
      lastStoppedAt: z.string().nullable().optional(),
    }),
    execute: async (input) => {
      if (!deps.issueInventoryService) {
        return { success: false, error: "Issue inventory service is not available." };
      }
      try {
        const patch = buildRuntimePatch(input);
        if (Object.keys(patch).length === 0) {
          return { success: false, error: "No runtime fields were provided." };
        }
        const runtime = deps.issueInventoryService.saveConvergenceRuntime(input.prId, patch);
        return { success: true, prId: input.prId, runtime };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.startPullRequestConvergenceRound = tool({
    description: "Launch the next PR convergence round through the existing PR issue-resolution workflow.",
    inputSchema: z.object({
      prId: z.string().trim().min(1),
      scope: z.enum(["checks", "comments", "both"]).optional().default("both"),
      modelId: z.string().trim().min(1).optional(),
      reasoning: z.string().nullable().optional(),
      permissionMode: z.enum(["read_only", "guarded_edit", "full_edit"]).optional(),
      additionalInstructions: z.string().nullable().optional(),
      autoConvergeEnabled: z.boolean().optional().default(true),
    }),
    execute: async ({ prId, scope, modelId, reasoning, permissionMode, additionalInstructions, autoConvergeEnabled }) => {
      if (!deps.prService) {
        return { success: false, error: "PR service is not available." };
      }
      try {
        const resolvedModelId = modelId?.trim() || deps.defaultModelId?.trim() || null;
        if (!resolvedModelId) {
          return { success: false, error: "A modelId is required to launch a convergence round." };
        }
        const resolvedReasoning = reasoning ?? deps.defaultReasoningEffort ?? null;

        if (!deps.issueInventoryService) {
          return { success: false, error: "Issue inventory service is not available." };
        }

        const result = await launchPrIssueResolutionChat(
          {
            prService: deps.prService,
            laneService: {
              list: deps.laneService.list,
              getLaneBaseAndBranch: deps.laneService.getLaneBaseAndBranch,
            },
            agentChatService: {
              createSession: deps.createChat,
              sendMessage: deps.sendChatMessage,
              previewSessionToolNames: deps.previewSessionToolNames,
            },
            sessionService: deps.sessionService,
            issueInventoryService: deps.issueInventoryService,
          },
          {
            prId,
            scope,
            modelId: resolvedModelId,
            reasoning: resolvedReasoning,
            permissionMode,
            additionalInstructions: additionalInstructions ?? null,
          },
        );

        let runtime: ConvergenceRuntimeState | null = null;
        try {
          const status = deps.issueInventoryService.getConvergenceStatus(prId);
          runtime = deps.issueInventoryService.saveConvergenceRuntime(prId, {
            autoConvergeEnabled,
            currentRound: status.currentRound,
            status: "running",
            pollerStatus: "waiting_for_comments",
            activeSessionId: result.sessionId,
            activeLaneId: result.laneId,
            activeHref: result.href,
            pauseReason: null,
            errorMessage: null,
            lastStartedAt: nowIso(),
            lastPolledAt: null,
            lastPausedAt: null,
            lastStoppedAt: null,
          });
        } catch (inventoryError) {
          console.error(
            `[convergence] Failed to update runtime for PR ${prId}: ${getErrorMessage(inventoryError)}`,
          );
        }

        return {
          success: true,
          prId,
          sessionId: result.sessionId,
          laneId: result.laneId,
          href: result.href,
          runtime,
          ...buildNavigationPayload(buildNavigationSuggestion({
            surface: "work",
            laneId: result.laneId,
            sessionId: result.sessionId,
          })),
        };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.stopPullRequestConvergence = tool({
    description: "Stop an active PR convergence run, interrupt the chat session, and persist the stopped runtime state.",
    inputSchema: z.object({
      prId: z.string().trim().min(1),
      sessionId: z.string().trim().min(1).optional(),
      reason: z.string().nullable().optional(),
    }),
    execute: async ({ prId, sessionId, reason }) => {
      try {
        const currentRuntime = deps.issueInventoryService?.getConvergenceRuntime(prId) ?? null;
        const activeSessionId = sessionId?.trim() || currentRuntime?.activeSessionId || null;
        if (!activeSessionId) {
          return { success: false, error: "No active convergence session was found to stop." };
        }
        await deps.interruptChat({ sessionId: activeSessionId });

        const stoppedRuntime = currentRuntime?.activeSessionId === activeSessionId
          ? deps.issueInventoryService?.saveConvergenceRuntime(prId, {
              autoConvergeEnabled: false,
              status: "stopped",
              pollerStatus: "stopped",
              activeSessionId: null,
              activeLaneId: null,
              activeHref: null,
              pauseReason: reason?.trim() || null,
              errorMessage: null,
              lastStoppedAt: nowIso(),
            }) ?? null
          : currentRuntime;

        return {
          success: true,
          prId,
          sessionId: activeSessionId,
          runtime: stoppedRuntime,
        };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.listFileWorkspaces = tool({
    description: "List ADE file workspaces so the CTO can inspect files by lane or attached workspace.",
    inputSchema: z.object({
      includeArchived: z.boolean().optional().default(true),
    }),
    execute: async ({ includeArchived }) => {
      if (!deps.fileService) return { success: false, error: "File service is not available." };
      const workspaces = deps.fileService.listWorkspaces({ includeArchived });
      return { success: true, count: workspaces.length, workspaces };
    },
  });

  tools.readWorkspaceFile = tool({
    description: "Read a file from an ADE workspace or lane without opening the renderer editor.",
    inputSchema: z.object({
      workspaceId: z.string().trim().min(1).optional(),
      laneId: z.string().trim().min(1).optional(),
      path: z.string().trim().min(1),
    }),
    execute: async ({ workspaceId, laneId, path }) => {
      if (!deps.fileService) return { success: false, error: "File service is not available." };
      try {
        const resolvedWorkspaceId = resolveWorkspaceIdForLane(deps, {
          workspaceId,
          laneId,
        });
        const file = deps.fileService.readFile({ workspaceId: resolvedWorkspaceId, path });
        return {
          success: true,
          workspaceId: resolvedWorkspaceId,
          path,
          file,
        };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.searchWorkspaceText = tool({
    description: "Search indexed text inside an ADE workspace or lane.",
    inputSchema: z.object({
      workspaceId: z.string().trim().min(1).optional(),
      laneId: z.string().trim().min(1).optional(),
      query: z.string().trim().min(1),
      limit: z.number().int().positive().max(200).optional().default(50),
    }),
    execute: async ({ workspaceId, laneId, query, limit }) => {
      if (!deps.fileService) return { success: false, error: "File service is not available." };
      try {
        const resolvedWorkspaceId = resolveWorkspaceIdForLane(deps, {
          workspaceId,
          laneId,
        });
        const matches = await deps.fileService.searchText({
          workspaceId: resolvedWorkspaceId,
          query,
          limit,
        });
        return {
          success: true,
          workspaceId: resolvedWorkspaceId,
          count: matches.length,
          matches,
        };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.listManagedProcesses = tool({
    description: "Inspect ADE-managed processes for a lane, including configured definitions and current runtime state.",
    inputSchema: z.object({
      laneId: z.string().optional(),
    }),
    execute: async ({ laneId }) => {
      if (!deps.processService) return { success: false, error: "Process service is not available." };
      const resolvedLaneId = laneId?.trim() || deps.defaultLaneId;
      try {
        const [definitions, runtime] = await Promise.all([
          Promise.resolve(deps.processService.listDefinitions()),
          Promise.resolve(deps.processService.listRuntime(resolvedLaneId)),
        ]);
        return {
          success: true,
          laneId: resolvedLaneId,
          definitions,
          runtime,
          ...buildNavigationPayload(buildNavigationSuggestion({
            surface: "lanes",
            laneId: resolvedLaneId,
          })),
        };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.startManagedProcess = tool({
    description: "Start an ADE-managed lane process.",
    inputSchema: z.object({
      laneId: z.string().trim().min(1).optional(),
      processId: z.string().trim().min(1),
    }),
    execute: async ({ laneId, processId }) => {
      if (!deps.processService) return { success: false, error: "Process service is not available." };
      try {
        const runtime = await deps.processService.start({
          laneId: laneId?.trim() || deps.defaultLaneId,
          processId,
        });
        return { success: true, runtime };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.stopManagedProcess = tool({
    description: "Stop an ADE-managed lane process.",
    inputSchema: z.object({
      laneId: z.string().trim().min(1).optional(),
      processId: z.string().trim().min(1),
    }),
    execute: async ({ laneId, processId }) => {
      if (!deps.processService) return { success: false, error: "Process service is not available." };
      try {
        const runtime = await deps.processService.stop({
          laneId: laneId?.trim() || deps.defaultLaneId,
          processId,
        });
        return { success: true, runtime };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.getManagedProcessLog = tool({
    description: "Read the bounded tail of an ADE-managed process log.",
    inputSchema: z.object({
      laneId: z.string().trim().min(1).optional(),
      processId: z.string().trim().min(1),
      maxBytes: z.number().int().positive().max(500_000).optional().default(40_000),
    }),
    execute: async ({ laneId, processId, maxBytes }) => {
      if (!deps.processService) return { success: false, error: "Process service is not available." };
      try {
        const content = deps.processService.getLogTail({
          laneId: laneId?.trim() || deps.defaultLaneId,
          processId,
          maxBytes,
        });
        return { success: true, laneId: laneId?.trim() || deps.defaultLaneId, processId, content };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.listLinearWorkflows = tool({
    description: "List active and queued Linear workflow runs managed by ADE.",
    inputSchema: z.object({}),
    execute: async () => {
      if (!deps.linearDispatcherService) return { success: false, error: "Linear dispatcher service is not available." };
      return {
        success: true,
        activeRuns: deps.linearDispatcherService.listActiveRuns(),
        queuedRuns: deps.linearDispatcherService.listQueue().slice(0, 50),
      };
    },
  });

  tools.getLinearRunStatus = tool({
    description: "Inspect a Linear workflow run in detail.",
    inputSchema: z.object({
      runId: z.string(),
    }),
    execute: async ({ runId }) => {
      if (!deps.linearDispatcherService || !deps.flowPolicyService) {
        return { success: false, error: "Linear workflow services are not available." };
      }
      const policy: LinearWorkflowConfig = deps.flowPolicyService.getPolicy();
      const detail = await deps.linearDispatcherService.getRunDetail(runId, policy);
      if (!detail) return { success: false, error: `Workflow run not found: ${runId}` };
      return { success: true, detail };
    },
  });

  tools.resolveLinearRunAction = tool({
    description: "Approve, reject, retry, resume, or explicitly complete a Linear workflow run from chat.",
    inputSchema: z.object({
      runId: z.string(),
      action: z.enum(["approve", "reject", "retry", "resume", "complete"]),
      note: z.string().optional(),
      laneId: z.string().optional(),
    }),
    execute: async ({ runId, action, note, laneId }) => {
      if (!deps.linearDispatcherService || !deps.flowPolicyService) {
        return { success: false, error: "Linear workflow services are not available." };
      }
      try {
        const run = await deps.linearDispatcherService.resolveRunAction(
          runId,
          action,
          note?.trim() || undefined,
          deps.flowPolicyService.getPolicy(),
          undefined,
          laneId?.trim() || undefined,
        );
        if (!run) return { success: false, error: `Workflow run not found: ${runId}` };
        return { success: true, run };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.cancelLinearRun = tool({
    description: "Cancel a Linear workflow run and record the operator reason.",
    inputSchema: z.object({
      runId: z.string(),
      reason: z.string(),
    }),
    execute: async ({ runId, reason }) => {
      if (!deps.linearDispatcherService || !deps.flowPolicyService) {
        return { success: false, error: "Linear workflow services are not available." };
      }
      try {
        await deps.linearDispatcherService.cancelRun(runId, reason.trim(), deps.flowPolicyService.getPolicy());
        const detail = await deps.linearDispatcherService.getRunDetail(runId, deps.flowPolicyService.getPolicy());
        return { success: true, runId, detail };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.commentOnLinearIssue = tool({
    description: "Post a comment to a Linear issue.",
    inputSchema: z.object({
      issueId: z.string(),
      body: z.string(),
    }),
    execute: async ({ issueId, body }) => {
      if (!deps.issueTracker) return { success: false, error: "Linear issue tracker is not available." };
      try {
        const comment = await deps.issueTracker.createComment(issueId, body);
        return { success: true, comment };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.updateLinearIssueState = tool({
    description: "Move a Linear issue to a new state by state ID or exact state name.",
    inputSchema: z.object({
      issueId: z.string(),
      stateId: z.string().optional(),
      stateName: z.string().optional(),
    }),
    execute: async ({ issueId, stateId, stateName }) => {
      if (!deps.issueTracker) return { success: false, error: "Linear issue tracker is not available." };
      try {
        let resolvedStateId = stateId?.trim() || "";
        if (!resolvedStateId && stateName?.trim()) {
          const issue = await deps.issueTracker.fetchIssueById(issueId);
          if (!issue?.teamKey) {
            return { success: false, error: "Could not resolve the issue team to look up workflow states." };
          }
          const states = await deps.issueTracker.fetchWorkflowStates(issue.teamKey);
          const match = states.find((entry) => entry.name.toLowerCase() === stateName.trim().toLowerCase()) ?? null;
          if (!match) {
            return { success: false, error: `No workflow state named '${stateName}' for team ${issue.teamKey}.` };
          }
          resolvedStateId = match.id;
        }
        if (!resolvedStateId) {
          return { success: false, error: "Provide either stateId or stateName." };
        }
        await deps.issueTracker.updateIssueState(issueId, resolvedStateId);
        return { success: true, issueId, stateId: resolvedStateId };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.routeLinearIssueToCto = tool({
    description: "Route a Linear issue into the persistent CTO session.",
    inputSchema: z.object({
      issueId: z.string(),
      laneId: z.string().optional(),
      reuseExisting: z.boolean().optional().default(true),
    }),
    execute: async ({ issueId, laneId, reuseExisting }) => routeIssueToCto({ issueId, laneId, reuseExisting }),
  });

  tools.routeLinearIssueToMission = tool({
    description: "Create a mission from a Linear issue and optionally launch it.",
    inputSchema: z.object({
      issueId: z.string(),
      laneId: z.string().optional(),
      launch: z.boolean().optional().default(true),
      runMode: z.enum(["autopilot", "manual"]).optional().default("autopilot"),
    }),
    execute: async ({ issueId, laneId, launch, runMode }) => routeIssueToMission({ issueId, laneId, launch, runMode }),
  });

  tools.routeLinearIssueToWorker = tool({
    description: "Wake a worker agent with a Linear issue as the task context.",
    inputSchema: z.object({
      issueId: z.string(),
      agentId: z.string(),
      taskKey: z.string().optional(),
    }),
    execute: async ({ issueId, agentId, taskKey }) => routeIssueToWorker({ issueId, agentId, taskKey }),
  });

  tools.rerouteLinearRun = tool({
    description: "Recover a Linear workflow run by canceling the current run if needed and re-routing its issue.",
    inputSchema: z.object({
      runId: z.string(),
      target: z.enum(["cto", "mission", "worker"]),
      reason: z.string(),
      laneId: z.string().optional(),
      reuseExisting: z.boolean().optional().default(true),
      launch: z.boolean().optional().default(true),
      runMode: z.enum(["autopilot", "manual"]).optional().default("autopilot"),
      agentId: z.string().optional(),
      taskKey: z.string().optional(),
    }),
    execute: async ({ runId, target, reason, laneId, reuseExisting, launch, runMode, agentId, taskKey }) => {
      if (!deps.linearDispatcherService || !deps.flowPolicyService) {
        return { success: false, error: "Linear workflow services are not available." };
      }
      const policy = getLinearPolicy();
      if (!policy) return { success: false, error: "Linear workflow policy is not available." };
      try {
        const detail = await deps.linearDispatcherService.getRunDetail(runId, policy);
        if (!detail) return { success: false, error: `Workflow run not found: ${runId}` };
        const wasCancelled = ACTIVE_LINEAR_RUN_STATUSES.has(detail.run.status);
        if (wasCancelled) {
          await deps.linearDispatcherService.cancelRun(
            runId,
            `${reason.trim()} (rerouted by CTO)`,
            policy,
          );
        }
        const issueId = detail.run.issueId || String(detail.issue?.id ?? "").trim();
        if (!issueId) {
          return { success: false, error: `Workflow run ${runId} has no associated issue to reroute.` };
        }
        const rerouted = target === "cto"
          ? await routeIssueToCto({ issueId, laneId, reuseExisting })
          : target === "mission"
            ? await routeIssueToMission({ issueId, laneId, launch, runMode })
            : await routeIssueToWorker({ issueId, agentId: agentId?.trim() || "", taskKey });
        if (!rerouted.success) return rerouted;
        return {
          success: true,
          runId,
          issueId,
          cancelledExistingRun: wasCancelled,
          rerouted,
        };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  // ---------------------------------------------------------------------------
  // PR Creation & Management
  // ---------------------------------------------------------------------------

  tools.createPrFromLane = tool({
    description: "Create a pull request from an ADE lane against its parent branch.",
    inputSchema: z.object({
      laneId: z.string().trim().min(1),
      title: z.string().trim().min(1),
      body: z.string().optional(),
      draft: z.boolean().optional().default(false),
    }),
    execute: async ({ laneId, title, body, draft }) => {
      if (!deps.prService) return { success: false, error: "PR service is not available." };
      try {
        const pr = await deps.prService.createFromLane({ laneId, title, body: body ?? "", draft });
        return { success: true, pr };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.landPullRequest = tool({
    description: "Land (merge) an ADE-managed pull request.",
    inputSchema: z.object({
      prId: z.string().trim().min(1),
      method: z.enum(["merge", "squash", "rebase"]).optional().default("squash"),
      archiveLane: z.boolean().optional().default(true),
    }),
    execute: async ({ prId, method, archiveLane }) => {
      if (!deps.prService) return { success: false, error: "PR service is not available." };
      try {
        const result = await deps.prService.land({ prId, method, archiveLane });
        return result;
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.closePullRequest = tool({
    description: "Close an ADE-managed pull request without merging.",
    inputSchema: z.object({
      prId: z.string().trim().min(1),
    }),
    execute: async ({ prId }) => {
      if (!deps.prService) return { success: false, error: "PR service is not available." };
      try {
        await deps.prService.closePr({ prId });
        return { success: true, prId };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.requestPrReviewers = tool({
    description: "Request reviewers on an ADE-managed pull request.",
    inputSchema: z.object({
      prId: z.string().trim().min(1),
      reviewers: z.array(z.string().trim().min(1)).min(1),
    }),
    execute: async ({ prId, reviewers }) => {
      if (!deps.prService) return { success: false, error: "PR service is not available." };
      try {
        await deps.prService.requestReviewers({ prId, reviewers });
        return { success: true, prId, reviewers };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.getPullRequestDiff = tool({
    description:
      "Retrieve the code diff for an ADE-managed pull request. " +
      "Returns per-file patches from GitHub. Use `files` to limit to specific paths. " +
      "Output is truncated to `maxChars` (default 80 000) to stay within context budgets.",
    inputSchema: z.object({
      prId: z.string().trim().min(1),
      files: z
        .array(z.string().trim().min(1))
        .optional()
        .describe("Optional list of file paths to include. Omit for full diff."),
      maxChars: z
        .number()
        .int()
        .min(1000)
        .max(400_000)
        .optional()
        .default(80_000)
        .describe("Maximum total characters of patch text to return."),
    }),
    execute: async ({ prId, files: filterFiles, maxChars }) => {
      if (!deps.prService) return { success: false, error: "PR service is not available." };
      try {
        let prFiles = await deps.prService.getFiles(prId);
        if (filterFiles && filterFiles.length > 0) {
          const allowed = new Set(filterFiles);
          prFiles = prFiles.filter((f) => allowed.has(f.filename));
        }
        // Build bounded output
        let totalChars = 0;
        let truncated = false;
        const patches: Array<{
          filename: string;
          status: string;
          additions: number;
          deletions: number;
          patch: string | null;
        }> = [];
        for (const f of prFiles) {
          const patchLen = f.patch?.length ?? 0;
          if (totalChars + patchLen > maxChars && patches.length > 0) {
            truncated = true;
            break;
          }
          patches.push({
            filename: f.filename,
            status: f.status,
            additions: f.additions,
            deletions: f.deletions,
            patch: f.patch,
          });
          totalChars += patchLen;
        }
        return {
          success: true,
          prId,
          fileCount: prFiles.length,
          returnedCount: patches.length,
          truncated,
          patches,
        };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.approvePullRequest = tool({
    description: "Submit an APPROVE review on an ADE-managed pull request.",
    inputSchema: z.object({
      prId: z.string().trim().min(1),
      body: z
        .string()
        .optional()
        .default("")
        .describe("Optional approval comment body."),
    }),
    execute: async ({ prId, body }) => {
      if (!deps.prService) return { success: false, error: "PR service is not available." };
      try {
        await deps.prService.submitReview({ prId, event: "APPROVE", body });
        return { success: true, prId, event: "APPROVE" };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.requestPrChanges = tool({
    description:
      "Submit a REQUEST_CHANGES review on an ADE-managed pull request with a comment explaining what needs to change.",
    inputSchema: z.object({
      prId: z.string().trim().min(1),
      body: z.string().trim().min(1).describe("Review comment explaining the requested changes."),
    }),
    execute: async ({ prId, body }) => {
      if (!deps.prService) return { success: false, error: "PR service is not available." };
      try {
        await deps.prService.submitReview({ prId, event: "REQUEST_CHANGES", body });
        return { success: true, prId, event: "REQUEST_CHANGES" };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  // ---------------------------------------------------------------------------
  // Lane Management
  // ---------------------------------------------------------------------------

  tools.deleteLane = tool({
    description: "Delete an ADE lane and its associated worktree. This is destructive — the worktree and branch are removed.",
    inputSchema: z.object({
      laneId: z.string().trim().min(1).describe("ID of the lane to delete."),
    }),
    execute: async ({ laneId }) => {
      try {
        await deps.laneService.delete({ laneId });
        return { success: true, laneId };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.renameLane = tool({
    description: "Rename a lane's display name. Does not change the git branch name.",
    inputSchema: z.object({
      laneId: z.string().trim().min(1).describe("ID of the lane to rename."),
      name: z.string().trim().min(1).describe("New display name for the lane."),
    }),
    execute: async ({ laneId, name }) => {
      try {
        await deps.laneService.rename({ laneId, name });
        return { success: true, laneId, name };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.archiveLane = tool({
    description: "Archive a lane — hides it from the default lane list but preserves all data and the worktree.",
    inputSchema: z.object({
      laneId: z.string().trim().min(1).describe("ID of the lane to archive."),
    }),
    execute: async ({ laneId }) => {
      try {
        await deps.laneService.archive({ laneId });
        return { success: true, laneId };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  // ---------------------------------------------------------------------------
  // Worker Management
  // ---------------------------------------------------------------------------

  tools.removeWorker = tool({
    description: "Remove a worker agent from the CTO org.",
    inputSchema: z.object({
      agentId: z.string().trim().min(1),
    }),
    execute: async ({ agentId }) => {
      if (!deps.workerAgentService) return { success: false, error: "Worker service is not available." };
      try {
        deps.workerAgentService.removeAgent(agentId);
        return { success: true, agentId };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.updateWorker = tool({
    description: "Update a worker agent configuration.",
    inputSchema: z.object({
      agentId: z.string().trim().min(1),
      name: z.string().optional(),
      role: z.enum(["engineer", "qa", "designer", "devops", "researcher", "general"]).optional(),
      title: z.string().nullable().optional(),
      reportsTo: z.string().nullable().optional(),
      capabilities: z.array(z.string()).optional(),
      modelId: z.string().nullable().optional(),
      budgetMonthlyCents: z.number().int().nonnegative().optional(),
    }),
    execute: async ({ agentId, name, role, title, reportsTo, capabilities, modelId, budgetMonthlyCents }) => {
      if (!deps.workerAgentService) return { success: false, error: "Worker service is not available." };
      const existing = deps.workerAgentService.getAgent(agentId);
      if (!existing) return { success: false, error: `Worker not found: ${agentId}` };
      try {
        const worker = deps.workerAgentService.saveAgent({
          id: agentId,
          name: name ?? existing.name,
          role: role ?? existing.role,
          ...(title !== undefined ? { title: title ?? undefined } : {}),
          ...(reportsTo !== undefined ? { reportsTo } : {}),
          ...(capabilities ? { capabilities } : {}),
          adapterType: existing.adapterType,
          adapterConfig: modelId !== undefined ? { ...existing.adapterConfig, modelId: modelId ?? undefined } : existing.adapterConfig,
          ...(budgetMonthlyCents !== undefined ? { budgetMonthlyCents } : {}),
        });
        return { success: true, worker };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  // ---------------------------------------------------------------------------
  // Test Management
  // ---------------------------------------------------------------------------

  tools.listTestSuites = tool({
    description: "List available test suites that can be run in ADE.",
    inputSchema: z.object({}),
    execute: async () => {
      if (!deps.testService) return { success: false, error: "Test service is not available." };
      const suites = deps.testService.listSuites();
      return { success: true, count: suites.length, suites };
    },
  });

  tools.runTests = tool({
    description: "Run a test suite in a specific ADE lane.",
    inputSchema: z.object({
      laneId: z.string().trim().min(1),
      suiteId: z.string().trim().min(1),
    }),
    execute: async ({ laneId, suiteId }) => {
      if (!deps.testService) return { success: false, error: "Test service is not available." };
      try {
        const run = await deps.testService.run({ laneId, suiteId });
        return { success: true, run };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.stopTestRun = tool({
    description: "Stop a running test execution.",
    inputSchema: z.object({
      runId: z.string().trim().min(1),
    }),
    execute: async ({ runId }) => {
      if (!deps.testService) return { success: false, error: "Test service is not available." };
      try {
        deps.testService.stop({ runId });
        return { success: true, runId };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.listTestRuns = tool({
    description: "List recent test runs, optionally filtered by lane or suite.",
    inputSchema: z.object({
      laneId: z.string().optional(),
      suiteId: z.string().optional(),
      limit: z.number().int().positive().max(100).optional().default(20),
    }),
    execute: async ({ laneId, suiteId, limit }) => {
      if (!deps.testService) return { success: false, error: "Test service is not available." };
      const runs = deps.testService.listRuns({
        ...(laneId?.trim() ? { laneId: laneId.trim() } : {}),
        ...(suiteId?.trim() ? { suiteId: suiteId.trim() } : {}),
        limit,
      });
      return { success: true, count: runs.length, runs };
    },
  });

  tools.getTestLog = tool({
    description: "Read the tail of a test run log.",
    inputSchema: z.object({
      runId: z.string().trim().min(1),
      maxBytes: z.number().int().positive().max(500_000).optional().default(40_000),
    }),
    execute: async ({ runId, maxBytes }) => {
      if (!deps.testService) return { success: false, error: "Test service is not available." };
      try {
        const content = deps.testService.getLogTail({ runId, maxBytes });
        return { success: true, runId, content };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  // ---------------------------------------------------------------------------
  // Terminal Management
  // ---------------------------------------------------------------------------

  tools.createTerminal = tool({
    description: "Open a shell terminal (PTY) in a lane. Use for raw CLI commands only — for AI-powered work, use spawnChat instead. This does NOT create an AI chat session.",
    inputSchema: z.object({
      laneId: z.string().trim().min(1),
      title: z.string().optional(),
      startupCommand: z.string().optional(),
    }),
    execute: async ({ laneId, title, startupCommand }) => {
      if (!deps.ptyService) return { success: false, error: "Terminal service is not available." };
      try {
        const result = await deps.ptyService.create({
          laneId,
          ...(title?.trim() ? { title: title.trim() } : {}),
          ...(startupCommand?.trim() ? { startupCommand: startupCommand.trim() } : {}),
          tracked: true,
        });
        return { success: true, ...result };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  // ---------------------------------------------------------------------------
  // Linear Issue Discovery
  // ---------------------------------------------------------------------------

  tools.listLinearIssues = tool({
    description: "Search Linear issues by project slug and state.",
    inputSchema: z.object({
      projectSlugs: z.array(z.string()).optional(),
      stateTypes: z.array(z.string()).optional(),
      limit: z.number().int().positive().max(100).optional().default(25),
    }),
    execute: async ({ projectSlugs, stateTypes, limit }) => {
      if (!deps.issueTracker) return { success: false, error: "Linear issue tracker is not available." };
      try {
        const issues = await deps.issueTracker.fetchCandidateIssues({
          projectSlugs: projectSlugs ?? [],
          stateTypes: stateTypes ?? ["started", "unstarted"],
        });
        const limited = issues.slice(0, limit);
        return {
          success: true,
          count: limited.length,
          totalAvailable: issues.length,
          issues: limited.map((issue) => ({
            id: issue.id,
            identifier: issue.identifier,
            title: issue.title,
            stateName: issue.stateName,
            priorityLabel: issue.priorityLabel,
            assigneeName: issue.assigneeName,
            labels: issue.labels,
            projectSlug: issue.projectSlug,
            url: issue.url,
          })),
        };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.getLinearIssue = tool({
    description: "Fetch a single Linear issue by ID or identifier.",
    inputSchema: z.object({
      issueId: z.string().trim().min(1),
    }),
    execute: async ({ issueId }) => {
      if (!deps.issueTracker) return { success: false, error: "Linear issue tracker is not available." };
      try {
        const issue = await deps.issueTracker.fetchIssueById(issueId);
        if (!issue) return { success: false, error: `Issue not found: ${issueId}` };
        return { success: true, issue: buildIssueBrief(issue), raw: issue };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.updateLinearIssueAssignee = tool({
    description: "Assign or unassign a Linear issue.",
    inputSchema: z.object({
      issueId: z.string().trim().min(1),
      assigneeId: z.string().nullable(),
    }),
    execute: async ({ issueId, assigneeId }) => {
      if (!deps.issueTracker) return { success: false, error: "Linear issue tracker is not available." };
      try {
        await deps.issueTracker.updateIssueAssignee(issueId, assigneeId);
        return { success: true, issueId, assigneeId };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.addLinearIssueLabel = tool({
    description: "Add a label to a Linear issue.",
    inputSchema: z.object({
      issueId: z.string().trim().min(1),
      label: z.string().trim().min(1),
    }),
    execute: async ({ issueId, label }) => {
      if (!deps.issueTracker) return { success: false, error: "Linear issue tracker is not available." };
      try {
        await deps.issueTracker.addLabel(issueId, label);
        return { success: true, issueId, label };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  // ---------------------------------------------------------------------------
  // Automation Management
  // ---------------------------------------------------------------------------

  tools.listAutomations = tool({
    description: "List automation rules configured in ADE.",
    inputSchema: z.object({}),
    execute: async () => {
      if (!deps.automationService) return { success: false, error: "Automation service is not available." };
      const rules = deps.automationService.list();
      return { success: true, count: rules.length, rules };
    },
  });

  tools.triggerAutomation = tool({
    description: "Manually trigger an ADE automation rule.",
    inputSchema: z.object({
      automationId: z.string().trim().min(1),
      dryRun: z.boolean().optional().default(false),
    }),
    execute: async ({ automationId, dryRun }) => {
      if (!deps.automationService) return { success: false, error: "Automation service is not available." };
      try {
        const run = await deps.automationService.triggerManually({ id: automationId, dryRun });
        return { success: true, run };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.listAutomationRuns = tool({
    description: "List recent automation run history.",
    inputSchema: z.object({
      limit: z.number().int().positive().max(100).optional().default(20),
    }),
    execute: async ({ limit }) => {
      if (!deps.automationService) return { success: false, error: "Automation service is not available." };
      const runs = deps.automationService.listRuns({ limit });
      return { success: true, count: runs.length, runs };
    },
  });

  // ---------------------------------------------------------------------------
  // Git Operations
  // ---------------------------------------------------------------------------

  const resolveLaneId = (laneId?: string): string => laneId?.trim() || deps.defaultLaneId;

  const gitGuard = async <T>(fn: () => Promise<T>): Promise<{ success: true } & T | { success: false; error: string }> => {
    if (!deps.gitService) return { success: false, error: "Git service is not available." };
    try {
      return { success: true, ...(await fn()) } as { success: true } & T;
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  };

  tools.gitStatus = tool({
    description: "Get the git sync status for a lane (branch, ahead/behind, dirty state).",
    inputSchema: z.object({ laneId: z.string().optional() }),
    execute: ({ laneId }) => gitGuard(() => deps.gitService!.getSyncStatus({ laneId: resolveLaneId(laneId) })),
  });

  tools.gitCommit = tool({
    description: "Create a git commit in a lane. By default stages all changes (stageAll: true). Use gitStatus first to see what will be committed.",
    inputSchema: z.object({ laneId: z.string().optional(), message: z.string().min(1).describe("Commit message."), stageAll: z.boolean().optional().default(true).describe("Stage all changes before committing.") }),
    execute: ({ laneId, message, stageAll }) => gitGuard(() => deps.gitService!.commit({ laneId: resolveLaneId(laneId), message, stageAll })),
  });

  tools.gitPush = tool({
    description: "Push commits to the remote for a lane.",
    inputSchema: z.object({ laneId: z.string().optional(), force: z.boolean().optional().default(false) }),
    execute: ({ laneId, force }) => gitGuard(() => deps.gitService!.push({ laneId: resolveLaneId(laneId), force })),
  });

  tools.gitPull = tool({
    description: "Pull from the remote for a lane.",
    inputSchema: z.object({ laneId: z.string().optional() }),
    execute: ({ laneId }) => gitGuard(() => deps.gitService!.pull({ laneId: resolveLaneId(laneId) })),
  });

  tools.gitFetch = tool({
    description: "Fetch remote refs for a lane.",
    inputSchema: z.object({ laneId: z.string().optional() }),
    execute: ({ laneId }) => gitGuard(() => deps.gitService!.fetch({ laneId: resolveLaneId(laneId) })),
  });

  tools.gitListRecentCommits = tool({
    description: "List recent commits in a lane.",
    inputSchema: z.object({ laneId: z.string().optional(), limit: z.number().int().positive().max(100).optional().default(20) }),
    execute: ({ laneId, limit }) => gitGuard(async () => {
      const commits = await deps.gitService!.listRecentCommits({ laneId: resolveLaneId(laneId), limit });
      return { count: commits.length, commits };
    }),
  });

  tools.gitListBranches = tool({
    description: "List git branches for a lane.",
    inputSchema: z.object({ laneId: z.string().optional() }),
    execute: ({ laneId }) => gitGuard(async () => {
      const branches = await deps.gitService!.listBranches({ laneId: resolveLaneId(laneId) });
      return { count: branches.length, branches };
    }),
  });

  tools.gitCheckoutBranch = tool({
    description: "Switch to or create a git branch in a lane.",
    inputSchema: z.object({ laneId: z.string().optional(), branch: z.string().min(1), create: z.boolean().optional().default(false) }),
    execute: ({ laneId, branch, create }) => gitGuard(() => deps.gitService!.checkoutBranch({ laneId: resolveLaneId(laneId), branch, create })),
  });

  tools.gitStashPush = tool({
    description: "Stash working changes in a lane.",
    inputSchema: z.object({ laneId: z.string().optional(), message: z.string().optional() }),
    execute: ({ laneId, message }) => gitGuard(() => deps.gitService!.stashPush({ laneId: resolveLaneId(laneId), ...(message?.trim() ? { message: message.trim() } : {}) })),
  });

  tools.gitStashPop = tool({
    description: "Pop the latest stash in a lane.",
    inputSchema: z.object({ laneId: z.string().optional() }),
    execute: ({ laneId }) => gitGuard(() => deps.gitService!.stashPop({ laneId: resolveLaneId(laneId) })),
  });

  tools.gitStashList = tool({
    description: "List stashes in a lane.",
    inputSchema: z.object({ laneId: z.string().optional() }),
    execute: ({ laneId }) => gitGuard(async () => {
      const stashes = await deps.gitService!.listStashes({ laneId: resolveLaneId(laneId) });
      return { count: stashes.length, stashes };
    }),
  });

  tools.gitGetConflictState = tool({
    description: "Check if a lane has merge or rebase conflicts in progress.",
    inputSchema: z.object({ laneId: z.string().optional() }),
    execute: ({ laneId }) => gitGuard(() => deps.gitService!.getConflictState({ laneId: resolveLaneId(laneId) })),
  });

  tools.gitRebaseContinue = tool({
    description: "Continue a rebase after resolving conflicts.",
    inputSchema: z.object({ laneId: z.string().optional() }),
    execute: ({ laneId }) => gitGuard(() => deps.gitService!.rebaseContinue({ laneId: resolveLaneId(laneId) })),
  });

  tools.gitRebaseAbort = tool({
    description: "Abort an in-progress rebase.",
    inputSchema: z.object({ laneId: z.string().optional() }),
    execute: ({ laneId }) => gitGuard(() => deps.gitService!.rebaseAbort({ laneId: resolveLaneId(laneId) })),
  });

  tools.gitMergeAbort = tool({
    description: "Abort an in-progress merge.",
    inputSchema: z.object({ laneId: z.string().optional() }),
    execute: ({ laneId }) => gitGuard(() => deps.gitService!.mergeAbort({ laneId: resolveLaneId(laneId) })),
  });

  // ---------------------------------------------------------------------------
  // Conflict Resolution
  // ---------------------------------------------------------------------------

  const conflictGuard = async <T>(fn: () => Promise<T>): Promise<{ success: true } & T | { success: false; error: string }> => {
    if (!deps.conflictService) return { success: false, error: "Conflict service is not available." };
    try {
      return { success: true, ...(await fn()) } as { success: true } & T;
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  };

  tools.getConflictStatus = tool({
    description: "Check merge conflict status for a lane.",
    inputSchema: z.object({ laneId: z.string().optional() }),
    execute: ({ laneId }) => conflictGuard(() => deps.conflictService!.getLaneStatus({ laneId: resolveLaneId(laneId) })),
  });

  tools.getConflictRiskMatrix = tool({
    description: "Get the conflict risk matrix across all lanes.",
    inputSchema: z.object({}),
    execute: () => conflictGuard(async () => {
      const matrix = await deps.conflictService!.getRiskMatrix();
      return { count: matrix.length, entries: matrix };
    }),
  });

  tools.simulateMerge = tool({
    description: "Dry-run merge between two lanes to predict conflicts.",
    inputSchema: z.object({ sourceLaneId: z.string().min(1), targetLaneId: z.string().optional() }),
    execute: ({ sourceLaneId, targetLaneId }) => conflictGuard(() => deps.conflictService!.simulateMerge({ sourceLaneId, targetLaneId: targetLaneId?.trim() || undefined })),
  });

  tools.runConflictPrediction = tool({
    description: "Run batch conflict prediction across all lanes.",
    inputSchema: z.object({}),
    execute: () => conflictGuard(() => deps.conflictService!.runPrediction()),
  });

  tools.listConflictProposals = tool({
    description: "List AI-generated conflict resolution proposals for a lane.",
    inputSchema: z.object({ laneId: z.string().min(1) }),
    execute: ({ laneId }) => conflictGuard(async () => {
      const proposals = await deps.conflictService!.listProposals({ laneId });
      return { count: proposals.length, proposals };
    }),
  });

  tools.requestConflictProposal = tool({
    description: "Request an AI-generated resolution for a specific conflict.",
    inputSchema: z.object({ laneId: z.string().min(1), filePath: z.string().optional() }),
    execute: ({ laneId, filePath }) => conflictGuard(() => deps.conflictService!.requestProposal({ laneId, filePath: filePath?.trim() || undefined })),
  });

  tools.applyConflictProposal = tool({
    description: "Apply an AI-generated conflict resolution proposal.",
    inputSchema: z.object({ laneId: z.string().min(1), proposalId: z.string().min(1) }),
    execute: ({ laneId, proposalId }) => conflictGuard(() => deps.conflictService!.applyProposal({ laneId, proposalId })),
  });

  tools.undoConflictProposal = tool({
    description: "Undo an applied conflict resolution proposal.",
    inputSchema: z.object({ laneId: z.string().min(1), proposalId: z.string().min(1) }),
    execute: ({ laneId, proposalId }) => conflictGuard(() => deps.conflictService!.undoProposal({ laneId, proposalId })),
  });

  // ---------------------------------------------------------------------------
  // Context Pack Export
  // ---------------------------------------------------------------------------

  tools.getContextStatus = tool({
    description: "Check what ADE context docs exist and whether they are stale.",
    inputSchema: z.object({}),
    execute: async () => {
      if (!deps.contextDocService) return { success: false, error: "Context doc service is not available." };
      try {
        return { success: true, ...deps.contextDocService.getStatus() };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.generateContextDocs = tool({
    description: "Generate bounded context packs for bootstrapping workers or exporting project state.",
    inputSchema: z.object({
      scope: z.string().optional(),
      categories: z.array(z.string()).optional(),
    }),
    execute: async ({ scope, categories }) => {
      if (!deps.contextDocService) return { success: false, error: "Context doc service is not available." };
      try {
        return { success: true, ...(await deps.contextDocService.generateDocs({ scope, categories })) };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  // ---------------------------------------------------------------------------
  // Agent Chat Steering
  // ---------------------------------------------------------------------------

  tools.steerChat = tool({
    description: "Inject a steering instruction into an active chat session.",
    inputSchema: z.object({
      sessionId: z.string().min(1),
      instruction: z.string().min(1),
    }),
    execute: async ({ sessionId, instruction }) => {
      if (!deps.steerChat) return { success: false, error: "Chat steering is not available." };
      try {
        await deps.steerChat({ sessionId, instruction });
        return { success: true, sessionId };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.cancelSteer = tool({
    description: "Cancel a pending steer instruction on a chat session.",
    inputSchema: z.object({
      sessionId: z.string().min(1),
    }),
    execute: async ({ sessionId }) => {
      if (!deps.cancelSteer) return { success: false, error: "Chat steering is not available." };
      try {
        await deps.cancelSteer({ sessionId });
        return { success: true, sessionId };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.handoffChat = tool({
    description: "Hand off a chat session to a different agent identity.",
    inputSchema: z.object({
      sessionId: z.string().min(1),
      targetIdentityKey: z.string().optional(),
      reason: z.string().optional(),
    }),
    execute: async ({ sessionId, targetIdentityKey, reason }) => {
      if (!deps.handoffChat) return { success: false, error: "Chat handoff is not available." };
      try {
        return { success: true, ...(await deps.handoffChat({ sessionId, targetIdentityKey, reason })) };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.listSubagents = tool({
    description: "List sub-agents spawned by a chat session.",
    inputSchema: z.object({
      sessionId: z.string().min(1),
    }),
    execute: async ({ sessionId }) => {
      if (!deps.listSubagents) return { success: false, error: "Sub-agent listing is not available." };
      try {
        const subagents = await deps.listSubagents({ sessionId });
        return { success: true, count: subagents.length, subagents };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.approveToolUse = tool({
    description: "Approve or deny a pending tool use in a chat session.",
    inputSchema: z.object({
      sessionId: z.string().min(1),
      toolUseId: z.string().min(1),
      decision: z.enum(["accept", "accept_for_session", "decline", "cancel"]),
    }),
    execute: async ({ sessionId, toolUseId, decision }) => {
      if (!deps.approveToolUse) return { success: false, error: "Tool use approval is not available." };
      try {
        await deps.approveToolUse({ sessionId, toolUseId, decision });
        return { success: true, sessionId, toolUseId, decision };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  // ---------------------------------------------------------------------------
  // Unified Event Feed
  // ---------------------------------------------------------------------------

  type RecentEvent = {
    type: string;
    timestamp: string;
    summary: string;
    ids: Record<string, string | null>;
  };

  tools.getRecentEvents = tool({
    description:
      "Surface a unified feed of recent project events: CTO session completions, worker activity, " +
      "test completions/failures, PR review activity, mission state transitions, and chat session events. " +
      "Use this to stay aware of what happened while you were idle or to brief the user on recent activity.",
    inputSchema: z.object({
      since: z
        .string()
        .optional()
        .describe("ISO 8601 timestamp. Only events after this time are returned. Defaults to 24 hours ago."),
      limit: z
        .number()
        .int()
        .positive()
        .max(200)
        .optional()
        .default(50)
        .describe("Maximum number of events to return."),
    }),
    execute: async ({ since, limit }) => {
      const sinceEpoch = since
        ? parseIsoToEpoch(since)
        : Date.now() - 24 * 60 * 60 * 1000;
      const safeLimit = Math.max(1, Math.min(200, limit));
      const events: RecentEvent[] = [];

      const afterCutoff = (ts: string | null | undefined): boolean => {
        if (!ts) return false;
        const epoch = parseIsoToEpoch(ts);
        return Number.isFinite(epoch) && epoch >= sinceEpoch;
      };

      // 1. CTO session logs
      if (deps.ctoStateService) {
        try {
          const logs = deps.ctoStateService.getSessionLogs(200);
          for (const log of logs) {
            if (!afterCutoff(log.createdAt)) continue;
            events.push({
              type: "cto_session",
              timestamp: log.createdAt,
              summary: log.summary,
              ids: { sessionId: log.sessionId, logId: log.id },
            });
          }
        } catch {
          // CTO state service may not be fully initialized
        }
      }

      // 2. Subordinate (worker) activity from CTO state
      if (deps.ctoStateService) {
        try {
          const activities = deps.ctoStateService.getSubordinateActivityLogs(200);
          for (const activity of activities) {
            if (!afterCutoff(activity.createdAt)) continue;
            events.push({
              type: `worker_${activity.activityType}`,
              timestamp: activity.createdAt,
              summary: `[${activity.agentName}] ${activity.summary}`,
              ids: {
                agentId: activity.agentId,
                sessionId: activity.sessionId ?? null,
                taskKey: activity.taskKey ?? null,
                issueKey: activity.issueKey ?? null,
              },
            });
          }
        } catch {
          // ignore
        }
      }

      // 3. Worker runs from heartbeat service
      if (deps.workerHeartbeatService) {
        try {
          const runs = deps.workerHeartbeatService.listRuns({ limit: 100 });
          for (const run of runs) {
            const ts = run.finishedAt ?? run.startedAt ?? run.createdAt;
            if (!afterCutoff(ts)) continue;
            events.push({
              type: "worker_run",
              timestamp: ts,
              summary: `Worker run ${run.status}${run.taskKey ? ` (task: ${run.taskKey})` : ""}${run.errorMessage ? ` — ${run.errorMessage}` : ""}`,
              ids: {
                runId: run.id,
                agentId: run.agentId,
                taskKey: run.taskKey ?? null,
                issueKey: run.issueKey ?? null,
              },
            });
          }
        } catch {
          // ignore
        }
      }

      // 4. Test runs
      if (deps.testService) {
        try {
          const runs = deps.testService.listRuns({ limit: 100 });
          for (const run of runs) {
            const ts = run.endedAt ?? run.startedAt;
            if (!afterCutoff(ts)) continue;
            const duration = run.durationMs != null ? ` (${Math.round(run.durationMs / 1000)}s)` : "";
            events.push({
              type: "test_run",
              timestamp: ts,
              summary: `${run.suiteName}: ${run.status}${duration}`,
              ids: {
                runId: run.id,
                suiteId: run.suiteId,
                laneId: run.laneId,
              },
            });
          }
        } catch {
          // ignore
        }
      }

      // 5. Mission state transitions
      if (deps.missionService) {
        try {
          const missions = deps.missionService.list({ limit: 50 });
          for (const mission of missions) {
            const ts = mission.completedAt ?? mission.updatedAt;
            if (!afterCutoff(ts)) continue;
            events.push({
              type: "mission_update",
              timestamp: ts,
              summary: `Mission "${mission.title}": ${mission.status}${mission.outcomeSummary ? ` — ${mission.outcomeSummary}` : ""}`,
              ids: {
                missionId: mission.id,
                laneId: mission.laneId,
              },
            });
          }
        } catch {
          // ignore
        }
      }

      // 6. PR review activity (recent events from all tracked PRs)
      if (deps.prService) {
        try {
          const prs = deps.prService.listAll();
          // Fetch activity for the most recently updated PRs to avoid excessive API calls
          const recentPrs = prs
            .filter((pr) => afterCutoff(pr.updatedAt))
            .slice(0, 5);
          for (const pr of recentPrs) {
            try {
              const activity = await deps.prService.getActivity(pr.id);
              for (const ev of activity) {
                if (!afterCutoff(ev.timestamp)) continue;
                events.push({
                  type: `pr_${ev.type}`,
                  timestamp: ev.timestamp,
                  summary: `PR #${pr.githubPrNumber} "${pr.title}": ${ev.body ?? ev.type}${ev.author ? ` (${ev.author})` : ""}`,
                  ids: {
                    prId: pr.id,
                    prNumber: String(pr.githubPrNumber),
                    laneId: pr.laneId,
                  },
                });
              }
            } catch {
              // individual PR activity fetch may fail
            }
          }
        } catch {
          // ignore
        }
      }

      // 7. Chat session events
      try {
        const chats = await deps.listChats(undefined, { includeIdentity: false, includeAutomation: true });
        for (const chat of chats) {
          const ts = chat.endedAt ?? chat.lastActivityAt;
          if (!afterCutoff(ts)) continue;
          events.push({
            type: "chat_session",
            timestamp: ts,
            summary: `Chat "${chat.title ?? chat.sessionId}": ${chat.status}${chat.summary ? ` — ${chat.summary}` : ""}`,
            ids: {
              sessionId: chat.sessionId,
              laneId: chat.laneId,
            },
          });
        }
      } catch {
        // ignore
      }

      // Sort descending by timestamp and apply limit
      events.sort((a, b) => parseIsoToEpoch(b.timestamp) - parseIsoToEpoch(a.timestamp));
      const sliced = events.slice(0, safeLimit);

      return {
        success: true,
        count: sliced.length,
        totalBeforeLimit: events.length,
        since: since ?? new Date(sinceEpoch).toISOString(),
        events: sliced,
      };
    },
  });

  // ---------------------------------------------------------------------------
  // Project Health Dashboard
  // ---------------------------------------------------------------------------

  tools.getProjectHealthSummary = tool({
    description:
      "Aggregate project health into a single snapshot: mission counts by status, worker utilization, test pass rates, PR status distribution, active lanes, and weekly budget burn.",
    inputSchema: z.object({
      testRunLimit: z
        .number()
        .int()
        .positive()
        .max(200)
        .optional()
        .default(50),
    }),
    execute: async ({ testRunLimit }) => {
      let missions: {
        byStatus: Record<string, number>;
        total: number;
        activeCount: number;
        openInterventions: number;
        weekly: { missions: number; successRate: number; avgDurationMs: number; totalCostUsd: number } | null;
      } | null = null;
      if (deps.missionService) {
        const all = deps.missionService.list({ includeArchived: false, limit: 500 });
        const byStatus: Record<string, number> = {};
        let openInterventions = 0;
        for (const m of all) {
          byStatus[m.status] = (byStatus[m.status] ?? 0) + 1;
          openInterventions += m.openInterventions;
        }
        const activeCount = all.filter(
          (m) => m.status === "queued" || m.status === "planning" || m.status === "in_progress" || m.status === "intervention_required",
        ).length;
        let weekly: { missions: number; successRate: number; avgDurationMs: number; totalCostUsd: number } | null = null;
        try {
          const dashboard = (deps.missionService as any).getDashboard?.();
          if (dashboard?.weekly) weekly = dashboard.weekly;
        } catch { /* non-fatal */ }
        missions = { byStatus, total: all.length, activeCount, openInterventions, weekly };
      }

      let workers: {
        total: number;
        byStatus: Record<string, number>;
        totalBudgetMonthlyCents: number;
        totalSpentMonthlyCents: number;
        budgetUtilizationPct: number;
      } | null = null;
      if (deps.workerAgentService) {
        const agents = deps.workerAgentService.listAgents();
        const byStatus: Record<string, number> = {};
        let totalBudget = 0;
        let totalSpent = 0;
        for (const a of agents) {
          byStatus[a.status] = (byStatus[a.status] ?? 0) + 1;
          totalBudget += (a as any).budgetMonthlyCents ?? 0;
          totalSpent += (a as any).spentMonthlyCents ?? 0;
        }
        workers = {
          total: agents.length,
          byStatus,
          totalBudgetMonthlyCents: totalBudget,
          totalSpentMonthlyCents: totalSpent,
          budgetUtilizationPct: totalBudget > 0 ? Math.round((totalSpent / totalBudget) * 10000) / 100 : 0,
        };
      }

      let tests: {
        suiteCount: number;
        recentRuns: number;
        byStatus: Record<string, number>;
        passRate: number;
      } | null = null;
      if (deps.testService) {
        const suites = deps.testService.listSuites();
        const runs = deps.testService.listRuns({ limit: testRunLimit });
        const byStatus: Record<string, number> = {};
        for (const r of runs) {
          byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
        }
        const terminal = runs.filter((r) => r.status !== "running");
        const passed = terminal.filter((r) => r.status === "passed").length;
        tests = {
          suiteCount: suites.length,
          recentRuns: runs.length,
          byStatus,
          passRate: terminal.length > 0 ? Math.round((passed / terminal.length) * 10000) / 100 : 0,
        };
      }

      let prs: {
        total: number;
        byState: Record<string, number>;
        byChecksStatus: Record<string, number>;
        byReviewStatus: Record<string, number>;
      } | null = null;
      if (deps.prService) {
        const all = (deps.prService as any).listAll?.() ?? [];
        const byState: Record<string, number> = {};
        const byChecksStatus: Record<string, number> = {};
        const byReviewStatus: Record<string, number> = {};
        for (const pr of all) {
          byState[pr.state] = (byState[pr.state] ?? 0) + 1;
          if (pr.checksStatus) byChecksStatus[pr.checksStatus] = (byChecksStatus[pr.checksStatus] ?? 0) + 1;
          if (pr.reviewStatus) byReviewStatus[pr.reviewStatus] = (byReviewStatus[pr.reviewStatus] ?? 0) + 1;
        }
        prs = { total: all.length, byState, byChecksStatus, byReviewStatus };
      }

      const allLanes = await deps.laneService.list({ includeArchived: false });
      const activeLanes = allLanes.filter((l) => l.laneType !== "primary");
      const lanes = {
        total: allLanes.length,
        active: activeLanes.length,
        withMission: activeLanes.filter((l) => (l as any).missionId).length,
      };

      return {
        success: true,
        generatedAt: nowIso(),
        missions,
        workers,
        tests,
        prs,
        lanes,
      };
    },
  });

  // ---------------------------------------------------------------------------
  // Computer Use Artifact Oversight
  // ---------------------------------------------------------------------------

  tools.listComputerUseArtifacts = tool({
    description:
      "List computer-use artifacts (screenshots, videos, browser traces, console logs) across the project.",
    inputSchema: z.object({
      kind: z
        .enum(["screenshot", "video_recording", "browser_trace", "browser_verification", "console_logs"])
        .optional(),
      ownerKind: z
        .enum(["lane", "mission", "orchestrator_run", "orchestrator_step", "orchestrator_attempt", "chat_session", "automation_run", "github_pr", "linear_issue"])
        .optional(),
      ownerId: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional().default(50),
    }),
    execute: async ({ kind, ownerKind, ownerId, limit }) => {
      if (!deps.computerUseArtifactBrokerService) {
        return { success: false, error: "Computer-use artifact broker is not available." };
      }
      try {
        const artifacts = deps.computerUseArtifactBrokerService.listArtifacts({
          kind: kind ?? null,
          ownerKind: ownerKind ?? undefined,
          ownerId: ownerId ?? undefined,
          limit,
        });
        return {
          success: true,
          count: artifacts.length,
          artifacts: artifacts.map((a: any) => ({
            id: a.id,
            kind: a.kind,
            title: a.title,
            description: a.description,
            uri: a.uri,
            reviewState: a.reviewState,
            workflowState: a.workflowState,
            reviewNote: a.reviewNote,
            createdAt: a.createdAt,
            owners: (a.links ?? []).map((l: any) => ({ kind: l.ownerKind, id: l.ownerId, relation: l.relation })),
          })),
        };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.getArtifactPreview = tool({
    description: "Get full details for a specific computer-use artifact by ID.",
    inputSchema: z.object({
      artifactId: z.string().min(1),
    }),
    execute: async ({ artifactId }) => {
      if (!deps.computerUseArtifactBrokerService) {
        return { success: false, error: "Computer-use artifact broker is not available." };
      }
      try {
        const results = deps.computerUseArtifactBrokerService.listArtifacts({ artifactId });
        if (results.length === 0) return { success: false, error: `Artifact not found: ${artifactId}` };
        const a = results[0] as any;
        return {
          success: true,
          artifact: {
            id: a.id, kind: a.kind, title: a.title, description: a.description,
            uri: a.uri, mimeType: a.mimeType, reviewState: a.reviewState,
            workflowState: a.workflowState, reviewNote: a.reviewNote,
            metadata: a.metadata, createdAt: a.createdAt,
            links: (a.links ?? []).map((l: any) => ({
              ownerKind: l.ownerKind, ownerId: l.ownerId, relation: l.relation,
            })),
          },
        };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.reviewArtifact = tool({
    description: "Mark a computer-use artifact as approved, rejected, or needing more evidence.",
    inputSchema: z.object({
      artifactId: z.string().min(1),
      reviewState: z.enum(["pending", "accepted", "needs_more", "dismissed"]),
      workflowState: z.enum(["evidence_only", "promoted", "published", "dismissed"]).optional(),
      reviewNote: z.string().max(2000).optional(),
    }),
    execute: async ({ artifactId, reviewState, workflowState, reviewNote }) => {
      if (!deps.computerUseArtifactBrokerService) {
        return { success: false, error: "Computer-use artifact broker is not available." };
      }
      try {
        const updated = deps.computerUseArtifactBrokerService.updateArtifactReview({
          artifactId,
          reviewState,
          workflowState: workflowState ?? null,
          reviewNote: reviewNote ?? null,
        });
        return {
          success: true,
          artifact: { id: updated.id, kind: updated.kind, reviewState: updated.reviewState, workflowState: updated.workflowState, reviewNote: updated.reviewNote },
        };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  // ---------------------------------------------------------------------------
  // Budget / Cost Visibility
  // ---------------------------------------------------------------------------

  tools.getProjectBudgetStatus = tool({
    description: "Get project-wide budget status: total spend, budget remaining, per-worker summaries, and optional per-mission deep dive.",
    inputSchema: z.object({
      monthKey: z.string().optional().describe("YYYY-MM format. Defaults to current month."),
      missionId: z.string().optional().describe("Include detailed budget for this mission."),
    }),
    execute: async ({ monthKey, missionId }) => {
      if (!deps.workerBudgetService) return { success: false, error: "Worker budget service is not available." };
      try {
        const snapshot = deps.workerBudgetService.getBudgetSnapshot({ monthKey: monthKey?.trim() || undefined });
        let missionBudget: any = null;
        if (missionId?.trim() && deps.missionBudgetService) {
          try {
            missionBudget = await deps.missionBudgetService.getMissionBudgetStatus({ missionId: missionId.trim() });
          } catch { /* non-fatal */ }
        }
        return {
          success: true,
          monthKey: snapshot.monthKey,
          computedAt: snapshot.computedAt,
          company: {
            budgetMonthlyCents: snapshot.companyBudgetMonthlyCents,
            spentMonthlyCents: snapshot.companySpentMonthlyCents,
            remainingCents: snapshot.companyRemainingCents,
          },
          workerCount: snapshot.workers.length,
          workerSummaries: snapshot.workers.map((w: any) => ({
            agentId: w.agentId, name: w.name, budgetMonthlyCents: w.budgetMonthlyCents,
            spentMonthlyCents: w.spentMonthlyCents, remainingCents: w.remainingCents, status: w.status,
          })),
          ...(missionBudget ? { missionBudget } : {}),
        };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.getWorkerCostBreakdown = tool({
    description: "Get per-worker monthly spend breakdown with token usage and model detail.",
    inputSchema: z.object({
      agentId: z.string().optional(),
      monthKey: z.string().optional(),
      limit: z.number().int().positive().optional().default(100),
    }),
    execute: async ({ agentId, monthKey, limit }) => {
      if (!deps.workerBudgetService) return { success: false, error: "Worker budget service is not available." };
      try {
        const snapshot = deps.workerBudgetService.getBudgetSnapshot({ monthKey: monthKey?.trim() || undefined });
        const targetWorkers = agentId?.trim()
          ? snapshot.workers.filter((w: any) => w.agentId === agentId.trim())
          : snapshot.workers;
        if (agentId?.trim() && targetWorkers.length === 0) {
          return { success: false, error: `Worker not found: ${agentId}` };
        }
        const breakdowns = targetWorkers.map((worker: any) => {
          const events = deps.workerBudgetService!.listCostEvents({
            agentId: worker.agentId,
            monthKey: monthKey?.trim() || undefined,
            limit,
          });
          const modelMap = new Map<string, { provider: string; modelId: string; totalCostCents: number; totalInputTokens: number; totalOutputTokens: number; eventCount: number }>();
          for (const event of events) {
            const key = `${event.provider}::${event.modelId ?? "unknown"}`;
            const existing = modelMap.get(key);
            if (existing) {
              existing.totalCostCents += event.costCents;
              existing.totalInputTokens += event.inputTokens ?? 0;
              existing.totalOutputTokens += event.outputTokens ?? 0;
              existing.eventCount += 1;
            } else {
              modelMap.set(key, {
                provider: event.provider, modelId: event.modelId ?? "unknown",
                totalCostCents: event.costCents, totalInputTokens: event.inputTokens ?? 0,
                totalOutputTokens: event.outputTokens ?? 0, eventCount: 1,
              });
            }
          }
          return {
            agentId: worker.agentId, name: worker.name, status: worker.status,
            budgetMonthlyCents: worker.budgetMonthlyCents, spentMonthlyCents: worker.spentMonthlyCents,
            remainingCents: worker.remainingCents,
            modelBreakdown: Array.from(modelMap.values()),
          };
        });
        return { success: true, monthKey: snapshot.monthKey, workerCount: breakdowns.length, breakdowns };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  // ---------------------------------------------------------------------------
  // Codebase Self-Search (for when CTO needs to understand ADE internals)
  // ---------------------------------------------------------------------------

  tools.searchCodebase = tool({
    description:
      "Search the ADE codebase itself for patterns, function names, or implementation details. " +
      "Use this when you need to understand how an ADE feature works internally, find the implementation " +
      "of a specific function, or debug unexpected behavior. This searches the actual ADE source code, " +
      "not the user's project files. Results are scoped and truncated to avoid context bloat.",
    inputSchema: z.object({
      pattern: z.string().trim().min(1).describe("Regex or text pattern to search for (e.g. 'spawnChat', 'createLane', 'modelId')."),
      fileGlob: z.string().optional().describe("Optional file glob to narrow search (e.g. '*.ts', 'services/**/*.ts'). Defaults to all TypeScript files."),
      maxResults: z.number().int().positive().max(30).optional().default(10).describe("Max number of file matches to return."),
      contextLines: z.number().int().nonnegative().max(5).optional().default(2).describe("Lines of context around each match."),
    }),
    execute: async ({ pattern, fileGlob, maxResults, contextLines }) => {
      try {
        const { execFileSync } = await import("node:child_process");
        const adeRoot = path.resolve(__dirname, "../../../../..");
        const searchPattern = pattern.trim().slice(0, 500);
        const globArg = (fileGlob?.trim() || "*.ts").slice(0, 200);
        const args = [
          "--no-heading",
          "--line-number",
          "--max-count=3",
          `--context=${contextLines}`,
          "--glob",
          globArg,
          "--",
          searchPattern,
          ".",
        ];
        const result = execFileSync("rg", args, {
          cwd: adeRoot,
          encoding: "utf8",
          maxBuffer: 512 * 1024,
          timeout: 10_000,
        }).trim();
        const lines = result ? result.split("\n") : [];
        const outputLines: string[] = [];
        const seenFiles = new Set<string>();
        for (const line of lines) {
          const match = line.match(/^([^:]+):\d+:/);
          if (match && !seenFiles.has(match[1])) {
            if (seenFiles.size >= maxResults) break;
            seenFiles.add(match[1]);
          }
          outputLines.push(line);
          if (outputLines.length >= 200) break;
        }
        const truncated = outputLines.length < lines.length || seenFiles.size >= maxResults;
        return {
          success: true,
          matchCount: outputLines.filter((l) => l.match(/^\S+:\d+:/)).length,
          truncated,
          output: outputLines.join("\n"),
        };
      } catch (error: any) {
        if (error?.status === 1) {
          return { success: true, matchCount: 0, truncated: false, output: "No matches found." };
        }
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  return tools;
}
