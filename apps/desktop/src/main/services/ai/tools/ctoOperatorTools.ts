import { tool, type Tool } from "ai";
import { z } from "zod";
import { getModelById } from "../../../../shared/modelRegistry";
import type {
  AgentChatCreateArgs,
  AgentChatInterruptArgs,
  AgentChatSendArgs,
  AgentChatSession,
  AgentChatSessionSummary,
  AgentStatus,
  AgentUpsertInput,
  CtoTriggerAgentWakeupArgs,
  LinearWorkflowConfig,
} from "../../../../shared/types";
import type { IssueTracker } from "../../cto/issueTracker";
import type { createLinearDispatcherService } from "../../cto/linearDispatcherService";
import type { createWorkerAgentService } from "../../cto/workerAgentService";
import type { createWorkerHeartbeatService } from "../../cto/workerHeartbeatService";
import type { createFlowPolicyService } from "../../cto/flowPolicyService";
import type { createLaneService } from "../../lanes/laneService";
import type { createMissionService } from "../../missions/missionService";
import type { createAiOrchestratorService } from "../../orchestrator/aiOrchestratorService";

export interface CtoOperatorToolDeps {
  currentSessionId: string;
  defaultLaneId: string;
  defaultModelId?: string | null;
  defaultReasoningEffort?: string | null;
  laneService: ReturnType<typeof createLaneService>;
  missionService?: ReturnType<typeof createMissionService> | null;
  aiOrchestratorService?: ReturnType<typeof createAiOrchestratorService> | null;
  workerAgentService?: ReturnType<typeof createWorkerAgentService> | null;
  workerHeartbeatService?: ReturnType<typeof createWorkerHeartbeatService> | null;
  linearDispatcherService?: ReturnType<typeof createLinearDispatcherService> | null;
  flowPolicyService?: ReturnType<typeof createFlowPolicyService> | null;
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
  sendChatMessage: (args: AgentChatSendArgs) => Promise<void>;
  interruptChat: (args: AgentChatInterruptArgs) => Promise<void>;
  ensureCtoSession: (args: {
    laneId: string;
    modelId?: string | null;
    reasoningEffort?: string | null;
    reuseExisting?: boolean;
  }) => Promise<AgentChatSession>;
  fetchMissionContext?: (missionId: string) => Promise<{ content: string; truncated: boolean }>;
}

type ChatNavigationHint = {
  surface: "lanes";
  laneId: string;
  sessionId: string;
};

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
    return {
      provider: "unified",
      model: args.modelId?.trim() || "",
    };
  }
  if (!descriptor.isCliWrapped) {
    return { provider: "unified", model: descriptor.id };
  }
  if (descriptor.family === "openai") {
    return { provider: "codex", model: descriptor.shortId };
  }
  return { provider: "claude", model: descriptor.shortId };
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

function buildChatNavigationHint(session: Pick<AgentChatSession, "id" | "laneId">): ChatNavigationHint {
  return {
    surface: "lanes",
    laneId: session.laneId,
    sessionId: session.id,
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
      navigation: buildChatNavigationHint(session),
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
      return { success: true as const, mission, run };
    } catch (error) {
      return { success: false as const, error: error instanceof Error ? error.message : String(error) };
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
      return { success: false as const, error: error instanceof Error ? error.message : String(error) };
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
      return { success: true, lane };
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
        return { success: true, lane };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
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
      permissionMode: z.enum(["default", "plan", "edit", "full-auto", "config-toml"]).optional().default("full-auto"),
      title: z.string().optional(),
      initialPrompt: z.string().optional(),
      openInUi: z.boolean().optional().default(true),
    }),
    execute: async ({ laneId, modelId, reasoningEffort, permissionMode, title, initialPrompt, openInUi }) => {
      try {
        const selectedModelId = modelId?.trim() || deps.defaultModelId || null;
        const resolved = deriveChatProvider({ modelId: selectedModelId });
        const session = await deps.createChat({
          laneId: laneId?.trim() || deps.defaultLaneId,
          provider: resolved.provider,
          model: resolved.model,
          ...(selectedModelId ? { modelId: selectedModelId } : {}),
          reasoningEffort: reasoningEffort ?? deps.defaultReasoningEffort ?? null,
          permissionMode,
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
          navigation: buildChatNavigationHint(session),
          provider: session.provider,
          model: session.model,
          modelId: session.modelId ?? null,
        };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  });

  tools.sendChatMessage = tool({
    description: "Send a message to an ADE chat session you are supervising.",
    inputSchema: z.object({
      sessionId: z.string(),
      text: z.string(),
    }),
    execute: async ({ sessionId, text }) => {
      try {
        await deps.sendChatMessage({ sessionId, text });
        return { success: true, sessionId };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  });

  tools.interruptChat = tool({
    description: "Interrupt a running ADE chat turn.",
    inputSchema: z.object({
      sessionId: z.string(),
    }),
    execute: async ({ sessionId }) => {
      try {
        await deps.interruptChat({ sessionId });
        return { success: true, sessionId };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  });

  tools.getChatStatus = tool({
    description: "Get the current status for an ADE chat session.",
    inputSchema: z.object({
      sessionId: z.string(),
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
        return { success: false, error: error instanceof Error ? error.message : String(error) };
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
        const mission = deps.missionService.create({
          prompt,
          ...(title?.trim() ? { title: title.trim() } : {}),
          ...(laneId?.trim() ? { laneId: laneId.trim() } : {}),
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
        return { success: true, mission, run };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
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
      return { success: true, mission };
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
        return { success: true, mission };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
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
        return { success: true, mission, run };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
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
        return { success: false, error: error instanceof Error ? error.message : String(error) };
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
        return { success: false, error: error instanceof Error ? error.message : String(error) };
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
        return { success: false, error: error instanceof Error ? error.message : String(error) };
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
        return { success: false, error: error instanceof Error ? error.message : String(error) };
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
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  });

  tools.openMissionContext = tool({
    description: "Open the generated mission context pack so you can review the mission's live execution context.",
    inputSchema: z.object({
      missionId: z.string(),
    }),
    execute: async ({ missionId }) => {
      if (!deps.fetchMissionContext) return { success: false, error: "Mission context export is not available." };
      try {
        const result = await deps.fetchMissionContext(missionId);
        return { success: true, missionId, ...result };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
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
        return { success: false, error: error instanceof Error ? error.message : String(error) };
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
        return { success: false, error: error instanceof Error ? error.message : String(error) };
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
    description: "Approve, reject, retry, or explicitly complete a Linear workflow run from chat.",
    inputSchema: z.object({
      runId: z.string(),
      action: z.enum(["approve", "reject", "retry", "complete"]),
      note: z.string().optional(),
    }),
    execute: async ({ runId, action, note }) => {
      if (!deps.linearDispatcherService || !deps.flowPolicyService) {
        return { success: false, error: "Linear workflow services are not available." };
      }
      try {
        const run = await deps.linearDispatcherService.resolveRunAction(
          runId,
          action,
          note?.trim() || undefined,
          deps.flowPolicyService.getPolicy(),
        );
        if (!run) return { success: false, error: `Workflow run not found: ${runId}` };
        return { success: true, run };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
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
        return { success: false, error: error instanceof Error ? error.message : String(error) };
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
        return { success: false, error: error instanceof Error ? error.message : String(error) };
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
        return { success: false, error: error instanceof Error ? error.message : String(error) };
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
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  });

  return tools;
}
