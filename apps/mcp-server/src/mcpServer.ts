import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Tool } from "ai";
import { createCoordinatorToolSet } from "../../desktop/src/main/services/orchestrator/coordinatorTools";
import { runGit } from "../../desktop/src/main/services/git/git";
import type { ContextExportLevel, MergeMethod } from "../../desktop/src/shared/types";
import type { AdeMcpRuntime } from "./bootstrap";
import { JsonRpcError, JsonRpcErrorCode, type JsonRpcHandler, type JsonRpcRequest } from "./jsonrpc";

type ToolSpec = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

type SessionIdentity = {
  callerId: string;
  role: "orchestrator" | "agent" | "external" | "evaluator";
  missionId: string | null;
  runId: string | null;
  stepId: string | null;
  attemptId: string | null;
  ownerId: string | null;
};

type SessionState = {
  initialized: boolean;
  protocolVersion: string;
  identity: SessionIdentity;
  askUserEvents: number[];
  askUserRateLimit: {
    maxCalls: number;
    windowMs: number;
  };
  memoryAddEvents: number[];
  memoryAddRateLimit: {
    maxCalls: number;
    windowMs: number;
  };
  memorySearchEvents: number[];
  memorySearchRateLimit: {
    maxCalls: number;
    windowMs: number;
  };
};

const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_PTY_COLS = 120;
const DEFAULT_PTY_ROWS = 36;

const RESOURCE_MIME_MARKDOWN = "text/markdown";
const RESOURCE_MIME_JSON = "application/json";

const TOOL_SPECS: ToolSpec[] = [
  {
    name: "spawn_agent",
    description: "Spawn a Codex or Claude CLI session in a lane-scoped tracked terminal.",
    inputSchema: {
      type: "object",
      required: ["laneId"],
      additionalProperties: false,
      properties: {
        laneId: { type: "string", minLength: 1 },
        provider: { type: "string", enum: ["codex", "claude"], default: "codex" },
        prompt: { type: "string" },
        model: { type: "string" },
        title: { type: "string" },
        runId: { type: "string" },
        stepId: { type: "string" },
        attemptId: { type: "string" },
        permissionMode: { type: "string", enum: ["plan", "edit", "full-auto"], default: "edit" },
        toolWhitelist: { type: "array", items: { type: "string" }, maxItems: 24 },
        maxPromptChars: { type: "number", minimum: 256, maximum: 12000 },
        contextFilePath: { type: "string" },
        context: {
          type: "object",
          additionalProperties: false,
          properties: {
            profile: { type: "string" },
            packs: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  scope: { type: "string" },
                  packKey: { type: "string" },
                  level: { type: "string" },
                  approxTokens: { type: "number" },
                  summary: { type: "string" }
                }
              }
            },
            docs: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  path: { type: "string" },
                  sha256: { type: "string" },
                  bytes: { type: "number" }
                }
              }
            },
            handoffDigest: {
              type: "object",
              additionalProperties: false,
              properties: {
                summarizedCount: { type: "number" },
                byType: { type: "object" },
                oldestCreatedAt: { type: "string" },
                newestCreatedAt: { type: "string" }
              }
            }
          }
        }
      }
    }
  },
  {
    name: "read_context",
    description: "Read project/lane/feature/conflict/plan/mission context packs for orchestration.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        scope: {
          type: "string",
          enum: ["project", "lane", "feature", "conflict", "plan", "mission"],
          default: "project"
        },
        laneId: { type: "string" },
        featureKey: { type: "string" },
        peerLaneId: { type: "string" },
        missionId: { type: "string" },
        level: { type: "string", enum: ["lite", "standard", "deep"], default: "standard" }
      }
    }
  },
  {
    name: "create_lane",
    description: "Create a new lane/worktree for task execution.",
    inputSchema: {
      type: "object",
      required: ["name"],
      additionalProperties: false,
      properties: {
        name: { type: "string", minLength: 1 },
        description: { type: "string" },
        parentLaneId: { type: "string" }
      }
    }
  },
  {
    name: "check_conflicts",
    description: "Run conflict prediction against one lane or a lane set.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        laneId: { type: "string" },
        laneIds: { type: "array", items: { type: "string" } },
        force: { type: "boolean", default: false }
      }
    }
  },
  {
    name: "merge_lane",
    description: "Merge a source lane into its parent lane with conflict-aware status reporting.",
    inputSchema: {
      type: "object",
      required: ["laneId"],
      additionalProperties: false,
      properties: {
        laneId: { type: "string", minLength: 1 },
        message: { type: "string" },
        deleteSourceLane: { type: "boolean", default: false }
      }
    }
  },
  {
    name: "ask_user",
    description: "Create a mission intervention and optionally wait for user resolution.",
    inputSchema: {
      type: "object",
      required: ["missionId", "title", "body"],
      additionalProperties: false,
      properties: {
        missionId: { type: "string", minLength: 1 },
        title: { type: "string", minLength: 1 },
        body: { type: "string", minLength: 1 },
        requestedAction: { type: "string" },
        laneId: { type: "string" },
        waitForResolutionMs: { type: "number", minimum: 0, maximum: 3600000 },
        pollIntervalMs: { type: "number", minimum: 100, maximum: 10000 }
      }
    }
  },
  {
    name: "memory_add",
    description: "Save important discoveries to project memory for future missions and workers.",
    inputSchema: {
      type: "object",
      required: ["content", "category"],
      additionalProperties: false,
      properties: {
        content: { type: "string", minLength: 1 },
        category: { type: "string", enum: ["fact", "preference", "pattern", "decision", "gotcha"] },
        importance: { type: "string", enum: ["low", "medium", "high"], default: "medium" }
      }
    }
  },
  {
    name: "memory_search",
    description: "Search project memories for relevant context from earlier missions and workers.",
    inputSchema: {
      type: "object",
      required: ["query"],
      additionalProperties: false,
      properties: {
        query: { type: "string", minLength: 1 },
        limit: { type: "number", minimum: 1, maximum: 50, default: 5 }
      }
    }
  },
  {
    name: "run_tests",
    description: "Run a configured test suite or ad-hoc command in a lane and return execution results.",
    inputSchema: {
      type: "object",
      required: ["laneId"],
      additionalProperties: false,
      properties: {
        laneId: { type: "string", minLength: 1 },
        suiteId: { type: "string" },
        command: { type: "string" },
        timeoutMs: { type: "number", minimum: 500, maximum: 1800000 },
        waitForCompletion: { type: "boolean", default: true },
        maxLogBytes: { type: "number", minimum: 1024, maximum: 2000000 }
      }
    }
  },
  {
    name: "get_lane_status",
    description: "Return lane status, diff stats, and conflict/rebase state.",
    inputSchema: {
      type: "object",
      required: ["laneId"],
      additionalProperties: false,
      properties: {
        laneId: { type: "string", minLength: 1 }
      }
    }
  },
  {
    name: "list_lanes",
    description: "List active lanes with metadata and branch status.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        includeArchived: { type: "boolean", default: false }
      }
    }
  },
  {
    name: "commit_changes",
    description: "Stage and commit lane changes with a provided message.",
    inputSchema: {
      type: "object",
      required: ["laneId", "message"],
      additionalProperties: false,
      properties: {
        laneId: { type: "string", minLength: 1 },
        message: { type: "string", minLength: 1 },
        amend: { type: "boolean", default: false },
        stageAll: { type: "boolean", default: true }
      }
    }
  },
  {
    name: "simulate_integration",
    description: "Dry-merge N lanes sequentially using git merge-tree, returning per-step conflict analysis without creating any branches or PRs",
    inputSchema: {
      type: "object",
      required: ["sourceLaneIds", "baseBranch"],
      additionalProperties: false,
      properties: {
        sourceLaneIds: { type: "array", items: { type: "string", minLength: 1 } },
        baseBranch: { type: "string", minLength: 1 }
      }
    }
  },
  {
    name: "create_queue",
    description: "Create a queue PR group with ordered lanes, each targeting the same branch for sequential landing",
    inputSchema: {
      type: "object",
      required: ["laneIds", "targetBranch"],
      additionalProperties: false,
      properties: {
        laneIds: { type: "array", items: { type: "string", minLength: 1 } },
        targetBranch: { type: "string", minLength: 1 },
        titles: { type: "object", additionalProperties: { type: "string" } },
        draft: { type: "boolean" },
        autoRebase: { type: "boolean" },
        ciGating: { type: "boolean" },
        queueName: { type: "string" }
      }
    }
  },
  {
    name: "create_integration",
    description: "Create an integration lane, merge source lanes into it, and create a single integration PR",
    inputSchema: {
      type: "object",
      required: ["sourceLaneIds", "integrationLaneName", "baseBranch", "title"],
      additionalProperties: false,
      properties: {
        sourceLaneIds: { type: "array", items: { type: "string", minLength: 1 } },
        integrationLaneName: { type: "string", minLength: 1 },
        baseBranch: { type: "string", minLength: 1 },
        title: { type: "string", minLength: 1 },
        body: { type: "string" },
        draft: { type: "boolean" }
      }
    }
  },
  {
    name: "rebase_lane",
    description: "Rebase a lane onto its base branch, optionally using AI to resolve conflicts",
    inputSchema: {
      type: "object",
      required: ["laneId"],
      additionalProperties: false,
      properties: {
        laneId: { type: "string", minLength: 1 },
        aiAssisted: { type: "boolean" },
        provider: { type: "string" },
        autoApplyThreshold: { type: "number", minimum: 0, maximum: 1 }
      }
    }
  },
  {
    name: "get_pr_health",
    description: "Get unified health status for a PR including checks, reviews, conflicts, and rebase status",
    inputSchema: {
      type: "object",
      required: ["prId"],
      additionalProperties: false,
      properties: {
        prId: { type: "string", minLength: 1 }
      }
    }
  },
  {
    name: "land_queue_next",
    description: "Land the next pending PR in a queue group sequentially",
    inputSchema: {
      type: "object",
      required: ["groupId", "method"],
      additionalProperties: false,
      properties: {
        groupId: { type: "string", minLength: 1 },
        method: { type: "string", minLength: 1 },
        autoResolve: { type: "boolean" },
        confidenceThreshold: { type: "number", minimum: 0, maximum: 1 }
      }
    }
  },
  // ── Mission Lifecycle Tools ──────────────────────────────────────
  {
    name: "create_mission",
    description: "Create a new mission from a prompt.",
    inputSchema: {
      type: "object",
      required: ["prompt"],
      additionalProperties: false,
      properties: {
        prompt: { type: "string", minLength: 1 },
        title: { type: "string" },
        laneId: { type: "string" },
        priority: { type: "string", enum: ["low", "medium", "high", "critical"] },
        executionMode: { type: "string", enum: ["autopilot", "manual"] },
        prStrategy: { type: "string", enum: ["integration", "per-lane", "manual"] },
        executorPolicy: { type: "object" }
      }
    }
  },
  {
    name: "start_mission",
    description: "Start a mission run, triggering planning and execution.",
    inputSchema: {
      type: "object",
      required: ["missionId"],
      additionalProperties: false,
      properties: {
        missionId: { type: "string", minLength: 1 },
        runMode: { type: "string", enum: ["autopilot", "manual"] },
        defaultExecutorKind: { type: "string" },
        coordinatorModel: { type: "string" }
      }
    }
  },
  {
    name: "pause_mission",
    description: "Pause an active mission run.",
    inputSchema: {
      type: "object",
      required: ["runId"],
      additionalProperties: false,
      properties: {
        runId: { type: "string", minLength: 1 },
        reason: { type: "string" }
      }
    }
  },
  {
    name: "resume_mission",
    description: "Resume a paused mission run.",
    inputSchema: {
      type: "object",
      required: ["runId"],
      additionalProperties: false,
      properties: {
        runId: { type: "string", minLength: 1 }
      }
    }
  },
  {
    name: "cancel_mission",
    description: "Cancel an active mission run gracefully.",
    inputSchema: {
      type: "object",
      required: ["runId"],
      additionalProperties: false,
      properties: {
        runId: { type: "string", minLength: 1 },
        reason: { type: "string" }
      }
    }
  },
  {
    name: "steer_mission",
    description: "Inject a steering directive into an active mission.",
    inputSchema: {
      type: "object",
      required: ["missionId", "directive"],
      additionalProperties: false,
      properties: {
        missionId: { type: "string", minLength: 1 },
        directive: { type: "string", minLength: 1 },
        targetStepKey: { type: "string" },
        priority: { type: "string", enum: ["suggestion", "instruction", "override"] }
      }
    }
  },
  {
    name: "approve_plan",
    description: "Approve or reject a mission's execution plan.",
    inputSchema: {
      type: "object",
      required: ["missionId", "approved"],
      additionalProperties: false,
      properties: {
        missionId: { type: "string", minLength: 1 },
        approved: { type: "boolean" },
        feedback: { type: "string" }
      }
    }
  },
  {
    name: "resolve_intervention",
    description: "Resolve an open mission intervention.",
    inputSchema: {
      type: "object",
      required: ["missionId", "interventionId", "status"],
      additionalProperties: false,
      properties: {
        missionId: { type: "string", minLength: 1 },
        interventionId: { type: "string", minLength: 1 },
        status: { type: "string", enum: ["resolved", "dismissed"] },
        note: { type: "string" }
      }
    }
  },
  // ── Observation Tools ────────────────────────────────────────────
  {
    name: "get_mission",
    description: "Get full mission details including steps, interventions, and metadata. When called by a worker, missionId defaults to the worker's own mission.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        missionId: { type: "string", description: "Mission ID. Auto-populated from caller context if omitted." }
      }
    }
  },
  {
    name: "get_run_graph",
    description: "Get the full run graph: run, steps, attempts, claims, timeline. When called by a worker, runId defaults to the worker's own run.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        runId: { type: "string", description: "Run ID. Auto-populated from caller context if omitted." },
        timelineLimit: { type: "number", minimum: 0, maximum: 1000 }
      }
    }
  },
  {
    name: "stream_events",
    description: "Poll buffered orchestrator events using a cursor for incremental streaming.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        cursor: { type: "number", minimum: 0 },
        limit: { type: "number", minimum: 1, maximum: 1000 },
        category: { type: "string", enum: ["orchestrator", "dag_mutation", "runtime", "mission"] }
      }
    }
  },
  {
    name: "get_step_output",
    description: "Get the output/result of a specific step in a run. When called by a worker, runId defaults to the worker's own run.",
    inputSchema: {
      type: "object",
      required: ["stepKey"],
      additionalProperties: false,
      properties: {
        runId: { type: "string", description: "Run ID. Auto-populated from caller context if omitted." },
        stepKey: { type: "string", minLength: 1 }
      }
    }
  },
  {
    name: "get_worker_states",
    description: "Get the current state of all workers in a run. When called by a worker, runId defaults to the worker's own run, so you can see your peers without passing parameters.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        runId: { type: "string", description: "Run ID. Auto-populated from caller context if omitted." }
      }
    }
  },
  {
    name: "get_timeline",
    description: "Get timeline events for a run, optionally filtered by step. When called by a worker, runId defaults to the worker's own run.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        runId: { type: "string", description: "Run ID. Auto-populated from caller context if omitted." },
        limit: { type: "number", minimum: 1, maximum: 1000 },
        stepId: { type: "string" }
      }
    }
  },
  {
    name: "get_mission_metrics",
    description: "Get aggregated metrics for a mission. When called by a worker, missionId defaults to the worker's own mission.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        missionId: { type: "string", description: "Mission ID. Auto-populated from caller context if omitted." }
      }
    }
  },
  {
    name: "get_final_diff",
    description: "Get the final diff output for a completed run. When called by a worker, runId defaults to the worker's own run.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        runId: { type: "string", description: "Run ID. Auto-populated from caller context if omitted." }
      }
    }
  },
  // ── Evaluation Tools ─────────────────────────────────────────────
  {
    name: "evaluate_run",
    description: "Submit a structured evaluation of a mission run.",
    inputSchema: {
      type: "object",
      required: ["runId", "missionId", "scores", "issues", "summary"],
      additionalProperties: false,
      properties: {
        runId: { type: "string", minLength: 1 },
        missionId: { type: "string", minLength: 1 },
        scores: {
          type: "object",
          required: ["planQuality", "parallelism", "coordinatorDecisions", "resourceEfficiency", "outcomeQuality"],
          additionalProperties: false,
          properties: {
            planQuality: { type: "number", minimum: 0, maximum: 10 },
            parallelism: { type: "number", minimum: 0, maximum: 10 },
            coordinatorDecisions: { type: "number", minimum: 0, maximum: 10 },
            resourceEfficiency: { type: "number", minimum: 0, maximum: 10 },
            outcomeQuality: { type: "number", minimum: 0, maximum: 10 }
          }
        },
        issues: {
          type: "array",
          items: {
            type: "object",
            required: ["category", "severity", "description", "recommendation"],
            additionalProperties: false,
            properties: {
              category: { type: "string", enum: ["planning", "execution", "coordination", "recovery", "output"] },
              severity: { type: "string", enum: ["minor", "major", "critical"] },
              description: { type: "string", minLength: 1 },
              stepKey: { type: "string" },
              recommendation: { type: "string", minLength: 1 }
            }
          }
        },
        summary: { type: "string", minLength: 1 },
        improvements: { type: "array", items: { type: "string" } },
        metadata: { type: "object" }
      }
    }
  },
  {
    name: "list_evaluations",
    description: "List evaluations for a mission or run.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        missionId: { type: "string" },
        runId: { type: "string" },
        limit: { type: "number", minimum: 1, maximum: 100 }
      }
    }
  },
  {
    name: "get_evaluation_report",
    description: "Get a full evaluation report with run context.",
    inputSchema: {
      type: "object",
      required: ["evaluationId"],
      additionalProperties: false,
      properties: {
        evaluationId: { type: "string", minLength: 1 }
      }
    }
  },
  // ── Worker Collaboration Tools ─────────────────────────────────
  {
    name: "get_pending_messages",
    description: "Get pending messages for this worker. Returns messages from coordinator, peers, or system. Uses caller identity from environment to auto-resolve the worker.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        since_cursor: {
          type: "string",
          description: "Optional ISO timestamp cursor to get messages after a certain point"
        },
        limit: {
          type: "number",
          description: "Maximum number of messages to return (default 50, max 200)"
        }
      }
    }
  }
];

