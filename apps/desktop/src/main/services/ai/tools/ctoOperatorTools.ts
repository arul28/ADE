import { tool, type Tool } from "ai";
import { z } from "zod";
import { getModelById, resolveChatProviderForDescriptor } from "../../../../shared/modelRegistry";
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
import { getErrorMessage, nowIso } from "../../shared/utils";

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
  issueTracker?: IssueTracker | null;
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
    return { provider: "unified", model: args.modelId?.trim() || "" };
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
    description: "List ADE lanes so you can inspect execution branches and choose where to open work.",
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
    description: "Create a normal ADE work chat, optionally seed it with an initial prompt, and return the session metadata.",
    inputSchema: z.object({
      laneId: z.string().optional(),
      modelId: z.string().optional(),
      reasoningEffort: z.string().nullable().optional(),
      title: z.string().optional(),
      initialPrompt: z.string().optional(),
      openInUi: z.boolean().optional().default(true),
    }),
    execute: async ({ laneId, modelId, reasoningEffort, title, initialPrompt, openInUi }) => {
      try {
        const selectedModelId = modelId?.trim() || deps.defaultModelId || null;
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

  // ---------------------------------------------------------------------------
  // Lane Management
  // ---------------------------------------------------------------------------

  tools.deleteLane = tool({
    description: "Delete an ADE lane and its associated worktree.",
    inputSchema: z.object({
      laneId: z.string().trim().min(1),
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
    description: "Create a new terminal session in an ADE lane.",
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

  return tools;
}
