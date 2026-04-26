import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createCtoOperatorTools } from "../../desktop/src/main/services/ai/tools/ctoOperatorTools";
import {
  createCoordinatorToolSet,
  type CoordinatorExecutableTool,
} from "../../desktop/src/main/services/orchestrator/coordinatorTools";
import {
  createComputerUseArtifactPath,
  getLocalComputerUseCapabilities,
  toProjectArtifactUri,
} from "../../desktop/src/main/services/computerUse/localComputerUse";
import { loadAgentBrowserArtifactPayloadFromFile, parseAgentBrowserArtifactPayload } from "../../desktop/src/main/services/proof/agentBrowserArtifactAdapter";
import { resolveAgentMemoryWritePolicy } from "../../desktop/src/main/services/memory/memoryService";
import {
  ADE_ACTION_ALLOWLIST,
  ADE_ACTION_DOMAIN_NAMES,
  type AdeActionDomain,
  callerHasRoleAtLeast,
  getAdeActionDomainServices,
  isAllowedAdeAction,
  isCtoOnlyAdeAction,
  listAllowedAdeActionNames,
} from "../../desktop/src/main/services/adeActions/registry";
import { ReflectionValidationError } from "../../desktop/src/main/services/orchestrator/orchestratorService";
import { getTeamMembersForRun, registerTeamMember, updateTeamMemberStatus } from "../../desktop/src/main/services/orchestrator/teamRuntimeState";
import { launchPrIssueResolutionChat, previewPrIssueResolutionPrompt } from "../../desktop/src/main/services/prs/prIssueResolver";
import { runGit } from "../../desktop/src/main/services/git/git";
import { resolvePathWithinRoot } from "../../desktop/src/main/services/shared/utils";
import { getDefaultModelDescriptor } from "../../desktop/src/shared/modelRegistry";
import { ADE_CLI_INLINE_GUIDANCE } from "../../desktop/src/shared/adeCliGuidance";
import { getPrIssueResolutionAvailability } from "../../desktop/src/shared/prIssueResolution";
import {
  type LinearWorkflowConfig,
  type ComputerUseArtifactOwner,
  type DockLayout,
  type GraphPersistedState,
  type MergeMethod,
} from "../../desktop/src/shared/types";
import type { PrActionRun, PrCheck, PrComment, PrReviewThread } from "../../desktop/src/shared/types/prs";
import { resolveAdeLayout } from "../../desktop/src/shared/adeLayout";
import type { AdeRuntime } from "./bootstrap";
import { JsonRpcError, JsonRpcErrorCode, type JsonRpcHandler, type JsonRpcRequest } from "./jsonrpc";

type ToolSpec = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

type ExecutableTool = {
  description?: string;
  inputSchema?: unknown;
  parameters?: unknown;
  execute?: (args: Record<string, unknown>) => Promise<unknown>;
};

type SessionIdentity = {
  callerId: string;
  role: "cto" | "orchestrator" | "agent" | "external" | "evaluator";
  chatSessionId: string | null;
  standaloneChatSession: boolean;
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

const RESOURCE_MIME_JSON = "application/json";

function resolveExecutableOnPath(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const trimmed = command.trim();
  if (!trimmed) return null;
  const lookup = process.platform === "win32"
    ? { command: "where.exe", args: [trimmed] }
    : { command: env.SHELL?.trim() || "/bin/sh", args: ["-lc", `command -v ${shellEscapeArg(trimmed)}`] };
  const result = spawnSync(lookup.command, lookup.args, {
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0 || typeof result.stdout !== "string") return null;
  const first = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!first) return null;
  return path.isAbsolute(first) ? first : null;
}

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
        permissionMode: { type: "string", enum: ["default", "plan", "edit", "full-auto", "config-toml"], default: "default" },
        toolWhitelist: { type: "array", items: { type: "string" }, maxItems: 24 },
        maxPromptChars: { type: "number", minimum: 256, maximum: 12000 },
        contextFilePath: { type: "string" },
        context: {
          type: "object",
          additionalProperties: false,
          properties: {
            profile: { type: "string" },
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
    name: "list_ade_actions",
    description: "List callable ADE service methods exposed to the CLI. Actions are returned as domain.action names with CLI usage hints.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        domain: {
          type: "string",
          enum: [...ADE_ACTION_DOMAIN_NAMES, "all"],
          default: "all",
        },
      }
    }
  },
  {
    name: "run_ade_action",
    description: "Invoke an exposed ADE service method by domain and action. Use args for one object parameter, argsList for multiple positional parameters, or arg for one scalar parameter.",
    inputSchema: {
      type: "object",
      required: ["domain", "action"],
      additionalProperties: false,
      properties: {
        domain: {
          type: "string",
          enum: [...ADE_ACTION_DOMAIN_NAMES],
        },
        action: { type: "string", minLength: 1 },
        args: { type: "object" },
        argsList: { type: "array" },
        arg: {},
      }
    }
  },
  {
    name: "get_ade_action_status",
    description: "Check status/progress for long-running ADE actions by operation/test/chat/run/mission identifiers.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        operationId: { type: "string", minLength: 1 },
        testRunId: { type: "string", minLength: 1 },
        chatSessionId: { type: "string", minLength: 1 },
        runId: { type: "string", minLength: 1 },
        missionId: { type: "string", minLength: 1 },
        prId: { type: "string", minLength: 1 },
        previousHash: { type: "string" },
        waitForMs: { type: "number", minimum: 0, maximum: 120000, default: 0 },
        pollIntervalMs: { type: "number", minimum: 100, maximum: 5000, default: 800 },
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
    description: "Ask the user a question and wait for their answer. Works in both mission contexts (with missionId) and standalone chat sessions (without missionId). Returns explicit outcome fields (`outcome`, `resolved`, `answered`, `declined`, `cancelled`, `timedOut`, `awaitingUserResponse`) so declines/cancels/timeouts cannot be mistaken for a still-pending question.",
    inputSchema: {
      type: "object",
      required: ["title", "body"],
      additionalProperties: false,
      properties: {
        missionId: { type: "string", minLength: 1 },
        title: { type: "string", minLength: 1 },
        body: { type: "string", minLength: 1 },
        questions: {
          type: "array",
          minItems: 1,
          maxItems: 3,
          items: {
            type: "object",
            required: ["question"],
            additionalProperties: false,
            properties: {
              id: { type: "string", minLength: 1 },
              header: { type: "string", minLength: 1 },
              question: { type: "string", minLength: 1 },
              multiSelect: { type: "boolean" },
              allowsFreeform: { type: "boolean" },
              isSecret: { type: "boolean" },
              defaultAssumption: { type: "string" },
              impact: { type: "string" },
              options: {
                type: "array",
                items: {
                  type: "object",
                  required: ["label"],
                  additionalProperties: false,
                  properties: {
                    label: { type: "string", minLength: 1 },
                    value: { type: "string", minLength: 1 },
                    description: { type: "string" },
                    recommended: { type: "boolean" },
                    preview: { type: "string" },
                    previewFormat: { type: "string", enum: ["markdown", "html"] }
                  }
                }
              }
            }
          }
        },
        requestedAction: { type: "string" },
        laneId: { type: "string" },
        phase: { type: "string" },
        waitForResolutionMs: { type: "number", minimum: 0, maximum: 3600000 },
        pollIntervalMs: { type: "number", minimum: 100, maximum: 10000 }
      }
    }
  },
  {
    name: "memory_add",
    description: "Save durable project knowledge for future missions and workers. Use this only for important decisions, conventions, repeatable patterns, stable preferences, or gotchas. If the standing CTO brief itself changed, use memory_update_core instead. Do not store ephemeral task chatter.",
    inputSchema: {
      type: "object",
      required: ["content", "category"],
      additionalProperties: false,
      properties: {
        content: { type: "string", minLength: 1 },
        category: { type: "string", enum: ["fact", "preference", "pattern", "decision", "gotcha", "convention"] },
        importance: { type: "string", enum: ["low", "medium", "high"], default: "medium" },
        scope: { type: "string", enum: ["project", "mission", "agent"] }
      }
    }
  },
  {
    name: "memory_update_core",
    description: "Update the standing Tier-1 CTO brief when the project summary, conventions, preferences, focus, or notes change. Do not use this for one-off discoveries; save those with memory_add instead.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        projectSummary: { type: "string" },
        criticalConventions: { type: "array", items: { type: "string" } },
        userPreferences: { type: "array", items: { type: "string" } },
        activeFocus: { type: "array", items: { type: "string" } },
        notes: { type: "array", items: { type: "string" } }
      }
    }
  },
  {
    name: "reflection_add",
    description: "Record a structured reflection entry for mission introspection and retrospective synthesis.",
    inputSchema: {
      type: "object",
      required: ["signalType", "observation", "agentRole", "phase", "recommendation", "context", "occurredAt"],
      additionalProperties: false,
      properties: {
        missionId: { type: "string" },
        runId: { type: "string" },
        stepId: { type: "string" },
        attemptId: { type: "string" },
        agentRole: { type: "string", minLength: 1 },
        phase: { type: "string", minLength: 1 },
        signalType: { type: "string", enum: ["wish", "frustration", "idea", "pattern", "limitation"] },
        observation: { type: "string", minLength: 1 },
        recommendation: { type: "string", minLength: 1 },
        context: { type: "string", minLength: 1 },
        occurredAt: {
          type: "string",
          minLength: 1,
          pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?(?:Z|[+-]\\d{2}:\\d{2})$"
        }
      }
    }
  },
  {
    name: "memory_search",
    description: "Search project memories for relevant context from earlier missions and workers before you guess, especially at session start and before architectural decisions.",
    inputSchema: {
      type: "object",
      required: ["query"],
      additionalProperties: false,
      properties: {
        query: { type: "string", minLength: 1 },
        scope: { type: "string", enum: ["project", "mission", "agent"] },
        status: { type: "string", enum: ["promoted", "candidate", "archived", "all"], default: "promoted" },
        limit: { type: "number", minimum: 1, maximum: 50, default: 5 }
      }
    }
  },
  {
    name: "get_environment_info",
    description: "Inspect ADE local fallback computer-use capability state, frontmost app context, and ADE artifact paths.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        includeDisplays: { type: "boolean", default: false }
      }
    }
  },
  {
    name: "launch_app",
    description: "Fallback-only: launch or focus a local desktop application for proof capture flows.",
    inputSchema: {
      type: "object",
      required: ["app"],
      additionalProperties: false,
      properties: {
        app: { type: "string", minLength: 1 },
        waitMs: { type: "number", minimum: 0, maximum: 30000, default: 500 },
        activate: { type: "boolean", default: true }
      }
    }
  },
  {
    name: "interact_gui",
    description: "Fallback-only: perform a local GUI interaction such as click, type, or keypress on macOS.",
    inputSchema: {
      type: "object",
      required: ["action"],
      additionalProperties: false,
      properties: {
        action: { type: "string", enum: ["click", "type", "keypress"] },
        app: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
        text: { type: "string" },
        key: { type: "string" }
      }
    }
  },
  {
    name: "screenshot_environment",
    description: "Fallback-only: capture a local screenshot/image and store it as visual ADE proof.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string" },
        displayId: { type: "number" },
        ownerKind: { type: "string" },
        ownerId: { type: "string" },
        format: { type: "string", enum: ["png", "jpg"], default: "png" }
      }
    }
  },
  {
    name: "record_environment",
    description: "Fallback-only: record a short local screen video and store it as visual ADE proof.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string" },
        displayId: { type: "number" },
        ownerKind: { type: "string" },
        ownerId: { type: "string" },
        durationSec: { type: "number", minimum: 1, maximum: 120, default: 10 }
      }
    }
  },
  {
    name: "ingest_computer_use_artifacts",
    description: "Register externally-produced visual proof artifacts into ADE for ownership, closeout, and publishing. Console logs are supporting diagnostics and should not be the only proof unless explicitly requested.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["backendStyle", "backendName"],
      properties: {
        backendStyle: { type: "string", enum: ["external_cli", "manual", "local_fallback"] },
        backendName: { type: "string", minLength: 1 },
        toolName: { type: "string" },
        command: { type: "string" },
        manifestPath: { type: "string" },
        inputs: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              kind: { type: "string" },
              title: { type: "string" },
              description: { type: "string" },
              path: { type: "string" },
              uri: { type: "string" },
              text: { type: "string" },
              json: {},
              mimeType: { type: "string" },
              rawType: { type: "string" },
              metadata: { type: "object" },
            }
          }
        },
        owners: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["kind", "id"],
            properties: {
              kind: {
                type: "string",
                enum: [
                  "lane",
                  "mission",
                  "orchestrator_run",
                  "orchestrator_step",
                  "orchestrator_attempt",
                  "chat_session",
                  "automation_run",
                  "github_pr",
                  "linear_issue",
                ],
              },
              id: { type: "string", minLength: 1 },
              relation: { type: "string", enum: ["attached_to", "produced_by", "published_to"] },
              metadata: { type: "object" },
            }
          }
        },
        laneId: { type: "string" },
        chatSessionId: { type: "string" },
        automationRunId: { type: "string" },
        prUrl: { type: "string" },
        linearIssueId: { type: "string" },
        ownerKind: { type: "string" },
        ownerId: { type: "string" },
      }
    }
  },
  {
    name: "list_computer_use_artifacts",
    description: "List ADE-managed proof artifacts by owner or canonical type, including visual proof and supporting diagnostics.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ownerKind: {
          type: "string",
          enum: [
            "lane",
            "mission",
            "orchestrator_run",
            "orchestrator_step",
            "orchestrator_attempt",
            "chat_session",
            "automation_run",
            "github_pr",
            "linear_issue",
          ],
        },
        ownerId: { type: "string" },
        kind: { type: "string", enum: ["screenshot", "video_recording", "browser_trace", "browser_verification", "console_logs"] },
        limit: { type: "number", minimum: 1, maximum: 200, default: 50 },
      }
    }
  },
  {
    name: "get_computer_use_backend_status",
    description: "Describe external-first computer-use backends available to ADE and the local fallback status.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {}
    }
  },
  {
    name: "memory_pin",
    description: "Pin a memory entry into always-available Tier-1 context.",
    inputSchema: {
      type: "object",
      required: ["id"],
      additionalProperties: false,
      properties: {
        id: { type: "string", minLength: 1 }
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
    name: "list_unregistered_lanes",
    description: "List git worktrees that are not yet registered as ADE lanes.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {}
    }
  },
  {
    name: "import_lane",
    description: "Import an existing git branch/worktree into ADE lane tracking.",
    inputSchema: {
      type: "object",
      required: ["branchRef"],
      additionalProperties: false,
      properties: {
        branchRef: { type: "string", minLength: 1 },
        name: { type: "string" },
        description: { type: "string" },
        baseBranch: { type: "string" }
      }
    }
  },
  {
    name: "git_get_sync_status",
    description: "Read upstream sync status for a lane branch.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        laneId: { type: "string", minLength: 1 }
      }
    }
  },
  {
    name: "git_fetch",
    description: "Fetch remote refs for a lane.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        laneId: { type: "string", minLength: 1 }
      }
    }
  },
  {
    name: "git_pull",
    description: "Pull remote changes into a lane.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        laneId: { type: "string", minLength: 1 }
      }
    }
  },
  {
    name: "git_push",
    description: "Push lane branch commits to remote.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        laneId: { type: "string", minLength: 1 },
        force: { type: "boolean", default: false },
        setUpstream: { type: "boolean", default: true }
      }
    }
  },
  {
    name: "git_list_branches",
    description: "List branches visible from a lane checkout.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        laneId: { type: "string", minLength: 1 }
      }
    }
  },
  {
    name: "git_checkout_branch",
    description: "Switch a lane checkout to an existing branch or create a new branch in that lane.",
    inputSchema: {
      type: "object",
      required: ["branchName"],
      additionalProperties: false,
      properties: {
        laneId: { type: "string", minLength: 1 },
        branchName: { type: "string", minLength: 1 },
        mode: { type: "string", enum: ["existing", "create"] },
        startPoint: { type: "string", minLength: 1 },
        baseRef: { type: "string", minLength: 1 },
        acknowledgeActiveWork: { type: "boolean" }
      }
    }
  },
  {
    name: "commit_changes",
    description: "Stage and commit lane changes. If message is omitted, ADE generates one with the configured Commit Messages model.",
    inputSchema: {
      type: "object",
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
    name: "generate_commit_message",
    description: "Generate a commit message for a lane using ADE's Commit Messages model settings.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        laneId: { type: "string", minLength: 1 },
        amend: { type: "boolean", default: false }
      }
    }
  },
  {
    name: "stash_push",
    description: "Stash lane changes so rebase or inspection can proceed cleanly. Defaults to the current chat lane when laneId is omitted.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        laneId: { type: "string", minLength: 1 },
        message: { type: "string", minLength: 1 },
        includeUntracked: { type: "boolean", default: true }
      }
    }
  },
  {
    name: "list_stashes",
    description: "List git stashes for a lane. Defaults to the current chat lane when laneId is omitted.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        laneId: { type: "string", minLength: 1 }
      }
    }
  },
  {
    name: "stash_apply",
    description: "Apply a stash to a lane without dropping it. Defaults to the current chat lane when laneId is omitted.",
    inputSchema: {
      type: "object",
      required: ["stashRef"],
      additionalProperties: false,
      properties: {
        laneId: { type: "string", minLength: 1 },
        stashRef: { type: "string", minLength: 1 }
      }
    }
  },
  {
    name: "stash_pop",
    description: "Pop a stash onto a lane and remove it from the stash list. Defaults to the current chat lane when laneId is omitted.",
    inputSchema: {
      type: "object",
      required: ["stashRef"],
      additionalProperties: false,
      properties: {
        laneId: { type: "string", minLength: 1 },
        stashRef: { type: "string", minLength: 1 }
      }
    }
  },
  {
    name: "stash_drop",
    description: "Drop a stash from a lane. Defaults to the current chat lane when laneId is omitted.",
    inputSchema: {
      type: "object",
      required: ["stashRef"],
      additionalProperties: false,
      properties: {
        laneId: { type: "string", minLength: 1 },
        stashRef: { type: "string", minLength: 1 }
      }
    }
  },
  {
    name: "stash_clear",
    description: "Clear all stashes for a lane. Defaults to the current chat lane when laneId is omitted.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        laneId: { type: "string", minLength: 1 }
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
    name: "get_lane_conflict_state",
    description: "Inspect the current merge or rebase conflict state for a lane. Defaults to the current chat lane when laneId is omitted.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        laneId: { type: "string", minLength: 1 }
      }
    }
  },
  {
    name: "rebase_continue",
    description: "Continue an in-progress rebase for a lane. Defaults to the current chat lane when laneId is omitted.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        laneId: { type: "string", minLength: 1 }
      }
    }
  },
  {
    name: "rebase_abort",
    description: "Abort an in-progress rebase for a lane. Defaults to the current chat lane when laneId is omitted.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        laneId: { type: "string", minLength: 1 }
      }
    }
  },
  {
    name: "create_pr_from_lane",
    description: "Create a PR from a lane branch. Drafts a title/body from ADE context when omitted.",
    inputSchema: {
      type: "object",
      required: ["laneId"],
      additionalProperties: false,
      properties: {
        laneId: { type: "string", minLength: 1 },
        baseBranch: { type: "string", minLength: 1 },
        title: { type: "string", minLength: 1 },
        body: { type: "string" },
        draft: { type: "boolean", default: false },
      }
    }
  },
  {
    name: "pr_update_title",
    description: "Update a PR title.",
    inputSchema: {
      type: "object",
      required: ["prId", "title"],
      additionalProperties: false,
      properties: {
        prId: { type: "string", minLength: 1 },
        title: { type: "string", minLength: 1 },
      }
    }
  },
  {
    name: "pr_update_body",
    description: "Update PR body/description markdown.",
    inputSchema: {
      type: "object",
      required: ["prId", "body"],
      additionalProperties: false,
      properties: {
        prId: { type: "string", minLength: 1 },
        body: { type: "string" },
      }
    }
  },
  {
    name: "pr_add_comment",
    description: "Add a top-level comment to a PR.",
    inputSchema: {
      type: "object",
      required: ["prId", "body"],
      additionalProperties: false,
      properties: {
        prId: { type: "string", minLength: 1 },
        body: { type: "string", minLength: 1 },
      }
    }
  },
  {
    name: "get_pr_health",
    description: "Get combined health status for a PR including checks, reviews, conflicts, and rebase status",
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
    name: "pr_get_checks",
    description: "Get the current CI checks for a pull request.",
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
    name: "pr_get_review_comments",
    description: "Fetch actionable review comments, reviews, and current check status for a pull request.",
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
    name: "pr_refresh_issue_inventory",
    description: "Refresh the current PR issue inventory, including checks, failing workflow runs, unresolved review threads, and advisory issue comments.",
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
    name: "pr_preview_issue_resolution_prompt",
    description: "Preview the ADE Path to Merge issue-resolution prompt for a PR without launching an agent.",
    inputSchema: {
      type: "object",
      required: ["prId", "scope", "modelId"],
      additionalProperties: false,
      properties: {
        prId: { type: "string", minLength: 1 },
        scope: { type: "string", enum: ["checks", "comments", "both"] },
        modelId: { type: "string", minLength: 1 },
        reasoning: { type: "string" },
        permissionMode: { type: "string", enum: ["read_only", "guarded_edit", "full_edit"] },
        additionalInstructions: { type: "string" }
      }
    }
  },
  {
    name: "pr_start_issue_resolution",
    description: "Start a Path to Merge issue-resolution agent session for failing checks and/or review comments on a PR.",
    inputSchema: {
      type: "object",
      required: ["prId", "scope", "modelId"],
      additionalProperties: false,
      properties: {
        prId: { type: "string", minLength: 1 },
        scope: { type: "string", enum: ["checks", "comments", "both"] },
        modelId: { type: "string", minLength: 1 },
        reasoning: { type: "string" },
        permissionMode: { type: "string", enum: ["read_only", "guarded_edit", "full_edit"] },
        additionalInstructions: { type: "string" }
      }
    }
  },
  {
    name: "pr_rerun_failed_checks",
    description: "Rerun failed CI checks for a pull request.",
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
    name: "pr_reply_to_review_thread",
    description: "Reply to a GitHub pull request review thread.",
    inputSchema: {
      type: "object",
      required: ["prId", "threadId", "body"],
      additionalProperties: false,
      properties: {
        prId: { type: "string", minLength: 1 },
        threadId: { type: "string", minLength: 1 },
        body: { type: "string", minLength: 1 }
      }
    }
  },
  {
    name: "pr_resolve_review_thread",
    description: "Resolve a GitHub pull request review thread.",
    inputSchema: {
      type: "object",
      required: ["prId", "threadId"],
      additionalProperties: false,
      properties: {
        prId: { type: "string", minLength: 1 },
        threadId: { type: "string", minLength: 1 }
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
    name: "list_retrospectives",
    description: "List generated retrospectives. When called by a worker, missionId defaults to the worker mission.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        missionId: { type: "string", description: "Mission ID filter. Auto-populated from caller context if omitted." },
        limit: { type: "number", minimum: 1, maximum: 100 }
      }
    }
  },
  {
    name: "list_reflection_trends",
    description: "List cross-mission reflection trend entries linked to source retrospectives.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        missionId: { type: "string", description: "Mission ID filter. Auto-populated from caller context if omitted." },
        runId: { type: "string", description: "Run ID filter. Auto-populated from caller context if omitted." },
        limit: { type: "number", minimum: 1, maximum: 500 }
      }
    }
  },
  {
    name: "list_reflection_pattern_stats",
    description: "List reflection pattern repetition stats and candidate-promotion linkage.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        limit: { type: "number", minimum: 1, maximum: 500 }
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

const CTO_OPERATOR_TOOL_SPECS: ToolSpec[] = [
  {
    name: "get_cto_state",
    description: "Read the reconstructed CTO identity, memory, and recent continuity state maintained by ADE. Prefer this over shell-reading .ade/cto files from the workspace.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        recentLimit: { type: "number", minimum: 0, maximum: 50 }
      }
    }
  },
  {
    name: "listChats",
    description: "List ADE Work chat sessions available to the CTO.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        laneId: { type: "string" },
        includeIdentity: { type: "boolean" }
      }
    }
  },
  {
    name: "spawnChat",
    description: "Create a Work chat session in ADE on a lane and optionally seed it with an initial prompt.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        laneId: { type: "string" },
        modelId: { type: "string" },
        reasoningEffort: { type: "string" },
        permissionMode: { type: "string", enum: ["default", "plan", "edit", "full-auto", "config-toml"] },
        title: { type: "string" },
        initialPrompt: { type: "string" },
        openInUi: { type: "boolean" }
      }
    }
  },
  {
    name: "getChatStatus",
    description: "Inspect the status of an ADE Work chat session.",
    inputSchema: {
      type: "object",
      required: ["sessionId"],
      additionalProperties: false,
      properties: {
        sessionId: { type: "string", minLength: 1 }
      }
    }
  },
  {
    name: "readChatTranscript",
    description: "Read a bounded transcript slice from an ADE Work chat session.",
    inputSchema: {
      type: "object",
      required: ["sessionId"],
      additionalProperties: false,
      properties: {
        sessionId: { type: "string", minLength: 1 },
        limit: { type: "number", minimum: 1, maximum: 200 },
        maxChars: { type: "number", minimum: 200, maximum: 120000 }
      }
    }
  },
  {
    name: "sendChatMessage",
    description: "Send a follow-up message to an ADE Work chat session.",
    inputSchema: {
      type: "object",
      required: ["sessionId", "text"],
      additionalProperties: false,
      properties: {
        sessionId: { type: "string", minLength: 1 },
        text: { type: "string", minLength: 1 }
      }
    }
  },
  {
    name: "interruptChat",
    description: "Interrupt an active ADE Work chat turn.",
    inputSchema: {
      type: "object",
      required: ["sessionId"],
      additionalProperties: false,
      properties: {
        sessionId: { type: "string", minLength: 1 }
      }
    }
  },
  {
    name: "resumeChat",
    description: "Resume an ended ADE Work chat session.",
    inputSchema: {
      type: "object",
      required: ["sessionId"],
      additionalProperties: false,
      properties: {
        sessionId: { type: "string", minLength: 1 }
      }
    }
  },
  {
    name: "endChat",
    description: "End an ADE Work chat session.",
    inputSchema: {
      type: "object",
      required: ["sessionId"],
      additionalProperties: false,
      properties: {
        sessionId: { type: "string", minLength: 1 }
      }
    }
  },
  {
    name: "listLinearWorkflows",
    description: "List active and queued Linear workflow runs managed by ADE.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} }
  },
  {
    name: "getLinearRunStatus",
    description: "Inspect a Linear workflow run in detail.",
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
    name: "resolveLinearRunAction",
    description: "Approve, reject, retry, resume, or explicitly complete a Linear workflow run.",
    inputSchema: {
      type: "object",
      required: ["runId", "action"],
      additionalProperties: false,
      properties: {
        runId: { type: "string", minLength: 1 },
        action: { type: "string", enum: ["approve", "reject", "retry", "complete", "resume"] },
        note: { type: "string" }
      }
    }
  },
  {
    name: "cancelLinearRun",
    description: "Cancel a Linear workflow run and record the operator reason.",
    inputSchema: {
      type: "object",
      required: ["runId", "reason"],
      additionalProperties: false,
      properties: {
        runId: { type: "string", minLength: 1 },
        reason: { type: "string", minLength: 1 }
      }
    }
  },
  {
    name: "routeLinearIssueToCto",
    description: "Route a Linear issue into the persistent CTO session.",
    inputSchema: {
      type: "object",
      required: ["issueId"],
      additionalProperties: false,
      properties: {
        issueId: { type: "string", minLength: 1 },
        laneId: { type: "string" },
        reuseExisting: { type: "boolean" }
      }
    }
  },
  {
    name: "routeLinearIssueToMission",
    description: "Create a mission from a Linear issue and optionally launch it.",
    inputSchema: {
      type: "object",
      required: ["issueId"],
      additionalProperties: false,
      properties: {
        issueId: { type: "string", minLength: 1 },
        laneId: { type: "string" },
        launch: { type: "boolean" },
        runMode: { type: "string", enum: ["autopilot", "manual"] }
      }
    }
  },
  {
    name: "routeLinearIssueToWorker",
    description: "Wake a worker agent with a Linear issue as the task context.",
    inputSchema: {
      type: "object",
      required: ["issueId", "agentId"],
      additionalProperties: false,
      properties: {
        issueId: { type: "string", minLength: 1 },
        agentId: { type: "string", minLength: 1 },
        taskKey: { type: "string" }
      }
    }
  },
  {
    name: "rerouteLinearRun",
    description: "Recover a Linear workflow run by canceling it if needed and re-routing its issue.",
    inputSchema: {
      type: "object",
      required: ["runId", "target", "reason"],
      additionalProperties: false,
      properties: {
        runId: { type: "string", minLength: 1 },
        target: { type: "string", enum: ["cto", "mission", "worker"] },
        reason: { type: "string", minLength: 1 },
        laneId: { type: "string" },
        reuseExisting: { type: "boolean" },
        launch: { type: "boolean" },
        runMode: { type: "string", enum: ["autopilot", "manual"] },
        agentId: { type: "string" },
        taskKey: { type: "string" }
      }
    }
  },
];