const COORDINATOR_TOOL_SPECS: ToolSpec[] = [
  {
    name: "spawn_worker",
    description: "Coordinator: spawn a new worker step in the current mission run.",
    inputSchema: {
      type: "object",
      required: ["name", "prompt"],
      additionalProperties: true,
      properties: {
        name: { type: "string", minLength: 1 },
        prompt: { type: "string", minLength: 1 }
      }
    }
  },
  { name: "insert_milestone", description: "Coordinator: insert a milestone gate into the DAG.", inputSchema: { type: "object", additionalProperties: true, properties: {} } },
  { name: "request_specialist", description: "Coordinator: request a specialist worker role.", inputSchema: { type: "object", additionalProperties: true, properties: {} } },
  { name: "delegate_to_subagent", description: "Coordinator: delegate a subtask from a parent worker.", inputSchema: { type: "object", additionalProperties: true, properties: {} } },
  { name: "stop_worker", description: "Coordinator: stop a running worker attempt.", inputSchema: { type: "object", additionalProperties: true, properties: {} } },
  { name: "send_message", description: "Coordinator: send a direct message to a worker.", inputSchema: { type: "object", additionalProperties: true, properties: {} } },
  { name: "message_worker", description: "Coordinator: relay a message between two workers.", inputSchema: { type: "object", additionalProperties: true, properties: {} } },
  { name: "broadcast", description: "Coordinator: broadcast a message to active workers.", inputSchema: { type: "object", additionalProperties: true, properties: {} } },
  { name: "get_worker_output", description: "Coordinator: fetch latest output/report for a worker step.", inputSchema: { type: "object", additionalProperties: true, properties: {} } },
  { name: "list_workers", description: "Coordinator: list current worker states.", inputSchema: { type: "object", additionalProperties: true, properties: {} } },
  { name: "report_status", description: "Worker: report progress/status to the coordinator.", inputSchema: { type: "object", additionalProperties: true, properties: {} } },
  { name: "report_result", description: "Worker: report completion result to the coordinator.", inputSchema: { type: "object", additionalProperties: true, properties: {} } },
  { name: "report_validation", description: "Validator: report validation verdict/findings for a step.", inputSchema: { type: "object", additionalProperties: true, properties: {} } },
  { name: "read_mission_status", description: "Coordinator: read full mission/run status snapshot.", inputSchema: { type: "object", additionalProperties: true, properties: {} } },
  { name: "read_mission_state", description: "Coordinator: read persisted mission state document.", inputSchema: { type: "object", additionalProperties: true, properties: {} } },
  { name: "update_mission_state", description: "Coordinator: patch persisted mission state document.", inputSchema: { type: "object", additionalProperties: true, properties: {} } },
  { name: "revise_plan", description: "Coordinator: revise mission DAG/plan.", inputSchema: { type: "object", additionalProperties: true, properties: {} } },
  { name: "update_tool_profiles", description: "Coordinator: update runtime role/tool profiles.", inputSchema: { type: "object", additionalProperties: true, properties: {} } },
  { name: "transfer_lane", description: "Coordinator: transfer a worker step to another lane.", inputSchema: { type: "object", additionalProperties: true, properties: {} } },
  { name: "provision_lane", description: "Coordinator: provision a new mission child lane.", inputSchema: { type: "object", additionalProperties: true, properties: {} } },
  { name: "create_task", description: "Coordinator: create a logical mission task without spawning a worker.", inputSchema: { type: "object", additionalProperties: true, properties: {} } },
  { name: "update_task", description: "Coordinator: update task metadata/status.", inputSchema: { type: "object", additionalProperties: true, properties: {} } },
  { name: "assign_task", description: "Coordinator: assign a task to an existing worker.", inputSchema: { type: "object", additionalProperties: true, properties: {} } },
  { name: "list_tasks", description: "Coordinator: list mission tasks and status.", inputSchema: { type: "object", additionalProperties: true, properties: {} } },
  { name: "skip_step", description: "Coordinator: skip a worker step.", inputSchema: { type: "object", additionalProperties: true, properties: {} } },
  { name: "mark_step_complete", description: "Coordinator: mark a worker step as succeeded.", inputSchema: { type: "object", additionalProperties: true, properties: {} } },
  { name: "mark_step_failed", description: "Coordinator: mark a worker step as failed.", inputSchema: { type: "object", additionalProperties: true, properties: {} } },
  { name: "retry_step", description: "Coordinator: retry a failed worker step.", inputSchema: { type: "object", additionalProperties: true, properties: {} } },
  { name: "complete_mission", description: "Coordinator: finalize the mission run as succeeded.", inputSchema: { type: "object", additionalProperties: true, properties: {} } },
  { name: "fail_mission", description: "Coordinator: finalize the mission run as failed.", inputSchema: { type: "object", additionalProperties: true, properties: {} } },
  { name: "get_budget_status", description: "Coordinator: inspect mission budget pressure/hard caps.", inputSchema: { type: "object", additionalProperties: true, properties: {} } },
  { name: "request_user_input", description: "Coordinator: open a user intervention with a question.", inputSchema: { type: "object", additionalProperties: true, properties: {} } },
  { name: "read_file", description: "Coordinator: read a file within project root.", inputSchema: { type: "object", additionalProperties: true, properties: {} } },
  { name: "read_step_output", description: "Coordinator: read output artifact for a specific step.", inputSchema: { type: "object", additionalProperties: true, properties: {} } },
  { name: "search_files", description: "Coordinator: search files/content in project root.", inputSchema: { type: "object", additionalProperties: true, properties: {} } },
  { name: "get_project_context", description: "Coordinator: return compact mission/project context for planning.", inputSchema: { type: "object", additionalProperties: true, properties: {} } },
];

const ALL_TOOL_SPECS: ToolSpec[] = [...TOOL_SPECS, ...COORDINATOR_TOOL_SPECS];
const COORDINATOR_TOOL_NAMES = new Set(COORDINATOR_TOOL_SPECS.map((tool) => tool.name));

const READ_ONLY_TOOLS = new Set([
  "read_context",
  "check_conflicts",
  "get_lane_status",
  "list_lanes",
  "simulate_integration",
  "get_pr_health",
  "memory_search"
]);

const MUTATION_TOOLS = new Set([
  "create_lane",
  "merge_lane",
  "commit_changes",
  "run_tests",
  "create_queue",
  "create_integration",
  "rebase_lane",
  "land_queue_next",
  "memory_add",
  "spawn_agent"
]);

const ORCHESTRATION_TOOLS = new Set([
  "create_mission",
  "start_mission",
  "pause_mission",
  "resume_mission",
  "cancel_mission",
  "steer_mission",
  "approve_plan",
  "resolve_intervention"
]);

const OBSERVATION_TOOLS = new Set([
  "get_mission",
  "get_run_graph",
  "stream_events",
  "get_step_output",
  "get_worker_states",
  "get_timeline",
  "get_mission_metrics",
  "get_final_diff",
  "get_pending_messages"
]);

const EVALUATOR_TOOLS = new Set([
  "evaluate_run"
]);

const EVALUATION_READ_TOOLS = new Set([
  "list_evaluations",
  "get_evaluation_report"
]);

