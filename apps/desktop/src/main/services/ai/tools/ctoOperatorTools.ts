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
  AutomationRuleSummary,
  AutomationRun,
  AutomationRunListArgs,
  GitPullArgs,
  OperatorNavigationSuggestion,
  SessionSettleOverride,
  SessionWakeReason,
  TestRunSummary,
  TestSuiteDefinition,
} from "../../../../shared/types";
import type { IssueTracker } from "../../cto/issueTracker";
import type { createFileService } from "../../files/fileService";
import type { createLaneService } from "../../lanes/laneService";
import type { createPrService } from "../../prs/prService";
import type { createSessionService } from "../../sessions/sessionService";
import { parseSnoozeDeadline } from "../../sessions/sessionRequestValidation";
import type { createCtoStateService } from "../../cto/ctoStateService";
import type { CtoMemoryService } from "../../cto/ctoMemoryService";
import { getErrorMessage, nowIso, parseIsoToEpoch } from "../../shared/utils";
import { buildAdePrUrl } from "../../../../shared/deeplinks";

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
  prService?: ReturnType<typeof createPrService> | null;
  fileService?: ReturnType<typeof createFileService> | null;
  sessionService: Pick<
    ReturnType<typeof createSessionService>,
    | "updateMeta"
    | "get"
    | "settleSession"
    | "unsettleSession"
    | "setSettleOverride"
    | "snoozeSession"
    | "wakeSession"
    | "clearWokeMarker"
  >;
  testService?: {
    listSuites: () => TestSuiteDefinition[];
    run: (args: { laneId: string; suiteId: string }) => Promise<TestRunSummary>;
    stop: (args: { runId: string }) => void;
    listRuns: (args?: { laneId?: string; suiteId?: string; limit?: number }) => TestRunSummary[];
    getLogTail: (args: { runId: string; maxBytes?: number }) => string;
  } | null;
  ptyService?: {
    create: (args: { laneId: string; title?: string; cols?: number; rows?: number; tracked?: boolean; toolType?: "shell"; startupCommand?: string }) => Promise<{ ptyId: string; sessionId: string }>;
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
    pull: (args: GitPullArgs) => Promise<any>;
    undoLastHeadChange: (args: { laneId: string }) => Promise<any>;
    redoLastHeadChange: (args: { laneId: string }) => Promise<any>;
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
  steerChat?: (args: { sessionId: string; instruction: string }) => Promise<{ steerId: string; queued: boolean }>;
  cancelSteer?: (args: { sessionId: string }) => Promise<void>;
  handoffChat?: (args: { sessionId: string; targetIdentityKey?: string; reason?: string }) => Promise<any>;
  listSubagents?: (args: { sessionId: string }) => Promise<any[]>;
  approveToolUse?: (args: { sessionId: string; toolUseId: string; decision: "accept" | "accept_for_session" | "decline" | "cancel" }) => Promise<void>;
  computerUseArtifactBrokerService?: {
    listArtifacts: (args?: any) => any[];
    updateArtifactReview: (args: any) => any;
  } | null;
  issueTracker?: IssueTracker | null;
  ctoStateService?: Pick<ReturnType<typeof createCtoStateService>, "getSessionLogs"> | null;
  ctoMemoryService?: Pick<
    CtoMemoryService,
    "appendMemoryFact" | "searchMemory" | "getSnapshot"
  > | null;
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
  ensureCtoSession: (args: {
    laneId: string;
    modelId?: string | null;
    reasoningEffort?: string | null;
    reuseExisting?: boolean;
  }) => Promise<AgentChatSession>;
}

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