const CTO_LINEAR_SYNC_TOOL_SPECS: ToolSpec[] = [
  {
    name: "getLinearSyncDashboard",
    description: "Read the ADE Linear sync dashboard.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} }
  },
  {
    name: "runLinearSyncNow",
    description: "Trigger a Linear sync run now and return the updated dashboard.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} }
  },
  {
    name: "listLinearSyncQueue",
    description: "List queued Linear sync items managed by ADE.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} }
  },
  {
    name: "resolveLinearSyncQueueItem",
    description: "Resolve a Linear sync queue item through ADE.",
    inputSchema: {
      type: "object",
      required: ["queueItemId", "action"],
      additionalProperties: false,
      properties: {
        queueItemId: { type: "string", minLength: 1 },
        action: { type: "string", enum: ["approve", "reject", "retry", "complete", "resume"] },
        note: { type: "string" },
        employeeOverride: { type: "string" },
        laneId: { type: "string" }
      }
    }
  },
  {
    name: "getLinearWorkflowRunDetail",
    description: "Read a detailed Linear workflow run record from ADE sync state.",
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
    name: "getLinearIngressStatus",
    description: "Read the ADE Linear ingress/webhook status.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} }
  },
  {
    name: "listLinearIngressEvents",
    description: "List recent ADE Linear ingress events.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        limit: { type: "number", minimum: 1, maximum: 100 }
      }
    }
  },
  {
    name: "ensureLinearWebhook",
    description: "Ensure the ADE Linear relay webhook exists and return ingress status.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        force: { type: "boolean" }
      }
    }
  },
  {
    name: "getFlowPolicy",
    description: "Read the current ADE Linear flow policy.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} }
  },
  {
    name: "saveFlowPolicy",
    description: "Update the ADE Linear flow policy.",
    inputSchema: {
      type: "object",
      required: ["policy"],
      additionalProperties: false,
      properties: {
        policy: { type: "object" },
        actor: { type: "string" }
      }
    }
  },
  {
    name: "simulateFlowRoute",
    description: "Simulate ADE Linear routing for a candidate issue payload.",
    inputSchema: {
      type: "object",
      required: ["issue"],
      additionalProperties: false,
      properties: {
        issue: { type: "object" }
      }
    }
  },
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
  { name: "delegate_parallel", description: "Coordinator: delegate multiple child subtasks from one parent in a single call.", inputSchema: { type: "object", additionalProperties: true, properties: {} } },
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
  { name: "set_current_phase", description: "Coordinator: set the active mission phase.", inputSchema: { type: "object", additionalProperties: true, properties: {} } },
  { name: "create_task", description: "Coordinator: create a logical mission task without spawning a worker.", inputSchema: { type: "object", additionalProperties: true, properties: {} } },
  { name: "update_task", description: "Coordinator: update task metadata/status.", inputSchema: { type: "object", additionalProperties: true, properties: {} } },
  { name: "assign_task", description: "Coordinator: assign a task to an existing worker.", inputSchema: { type: "object", additionalProperties: true, properties: {} } },
  { name: "list_tasks", description: "Coordinator: list mission tasks and status.", inputSchema: { type: "object", additionalProperties: true, properties: {} } },
  { name: "skip_step", description: "Coordinator: skip a worker step.", inputSchema: { type: "object", additionalProperties: true, properties: {} } },
  { name: "mark_step_complete", description: "Coordinator: mark a worker step as succeeded.", inputSchema: { type: "object", additionalProperties: true, properties: {} } },
  { name: "mark_step_failed", description: "Coordinator: mark a worker step as failed.", inputSchema: { type: "object", additionalProperties: true, properties: {} } },
  { name: "retry_step", description: "Coordinator: retry a failed worker step.", inputSchema: { type: "object", additionalProperties: true, properties: {} } },
  { name: "complete_mission", description: "Coordinator: request mission success finalization. The runtime still enforces completion gates before success is granted.", inputSchema: { type: "object", additionalProperties: true, properties: {} } },
  { name: "fail_mission", description: "Coordinator: finalize the mission run as failed.", inputSchema: { type: "object", additionalProperties: true, properties: {} } },
  { name: "get_budget_status", description: "Coordinator: inspect mission budget pressure/hard caps.", inputSchema: { type: "object", additionalProperties: true, properties: {} } },
  { name: "request_user_input", description: "Coordinator: open a user intervention with a question.", inputSchema: { type: "object", additionalProperties: true, properties: {} } },
  { name: "read_file", description: "Coordinator: read a file within project root.", inputSchema: { type: "object", additionalProperties: true, properties: {} } },
  { name: "read_step_output", description: "Coordinator: read output artifact for a specific step.", inputSchema: { type: "object", additionalProperties: true, properties: {} } },
  { name: "search_files", description: "Coordinator: search files/content in project root.", inputSchema: { type: "object", additionalProperties: true, properties: {} } },
  { name: "get_project_context", description: "Coordinator: return compact mission/project context for planning.", inputSchema: { type: "object", additionalProperties: true, properties: {} } },
];

const AGENT_VISIBLE_COORDINATOR_TOOL_NAMES = new Set([
  "report_status",
  "report_result",
  "report_validation",
  "delegate_to_subagent",
  "delegate_parallel",
  "get_worker_output",
  "list_workers",
  "read_mission_status",
  "read_mission_state",
  "list_tasks",
  "get_budget_status",
  "get_project_context",
]);

const AGENT_VISIBLE_COORDINATOR_TOOL_SPECS = COORDINATOR_TOOL_SPECS.filter((tool) =>
  AGENT_VISIBLE_COORDINATOR_TOOL_NAMES.has(tool.name)
);

const STANDALONE_CHAT_HIDDEN_TOOL_NAMES = new Set([
  "spawn_agent",
  ...COORDINATOR_TOOL_SPECS.map((tool) => tool.name),
]);

const CTO_OPERATOR_TOOL_NAMES = new Set(CTO_OPERATOR_TOOL_SPECS.map((tool) => tool.name));
const CTO_LINEAR_SYNC_TOOL_NAMES = new Set(CTO_LINEAR_SYNC_TOOL_SPECS.map((tool) => tool.name));

const LOCAL_COMPUTER_USE_TOOL_NAMES = new Set([
  "get_environment_info",
  "launch_app",
  "interact_gui",
  "screenshot_environment",
  "record_environment",
]);

const ALL_TOOL_SPECS: ToolSpec[] = [
  ...TOOL_SPECS,
  ...CTO_OPERATOR_TOOL_SPECS,
  ...CTO_LINEAR_SYNC_TOOL_SPECS,
  ...COORDINATOR_TOOL_SPECS,
];
const COORDINATOR_TOOL_NAMES = new Set(COORDINATOR_TOOL_SPECS.map((tool) => tool.name));

const READ_ONLY_TOOLS = new Set([
  "check_conflicts",
  "list_ade_actions",
  "get_ade_action_status",
  "get_lane_status",
  "get_lane_conflict_state",
  "list_lanes",
  "list_unregistered_lanes",
  "git_get_sync_status",
  "git_list_branches",
  "generate_commit_message",
  "list_stashes",
  "simulate_integration",
  "get_pr_health",
  "pr_get_checks",
  "pr_get_review_comments",
  "pr_refresh_issue_inventory",
  "pr_preview_issue_resolution_prompt",
  "memory_search",
  "get_cto_state",
  "listChats",
  "getChatStatus",
  "readChatTranscript",
  "listLinearWorkflows",
  "getLinearRunStatus",
  "getLinearSyncDashboard",
  "listLinearSyncQueue",
  "getLinearWorkflowRunDetail",
  "getLinearIngressStatus",
  "listLinearIngressEvents",
  "getFlowPolicy",
  "simulateFlowRoute",
  "get_environment_info",
  "list_computer_use_artifacts",
  "get_computer_use_backend_status",
]);

const MUTATION_TOOLS = new Set([
  "create_lane",
  "run_ade_action",
  "import_lane",
  "merge_lane",
  "git_fetch",
  "git_pull",
  "git_push",
  "git_checkout_branch",
  "commit_changes",
  "stash_push",
  "stash_apply",
  "stash_pop",
  "stash_drop",
  "stash_clear",
  "run_tests",
  "create_queue",
  "create_integration",
  "create_pr_from_lane",
  "pr_update_title",
  "pr_update_body",
  "pr_add_comment",
  "rebase_lane",
  "rebase_continue",
  "rebase_abort",
  "land_queue_next",
  "pr_rerun_failed_checks",
  "pr_start_issue_resolution",
  "pr_reply_to_review_thread",
  "pr_resolve_review_thread",
  "memory_add",
  "memory_pin",
  "memory_update_core",
  "reflection_add",
  "spawnChat",
  "sendChatMessage",
  "interruptChat",
  "resumeChat",
  "endChat",
  "resolveLinearRunAction",
  "cancelLinearRun",
  "routeLinearIssueToCto",
  "routeLinearIssueToMission",
  "routeLinearIssueToWorker",
  "rerouteLinearRun",
  "runLinearSyncNow",
  "resolveLinearSyncQueueItem",
  "ensureLinearWebhook",
  "saveFlowPolicy",
  "launch_app",
  "interact_gui",
  "screenshot_environment",
  "record_environment",
  "ingest_computer_use_artifacts",
  "spawn_agent"
]);

const ORCHESTRATION_TOOLS = new Set([
  "create_mission",
  "start_mission",
  "pause_mission",
  "resume_mission",
  "cancel_mission",
  "steer_mission",
  "resolve_intervention"
]);