function nowIso(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeObject(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asOptionalTrimmedString(value: unknown): string | null {
  const text = asTrimmedString(value);
  return text.length ? text : null;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function assertNonEmptyString(value: unknown, field: string): string {
  const text = asTrimmedString(value);
  if (!text.length) {
    throw new JsonRpcError(JsonRpcErrorCode.invalidParams, `${field} is required`);
  }
  return text;
}

function normalizeExportLevel(value: unknown, fallback: ContextExportLevel = "standard"): ContextExportLevel {
  if (value === "lite" || value === "standard" || value === "deep") return value;
  return fallback;
}

type MemoryToolCategory = "fact" | "preference" | "pattern" | "decision" | "gotcha";
type MemoryToolImportance = "low" | "medium" | "high";
type SharedFactType = "api_pattern" | "schema_change" | "config" | "architectural" | "gotcha";

function parseMemoryToolCategory(value: unknown): MemoryToolCategory {
  const category = asTrimmedString(value);
  if (
    category === "fact" ||
    category === "preference" ||
    category === "pattern" ||
    category === "decision" ||
    category === "gotcha"
  ) {
    return category;
  }
  throw new JsonRpcError(
    JsonRpcErrorCode.invalidParams,
    "category must be one of: fact, preference, pattern, decision, gotcha"
  );
}

function parseMemoryToolImportance(value: unknown): MemoryToolImportance {
  const importance = asOptionalTrimmedString(value) ?? "medium";
  if (importance === "low" || importance === "medium" || importance === "high") {
    return importance;
  }
  throw new JsonRpcError(JsonRpcErrorCode.invalidParams, "importance must be one of: low, medium, high");
}

function mapMemoryCategoryToSharedFactType(category: MemoryToolCategory): SharedFactType {
  if (category === "pattern") return "api_pattern";
  if (category === "preference") return "config";
  if (category === "gotcha") return "gotcha";
  return "architectural";
}

function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function mcpTextResult(value: unknown, isError = false): Record<string, unknown> {
  const text = typeof value === "string" ? value : jsonText(value);
  return {
    content: [{ type: "text", text }],
    structuredContent: value,
    ...(isError ? { isError: true } : {})
  };
}

function sanitizeForAudit(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[depth-clipped]";
  if (value == null) return value;
  if (typeof value === "string") {
    return value.length > 500 ? `${value.slice(0, 500)}…` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.slice(0, 40).map((entry) => sanitizeForAudit(entry, depth + 1));
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const [key, entry] of Object.entries(value)) {
      out[key] = sanitizeForAudit(entry, depth + 1);
      count += 1;
      if (count >= 40) {
        out.__truncated__ = true;
        break;
      }
    }
    return out;
  }
  return String(value);
}

function requirePrService(runtime: AdeMcpRuntime): NonNullable<AdeMcpRuntime["prService"]> {
  if (!runtime.prService) {
    throw new JsonRpcError(JsonRpcErrorCode.internalError, "prService is not available in this MCP runtime configuration");
  }
  return runtime.prService;
}

function extractLaneId(args: Record<string, unknown>): string | null {
  const fromPrimary = asOptionalTrimmedString(args.laneId);
  if (fromPrimary) return fromPrimary;
  const fromParent = asOptionalTrimmedString(args.parentLaneId);
  if (fromParent) return fromParent;
  return null;
}

function stripInjectionChars(value: string): string {
  return value.replace(/[\n\r\0]/g, " ");
}

function shellEscapeArg(value: string): string {
  const sanitized = stripInjectionChars(value);
  if (!sanitized.length) return "''";
  if (/^[a-zA-Z0-9_./:-]+$/.test(sanitized)) return sanitized;
  return `'${sanitized.replace(/'/g, `'"'"'`)}'`;
}

function clipText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 18))}\n...<truncated>`;
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

type SpawnPermissionMode = "plan" | "edit" | "full-auto";

function parseSpawnPermissionMode(value: unknown): SpawnPermissionMode {
  const normalized = asTrimmedString(value).toLowerCase();
  if (normalized === "plan" || normalized === "full-auto") return normalized;
  return "edit";
}

function normalizeToolWhitelist(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((entry) => asTrimmedString(entry)).filter(Boolean))].slice(0, 24);
}

function resolveSpawnContextFile(args: {
  runtime: AdeMcpRuntime;
  laneId: string;
  provider: "codex" | "claude";
  permissionMode: SpawnPermissionMode;
  runId: string | null;
  stepId: string | null;
  attemptId: string | null;
  userPrompt: string | null;
  context: Record<string, unknown>;
  contextFilePathRaw: string | null;
}): { contextFilePath: string | null; contextDigest: string | null; contextBytes: number | null; approxTokens: number } {
  const contextFilePathRaw = args.contextFilePathRaw?.trim() ?? "";
  const packList = Array.isArray(args.context.packs) ? args.context.packs : [];
  const docsList = Array.isArray(args.context.docs) ? args.context.docs : [];
  const hasContextPayload = packList.length > 0 || docsList.length > 0 || Object.keys(args.context).length > 0;
  const approxTokens = packList.reduce((sum, item) => {
    const record = safeObject(item);
    const raw = Number(record.approxTokens ?? 0);
    return sum + (Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0);
  }, 0);

  if (!contextFilePathRaw && !hasContextPayload) {
    return { contextFilePath: null, contextDigest: null, contextBytes: null, approxTokens };
  }

  if (contextFilePathRaw.length) {
    if (path.isAbsolute(contextFilePathRaw)) {
      throw new JsonRpcError(JsonRpcErrorCode.invalidParams, "contextFilePath must be a relative path within the project directory");
    }
    const abs = path.resolve(args.runtime.projectRoot, contextFilePathRaw);
    if (!abs.startsWith(args.runtime.projectRoot + path.sep) && abs !== args.runtime.projectRoot) {
      throw new JsonRpcError(JsonRpcErrorCode.invalidParams, "contextFilePath must be within the project directory");
    }
    if (!fs.existsSync(abs)) {
      throw new JsonRpcError(JsonRpcErrorCode.invalidParams, `contextFilePath does not exist: ${contextFilePathRaw}`);
    }
    const text = fs.readFileSync(abs, "utf8");
    return {
      contextFilePath: abs,
      contextDigest: sha256Text(text),
      contextBytes: Buffer.byteLength(text, "utf8"),
      approxTokens
    };
  }

  const baseDir = path.join(args.runtime.projectRoot, ".ade", "orchestrator", "mcp-context");
  const runSegment = args.runId ?? "standalone";
  const dir = path.join(baseDir, runSegment);
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${randomUUID()}.json`;
  const contextFilePath = path.join(dir, filename);
  const payload = {
    schema: "ade.mcp.spawnAgentContext.v1",
    generatedAt: nowIso(),
    mission: {
      runId: args.runId,
      stepId: args.stepId,
      attemptId: args.attemptId
    },
    worker: {
      laneId: args.laneId,
      provider: args.provider,
      permissionMode: args.permissionMode
    },
    promptPreview: args.userPrompt ? clipText(args.userPrompt, 2000) : null,
    context: {
      profile: asOptionalTrimmedString(args.context.profile),
      packs: packList.slice(0, 24).map((item) => {
        const record = safeObject(item);
        return {
          scope: asOptionalTrimmedString(record.scope),
          packKey: asOptionalTrimmedString(record.packKey),
          level: asOptionalTrimmedString(record.level),
          approxTokens: Number.isFinite(Number(record.approxTokens)) ? Number(record.approxTokens) : null,
          summary: clipText(asTrimmedString(record.summary), 800)
        };
      }),
      docs: docsList.slice(0, 40).map((item) => {
        const record = safeObject(item);
        return {
          path: asOptionalTrimmedString(record.path),
          sha256: asOptionalTrimmedString(record.sha256),
          bytes: Number.isFinite(Number(record.bytes)) ? Number(record.bytes) : null
        };
      }),
      handoffDigest: safeObject(args.context.handoffDigest)
    }
  };
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  fs.writeFileSync(contextFilePath, serialized, "utf8");
  return {
    contextFilePath,
    contextDigest: sha256Text(serialized),
    contextBytes: Buffer.byteLength(serialized, "utf8"),
    approxTokens
  };
}

function mapLaneSummary(lane: Record<string, unknown>): Record<string, unknown> {
  return {
    id: lane.id,
    name: lane.name,
    laneType: lane.laneType,
    parentLaneId: lane.parentLaneId,
    baseRef: lane.baseRef,
    branchRef: lane.branchRef,
    worktreePath: lane.worktreePath,
    archivedAt: lane.archivedAt,
    stackDepth: lane.stackDepth,
    status: lane.status
  };
}

/**
 * Caller context resolved from environment variables.
 * Workers spawned by the orchestrator have ADE_MISSION_ID, ADE_RUN_ID, etc.
 * set in their environment. These provide automatic identity and context defaults.
 */
type CallerContext = {
  missionId: string | null;
  runId: string | null;
  stepId: string | null;
  attemptId: string | null;
};

function resolveEnvCallerContext(): CallerContext {
  return {
    missionId: process.env.ADE_MISSION_ID?.trim() || null,
    runId: process.env.ADE_RUN_ID?.trim() || null,
    stepId: process.env.ADE_STEP_ID?.trim() || null,
    attemptId: process.env.ADE_ATTEMPT_ID?.trim() || null
  };
}

function resolveCallerContext(session?: SessionState): CallerContext {
  const envContext = resolveEnvCallerContext();
  if (!session) return envContext;
  return {
    missionId: session.identity.missionId ?? envContext.missionId,
    runId: session.identity.runId ?? envContext.runId,
    stepId: session.identity.stepId ?? envContext.stepId,
    attemptId: session.identity.attemptId ?? envContext.attemptId
  };
}

function parseInitializeIdentity(params: unknown): SessionIdentity {
  const data = safeObject(params);
  const identity = safeObject(data.identity);
  const envContext = resolveEnvCallerContext();
  const role = asTrimmedString(identity.role) || process.env.ADE_DEFAULT_ROLE || "";
  const validRole: SessionIdentity["role"] =
    role === "orchestrator" || role === "agent" || role === "evaluator" ? role : "external";

  return {
    callerId: asOptionalTrimmedString(identity.callerId) ?? envContext.attemptId ?? "unknown",
    role: validRole,
    missionId: asOptionalTrimmedString(identity.missionId) ?? envContext.missionId,
    runId: asOptionalTrimmedString(identity.runId) ?? envContext.runId,
    stepId: asOptionalTrimmedString(identity.stepId) ?? envContext.stepId,
    attemptId: asOptionalTrimmedString(identity.attemptId) ?? envContext.attemptId,
    ownerId: asOptionalTrimmedString(identity.ownerId)
  };
}

function parseMcpUri(uriRaw: string): { path: string[] } {
  const trimmed = uriRaw.trim();
  if (!trimmed.startsWith("ade://")) {
    throw new JsonRpcError(JsonRpcErrorCode.invalidParams, `Unsupported resource URI: ${uriRaw}`);
  }
  const body = trimmed.slice("ade://".length);
  const pathParts = body.split("/").map((part) => decodeURIComponent(part));
  return { path: pathParts.filter((part) => part.length > 0) };
}

function resourceListFromLanes(lanes: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const resources: Array<Record<string, unknown>> = [
    {
      uri: "ade://pack/project/lite",
      name: "Project Pack (Lite)",
      description: "Project context export (lite)",
      mimeType: RESOURCE_MIME_MARKDOWN
    },
    {
      uri: "ade://pack/project/standard",
      name: "Project Pack (Standard)",
      description: "Project context export (standard)",
      mimeType: RESOURCE_MIME_MARKDOWN
    },
    {
      uri: "ade://pack/project/deep",
      name: "Project Pack (Deep)",
      description: "Project context export (deep)",
      mimeType: RESOURCE_MIME_MARKDOWN
    }
  ];

  for (const lane of lanes) {
    const laneId = asTrimmedString(lane.id);
    const laneName = asTrimmedString(lane.name) || laneId;
    if (!laneId) continue;

    for (const level of ["lite", "standard", "deep"] as const) {
      resources.push({
        uri: `ade://pack/lane/${encodeURIComponent(laneId)}/${level}`,
        name: `${laneName} Pack (${level})`,
        description: `Lane context export for '${laneName}' (${level})`,
        mimeType: RESOURCE_MIME_MARKDOWN
      });
    }

    resources.push({
      uri: `ade://lane/${encodeURIComponent(laneId)}/status`,
      name: `${laneName} Status`,
      description: `Lane status snapshot for '${laneName}'`,
      mimeType: RESOURCE_MIME_JSON
    });

    resources.push({
      uri: `ade://lane/${encodeURIComponent(laneId)}/conflicts`,
      name: `${laneName} Conflict Summary`,
      description: `Conflict overlap summary for '${laneName}'`,
      mimeType: RESOURCE_MIME_JSON
    });
  }

  return resources;
}