function buildNavigationSuggestion(args: {
  surface: OperatorNavigationSuggestion["surface"];
  laneId?: string | null;
  sessionId?: string | null;
}): OperatorNavigationSuggestion {
  const laneId = args.laneId?.trim() || null;
  const sessionId = args.sessionId?.trim() || null;
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

/**
 * The lifecycle slice the CTO needs to triage a row: whether it is settled,
 * whether it is deliberately quiet, and — the load-bearing bit — WHY it came
 * back if a snooze was broken early.
 */
function readSessionLifecycle(
  deps: Pick<CtoOperatorToolDeps, "sessionService">,
  sessionId: string,
): {
  settledAt: string | null;
  settleOverride: SessionSettleOverride | null;
  statusNote: string | null;
  attentionRequestedAt: string | null;
  attentionMessage: string | null;
  lastTurnFailedAt: string | null;
  snoozedUntil: string | null;
  snoozedAt: string | null;
  snoozed: boolean;
  wokeAt: string | null;
  wokeReason: SessionWakeReason | null;
} | null {
  // Not every host wires the full session service (the prompt-manifest preview
  // and older harnesses pass only `updateMeta`), and a missing lifecycle read
  // must degrade to "unknown" rather than break the tool it decorates.
  const session = typeof deps.sessionService?.get === "function"
    ? deps.sessionService.get(sessionId)
    : null;
  if (!session) return null;
  const snoozedUntil = session.snoozedUntil ?? null;
  const snoozedUntilMs = snoozedUntil ? Date.parse(snoozedUntil) : NaN;
  return {
    settledAt: session.settledAt ?? null,
    settleOverride: session.settleOverride ?? null,
    statusNote: session.statusNote ?? null,
    attentionRequestedAt: session.attentionRequestedAt ?? null,
    attentionMessage: session.attentionMessage ?? null,
    lastTurnFailedAt: session.lastTurnFailedAt ?? null,
    snoozedUntil,
    snoozedAt: session.snoozedAt ?? null,
    snoozed: Number.isFinite(snoozedUntilMs) && snoozedUntilMs > Date.now(),
    wokeAt: session.wokeAt ?? null,
    wokeReason: session.wokeReason ?? null,
  };
}

/**
 * Throws on anything that would make the snooze a silent no-op — an
 * unparseable date, a deadline already in the past (`snoozed` is
 * `snoozedUntil > now`, so the write "succeeds" while the row stays visible),
 * or neither argument. Callers surface the message as `{ success: false }`.
 */
function resolveSnoozeDeadline(args: {
  untilIso?: string | null;
  durationMinutes?: number | null;
}): string {
  const raw = args.untilIso?.trim();
  if (raw) return parseSnoozeDeadline(raw);
  const minutes = args.durationMinutes ?? null;
  if (minutes == null || !Number.isFinite(minutes) || minutes <= 0) {
    throw new Error("Pass a valid future untilIso timestamp or a positive durationMinutes.");
  }
  return new Date(Date.now() + Math.floor(minutes) * 60_000).toISOString();
}

export function createCtoOperatorTools(deps: CtoOperatorToolDeps): Record<string, Tool> {
  const tools: Record<string, Tool> = {};

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
    description:
      "List ADE chat sessions so you can supervise active work and persistent identity threads. Each row carries " +
      "its settle/snooze lifecycle plus `wokeReason` when a snooze broke early, so you can triage what actually " +
      "needs you versus what is deliberately quiet.",
    inputSchema: z.object({
      laneId: z.string().optional(),
      includeIdentity: z.boolean().optional().default(true),
    }),
    execute: async ({ laneId, includeIdentity }) => {
      const chats = await deps.listChats(laneId?.trim() || undefined, {
        includeIdentity,
        includeAutomation: false,
      });
      const withLifecycle = chats.map((chat) => {
        const lifecycle = readSessionLifecycle(deps, chat.sessionId);
        return lifecycle ? { ...chat, lifecycle } : chat;
      });
      return { success: true, count: withLifecycle.length, chats: withLifecycle };
    },
  });

  tools.spawnChat = tool({
    description:
      "Create a native ADE work chat session — the primary way to launch an AI agent in ADE. " +
      "IMPORTANT: Always pass modelId when the user specifies a model. Use the full model ID " +
      "(e.g. 'anthropic/claude-opus-5' for Opus, 'anthropic/claude-sonnet-5' for Sonnet, " +
      "'anthropic/claude-haiku-4-5' for Haiku, 'openai/gpt-5.6-sol' for Sol). " +
      "If no modelId is passed, the CTO's default model preference is used. " +
      "Set initialPrompt to seed the chat with a task description — the agent will begin working immediately. " +
      "This creates a full ADE chat with UI, streaming, tool approval, and service integration. " +
      "Use this when the user asks for 'a chat' or 'an agent'. If they explicitly want a terminal or CLI tool, use createTerminal instead.",
    inputSchema: z.object({
      laneId: z.string().optional().describe("Lane to run in. Defaults to the primary lane. A new lane is auto-created if needed."),
      modelId: z.string().optional().describe("Full model ID (e.g. 'anthropic/claude-sonnet-5'). MUST be set when user specifies a model."),
      reasoningEffort: z.string().nullable().optional().describe("Reasoning effort advertised by the model, including 'max' or Codex 'ultra' when supported."),
      title: z.string().optional().describe("Display title for the chat session."),
      initialPrompt: z.string().optional().describe("Task description to seed the chat. The agent starts working immediately."),
      openInUi: z.boolean().optional().default(true).describe("Whether to open the chat in the ADE UI."),
    }),
    execute: async ({ laneId, modelId, reasoningEffort, title, initialPrompt, openInUi }) => {
      try {
        // Resolve model: supports full IDs (anthropic/claude-sonnet-5), short IDs (sonnet), and aliases (opus)
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

  tools.getChatStatus = tool({
    description:
      "Get the current status for an ADE chat session, including its settle/snooze lifecycle " +
      "and — when it recently came back from a snooze — the reason it woke.",
    inputSchema: z.object({
      sessionId: z.string().trim().min(1),
    }),
    execute: async ({ sessionId }) => {
      const session = await deps.getChatStatus(sessionId);
      if (!session) return { success: false, error: `Chat not found: ${sessionId}` };
      return { success: true, session, lifecycle: readSessionLifecycle(deps, sessionId) };
    },
  });

  tools.getSessionLifecycle = tool({
    description:
      "Read the settle/snooze lifecycle for any ADE session (chat or tracked CLI). Use this to triage " +
      "what needs attention: `snoozed` rows are deliberately quiet until `snoozedUntil`, and `wokeReason` " +
      "explains why a snoozed row came back early ('needs_you' = blocked on a human, 'error' = the turn " +
      "failed, 'turn_complete' = the work finished, 'timer' = the snooze simply expired, 'manual' = someone woke it).",
    inputSchema: z.object({
      sessionId: z.string().trim().min(1),
    }),
    execute: async ({ sessionId }) => {
      const lifecycle = readSessionLifecycle(deps, sessionId);
      if (!lifecycle) return { success: false, error: `Session not found: ${sessionId}` };
      return { success: true, sessionId, ...lifecycle };
    },
  });

  tools.settleSession = tool({
    description:
      "Mark an ADE session complete so it drops out of the active tier. Pass `outcome` to record a one-line " +
      "result on the row. Real activity (a new turn, an approval request, a failed turn) un-settles it again.",
    inputSchema: z.object({
      sessionId: z.string().trim().min(1),
      outcome: z.string().trim().min(1).optional().describe("Short outcome line, e.g. 'PR #841 merged, CI green'."),
    }),
    execute: async ({ sessionId, outcome }) => {
      try {
        const ok = deps.sessionService.settleSession(sessionId, {
          ...(outcome ? { outcome } : {}),
          source: "operator",
        });
        if (!ok) return { success: false, error: `Session not found: ${sessionId}` };
        return { success: true, sessionId, ...readSessionLifecycle(deps, sessionId) };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.unsettleSession = tool({
    description:
      "Return a settled ADE session to the active lifecycle. An explicit keep-active pin survives; " +
      "to force a derived-settle row back to active use setSessionSettleOverride with 'active'.",
    inputSchema: z.object({
      sessionId: z.string().trim().min(1),
    }),
    execute: async ({ sessionId }) => {
      try {
        const ok = deps.sessionService.unsettleSession(sessionId);
        if (!ok) return { success: false, error: `Session not found: ${sessionId}` };
        return { success: true, sessionId, ...readSessionLifecycle(deps, sessionId) };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.setSessionSettleOverride = tool({
    description:
      "Pin an ADE session's settle state. 'settled' behaves like a declared settle, 'active' is a keep-active " +
      "pin, and `clear` returns the row to the declared lifecycle state.",
    inputSchema: z.object({
      sessionId: z.string().trim().min(1),
      override: z.enum(["settled", "active", "clear"]).describe("'clear' removes the pin."),
    }),
    execute: async ({ sessionId, override }) => {
      try {
        const normalized = override === "clear" ? null : override;
        const ok = deps.sessionService.setSettleOverride(sessionId, normalized, "operator");
        if (!ok) return { success: false, error: `Session not found: ${sessionId}` };
        return { success: true, sessionId, ...readSessionLifecycle(deps, sessionId) };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.snoozeSession = tool({
    description:
      "Hide an ADE session from the attention surfaces until a deadline. Snooze is a visibility overlay, not a " +
      "lifecycle change: the session keeps running, and a hand-raise (approval request, failed turn, completed " +
      "turn) wakes it early with a recorded reason. Pass either `untilIso` or `durationMinutes`.",
    inputSchema: z.object({
      sessionId: z.string().trim().min(1),
      untilIso: z.string().trim().min(1).optional().describe("ISO-8601 deadline. Wins over durationMinutes."),
      durationMinutes: z
        .number()
        .int()
        .positive()
        .max(60 * 24 * 30)
        .optional()
        .describe("Minutes from now. Ignored when untilIso is supplied."),
    }),
    execute: async ({ sessionId, untilIso, durationMinutes }) => {
      try {
        const deadline = resolveSnoozeDeadline({ untilIso, durationMinutes });
        const ok = deps.sessionService.snoozeSession(sessionId, deadline);
        if (!ok) return { success: false, error: `Session not found: ${sessionId}` };
        return { success: true, sessionId, ...readSessionLifecycle(deps, sessionId) };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.wakeSession = tool({
    description: "Clear a snooze on an ADE session so it resurfaces now. No-op when the session was not snoozed.",
    inputSchema: z.object({
      sessionId: z.string().trim().min(1),
      reason: z
        .enum(["timer", "needs_you", "error", "turn_complete", "manual"])
        .optional()
        .describe("Recorded on the row so the surfaces can explain why it came back. Defaults to 'manual'."),
    }),
    execute: async ({ sessionId, reason }) => {
      try {
        const woke = deps.sessionService.wakeSession(sessionId, reason ?? "manual");
        return { success: true, sessionId, woke, ...readSessionLifecycle(deps, sessionId) };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
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
        const file = await deps.fileService.readFile({ workspaceId: resolvedWorkspaceId, path });
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
        return { success: true, pr, githubUrl: pr.githubUrl, adeUrl: buildAdePrUrl(pr) };
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
    description: "Request user or team reviewers on an ADE-managed pull request.",
    inputSchema: z.object({
      prId: z.string().trim().min(1),
      reviewers: z.array(z.string().trim().min(1)).optional(),
      teamReviewers: z.array(z.string().trim().min(1)).optional(),
    }).refine(
      (value) => (value.reviewers?.length ?? 0) + (value.teamReviewers?.length ?? 0) > 0,
      { message: "Provide at least one reviewer or team reviewer." },
    ),
    execute: async ({ prId, reviewers = [], teamReviewers = [] }) => {
      if (!deps.prService) return { success: false, error: "PR service is not available." };
      try {
        await deps.prService.requestReviewers({ prId, reviewers, teamReviewers });
        return { success: true, prId, reviewers, teamReviewers };
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
          toolType: "shell",
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
    description: "Pull from the remote for a lane. Defaults to fast-forward only; use rebase or merge when that is the intended history shape.",
    inputSchema: z.object({
      laneId: z.string().optional(),
      mode: z.enum(["ff-only", "rebase", "merge"]).optional().default("ff-only"),
    }),
    execute: ({ laneId, mode }) => gitGuard(() => deps.gitService!.pull({ laneId: resolveLaneId(laneId), mode })),
  });

  tools.gitUndoLastHeadChange = tool({
    description: "Undo the latest successful head-changing git operation recorded by ADE for a lane. This resets the lane with git reset --hard.",
    inputSchema: z.object({ laneId: z.string().optional() }),
    execute: ({ laneId }) => gitGuard(() => deps.gitService!.undoLastHeadChange({ laneId: resolveLaneId(laneId) })),
  });

  tools.gitRedoLastHeadChange = tool({
    description: "Redo the latest successful ADE git undo for a lane. This resets the lane with git reset --hard.",
    inputSchema: z.object({ laneId: z.string().optional() }),
    execute: ({ laneId }) => gitGuard(() => deps.gitService!.redoLastHeadChange({ laneId: resolveLaneId(laneId) })),
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
    inputSchema: z.object({
      laneId: z.string().optional(),
      branch: z.string().min(1),
      create: z.boolean().optional().default(false),
      startPoint: z.string().optional(),
      baseRef: z.string().optional(),
      acknowledgeActiveWork: z.boolean().optional().default(false),
    }),
    execute: ({ laneId, branch, create, startPoint, baseRef, acknowledgeActiveWork }) => gitGuard(() => deps.gitService!.checkoutBranch({
      laneId: resolveLaneId(laneId),
      branchName: branch,
      mode: create ? "create" : "existing",
      startPoint,
      baseRef,
      acknowledgeActiveWork,
    })),
  });

  tools.gitStashPush = tool({
    description: "Stash working changes for a lane branch.",
    inputSchema: z.object({ laneId: z.string().optional(), message: z.string().optional() }),
    execute: ({ laneId, message }) => gitGuard(() => deps.gitService!.stashPush({ laneId: resolveLaneId(laneId), ...(message?.trim() ? { message: message.trim() } : {}) })),
  });

  tools.gitStashPop = tool({
    description: "Pop a stash saved for a lane branch. Defaults to the latest branch-matching stash; call gitStashList to inspect refs.",
    inputSchema: z.object({ laneId: z.string().optional(), stashRef: z.string().optional() }),
    execute: ({ laneId, stashRef }) => gitGuard(async () => {
      const resolvedLaneId = resolveLaneId(laneId);
      const trimmedRef = stashRef?.trim();
      const stashes = await deps.gitService!.listStashes({ laneId: resolvedLaneId });
      const selectedStash = trimmedRef
        ? stashes.find((stash) => stash.ref === trimmedRef)
        : stashes[0];
      if (trimmedRef && !selectedStash) {
        throw new Error(`Stash ${trimmedRef} is not saved for this lane branch.`);
      }
      const resolvedRef = trimmedRef || selectedStash?.ref;
      if (!resolvedRef) throw new Error("No stashes are saved for this lane branch.");
      return deps.gitService!.stashPop({
        laneId: resolvedLaneId,
        stashRef: resolvedRef,
        ...(selectedStash?.oid ? { stashOid: selectedStash.oid } : {}),
      });
    }),
  });

  tools.gitStashList = tool({
    description: "List stashes saved for a lane branch.",
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
      "Surface a unified feed of recent project events: CTO session completions, " +
      "test completions/failures, PR review activity, and chat session events. " +
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

      // 2. Test runs
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

      // 5. PR review activity (recent events from all tracked PRs)
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
      "Aggregate project health into a single snapshot: test pass rates, PR status distribution, and active lanes.",
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
      };

      return {
        success: true,
        generatedAt: nowIso(),
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
        .enum(["lane", "chat_session", "automation_run", "github_pr", "linear_issue"])
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
        const adeRoot = typeof __dirname === "string"
          ? path.resolve(__dirname, "../../../../..")
          : path.resolve(process.cwd());
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

  // ---------------------------------------------------------------------------
  // Persistent Memory
  // ---------------------------------------------------------------------------

  tools.saveMemory = tool({
    description:
      "Save a durable fact to your persistent memory (MEMORY.md). Use for decisions, user preferences, " +
      "conventions, and standing project context you should remember across sessions and model switches. " +
      "Keep each fact to one crisp sentence. Exact duplicates are ignored.",
    inputSchema: z.object({
      fact: z.string().trim().min(1).describe("A single durable fact to remember."),
    }),
    execute: async ({ fact }) => {
      if (!deps.ctoMemoryService) return { success: false, error: "Memory service is not available." };
      try {
        const result = deps.ctoMemoryService.appendMemoryFact(fact);
        return {
          success: true,
          saved: result.saved,
          fact: result.fact,
          file: "MEMORY.md",
          ...(result.evictedCount
            ? {
                notice: `MEMORY.md hit its size cap: the ${result.evictedCount} oldest fact(s) were moved to memory-archive.md (still searchable via searchMemory). Consider pruning MEMORY.md.`,
              }
            : {}),
        };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.searchMemory = tool({
    description:
      "Search your persistent memory (MEMORY.md, thread state, and recent daily logs) for prior context. " +
      "Use this before asking the user to restate something you may already know.",
    inputSchema: z.object({
      query: z.string().trim().min(1),
      limit: z.number().int().positive().max(100).optional().default(20),
    }),
    execute: async ({ query, limit }) => {
      if (!deps.ctoMemoryService) return { success: false, error: "Memory service is not available." };
      try {
        const rows = deps.ctoMemoryService.searchMemory(query, { limit });
        return { success: true, query, count: rows.length, rows };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.readMemory = tool({
    description:
      "Read your persistent memory: durable facts (MEMORY.md), the current thread state, and today's daily journal. " +
      "Use to review what you already know before making decisions.",
    inputSchema: z.object({}),
    execute: async () => {
      if (!deps.ctoMemoryService) return { success: false, error: "Memory service is not available." };
      try {
        const snapshot = deps.ctoMemoryService.getSnapshot();
        return {
          success: true,
          memory: snapshot.memory,
          threadState: snapshot.threadState,
          dailyLog: snapshot.dailyLog,
          dailyLogDate: snapshot.dailyLogDate,
          updatedAt: snapshot.updatedAt,
        };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  return tools;
}