const OBSERVATION_TOOLS = new Set([
  "get_mission",
  "get_run_graph",
  "stream_events",
  "get_step_output",
  "get_worker_states",
  "get_timeline",
  "list_retrospectives",
  "list_reflection_trends",
  "list_reflection_pattern_stats",
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

/**
 * Recursively fix JSON Schema issues that strict providers (OpenAI) reject:
 * - arrays missing `items` → default to `items: {}`
 * - objects missing `properties` → default to `properties: {}`
 * - objects whose `required` doesn't include all property keys → patch it
 */
function sanitizeToolSchema(schema: unknown): unknown {
  if (!isRecord(schema)) return schema;
  const out = { ...schema };
  if (out.type === "array" && out.items == null) {
    out.items = {};
  }
  if (out.type === "object" && out.properties == null) {
    out.properties = {};
  }
  if (out.type === "object" && isRecord(out.properties)) {
    const propKeys = Object.keys(out.properties);
    if (propKeys.length && !Array.isArray(out.required)) {
      // Default to no required fields when none declared; preserve any
      // explicit `required` array exactly as written so optional properties
      // stay optional.
      out.required = [];
    }
    const sanitizedProps: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(out.properties)) {
      sanitizedProps[key] = sanitizeToolSchema(val);
    }
    out.properties = sanitizedProps;
  }
  if (out.items != null) {
    out.items = sanitizeToolSchema(out.items);
  }
  if (Array.isArray(out.anyOf)) {
    out.anyOf = out.anyOf.map(sanitizeToolSchema);
  }
  if (Array.isArray(out.oneOf)) {
    out.oneOf = out.oneOf.map(sanitizeToolSchema);
  }
  if (Array.isArray(out.allOf)) {
    out.allOf = out.allOf.map(sanitizeToolSchema);
  }
  return out;
}

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asOptionalTrimmedString(value: unknown): string | null {
  const text = asTrimmedString(value);
  return text.length ? text : null;
}

function parseEnvBoolean(value: string | undefined): boolean | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (normalized === "1" || normalized === "true" || normalized === "yes") return true;
  if (normalized === "0" || normalized === "false" || normalized === "no") return false;
  return null;
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

export function resolveComputerUseOwners(session: SessionState, toolArgs: Record<string, unknown>): ComputerUseArtifactOwner[] {
  const owners: ComputerUseArtifactOwner[] = [];
  const add = (
    kind: ComputerUseArtifactOwner["kind"],
    id: string | null | undefined,
    relation: ComputerUseArtifactOwner["relation"] = "attached_to",
  ) => {
    if (!id || !id.trim().length) return;
    owners.push({ kind, id: id.trim(), relation });
  };
  const addExplicitOwner = () => {
    const rawKind = asOptionalTrimmedString(toolArgs.ownerKind);
    const ownerId = asOptionalTrimmedString(toolArgs.ownerId);
    if (Boolean(rawKind) !== Boolean(ownerId)) {
      throw new JsonRpcError(
        JsonRpcErrorCode.invalidParams,
        "ownerKind and ownerId must be provided together",
      );
    }
    if (!rawKind || !ownerId) return;
    let normalizedKind = rawKind;
    if (rawKind === "chat") normalizedKind = "chat_session";
    else if (rawKind === "pr") normalizedKind = "github_pr";
    switch (normalizedKind) {
      case "lane":
      case "mission":
      case "orchestrator_run":
      case "orchestrator_step":
      case "orchestrator_attempt":
      case "chat_session":
      case "automation_run":
      case "github_pr":
      case "linear_issue":
        add(
          normalizedKind,
          ownerId,
          normalizedKind === "github_pr" || normalizedKind === "linear_issue"
            ? "published_to"
            : normalizedKind === "orchestrator_attempt"
              ? "produced_by"
              : "attached_to",
        );
        break;
      default:
        throw new JsonRpcError(JsonRpcErrorCode.invalidParams, `Unsupported proof ownerKind: ${rawKind}`);
    }
  };

  addExplicitOwner();
  add("mission", session.identity.missionId);
  add("orchestrator_run", session.identity.runId);
  add("orchestrator_step", session.identity.stepId);
  add("orchestrator_attempt", session.identity.attemptId, "produced_by");
  add("lane", asOptionalTrimmedString(toolArgs.laneId));
  const explicitChatSessionId = asOptionalTrimmedString(toolArgs.chatSessionId);
  if (explicitChatSessionId) {
    add("chat_session", explicitChatSessionId);
  } else if (session.identity.chatSessionId) {
    add("chat_session", session.identity.chatSessionId);
  } else {
    const looksLikeStandaloneChat =
      !session.identity.missionId
      && !session.identity.runId
      && !session.identity.stepId
      && session.identity.role !== "orchestrator"
      && session.identity.role !== "evaluator";
    if (looksLikeStandaloneChat) {
      const implicitChatSessionId =
        asOptionalTrimmedString(session.identity.callerId) ?? asOptionalTrimmedString(session.identity.attemptId);
      if (implicitChatSessionId && implicitChatSessionId !== "unknown") {
        add("chat_session", implicitChatSessionId);
      }
    }
  }
  add("automation_run", asOptionalTrimmedString(toolArgs.automationRunId));
  add("github_pr", asOptionalTrimmedString(toolArgs.prUrl), "published_to");
  add("linear_issue", asOptionalTrimmedString(toolArgs.linearIssueId), "published_to");

  const rawOwners = Array.isArray(toolArgs.owners) ? toolArgs.owners : [];
  for (const entry of rawOwners) {
    const owner = safeObject(entry);
    const kind = asOptionalTrimmedString(owner.kind) as ComputerUseArtifactOwner["kind"] | null;
    const id = asOptionalTrimmedString(owner.id);
    const relation = asOptionalTrimmedString(owner.relation) as ComputerUseArtifactOwner["relation"] | null;
    if (!kind || !id) continue;
    owners.push({
      kind,
      id,
      ...(relation ? { relation } : {}),
      ...(isRecord(owner.metadata) ? { metadata: owner.metadata } : {}),
    });
  }

  return owners;
}

type MemoryToolCategory = "fact" | "preference" | "pattern" | "decision" | "gotcha" | "convention";
type MemoryToolImportance = "low" | "medium" | "high";
type MemoryToolScope = "project" | "mission" | "agent";
type MemoryToolSearchStatus = "promoted" | "candidate" | "archived" | "all";
type MemoryServiceScope = "project" | "agent" | "mission";
type SharedFactType = "api_pattern" | "schema_change" | "config" | "architectural" | "gotcha";

function parseMemoryToolCategory(value: unknown): MemoryToolCategory {
  const category = asTrimmedString(value);
  if (
    category === "fact" ||
    category === "preference" ||
    category === "pattern" ||
    category === "decision" ||
    category === "gotcha" ||
    category === "convention"
  ) {
    return category;
  }
  throw new JsonRpcError(
    JsonRpcErrorCode.invalidParams,
    "category must be one of: fact, preference, pattern, decision, gotcha, convention"
  );
}

function parseMemoryToolImportance(value: unknown): MemoryToolImportance {
  const importance = asOptionalTrimmedString(value) ?? "medium";
  if (importance === "low" || importance === "medium" || importance === "high") {
    return importance;
  }
  throw new JsonRpcError(JsonRpcErrorCode.invalidParams, "importance must be one of: low, medium, high");
}

function parseMemoryToolScope(value: unknown, fallback: MemoryToolScope): MemoryToolScope {
  const scope = asOptionalTrimmedString(value) ?? fallback;
  if (scope === "project" || scope === "mission" || scope === "agent") {
    return scope;
  }
  throw new JsonRpcError(JsonRpcErrorCode.invalidParams, "scope must be one of: project, mission, agent");
}

function mapMemoryToolScopeToServiceScope(scope: MemoryToolScope): MemoryServiceScope {
  if (scope === "agent") return "agent";
  return scope;
}

function resolveMemoryToolScopeOwnerId(scope: MemoryToolScope, callerCtx: CallerContext): string | null {
  if (scope === "mission") {
    return callerCtx.runId ?? null;
  }
  if (scope === "agent") {
    return callerCtx.callerId ?? callerCtx.attemptId ?? null;
  }
  return null;
}

function parseMemoryToolSearchStatus(value: unknown): MemoryToolSearchStatus {
  const status = asOptionalTrimmedString(value) ?? "promoted";
  if (status === "promoted" || status === "candidate" || status === "archived" || status === "all") {
    return status;
  }
  throw new JsonRpcError(JsonRpcErrorCode.invalidParams, "status must be one of: promoted, candidate, archived, all");
}

function mapMemoryCategoryToSharedFactType(category: MemoryToolCategory): SharedFactType {
  if (category === "pattern") return "api_pattern";
  if (category === "preference" || category === "convention") return "config";
  if (category === "gotcha") return "gotcha";
  return "architectural";
}

function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2);
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

function requirePrService(runtime: AdeRuntime): NonNullable<AdeRuntime["prService"]> {
  if (!runtime.prService) {
    throw new JsonRpcError(JsonRpcErrorCode.internalError, "prService is not available in this ADE runtime configuration");
  }
  return runtime.prService;
}

function isBotAuthor(author: string): boolean {
  const normalized = author.trim().toLowerCase();
  return normalized.includes("[bot]") || normalized.includes("github-actions");
}

function summarizePrChecks(checks: PrCheck[]): { overall: "failing" | "pending" | "passing"; counts: { passing: number; failing: number; pending: number; total: number } } {
  const passing = checks.filter((check) => check.conclusion === "success").length;
  const failing = checks.filter((check) => check.conclusion === "failure").length;
  const pending = checks.filter((check) => check.status !== "completed").length;

  let overall: "failing" | "pending" | "passing" = "passing";
  if (failing > 0) overall = "failing";
  else if (pending > 0) overall = "pending";

  return { overall, counts: { passing, failing, pending, total: checks.length } };
}

function mapCheckToSummary(check: PrCheck): { name: string; status: string; conclusion: string | null; url: string | null } {
  return { name: check.name, status: check.status, conclusion: check.conclusion, url: check.detailsUrl };
}

function summarizePrReviewComments(prId: string, comments: PrComment[], reviews: Array<{ reviewer: string; reviewerAvatarUrl: string | null; state: string; body: string | null; submittedAt: string | null }>, checks: PrCheck[]) {
  const actionableComments = comments.filter((comment) => Boolean(comment.body?.trim()) && !isBotAuthor(comment.author));
  const pendingReviews = reviews.filter((review) => review.state === "changes_requested" || review.state === "commented");
  const checkSummary = summarizePrChecks(checks);
  return {
    success: true,
    prId,
    summary: {
      totalComments: comments.length,
      actionableComments: actionableComments.length,
      reviewsRequiringChanges: pendingReviews.filter((review) => review.state === "changes_requested").length,
      checksStatus: checkSummary.overall,
    },
    comments: actionableComments.map((comment) => ({
      id: comment.id,
      author: comment.author,
      body: comment.body,
      source: comment.source,
      path: comment.path,
      line: comment.line,
      url: comment.url,
      createdAt: comment.createdAt,
    })),
    reviews: pendingReviews.map((review) => ({
      reviewer: review.reviewer,
      state: review.state,
      body: review.body,
      submittedAt: review.submittedAt,
    })),
    checks: checks.map(mapCheckToSummary),
  };
}

function summarizePrIssueInventory(args: {
  checks: PrCheck[];
  actionRuns: PrActionRun[];
  reviewThreads: PrReviewThread[];
  comments: PrComment[];
}) {
  const availability = getPrIssueResolutionAvailability(args.checks, args.reviewThreads);
  const failingRuns = args.actionRuns
    .filter((run) => run.conclusion === "failure" || run.conclusion === "timed_out" || run.conclusion === "action_required")
    .map((run) => ({
      id: run.id,
      name: run.name,
      status: run.status,
      conclusion: run.conclusion,
      url: run.htmlUrl,
      failingJobs: run.jobs
        .filter((job) => job.conclusion === "failure" || job.status === "in_progress")
        .map((job) => ({
          id: job.id,
          name: job.name,
          status: job.status,
          conclusion: job.conclusion,
          failingSteps: job.steps
            .filter((step) => step.conclusion === "failure" || step.status === "in_progress")
            .map((step) => step.name),
        })),
    }));

  return {
    success: true,
    summary: availability,
    checks: args.checks.map(mapCheckToSummary),
    failingWorkflowRuns: failingRuns,
    reviewThreads: args.reviewThreads
      .filter((thread) => !thread.isResolved && !thread.isOutdated)
      .map((thread) => ({
        id: thread.id,
        path: thread.path,
        line: thread.line,
        url: thread.url,
        comments: thread.comments.map((comment) => ({
          id: comment.id,
          author: comment.author,
          body: comment.body,
          url: comment.url,
        })),
      })),
    issueComments: args.comments
      .filter((comment) => comment.source === "issue")
      .map((comment) => ({
        id: comment.id,
        author: comment.author,
        body: comment.body,
        url: comment.url,
      })),
  };
}

function requireAgentChatService(runtime: AdeRuntime): NonNullable<AdeRuntime["agentChatService"]> {
  if (!runtime.agentChatService) {
    throw new JsonRpcError(
      JsonRpcErrorCode.internalError,
      "agentChatService is not available in this ADE runtime configuration",
    );
  }
  return runtime.agentChatService;
}

function requireLinearSyncService(runtime: AdeRuntime): NonNullable<AdeRuntime["linearSyncService"]> {
  if (!runtime.linearSyncService) {
    throw new JsonRpcError(JsonRpcErrorCode.internalError, "linearSyncService is not available in this ADE runtime configuration");
  }
  return runtime.linearSyncService;
}

function requireLinearIngressService(runtime: AdeRuntime): NonNullable<AdeRuntime["linearIngressService"]> {
  if (!runtime.linearIngressService) {
    throw new JsonRpcError(JsonRpcErrorCode.internalError, "linearIngressService is not available in this ADE runtime configuration");
  }
  return runtime.linearIngressService;
}

function requireFlowPolicyService(runtime: AdeRuntime): NonNullable<AdeRuntime["flowPolicyService"]> {
  if (!runtime.flowPolicyService) {
    throw new JsonRpcError(JsonRpcErrorCode.internalError, "flowPolicyService is not available in this ADE runtime configuration");
  }
  return runtime.flowPolicyService;
}

function requireLinearRoutingService(runtime: AdeRuntime): NonNullable<AdeRuntime["linearRoutingService"]> {
  if (!runtime.linearRoutingService) {
    throw new JsonRpcError(JsonRpcErrorCode.internalError, "linearRoutingService is not available in this ADE runtime configuration");
  }
  return runtime.linearRoutingService;
}

async function resolveDefaultLaneId(runtime: AdeRuntime): Promise<string> {
  await runtime.laneService.ensurePrimaryLane().catch(() => {});
  const lanes = await runtime.laneService.list({ includeArchived: false, includeStatus: false });
  const laneId = (lanes.find((lane) => lane.laneType === "primary") ?? lanes[0])?.id?.trim?.() || "";
  if (!laneId) {
    throw new JsonRpcError(JsonRpcErrorCode.internalError, "No active lane is available for CTO operator actions.");
  }
  return laneId;
}

function resolveChatSessionLaneId(runtime: AdeRuntime, session: SessionState): string | null {
  const chatSessionId = asOptionalTrimmedString(session.identity.chatSessionId);
  if (!chatSessionId) return null;
  const chatSession = runtime.sessionService.get(chatSessionId);
  const laneId = typeof chatSession?.laneId === "string" ? chatSession.laneId.trim() : "";
  return laneId.length ? laneId : null;
}

function resolveLaneWorktreePath(runtime: AdeRuntime, laneId: string | null | undefined): string | null {
  const normalizedLaneId = asOptionalTrimmedString(laneId);
  if (!normalizedLaneId) return null;
  try {
    if (typeof runtime.laneService.getLaneWorktreePath === "function") {
      const worktreePath = runtime.laneService.getLaneWorktreePath(normalizedLaneId);
      const trimmed = typeof worktreePath === "string" ? worktreePath.trim() : "";
      if (trimmed.length > 0) return trimmed;
    }
  } catch {
    // Fall through to other lane resolvers below.
  }
  try {
    if (typeof runtime.laneService.getLaneBaseAndBranch === "function") {
      const lane = runtime.laneService.getLaneBaseAndBranch(normalizedLaneId);
      const trimmed = typeof lane?.worktreePath === "string" ? lane.worktreePath.trim() : "";
      if (trimmed.length > 0) return trimmed;
    }
  } catch {
    // Ignore lane lookup failures and use the runtime fallback.
  }
  return null;
}

function resolveRunContextLaneId(runtime: AdeRuntime, callerCtx: CallerContext): string | null {
  const runId = asOptionalTrimmedString(callerCtx.runId);
  if (!runId) return null;

  const graph = getRunGraphSafe(runtime, runId);
  if (graph) {
    const inferredWorkerId = inferWorkerIdFromCaller(graph, callerCtx);
    const step = resolveStepFromGraph(graph, callerCtx.stepId, inferredWorkerId);
    const stepLaneId = asOptionalTrimmedString(step?.laneId);
    if (stepLaneId) return stepLaneId;
  }

  const missionId = asOptionalTrimmedString(callerCtx.missionId) ?? resolveMissionIdForRun(runtime, runId);
  if (!missionId) return null;
  const mission = runtime.missionService.get(missionId) as Record<string, unknown> | null;
  return asOptionalTrimmedString(mission?.laneId) ?? asOptionalTrimmedString(mission?.lane_id);
}

function resolveAuthorizedWorkspaceRoot(
  runtime: AdeRuntime,
  session: SessionState,
  toolArgs?: Record<string, unknown>,
): string {
  const requestedLaneId = toolArgs ? extractLaneId(toolArgs) : null;
  if (requestedLaneId) {
    const laneWorktreePath = resolveLaneWorktreePath(runtime, requestedLaneId);
    if (!laneWorktreePath) {
      throw new JsonRpcError(
        JsonRpcErrorCode.invalidParams,
        `Requested lane '${requestedLaneId}' does not have an available worktree.`,
      );
    }
    return laneWorktreePath;
  }

  const sessionLaneId = resolveChatSessionLaneId(runtime, session);
  if (sessionLaneId) {
    const laneWorktreePath = resolveLaneWorktreePath(runtime, sessionLaneId);
    if (!laneWorktreePath) {
      throw new JsonRpcError(
        JsonRpcErrorCode.invalidParams,
        `Chat session lane '${sessionLaneId}' does not have an available worktree.`,
      );
    }
    return laneWorktreePath;
  }

  const runContextLaneId = resolveRunContextLaneId(runtime, resolveCallerContext(session));
  if (runContextLaneId) {
    const laneWorktreePath = resolveLaneWorktreePath(runtime, runContextLaneId);
    if (!laneWorktreePath) {
      throw new JsonRpcError(
        JsonRpcErrorCode.invalidParams,
        `Run context lane '${runContextLaneId}' does not have an available worktree.`,
      );
    }
    return laneWorktreePath;
  }

  const fallbackWorkspaceRoot = typeof runtime.workspaceRoot === "string" ? runtime.workspaceRoot.trim() : "";
  if (fallbackWorkspaceRoot.length > 0) return fallbackWorkspaceRoot;
  return runtime.projectRoot;
}

function resolveRequestedOrSessionLaneId(
  runtime: AdeRuntime,
  session: SessionState,
  toolArgs: Record<string, unknown>,
): string | null {
  return extractLaneId(toolArgs) ?? resolveChatSessionLaneId(runtime, session);
}

function requireLaneIdForTool(
  runtime: AdeRuntime,
  session: SessionState,
  toolArgs: Record<string, unknown>,
  toolName: string,
): string {
  const laneId = resolveRequestedOrSessionLaneId(runtime, session, toolArgs)?.trim() ?? "";
  if (!laneId) {
    throw new JsonRpcError(
      JsonRpcErrorCode.invalidParams,
      `${toolName} requires laneId unless the caller is already bound to a chat session lane.`,
    );
  }
  return laneId;
}

async function runCtoOperatorBridgeTool(
  runtime: AdeRuntime,
  session: SessionState,
  name: string,
  toolArgs: Record<string, unknown>,
): Promise<unknown> {
  const agentChatService = requireAgentChatService(runtime);
  const defaultLaneId = (resolveRequestedOrSessionLaneId(runtime, session, toolArgs) ?? await resolveDefaultLaneId(runtime)).trim();
  const ctoIdentity = runtime.ctoStateService.getIdentity();
  const preferredProvider = ctoIdentity.modelPreferences.provider.trim().toLowerCase();
  const fallbackModelId = preferredProvider.includes("claude")
    ? (getDefaultModelDescriptor("claude")?.id ?? null)
    : (getDefaultModelDescriptor("codex")?.id ?? null);
  const defaultModelId =
    (typeof ctoIdentity.modelPreferences.modelId === "string" && ctoIdentity.modelPreferences.modelId.trim().length
      ? ctoIdentity.modelPreferences.modelId.trim()
      : null)
    ?? fallbackModelId;
  const tools = createCtoOperatorTools({
    currentSessionId: session.identity.callerId || "ade-cli-cto",
    defaultLaneId,
    defaultModelId,
    sessionService: runtime.sessionService,
    resolveExecutionLane: async ({ requestedLaneId }) => requestedLaneId?.trim() || defaultLaneId,
    laneService: runtime.laneService,
    missionService: runtime.missionService,
    aiOrchestratorService: runtime.aiOrchestratorService,
    workerAgentService: runtime.workerAgentService,
    linearDispatcherService: runtime.linearDispatcherService ?? null,
    flowPolicyService: runtime.flowPolicyService ?? null,
    prService: runtime.prService ?? null,
    issueInventoryService: runtime.issueInventoryService,
    fileService: runtime.fileService ?? null,
    processService: runtime.processService ?? null,
    issueTracker: runtime.linearIssueTracker ?? null,
    listChats: agentChatService.listSessions,
    getChatStatus: agentChatService.getSessionSummary,
    getChatTranscript: agentChatService.getChatTranscript,
    createChat: agentChatService.createSession,
    updateChatSession: agentChatService.updateSession,
    previewSessionToolNames: agentChatService.previewSessionToolNames,
    sendChatMessage: agentChatService.sendMessage,
    interruptChat: agentChatService.interrupt,
    resumeChat: agentChatService.resumeSession,
    disposeChat: agentChatService.dispose,
    ensureCtoSession: async ({ laneId, modelId, reasoningEffort, reuseExisting }) =>
      agentChatService.ensureIdentitySession({
        identityKey: "cto",
        laneId,
        modelId,
        reasoningEffort,
        reuseExisting,
      }),
  });
  const toolEntry = (tools as Record<string, ExecutableTool>)[name];
  const executable = toolEntry as unknown as { execute?: (args: Record<string, unknown>) => Promise<unknown> };
  if (!toolEntry || typeof executable.execute !== "function") {
    throw new JsonRpcError(JsonRpcErrorCode.methodNotFound, `Unsupported CTO operator tool: ${name}`);
  }
  return await executable.execute(toolArgs);
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

function windowsShellEscapeArg(value: string): string {
  const sanitized = stripInjectionChars(value);
  if (!sanitized.length) return "\"\"";
  if (/^[a-zA-Z0-9_.:/\\-]+$/.test(sanitized)) return sanitized;
  let quoted = "\"";
  let backslashes = 0;
  for (const char of sanitized.replace(/%/g, "%%")) {
    if (char === "\\") {
      backslashes += 1;
      continue;
    }
    if (char === "\"") {
      quoted += "\\".repeat(backslashes * 2);
      quoted += "\"\"";
    } else {
      quoted += "\\".repeat(backslashes);
      quoted += char;
    }
    backslashes = 0;
  }
  quoted += "\\".repeat(backslashes * 2);
  quoted += "\"";
  return quoted;
}

function previewShellEscapeArg(value: string): string {
  return process.platform === "win32" ? windowsShellEscapeArg(value) : shellEscapeArg(value);
}

function clipText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 18))}\n...<truncated>`;
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

type SpawnPermissionMode = "default" | "plan" | "edit" | "full-auto" | "config-toml";

function parseSpawnPermissionMode(value: unknown): SpawnPermissionMode {
  const normalized = asTrimmedString(value).toLowerCase();
  if (normalized === "plan" || normalized === "edit" || normalized === "full-auto" || normalized === "config-toml") return normalized;
  return "default";
}

function normalizeToolWhitelist(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((entry) => asTrimmedString(entry)).filter(Boolean))].slice(0, 24);
}

function resolveSpawnContextFile(args: {
  runtime: AdeRuntime;
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
  const docsList = Array.isArray(args.context.docs) ? args.context.docs : [];
  const hasContextPayload = docsList.length > 0 || Object.keys(args.context).length > 0;
  const approxTokens = 0;

  if (!contextFilePathRaw && !hasContextPayload) {
    return { contextFilePath: null, contextDigest: null, contextBytes: null, approxTokens };
  }

  if (contextFilePathRaw.length) {
    if (path.isAbsolute(contextFilePathRaw)) {
      throw new JsonRpcError(JsonRpcErrorCode.invalidParams, "contextFilePath must be a relative path within the project directory");
    }
    let abs: string;
    try {
      abs = resolvePathWithinRoot(args.runtime.projectRoot, path.resolve(args.runtime.projectRoot, contextFilePathRaw));
    } catch {
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

  const baseDir = resolveAdeLayout(args.runtime.projectRoot).agentContextDir;
  const runSegment = args.runId ?? "standalone";
  const dir = path.join(baseDir, runSegment);
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${randomUUID()}.json`;
  const contextFilePath = path.join(dir, filename);
  const payload = {
    schema: "ade.agent.spawnContext.v1",
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
  callerId: string | null;
  role: SessionIdentity["role"] | null;
  chatSessionId: string | null;
  standaloneChatSession: boolean;
  missionId: string | null;
  runId: string | null;
  stepId: string | null;
  attemptId: string | null;
  ownerId: string | null;
};