function appendPackResource(
  resources: Array<Record<string, unknown>>,
  args: {
    uri: string;
    name: string;
    description: string;
  }
): void {
  resources.push({
    uri: args.uri,
    name: args.name,
    description: args.description,
    mimeType: RESOURCE_MIME_MARKDOWN
  });
}

function listFeatureKeysFromLanes(lanes: Array<Record<string, unknown>>): string[] {
  const keys = new Set<string>();

  for (const lane of lanes) {
    const rawTags = Array.isArray(lane.tags) ? lane.tags : [];
    for (const tag of rawTags) {
      const key = asTrimmedString(tag);
      if (key.length) keys.add(key);
    }
  }

  return [...keys].sort((a, b) => a.localeCompare(b));
}

function listMissionIds(runtime: AdeMcpRuntime): string[] {
  const rows = runtime.db.all<{ id: string }>(
    `
      select id
      from missions
      where project_id = ?
      order by updated_at desc
      limit 120
    `,
    [runtime.projectId]
  );

  return rows
    .map((row) => asTrimmedString(row.id))
    .filter((entry) => entry.length > 0);
}

function buildResourceList(args: {
  lanes: Array<Record<string, unknown>>;
  featureKeys: string[];
  missionIds: string[];
}): Array<Record<string, unknown>> {
  const resources = resourceListFromLanes(args.lanes);

  for (const lane of args.lanes) {
    const laneId = asTrimmedString(lane.id);
    const laneName = asTrimmedString(lane.name) || laneId;
    if (!laneId) continue;

    for (const level of ["lite", "standard", "deep"] as const) {
      appendPackResource(resources, {
        uri: `ade://pack/plan/${encodeURIComponent(laneId)}/${level}`,
        name: `${laneName} Plan Pack (${level})`,
        description: `Plan pack export for lane '${laneName}' (${level})`
      });
      appendPackResource(resources, {
        uri: `ade://pack/conflict/${encodeURIComponent(laneId)}/base/${level}`,
        name: `${laneName} Conflict Pack (${level})`,
        description: `Conflict pack export anchored to lane '${laneName}' (${level})`
      });
    }
  }

  for (const featureKey of args.featureKeys) {
    for (const level of ["lite", "standard", "deep"] as const) {
      appendPackResource(resources, {
        uri: `ade://pack/feature/${encodeURIComponent(featureKey)}/${level}`,
        name: `Feature Pack: ${featureKey} (${level})`,
        description: `Feature pack export for '${featureKey}' (${level})`
      });
    }
  }

  for (const missionId of args.missionIds) {
    for (const level of ["lite", "standard", "deep"] as const) {
      appendPackResource(resources, {
        uri: `ade://pack/mission/${encodeURIComponent(missionId)}/${level}`,
        name: `Mission Pack: ${missionId} (${level})`,
        description: `Mission pack export for mission '${missionId}' (${level})`
      });
    }
  }

  return resources;
}

function findToolSpec(name: string): ToolSpec {
  const match = ALL_TOOL_SPECS.find((entry) => entry.name === name);
  if (!match) {
    throw new JsonRpcError(JsonRpcErrorCode.methodNotFound, `Unknown MCP tool: ${name}`);
  }
  return match;
}

async function waitForTestRunCompletion(args: {
  runtime: AdeMcpRuntime;
  runId: string;
  laneId: string;
  timeoutMs: number;
}): Promise<Record<string, unknown>> {
  const { runtime, runId, laneId, timeoutMs } = args;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    const rows = runtime.testService.listRuns({ laneId, limit: 500 });
    const run = rows.find((entry) => entry.id === runId);
    if (run && run.status !== "running") {
      return {
        run,
        logTail: runtime.testService.getLogTail({ runId, maxBytes: 220_000 })
      };
    }
    await sleep(500);
  }

  runtime.testService.stop({ runId });
  const rows = runtime.testService.listRuns({ laneId, limit: 500 });
  const run = rows.find((entry) => entry.id === runId) ?? null;
  return {
    run,
    timedOut: true,
    logTail: runtime.testService.getLogTail({ runId, maxBytes: 220_000 })
  };
}

async function waitForSessionCompletion(args: {
  runtime: AdeMcpRuntime;
  ptyId: string;
  sessionId: string;
  timeoutMs: number;
  maxLogBytes: number;
}): Promise<Record<string, unknown>> {
  const { runtime, ptyId, sessionId, timeoutMs, maxLogBytes } = args;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    const session = runtime.sessionService.get(sessionId);
    if (session && session.status !== "running") {
      const logTail = runtime.sessionService.readTranscriptTail(session.transcriptPath, maxLogBytes, {
        raw: true,
        alignToLineBoundary: true
      });
      return {
        session,
        logTail
      };
    }
    await sleep(400);
  }

  runtime.ptyService.dispose({ ptyId, sessionId });
  const session = runtime.sessionService.get(sessionId);
  return {
    session,
    timedOut: true,
    logTail: session
      ? runtime.sessionService.readTranscriptTail(session.transcriptPath, maxLogBytes, {
          raw: true,
          alignToLineBoundary: true
        })
      : ""
  };
}

async function buildLaneStatus(runtime: AdeMcpRuntime, laneId: string): Promise<Record<string, unknown>> {
  const lanes = await runtime.laneService.list({ includeArchived: true });
  const lane = lanes.find((entry) => entry.id === laneId);
  if (!lane) {
    throw new JsonRpcError(JsonRpcErrorCode.invalidParams, `Lane not found: ${laneId}`);
  }

  const changes = await runtime.diffService.getChanges(laneId);
  const conflict = await runtime.conflictService.getLaneStatus({ laneId });
  const gitConflictState = await runtime.gitService.getConflictState({ laneId });

  return {
    lane: mapLaneSummary(lane as unknown as Record<string, unknown>),
    diff: {
      unstagedCount: changes.unstaged.length,
      stagedCount: changes.staged.length,
      hasChanges: changes.unstaged.length > 0 || changes.staged.length > 0
    },
    conflict,
    gitConflictState,
    rebaseStatus: gitConflictState.kind === "rebase" ? "in_progress" : "idle"
  };
}


// Global ask_user rate limit shared across all sessions to prevent
// bypass via session recycling. Limits to 20 calls per 60s globally.
const GLOBAL_ASK_USER_RATE_LIMIT = {
  maxCalls: 20,
  windowMs: 60_000,
  events: [] as number[]
};

/** @internal Exported for test cleanup only. */
export function _resetGlobalAskUserRateLimit(): void {
  GLOBAL_ASK_USER_RATE_LIMIT.events = [];
}

function ensureAskUserAllowed(session: SessionState): void {
  const now = Date.now();

  // Enforce global rate limit (shared across all sessions)
  const globalCutoff = now - GLOBAL_ASK_USER_RATE_LIMIT.windowMs;
  GLOBAL_ASK_USER_RATE_LIMIT.events = GLOBAL_ASK_USER_RATE_LIMIT.events.filter((ts) => ts >= globalCutoff);
  if (GLOBAL_ASK_USER_RATE_LIMIT.events.length >= GLOBAL_ASK_USER_RATE_LIMIT.maxCalls) {
    throw new JsonRpcError(JsonRpcErrorCode.policyDenied, "ask_user global rate limit exceeded.");
  }

  // Enforce per-session rate limit (stricter, per-caller)
  const sessionCutoff = now - session.askUserRateLimit.windowMs;
  session.askUserEvents = session.askUserEvents.filter((ts) => ts >= sessionCutoff);
  if (session.askUserEvents.length >= session.askUserRateLimit.maxCalls) {
    throw new JsonRpcError(JsonRpcErrorCode.policyDenied, "ask_user rate limit exceeded.");
  }

  session.askUserEvents.push(now);
  GLOBAL_ASK_USER_RATE_LIMIT.events.push(now);
}

function ensureMemoryAddAllowed(session: SessionState): void {
  const now = Date.now();
  const cutoff = now - session.memoryAddRateLimit.windowMs;
  session.memoryAddEvents = session.memoryAddEvents.filter((ts) => ts >= cutoff);
  if (session.memoryAddEvents.length >= session.memoryAddRateLimit.maxCalls) {
    throw new JsonRpcError(JsonRpcErrorCode.policyDenied, "memory_add rate limit exceeded.");
  }
  session.memoryAddEvents.push(now);
}

function ensureMemorySearchAllowed(session: SessionState): void {
  const now = Date.now();
  const cutoff = now - session.memorySearchRateLimit.windowMs;
  session.memorySearchEvents = session.memorySearchEvents.filter((ts) => ts >= cutoff);
  if (session.memorySearchEvents.length >= session.memorySearchRateLimit.maxCalls) {
    throw new JsonRpcError(JsonRpcErrorCode.policyDenied, "memory_search rate limit exceeded.");
  }
  session.memorySearchEvents.push(now);
}

type CoordinatorToolCacheEntry = {
  missionId: string;
  tools: Record<string, Tool>;
};

const coordinatorToolCacheByRuntime = new WeakMap<AdeMcpRuntime, Map<string, CoordinatorToolCacheEntry>>();

function resolveMissionIdForRun(runtime: AdeMcpRuntime, runId: string): string | null {
  const graphMissionId = (() => {
    try {
      const graph = runtime.orchestratorService.getRunGraph({ runId, timelineLimit: 0 });
      const runRecord = safeObject(graph.run);
      return asOptionalTrimmedString(runRecord.missionId);
    } catch {
      return null;
    }
  })();
  if (graphMissionId) return graphMissionId;
  const row = runtime.db.get<{ mission_id: string | null }>(
    `
      select mission_id
      from orchestrator_runs
      where id = ?
      limit 1
    `,
    [runId]
  );
  return asOptionalTrimmedString(row?.mission_id);
}

function getCoordinatorToolSet(args: {
  runtime: AdeMcpRuntime;
  runId: string;
  missionId: string;
}): Record<string, Tool> {
  let runtimeCache = coordinatorToolCacheByRuntime.get(args.runtime);
  if (!runtimeCache) {
    runtimeCache = new Map<string, CoordinatorToolCacheEntry>();
    coordinatorToolCacheByRuntime.set(args.runtime, runtimeCache);
  }
  const cached = runtimeCache.get(args.runId);
  if (cached && cached.missionId === args.missionId) {
    return cached.tools;
  }

  const missionRecord = safeObject(args.runtime.missionService.get(args.missionId));
  const missionLaneId = asOptionalTrimmedString(missionRecord.laneId ?? missionRecord.lane_id);
  const toolSet = createCoordinatorToolSet({
    orchestratorService: args.runtime.orchestratorService,
    missionService: args.runtime.missionService,
    runId: args.runId,
    missionId: args.missionId,
    logger: args.runtime.logger,
    db: args.runtime.db,
    projectRoot: args.runtime.projectRoot,
    missionLaneId: missionLaneId ?? undefined,
    onDagMutation: (event) => {
      args.runtime.eventBuffer.push({
        timestamp: nowIso(),
        category: "dag_mutation",
        payload: event as unknown as Record<string, unknown>
      });
    }
  });
  runtimeCache.set(args.runId, {
    missionId: args.missionId,
    tools: toolSet
  });
  return toolSet;
}

async function runCoordinatorTool(args: {
  runtime: AdeMcpRuntime;
  name: string;
  toolArgs: Record<string, unknown>;
  callerCtx: CallerContext;
}): Promise<Record<string, unknown>> {
  const runId = args.callerCtx.runId ?? asOptionalTrimmedString(args.toolArgs.runId);
  if (!runId) {
    throw new JsonRpcError(
      JsonRpcErrorCode.invalidParams,
      `Coordinator tool '${args.name}' requires run context. Provide runId or set ADE_RUN_ID.`
    );
  }
  const missionId =
    args.callerCtx.missionId
    ?? asOptionalTrimmedString(args.toolArgs.missionId)
    ?? resolveMissionIdForRun(args.runtime, runId);
  if (!missionId) {
    throw new JsonRpcError(
      JsonRpcErrorCode.invalidParams,
      `Coordinator tool '${args.name}' requires mission context. Provide missionId or set ADE_MISSION_ID.`
    );
  }

  const toolSet = getCoordinatorToolSet({
    runtime: args.runtime,
    runId,
    missionId
  });
  const toolEntry = toolSet[args.name] as { execute?: (input: Record<string, unknown>) => Promise<unknown> } | undefined;
  if (!toolEntry?.execute) {
    throw new JsonRpcError(JsonRpcErrorCode.methodNotFound, `Coordinator tool not found: ${args.name}`);
  }
  const output = await toolEntry.execute(args.toolArgs);
  if (isRecord(output)) {
    return output;
  }
  return {
    ok: true,
    result: output ?? null
  };
}


async function runTool(args: {
  runtime: AdeMcpRuntime;
  session: SessionState;
  name: string;
  toolArgs: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const { runtime, session, name, toolArgs } = args;
  const callerCtx = resolveCallerContext(session);

  if (COORDINATOR_TOOL_NAMES.has(name)) {
    return await runCoordinatorTool({ runtime, name, toolArgs, callerCtx });
  }

  if (name === "list_lanes") {
    const includeArchived = asBoolean(toolArgs.includeArchived, false);
    const lanes = await runtime.laneService.list({ includeArchived });
    return {
      lanes: lanes.map((lane) => mapLaneSummary(lane as unknown as Record<string, unknown>))
    };
  }

  if (name === "get_lane_status") {
    const laneId = assertNonEmptyString(toolArgs.laneId, "laneId");
    return await buildLaneStatus(runtime, laneId);
  }

  if (name === "create_lane") {


    const nameArg = assertNonEmptyString(toolArgs.name, "name");
    const description = asOptionalTrimmedString(toolArgs.description);
    const parentLaneId = asOptionalTrimmedString(toolArgs.parentLaneId);

    const lane = await runtime.laneService.create({
      name: nameArg,
      ...(description ? { description } : {}),
      ...(parentLaneId ? { parentLaneId } : {})
    });

    return {
      lane: mapLaneSummary(lane as unknown as Record<string, unknown>)
    };
  }

  if (name === "check_conflicts") {
    const laneId = asOptionalTrimmedString(toolArgs.laneId);
    const laneIds = Array.isArray(toolArgs.laneIds)
      ? toolArgs.laneIds.map((entry) => asTrimmedString(entry)).filter(Boolean)
      : undefined;
    const assessment = await runtime.conflictService.runPrediction({
      ...(laneId ? { laneId } : {}),
      ...(laneIds && laneIds.length ? { laneIds } : {})
    });

    return {
      assessment
    };
  }

  if (name === "merge_lane") {
    const laneId = assertNonEmptyString(toolArgs.laneId, "laneId");


    const message = asOptionalTrimmedString(toolArgs.message);
    const deleteSourceLane = asBoolean(toolArgs.deleteSourceLane, false);

    const lanes = await runtime.laneService.list({ includeArchived: false });
    const source = lanes.find((entry) => entry.id === laneId);
    if (!source) {
      throw new JsonRpcError(JsonRpcErrorCode.invalidParams, `Lane not found: ${laneId}`);
    }
    if (!source.parentLaneId) {
      throw new JsonRpcError(JsonRpcErrorCode.invalidParams, "Source lane has no parent lane to merge into.");
    }

    const parentLaneId = source.parentLaneId;


    const parent = runtime.laneService.getLaneBaseAndBranch(parentLaneId);
    const preHead = (await runGit(["rev-parse", "HEAD"], { cwd: parent.worktreePath, timeoutMs: 8_000 })).stdout.trim() || null;

    const mergeArgs = ["merge", "--no-ff"];
    if (message) {
      mergeArgs.push("-m", message);
    }
    mergeArgs.push(source.branchRef);

    const mergeResult = await runGit(mergeArgs, {
      cwd: parent.worktreePath,
      timeoutMs: 180_000
    });

    if (mergeResult.exitCode !== 0) {
      const unmerged = await runGit(["diff", "--name-only", "--diff-filter=U"], {
        cwd: parent.worktreePath,
        timeoutMs: 12_000
      });
      const conflictedFiles = unmerged.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

      return {
        merged: false,
        status: "conflict",
        laneId,
        parentLaneId,
        conflictedFiles,
        error: mergeResult.stderr.trim() || mergeResult.stdout.trim() || "Merge failed"
      };
    }

    const postHead = (await runGit(["rev-parse", "HEAD"], { cwd: parent.worktreePath, timeoutMs: 8_000 })).stdout.trim() || null;

    if (deleteSourceLane) {
      await runtime.laneService.delete({
        laneId,
        deleteBranch: false,
        force: false
      });
    }

    return {
      merged: true,
      status: "clean",
      laneId,
      parentLaneId,
      preHeadSha: preHead,
      postHeadSha: postHead,
      deleteSourceLane
    };
  }

  if (name === "ask_user") {
    ensureAskUserAllowed(session);

    const missionId = assertNonEmptyString(toolArgs.missionId, "missionId");
    const title = assertNonEmptyString(toolArgs.title, "title");
    const body = assertNonEmptyString(toolArgs.body, "body");
    const requestedAction = asOptionalTrimmedString(toolArgs.requestedAction);
    const laneId = asOptionalTrimmedString(toolArgs.laneId);
    const waitForResolutionMs = Math.max(0, Math.floor(asNumber(toolArgs.waitForResolutionMs, 0)));
    const pollIntervalMs = Math.max(100, Math.floor(asNumber(toolArgs.pollIntervalMs, 1000)));

    const intervention = runtime.missionService.addIntervention({
      missionId,
      interventionType: "manual_input",
      title,
      body,
      ...(requestedAction ? { requestedAction } : {}),
      ...(laneId ? { laneId } : {})
    });

    if (waitForResolutionMs <= 0) {
      return {
        intervention,
        awaitingUserResponse: true
      };
    }

    const deadline = Date.now() + waitForResolutionMs;
    while (Date.now() <= deadline) {
      const mission = runtime.missionService.get(missionId);
      const latest = mission?.interventions.find((entry) => entry.id === intervention.id) ?? null;
      if (latest && latest.status !== "open") {
        return {
          intervention: latest,
          awaitingUserResponse: false
        };
      }
      await sleep(pollIntervalMs);
    }

    const mission = runtime.missionService.get(missionId);
    const latest = mission?.interventions.find((entry) => entry.id === intervention.id) ?? intervention;
    return {
      intervention: latest,
      awaitingUserResponse: true,
      timedOut: true
    };
  }

  if (name === "memory_add") {
    ensureMemoryAddAllowed(session);

    const content = assertNonEmptyString(toolArgs.content, "content");
    const category = parseMemoryToolCategory(toolArgs.category);
    const importance = parseMemoryToolImportance(toolArgs.importance);

    let memoryWritten = false;
    let memoryId: string | null = null;
    let memoryError: string | null = null;
    try {
      const memory = runtime.memoryService.addMemory({
        projectId: runtime.projectId,
        scope: "project",
        category,
        content,
        importance,
        ...(callerCtx.runId ? { sourceRunId: callerCtx.runId } : {})
      });
      memoryWritten = true;
      memoryId = memory.id;
    } catch (error) {
      memoryError = error instanceof Error ? error.message : String(error);
    }

    const sharedFactAttempted = Boolean(callerCtx.runId);
    const sharedFactType = mapMemoryCategoryToSharedFactType(category);
    let sharedFactWritten = false;
    let sharedFactId: string | null = null;
    let sharedFactError: string | null = null;

    if (sharedFactAttempted) {
      try {
        const sharedFact = runtime.memoryService.addSharedFact({
          runId: callerCtx.runId as string,
          stepId: callerCtx.stepId ?? undefined,
          factType: sharedFactType,
          content
        });
        sharedFactWritten = true;
        sharedFactId = sharedFact.id;
      } catch (error) {
        sharedFactError = error instanceof Error ? error.message : String(error);
      }
    }

    return {
      content,
      category,
      importance,
      memory: {
        written: memoryWritten,
        id: memoryId,
        ...(memoryError ? { error: memoryError } : {})
      },
      sharedFact: {
        attempted: sharedFactAttempted,
        written: sharedFactWritten,
        id: sharedFactId,
        ...(sharedFactAttempted
          ? {
              runId: callerCtx.runId,
              stepId: callerCtx.stepId ?? null,
              factType: sharedFactType
            }
          : {}),
        ...(sharedFactError ? { error: sharedFactError } : {})
      },
      wroteAny: memoryWritten || sharedFactWritten
    };
  }

  if (name === "memory_search") {
    ensureMemorySearchAllowed(session);

    const query = assertNonEmptyString(toolArgs.query, "query");
    const limit = Math.max(1, Math.min(50, Math.floor(asNumber(toolArgs.limit, 5))));
    const memories = runtime.memoryService.searchMemories(query, runtime.projectId, undefined, limit);

    return {
      query,
      count: memories.length,
      memories: memories.map((memory) => ({
        id: memory.id,
        category: memory.category,
        content: memory.content,
        importance: memory.importance,
        createdAt: memory.createdAt
      }))
    };
  }

  if (name === "run_tests") {
    const laneId = assertNonEmptyString(toolArgs.laneId, "laneId");

    const suiteId = asOptionalTrimmedString(toolArgs.suiteId);
    const command = asOptionalTrimmedString(toolArgs.command);
    const waitForCompletion = asBoolean(toolArgs.waitForCompletion, true);
    const timeoutMs = Math.max(500, Math.floor(asNumber(toolArgs.timeoutMs, 10 * 60_000)));
    const maxLogBytes = Math.max(1024, Math.floor(asNumber(toolArgs.maxLogBytes, 220_000)));

    if (!suiteId && !command) {
      throw new JsonRpcError(JsonRpcErrorCode.invalidParams, "run_tests requires either suiteId or command.");
    }

    if (suiteId) {
      const run = await runtime.testService.run({ laneId, suiteId });
      if (!waitForCompletion) {
        return { run };
      }
      const result = await waitForTestRunCompletion({ runtime, runId: run.id, laneId, timeoutMs });
      return {
        mode: "suite",
        suiteId,
        ...result
      };
    }

    const commandText = assertNonEmptyString(command, "command");

    const pty = await runtime.ptyService.create({
      laneId,
      cols: DEFAULT_PTY_COLS,
      rows: DEFAULT_PTY_ROWS,
      title: `MCP Test: ${commandText}`,
      tracked: true,
      toolType: "shell",
      startupCommand: commandText
    });

    if (!waitForCompletion) {
      return {
        mode: "command",
        laneId,
        command: commandText,
        ptyId: pty.ptyId,
        sessionId: pty.sessionId
      };
    }

    const result = await waitForSessionCompletion({
      runtime,
      ptyId: pty.ptyId,
      sessionId: pty.sessionId,
      timeoutMs,
      maxLogBytes
    });

    return {
      mode: "command",
      laneId,
      command: commandText,
      ptyId: pty.ptyId,
      sessionId: pty.sessionId,
      ...result
    };
  }

  if (name === "commit_changes") {
    const laneId = assertNonEmptyString(toolArgs.laneId, "laneId");


    const message = assertNonEmptyString(toolArgs.message, "message");
    const amend = asBoolean(toolArgs.amend, false);
    const stageAll = asBoolean(toolArgs.stageAll, true);

    if (stageAll) {
      await runtime.gitService.stageAll({ laneId, paths: [] });
    }

    const action = await runtime.gitService.commit({ laneId, message, amend });
    const latest = await runtime.gitService.listRecentCommits({ laneId, limit: 1 });

    return {
      action,
      commit: latest[0] ?? null
    };
  }

  if (name === "simulate_integration") {
    const sourceLaneIds = Array.isArray(toolArgs.sourceLaneIds)
      ? toolArgs.sourceLaneIds.map((entry) => asTrimmedString(entry)).filter(Boolean)
      : [];
    if (!sourceLaneIds.length) {
      throw new JsonRpcError(JsonRpcErrorCode.invalidParams, "sourceLaneIds is required and must be non-empty");
    }
    const baseBranch = assertNonEmptyString(toolArgs.baseBranch, "baseBranch");
    const prSvc = requirePrService(runtime);
    const result = await prSvc.simulateIntegration({ sourceLaneIds, baseBranch });
    return result;
  }

  if (name === "create_queue") {

    const laneIds = Array.isArray(toolArgs.laneIds)
      ? toolArgs.laneIds.map((entry) => asTrimmedString(entry)).filter(Boolean)
      : [];
    if (!laneIds.length) {
      throw new JsonRpcError(JsonRpcErrorCode.invalidParams, "laneIds is required and must be non-empty");
    }
    const targetBranch = assertNonEmptyString(toolArgs.targetBranch, "targetBranch");
    const titles = isRecord(toolArgs.titles) ? toolArgs.titles as Record<string, string> : undefined;
    const draft = typeof toolArgs.draft === "boolean" ? toolArgs.draft : undefined;
    const autoRebase = typeof toolArgs.autoRebase === "boolean" ? toolArgs.autoRebase : undefined;
    const ciGating = typeof toolArgs.ciGating === "boolean" ? toolArgs.ciGating : undefined;
    const queueName = asOptionalTrimmedString(toolArgs.queueName);
    const prSvc = requirePrService(runtime);
    const result = await prSvc.createQueuePrs({
      laneIds,
      targetBranch,
      ...(titles ? { titles } : {}),
      ...(draft !== undefined ? { draft } : {}),
      ...(autoRebase !== undefined ? { autoRebase } : {}),
      ...(ciGating !== undefined ? { ciGating } : {}),
      ...(queueName ? { queueName } : {})
    });
    return result;
  }

  if (name === "create_integration") {

    const sourceLaneIds = Array.isArray(toolArgs.sourceLaneIds)
      ? toolArgs.sourceLaneIds.map((entry) => asTrimmedString(entry)).filter(Boolean)
      : [];
    if (!sourceLaneIds.length) {
      throw new JsonRpcError(JsonRpcErrorCode.invalidParams, "sourceLaneIds is required and must be non-empty");
    }
    const integrationLaneName = assertNonEmptyString(toolArgs.integrationLaneName, "integrationLaneName");
    const baseBranch = assertNonEmptyString(toolArgs.baseBranch, "baseBranch");
    const title = assertNonEmptyString(toolArgs.title, "title");
    const body = asOptionalTrimmedString(toolArgs.body);
    const draft = typeof toolArgs.draft === "boolean" ? toolArgs.draft : undefined;
    const prSvc = requirePrService(runtime);
    const result = await prSvc.createIntegrationPr({
      sourceLaneIds,
      integrationLaneName,
      baseBranch,
      title,
      ...(body ? { body } : {}),
      ...(draft !== undefined ? { draft } : {})
    });
    return result;
  }

  if (name === "rebase_lane") {
    const laneId = assertNonEmptyString(toolArgs.laneId, "laneId");

    const aiAssisted = typeof toolArgs.aiAssisted === "boolean" ? toolArgs.aiAssisted : undefined;
    const provider = asOptionalTrimmedString(toolArgs.provider);
    const autoApplyThreshold = typeof toolArgs.autoApplyThreshold === "number" ? toolArgs.autoApplyThreshold : undefined;
    const result = await runtime.conflictService.rebaseLane({
      laneId,
      ...(aiAssisted !== undefined ? { aiAssisted } : {}),
      ...(provider ? { provider: provider as "codex" | "claude" | undefined } : {}),
      ...(autoApplyThreshold !== undefined ? { autoApplyThreshold } : {})
    });
    return result;
  }

  if (name === "get_pr_health") {
    const prId = assertNonEmptyString(toolArgs.prId, "prId");
    const prSvc = requirePrService(runtime);
    const result = await prSvc.getPrHealth(prId);
    return result;
  }

  if (name === "land_queue_next") {

    const groupId = assertNonEmptyString(toolArgs.groupId, "groupId");
    const method = assertNonEmptyString(toolArgs.method, "method");
    const autoResolve = typeof toolArgs.autoResolve === "boolean" ? toolArgs.autoResolve : undefined;
    const confidenceThreshold = typeof toolArgs.confidenceThreshold === "number" ? toolArgs.confidenceThreshold : undefined;
    const prSvc = requirePrService(runtime);
    const result = await prSvc.landQueueNext({
      groupId,
      method: method as MergeMethod,
      ...(autoResolve !== undefined ? { autoResolve } : {}),
      ...(confidenceThreshold !== undefined ? { confidenceThreshold } : {})
    });
    return result;
  }

  if (name === "read_context") {
    const scope = asTrimmedString(toolArgs.scope) || "project";
    const level = normalizeExportLevel(toolArgs.level, "standard");

    if (scope === "project") {
      const exportData = await runtime.packService.getProjectExport({ level });
      return { export: exportData };
    }

    if (scope === "lane") {
      const laneId = assertNonEmptyString(toolArgs.laneId, "laneId");
      const exportData = await runtime.packService.getLaneExport({ laneId, level });
      return { export: exportData };
    }

    if (scope === "feature") {
      const featureKey = assertNonEmptyString(toolArgs.featureKey, "featureKey");
      const exportData = await runtime.packService.getFeatureExport({ featureKey, level });
      return { export: exportData };
    }

    if (scope === "conflict") {
      const laneId = assertNonEmptyString(toolArgs.laneId, "laneId");
      const peerLaneId = asOptionalTrimmedString(toolArgs.peerLaneId);
      const exportData = await runtime.packService.getConflictExport({
        laneId,
        ...(peerLaneId ? { peerLaneId } : {}),
        level
      });
      return { export: exportData };
    }

    if (scope === "plan") {
      const laneId = assertNonEmptyString(toolArgs.laneId, "laneId");
      const exportData = await runtime.packService.getPlanExport({ laneId, level });
      return { export: exportData };
    }

    if (scope === "mission") {
      const missionId = assertNonEmptyString(toolArgs.missionId, "missionId");
      const exportData = await runtime.packService.getMissionExport({ missionId, level });
      return { export: exportData };
    }

    throw new JsonRpcError(JsonRpcErrorCode.invalidParams, `Unsupported read_context scope '${scope}'.`);
  }

  if (name === "spawn_agent") {


    const laneId = assertNonEmptyString(toolArgs.laneId, "laneId");
    const provider = asTrimmedString(toolArgs.provider) === "claude" ? "claude" : "codex";
    const model = asOptionalTrimmedString(toolArgs.model);
    const permissionMode = parseSpawnPermissionMode(toolArgs.permissionMode);
    const maxPromptChars = Math.max(256, Math.min(12000, Math.floor(asNumber(toolArgs.maxPromptChars, 2800))));
    const prompt = asOptionalTrimmedString(toolArgs.prompt);
    const runId = asOptionalTrimmedString(toolArgs.runId);
    const stepId = asOptionalTrimmedString(toolArgs.stepId);
    const attemptId = asOptionalTrimmedString(toolArgs.attemptId);
    const toolWhitelist = normalizeToolWhitelist(toolArgs.toolWhitelist);
    const title = stripInjectionChars(
      asOptionalTrimmedString(toolArgs.title) ?? `MCP Agent (${provider}${permissionMode === "plan" ? " · plan" : ""})`
    );
    const context = safeObject(toolArgs.context);

    const contextRef = resolveSpawnContextFile({
      runtime,
      laneId,
      provider,
      permissionMode,
      runId,
      stepId,
      attemptId,
      userPrompt: prompt,
      context,
      contextFilePathRaw: asOptionalTrimmedString(toolArgs.contextFilePath)
    });

    const promptSegments: string[] = [];
    if (runId || stepId || attemptId) {
      promptSegments.push(
        `Mission context: run=${runId ?? "n/a"} step=${stepId ?? "n/a"} attempt=${attemptId ?? "n/a"}.`
      );
    }
    if (contextRef.contextFilePath) {
      promptSegments.push(`Read worker context from: ${contextRef.contextFilePath}`);
    }
    if (toolWhitelist.length > 0) {
      promptSegments.push(`Allowed tools: ${toolWhitelist.join(", ")}`);
    }
    if (prompt) {
      promptSegments.push(clipText(prompt, maxPromptChars));
    }
    const finalPrompt = promptSegments.join("\n").trim();

    const commandParts: string[] = [provider];
    if (model) {
      commandParts.push("--model", shellEscapeArg(model));
    }
    if (provider === "codex") {
      const codexSandbox =
        permissionMode === "plan" ? "read-only" : permissionMode === "full-auto" ? "danger-full-access" : "workspace-write";
      commandParts.push("--sandbox", codexSandbox);
      if (permissionMode === "full-auto") {
        commandParts.push("--full-auto");
      }
    } else {
      const claudePermission =
        permissionMode === "plan" ? "plan" : permissionMode === "full-auto" ? "bypassPermissions" : "acceptEdits";
      commandParts.push("--permission-mode", claudePermission);

      // Bind ADE MCP server to Claude workers via --mcp-config
      if (runId && attemptId) {
        const mcpConfigDir = path.join(runtime.projectRoot, ".ade", "orchestrator", "mcp-configs");
        fs.mkdirSync(mcpConfigDir, { recursive: true });
        const mcpConfigPath = path.join(mcpConfigDir, `spawn-${attemptId ?? Date.now()}.json`);
        const builtEntry = path.join(runtime.projectRoot, "apps", "mcp-server", "dist", "index.cjs");
        const srcEntry = path.join(runtime.projectRoot, "apps", "mcp-server", "src", "index.ts");
        const mcpCmd = fs.existsSync(builtEntry) ? "node" : "npx";
        const mcpArgs = fs.existsSync(builtEntry)
          ? [builtEntry, "--project-root", runtime.projectRoot]
          : ["tsx", srcEntry, "--project-root", runtime.projectRoot];
        const mcpConfig = {
          mcpServers: {
            ade: {
              command: mcpCmd,
              args: mcpArgs,
              env: {
                ADE_PROJECT_ROOT: runtime.projectRoot,
                ADE_MISSION_ID: callerCtx.missionId ?? "",
                ADE_RUN_ID: runId,
                ADE_STEP_ID: stepId ?? "",
                ADE_ATTEMPT_ID: attemptId,
                ADE_DEFAULT_ROLE: "agent"
              }
            }
          }
        };
        fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2), "utf8");
        commandParts.push("--mcp-config", shellEscapeArg(mcpConfigPath));
      }
    }
    if (finalPrompt) {
      commandParts.push(shellEscapeArg(finalPrompt));
    }

    // Prepend env vars for worker identity
    const envPrefixParts: string[] = [];
    if (runId) envPrefixParts.push(`ADE_RUN_ID=${shellEscapeArg(runId)}`);
    if (stepId) envPrefixParts.push(`ADE_STEP_ID=${shellEscapeArg(stepId)}`);
    if (attemptId) envPrefixParts.push(`ADE_ATTEMPT_ID=${shellEscapeArg(attemptId)}`);
    if (callerCtx.missionId) envPrefixParts.push(`ADE_MISSION_ID=${shellEscapeArg(callerCtx.missionId)}`);
    envPrefixParts.push("ADE_DEFAULT_ROLE=agent");

    const startupCommand = envPrefixParts.length > 0
      ? `${envPrefixParts.join(" ")} ${commandParts.join(" ")}`
      : commandParts.join(" ");

    const created = await runtime.ptyService.create({
      laneId,
      cols: DEFAULT_PTY_COLS,
      rows: DEFAULT_PTY_ROWS,
      title,
      tracked: true,
      toolType: `${provider}-orchestrated`,
      startupCommand
    });

    return {
      provider,
      laneId,
      title,
      permissionMode,
      startupCommand,
      ptyId: created.ptyId,
      sessionId: created.sessionId,
      contextRef: {
        path: contextRef.contextFilePath,
        digest: contextRef.contextDigest,
        bytes: contextRef.contextBytes,
        approxTokens: contextRef.approxTokens
      }
    };
  }

  // ── Mission Lifecycle Tools ──────────────────────────────────────

  if (name === "create_mission") {

    const prompt = assertNonEmptyString(toolArgs.prompt, "prompt");
    const title = asOptionalTrimmedString(toolArgs.title);
    const laneId = asOptionalTrimmedString(toolArgs.laneId);
    const priority = asOptionalTrimmedString(toolArgs.priority);
    const executionMode = asOptionalTrimmedString(toolArgs.executionMode);
    const prStrategy = asOptionalTrimmedString(toolArgs.prStrategy);
    const executorPolicy = isRecord(toolArgs.executorPolicy) ? toolArgs.executorPolicy : undefined;

    const createArgs: Record<string, unknown> = { prompt };
    if (title) createArgs.title = title;
    if (laneId) createArgs.laneId = laneId;
    if (priority) createArgs.priority = priority;
    if (executionMode) createArgs.executionMode = executionMode;
    if (prStrategy) createArgs.prStrategy = prStrategy;
    if (executorPolicy) createArgs.executionPolicy = executorPolicy;
    const mission = runtime.missionService.create(createArgs as any);

    runtime.eventBuffer.push({
      timestamp: nowIso(),
      category: "mission",
      payload: { type: "mission_created", missionId: mission.id }
    });

    return { mission };
  }

  if (name === "start_mission") {

    const missionId = assertNonEmptyString(toolArgs.missionId, "missionId");
    const runMode = asOptionalTrimmedString(toolArgs.runMode) as "autopilot" | "manual" | null;
    const defaultExecutorKind = asOptionalTrimmedString(toolArgs.defaultExecutorKind);
    const coordinatorModel = asOptionalTrimmedString(toolArgs.coordinatorModel);

    const startArgs: Record<string, unknown> = { missionId };
    if (runMode) startArgs.runMode = runMode;
    if (defaultExecutorKind) startArgs.defaultExecutorKind = defaultExecutorKind;
    if (coordinatorModel) startArgs.defaultModelId = coordinatorModel;
    const result = await runtime.aiOrchestratorService.startMissionRun(startArgs as any);

    const runId = result.started?.run.id ?? null;

    runtime.eventBuffer.push({
      timestamp: nowIso(),
      category: "mission",
      payload: { type: "mission_started", missionId, runId }
    });

    return { ...result, runId };
  }

  if (name === "pause_mission") {

    const runId = assertNonEmptyString(toolArgs.runId, "runId");
    const reason = asOptionalTrimmedString(toolArgs.reason);
    const run = runtime.orchestratorService.pauseRun({
      runId,
      ...(reason ? { reason } : {})
    });
    return { run };
  }

  if (name === "resume_mission") {

    const runId = assertNonEmptyString(toolArgs.runId, "runId");
    const run = runtime.orchestratorService.resumeRun({ runId });
    return { run };
  }

  if (name === "cancel_mission") {

    const runId = assertNonEmptyString(toolArgs.runId, "runId");
    const reason = asOptionalTrimmedString(toolArgs.reason);
    const result = await runtime.aiOrchestratorService.cancelRunGracefully({
      runId,
      ...(reason ? { reason } : {})
    });
    return result;
  }

  if (name === "steer_mission") {

    const missionId = assertNonEmptyString(toolArgs.missionId, "missionId");
    const directive = assertNonEmptyString(toolArgs.directive, "directive");
    const targetStepKey = asOptionalTrimmedString(toolArgs.targetStepKey);
    const priorityRaw = asOptionalTrimmedString(toolArgs.priority);
    const validPriorities = new Set(["suggestion", "instruction", "override"]);
    const priority: "suggestion" | "instruction" | "override" =
      priorityRaw && validPriorities.has(priorityRaw)
        ? (priorityRaw as "suggestion" | "instruction" | "override")
        : "suggestion";
    const result = runtime.aiOrchestratorService.steerMission({
      missionId,
      directive,
      priority,
      ...(targetStepKey ? { targetStepKey } : {})
    });
    return result;
  }

  if (name === "approve_plan") {

    const missionId = assertNonEmptyString(toolArgs.missionId, "missionId");
    const approved = toolArgs.approved === true;
    const feedback = asOptionalTrimmedString(toolArgs.feedback);

    if (!approved) {
      // Rejection: add intervention and cancel any active run for this mission
      const intervention = runtime.missionService.addIntervention({
        missionId,
        interventionType: "manual_input",
        title: "Plan rejected",
        body: feedback ?? "Plan was rejected by evaluator."
      });
      // Cancel the most recent active run if one exists
      const runs = runtime.orchestratorService.listRuns({ missionId, status: "active", limit: 1 });
      let cancelledRunId: string | null = null;
      if (runs.length > 0) {
        try {
          await runtime.aiOrchestratorService.cancelRunGracefully({ runId: runs[0]!.id, reason: "Plan rejected" });
          cancelledRunId = runs[0]!.id;
        } catch {
          // Run may already be in a terminal state
        }
      }
      return { approved: false, intervention, cancelledRunId };
    }

    // Approval: start the mission run via approveMissionPlan
    const result = await runtime.aiOrchestratorService.approveMissionPlan({
      missionId
    });
    return { approved: true, ...result };
  }

  if (name === "resolve_intervention") {

    const missionId = assertNonEmptyString(toolArgs.missionId, "missionId");
    const interventionId = assertNonEmptyString(toolArgs.interventionId, "interventionId");
    const statusRaw = assertNonEmptyString(toolArgs.status, "status");
    const status = statusRaw === "dismissed" ? "dismissed" as const : "resolved" as const;
    const note = asOptionalTrimmedString(toolArgs.note);
    const intervention = runtime.missionService.resolveIntervention({
      missionId,
      interventionId,
      status,
      ...(note ? { note } : {})
    });
    return { intervention };
  }

  // ── Observation Tools ────────────────────────────────────────────
  // Observation tools support auto-population from caller context (env vars).
  // When a worker calls these tools without explicit IDs, they default to
  // the worker's own mission/run context.

  if (name === "get_mission") {
    const missionId = asOptionalTrimmedString(toolArgs.missionId) ?? callerCtx.missionId;
    if (!missionId) {
      throw new JsonRpcError(JsonRpcErrorCode.invalidParams, "missionId is required (not available from caller context)");
    }
    const mission = runtime.missionService.get(missionId);
    if (!mission) {
      throw new JsonRpcError(JsonRpcErrorCode.invalidParams, `Mission not found: ${missionId}`);
    }
    return { mission };
  }

  if (name === "get_run_graph") {
    const runId = asOptionalTrimmedString(toolArgs.runId) ?? callerCtx.runId;
    if (!runId) {
      throw new JsonRpcError(JsonRpcErrorCode.invalidParams, "runId is required (not available from caller context)");
    }
    const timelineLimit = asNumber(toolArgs.timelineLimit, 300);
    try {
      const graph = runtime.orchestratorService.getRunGraph({ runId, timelineLimit });
      return { graph };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new JsonRpcError(JsonRpcErrorCode.invalidParams, `Run not found or inaccessible: ${runId}. ${msg}`);
    }
  }

  if (name === "stream_events") {
    const cursor = asNumber(toolArgs.cursor, 0);
    const limit = asNumber(toolArgs.limit, 100);
    const category = asOptionalTrimmedString(toolArgs.category);
    if (category) {
      // When filtering by category, drain a larger batch and filter client-side.
      // Use the last matching event's ID as nextCursor so no events are skipped.
      const batchSize = Math.min(1000, limit * 10);
      const result = runtime.eventBuffer.drain(cursor, batchSize);
      const filtered = result.events.filter((e) => e.category === category);
      const sliced = filtered.slice(0, limit);
      const lastId = sliced.length > 0 ? sliced[sliced.length - 1]!.id : cursor;
      return {
        events: sliced,
        nextCursor: lastId,
        hasMore: filtered.length > limit || result.hasMore
      };
    }
    return runtime.eventBuffer.drain(cursor, limit);
  }

  if (name === "get_step_output") {
    const runId = asOptionalTrimmedString(toolArgs.runId) ?? callerCtx.runId;
    if (!runId) {
      throw new JsonRpcError(JsonRpcErrorCode.invalidParams, "runId is required (not available from caller context)");
    }
    const stepKey = assertNonEmptyString(toolArgs.stepKey, "stepKey");
    const graph = runtime.orchestratorService.getRunGraph({ runId, timelineLimit: 0 });
    const step = graph.steps.find((s) => s.stepKey === stepKey);
    if (!step) {
      throw new JsonRpcError(JsonRpcErrorCode.invalidParams, `Step not found: ${stepKey}`);
    }
    const attempts = graph.attempts.filter((a) => a.stepId === step.id);
    return { step, attempts };
  }

  if (name === "get_worker_states") {
    const runId = asOptionalTrimmedString(toolArgs.runId) ?? callerCtx.runId;
    if (!runId) {
      throw new JsonRpcError(JsonRpcErrorCode.invalidParams, "runId is required (not available from caller context)");
    }
    const states = runtime.aiOrchestratorService.getWorkerStates({ runId });
    return { runId, workers: states };
  }

  if (name === "get_timeline") {
    const runId = asOptionalTrimmedString(toolArgs.runId) ?? callerCtx.runId;
    if (!runId) {
      throw new JsonRpcError(JsonRpcErrorCode.invalidParams, "runId is required (not available from caller context)");
    }
    const limit = asNumber(toolArgs.limit, 300);
    const stepId = asOptionalTrimmedString(toolArgs.stepId);
    const timeline = runtime.orchestratorService.listTimeline({ runId, limit });
    if (stepId) {
      const filtered = timeline.filter((e) => e.stepId === stepId);
      return { timeline: filtered };
    }
    return { timeline };
  }

  if (name === "get_mission_metrics") {
    const missionId = asOptionalTrimmedString(toolArgs.missionId) ?? callerCtx.missionId;
    if (!missionId) {
      throw new JsonRpcError(JsonRpcErrorCode.invalidParams, "missionId is required (not available from caller context)");
    }
    const metrics = runtime.aiOrchestratorService.getMissionMetrics({ missionId });
    return { metrics };
  }

  if (name === "get_final_diff") {
    const runId = asOptionalTrimmedString(toolArgs.runId) ?? callerCtx.runId;
    if (!runId) {
      throw new JsonRpcError(JsonRpcErrorCode.invalidParams, "runId is required (not available from caller context)");
    }
    const graph = runtime.orchestratorService.getRunGraph({ runId, timelineLimit: 0 });
    const laneIds = [...new Set(graph.steps.map((s) => s.laneId).filter(Boolean))] as string[];
    const diffs: Record<string, unknown> = {};
    for (const laneId of laneIds) {
      diffs[laneId] = await runtime.diffService.getChanges(laneId);
    }
    return { runId, diffs };
  }

  // ── Worker Collaboration Tools ─────────────────────────────────

  if (name === "get_pending_messages") {
    const missionId = callerCtx.missionId;
    const attemptId = callerCtx.attemptId ?? session.identity.attemptId;
    if (!missionId || !attemptId) {
      throw new JsonRpcError(
        JsonRpcErrorCode.invalidParams,
        "get_pending_messages requires worker identity (ADE_MISSION_ID and ADE_ATTEMPT_ID env vars). This tool is only available to workers spawned by the orchestrator."
      );
    }

    const sinceCursor = asOptionalTrimmedString(toolArgs.since_cursor);
    const limit = Math.max(1, Math.min(200, Math.floor(asNumber(toolArgs.limit, 50))));

    // Find the worker's thread by attemptId
    const threads = runtime.aiOrchestratorService.listChatThreads({ missionId });
    const workerThread = threads.find(
      (t: Record<string, unknown>) =>
        (t.attemptId === attemptId) ||
        (t.threadType === "worker" && t.attemptId === attemptId)
    );

    if (!workerThread) {
      return {
        messages: [],
        workerAttemptId: attemptId,
        missionId,
        threadId: null,
        note: "No message thread found for this worker yet"
      };
    }

    const threadId = String(workerThread.id ?? "");
    const allMessages = runtime.aiOrchestratorService.getThreadMessages({
      missionId,
      threadId,
      limit: limit * 2 // fetch extra to filter
    });

    // Filter to messages addressed to this worker (not from this worker)
    let messages = allMessages.filter((msg: Record<string, unknown>) => {
      // Include messages from coordinator, user, or other agents
      if (msg.role === "orchestrator" || msg.role === "user" || msg.role === "system") return true;
      // Include inter-agent messages targeted at this worker
      const target = msg.target as Record<string, unknown> | null | undefined;
      if (target?.targetAttemptId === attemptId && msg.attemptId !== attemptId) return true;
      // Include agent messages that are inter-agent deliveries to this thread
      const metadata = msg.metadata as Record<string, unknown> | null | undefined;
      if (metadata?.interAgentDelivery === true && msg.attemptId !== attemptId) return true;
      return false;
    });

    // Apply cursor filter
    if (sinceCursor) {
      const cursorTime = Date.parse(sinceCursor);
      if (!Number.isNaN(cursorTime)) {
        messages = messages.filter((msg: Record<string, unknown>) => {
          const ts = Date.parse(String(msg.timestamp ?? ""));
          return !Number.isNaN(ts) && ts > cursorTime;
        });
      }
    }

    // Limit
    messages = messages.slice(-limit);

    return {
      messages: messages.map((msg: Record<string, unknown>) => ({
        id: msg.id,
        role: msg.role,
        content: msg.content,
        timestamp: msg.timestamp,
        stepKey: msg.stepKey ?? null,
        attemptId: msg.attemptId ?? null,
        metadata: msg.metadata ?? null
      })),
      workerAttemptId: attemptId,
      missionId,
      threadId,
      count: messages.length
    };
  }

  // ── Evaluation Tools ─────────────────────────────────────────────

  if (name === "evaluate_run") {

    const runId = assertNonEmptyString(toolArgs.runId, "runId");
    const missionId = assertNonEmptyString(toolArgs.missionId, "missionId");
    const scores = safeObject(toolArgs.scores);
    const issues = Array.isArray(toolArgs.issues) ? toolArgs.issues : [];
    const summary = assertNonEmptyString(toolArgs.summary, "summary");
    const improvements = Array.isArray(toolArgs.improvements) ? toolArgs.improvements : [];
    const metadata = isRecord(toolArgs.metadata) ? toolArgs.metadata : {};

    const id = randomUUID();
    const evaluatedAt = nowIso();

    runtime.db.run(
      `INSERT INTO orchestrator_evaluations (id, project_id, run_id, mission_id, evaluator_id, scores_json, issues_json, summary, improvements_json, metadata_json, evaluated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        runtime.projectId,
        runId,
        missionId,
        session.identity.callerId,
        JSON.stringify(scores),
        JSON.stringify(issues),
        summary,
        JSON.stringify(improvements),
        JSON.stringify(metadata),
        evaluatedAt
      ]
    );

    return {
      id,
      runId,
      missionId,
      evaluatorId: session.identity.callerId,
      scores,
      issues,
      summary,
      improvements,
      evaluatedAt
    };
  }

  if (name === "list_evaluations") {
    const missionId = asOptionalTrimmedString(toolArgs.missionId);
    const runId = asOptionalTrimmedString(toolArgs.runId);
    const limit = Math.max(1, Math.min(100, Math.floor(asNumber(toolArgs.limit, 20))));

    const where: string[] = ["project_id = ?"];
    const params: Array<string | number> = [runtime.projectId];
    if (missionId) { where.push("mission_id = ?"); params.push(missionId); }
    if (runId) { where.push("run_id = ?"); params.push(runId); }
    params.push(limit);

    const rows = runtime.db.all<{
      id: string; run_id: string; mission_id: string; evaluator_id: string;
      scores_json: string; issues_json: string; summary: string;
      improvements_json: string | null; metadata_json: string | null; evaluated_at: string;
    }>(
      `SELECT id, run_id, mission_id, evaluator_id, scores_json, issues_json, summary, improvements_json, metadata_json, evaluated_at
       FROM orchestrator_evaluations
       WHERE ${where.join(" AND ")}
       ORDER BY evaluated_at DESC
       LIMIT ?`,
      params
    );

    const evaluations = rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      missionId: row.mission_id,
      evaluatorId: row.evaluator_id,
      scores: JSON.parse(row.scores_json),
      issueCount: JSON.parse(row.issues_json).length,
      summary: row.summary,
      evaluatedAt: row.evaluated_at
    }));

    return { evaluations };
  }

  if (name === "get_evaluation_report") {
    const evaluationId = assertNonEmptyString(toolArgs.evaluationId, "evaluationId");

    const row = runtime.db.get<{
      id: string; run_id: string; mission_id: string; evaluator_id: string;
      scores_json: string; issues_json: string; summary: string;
      improvements_json: string | null; metadata_json: string | null; evaluated_at: string;
    }>(
      `SELECT id, run_id, mission_id, evaluator_id, scores_json, issues_json, summary, improvements_json, metadata_json, evaluated_at
       FROM orchestrator_evaluations
       WHERE id = ? AND project_id = ?`,
      [evaluationId, runtime.projectId]
    );

    if (!row) {
      throw new JsonRpcError(JsonRpcErrorCode.invalidParams, `Evaluation not found: ${evaluationId}`);
    }

    let runContext: Record<string, unknown> | null = null;
    try {
      const graph = runtime.orchestratorService.getRunGraph({ runId: row.run_id, timelineLimit: 50 });
      runContext = {
        run: graph.run,
        stepCount: graph.steps.length,
        attemptCount: graph.attempts.length,
        completionEvaluation: graph.completionEvaluation
      };
    } catch {
      // Run may no longer exist
    }

    return {
      evaluation: {
        id: row.id,
        runId: row.run_id,
        missionId: row.mission_id,
        evaluatorId: row.evaluator_id,
        scores: JSON.parse(row.scores_json),
        issues: JSON.parse(row.issues_json),
        summary: row.summary,
        improvements: row.improvements_json ? JSON.parse(row.improvements_json) : [],
        metadata: row.metadata_json ? JSON.parse(row.metadata_json) : {},
        evaluatedAt: row.evaluated_at
      },
      runContext
    };
  }

  throw new JsonRpcError(JsonRpcErrorCode.methodNotFound, `Unknown MCP tool: ${name}`);
}

async function readResource(runtime: AdeMcpRuntime, uri: string): Promise<Record<string, unknown>> {
  const parsed = parseMcpUri(uri);
  const [head, ...tail] = parsed.path;

  if (head === "pack") {
    const [scope, a, b, c] = tail;

    if (scope === "project" && a) {
      const level = normalizeExportLevel(a, "standard");
      const exportData = await runtime.packService.getProjectExport({ level });
      return {
        contents: [
          {
            uri,
            mimeType: RESOURCE_MIME_MARKDOWN,
            text: `\`\`\`json\n${jsonText(exportData.header)}\n\`\`\`\n\n${exportData.content}`
          }
        ]
      };
    }

    if (scope === "lane" && a && b) {
      const laneId = a;
      const level = normalizeExportLevel(b, "standard");
      const exportData = await runtime.packService.getLaneExport({ laneId, level });
      return {
        contents: [
          {
            uri,
            mimeType: RESOURCE_MIME_MARKDOWN,
            text: `\`\`\`json\n${jsonText(exportData.header)}\n\`\`\`\n\n${exportData.content}`
          }
        ]
      };
    }

    if (scope === "feature" && a && b) {
      const featureKey = a;
      const level = normalizeExportLevel(b, "standard");
      const exportData = await runtime.packService.getFeatureExport({ featureKey, level });
      return {
        contents: [
          {
            uri,
            mimeType: RESOURCE_MIME_MARKDOWN,
            text: `\`\`\`json\n${jsonText(exportData.header)}\n\`\`\`\n\n${exportData.content}`
          }
        ]
      };
    }

    if (scope === "plan" && a && b) {
      const laneId = a;
      const level = normalizeExportLevel(b, "standard");
      const exportData = await runtime.packService.getPlanExport({ laneId, level });
      return {
        contents: [
          {
            uri,
            mimeType: RESOURCE_MIME_MARKDOWN,
            text: `\`\`\`json\n${jsonText(exportData.header)}\n\`\`\`\n\n${exportData.content}`
          }
        ]
      };
    }

    if (scope === "mission" && a && b) {
      const missionId = a;
      const level = normalizeExportLevel(b, "standard");
      const exportData = await runtime.packService.getMissionExport({ missionId, level });
      return {
        contents: [
          {
            uri,
            mimeType: RESOURCE_MIME_MARKDOWN,
            text: `\`\`\`json\n${jsonText(exportData.header)}\n\`\`\`\n\n${exportData.content}`
          }
        ]
      };
    }

    if (scope === "conflict" && a && b && c) {
      const laneId = a;
      const peerLaneId = b === "base" ? null : b;
      const level = normalizeExportLevel(c, "standard");
      const exportData = await runtime.packService.getConflictExport({
        laneId,
        ...(peerLaneId ? { peerLaneId } : {}),
        level
      });
      return {
        contents: [
          {
            uri,
            mimeType: RESOURCE_MIME_MARKDOWN,
            text: `\`\`\`json\n${jsonText(exportData.header)}\n\`\`\`\n\n${exportData.content}`
          }
        ]
      };
    }
  }

  if (head === "lane") {
    const [laneId, scope] = tail;
    if (laneId && scope === "status") {
      const payload = await buildLaneStatus(runtime, laneId);
      return {
        contents: [
          {
            uri,
            mimeType: RESOURCE_MIME_JSON,
            text: jsonText(payload)
          }
        ]
      };
    }

    if (laneId && scope === "conflicts") {
      const status = await runtime.conflictService.getLaneStatus({ laneId });
      const overlaps = await runtime.conflictService.listOverlaps({ laneId });
      return {
        contents: [
          {
            uri,
            mimeType: RESOURCE_MIME_JSON,
            text: jsonText({ status, overlaps })
          }
        ]
      };
    }
  }

  throw new JsonRpcError(JsonRpcErrorCode.invalidParams, `Unsupported resource URI: ${uri}`);
}