function resolveEnvCallerContext(): CallerContext {
  const envRoleRaw = process.env.ADE_DEFAULT_ROLE?.trim() ?? "";
  const envRole: SessionIdentity["role"] | null =
    envRoleRaw === "cto"
    || envRoleRaw === "orchestrator"
    || envRoleRaw === "agent"
    || envRoleRaw === "external"
    || envRoleRaw === "evaluator"
      ? envRoleRaw
      : null;
  const envChatSessionId = process.env.ADE_CHAT_SESSION_ID?.trim() || null;
  const envMissionId = process.env.ADE_MISSION_ID?.trim() || null;
  const envRunId = process.env.ADE_RUN_ID?.trim() || null;
  const envStepId = process.env.ADE_STEP_ID?.trim() || null;
  const envAttemptId = process.env.ADE_ATTEMPT_ID?.trim() || null;
  return {
    callerId: envChatSessionId ?? envAttemptId ?? null,
    role: envRole,
    chatSessionId: envChatSessionId,
    standaloneChatSession: Boolean(envChatSessionId) && !envMissionId && !envRunId && !envStepId && !envAttemptId,
    missionId: envMissionId,
    runId: envRunId,
    stepId: envStepId,
    attemptId: envAttemptId,
    ownerId: process.env.ADE_OWNER_ID?.trim() || null,
  };
}

function resolveCallerContext(session?: SessionState): CallerContext {
  const envContext = resolveEnvCallerContext();
  if (!session) return envContext;
  return {
    callerId: asOptionalTrimmedString(session.identity.callerId),
    role: session.identity.role ?? envContext.role,
    chatSessionId: envContext.chatSessionId,
    standaloneChatSession: session.identity.standaloneChatSession,
    missionId: session.identity.missionId ?? envContext.missionId,
    runId: envContext.runId,
    stepId: session.identity.stepId ?? envContext.stepId,
    attemptId: session.identity.attemptId ?? envContext.attemptId,
    ownerId: session.identity.ownerId ?? envContext.ownerId,
  };
}

function resolveWorkerAgentOwnerId(identityKey: unknown): string | null {
  const trimmed = typeof identityKey === "string" ? identityKey.trim() : "";
  if (!trimmed || trimmed === "cto") return null;
  const match = /^agent:(.+)$/.exec(trimmed);
  return match?.[1]?.trim() || null;
}

async function resolveEffectiveCallerContext(
  runtime: AdeRuntime,
  session?: SessionState,
): Promise<CallerContext> {
  const callerCtx = { ...resolveCallerContext(session) };

  if (!callerCtx.missionId && callerCtx.runId) {
    callerCtx.missionId = resolveMissionIdForRun(runtime, callerCtx.runId);
  }

  if (!callerCtx.ownerId && callerCtx.chatSessionId && runtime.agentChatService?.getSessionSummary) {
    try {
      const summary = await runtime.agentChatService.getSessionSummary(callerCtx.chatSessionId);
      callerCtx.ownerId = resolveWorkerAgentOwnerId(summary?.identityKey);
    } catch {
      // Fall back to initialize/env identity when chat summaries are unavailable.
    }
  }

  return callerCtx;
}

function isStandaloneChatCaller(callerCtx: CallerContext): boolean {
  return callerCtx.standaloneChatSession;
}

function isToolHiddenForStandaloneChat(name: string, callerCtx: CallerContext): boolean {
  return isStandaloneChatCaller(callerCtx) && STANDALONE_CHAT_HIDDEN_TOOL_NAMES.has(name);
}

function canCallerAccessCoordinatorTool(name: string, callerCtx: CallerContext): boolean {
  if (!COORDINATOR_TOOL_NAMES.has(name)) return true;
  if (isToolHiddenForStandaloneChat(name, callerCtx)) return false;
  if (callerCtx.role === "orchestrator") return true;
  if (callerCtx.role === "agent" && AGENT_VISIBLE_COORDINATOR_TOOL_NAMES.has(name)) return true;
  if (
    AGENT_VISIBLE_COORDINATOR_TOOL_NAMES.has(name)
    && (callerCtx.attemptId || callerCtx.stepId || callerCtx.runId || callerCtx.missionId)
  ) {
    return true;
  }
  return false;
}

function isLocalComputerUseAllowed(callerCtx: CallerContext): boolean {
  return callerCtx.role === "cto"
    || callerCtx.role === "orchestrator"
    || callerCtx.role === "agent";
}

async function listToolSpecsForSession(runtime: AdeRuntime, session: SessionState): Promise<ToolSpec[]> {
  const callerCtx = await resolveEffectiveCallerContext(runtime, session);
  const externalComputerUseAvailable = runtime.computerUseArtifactBrokerService
    ?.getBackendStatus()
    ?.backends.some((backend) => backend.available) ?? false;
  const localComputerUseAllowed = isLocalComputerUseAllowed(callerCtx);
  const shouldHideLocalComputerUse = !localComputerUseAllowed || externalComputerUseAvailable;
  const visibleBaseTools = shouldHideLocalComputerUse
    ? TOOL_SPECS.filter((tool) => !LOCAL_COMPUTER_USE_TOOL_NAMES.has(tool.name))
    : TOOL_SPECS;
  const visibleCoordinatorTools = shouldHideLocalComputerUse
    ? COORDINATOR_TOOL_SPECS.filter((tool) => !LOCAL_COMPUTER_USE_TOOL_NAMES.has(tool.name))
    : COORDINATOR_TOOL_SPECS;
  const allVisibleTools = (() => {
    if (callerCtx.role === "external" || !callerCtx.role) {
      return visibleBaseTools;
    }
    if (callerCtx.role === "agent") {
      return [...visibleBaseTools, ...AGENT_VISIBLE_COORDINATOR_TOOL_SPECS];
    }
    if (callerCtx.role === "cto") {
      return [...visibleBaseTools, ...CTO_OPERATOR_TOOL_SPECS, ...CTO_LINEAR_SYNC_TOOL_SPECS];
    }
    return [...visibleBaseTools, ...visibleCoordinatorTools];
  })();

  return allVisibleTools.filter((tool) => !isToolHiddenForStandaloneChat(tool.name, callerCtx));
}

function parseInitializeIdentity(runtime: AdeRuntime, params: unknown): SessionIdentity {
  const data = safeObject(params);
  const identity = safeObject(data.identity);
  const envContext = resolveEnvCallerContext();
  const identityRole = asOptionalTrimmedString(identity.role);
  const parsedIdentityRole: SessionIdentity["role"] | null =
    identityRole === "cto" || identityRole === "orchestrator" || identityRole === "agent" || identityRole === "external" || identityRole === "evaluator"
      ? identityRole
      : null;
  const validRole: SessionIdentity["role"] = envContext.role ?? "external";
  const resolvedRunId = envContext.runId;
  const requestedMissionId = asOptionalTrimmedString(identity.missionId);
  const resolvedMissionId =
    envContext.missionId
    ?? (resolvedRunId ? resolveMissionIdForRun(runtime, resolvedRunId) : null);
  if (requestedMissionId && resolvedMissionId && requestedMissionId !== resolvedMissionId) {
    throw new JsonRpcError(
      JsonRpcErrorCode.invalidParams,
      "identity.missionId does not match the server-authorized run context",
    );
  }

  const standaloneChatSession = Boolean(envContext.chatSessionId)
    && !envContext.missionId
    && !envContext.runId
    && !envContext.stepId
    && !envContext.attemptId;

  return {
    callerId: asOptionalTrimmedString(identity.callerId) ?? envContext.chatSessionId ?? envContext.attemptId ?? "unknown",
    role: validRole,
    chatSessionId: envContext.chatSessionId,
    standaloneChatSession,
    missionId: resolvedMissionId ?? requestedMissionId ?? null,
    runId: resolvedRunId,
    stepId: asOptionalTrimmedString(identity.stepId) ?? envContext.stepId,
    attemptId: asOptionalTrimmedString(identity.attemptId) ?? envContext.attemptId,
    ownerId: asOptionalTrimmedString(identity.ownerId) ?? envContext.ownerId,
  };
}

function parseAdeResourceUri(uriRaw: string): { path: string[] } {
  const trimmed = uriRaw.trim();
  if (!trimmed.startsWith("ade://")) {
    throw new JsonRpcError(JsonRpcErrorCode.invalidParams, `Unsupported resource URI: ${uriRaw}`);
  }
  const body = trimmed.slice("ade://".length);
  const pathParts = body.split("/").map((part) => decodeURIComponent(part));
  return { path: pathParts.filter((part) => part.length > 0) };
}