export function createMcpRequestHandler(args: {
  runtime: AdeMcpRuntime;
  serverVersion: string;
}): JsonRpcHandler {
  const { runtime, serverVersion } = args;

  const session: SessionState = {
    initialized: false,
    protocolVersion: DEFAULT_PROTOCOL_VERSION,
    identity: {
      callerId: "unknown",
      role: "external",
      missionId: null,
      runId: null,
      stepId: null,
      attemptId: null,
      ownerId: null
    },
    askUserEvents: [],
    askUserRateLimit: {
      maxCalls: 6,
      windowMs: 60_000
    },
    memoryAddEvents: [],
    memoryAddRateLimit: {
      maxCalls: 10,
      windowMs: 60_000
    },
    memorySearchEvents: [],
    memorySearchRateLimit: {
      maxCalls: 20,
      windowMs: 60_000
    }
  };

  const auditToolCall = async (
    toolName: string,
    toolArgs: Record<string, unknown>,
    runner: () => Promise<Record<string, unknown>>
  ): Promise<Record<string, unknown>> => {
    const startedAt = Date.now();
    const laneId = extractLaneId(toolArgs);
    const operation = runtime.operationService.start({
      laneId,
      kind: "mcp_tool_call",
      metadata: {
        tool: toolName,
        callerId: session.identity.callerId,
        role: session.identity.role,
        missionId: session.identity.missionId,
        runId: session.identity.runId,
        stepId: session.identity.stepId,
        attemptId: session.identity.attemptId,
        ownerId: session.identity.ownerId,
        args: sanitizeForAudit(toolArgs)
      }
    });

    try {
      const result = await runner();
      runtime.operationService.finish({
        operationId: operation.operationId,
        status: "succeeded",
        metadataPatch: {
          resultStatus: "success",
          durationMs: Date.now() - startedAt,
          result: sanitizeForAudit(result)
        }
      });
      return result;
    } catch (error) {
      runtime.operationService.finish({
        operationId: operation.operationId,
        status: "failed",
        metadataPatch: {
          resultStatus: "failed",
          durationMs: Date.now() - startedAt,
          errorMessage: error instanceof Error ? error.message : String(error)
        }
      });
      throw error;
    }
  };

  return async (request: JsonRpcRequest): Promise<unknown | null> => {
    const method = typeof request.method === "string" ? request.method : "";
    const params = safeObject(request.params);

    if (method === "initialize") {
      session.initialized = true;
      session.protocolVersion = asOptionalTrimmedString(params.protocolVersion) ?? DEFAULT_PROTOCOL_VERSION;
      session.identity = parseInitializeIdentity(params);
      return {
        protocolVersion: session.protocolVersion,
        serverInfo: {
          name: "ade-mcp-server",
          version: serverVersion
        },
        capabilities: {
          tools: {
            listChanged: false
          },
          resources: {
            listChanged: false,
            subscribe: false
          }
        }
      };
    }

    if (method === "notifications/initialized") {
      return null;
    }

    if (!session.initialized) {
      throw new JsonRpcError(JsonRpcErrorCode.invalidRequest, "Server must be initialized first.");
    }

    if (method === "ping") {
      return { pong: true, at: nowIso() };
    }

    if (method === "tools/list") {
      return {
        tools: ALL_TOOL_SPECS.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema
        }))
      };
    }

    if (method === "tools/call") {
      const toolName = assertNonEmptyString(params.name, "name");
      const toolSpec = findToolSpec(toolName);
      void toolSpec;
      const toolArgs = safeObject(params.arguments);

      try {
        const result = await auditToolCall(toolName, toolArgs, async () => {

          if (
            READ_ONLY_TOOLS.has(toolName) ||
            MUTATION_TOOLS.has(toolName) ||
            ORCHESTRATION_TOOLS.has(toolName) ||
            OBSERVATION_TOOLS.has(toolName) ||
            EVALUATOR_TOOLS.has(toolName) ||
            EVALUATION_READ_TOOLS.has(toolName) ||
            COORDINATOR_TOOL_NAMES.has(toolName) ||
            toolName === "spawn_agent" ||
            toolName === "ask_user"
          ) {
            return await runTool({ runtime, session, name: toolName, toolArgs });
          }

          throw new JsonRpcError(JsonRpcErrorCode.methodNotFound, `Unsupported tool: ${toolName}`);
        });

        return mcpTextResult(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return mcpTextResult(
          {
            ok: false,
            error: {
              code: error instanceof JsonRpcError ? error.code : JsonRpcErrorCode.toolFailed,
              message
            }
          },
          true
        );
      }
    }

    if (method === "resources/list") {
      const lanes = await runtime.laneService.list({ includeArchived: false });
      const laneRecords = lanes as unknown as Array<Record<string, unknown>>;
      const featureKeys = listFeatureKeysFromLanes(laneRecords);
      const missionIds = listMissionIds(runtime);
      return {
        resources: buildResourceList({
          lanes: laneRecords,
          featureKeys,
          missionIds
        })
      };
    }

    if (method === "resources/read") {
      const uri = assertNonEmptyString(params.uri, "uri");
      return await readResource(runtime, uri);
    }

    if (method === "shutdown") {
      return {};
    }

    if (method === "exit") {
      process.nextTick(() => process.exit(0));
      return {};
    }

    throw new JsonRpcError(JsonRpcErrorCode.methodNotFound, `Method not found: ${method}`);
  };
}