function resourceListFromLanes(lanes: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const resources: Array<Record<string, unknown>> = [];

  for (const lane of lanes) {
    const laneId = asTrimmedString(lane.id);
    const laneName = asTrimmedString(lane.name) || laneId;
    if (!laneId) continue;

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

function buildResourceList(args: {
  lanes: Array<Record<string, unknown>>;
}): Array<Record<string, unknown>> {
  return resourceListFromLanes(args.lanes);
}

async function waitForTestRunCompletion(args: {
  runtime: AdeRuntime;
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
  runtime: AdeRuntime;
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

async function buildLaneStatus(runtime: AdeRuntime, laneId: string): Promise<Record<string, unknown>> {
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
  tools: Record<string, ExecutableTool>;
};

const coordinatorToolCacheByRuntime = new WeakMap<AdeRuntime, Map<string, CoordinatorToolCacheEntry>>();

function resolveMissionIdForRun(runtime: AdeRuntime, runId: string): string | null {
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

function resolveRunIdForMission(runtime: AdeRuntime, missionId: string): string | null {
  const row = runtime.db.get<{ id: string | null }>(
    `
      select id
      from orchestrator_runs
      where mission_id = ?
      order by
        case status
          when 'active' then 0
          when 'bootstrapping' then 1
          when 'queued' then 2
          when 'paused' then 3
          else 4
        end,
        datetime(updated_at) desc,
        datetime(created_at) desc
      limit 1
    `,
    [missionId]
  );
  return asOptionalTrimmedString(row?.id);
}

function getCoordinatorToolSet(args: {
  runtime: AdeRuntime;
  runId: string;
  missionId: string;
}): Record<string, ExecutableTool> {
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
    workspaceRoot: (() => {
      const laneWorkspaceRoot = resolveLaneWorktreePath(args.runtime, missionLaneId);
      if (missionLaneId && !laneWorkspaceRoot) {
        throw new JsonRpcError(
          JsonRpcErrorCode.invalidParams,
          `Mission lane '${missionLaneId}' does not have an available worktree.`,
        );
      }
      return laneWorkspaceRoot
        ?? (typeof args.runtime.workspaceRoot === "string" && args.runtime.workspaceRoot.trim().length > 0
          ? args.runtime.workspaceRoot.trim()
          : args.runtime.projectRoot);
    })(),
    missionLaneId: missionLaneId ?? undefined,
    onRunFinalize: ({ runId }) => {
      args.runtime.aiOrchestratorService.finalizeRun({ runId, force: true });
    },
    onDagMutation: (event) => {
      args.runtime.eventBuffer.push({
        timestamp: nowIso(),
        category: "dag_mutation",
        payload: event as unknown as Record<string, unknown>
      });
    }
  });
  const normalizedToolSet = toolSet as unknown as Record<string, CoordinatorExecutableTool>;
  runtimeCache.set(args.runId, {
    missionId: args.missionId,
    tools: normalizedToolSet
  });
  return normalizedToolSet;
}

type NativeCallerRegistration = {
  memberId: string;
  parentWorkerId: string;
  parentStepId: string;
  sourceAttemptId: string;
};

function getTeamRuntimeContext(runtime: AdeRuntime): import("../../desktop/src/main/services/orchestrator/orchestratorContext").OrchestratorContext {
  return {
    db: runtime.db,
    logger: runtime.logger,
  } as import("../../desktop/src/main/services/orchestrator/orchestratorContext").OrchestratorContext;
}

function getRunGraphSafe(runtime: AdeRuntime, runId: string): Record<string, unknown> | null {
  try {
    return runtime.orchestratorService.getRunGraph({ runId, timelineLimit: 0 }) as unknown as Record<string, unknown>;
  } catch {
    return null;
  }
}

function getTeamMembersForRunSafe(runtime: AdeRuntime, runId: string): Array<Record<string, unknown>> {
  const aiService = runtime.aiOrchestratorService as unknown as { getTeamMembers?: (args: { runId: string }) => unknown };
  if (typeof aiService.getTeamMembers === "function") {
    try {
      const members = aiService.getTeamMembers({ runId });
      if (Array.isArray(members)) return members as Array<Record<string, unknown>>;
    } catch {
      // Fall through to DB-backed path.
    }
  }
  return getTeamMembersForRun(getTeamRuntimeContext(runtime), runId) as unknown as Array<Record<string, unknown>>;
}

function resolveStepFromGraph(graph: Record<string, unknown>, stepId: string | null, stepKey: string | null): Record<string, unknown> | null {
  const steps = Array.isArray(graph.steps) ? (graph.steps as Array<Record<string, unknown>>) : [];
  if (stepId) {
    const byId = steps.find((step) => asOptionalTrimmedString(step.id) === stepId);
    if (byId) return byId;
  }
  if (stepKey) {
    const byKey = steps.find((step) => asOptionalTrimmedString(step.stepKey) === stepKey);
    if (byKey) return byKey;
  }
  return null;
}

function titleCaseWords(raw: string): string {
  return raw
    .split(/[\s_-]+/)
    .map((token) => token ? `${token.charAt(0).toUpperCase()}${token.slice(1).toLowerCase()}` : "")
    .join(" ")
    .trim();
}

function deriveQuestionOwnerFromPhase(args: {
  phaseKey?: string | null;
  phaseName?: string | null;
}): { ownerKind: string; ownerLabel: string } {
  const normalizedPhaseKey = asOptionalTrimmedString(args.phaseKey)?.toLowerCase() ?? "";
  const normalizedPhaseName = asOptionalTrimmedString(args.phaseName)?.toLowerCase() ?? "";
  const normalized = normalizedPhaseKey || normalizedPhaseName;
  if (normalized === "planning") {
    return { ownerKind: "planner", ownerLabel: "Planner question" };
  }
  if (normalized === "development") {
    return { ownerKind: "developer", ownerLabel: "Developer question" };
  }
  if (normalized === "validation") {
    return { ownerKind: "validator", ownerLabel: "Validator question" };
  }
  if (normalized === "testing") {
    return { ownerKind: "tester", ownerLabel: "Tester question" };
  }
  const humanPhase = asOptionalTrimmedString(args.phaseName) ?? asOptionalTrimmedString(args.phaseKey);
  if (humanPhase) {
    return {
      ownerKind: normalized || "phase_worker",
      ownerLabel: `${titleCaseWords(humanPhase)} question`,
    };
  }
  return { ownerKind: "worker", ownerLabel: "Worker question" };
}

function getAgentAskUserPolicy(args: {
  runtime: AdeRuntime;
  callerCtx: CallerContext;
}): {
  stepId: string | null;
  stepKey: string | null;
  phase: string | null;
  phaseName: string | null;
  enabled: boolean;
  maxQuestions: number | null;
  ownerKind: string;
  ownerLabel: string;
  existingQuestions: number;
} | null {
  if (args.callerCtx.role !== "agent" || !args.callerCtx.runId) return null;
  const graph = getRunGraphSafe(args.runtime, args.callerCtx.runId);
  if (!graph) return null;

  const inferredWorkerId = inferWorkerIdFromCaller(graph, args.callerCtx);
  const step = resolveStepFromGraph(graph, args.callerCtx.stepId, inferredWorkerId);
  if (!step) return null;

  const metadata = safeObject(step.metadata);
  const phase = asOptionalTrimmedString(metadata.phaseKey);
  const phaseName = asOptionalTrimmedString(metadata.phaseName);
  const phaseAskQuestions = safeObject(metadata.phaseAskQuestions);
  const defaultEnabled = (phase?.toLowerCase() ?? phaseName?.toLowerCase() ?? "") === "planning";
  const enabled = typeof phaseAskQuestions.enabled === "boolean"
    ? phaseAskQuestions.enabled
    : defaultEnabled;
  const rawMaxQuestions = Number(phaseAskQuestions.maxQuestions ?? Number.NaN);
  const maxQuestions = enabled
    ? Number.isFinite(rawMaxQuestions)
      ? Math.max(1, Math.min(10, Math.floor(rawMaxQuestions)))
      : 5
    : null;
  const mission = args.callerCtx.missionId ? args.runtime.missionService.get(args.callerCtx.missionId) : null;
  const stepId = asOptionalTrimmedString(step.id);
  const stepKey = asOptionalTrimmedString(step.stepKey);
  const existingQuestions = (mission?.interventions ?? []).filter((entry) => {
    if (entry.interventionType !== "manual_input") return false;
    const metadata = safeObject(entry.metadata);
    if (asOptionalTrimmedString(metadata.source) !== "ask_user") return false;
    if (asOptionalTrimmedString(metadata.runId) !== args.callerCtx.runId) return false;
    const entryStepId = asOptionalTrimmedString(metadata.stepId);
    const entryStepKey = asOptionalTrimmedString(metadata.stepKey);
    if (stepId && entryStepId === stepId) return true;
    if (stepKey && entryStepKey === stepKey) return true;
    const entryPhase = asOptionalTrimmedString(metadata.phase)?.toLowerCase() ?? "";
    const normalizedPhase = (phase ?? phaseName ?? "").toLowerCase();
    return normalizedPhase.length > 0 && entryPhase === normalizedPhase;
  }).length ?? 0;

  const owner = deriveQuestionOwnerFromPhase({ phaseKey: phase, phaseName });
  return {
    stepId,
    stepKey,
    phase,
    phaseName,
    enabled,
    maxQuestions,
    ownerKind: owner.ownerKind,
    ownerLabel: owner.ownerLabel,
    existingQuestions,
  };
}

function inferWorkerIdFromCaller(graph: Record<string, unknown>, callerCtx: CallerContext): string | null {
  const directStep = resolveStepFromGraph(graph, callerCtx.stepId, null);
  const directKey = asOptionalTrimmedString(directStep?.stepKey);
  if (directKey) return directKey;

  const attempts = Array.isArray(graph.attempts) ? (graph.attempts as Array<Record<string, unknown>>) : [];
  const attemptId = asOptionalTrimmedString(callerCtx.attemptId) ?? asOptionalTrimmedString(callerCtx.callerId);
  if (!attemptId) return null;
  const attempt = attempts.find((entry) => asOptionalTrimmedString(entry.id) === attemptId);
  const stepId = asOptionalTrimmedString(attempt?.stepId);
  if (!stepId) return null;
  const step = resolveStepFromGraph(graph, stepId, null);
  return asOptionalTrimmedString(step?.stepKey);
}

function normalizeWorkerOutcome(raw: unknown): "succeeded" | "failed" | "partial" {
  const normalized = asOptionalTrimmedString(raw)?.toLowerCase() ?? "";
  if (normalized === "succeeded" || normalized === "success" || normalized === "pass" || normalized === "passed" || normalized === "done" || normalized === "completed") {
    return "succeeded";
  }
  if (normalized === "failed" || normalized === "fail" || normalized === "error") {
    return "failed";
  }
  return "partial";
}

function summarizeLegacyTestsRun(entries: unknown): Record<string, number> | null {
  if (!Array.isArray(entries)) return null;
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const entry of entries) {
    const result = asOptionalTrimmedString(safeObject(entry).result)?.toLowerCase() ?? "";
    if (result === "pass" || result === "passed" || result === "success" || result === "succeeded") {
      passed += 1;
    } else if (result === "fail" || result === "failed" || result === "error") {
      failed += 1;
    } else {
      skipped += 1;
    }
  }
  return { passed, failed, skipped };
}

function normalizeCoordinatorWorkerToolArgs(args: {
  name: string;
  toolArgs: Record<string, unknown>;
  callerCtx: CallerContext;
  graph: Record<string, unknown> | null;
}): Record<string, unknown> {
  const normalized = { ...args.toolArgs };
  const inferredWorkerId = args.graph ? inferWorkerIdFromCaller(args.graph, args.callerCtx) : null;
  const stepKeyAlias = asOptionalTrimmedString(normalized.stepKey);
  const explicitWorkerId = asOptionalTrimmedString(normalized.workerId);

  if (!explicitWorkerId && stepKeyAlias) {
    normalized.workerId = stepKeyAlias;
  } else if (!explicitWorkerId && inferredWorkerId) {
    normalized.workerId = inferredWorkerId;
  }

  if (args.name === "report_status") {
    const summary = asOptionalTrimmedString(normalized.summary);
    if (!asOptionalTrimmedString(normalized.nextAction) && summary) {
      normalized.nextAction = summary;
    }
    if (!asOptionalTrimmedString(normalized.details) && summary) {
      normalized.details = summary;
    }
    if (!Array.isArray(normalized.blockers) && typeof normalized.blockers === "string") {
      normalized.blockers = [normalized.blockers];
    }
    const rawProgress = Number(normalized.progressPct ?? Number.NaN);
    if (!Number.isFinite(rawProgress)) {
      const status = asOptionalTrimmedString(normalized.status)?.toLowerCase() ?? "";
      if (status === "succeeded" || status === "success" || status === "completed" || status === "done") {
        normalized.progressPct = 100;
      } else if (status === "running" || status === "working" || status === "in_progress" || status === "in-progress") {
        normalized.progressPct = 50;
      } else if (status === "blocked" || status === "waiting") {
        normalized.progressPct = 25;
      } else {
        normalized.progressPct = 0;
      }
    }
  } else if (args.name === "report_result") {
    normalized.outcome = normalizeWorkerOutcome(normalized.outcome);
    const summarizedTests = summarizeLegacyTestsRun(normalized.testsRun);
    if (summarizedTests) {
      normalized.testsRun = summarizedTests;
    }
  } else if (args.name === "report_validation") {
    if (!asOptionalTrimmedString(normalized.validatorWorkerId) && inferredWorkerId) {
      normalized.validatorWorkerId = inferredWorkerId;
    }
    if (!Array.isArray(normalized.findings)) {
      normalized.findings = [];
    }
    if (!Array.isArray(normalized.remediationInstructions)) {
      const notes = Array.isArray(normalized.notes)
        ? normalized.notes.map((entry) => String(entry ?? "").trim()).filter((entry) => entry.length > 0)
        : [];
      normalized.remediationInstructions = notes;
    }
  }

  return normalized;
}

function normalizeAgentDelegationToolArgs(args: {
  name: string;
  toolArgs: Record<string, unknown>;
  callerCtx: CallerContext;
  graph: Record<string, unknown> | null;
}): Record<string, unknown> {
  const normalized = { ...args.toolArgs };
  if (args.callerCtx.role !== "agent") return normalized;
  if (args.name !== "delegate_to_subagent" && args.name !== "delegate_parallel") return normalized;
  if (!args.graph) {
    throw new JsonRpcError(
      JsonRpcErrorCode.invalidParams,
      `Agent caller cannot use '${args.name}' without an active run graph.`
    );
  }

  const ownedWorkerId = inferWorkerIdFromCaller(args.graph, args.callerCtx);
  if (!ownedWorkerId) {
    throw new JsonRpcError(
      JsonRpcErrorCode.invalidParams,
      `Agent caller cannot use '${args.name}' without an active parent worker context.`
    );
  }

  const requestedParentWorkerId = asOptionalTrimmedString(normalized.parentWorkerId);
  if (requestedParentWorkerId && requestedParentWorkerId !== ownedWorkerId) {
    throw new JsonRpcError(
      JsonRpcErrorCode.invalidParams,
      `Agent caller may only delegate beneath its own worker '${ownedWorkerId}'.`
    );
  }

  normalized.parentWorkerId = ownedWorkerId;
  return normalized;
}

function resolveParentAttemptIdFromGraph(graph: Record<string, unknown>, parentWorkerId: string): string | null {
  const steps = Array.isArray(graph.steps) ? (graph.steps as Array<Record<string, unknown>>) : [];
  const attempts = Array.isArray(graph.attempts) ? (graph.attempts as Array<Record<string, unknown>>) : [];
  const parentStep = steps.find((step) => asOptionalTrimmedString(step.stepKey) === parentWorkerId);
  const parentStepId = asOptionalTrimmedString(parentStep?.id);
  if (!parentStepId) return null;
  const parentAttempts = attempts.filter((attempt) => asOptionalTrimmedString(attempt.stepId) === parentStepId);
  if (!parentAttempts.length) return null;
  const running = parentAttempts.find((attempt) => asOptionalTrimmedString(attempt.status) === "running");
  if (running) return asOptionalTrimmedString(running.id);
  const sorted = [...parentAttempts].sort((left, right) => {
    const leftTs = Date.parse(asOptionalTrimmedString(left.completedAt) ?? asOptionalTrimmedString(left.createdAt) ?? "");
    const rightTs = Date.parse(asOptionalTrimmedString(right.completedAt) ?? asOptionalTrimmedString(right.createdAt) ?? "");
    return (Number.isFinite(rightTs) ? rightTs : 0) - (Number.isFinite(leftTs) ? leftTs : 0);
  });
  return asOptionalTrimmedString(sorted[0]?.id);
}

function inferParallelismCap(graph: Record<string, unknown>): number {
  const run = safeObject(graph.run);
  const runMetadata = safeObject(run.metadata);
  const autopilot = safeObject(runMetadata.autopilot);
  const raw = Number(autopilot.parallelismCap ?? runMetadata.maxParallelWorkers ?? Number.NaN);
  if (Number.isFinite(raw) && raw > 0) {
    return Math.max(1, Math.min(32, Math.floor(raw)));
  }
  return 4;
}

function ensureNativeTeammateRegistration(args: {
  runtime: AdeRuntime;
  runId: string;
  missionId: string;
  callerCtx: CallerContext;
  toolName: string;
  toolArgs: Record<string, unknown>;
}): NativeCallerRegistration | null {
  if (args.toolName !== "report_status" && args.toolName !== "report_result") return null;
  if (args.callerCtx.role !== "agent") return null;
  const graph = getRunGraphSafe(args.runtime, args.runId);
  if (!graph) return null;

  const callerId = asOptionalTrimmedString(args.callerCtx.callerId) ?? asOptionalTrimmedString(args.callerCtx.attemptId);
  if (!callerId || callerId === "unknown") return null;

  const attempts = Array.isArray(graph.attempts) ? (graph.attempts as Array<Record<string, unknown>>) : [];
  const steps = Array.isArray(graph.steps) ? (graph.steps as Array<Record<string, unknown>>) : [];
  const knownAttemptIds = new Set(
    attempts
      .map((attempt) => asOptionalTrimmedString(attempt.id))
      .filter((entry): entry is string => Boolean(entry))
  );
  const knownStepKeys = new Set(
    steps
      .map((step) => asOptionalTrimmedString(step.stepKey))
      .filter((entry): entry is string => Boolean(entry))
  );
  const existingMembers = getTeamMembersForRunSafe(args.runtime, args.runId);
  const knownTeamMemberIds = new Set(
    existingMembers
      .map((member) => asOptionalTrimmedString(member.id))
      .filter((entry): entry is string => Boolean(entry))
  );
  if (knownAttemptIds.has(callerId) || knownStepKeys.has(callerId) || knownTeamMemberIds.has(callerId)) {
    return null;
  }

  let parentStep: Record<string, unknown> | null = null;
  if (args.callerCtx.stepId) {
    parentStep = resolveStepFromGraph(graph, args.callerCtx.stepId, null);
  }
  if (!parentStep && args.callerCtx.attemptId) {
    const parentAttempt = attempts.find((attempt) => asOptionalTrimmedString(attempt.id) === args.callerCtx.attemptId);
    const parentStepId = asOptionalTrimmedString(parentAttempt?.stepId);
    if (parentStepId) {
      parentStep = resolveStepFromGraph(graph, parentStepId, null);
    }
  }
  if (!parentStep) {
    const fallbackWorkerId = asOptionalTrimmedString(args.toolArgs.workerId);
    if (fallbackWorkerId) {
      parentStep = resolveStepFromGraph(graph, null, fallbackWorkerId);
    }
  }
  if (!parentStep) return null;

  const parentWorkerId = asOptionalTrimmedString(parentStep.stepKey);
  const parentStepId = asOptionalTrimmedString(parentStep.id);
  if (!parentWorkerId || !parentStepId) return null;

  const nativeMemberId = `claude-native:${args.runId}:${createHash("sha1").update(callerId).digest("hex").slice(0, 16)}`;
  const existing = existingMembers.find((member) => asOptionalTrimmedString(member.id) === nativeMemberId) ?? null;
  const cap = inferParallelismCap(graph);
  const activeForParent = existingMembers.filter((member) => {
    const metadata = safeObject(member.metadata);
    const source = asOptionalTrimmedString(member.source) ?? asOptionalTrimmedString(metadata.source);
    const memberParent = asOptionalTrimmedString(member.parentWorkerId) ?? asOptionalTrimmedString(metadata.parentWorkerId);
    const status = asOptionalTrimmedString(member.status) ?? "unknown";
    return source === "claude-native"
      && memberParent === parentWorkerId
      && status !== "terminated"
      && status !== "failed";
  }).length;
  if (!existing && activeForParent >= cap) {
    throw new JsonRpcError(
      JsonRpcErrorCode.invalidParams,
      `Native teammate allocation cap exceeded for parent '${parentWorkerId}' (${activeForParent}/${cap}).`
    );
  }

  const parentMetadata = safeObject(parentStep.metadata);
  const inferredModel = asOptionalTrimmedString(parentMetadata.modelId) ?? "claude-native";
  const now = nowIso();
  if (existing) {
    updateTeamMemberStatus(getTeamRuntimeContext(args.runtime), nativeMemberId, {
      status: "active"
    });
  } else {
    registerTeamMember(getTeamRuntimeContext(args.runtime), {
      id: nativeMemberId,
      runId: args.runId,
      missionId: args.missionId,
      provider: "claude",
      model: inferredModel,
      role: "teammate",
      source: "claude-native",
      parentWorkerId,
      sessionId: null,
      status: "active",
      claimedTaskIds: [],
      metadata: {
        source: "claude-native",
        parentWorkerId,
        parentStepId,
        parentAttemptId: args.callerCtx.attemptId ?? null,
        nativeCallerId: callerId,
      },
      createdAt: now,
      updatedAt: now,
    });
  }

  if (!asOptionalTrimmedString(args.toolArgs.workerId)) {
    args.toolArgs.workerId = parentWorkerId;
  }

  return {
    memberId: nativeMemberId,
    parentWorkerId,
    parentStepId,
    sourceAttemptId: nativeMemberId,
  };
}

async function maybeSendInterAgentMessage(args: {
  runtime: AdeRuntime;
  missionId: string;
  fromAttemptId: string;
  toAttemptId: string;
  content: string;
  metadata: Record<string, unknown>;
}): Promise<void> {
  const sender = (args.runtime.aiOrchestratorService as unknown as {
    sendAgentMessage?: (msg: {
      missionId: string;
      fromAttemptId: string;
      toAttemptId: string;
      content: string;
      metadata?: Record<string, unknown> | null;
    }) => unknown;
  }).sendAgentMessage;
  if (typeof sender !== "function") return;
  await Promise.resolve(sender({
    missionId: args.missionId,
    fromAttemptId: args.fromAttemptId,
    toAttemptId: args.toAttemptId,
    content: args.content,
    metadata: args.metadata,
  }));
}

async function postProcessCoordinatorToolResult(args: {
  runtime: AdeRuntime;
  toolName: string;
  runId: string;
  missionId: string;
  callerCtx: CallerContext;
  result: Record<string, unknown>;
  nativeRegistration: NativeCallerRegistration | null;
}): Promise<void> {
  if (args.toolName === "report_status") {
    const report = safeObject(args.result.report);
    const workerId = asOptionalTrimmedString(report.workerId);
    const stepId = asOptionalTrimmedString(report.stepId);
    const progressPct = Number(report.progressPct ?? Number.NaN);
    const nextAction = asOptionalTrimmedString(report.nextAction) ?? "status update";
    const blockers = Array.isArray(report.blockers)
      ? report.blockers.map((entry) => String(entry ?? "").trim()).filter((entry) => entry.length > 0)
      : [];

    args.runtime.eventBuffer.push({
      timestamp: nowIso(),
      category: "runtime",
      payload: {
        type: "worker_status_reported",
        runId: args.runId,
        stepId,
        attemptId: args.callerCtx.attemptId ?? null,
        reason: "report_status",
        detail: report,
      }
    });

    const graph = getRunGraphSafe(args.runtime, args.runId);
    if (!graph) return;
    const step = resolveStepFromGraph(graph, stepId, workerId);
    const stepMetadata = safeObject(step?.metadata);
    const parentWorkerId =
      args.nativeRegistration?.parentWorkerId
      ?? asOptionalTrimmedString(stepMetadata.parentWorkerId);
    if (!parentWorkerId) return;
    const parentAttemptId = resolveParentAttemptIdFromGraph(graph, parentWorkerId);
    if (!parentAttemptId) return;
    const fromAttemptId =
      args.nativeRegistration?.sourceAttemptId
      ?? asOptionalTrimmedString(args.callerCtx.attemptId)
      ?? workerId;
    if (!fromAttemptId || fromAttemptId === parentAttemptId) return;

    const workerLabel = asOptionalTrimmedString(step?.title) ?? workerId ?? "sub-agent";
    const progressLabel = Number.isFinite(progressPct) ? `${Math.max(0, Math.min(100, Math.round(progressPct)))}%` : "progress";
    const blockerSuffix = blockers.length > 0 ? ` Blockers: ${blockers.join("; ")}` : "";
    const content = `[sub-agent:${workerLabel}] ${progressLabel} — ${nextAction}.${blockerSuffix}`;

    await maybeSendInterAgentMessage({
      runtime: args.runtime,
      missionId: args.missionId,
      fromAttemptId,
      toAttemptId: parentAttemptId,
      content,
      metadata: {
        source: "subagent_status_rollup",
        parentWorkerId,
        workerId: workerId ?? null,
        isNative: Boolean(args.nativeRegistration),
      },
    });
    return;
  }

  if (args.toolName === "report_result" && args.nativeRegistration) {
    const report = safeObject(args.result.report);
    const graph = getRunGraphSafe(args.runtime, args.runId);
    if (!graph) return;
    const parentAttemptId = resolveParentAttemptIdFromGraph(graph, args.nativeRegistration.parentWorkerId);
    if (!parentAttemptId) return;
    const outcome = asOptionalTrimmedString(report.outcome) ?? "completed";
    const summary = asOptionalTrimmedString(report.summary) ?? "No summary provided.";
    const content = `Sub-agent '${args.nativeRegistration.memberId}' completed (${outcome}): ${summary}`;
    await maybeSendInterAgentMessage({
      runtime: args.runtime,
      missionId: args.missionId,
      fromAttemptId: args.nativeRegistration.sourceAttemptId,
      toAttemptId: parentAttemptId,
      content,
      metadata: {
        source: "subagent_result_rollup",
        parentWorkerId: args.nativeRegistration.parentWorkerId,
        isNative: true,
      },
    });
  }
}

async function runCoordinatorTool(args: {
  runtime: AdeRuntime;
  name: string;
  toolArgs: Record<string, unknown>;
  callerCtx: CallerContext;
}): Promise<Record<string, unknown>> {
  const missionIdFromContext =
    args.callerCtx.missionId
    ?? asOptionalTrimmedString(args.toolArgs.missionId);
  const runId =
    args.callerCtx.runId
    ?? asOptionalTrimmedString(args.toolArgs.runId)
    ?? (missionIdFromContext ? resolveRunIdForMission(args.runtime, missionIdFromContext) : null);
  if (!runId) {
    throw new JsonRpcError(
      JsonRpcErrorCode.invalidParams,
      `Coordinator tool '${args.name}' requires run context. Provide runId or set ADE_RUN_ID.`
    );
  }
  const missionId =
    missionIdFromContext
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
  const graph = getRunGraphSafe(args.runtime, runId);
  const normalizedToolArgs =
    args.name === "report_status" || args.name === "report_result" || args.name === "report_validation"
      ? normalizeCoordinatorWorkerToolArgs({
          name: args.name,
          toolArgs: args.toolArgs,
          callerCtx: args.callerCtx,
          graph,
        })
      : { ...args.toolArgs };
  const effectiveToolArgs = normalizeAgentDelegationToolArgs({
    name: args.name,
    toolArgs: normalizedToolArgs,
    callerCtx: args.callerCtx,
    graph,
  });
  const nativeRegistration = ensureNativeTeammateRegistration({
    runtime: args.runtime,
    runId,
    missionId,
    callerCtx: args.callerCtx,
    toolName: args.name,
    toolArgs: effectiveToolArgs,
  });
  const output = await toolEntry.execute(effectiveToolArgs);
  if (isRecord(output)) {
    if (output.ok === true && (args.name === "report_status" || args.name === "report_result")) {
      await postProcessCoordinatorToolResult({
        runtime: args.runtime,
        toolName: args.name,
        runId,
        missionId,
        callerCtx: args.callerCtx,
        result: output,
        nativeRegistration,
      });
    }
    return output;
  }
  return {
    ok: true,
    result: output ?? null
  };
}


async function runTool(args: {
  runtime: AdeRuntime;
  session: SessionState;
  name: string;
  toolArgs: Record<string, unknown>;
}): Promise<unknown> {
  const { runtime, session, name, toolArgs } = args;
  const callerCtx = await resolveEffectiveCallerContext(runtime, session);
  if (isToolHiddenForStandaloneChat(name, callerCtx)) {
    throw new JsonRpcError(JsonRpcErrorCode.methodNotFound, `Unsupported tool: ${name}`);
  }
  const runLocalCommand = (
    command: string,
    commandArgs: string[],
    options?: { env?: NodeJS.ProcessEnv }
  ): { stdout: string; stderr: string } => {
    const result = spawnSync(command, commandArgs, {
      cwd: runtime.projectRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        ...(options?.env ?? {}),
      },
    });
    if (result.status !== 0) {
      throw new JsonRpcError(
        JsonRpcErrorCode.toolFailed,
        `${command} failed: ${(result.stderr || result.stdout || "unknown error").trim() || "unknown error"}`,
      );
    }
    return {
      stdout: typeof result.stdout === "string" ? result.stdout.trim() : "",
      stderr: typeof result.stderr === "string" ? result.stderr.trim() : "",
    };
  };
  const tryLocalCommand = (
    command: string,
    commandArgs: string[],
    options?: { env?: NodeJS.ProcessEnv }
  ): { stdout: string; stderr: string } | null => {
    try {
      return runLocalCommand(command, commandArgs, options);
    } catch {
      return null;
    }
  };
  const ensureLocalComputerUse = (
    toolName: string,
    capabilityKey: "screenshot" | "browser_verification" | "browser_trace" | "video_recording" | "console_logs" | "appLaunch" | "guiInteraction" | "environmentInfo",
  ) => {
    if (!isLocalComputerUseAllowed(callerCtx)) {
      throw new JsonRpcError(
        JsonRpcErrorCode.methodNotFound,
        `Unsupported tool: ${toolName}`,
      );
    }
    const capabilities = getLocalComputerUseCapabilities();
    const capability =
      capabilityKey === "appLaunch" || capabilityKey === "guiInteraction" || capabilityKey === "environmentInfo"
        ? capabilities[capabilityKey]
        : capabilities.proofRequirements[capabilityKey];
    if (!capability.available) {
      throw new JsonRpcError(JsonRpcErrorCode.toolFailed, `${toolName} is unavailable: ${capability.detail}`);
    }
    return capabilities;
  };
  const ingestLocalComputerUseArtifact = (args: {
    sessionState: SessionState;
    toolName: string;
    title: string;
    kind: "screenshot" | "video_recording";
    artifactPath: string;
    mimeType: string;
    metadata: Record<string, unknown>;
    toolArgs: Record<string, unknown>;
  }) => {
    const result = runtime.computerUseArtifactBrokerService.ingest({
      backend: {
        name: "screencapture",
        toolName: args.toolName,
      },
      inputs: [
        {
          kind: args.kind,
          title: args.title,
          path: args.artifactPath,
          mimeType: args.mimeType,
          metadata: {
            ...args.metadata,
          },
        },
      ],
      owners: resolveComputerUseOwners(args.sessionState, args.toolArgs),
    });
    return {
      artifact: {
        type: args.kind,
        title: args.title,
        uri: toProjectArtifactUri(runtime.projectRoot, args.artifactPath),
        metadata: args.metadata,
      },
      artifacts: result.artifacts,
      links: result.links,
    };
  };
  const activateApp = async (app: string): Promise<void> => {
    runLocalCommand("open", ["-a", app]);
    const capabilities = getLocalComputerUseCapabilities();
    if (capabilities.environmentInfo.available) {
      tryLocalCommand("osascript", ["-e", `tell application ${JSON.stringify(app)} to activate`]);
    }
    await sleep(250);
  };

  if (CTO_OPERATOR_TOOL_NAMES.has(name)) {
    if (callerCtx.role !== "cto") {
      throw new JsonRpcError(JsonRpcErrorCode.methodNotFound, `Unsupported tool: ${name}`);
    }
    if (name === "get_cto_state") {
      const recentLimit = Math.max(0, Math.min(50, Math.floor(asNumber(toolArgs.recentLimit, 10))));
      return runtime.ctoStateService.getSnapshot(recentLimit);
    }
    return await runCtoOperatorBridgeTool(runtime, session, name, toolArgs);
  }

  if (CTO_LINEAR_SYNC_TOOL_NAMES.has(name)) {
    if (callerCtx.role !== "cto") {
      throw new JsonRpcError(JsonRpcErrorCode.methodNotFound, `Unsupported tool: ${name}`);
    }

    if (name === "getLinearSyncDashboard") {
      return requireLinearSyncService(runtime).getDashboard();
    }

    if (name === "runLinearSyncNow") {
      return await requireLinearSyncService(runtime).runSyncNow();
    }

    if (name === "listLinearSyncQueue") {
      return requireLinearSyncService(runtime).listQueue({ limit: 300 });
    }

    if (name === "resolveLinearSyncQueueItem") {
      const action = assertNonEmptyString(toolArgs.action, "action");
      if (!new Set(["approve", "reject", "retry", "complete", "resume"]).has(action)) {
        throw new JsonRpcError(
          JsonRpcErrorCode.invalidParams,
          "action must be one of: approve, reject, retry, complete, resume",
        );
      }
      return await requireLinearSyncService(runtime).resolveQueueItem({
        queueItemId: assertNonEmptyString(toolArgs.queueItemId, "queueItemId"),
        action: action as "approve" | "reject" | "retry" | "complete" | "resume",
        note: asOptionalTrimmedString(toolArgs.note) ?? undefined,
        employeeOverride: asOptionalTrimmedString(toolArgs.employeeOverride) ?? undefined,
        laneId: asOptionalTrimmedString(toolArgs.laneId) ?? undefined,
      });
    }

    if (name === "getLinearWorkflowRunDetail") {
      const runId = assertNonEmptyString(toolArgs.runId, "runId");
      return await requireLinearSyncService(runtime).getRunDetail({ runId });
    }

    if (name === "getLinearIngressStatus") {
      return requireLinearIngressService(runtime).getStatus();
    }

    if (name === "listLinearIngressEvents") {
      return requireLinearIngressService(runtime).listRecentEvents(asNumber(toolArgs.limit, 20) ?? 20);
    }

    if (name === "ensureLinearWebhook") {
      const ingress = requireLinearIngressService(runtime);
      await ingress.ensureRelayWebhook(asBoolean(toolArgs.force, false));
      return ingress.getStatus();
    }

    if (name === "getFlowPolicy") {
      return requireFlowPolicyService(runtime).getPolicy();
    }

    if (name === "saveFlowPolicy") {
      const policy = safeObject(toolArgs.policy) as unknown as LinearWorkflowConfig;
      return requireFlowPolicyService(runtime).savePolicy(policy, asOptionalTrimmedString(toolArgs.actor) ?? "user");
    }

    if (name === "simulateFlowRoute") {
      const issue = safeObject(toolArgs.issue);
      return requireLinearRoutingService(runtime).simulateRoute({ issue: issue as any });
    }

    throw new JsonRpcError(JsonRpcErrorCode.methodNotFound, `Unsupported tool: ${name}`);
  }

  if (COORDINATOR_TOOL_NAMES.has(name)) {
    if (!canCallerAccessCoordinatorTool(name, callerCtx)) {
      throw new JsonRpcError(JsonRpcErrorCode.methodNotFound, `Unsupported tool: ${name}`);
    }
    return await runCoordinatorTool({ runtime, name, toolArgs, callerCtx });
  }

  if (name === "list_ade_actions") {
    const domain = asOptionalTrimmedString(toolArgs.domain) ?? "all";
    const services = getAdeActionDomainServices(runtime);
    const domains = domain === "all"
      ? (Object.keys(services) as AdeActionDomain[])
      : [domain as AdeActionDomain];
    const callerIsCto = callerHasRoleAtLeast(callerCtx.role, "cto");
    const actions = domains.flatMap((entry) => {
      const service = services[entry];
      if (!service) return [];
      return listAllowedAdeActionNames(entry, service)
        .filter((action) => callerIsCto || !isCtoOnlyAdeAction(entry, action))
        .map((action) => ({
          domain: entry,
          action,
          name: `${entry}.${action}`,
          usage: `ade actions run ${entry}.${action} --input-json '{"key":"value"}' (or --scalar value / --args-list-json '[...]' for scalar or positional service methods)`,
        }));
    });
    return {
      count: actions.length,
      actions,
    };
  }

  if (name === "run_ade_action") {
    const domain = assertNonEmptyString(toolArgs.domain, "domain") as AdeActionDomain;
    const action = assertNonEmptyString(toolArgs.action, "action");
    const services = getAdeActionDomainServices(runtime);
    const service = services[domain];
    if (!service) {
      throw new JsonRpcError(JsonRpcErrorCode.invalidParams, `Domain '${domain}' is unavailable in this runtime.`);
    }
    const callable = service[action];
    if (typeof callable !== "function") {
      throw new JsonRpcError(JsonRpcErrorCode.invalidParams, `Action '${domain}.${action}' is not callable.`);
    }
    if (!isAllowedAdeAction(domain, action)) {
      throw new JsonRpcError(JsonRpcErrorCode.invalidParams, `Action '${domain}.${action}' is not exposed through ADE actions.`);
    }
    if (isCtoOnlyAdeAction(domain, action) && !callerHasRoleAtLeast(callerCtx.role, "cto")) {
      throw new JsonRpcError(JsonRpcErrorCode.methodNotFound, `Action '${domain}.${action}' requires elevated role.`);
    }
    const argsList = Array.isArray(toolArgs.argsList) ? toolArgs.argsList : null;
    const hasScalarArg = Object.prototype.hasOwnProperty.call(toolArgs, "arg");
    const rawObjectArgs = safeObject(toolArgs.args);
    const result = argsList
      ? await (callable as (...params: unknown[]) => Promise<unknown>)(...argsList)
      : hasScalarArg
        ? await (callable as (arg: unknown) => Promise<unknown>)(toolArgs.arg)
        : await (callable as (args?: Record<string, unknown>) => Promise<unknown>)(
            Object.keys(rawObjectArgs).length > 0 ? rawObjectArgs : undefined
          );
    const record = isRecord(result) ? result : null;
    const statusHints = {
      operationId: typeof record?.operationId === "string" ? record.operationId : null,
      testRunId: typeof record?.id === "string" && domain === "tests" ? record.id : null,
      chatSessionId: typeof record?.sessionId === "string" ? record.sessionId : null,
      runId: typeof record?.runId === "string" ? record.runId : null,
      missionId: typeof record?.missionId === "string" ? record.missionId : null,
    };
    return {
      domain,
      action,
      result,
      statusHints,
    };
  }

  if (name === "get_ade_action_status") {
    const operationId = asOptionalTrimmedString(toolArgs.operationId);
    const testRunId = asOptionalTrimmedString(toolArgs.testRunId);
    const chatSessionId = asOptionalTrimmedString(toolArgs.chatSessionId);
    const runId = asOptionalTrimmedString(toolArgs.runId);
    const missionId = asOptionalTrimmedString(toolArgs.missionId);
    const prId = asOptionalTrimmedString(toolArgs.prId);
    const previousHash = asOptionalTrimmedString(toolArgs.previousHash);
    const waitForMs = Math.max(0, Math.min(120_000, Math.floor(asNumber(toolArgs.waitForMs, 0))));
    const pollIntervalMs = Math.max(100, Math.min(5_000, Math.floor(asNumber(toolArgs.pollIntervalMs, 800))));

    const collectStatusPayload = async (): Promise<Record<string, unknown>> => {
      const payload: Record<string, unknown> = {};
      if (operationId) {
        const operation = runtime.operationService.list({ limit: 500 }).find((entry) => entry.id === operationId) ?? null;
        payload.operation = operation;
      }
      if (testRunId) {
        const run = runtime.testService.listRuns({ limit: 200 }).find((entry) => entry.id === testRunId) ?? null;
        payload.testRun = run;
        if (run) payload.testRunLogTail = runtime.testService.getLogTail({ runId: testRunId, maxBytes: 16_000 });
      }
      if (chatSessionId && runtime.agentChatService) {
        payload.chatSession = await runtime.agentChatService.getSessionSummary(chatSessionId);
      }
      if (runId) {
        payload.runGraph = runtime.orchestratorService.getRunGraph({ runId, timelineLimit: 150 });
      }
      if (missionId) {
        payload.mission = runtime.missionService.get(missionId);
      }
      if (prId && runtime.prService) {
        payload.pr = {
          health: await runtime.prService.getPrHealth(prId),
          checks: await runtime.prService.getChecks(prId),
          reviews: await runtime.prService.getReviews(prId),
        };
      }
      return payload;
    };

    const hashPayload = (payload: Record<string, unknown>): string =>
      createHash("sha256").update(JSON.stringify(payload)).digest("hex");

    let payload = await collectStatusPayload();
    let hash = hashPayload(payload);
    if (previousHash && waitForMs > 0 && hash === previousHash) {
      const deadline = Date.now() + waitForMs;
      while (Date.now() < deadline && hash === previousHash) {
        await sleep(pollIntervalMs);
        payload = await collectStatusPayload();
        hash = hashPayload(payload);
      }
    }
    return {
      ...payload,
      hash,
      changed: previousHash ? hash !== previousHash : true,
    };
  }

  if (name === "list_lanes") {
    const includeArchived = asBoolean(toolArgs.includeArchived, false);
    const lanes = await runtime.laneService.list({ includeArchived });
    return {
      lanes: lanes.map((lane) => mapLaneSummary(lane as unknown as Record<string, unknown>))
    };
  }

  if (name === "list_unregistered_lanes") {
    const worktrees = await runtime.laneService.listUnregisteredWorktrees();
    return { worktrees };
  }

  if (name === "get_lane_status") {
    const laneId = requireLaneIdForTool(runtime, session, toolArgs, "get_lane_status");
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

  if (name === "import_lane") {
    const branchRef = assertNonEmptyString(toolArgs.branchRef, "branchRef");
    const imported = await runtime.laneService.importBranch({
      branchRef,
      ...(asOptionalTrimmedString(toolArgs.name) ? { name: asOptionalTrimmedString(toolArgs.name)! } : {}),
      ...(asOptionalTrimmedString(toolArgs.description) ? { description: asOptionalTrimmedString(toolArgs.description)! } : {}),
      ...(asOptionalTrimmedString(toolArgs.baseBranch) ? { baseBranch: asOptionalTrimmedString(toolArgs.baseBranch)! } : {}),
    });
    return {
      lane: mapLaneSummary(imported as unknown as Record<string, unknown>),
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

    const missionId = asOptionalTrimmedString(toolArgs.missionId) ?? callerCtx.missionId ?? undefined;
    const title = assertNonEmptyString(toolArgs.title, "title");
    const body = assertNonEmptyString(toolArgs.body, "body");
    const requestedAction = asOptionalTrimmedString(toolArgs.requestedAction);
    const laneId = asOptionalTrimmedString(toolArgs.laneId);
    const phase = asOptionalTrimmedString(toolArgs.phase);
    const waitForResolutionMs = Math.max(0, Math.floor(asNumber(toolArgs.waitForResolutionMs, 0)));
    const pollIntervalMs = Math.max(100, Math.floor(asNumber(toolArgs.pollIntervalMs, 1000)));
    const structuredQuestions = Array.isArray(toolArgs.questions)
      ? toolArgs.questions.flatMap((rawQuestion, index) => {
          if (!rawQuestion || typeof rawQuestion !== "object") return [];
          const q = rawQuestion as Record<string, unknown>;
          const question = asOptionalTrimmedString(q.question);
          if (!question) return [];
          const options = Array.isArray(q.options)
            ? q.options.flatMap((rawOption) => {
                if (!rawOption || typeof rawOption !== "object") return [];
                const o = rawOption as Record<string, unknown>;
                const label = asOptionalTrimmedString(o.label);
                if (!label) return [];
                const value = asOptionalTrimmedString(o.value);
                const description = asOptionalTrimmedString(o.description);
                const preview = asOptionalTrimmedString(o.preview);
                const previewFormat = o.previewFormat === "markdown" || o.previewFormat === "html" ? o.previewFormat : undefined;
                return [{
                  label,
                  ...(value ? { value } : {}),
                  ...(description ? { description } : {}),
                  ...(o.recommended === true ? { recommended: true } : {}),
                  ...(preview ? { preview } : {}),
                  ...(previewFormat ? { previewFormat } : {}),
                }];
              })
            : undefined;
          const header = asOptionalTrimmedString(q.header);
          const defaultAssumption = asOptionalTrimmedString(q.defaultAssumption);
          const impact = asOptionalTrimmedString(q.impact);
          return [{
            id: asOptionalTrimmedString(q.id) ?? `question_${index + 1}`,
            ...(header ? { header } : {}),
            question,
            ...(options?.length ? { options } : {}),
            ...(q.multiSelect === true ? { multiSelect: true } : {}),
            ...(typeof q.allowsFreeform === "boolean" ? { allowsFreeform: q.allowsFreeform } : {}),
            ...(q.isSecret === true ? { isSecret: true } : {}),
            ...(defaultAssumption ? { defaultAssumption } : {}),
            ...(impact ? { impact } : {}),
          }];
        })
      : undefined;
    const askUserPolicy = getAgentAskUserPolicy({ runtime, callerCtx });
    const summarizeAskUserDecision = (decision: string, responseText: string | null, answered: boolean): string | null => {
      const trimmed = typeof responseText === "string" ? responseText.trim() : "";
      if (trimmed.length) return trimmed;
      if (answered) return null;
      if (decision === "cancel") return "The user cancelled the question.";
      if (decision === "decline") return "The user declined to answer the question.";
      if (decision === "timeout") return "The question timed out before the user answered.";
      return "The user did not answer the question.";
    };
    const buildAskUserResult = (args: {
      intervention?: unknown;
      awaitingUserResponse: boolean;
      blocking: boolean;
      outcome: "pending" | "answered" | "declined" | "cancelled" | "timed_out";
      decision?: string;
      responseText?: string | null;
      answers?: Record<string, string[]>;
    }): Record<string, unknown> => ({
      decision: args.decision ?? (args.outcome === "answered" ? "accept" : args.outcome),
      outcome: args.outcome,
      resolved: args.outcome !== "pending" && !args.awaitingUserResponse,
      answered: args.outcome === "answered",
      declined: args.outcome === "declined",
      cancelled: args.outcome === "cancelled",
      timedOut: args.outcome === "timed_out",
      awaitingUserResponse: args.awaitingUserResponse,
      blocking: args.blocking,
      ...(args.intervention ? { intervention: args.intervention } : {}),
      answers: args.answers ?? {},
      responseText: args.responseText ?? null,
    });

    // ── Standalone chat session path (no missionId) ──
    // Route through agentChatService.requestChatInput which creates an inline
    // pending-input in the chat UI and blocks until the user answers.
    if (!missionId) {
      // Use server-authorized chatSessionId; reject unverified client-supplied ids.
      const serverChatSessionId = callerCtx.chatSessionId;
      const clientChatSessionId = session.identity.chatSessionId;
      if (clientChatSessionId && serverChatSessionId && clientChatSessionId !== serverChatSessionId) {
        throw new JsonRpcError(
          JsonRpcErrorCode.invalidParams,
          "ask_user: client-supplied chatSessionId does not match server-authorized session.",
        );
      }
      const chatSessionId = serverChatSessionId ?? clientChatSessionId;
      if (!chatSessionId || !runtime.agentChatService) {
        throw new JsonRpcError(
          JsonRpcErrorCode.invalidParams,
          "ask_user requires either a missionId or an active chat session (chatSessionId).",
        );
      }

      // Race the chat input against an optional timeout.
      const inputPromise = runtime.agentChatService.requestChatInput({
        chatSessionId,
        title,
        body,
        ...(structuredQuestions?.length ? { questions: structuredQuestions } : {}),
      });
      const result = waitForResolutionMs > 0
        ? await Promise.race([
            inputPromise,
            new Promise<null>((resolve) => setTimeout(() => resolve(null), waitForResolutionMs)),
          ])
        : await inputPromise;

      if (!result) {
        return buildAskUserResult({
          awaitingUserResponse: true,
          blocking: true,
          outcome: "timed_out",
          decision: "timeout",
          responseText: summarizeAskUserDecision("timeout", null, false),
        });
      }
      const answered = result.decision !== "decline" && result.decision !== "cancel";
      const outcome = result.decision === "decline"
        ? "declined"
        : result.decision === "cancel"
          ? "cancelled"
          : "answered";
      return buildAskUserResult({
        awaitingUserResponse: false,
        blocking: false,
        outcome,
        decision: result.decision,
        answers: result.answers,
        responseText: summarizeAskUserDecision(result.decision, result.responseText, answered),
      });
    }

    if (askUserPolicy && !askUserPolicy.enabled) {
      throw new JsonRpcError(
        JsonRpcErrorCode.policyDenied,
        "Ask Questions is disabled for this phase. Proceed with the best grounded assumption instead.",
      );
    }
    if (
      askUserPolicy
      && askUserPolicy.maxQuestions != null
      && askUserPolicy.existingQuestions >= askUserPolicy.maxQuestions
    ) {
      throw new JsonRpcError(
        JsonRpcErrorCode.policyDenied,
        `This phase already reached its Ask Questions limit (${askUserPolicy.maxQuestions}) for the active worker.`,
      );
    }

    const resolvedPhase = phase ?? askUserPolicy?.phase ?? null;
    const resolvedPhaseName = askUserPolicy?.phaseName ?? null;
    const ownerKind = callerCtx.role === "orchestrator"
      ? "coordinator"
      : askUserPolicy?.ownerKind ?? "worker";
    const ownerLabel = callerCtx.role === "orchestrator"
      ? "Coordinator question"
      : askUserPolicy?.ownerLabel ?? "Worker question";

    const intervention = runtime.missionService.addIntervention({
      missionId,
      interventionType: "manual_input",
      title,
      body,
      ...(requestedAction ? { requestedAction } : {}),
      ...(laneId ? { laneId } : {}),
      metadata: {
        source: "ask_user",
        ...(callerCtx.runId ? { runId: callerCtx.runId } : {}),
        ...(resolvedPhase ? { phase: resolvedPhase } : {}),
        ...(resolvedPhaseName ? { phaseName: resolvedPhaseName } : {}),
        ...(askUserPolicy?.stepId ? { stepId: askUserPolicy.stepId } : {}),
        ...(askUserPolicy?.stepKey ? { stepKey: askUserPolicy.stepKey } : {}),
        questionOwnerKind: ownerKind,
        questionOwnerLabel: ownerLabel,
        ownerRole: callerCtx.role ?? "external",
        blocking: true,
        canProceedWithoutAnswer: false,
      }
    });

    if (callerCtx.runId) {
      try {
        runtime.orchestratorService.pauseRun({
          runId: callerCtx.runId,
          reason: `Blocking user question: ${title.slice(0, 120)}`,
          metadata: {
            interventionSource: "ask_user",
            interventionId: intervention.id,
          },
        });
      } catch {
        // Best-effort: the run may already be paused or terminal.
      }
    }

    if (session.identity.role === "orchestrator" || callerCtx.runId || waitForResolutionMs <= 0) {
      return buildAskUserResult({
        intervention,
        awaitingUserResponse: true,
        blocking: true,
        outcome: "pending",
      });
    }

    const deadline = Date.now() + waitForResolutionMs;
    while (Date.now() <= deadline) {
      const mission = runtime.missionService.get(missionId);
      const latest = mission?.interventions.find((entry) => entry.id === intervention.id) ?? null;
      if (latest && latest.status !== "open") {
        return buildAskUserResult({
          intervention: latest,
          awaitingUserResponse: false,
          blocking: false,
          outcome: latest.status === "dismissed" ? "declined" : "answered",
        });
      }
      await sleep(pollIntervalMs);
    }

    const mission = runtime.missionService.get(missionId);
    const latest = mission?.interventions.find((entry) => entry.id === intervention.id) ?? intervention;
    return buildAskUserResult({
      intervention: latest,
      awaitingUserResponse: true,
      blocking: true,
      outcome: "timed_out",
    });
  }

  if (name === "get_environment_info") {
    const includeDisplays = asBoolean(toolArgs.includeDisplays, false);
    if (!isLocalComputerUseAllowed(callerCtx)) {
      ensureLocalComputerUse(name, "environmentInfo");
    }
    const capabilities = getLocalComputerUseCapabilities();
    const frontmostApp = capabilities.environmentInfo.available
      ? tryLocalCommand("osascript", [
          "-e",
          "tell application \"System Events\" to get name of first application process whose frontmost is true",
        ])?.stdout || null
      : null;
    let displays: unknown = [];
    if (includeDisplays && capabilities.environmentInfo.available) {
      const displayResult = tryLocalCommand("system_profiler", ["SPDisplaysDataType", "-json"]);
      if (displayResult?.stdout) {
        try {
          displays = JSON.parse(displayResult.stdout);
        } catch {
          displays = [];
        }
      }
    }
    return {
      platform: process.platform,
      projectRoot: runtime.projectRoot,
      artifactsDir: path.join(resolveAdeLayout(runtime.projectRoot).artifactsDir, "computer-use"),
      frontmostApp,
      capabilities,
      displays,
    };
  }

  if (name === "launch_app") {
    ensureLocalComputerUse(name, "appLaunch");
    const app = assertNonEmptyString(toolArgs.app, "app");
    const waitMs = Math.max(0, Math.min(30_000, Math.floor(asNumber(toolArgs.waitMs, 500))));
    const activate = asBoolean(toolArgs.activate, true);
    if (activate) {
      await activateApp(app);
    } else {
      runLocalCommand("open", ["-a", app]);
    }
    if (waitMs > 0) {
      await sleep(waitMs);
    }
    return {
      launched: true,
      app,
      waitMs,
    };
  }

  if (name === "interact_gui") {
    const action = assertNonEmptyString(toolArgs.action, "action");
    const app = asOptionalTrimmedString(toolArgs.app);
    if (app) {
      ensureLocalComputerUse(name, "appLaunch");
      await activateApp(app);
    }
    if (action === "click") {
      ensureLocalComputerUse(name, "guiInteraction");
      const x = Math.floor(asNumber(toolArgs.x, Number.NaN));
      const y = Math.floor(asNumber(toolArgs.y, Number.NaN));
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new JsonRpcError(JsonRpcErrorCode.invalidParams, "click requires numeric x and y coordinates.");
      }
      runLocalCommand("swift", [
        "-e",
        [
          "import CoreGraphics",
          "let x = Double(CommandLine.arguments[1]) ?? 0",
          "let y = Double(CommandLine.arguments[2]) ?? 0",
          "let point = CGPoint(x: x, y: y)",
          "let move = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left)!",
          "move.post(tap: .cghidEventTap)",
          "let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left)!",
          "down.post(tap: .cghidEventTap)",
          "let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left)!",
          "up.post(tap: .cghidEventTap)",
        ].join("\n"),
        String(x),
        String(y),
      ]);
      return { action, x, y, app };
    }
    if (action === "type") {
      ensureLocalComputerUse(name, "guiInteraction");
      const text = assertNonEmptyString(toolArgs.text, "text");
      runLocalCommand("osascript", [
        "-e",
        `tell application "System Events" to keystroke ${JSON.stringify(text)}`,
      ]);
      return { action, textLength: text.length, app };
    }
    if (action === "keypress") {
      ensureLocalComputerUse(name, "guiInteraction");
      const key = assertNonEmptyString(toolArgs.key, "key").trim().toLowerCase();
      const keyCodeMap: Record<string, number> = { enter: 36, return: 36, tab: 48, escape: 53, esc: 53, space: 49 };
      if (keyCodeMap[key] != null) {
        runLocalCommand("osascript", [
          "-e",
          `tell application "System Events" to key code ${keyCodeMap[key]}`,
        ]);
      } else {
        runLocalCommand("osascript", [
          "-e",
          `tell application "System Events" to keystroke ${JSON.stringify(key)}`,
        ]);
      }
      return { action, key, app };
    }
    throw new JsonRpcError(JsonRpcErrorCode.invalidParams, `Unsupported GUI action: ${action}`);
  }

  if (name === "screenshot_environment") {
    ensureLocalComputerUse(name, "screenshot");
    const displayId = Number.isFinite(Number(toolArgs.displayId)) ? String(Math.floor(Number(toolArgs.displayId))) : null;
    const format = asOptionalTrimmedString(toolArgs.format) === "jpg" ? "jpg" : "png";
    const title = asOptionalTrimmedString(toolArgs.name) ?? "Environment screenshot";
    const artifactPath = createComputerUseArtifactPath(runtime.projectRoot, title, format);
    const commandArgs = ["-x"];
    if (displayId) commandArgs.push(`-D${displayId}`);
    commandArgs.push(artifactPath);
    runLocalCommand("screencapture", commandArgs);
    return ingestLocalComputerUseArtifact({
      sessionState: session,
      toolName: name,
      title,
      kind: "screenshot",
      artifactPath,
      mimeType: format === "jpg" ? "image/jpeg" : "image/png",
      metadata: {
        absolutePath: artifactPath,
        displayId,
        format,
      },
      toolArgs,
    });
  }

  if (name === "record_environment") {
    ensureLocalComputerUse(name, "video_recording");
    const displayId = Number.isFinite(Number(toolArgs.displayId)) ? String(Math.floor(Number(toolArgs.displayId))) : null;
    const durationSec = Math.max(1, Math.min(120, Math.floor(asNumber(toolArgs.durationSec, 10))));
    const title = asOptionalTrimmedString(toolArgs.name) ?? "Environment recording";
    const artifactPath = createComputerUseArtifactPath(runtime.projectRoot, title, "mov");
    const commandArgs = ["-v", `-V${durationSec}`, "-x"];
    if (displayId) commandArgs.push(`-D${displayId}`);
    commandArgs.push(artifactPath);
    runLocalCommand("screencapture", commandArgs);
    return ingestLocalComputerUseArtifact({
      sessionState: session,
      toolName: name,
      title,
      kind: "video_recording",
      artifactPath,
      mimeType: "video/quicktime",
      metadata: {
        absolutePath: artifactPath,
        displayId,
        durationSec,
        format: "mov",
      },
      toolArgs,
    });
  }

  if (name === "ingest_computer_use_artifacts") {
    const backendStyle = assertNonEmptyString(toolArgs.backendStyle, "backendStyle") as "external_cli" | "manual" | "local_fallback";
    const backendName = assertNonEmptyString(toolArgs.backendName, "backendName");
    const manifestPath = asOptionalTrimmedString(toolArgs.manifestPath);
    let inputs = Array.isArray(toolArgs.inputs) ? toolArgs.inputs.map((entry) => safeObject(entry)) : [];
    if (manifestPath) {
      if (path.isAbsolute(manifestPath)) {
        throw new JsonRpcError(JsonRpcErrorCode.invalidParams, "manifestPath must be relative to the project root");
      }
      let resolvedManifest: string;
      try {
        resolvedManifest = resolvePathWithinRoot(runtime.projectRoot, path.resolve(runtime.projectRoot, manifestPath));
      } catch {
        throw new JsonRpcError(JsonRpcErrorCode.invalidParams, "manifestPath must stay within the project root");
      }
      inputs = loadAgentBrowserArtifactPayloadFromFile(resolvedManifest).map((entry) => ({
        ...entry,
        metadata: {
          ...(isRecord(entry.metadata) ? entry.metadata : {}),
          manifestPath: resolvedManifest,
        },
      }));
    } else if (backendName === "agent-browser" && inputs.length === 1 && isRecord(inputs[0]?.json)) {
      const adapted = parseAgentBrowserArtifactPayload(inputs[0].json);
      if (adapted.length > 0) {
        inputs = adapted.map((entry) => ({
          ...entry,
          metadata: {
            ...(isRecord(entry.metadata) ? entry.metadata : {}),
            adapter: "agent-browser-json",
          },
        }));
      }
    }
    if (inputs.length === 0) {
      throw new JsonRpcError(JsonRpcErrorCode.invalidParams, "Provide inputs or manifestPath for computer-use ingestion.");
    }
    const result = runtime.computerUseArtifactBrokerService.ingest({
      backend: {
        name: backendName,
        toolName: asOptionalTrimmedString(toolArgs.toolName),
        command: asOptionalTrimmedString(toolArgs.command),
      },
      inputs: inputs.map((entry) => ({
        kind: asOptionalTrimmedString(entry.kind),
        title: asOptionalTrimmedString(entry.title),
        description: asOptionalTrimmedString(entry.description),
        path: asOptionalTrimmedString(entry.path),
        uri: asOptionalTrimmedString(entry.uri),
        text: typeof entry.text === "string" ? entry.text : null,
        ...(entry.json !== undefined ? { json: entry.json } : {}),
        mimeType: asOptionalTrimmedString(entry.mimeType),
        rawType: asOptionalTrimmedString(entry.rawType),
        ...(isRecord(entry.metadata) ? { metadata: entry.metadata } : {}),
      })),
      owners: resolveComputerUseOwners(session, toolArgs),
    });
    return result;
  }

  if (name === "list_computer_use_artifacts") {
    return {
      artifacts: runtime.computerUseArtifactBrokerService.listArtifacts({
        ownerKind: asOptionalTrimmedString(toolArgs.ownerKind) as any,
        ownerId: asOptionalTrimmedString(toolArgs.ownerId),
        kind: asOptionalTrimmedString(toolArgs.kind) as any,
        limit: asNumber(toolArgs.limit, 50),
      }),
    };
  }

  if (name === "get_computer_use_backend_status") {
    return runtime.computerUseArtifactBrokerService.getBackendStatus();
  }

  if (name === "memory_add") {
    ensureMemoryAddAllowed(session);

    const content = assertNonEmptyString(toolArgs.content, "content");
    const category = parseMemoryToolCategory(toolArgs.category);
    const importance = parseMemoryToolImportance(toolArgs.importance);
    const requestedScope = parseMemoryToolScope(toolArgs.scope, callerCtx.runId ? "mission" : "project");
    const serviceScope = mapMemoryToolScopeToServiceScope(requestedScope);
    const scopeOwnerId = resolveMemoryToolScopeOwnerId(requestedScope, callerCtx);
    const writePolicy = resolveAgentMemoryWritePolicy({ pin: false, writeGateMode: "default" });

    type MemoryWriteOutcome = {
      written: boolean;
      id: string | null;
      error: string | null;
      reason: string | null;
      durability: "candidate" | "promoted" | "rejected";
      tier: number | null;
      deduped: boolean;
      mergedIntoId: string | null;
    };

    let memoryOutcome: MemoryWriteOutcome;
    try {
      const result = runtime.memoryService.writeMemory({
        projectId: runtime.projectId,
        scope: serviceScope,
        ...(scopeOwnerId ? { scopeOwnerId } : {}),
        tier: writePolicy.tier,
        category,
        content,
        importance,
        status: writePolicy.status,
        confidence: writePolicy.confidence,
        writeGateMode: "default",
        ...(callerCtx.runId ? { sourceRunId: callerCtx.runId } : {})
      });
      if (result.accepted && result.memory) {
        memoryOutcome = {
          written: true,
          id: result.memory.id,
          error: null,
          reason: result.reason ?? null,
          durability: result.memory.status as "candidate" | "promoted",
          tier: result.memory.tier,
          deduped: result.deduped === true,
          mergedIntoId: result.mergedIntoId ?? null,
        };
      } else {
        memoryOutcome = {
          written: false, id: null, error: result.reason ?? "memory write rejected",
          reason: null, durability: "rejected", tier: null, deduped: false, mergedIntoId: null,
        };
      }
    } catch (error) {
      memoryOutcome = {
        written: false, id: null, error: error instanceof Error ? error.message : String(error),
        reason: null, durability: "rejected", tier: null, deduped: false, mergedIntoId: null,
      };
    }

    const sharedFactAttempted = Boolean(callerCtx.runId) && requestedScope === "mission";
    const sharedFactType = mapMemoryCategoryToSharedFactType(category);
    const sharedFactMemoryService = runtime.memoryService as typeof runtime.memoryService & {
      addSharedFact?: (args: {
        runId: string;
        stepId?: string;
        factType: string;
        content: string;
      }) => { id: string };
    };
    let sharedFactWritten = false;
    let sharedFactId: string | null = null;
    let sharedFactError: string | null = null;

    if (sharedFactAttempted && typeof sharedFactMemoryService.addSharedFact === "function") {
      try {
        const sharedFact = sharedFactMemoryService.addSharedFact({
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
      scope: requestedScope,
      memory: {
        written: memoryOutcome.written,
        durability: memoryOutcome.durability,
        id: memoryOutcome.id,
        tier: memoryOutcome.tier,
        deduped: memoryOutcome.deduped,
        mergedIntoId: memoryOutcome.mergedIntoId,
        ...(memoryOutcome.error ? { error: memoryOutcome.error } : {})
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
      wroteAny: memoryOutcome.written || sharedFactWritten,
      saved: memoryOutcome.written,
      durability: memoryOutcome.durability,
      reason: memoryOutcome.written ? memoryOutcome.reason : (memoryOutcome.error ?? "memory write rejected"),
      deduped: memoryOutcome.deduped,
      mergedIntoId: memoryOutcome.mergedIntoId,
    };
  }

  if (name === "memory_update_core") {
    ensureMemoryAddAllowed(session);

    const patch: Partial<{
      projectSummary: string;
      criticalConventions: string[];
      userPreferences: string[];
      activeFocus: string[];
      notes: string[];
    }> = {};

    if (typeof toolArgs.projectSummary === "string") {
      patch.projectSummary = toolArgs.projectSummary;
    }
    if (Array.isArray(toolArgs.criticalConventions)) {
      patch.criticalConventions = toolArgs.criticalConventions.map((entry) => String(entry ?? "").trim()).filter((entry) => entry.length > 0);
    }
    if (Array.isArray(toolArgs.userPreferences)) {
      patch.userPreferences = toolArgs.userPreferences.map((entry) => String(entry ?? "").trim()).filter((entry) => entry.length > 0);
    }
    if (Array.isArray(toolArgs.activeFocus)) {
      patch.activeFocus = toolArgs.activeFocus.map((entry) => String(entry ?? "").trim()).filter((entry) => entry.length > 0);
    }
    if (Array.isArray(toolArgs.notes)) {
      patch.notes = toolArgs.notes.map((entry) => String(entry ?? "").trim()).filter((entry) => entry.length > 0);
    }

    const hasPatch = Object.values(patch).some((value) => value !== undefined);
    if (!hasPatch) {
      throw new JsonRpcError(JsonRpcErrorCode.invalidParams, "memory_update_core requires at least one patch field.");
    }

    if (callerCtx.role === "agent" && callerCtx.ownerId && runtime.workerAgentService) {
      const coreMemory = runtime.workerAgentService.updateCoreMemory(callerCtx.ownerId, patch);
      return {
        updated: true,
        version: coreMemory.version,
        updatedAt: coreMemory.updatedAt,
        coreMemory
      };
    }

    const snapshot = runtime.ctoStateService.updateCoreMemory(patch);
    return {
      updated: true,
      version: snapshot.coreMemory.version,
      updatedAt: snapshot.coreMemory.updatedAt,
      coreMemory: snapshot.coreMemory
    };
  }

  if (name === "reflection_add") {
    const missionId = asOptionalTrimmedString(toolArgs.missionId) ?? callerCtx.missionId;
    const runId = asOptionalTrimmedString(toolArgs.runId) ?? callerCtx.runId;
    const signalType = assertNonEmptyString(toolArgs.signalType, "signalType");
    const observation = assertNonEmptyString(toolArgs.observation, "observation");
    const agentRole = assertNonEmptyString(toolArgs.agentRole, "agentRole");
    const phase = assertNonEmptyString(toolArgs.phase, "phase");
    if (!missionId) {
      throw new JsonRpcError(JsonRpcErrorCode.invalidParams, "missionId is required (either argument or initialize identity).");
    }
    if (!runId) {
      throw new JsonRpcError(JsonRpcErrorCode.invalidParams, "runId is required (either argument or initialize identity).");
    }

    let reflection;
    try {
      reflection = runtime.orchestratorService.addReflection({
        missionId,
        runId,
        stepId: asOptionalTrimmedString(toolArgs.stepId) ?? callerCtx.stepId,
        attemptId: asOptionalTrimmedString(toolArgs.attemptId) ?? callerCtx.attemptId,
        signalType: signalType as "wish" | "frustration" | "idea" | "pattern" | "limitation",
        observation,
        recommendation: assertNonEmptyString(toolArgs.recommendation, "recommendation"),
        context: assertNonEmptyString(toolArgs.context, "context"),
        agentRole,
        phase,
        occurredAt: assertNonEmptyString(toolArgs.occurredAt, "occurredAt"),
      });
    } catch (error) {
      if (error instanceof ReflectionValidationError) {
        throw new JsonRpcError(
          JsonRpcErrorCode.invalidParams,
          `Invalid reflection input [${error.code}]: ${error.message}`,
          {
            code: error.code,
            ...(error.details ? { details: error.details } : {})
          }
        );
      }
      throw error;
    }

    return { reflection };
  }

  if (name === "memory_search") {
    ensureMemorySearchAllowed(session);

    const query = assertNonEmptyString(toolArgs.query, "query");
    const requestedScope = parseMemoryToolScope(toolArgs.scope, callerCtx.runId ? "mission" : "project");
    const serviceScope = mapMemoryToolScopeToServiceScope(requestedScope);
    const scopeOwnerId = resolveMemoryToolScopeOwnerId(requestedScope, callerCtx);
    const status = parseMemoryToolSearchStatus(toolArgs.status);
    const statusFilter =
      status === "all"
        ? (["promoted", "candidate", "archived"] as const)
        : status;
    const limit = Math.max(1, Math.min(50, Math.floor(asNumber(toolArgs.limit, 5))));
    const memories = await runtime.memoryService.searchMemories(
      query,
      runtime.projectId,
      serviceScope,
      limit,
      statusFilter,
      scopeOwnerId
    );

    return {
      query,
      scope: requestedScope,
      status,
      count: memories.length,
      memories: memories.map((memory) => ({
        id: memory.id,
        scope: memory.scope,
        status: memory.status,
        category: memory.category,
        content: memory.content,
        importance: memory.importance,
        confidence: memory.confidence,
        createdAt: memory.createdAt,
        promotedAt: memory.promotedAt,
        sourceRunId: memory.sourceRunId
      }))
    };
  }

  if (name === "memory_pin") {
    ensureMemoryAddAllowed(session);

    const id = assertNonEmptyString(toolArgs.id, "id");
    runtime.memoryService.pinMemory(id);
    return {
      id,
      pinned: true,
      tier: "pinned"
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
      title: `ADE Test: ${commandText}`,
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

  if (name === "git_get_sync_status") {
    const laneId = requireLaneIdForTool(runtime, session, toolArgs, "git_get_sync_status");
    const status = await runtime.gitService.getSyncStatus({ laneId });
    return { laneId, status };
  }

  if (name === "git_fetch") {
    const laneId = requireLaneIdForTool(runtime, session, toolArgs, "git_fetch");
    const action = await runtime.gitService.fetch({ laneId });
    return { laneId, action };
  }

  if (name === "git_pull") {
    const laneId = requireLaneIdForTool(runtime, session, toolArgs, "git_pull");
    const action = await runtime.gitService.pull({ laneId });
    return { laneId, action };
  }

  if (name === "git_push") {
    const laneId = requireLaneIdForTool(runtime, session, toolArgs, "git_push");
    const force = asBoolean(toolArgs.forceWithLease, asBoolean(toolArgs.force, false));
    const action = await runtime.gitService.push({ laneId, forceWithLease: force });
    return { laneId, action };
  }

  if (name === "git_list_branches") {
    const laneId = requireLaneIdForTool(runtime, session, toolArgs, "git_list_branches");
    const branches = await runtime.gitService.listBranches({ laneId });
    return { laneId, branches };
  }

  if (name === "git_checkout_branch") {
    const laneId = requireLaneIdForTool(runtime, session, toolArgs, "git_checkout_branch");
    const branchName = assertNonEmptyString(toolArgs.branchName, "branchName");
    const rawMode = toolArgs.mode;
    let mode: "existing" | "create" | undefined;
    if (rawMode === undefined || rawMode === null) {
      mode = undefined;
    } else if (rawMode === "existing" || rawMode === "create") {
      mode = rawMode;
    } else {
      throw new JsonRpcError(
        JsonRpcErrorCode.invalidParams,
        `mode must be either "existing" or "create"`
      );
    }
    const startPoint = typeof toolArgs.startPoint === "string" ? toolArgs.startPoint : undefined;
    const baseRef = typeof toolArgs.baseRef === "string" ? toolArgs.baseRef : undefined;
    const acknowledgeActiveWork = typeof toolArgs.acknowledgeActiveWork === "boolean" ? toolArgs.acknowledgeActiveWork : undefined;
    const action = await runtime.gitService.checkoutBranch({
      laneId,
      branchName,
      mode: mode ?? "existing",
      startPoint,
      baseRef,
      acknowledgeActiveWork,
    });
    return { laneId, branchName, action };
  }

  if (name === "commit_changes") {
    const laneId = requireLaneIdForTool(runtime, session, toolArgs, "commit_changes");
    const amend = asBoolean(toolArgs.amend, false);
    const stageAll = asBoolean(toolArgs.stageAll, true);

    if (stageAll) {
      await runtime.gitService.stageAll({ laneId, paths: [] });
    }

    const explicitMessage = asOptionalTrimmedString(toolArgs.message);
    const generated = explicitMessage
      ? null
      : await runtime.gitService.generateCommitMessage({ laneId, amend });
    const message = explicitMessage ?? generated?.message ?? "";
    if (!message.trim().length) {
      throw new JsonRpcError(JsonRpcErrorCode.toolFailed, "Commit message is empty after generation.");
    }

    const action = await runtime.gitService.commit({ laneId, message, amend });
    const latest = await runtime.gitService.listRecentCommits({ laneId, limit: 1 });

    return {
      action,
      commit: latest[0] ?? null,
      message,
      messageSource: explicitMessage ? "provided" : "generated",
      ...(generated?.model ? { generatedByModel: generated.model } : {})
    };
  }

  if (name === "generate_commit_message") {
    const laneId = requireLaneIdForTool(runtime, session, toolArgs, "generate_commit_message");
    const amend = asBoolean(toolArgs.amend, false);
    const result = await runtime.gitService.generateCommitMessage({ laneId, amend });
    return {
      laneId,
      amend,
      ...result,
    };
  }

  if (name === "stash_push") {
    const laneId = requireLaneIdForTool(runtime, session, toolArgs, "stash_push");
    const message = asOptionalTrimmedString(toolArgs.message);
    const includeUntracked = typeof toolArgs.includeUntracked === "boolean" ? toolArgs.includeUntracked : true;
    const action = await runtime.gitService.stashPush({
      laneId,
      includeUntracked,
      ...(message ? { message } : {})
    });
    const stashes = await runtime.gitService.listStashes({ laneId });
    return {
      action,
      latest: stashes[0] ?? null,
      count: stashes.length,
    };
  }

  if (name === "list_stashes") {
    const laneId = requireLaneIdForTool(runtime, session, toolArgs, "list_stashes");
    const stashes = await runtime.gitService.listStashes({ laneId });
    return {
      laneId,
      count: stashes.length,
      stashes,
    };
  }

  if (name === "stash_apply") {
    const laneId = requireLaneIdForTool(runtime, session, toolArgs, "stash_apply");
    const stashRef = assertNonEmptyString(toolArgs.stashRef, "stashRef");
    const action = await runtime.gitService.stashApply({ laneId, stashRef });
    return { action };
  }

  if (name === "stash_pop") {
    const laneId = requireLaneIdForTool(runtime, session, toolArgs, "stash_pop");
    const stashRef = assertNonEmptyString(toolArgs.stashRef, "stashRef");
    const action = await runtime.gitService.stashPop({ laneId, stashRef });
    return { action };
  }

  if (name === "stash_drop") {
    const laneId = requireLaneIdForTool(runtime, session, toolArgs, "stash_drop");
    const stashRef = assertNonEmptyString(toolArgs.stashRef, "stashRef");
    const action = await runtime.gitService.stashDrop({ laneId, stashRef });
    return { action };
  }

  if (name === "stash_clear") {
    const laneId = requireLaneIdForTool(runtime, session, toolArgs, "stash_clear");
    const action = await runtime.gitService.stashClear({ laneId });
    return { action };
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
    const laneId = requireLaneIdForTool(runtime, session, toolArgs, "rebase_lane");

    const aiAssisted = typeof toolArgs.aiAssisted === "boolean" ? toolArgs.aiAssisted : undefined;
    const provider = asOptionalTrimmedString(toolArgs.provider);
    const autoApplyThreshold = typeof toolArgs.autoApplyThreshold === "number" ? toolArgs.autoApplyThreshold : undefined;
    const result = await runtime.conflictService.rebaseLane({
      laneId,
      ...(aiAssisted !== undefined ? { aiAssisted } : {}),
      ...(provider ? { provider: provider as "codex" | "claude" | undefined } : {}),
      ...(autoApplyThreshold !== undefined ? { autoApplyThreshold } : {})
    });
    if (
      !result.success
      && typeof result.error === "string"
      && /commit or stash before rebasing/i.test(result.error)
    ) {
      return {
        ...result,
        suggestedNextAction: "stash_or_commit_dirty_worktree",
        suggestedTools: ["stash_push", "commit_changes"],
      };
    }
    return result;
  }

  if (name === "create_pr_from_lane") {
    const laneId = assertNonEmptyString(toolArgs.laneId, "laneId");
    const baseBranch = asOptionalTrimmedString(toolArgs.baseBranch);
    const prSvc = requirePrService(runtime);
    let title = asOptionalTrimmedString(toolArgs.title);
    let body = typeof toolArgs.body === "string" ? toolArgs.body : null;
    if (!title || body == null) {
      const draft = await prSvc.draftDescription({
        laneId,
        ...(baseBranch ? { baseBranch } : {}),
      });
      title = title || asOptionalTrimmedString(draft.title) || `PR for ${laneId}`;
      body = body ?? asOptionalTrimmedString(draft.body) ?? "";
    }
    const draft = asBoolean(toolArgs.draft, false);
    const pr = await prSvc.createFromLane({
      laneId,
      title,
      body,
      draft,
      ...(baseBranch ? { baseBranch } : {}),
    });
    return { pr };
  }

  if (name === "pr_update_title") {
    const prId = assertNonEmptyString(toolArgs.prId, "prId");
    const title = assertNonEmptyString(toolArgs.title, "title");
    await requirePrService(runtime).updateTitle({ prId, title });
    return { success: true, prId, title };
  }

  if (name === "pr_update_body") {
    const prId = assertNonEmptyString(toolArgs.prId, "prId");
    const body = typeof toolArgs.body === "string" ? toolArgs.body : "";
    await requirePrService(runtime).updateBody({ prId, body });
    return { success: true, prId };
  }

  if (name === "pr_add_comment") {
    const prId = assertNonEmptyString(toolArgs.prId, "prId");
    const body = assertNonEmptyString(toolArgs.body, "body");
    const comment = await requirePrService(runtime).addComment({ prId, body });
    return { success: true, comment };
  }

  if (name === "get_pr_health") {
    const prId = assertNonEmptyString(toolArgs.prId, "prId");
    const prSvc = requirePrService(runtime);
    const result = await prSvc.getPrHealth(prId);
    return result;
  }

  if (name === "pr_get_checks") {
    const prId = assertNonEmptyString(toolArgs.prId, "prId");
    const prSvc = requirePrService(runtime);
    const checks = await prSvc.getChecks(prId);
    return {
      success: true,
      prId,
      checks: checks.map(mapCheckToSummary),
    };
  }

  if (name === "pr_get_review_comments") {
    const prId = assertNonEmptyString(toolArgs.prId, "prId");
    const prSvc = requirePrService(runtime);
    const [comments, reviews, checks] = await Promise.all([
      prSvc.getComments(prId),
      prSvc.getReviews(prId),
      prSvc.getChecks(prId),
    ]);
    return summarizePrReviewComments(prId, comments, reviews, checks);
  }

  if (name === "pr_refresh_issue_inventory") {
    const prId = assertNonEmptyString(toolArgs.prId, "prId");
    const prSvc = requirePrService(runtime);
    const [checks, actionRuns, reviewThreads, comments] = await Promise.all([
      prSvc.getChecks(prId),
      prSvc.getActionRuns(prId),
      prSvc.getReviewThreads(prId),
      prSvc.getComments(prId),
    ]);
    return summarizePrIssueInventory({
      checks,
      actionRuns,
      reviewThreads,
      comments,
    });
  }

  if (name === "pr_preview_issue_resolution_prompt" || name === "pr_start_issue_resolution") {
    const prId = assertNonEmptyString(toolArgs.prId, "prId");
    const scope = assertNonEmptyString(toolArgs.scope, "scope");
    if (scope !== "checks" && scope !== "comments" && scope !== "both") {
      throw new JsonRpcError(JsonRpcErrorCode.invalidParams, "scope must be one of checks, comments, or both.");
    }
    const modelId = assertNonEmptyString(toolArgs.modelId, "modelId");
    const permissionMode = asOptionalTrimmedString(toolArgs.permissionMode);
    if (
      permissionMode
      && permissionMode !== "read_only"
      && permissionMode !== "guarded_edit"
      && permissionMode !== "full_edit"
    ) {
      throw new JsonRpcError(JsonRpcErrorCode.invalidParams, "permissionMode must be one of read_only, guarded_edit, or full_edit.");
    }
    const issueResolutionArgs = {
      prId,
      scope,
      modelId,
      reasoning: asOptionalTrimmedString(toolArgs.reasoning),
      ...(permissionMode ? { permissionMode } : {}),
      additionalInstructions: asOptionalTrimmedString(toolArgs.additionalInstructions),
    };
    const deps = {
      prService: requirePrService(runtime),
      laneService: runtime.laneService,
      agentChatService: requireAgentChatService(runtime),
      sessionService: runtime.sessionService,
      issueInventoryService: runtime.issueInventoryService,
    };

    if (name === "pr_preview_issue_resolution_prompt") {
      return await previewPrIssueResolutionPrompt(deps, issueResolutionArgs as any);
    }

    const result = await launchPrIssueResolutionChat(deps, issueResolutionArgs as any);
    let convergenceRuntime: unknown = null;
    try {
      const status = runtime.issueInventoryService.getConvergenceStatus(prId);
      convergenceRuntime = runtime.issueInventoryService.saveConvergenceRuntime(prId, {
        currentRound: status.currentRound,
        status: "running",
        pollerStatus: "idle",
        activeSessionId: result.sessionId,
        activeLaneId: result.laneId,
        activeHref: result.href,
        lastStartedAt: nowIso(),
        errorMessage: null,
        pauseReason: null,
      });
    } catch (error) {
      runtime.logger.warn("rpc.pr_issue_resolution_convergence_persist_failed", {
        prId,
        sessionId: result.sessionId,
        laneId: result.laneId,
        href: result.href,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return {
      ...result,
      convergenceRuntime,
    };
  }

  if (name === "pr_rerun_failed_checks") {
    const prId = assertNonEmptyString(toolArgs.prId, "prId");
    await requirePrService(runtime).rerunChecks({ prId });
    return {
      success: true,
      prId,
    };
  }

  if (name === "pr_reply_to_review_thread") {
    const prId = assertNonEmptyString(toolArgs.prId, "prId");
    const threadId = assertNonEmptyString(toolArgs.threadId, "threadId");
    const body = assertNonEmptyString(toolArgs.body, "body");
    const comment = await requirePrService(runtime).replyToReviewThread({
      prId,
      threadId,
      body,
    });
    return {
      success: true,
      comment,
    };
  }

  if (name === "pr_resolve_review_thread") {
    const prId = assertNonEmptyString(toolArgs.prId, "prId");
    const threadId = assertNonEmptyString(toolArgs.threadId, "threadId");
    await requirePrService(runtime).resolveReviewThread({
      prId,
      threadId,
    });
    return {
      success: true,
      prId,
      threadId,
    };
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

  if (name === "get_lane_conflict_state") {
    const laneId = requireLaneIdForTool(runtime, session, toolArgs, "get_lane_conflict_state");
    return await runtime.gitService.getConflictState({ laneId });
  }

  if (name === "rebase_continue") {
    const laneId = requireLaneIdForTool(runtime, session, toolArgs, "rebase_continue");
    const action = await runtime.gitService.rebaseContinue({ laneId });
    return { action };
  }

  if (name === "rebase_abort") {
    const laneId = requireLaneIdForTool(runtime, session, toolArgs, "rebase_abort");
    const action = await runtime.gitService.rebaseAbort({ laneId });
    return { action };
  }

  if (name === "spawn_agent") {


    const laneId = assertNonEmptyString(toolArgs.laneId, "laneId");
    const laneWorktreePath = resolveLaneWorktreePath(runtime, laneId);
    if (!laneWorktreePath) {
      throw new JsonRpcError(
        JsonRpcErrorCode.invalidParams,
        `Requested lane '${laneId}' does not have an available worktree.`,
      );
    }
    const provider = asTrimmedString(toolArgs.provider) === "claude" ? "claude" : "codex";
    const model = asOptionalTrimmedString(toolArgs.model);
    const permissionMode = parseSpawnPermissionMode(toolArgs.permissionMode);
    if (provider === "claude" && permissionMode === "config-toml") {
      throw new JsonRpcError(
        JsonRpcErrorCode.invalidParams,
        "permissionMode config-toml is only supported for Codex spawn_agent sessions.",
      );
    }
    const maxPromptChars = Math.max(256, Math.min(12000, Math.floor(asNumber(toolArgs.maxPromptChars, 2800))));
    const prompt = asOptionalTrimmedString(toolArgs.prompt);
    const runId = asOptionalTrimmedString(toolArgs.runId);
    const stepId = asOptionalTrimmedString(toolArgs.stepId);
    const attemptId = asOptionalTrimmedString(toolArgs.attemptId);
    const promptRunId = runId ? stripInjectionChars(runId) : null;
    const promptStepId = stepId ? stripInjectionChars(stepId) : null;
    const promptAttemptId = attemptId ? stripInjectionChars(attemptId) : null;
    const toolWhitelist = normalizeToolWhitelist(toolArgs.toolWhitelist);
    const title = stripInjectionChars(
      asOptionalTrimmedString(toolArgs.title) ?? `ADE Agent (${provider}${permissionMode === "plan" ? " · plan" : ""})`
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
    promptSegments.push(ADE_CLI_INLINE_GUIDANCE);
    if (promptRunId || promptStepId || promptAttemptId) {
      promptSegments.push(
        `Mission context: run=${promptRunId ?? "n/a"} step=${promptStepId ?? "n/a"} attempt=${promptAttemptId ?? "n/a"}.`
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

    const commandArgs: string[] = [];
    const commandPreviewParts: string[] = [provider];
    if (model) {
      commandArgs.push("--model", model);
      commandPreviewParts.push("--model", previewShellEscapeArg(model));
    }
    if (provider === "codex") {
      if (permissionMode === "full-auto") {
        commandArgs.push("--dangerously-bypass-approvals-and-sandbox");
        commandPreviewParts.push("--dangerously-bypass-approvals-and-sandbox");
      } else if (permissionMode === "default") {
        commandArgs.push("--full-auto");
        commandPreviewParts.push("--full-auto");
      } else if (permissionMode === "config-toml") {
        // No explicit Codex permission flags; let the host config.toml decide.
      } else if (permissionMode === "plan") {
        commandArgs.push("--sandbox", "read-only", "--ask-for-approval", "on-request");
        commandPreviewParts.push("--sandbox", "read-only", "--ask-for-approval", "on-request");
      } else {
        commandArgs.push("--sandbox", "workspace-write", "--ask-for-approval", "untrusted");
        commandPreviewParts.push("--sandbox", "workspace-write", "--ask-for-approval", "untrusted");
      }
    } else {
      const claudePermission =
        permissionMode === "plan" ? "plan" : permissionMode === "full-auto" ? "bypassPermissions" : permissionMode === "edit" ? "acceptEdits" : "default";
      commandArgs.push("--permission-mode", claudePermission);
      commandPreviewParts.push("--permission-mode", previewShellEscapeArg(claudePermission));

      // ADE-owned actions are exposed through the `ade` CLI. Child agent
      // sessions receive identity env vars below instead of an attached server.
    }
    if (finalPrompt) {
      commandArgs.push(finalPrompt);
      commandPreviewParts.push(previewShellEscapeArg(finalPrompt));
    }

    // Attach worker identity through the process environment. The startup
    // command remains a display/resume preview only; the actual launch uses
    // command/args/env so it works on Windows without POSIX inline assignment.
    const workerEnv: Record<string, string> = {};
    const envPrefixParts: string[] = [];
    const addWorkerEnv = (key: string, value: string | null | undefined) => {
      if (!value) return;
      workerEnv[key] = value;
      envPrefixParts.push(`${key}=${shellEscapeArg(value)}`);
    };
    addWorkerEnv("ADE_RUN_ID", runId);
    addWorkerEnv("ADE_STEP_ID", stepId);
    addWorkerEnv("ADE_ATTEMPT_ID", attemptId);
    addWorkerEnv("ADE_MISSION_ID", callerCtx.missionId);
    addWorkerEnv("ADE_OWNER_ID", callerCtx.ownerId);
    workerEnv.ADE_DEFAULT_ROLE = "agent";
    envPrefixParts.push("ADE_DEFAULT_ROLE=agent");

    const startupEnvPrefixParts = process.platform === "win32" ? [] : envPrefixParts;
    const startupCommand = startupEnvPrefixParts.length > 0
      ? `${startupEnvPrefixParts.join(" ")} ${commandPreviewParts.join(" ")}`
      : commandPreviewParts.join(" ");
    const providerExecutable = resolveExecutableOnPath(provider);

    const created = await runtime.ptyService.create({
      laneId,
      cols: DEFAULT_PTY_COLS,
      rows: DEFAULT_PTY_ROWS,
      title,
      tracked: true,
      toolType: `${provider}-orchestrated`,
      ...(providerExecutable ? { command: providerExecutable, args: commandArgs } : {}),
      env: workerEnv,
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
    const interventionId = asOptionalTrimmedString(toolArgs.interventionId);
    const resolutionKind = asOptionalTrimmedString(toolArgs.resolutionKind);
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
      ...(targetStepKey ? { targetStepKey } : {}),
      ...(interventionId ? { interventionId } : {}),
      ...(resolutionKind ? { resolutionKind: resolutionKind as any } : {})
    });
    return result;
  }

  if (name === "resolve_intervention") {

    const missionId = assertNonEmptyString(toolArgs.missionId, "missionId");
    const interventionId = assertNonEmptyString(toolArgs.interventionId, "interventionId");
    const statusRaw = assertNonEmptyString(toolArgs.status, "status");
    const status = statusRaw === "dismissed" ? "dismissed" as const : "resolved" as const;
    const note = asOptionalTrimmedString(toolArgs.note);
    const resolutionKind = asOptionalTrimmedString(toolArgs.resolutionKind);
    const intervention = runtime.missionService.resolveIntervention({
      missionId,
      interventionId,
      status,
      ...(note ? { note } : {}),
      ...(resolutionKind ? { resolutionKind: resolutionKind as any } : {})
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

  if (name === "list_retrospectives") {
    const missionId = asOptionalTrimmedString(toolArgs.missionId) ?? callerCtx.missionId ?? undefined;
    const limit = asNumber(toolArgs.limit, 20);
    const retrospectives = runtime.orchestratorService.listRetrospectives({
      ...(missionId ? { missionId } : {}),
      limit
    });
    return { retrospectives };
  }

  if (name === "list_reflection_trends") {
    const missionId = asOptionalTrimmedString(toolArgs.missionId) ?? callerCtx.missionId ?? undefined;
    const runId = asOptionalTrimmedString(toolArgs.runId) ?? callerCtx.runId ?? undefined;
    const limit = asNumber(toolArgs.limit, 100);
    const trends = runtime.orchestratorService.listRetrospectiveTrends({
      ...(missionId ? { missionId } : {}),
      ...(runId ? { runId } : {}),
      limit
    });
    return { trends };
  }

  if (name === "list_reflection_pattern_stats") {
    const limit = asNumber(toolArgs.limit, 100);
    const patternStats = runtime.orchestratorService.listRetrospectivePatternStats({ limit });
    return { patternStats };
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
      // Use the last *drained* event's ID (not last *filtered*) as nextCursor
      // to advance past non-matching events and avoid infinite polling loops.
      const batchSize = Math.min(1000, limit * 10);
      const result = runtime.eventBuffer.drain(cursor, batchSize);
      const filtered = result.events.filter((e) => e.category === category);
      const sliced = filtered.slice(0, limit);
      return {
        events: sliced,
        nextCursor: result.nextCursor,
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

  throw new JsonRpcError(JsonRpcErrorCode.methodNotFound, `Unknown ADE action: ${name}`);
}

async function readResource(runtime: AdeRuntime, uri: string): Promise<Record<string, unknown>> {
  const parsed = parseAdeResourceUri(uri);
  const [head, ...tail] = parsed.path;

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

export function createAdeRpcRequestHandler(args: {
  runtime: AdeRuntime;
  serverVersion: string;
  onActionsListChanged?: (() => void) | null;
}): JsonRpcHandler & { dispose: () => void } {
  const { runtime, serverVersion, onActionsListChanged } = args;

  const session: SessionState = {
    initialized: false,
    protocolVersion: DEFAULT_PROTOCOL_VERSION,
    identity: {
      callerId: "unknown",
      role: "external",
      chatSessionId: null,
      standaloneChatSession: false,
      missionId: null,
      runId: null,
      stepId: null,
      attemptId: null,
      ownerId: null,
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

  const auditActionCall = async (
    actionName: string,
    actionArgs: Record<string, unknown>,
    runner: () => Promise<unknown>
  ): Promise<unknown> => {
    const startedAt = Date.now();
    const laneId = resolveRequestedOrSessionLaneId(runtime, session, actionArgs);
    const operation = runtime.operationService.start({
      laneId,
      kind: "ade_action_call",
      metadata: {
        action: actionName,
        callerId: session.identity.callerId,
        role: session.identity.role,
        chatSessionId: session.identity.chatSessionId,
        missionId: session.identity.missionId,
        runId: session.identity.runId,
        stepId: session.identity.stepId,
        attemptId: session.identity.attemptId,
        ownerId: session.identity.ownerId,
        args: sanitizeForAudit(actionArgs)
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

  const listActions = async (): Promise<Record<string, unknown>> => ({
    actions: (await listToolSpecsForSession(runtime, session)).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: sanitizeToolSchema(tool.inputSchema),
    })),
  });

  const callAction = async (actionName: string, actionArgs: Record<string, unknown>): Promise<unknown> => {
    return await auditActionCall(actionName, actionArgs, async () => {
      if (
        READ_ONLY_TOOLS.has(actionName) ||
        MUTATION_TOOLS.has(actionName) ||
        ORCHESTRATION_TOOLS.has(actionName) ||
        OBSERVATION_TOOLS.has(actionName) ||
        EVALUATOR_TOOLS.has(actionName) ||
        EVALUATION_READ_TOOLS.has(actionName) ||
        COORDINATOR_TOOL_NAMES.has(actionName) ||
        actionName === "spawn_agent" ||
        actionName === "ask_user"
      ) {
        return await runTool({ runtime, session, name: actionName, toolArgs: actionArgs });
      }

      throw new JsonRpcError(JsonRpcErrorCode.methodNotFound, `Unsupported ADE action: ${actionName}`);
    });
  };

  const handler = (async (request: JsonRpcRequest): Promise<unknown | null> => {
    const method = typeof request.method === "string" ? request.method : "";
    const params = safeObject(request.params);

    if (method === "ade/initialize") {
      session.initialized = true;
      session.protocolVersion = asOptionalTrimmedString(params.protocolVersion) ?? DEFAULT_PROTOCOL_VERSION;
      session.identity = parseInitializeIdentity(runtime, params);
      const resourcesEnabled = session.identity.role !== "orchestrator";
      return {
        protocolVersion: session.protocolVersion,
        runtimeInfo: {
          name: "ade-rpc",
          version: serverVersion
        },
        capabilities: {
          actions: {
            listChanged: true
          },
          ...(resourcesEnabled
            ? {
                resources: {
                  listChanged: false,
                  subscribe: false
                }
              }
            : {})
        }
      };
    }

    if (method === "ade/initialized") {
      return null;
    }

    if (!session.initialized) {
      throw new JsonRpcError(JsonRpcErrorCode.invalidRequest, "Server must be initialized first.");
    }

    if (method === "ping") {
      return { pong: true, at: nowIso() };
    }

    if (method === "ade/actions/list") {
      return await listActions();
    }

    if (method === "ade/actions/call") {
      const actionName = assertNonEmptyString(params.name, "name");
      const actionArgs = safeObject(params.arguments);
      try {
        return await callAction(actionName, actionArgs);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          error: {
            code: error instanceof JsonRpcError ? error.code : JsonRpcErrorCode.toolFailed,
            message,
          },
        };
      }
    }

    if (method === "ade/resources/list") {
      const lanes = await runtime.laneService.list({ includeArchived: false });
      const laneRecords = lanes as unknown as Array<Record<string, unknown>>;
      return {
        resources: buildResourceList({
          lanes: laneRecords
        })
      };
    }

    if (method === "ade/resources/read") {
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
  }) as JsonRpcHandler & { dispose: () => void };

  handler.dispose = () => {};

  return handler;
}
