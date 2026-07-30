import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createCtoOperatorTools } from "../../desktop/src/main/services/ai/tools/ctoOperatorTools";
import {
  createComputerUseArtifactPath,
  getLocalComputerUseCapabilities,
  toProjectArtifactUri,
} from "../../desktop/src/main/services/computerUse/localComputerUse";
import {
  ADE_ACTION_DOMAIN_NAMES,
  type AdeActionDomain,
  callerHasRoleAtLeast,
  getAdeActionInputContract,
  getAdeActionDomainServices,
  isAllowedAdeAction,
  isCtoOnlyAdeAction,
  listAllowedAdeActionNames,
  scopeAccountStatusForRole,
} from "../../desktop/src/main/services/adeActions/registry";
import { runGit } from "../../desktop/src/main/services/git/git";
import { resolvePathWithinRoot } from "../../desktop/src/main/services/shared/utils";
import { getDefaultModelDescriptor } from "../../desktop/src/shared/modelRegistry";
import { buildAdeCliInlineGuidance } from "../../desktop/src/shared/adeCliGuidance";
import { buildDeeplink, isValidCommitSha, isValidRepoRelativePath } from "../../desktop/src/shared/deeplinks";
import { resolveStableLaneBaseBranch } from "../../desktop/src/shared/laneBaseResolution";
import {
  ADE_AGENT_SKILLS_DIRS_ENV,
  getAdeAgentSkillRootsForPrompt,
  joinAdeAgentSkillRoots,
} from "../../desktop/src/shared/agentSkillRoots";
import { isActionablePrIssueComment } from "../../desktop/src/shared/prIssueResolution";
import {
  type ComputerUseBackendStyle,
  type ExternalSessionProvider,
  type ExternalSessionSummary,
  type ComputerUseArtifactOwner,
  type LaneLinearIssue,
  type LaneLinearIssueLink,
  type MergeMethod,
  type AppNavigationRequest,
} from "../../desktop/src/shared/types";
import type { PrCheck, PrComment, PrReviewThread } from "../../desktop/src/shared/types/prs";
import type { CtoLinearQuickView } from "../../desktop/src/shared/types/cto";
import type { LinearConnectionStatus } from "../../desktop/src/shared/types/linearSync";
import { resolveAdeLayout } from "../../desktop/src/shared/adeLayout";
import {
  buildTrackedCliLaunchCommand,
  deriveTrackedCliInitialInputSessionMeta,
  isLaunchProfile,
  isTrackedCliPermissionMode,
  LAUNCH_PROFILE_TITLE,
  LAUNCH_PROFILE_TOOL_TYPE,
  resolveCleanShellLaunchFields,
  validateLaunchProfilePermissionMode,
  type CliProvider,
  type LaunchProfile,
  type TrackedCliLaunchCommand,
} from "../../desktop/src/shared/cliLaunch";
import type { AgentChatPermissionMode, AgentChatSpawnKind, TerminalResumeMetadata, TerminalSessionSummary } from "../../desktop/src/shared/types";
import type { AdeRuntime } from "./bootstrap";
import {
  recordUsageInteraction,
  usageActionFromRpcDomain,
  usageClientSurfaceFromRpcName,
} from "../../desktop/src/main/services/usage/usageStatsStore";
import { JsonRpcError, JsonRpcErrorCode, type JsonRpcHandler, type JsonRpcRequest } from "./jsonrpc";
import { normalizeAdeRuntimeRole, resolveSessionBoundRole } from "./runtimeRoles";
import { getSharedModelPickerStore } from "./services/modelPickerStore";
import { resolveLaneCreateRemoteBase } from "./services/laneCreateRemoteBase";
import { BUILT_IN_BROWSER_ACTOR_CAPABILITY_PARAM } from "./services/builtInBrowser/desktopBridgeMethods";
import { resolveCodexComputerUseMcpConfig } from "../../desktop/src/main/utils/codexComputerUse";
import { parseTrackedCliLaunchConfig } from "../../desktop/src/main/utils/terminalSessionSignals";
import { RUNTIME_COMPAT_LEVEL } from "../../desktop/src/shared/adeRuntimeProtocol";

// Cross-surface (desktop + TUI + iOS) model picker favorites & recents.
// Backed by the per-project cr-sqlite CRR DB (runtime.db) so the three surfaces
// converge for a given project via sync. The store is a per-db singleton (see
// services/modelPickerStore.ts) shared by the JSON-RPC server and the sync
// host. A one-time best-effort import of the legacy ~/.ade/modelPicker.json
// runs on first DB-backed init — see modelPickerStore.ts for schema + migration.

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

const LINEAR_ISSUE_TOOL_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: [
    "id",
    "identifier",
    "title",
    "description",
    "url",
    "projectId",
    "projectSlug",
    "projectName",
    "teamId",
    "teamKey",
    "teamName",
    "stateId",
    "stateName",
    "stateType",
    "priority",
    "priorityLabel",
    "labels",
    "assigneeId",
    "assigneeName",
    "creatorId",
    "creatorName",
    "dueDate",
    "estimate",
    "branchName",
    "createdAt",
    "updatedAt",
  ],
  additionalProperties: false,
  properties: {
    id: { type: "string", minLength: 1 },
    identifier: { type: "string", minLength: 1 },
    title: { type: "string", minLength: 1 },
    description: { anyOf: [{ type: "string" }, { type: "null" }] },
    url: { anyOf: [{ type: "string" }, { type: "null" }] },
    projectId: { type: "string", minLength: 1 },
    projectSlug: { type: "string", minLength: 1 },
    projectName: { anyOf: [{ type: "string" }, { type: "null" }] },
    teamId: { type: "string", minLength: 1 },
    teamKey: { type: "string", minLength: 1 },
    teamName: { anyOf: [{ type: "string" }, { type: "null" }] },
    stateId: { type: "string", minLength: 1 },
    stateName: { type: "string", minLength: 1 },
    stateType: { type: "string", minLength: 1 },
    priority: { type: "number" },
    priorityLabel: { type: "string", enum: ["urgent", "high", "normal", "low", "none"] },
    labels: { type: "array", items: { type: "string" } },
    assigneeId: { anyOf: [{ type: "string" }, { type: "null" }] },
    assigneeName: { anyOf: [{ type: "string" }, { type: "null" }] },
    creatorId: { anyOf: [{ type: "string" }, { type: "null" }] },
    creatorName: { anyOf: [{ type: "string" }, { type: "null" }] },
    dueDate: { anyOf: [{ type: "string" }, { type: "null" }] },
    estimate: { anyOf: [{ type: "number" }, { type: "null" }] },
    branchName: { anyOf: [{ type: "string" }, { type: "null" }] },
    createdAt: { type: "string", minLength: 1 },
    updatedAt: { type: "string", minLength: 1 },
  },
};

type SessionIdentity = {
  callerId: string;
  role: "cto" | "orchestrator" | "agent" | "external" | "evaluator";
  chatSessionId: string | null;
  standaloneChatSession: boolean;
  runId: string | null;
  stepId: string | null;
  attemptId: string | null;
  ownerId: string | null;
  browserActorToken: string | null;
};

type SessionState = {
  initialized: boolean;
  protocolVersion: string;
  clientName: string;
  identity: SessionIdentity;
  askUserEvents: number[];
  askUserRateLimit: {
    maxCalls: number;
    windowMs: number;
  };
};

function isUserClientSession(session: SessionState): boolean {
  return !session.identity.runId
    && !session.identity.stepId
    && !session.identity.attemptId
    && !session.identity.chatSessionId;
}

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
    windowsHide: true,
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
        permissionMode: { type: "string", enum: ["default", "auto", "plan", "edit", "full-auto", "config-toml"], default: "default" },
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
        parentLaneId: { type: "string" },
        baseBranch: { type: "string" },
        branchName: { type: "string" },
        linearIssue: LINEAR_ISSUE_TOOL_SCHEMA
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
    name: "start_cli_session",
    description: "Start a tracked ADE Work CLI terminal for an allowlisted provider, using the same launch helpers as desktop and mobile.",
    inputSchema: {
      type: "object",
      required: ["laneId", "provider"],
      additionalProperties: false,
      properties: {
        laneId: { type: "string", minLength: 1 },
        provider: { type: "string", enum: ["claude", "codex", "cursor", "droid", "opencode", "shell"] },
        permissionMode: { type: "string", enum: ["default", "auto", "plan", "edit", "full-auto", "config-toml"], default: "default" },
        title: { type: "string" },
        initialInput: { type: "string" },
        cols: { type: "number", minimum: 20, maximum: 400, default: 120 },
        rows: { type: "number", minimum: 4, maximum: 200, default: 36 },
        model: { type: "string" },
        modelId: { type: "string" },
        reasoningEffort: { type: "string" },
        fastMode: { type: "boolean" },
        codexFastMode: { type: "boolean", deprecated: true },
        cwd: { type: "string" },
        chatSessionId: { type: "string" },
        orchestrationParentSessionId: { type: "string", minLength: 1 },
        spawnKind: { type: "string", enum: ["subagent", "peer"] },
        tracked: { type: "boolean", default: true }
      }
    }
  },
  {
    name: "send_to_session",
    description: "Send text to an ADE Work CLI session. If the session is ended and resumable, ADE starts the provider continuation internally and attaches it to the same durable session.",
    inputSchema: {
      type: "object",
      required: ["sessionId", "text"],
      additionalProperties: false,
      properties: {
        sessionId: { type: "string", minLength: 1 },
        text: { type: "string", minLength: 1 },
        cols: { type: "number", minimum: 20, maximum: 400, default: 120 },
        rows: { type: "number", minimum: 4, maximum: 200, default: 36 }
      }
    }
  },
  {
    name: "get_ade_action_status",
    description: "Check status/progress for long-running ADE actions by operation, test, chat, or PR identifiers.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        operationId: { type: "string", minLength: 1 },
        testRunId: { type: "string", minLength: 1 },
        chatSessionId: { type: "string", minLength: 1 },
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
    description: "Ask the user a question and wait for their answer from an active chat session. Returns explicit outcome fields (`outcome`, `resolved`, `answered`, `declined`, `cancelled`, `timedOut`, `awaitingUserResponse`) so declines/cancels/timeouts cannot be mistaken for a still-pending question.",
    inputSchema: {
      type: "object",
      required: ["title", "body"],
      additionalProperties: false,
      properties: {
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
    description: "Perform a local GUI interaction such as click, type, or keypress.",
    inputSchema: {
      type: "object",
      required: ["action"],
      additionalProperties: false,
      properties: {
        action: { type: "string", enum: ["click", "type", "keypress"] },
        target: { type: "string", enum: ["local"], default: "local" },
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
    description: "Capture a local screenshot/image and store it as visual ADE proof.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        target: { type: "string", enum: ["local"], default: "local" },
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
        callerRoot: { type: "string", description: "Absolute directory that relative input paths are resolved against. Defaults to the agent's workspace root." },
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
    name: "delete_computer_use_artifacts",
    description: "Delete stored proof artifacts: removes the database records and the stored file. Idempotent.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        artifactId: { type: "string", minLength: 1 },
        artifactIds: { type: "array", items: { type: "string", minLength: 1 } },
      }
    }
  },
  {
    name: "list_broken_computer_use_artifacts",
    description: "List proof records whose stored file is missing or was never imported, with the path each can be recovered from when one survives.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        limit: { type: "number", minimum: 1, maximum: 2000, default: 200 },
      }
    }
  },
  {
    name: "prune_broken_computer_use_artifacts",
    description: "Delete every proof record whose file is missing or was never imported.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} }
  },
  {
    name: "recover_computer_use_artifact",
    description: "Re-import a broken proof record's original file when it still exists on disk.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["artifactId"],
      properties: { artifactId: { type: "string", minLength: 1 } }
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
    description: "Pull remote changes into a lane. Defaults to fast-forward only; pass mode rebase or merge for non-ff pull behavior.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        laneId: { type: "string", minLength: 1 },
        mode: { type: "string", enum: ["ff-only", "ff_only", "rebase", "merge"] }
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
    name: "git_undo_last_head_change",
    description: "Reset a lane to the pre-HEAD SHA from the latest successful head-changing git operation recorded by ADE.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        laneId: { type: "string", minLength: 1 }
      }
    }
  },
  {
    name: "git_redo_last_head_change",
    description: "Restore the post-HEAD SHA from the latest successful ADE git undo operation.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        laneId: { type: "string", minLength: 1 }
      }
    }
  },
  {
    name: "git_list_branches",
    description: "List branches visible from a lane checkout, including last commit sha/date/author/subject for each branch.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        laneId: { type: "string", minLength: 1 }
      }
    }
  },
  {
    name: "git_get_user_identity",
    description: "Read the lane checkout's git user.name and user.email config (the identity new commits would be authored under).",
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
        stashRef: { type: "string", minLength: 1 },
        stashOid: { type: "string", minLength: 1 }
      }
    }
  },
  {
    name: "stash_pop",
    description: "Pop a stash onto a lane and remove it from the stash list. Defaults to the current chat lane when laneId is omitted.",
    inputSchema: {
      type: "object",
      required: ["stashRef", "stashOid"],
      additionalProperties: false,
      properties: {
        laneId: { type: "string", minLength: 1 },
        stashRef: { type: "string", minLength: 1 },
        stashOid: { type: "string", minLength: 1 }
      }
    }
  },
  {
    name: "stash_drop",
    description: "Drop a stash from a lane. Defaults to the current chat lane when laneId is omitted.",
    inputSchema: {
      type: "object",
      required: ["stashRef", "stashOid"],
      additionalProperties: false,
      properties: {
        laneId: { type: "string", minLength: 1 },
        stashRef: { type: "string", minLength: 1 },
        stashOid: { type: "string", minLength: 1 }
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
    description: "Create a PR from a lane branch. When omitted, the title defaults to \"source lane -> target lane\" and the body is empty. Returns GitHub and ADE PR URLs when available.",
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
        closeLinearIssueOnMerge: { type: "boolean", default: true },
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
    name: "prs_list_open",
    description: "List every open pull request in the project's GitHub repo as flat BranchPullRequest rows keyed by head branch. Independent of ADE lane state, so it surfaces PRs whose head branch has no local lane.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {}
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
  // ── Observation Tools ────────────────────────────────────────────
  {
    name: "stream_events",
    description: "Poll buffered orchestrator events using a cursor for incremental streaming.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        cursor: { type: "number", minimum: 0 },
        limit: { type: "number", minimum: 1, maximum: 1000 },
        category: { type: "string", enum: ["orchestrator", "dag_mutation", "runtime", "pty"] }
      }
    }
  },
];

const STANDALONE_CHAT_HIDDEN_TOOL_NAMES = new Set([
  "spawn_agent",
]);

const CTO_OPERATOR_TOOL_SPECS: ToolSpec[] = [
  {
    name: "get_cto_state",
    description: "Read the reconstructed CTO identity and recent continuity state maintained by ADE. Prefer this over shell-reading .ade/cto files from the workspace.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        recentLimit: { type: "number", minimum: 0, maximum: 50 }
      }
    }
  },
  {
    name: "saveMemory",
    description: "Save a durable fact to your persistent memory (MEMORY.md) — decisions, preferences, conventions, and standing project context you should remember across sessions and model switches. One crisp sentence per fact; exact duplicates are ignored.",
    inputSchema: {
      type: "object",
      required: ["fact"],
      additionalProperties: false,
      properties: {
        fact: { type: "string", minLength: 1 }
      }
    }
  },
  {
    name: "searchMemory",
    description: "Search your persistent memory (MEMORY.md, thread state, and recent daily logs) for prior context before asking the user to restate something.",
    inputSchema: {
      type: "object",
      required: ["query"],
      additionalProperties: false,
      properties: {
        query: { type: "string", minLength: 1 },
        limit: { type: "number", minimum: 1, maximum: 100 }
      }
    }
  },
  {
    name: "readMemory",
    description: "Read your persistent memory: durable facts (MEMORY.md) and the current thread state.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {}
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
        permissionMode: { type: "string", enum: ["default", "auto", "plan", "edit", "full-auto", "config-toml"] },
        droidPermissionMode: { type: "string", enum: ["read-only", "auto-low", "auto-medium", "auto-high"] },
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
];

const CTO_LINEAR_SYNC_TOOL_SPECS: ToolSpec[] = [
  {
    name: "getLinearQuickView",
    description: "Read a compact Linear workspace, project, and issue quick view through the connected Linear SDK account.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} }
  },
  {
    name: "getLinearIssuePickerData",
    description: "Read the projects, users, and workflow states needed to populate the Linear issue picker for lane creation.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} }
  },
  {
    name: "searchLinearIssues",
    description: "Search Linear issues for the lane Linear-issue picker, filtered by project, team, state, assignee, priority, or text query.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        projectId: { anyOf: [{ type: "string" }, { type: "null" }] },
        projectSlug: { anyOf: [{ type: "string" }, { type: "null" }] },
        teamKey: { anyOf: [{ type: "string" }, { type: "null" }] },
        stateTypes: { type: "array", items: { type: "string" } },
        assigneeId: { anyOf: [{ type: "string" }, { type: "null" }] },
        priority: { anyOf: [{ type: "number" }, { type: "null" }] },
        query: { anyOf: [{ type: "string" }, { type: "null" }] },
        first: { type: "number", minimum: 1, maximum: 50 },
        after: { anyOf: [{ type: "string" }, { type: "null" }] },
        includeArchived: { type: "boolean" }
      }
    }
  },
  {
    name: "getLinearIssueComments",
    description: "Fetch comments on a Linear issue by its ID.",
    inputSchema: {
      type: "object",
      required: ["issueId"],
      additionalProperties: false,
      properties: {
        issueId: { type: "string", minLength: 1 }
      }
    }
  },
];


const CTO_OPERATOR_TOOL_NAMES = new Set(CTO_OPERATOR_TOOL_SPECS.map((tool) => tool.name));
const CTO_LINEAR_SYNC_TOOL_NAMES = new Set(CTO_LINEAR_SYNC_TOOL_SPECS.map((tool) => tool.name));
const DISABLED_ADE_ACTION_DOMAINS = new Set<AdeActionDomain>();

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
];
const READ_ONLY_TOOLS = new Set([
  "check_conflicts",
  "list_ade_actions",
  "get_ade_action_status",
  "stream_events",
  "get_lane_status",
  "get_lane_conflict_state",
  "list_lanes",
  "list_unregistered_lanes",
  "git_get_sync_status",
  "git_list_branches",
  "git_get_user_identity",
  "prs_list_open",
  "generate_commit_message",
  "list_stashes",
  "simulate_integration",
  "get_pr_health",
  "pr_get_checks",
  "pr_get_review_comments",
  "get_cto_state",
  "searchMemory",
  "readMemory",
  "listChats",
  "getChatStatus",
  "readChatTranscript",
  "getLinearQuickView",
  "getLinearIssuePickerData",
  "searchLinearIssues",
  "getLinearIssueComments",
  "get_environment_info",
  "list_computer_use_artifacts",
  "list_broken_computer_use_artifacts",
  "get_computer_use_backend_status",
]);

const MUTATION_TOOLS = new Set([
  "saveMemory",
  "create_lane",
  "delete_computer_use_artifacts",
  "prune_broken_computer_use_artifacts",
  "recover_computer_use_artifact",
  "run_ade_action",
  "start_cli_session",
  "send_to_session",
  "import_lane",
  "merge_lane",
  "git_fetch",
  "git_pull",
  "git_push",
  "git_undo_last_head_change",
  "git_redo_last_head_change",
  "git_checkout_branch",
  "commit_changes",
  "stash_push",
  "stash_apply",
  "stash_pop",
  "stash_drop",
  "stash_clear",
  "run_tests",
  "create_integration",
  "create_pr_from_lane",
  "pr_update_title",
  "pr_update_body",
  "pr_add_comment",
  "rebase_lane",
  "rebase_continue",
  "rebase_abort",
  "pr_rerun_failed_checks",
  "pr_reply_to_review_thread",
  "pr_resolve_review_thread",
  "spawnChat",
  "sendChatMessage",
  "interruptChat",
  "launch_app",
  "interact_gui",
  "screenshot_environment",
  "record_environment",
  "ingest_computer_use_artifacts",
  "spawn_agent"
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

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asPositiveInteger(value: unknown): number | null {
  let parsed = NaN;
  if (typeof value === "number") parsed = value;
  else if (typeof value === "string") parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function prLinkUrls(pr: unknown): { githubUrl?: string; adeUrl?: string } {
  if (!isRecord(pr)) return {};
  const githubUrl = asOptionalTrimmedString(pr.githubUrl);
  const repoOwner = asOptionalTrimmedString(pr.repoOwner);
  const repoName = asOptionalTrimmedString(pr.repoName);
  const prNumber = asPositiveInteger(
    pr.githubPrNumber ?? pr.prNumber ?? pr.number,
  );
  const derivedGithubUrl = repoOwner && repoName && prNumber
    ? `https://github.com/${repoOwner}/${repoName}/pull/${prNumber}`
    : null;
  const adeUrl = repoOwner && repoName && prNumber
    ? buildDeeplink({ kind: "pr", repoOwner, repoName, prNumber })
    : null;
  const resolvedGithubUrl = githubUrl ?? derivedGithubUrl;
  return {
    ...(resolvedGithubUrl ? { githubUrl: resolvedGithubUrl } : {}),
    ...(adeUrl ? { adeUrl } : {}),
  };
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function assertOptionalStringOrNull(value: unknown, field: string): string | null {
  if (value == null) return null;
  if (typeof value !== "string") {
    throw new JsonRpcError(JsonRpcErrorCode.invalidParams, `${field} must be a string or null`);
  }
  return value;
}

function assertStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new JsonRpcError(JsonRpcErrorCode.invalidParams, `${field} must be an array of strings`);
  }
  return [...value];
}

function assertOptionalNumberOrNull(value: unknown, field: string): number | null {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new JsonRpcError(JsonRpcErrorCode.invalidParams, `${field} must be a number or null`);
  }
  return value;
}

function assertNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new JsonRpcError(JsonRpcErrorCode.invalidParams, `${field} must be a number`);
  }
  return value;
}

function assertLinearPriorityLabel(value: unknown, field: string): LaneLinearIssue["priorityLabel"] {
  if (value === "urgent" || value === "high" || value === "normal" || value === "low" || value === "none") {
    return value;
  }
  throw new JsonRpcError(JsonRpcErrorCode.invalidParams, `${field} must be one of: urgent, high, normal, low, none`);
}

function parseLaneLinearIssue(value: unknown, field = "linearIssue"): LaneLinearIssue {
  const issue = safeObject(value);
  if (Object.keys(issue).length === 0) {
    throw new JsonRpcError(JsonRpcErrorCode.invalidParams, `${field} must be an object`);
  }
  return {
    id: assertNonEmptyString(issue.id, `${field}.id`),
    identifier: assertNonEmptyString(issue.identifier, `${field}.identifier`),
    title: assertNonEmptyString(issue.title, `${field}.title`),
    description: assertOptionalStringOrNull(issue.description, `${field}.description`),
    url: assertOptionalStringOrNull(issue.url, `${field}.url`),
    projectId: asTrimmedString(issue.projectId),
    projectSlug: asTrimmedString(issue.projectSlug),
    projectName: assertOptionalStringOrNull(issue.projectName, `${field}.projectName`),
    teamId: assertNonEmptyString(issue.teamId, `${field}.teamId`),
    teamKey: assertNonEmptyString(issue.teamKey, `${field}.teamKey`),
    teamName: assertOptionalStringOrNull(issue.teamName, `${field}.teamName`),
    stateId: assertNonEmptyString(issue.stateId, `${field}.stateId`),
    stateName: assertNonEmptyString(issue.stateName, `${field}.stateName`),
    stateType: assertNonEmptyString(issue.stateType, `${field}.stateType`),
    priority: assertNumber(issue.priority, `${field}.priority`),
    priorityLabel: assertLinearPriorityLabel(issue.priorityLabel, `${field}.priorityLabel`),
    labels: assertStringArray(issue.labels, `${field}.labels`),
    assigneeId: assertOptionalStringOrNull(issue.assigneeId, `${field}.assigneeId`),
    assigneeName: assertOptionalStringOrNull(issue.assigneeName, `${field}.assigneeName`),
    creatorId: assertOptionalStringOrNull(issue.creatorId, `${field}.creatorId`),
    creatorName: assertOptionalStringOrNull(issue.creatorName, `${field}.creatorName`),
    dueDate: assertOptionalStringOrNull(issue.dueDate, `${field}.dueDate`),
    estimate: assertOptionalNumberOrNull(issue.estimate, `${field}.estimate`),
    branchName: assertOptionalStringOrNull(issue.branchName, `${field}.branchName`),
    createdAt: assertNonEmptyString(issue.createdAt, `${field}.createdAt`),
    updatedAt: assertNonEmptyString(issue.updatedAt, `${field}.updatedAt`),
  };
}

function projectLaneLinearIssue(value: unknown): LaneLinearIssue | null {
  if (!value) return null;
  try {
    return parseLaneLinearIssue(value);
  } catch {
    return null;
  }
}

function projectLaneLinearIssueLink(value: unknown): LaneLinearIssueLink | null {
  const link = safeObject(value);
  if (Object.keys(link).length === 0) return null;
  const issue = projectLaneLinearIssue(link.issue);
  if (!issue) return null;
  const role = asOptionalTrimmedString(link.role);
  const source = asOptionalTrimmedString(link.source);
  const laneId = asOptionalTrimmedString(link.laneId);
  const evidenceRecord = safeObject(link.evidence);
  const evidence = Object.keys(evidenceRecord).length
    ? {
        chatSessionId: asOptionalTrimmedString(evidenceRecord.chatSessionId),
        commitSha: asOptionalTrimmedString(evidenceRecord.commitSha),
        prId: asOptionalTrimmedString(evidenceRecord.prId),
      }
    : null;
  return {
    id: asOptionalTrimmedString(link.id) ?? "",
    laneId: laneId ?? "",
    issue,
    role: role === "primary" || role === "worked" || role === "referenced" || role === "inferred"
      ? role
      : "worked",
    source: source === "lane_create"
      || source === "lane_link"
      || source === "chat_attach"
      || source === "linear_open_issue"
      || source === "commit"
      || source === "pr_body"
      || source === "manual"
      ? source
      : "manual",
    includeInPr: link.includeInPr !== false,
    closeOnMerge: link.closeOnMerge === true,
    evidence,
    createdAt: asOptionalTrimmedString(link.createdAt) ?? "",
    updatedAt: asOptionalTrimmedString(link.updatedAt) ?? "",
  };
}

function assertNonEmptyString(value: unknown, field: string): string {
  const text = asTrimmedString(value);
  if (!text.length) {
    throw new JsonRpcError(JsonRpcErrorCode.invalidParams, `${field} is required`);
  }
  return text;
}

function assertComputerUseBackendStyle(value: unknown, field: string): ComputerUseBackendStyle {
  const style = assertNonEmptyString(value, field);
  if (style === "external_cli" || style === "manual" || style === "local_fallback") {
    return style;
  }
  throw new JsonRpcError(JsonRpcErrorCode.invalidParams, `${field} must be one of: external_cli, manual, local_fallback`);
}

function parseCliSessionProvider(value: unknown): LaunchProfile {
  const provider = asTrimmedString(value).toLowerCase();
  if (!isLaunchProfile(provider)) {
    throw new JsonRpcError(
      JsonRpcErrorCode.invalidParams,
      "provider must be one of claude, codex, cursor, droid, opencode, or shell",
    );
  }
  return provider;
}

function parseCliSessionPermissionMode(value: unknown): AgentChatPermissionMode {
  const mode = asTrimmedString(value).toLowerCase();
  if (!mode) return "default";
  if (isTrackedCliPermissionMode(mode)) return mode;
  throw new JsonRpcError(
    JsonRpcErrorCode.invalidParams,
    "permissionMode must be one of default, auto, plan, edit, full-auto, or config-toml",
  );
}

function parseCliSessionSpawnKind(value: unknown): AgentChatSpawnKind | null {
  if (value == null) return null;
  const spawnKind = asTrimmedString(value).toLowerCase();
  if (spawnKind === "subagent" || spawnKind === "peer") {
    return spawnKind;
  }
  throw new JsonRpcError(
    JsonRpcErrorCode.invalidParams,
    "spawnKind must be subagent or peer; silent spawn kind 'none' is no longer supported",
  );
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const raw = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(min, Math.min(max, Math.floor(raw)));
}

function isCliProvider(provider: LaunchProfile): provider is CliProvider {
  return provider !== "shell";
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
      case "chat_session":
      case "automation_run":
      case "github_pr":
      case "linear_issue":
        add(
          normalizedKind,
          ownerId,
          normalizedKind === "github_pr" || normalizedKind === "linear_issue"
            ? "published_to"
            : "attached_to",
        );
        break;
      default:
        throw new JsonRpcError(JsonRpcErrorCode.invalidParams, `Unsupported proof ownerKind: ${rawKind}`);
    }
  };

  addExplicitOwner();
  add("lane", asOptionalTrimmedString(toolArgs.laneId));
  const explicitChatSessionId = asOptionalTrimmedString(toolArgs.chatSessionId);
  if (explicitChatSessionId) {
    add("chat_session", explicitChatSessionId);
  } else if (session.identity.chatSessionId) {
    add("chat_session", session.identity.chatSessionId);
  } else {
    const looksLikeStandaloneChat =
      !session.identity.runId
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

function summarizePrReviewComments(
  prId: string,
  comments: PrComment[],
  reviews: Array<{ reviewer: string; reviewerAvatarUrl: string | null; state: string; body: string | null; submittedAt: string | null }>,
  checks: PrCheck[],
  reviewThreads: PrReviewThread[],
) {
  const actionableIssueComments = comments.filter(isActionablePrIssueComment);
  const unresolvedThreads = reviewThreads.filter((thread) => !thread.isResolved && !thread.isOutdated);
  const actionableThreadCommentCount = unresolvedThreads.reduce((acc, thread) => acc + thread.comments.length, 0);
  const pendingReviews = reviews.filter((review) => review.state === "changes_requested" || review.state === "commented");
  const checkSummary = summarizePrChecks(checks);
  return {
    success: true,
    prId,
    summary: {
      totalComments: comments.length,
      actionableComments: actionableIssueComments.length + actionableThreadCommentCount,
      actionableReviewThreadCount: unresolvedThreads.length,
      reviewsRequiringChanges: pendingReviews.filter((review) => review.state === "changes_requested").length,
      checksStatus: checkSummary.overall,
    },
    reviewThreads: unresolvedThreads.map((thread) => ({
      id: thread.id,
      path: thread.path,
      line: thread.line,
      url: thread.url,
      isResolved: thread.isResolved,
      isOutdated: thread.isOutdated,
      comments: thread.comments.map((comment) => ({
        id: comment.id,
        author: comment.author,
        body: comment.body,
        url: comment.url,
      })),
    })),
    comments: actionableIssueComments.map((comment) => ({
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

function requireAgentChatService(runtime: AdeRuntime): NonNullable<AdeRuntime["agentChatService"]> {
  if (!runtime.agentChatService) {
    throw new JsonRpcError(
      JsonRpcErrorCode.internalError,
      "agentChatService is not available in this ADE runtime configuration",
    );
  }
  return runtime.agentChatService;
}

function requireLinearIssueTracker(runtime: AdeRuntime): NonNullable<AdeRuntime["linearIssueTracker"]> {
  if (!runtime.linearIssueTracker) {
    throw new JsonRpcError(JsonRpcErrorCode.internalError, "linearIssueTracker is not available in this ADE runtime configuration");
  }
  return runtime.linearIssueTracker;
}

async function buildCliLinearConnectionStatus(runtime: AdeRuntime): Promise<LinearConnectionStatus> {
  const credentialStatus = runtime.linearCredentialService?.getStatus() ?? {
    tokenStored: false,
    authMode: null,
    tokenExpiresAt: null,
    oauthConfigured: false,
  };
  const tokenStored = Boolean(credentialStatus.tokenStored);
  if (!runtime.linearIssueTracker || !tokenStored) {
    return {
      tokenStored,
      connected: false,
      viewerId: null,
      viewerName: null,
      checkedAt: nowIso(),
      authMode: credentialStatus.authMode,
      oauthAvailable: credentialStatus.oauthConfigured,
      tokenExpiresAt: credentialStatus.tokenExpiresAt,
      message: tokenStored ? "Linear tracker service unavailable." : "Linear token not configured.",
    };
  }
  try {
    const status = await runtime.linearIssueTracker.getConnectionStatus();
    return {
      tokenStored,
      connected: status.connected,
      viewerId: status.viewerId,
      viewerName: status.viewerName,
      organizationId: status.organizationId ?? null,
      organizationName: status.organizationName ?? null,
      organizationUrlKey: status.organizationUrlKey ?? null,
      organizationLogoUrl: status.organizationLogoUrl ?? null,
      checkedAt: nowIso(),
      authMode: credentialStatus.authMode,
      oauthAvailable: credentialStatus.oauthConfigured,
      tokenExpiresAt: credentialStatus.tokenExpiresAt,
      message: status.message,
    };
  } catch (err) {
    return {
      tokenStored,
      connected: false,
      viewerId: null,
      viewerName: null,
      checkedAt: nowIso(),
      authMode: credentialStatus.authMode,
      oauthAvailable: credentialStatus.oauthConfigured,
      tokenExpiresAt: credentialStatus.tokenExpiresAt,
      message: err instanceof Error && err.message ? err.message : "Linear tracker error",
    };
  }
}

function emptyLinearQuickView(connection: LinearConnectionStatus): CtoLinearQuickView {
  return {
    connection,
    organization: null,
    viewer: null,
    projects: [],
    teams: [],
    assignedIssues: [],
    recentIssues: [],
    fetchedAt: nowIso(),
    sdk: { packageName: "@linear/sdk", surfaces: [] },
  };
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

function canonicalAuthorizationPath(candidate: string): string {
  const resolved = path.resolve(candidate);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function isPathWithinAuthorizedRoot(root: string, candidate: string): boolean {
  try {
    resolvePathWithinRoot(root, candidate, { allowMissing: true });
    return true;
  } catch {
    return false;
  }
}

async function resolveAuthorizedComputerUseIngestRoot(
  runtime: AdeRuntime,
  session: SessionState,
  toolArgs: Record<string, unknown>,
): Promise<{ laneId: string | null; root: string; callerRoot: string }> {
  const requestedLaneId = asOptionalTrimmedString(toolArgs.laneId);
  const sessionLaneId = resolveChatSessionLaneId(runtime, session);
  const projectWideAuthorized = session.identity.role === "cto" && isUserClientSession(session);
  const callerRoot = asOptionalTrimmedString(toolArgs.callerRoot);
  if (callerRoot && !path.isAbsolute(callerRoot)) {
    throw new JsonRpcError(JsonRpcErrorCode.invalidParams, "callerRoot must be an absolute path");
  }
  if (!projectWideAuthorized && requestedLaneId && requestedLaneId !== sessionLaneId) {
    throw new JsonRpcError(
      JsonRpcErrorCode.invalidParams,
      "laneId must match the caller's authorized chat-session lane",
    );
  }
  const inferredLane = !requestedLaneId
    && !sessionLaneId
    && callerRoot
    && isUnboundAdeCliCaller(session)
    ? (await runtime.laneService.list({ includeArchived: false, includeStatus: false }).catch(() => []))
        .flatMap((lane) => {
          const roots = [lane.worktreePath, lane.attachedRootPath]
            .map((root) => asOptionalTrimmedString(root))
            .filter((root): root is string => Boolean(root))
            .map((root) => canonicalAuthorizationPath(root));
          return roots
            .filter((root) => isPathWithinAuthorizedRoot(root, callerRoot))
            .map((root) => ({ laneId: lane.id, root }));
        })
        .sort((left, right) => right.root.length - left.root.length)[0] ?? null
    : null;
  const authorizedLaneId = requestedLaneId ?? sessionLaneId ?? inferredLane?.laneId ?? null;
  const authorizedRoot = authorizedLaneId
    ? inferredLane?.root ?? resolveLaneWorktreePath(runtime, authorizedLaneId)
    : projectWideAuthorized
      ? runtime.projectRoot
      : null;
  if (!authorizedRoot) {
    throw new JsonRpcError(
      JsonRpcErrorCode.invalidParams,
      "Computer-use ingestion requires an authorized lane worktree.",
    );
  }
  if (
    callerRoot
    && !isPathWithinAuthorizedRoot(authorizedRoot, callerRoot)
  ) {
    throw new JsonRpcError(
      JsonRpcErrorCode.invalidParams,
      "callerRoot must be inside the server-authorized lane worktree",
    );
  }
  const canonicalRoot = canonicalAuthorizationPath(authorizedRoot);
  return {
    laneId: authorizedLaneId,
    root: canonicalRoot,
    callerRoot: canonicalAuthorizationPath(callerRoot ?? canonicalRoot),
  };
}

function isProjectWideProofMaintenanceAuthorized(session: SessionState): boolean {
  return (session.identity.role === "cto" && isUserClientSession(session))
    || isUnboundAdeCliCaller(session);
}

function resolveAuthorizedProofOwners(
  runtime: AdeRuntime,
  session: SessionState,
): ComputerUseArtifactOwner[] {
  const owners: ComputerUseArtifactOwner[] = [];
  const add = (kind: ComputerUseArtifactOwner["kind"], id: string | null | undefined) => {
    const normalizedId = asOptionalTrimmedString(id);
    if (!normalizedId) return;
    if (owners.some((owner) => owner.kind === kind && owner.id === normalizedId)) return;
    owners.push({ kind, id: normalizedId, relation: "attached_to" });
  };
  add("chat_session", session.identity.chatSessionId);
  add("lane", resolveChatSessionLaneId(runtime, session));
  add("automation_run", session.identity.runId);
  return owners;
}

function validateComputerUseOwnerClaims(
  runtime: AdeRuntime,
  session: SessionState,
  toolArgs: Record<string, unknown>,
): void {
  if (isProjectWideProofMaintenanceAuthorized(session)) return;
  const authorized = resolveAuthorizedProofOwners(runtime, session);
  const assertAuthorized = (kind: string | null, id: string | null) => {
    if (!kind || !id) return;
    const normalizedKind = kind === "chat" ? "chat_session" : kind === "pr" ? "github_pr" : kind;
    // Publishing proof to an explicitly named PR or Linear issue is a
    // legitimate cross-surface operation. Local ownership must still come
    // from the authenticated session context.
    if (normalizedKind === "github_pr" || normalizedKind === "linear_issue") return;
    if (!authorized.some((owner) => owner.kind === normalizedKind && owner.id === id)) {
      throw new JsonRpcError(
        JsonRpcErrorCode.methodNotFound,
        "Proof owner claims must match the caller's authenticated chat, lane, or automation run.",
      );
    }
  };
  assertAuthorized(asOptionalTrimmedString(toolArgs.ownerKind), asOptionalTrimmedString(toolArgs.ownerId));
  assertAuthorized("lane", asOptionalTrimmedString(toolArgs.laneId));
  assertAuthorized("chat_session", asOptionalTrimmedString(toolArgs.chatSessionId));
  assertAuthorized("automation_run", asOptionalTrimmedString(toolArgs.automationRunId));
  for (const entry of Array.isArray(toolArgs.owners) ? toolArgs.owners : []) {
    const owner = safeObject(entry);
    assertAuthorized(asOptionalTrimmedString(owner.kind), asOptionalTrimmedString(owner.id));
  }
}

function artifactMatchesAuthorizedOwners(
  artifact: {
    laneId?: string | null;
    links?: Array<{ ownerKind?: string; ownerId?: string }>;
  } | null | undefined,
  owners: ComputerUseArtifactOwner[],
): boolean {
  return Boolean(
    owners.some((owner) => owner.kind === "lane" && owner.id === artifact?.laneId)
    || artifact?.links?.some((link) =>
      owners.some((owner) => owner.kind === link.ownerKind && owner.id === link.ownerId)),
  );
}

function listAuthorizedProofArtifactIds(
  runtime: AdeRuntime,
  owners: ComputerUseArtifactOwner[],
): Set<string> {
  const artifactIds = new Set<string>();
  for (const owner of owners) {
    for (const artifact of runtime.computerUseArtifactBrokerService.listArtifacts({
      ownerKind: owner.kind,
      ownerId: owner.id,
      limit: 2000,
    })) {
      artifactIds.add(artifact.id);
    }
  }
  return artifactIds;
}

function branchNameForPrTitle(ref: string | null | undefined): string {
  let value = (ref ?? "").trim();
  value = value.replace(/^refs\/heads\//, "");
  value = value.replace(/^refs\/remotes\//, "");
  value = value.replace(/^origin\//, "");
  return value;
}

async function defaultPrTitleForLane(runtime: AdeRuntime, laneId: string, baseBranch?: string | null): Promise<string> {
  const lanes = await runtime.laneService.list({ includeArchived: false, includeStatus: false }).catch(() => []);
  const sourceLane = lanes.find((lane) => lane.id === laneId) ?? null;
  const laneInfo = (() => {
    try {
      return typeof runtime.laneService.getLaneBaseAndBranch === "function"
        ? runtime.laneService.getLaneBaseAndBranch(laneId)
        : null;
    } catch {
      return null;
    }
  })();
  const sourceName = asOptionalTrimmedString(sourceLane?.name) || laneId;
  const parentLane = sourceLane?.parentLaneId
    ? lanes.find((lane) => lane.id === sourceLane.parentLaneId) ?? null
    : null;
  const primaryLane = lanes.find((lane) => lane.laneType === "primary") ?? null;
  const stableBaseBranch = sourceLane
    ? resolveStableLaneBaseBranch({
        lane: sourceLane,
        parent: parentLane,
        primaryBranchRef: primaryLane?.branchRef ?? runtime.project?.baseRef ?? "main",
      })
    : laneInfo?.baseRef || runtime.project?.baseRef || "main";
  const targetBranch = branchNameForPrTitle(baseBranch || stableBaseBranch || laneInfo?.baseRef || runtime.project?.baseRef || "main");
  const targetLane = targetBranch
    ? lanes.find((lane) => lane.id !== laneId && branchNameForPrTitle(lane.branchRef) === targetBranch)
    : null;
  const targetName = asOptionalTrimmedString(targetLane?.name) || targetBranch || "target";
  return `${sourceName} -> ${targetName}`;
}

function buildAdeInlineGuidanceForLane(laneWorktreePath: string | null | undefined): string {
  return buildAdeCliInlineGuidance(getAdeAgentSkillRootsForPrompt({ cwd: laneWorktreePath ?? undefined }));
}

function resolveRunContextLaneId(_runtime: AdeRuntime, _callerCtx: CallerContext): string | null {
  return null;
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

function isTerminalSessionSummaryLike(value: unknown): value is TerminalSessionSummary {
  if (!isRecord(value)) return false;
  return Boolean(asOptionalTrimmedString(value.id) && asOptionalTrimmedString(value.laneId));
}

/**
 * A caller tried to reach past its own session's scope.
 *
 * These denials are NOT missing capabilities: the action exists and the host
 * implements it — the caller is simply session-bound and may only aim it at
 * itself. They used to be reported as `methodNotFound` / "Unsupported <x>
 * method", which is indistinguishable from an old host that lacks the method,
 * with two real consequences:
 *
 *  - Agents read it as "this runtime can't do that" and reported the capability
 *    as unavailable instead of correcting the target session.
 *  - Clients silently degraded: `adeApi` matches "Unsupported chat method: …"
 *    as a compatibility signal and falls back to a legacy path, so a permission
 *    error quietly took a code path meant for version skew.
 *
 * So scope denials use the policy-denied code, stable structured data, and a
 * message that names the boundary and the way through it. Genuine unsupported-
 * method errors keep the old wording, which is what the legacy-host fallbacks
 * match on — do not reuse it here.
 */
function scopeAccessDenied(
  scopeDescription: string,
  method: string,
  detail?: {
    callerChatSessionId?: string | null;
    requestedSessionId?: string | null;
    alternativeAction?: string | null;
  },
): never {
  const caller = asOptionalTrimmedString(detail?.callerChatSessionId);
  const requested = asOptionalTrimmedString(detail?.requestedSessionId);
  const alternativeAction = asOptionalTrimmedString(detail?.alternativeAction);
  const parts = [`${method} is not permitted for this caller: ${scopeDescription}.`];
  if (caller && requested) {
    parts.push(`Caller session is ${caller}; requested session was ${requested}.`);
  } else if (caller) {
    parts.push(`Caller session is ${caller}.`);
  } else if (requested) {
    parts.push(`Requested session was ${requested}.`);
  }
  if (alternativeAction) {
    parts.push(`To message another session, use ${alternativeAction}.`);
  }
  throw new JsonRpcError(JsonRpcErrorCode.policyDenied, parts.join(" "), {
    kind: "session_scope_denied",
    method,
    callerSessionId: caller,
    requestedSessionId: requested,
    alternativeAction,
  });
}

function ptyAccessDenied(method: string): never {
  scopeAccessDenied("PTY access is limited to the caller's own terminal session and lane", method);
}

function chatAccessDenied(
  method: string,
  detail?: { callerChatSessionId?: string | null; requestedSessionId?: string | null },
): never {
  scopeAccessDenied("chat access is limited to the caller's own chat session", method, {
    ...detail,
    // The one chat action that is deliberately unscoped, so a denied caller has
    // a real next step rather than concluding cross-session work is impossible.
    alternativeAction: "chat.messageSession",
  });
}

function builtInBrowserAccessDenied(method: string): never {
  scopeAccessDenied("built-in browser access is limited to the caller's own session", method);
}

function externalSessionsAccessDenied(method: string): never {
  throw new JsonRpcError(JsonRpcErrorCode.methodNotFound, `Unsupported external sessions method: ${method}`);
}

function listPtySessionsForAuthorization(runtime: AdeRuntime): TerminalSessionSummary[] {
  try {
    const rows = runtime.ptyService.list({});
    return Array.isArray(rows) ? rows.filter(isTerminalSessionSummaryLike) : [];
  } catch {
    return [];
  }
}

function getPtySessionForAuthorization(runtime: AdeRuntime, sessionId: string | null): TerminalSessionSummary | null {
  if (!sessionId) return null;
  try {
    const session = runtime.sessionService.get(sessionId);
    return isTerminalSessionSummaryLike(session) ? session : null;
  } catch {
    return null;
  }
}

function findPtySessionByPtyId(runtime: AdeRuntime, ptyId: string | null): TerminalSessionSummary | null {
  if (!ptyId) return null;
  return listPtySessionsForAuthorization(runtime).find((session) => session.ptyId === ptyId) ?? null;
}

function authorizedPtyLaneIds(runtime: AdeRuntime, session: SessionState): Set<string> {
  const laneIds = new Set<string>();
  const chatLaneId = resolveChatSessionLaneId(runtime, session);
  if (chatLaneId) laneIds.add(chatLaneId);
  const runLaneId = resolveRunContextLaneId(runtime, resolveCallerContext(session));
  if (runLaneId) laneIds.add(runLaneId);
  return laneIds;
}

function isPtySessionAuthorized(runtime: AdeRuntime, session: SessionState, target: TerminalSessionSummary): boolean {
  if (callerHasRoleAtLeast(session.identity.role, "cto")) return true;
  const targetSessionId = asOptionalTrimmedString(target.id);
  const targetLaneId = asOptionalTrimmedString(target.laneId);
  const targetChatSessionId = asOptionalTrimmedString(target.chatSessionId);
  const callerChatSessionId = asOptionalTrimmedString(session.identity.chatSessionId);
  if (
    callerChatSessionId
    && (callerChatSessionId === targetSessionId || callerChatSessionId === targetChatSessionId)
  ) {
    return true;
  }
  return Boolean(targetLaneId && authorizedPtyLaneIds(runtime, session).has(targetLaneId));
}

function ensurePtyCreateAuthorized(
  runtime: AdeRuntime,
  session: SessionState,
  method: string,
  ptyArgs: Record<string, unknown>,
): void {
  if (callerHasRoleAtLeast(session.identity.role, "cto")) return;
  const laneId = asOptionalTrimmedString(ptyArgs.laneId);
  const requestedChatSessionId = asOptionalTrimmedString(ptyArgs.chatSessionId);
  const callerChatSessionId = asOptionalTrimmedString(session.identity.chatSessionId);
  if (requestedChatSessionId && requestedChatSessionId !== callerChatSessionId) {
    ptyAccessDenied(method);
  }
  if (!laneId || !authorizedPtyLaneIds(runtime, session).has(laneId)) {
    ptyAccessDenied(method);
  }
}

function ensurePtyTargetAuthorized(
  runtime: AdeRuntime,
  session: SessionState,
  method: string,
  ptyArgs: Record<string, unknown>,
): void {
  if (callerHasRoleAtLeast(session.identity.role, "cto")) return;
  const ptyId = asOptionalTrimmedString(ptyArgs.ptyId);
  const sessionId = asOptionalTrimmedString(ptyArgs.sessionId);
  const target = findPtySessionByPtyId(runtime, ptyId) ?? getPtySessionForAuthorization(runtime, sessionId);
  if (!target || !isPtySessionAuthorized(runtime, session, target)) {
    ptyAccessDenied(method);
  }
}

function listAuthorizedPtySessions(
  runtime: AdeRuntime,
  session: SessionState,
  method: string,
  ptyArgs: Record<string, unknown>,
): TerminalSessionSummary[] {
  if (callerHasRoleAtLeast(session.identity.role, "cto")) {
    return runtime.ptyService.list(ptyArgs as Parameters<typeof runtime.ptyService.list>[0]);
  }

  const callerChatSessionId = asOptionalTrimmedString(session.identity.chatSessionId);
  const laneIds = authorizedPtyLaneIds(runtime, session);
  const requestedLaneId = extractLaneId(ptyArgs);
  if (requestedLaneId && !laneIds.has(requestedLaneId)) {
    ptyAccessDenied(method);
  }
  if (!callerChatSessionId && !laneIds.size) {
    ptyAccessDenied(method);
  }

  const scopedArgs = { ...ptyArgs };
  if (!requestedLaneId && laneIds.size === 1) {
    scopedArgs.laneId = [...laneIds][0];
  }
  return runtime.ptyService
    .list(scopedArgs as Parameters<typeof runtime.ptyService.list>[0])
    .filter((target) => isPtySessionAuthorized(runtime, session, target));
}

function requireObjectArgsForScopedAdeAction(
  domain: string,
  action: string,
  argsList: unknown[] | null,
  hasScalarArg: boolean,
  rawObjectArgs: Record<string, unknown>,
): Record<string, unknown> {
  if (argsList || hasScalarArg) {
    ptyAccessDenied(`run_ade_action:${domain}.${action}`);
  }
  return rawObjectArgs;
}

function authorizePtyAdeActionInvocation(
  runtime: AdeRuntime,
  session: SessionState,
  action: string,
  ptyArgs: Record<string, unknown>,
): void {
  const method = `run_ade_action:pty.${action}`;
  switch (action) {
    case "create":
      ensurePtyCreateAuthorized(runtime, session, method, ptyArgs);
      return;
    case "sendToSession":
    case "resumeSession":
    case "write":
    case "resize":
    case "dispose":
      ensurePtyTargetAuthorized(runtime, session, method, ptyArgs);
      return;
    default:
      ptyAccessDenied(method);
  }
}

function scopeTerminalChatArgs(
  runtime: AdeRuntime,
  session: SessionState,
  method: string,
  terminalArgs: Record<string, unknown>,
): Record<string, unknown> {
  const scopedArgs = { ...terminalArgs };
  const callerChatSessionId = asOptionalTrimmedString(session.identity.chatSessionId);
  const requestedChatSessionId = asOptionalTrimmedString(scopedArgs.chatSessionId);
  const requestedLaneId = extractLaneId(scopedArgs);
  if (requestedChatSessionId && requestedChatSessionId !== callerChatSessionId) {
    ptyAccessDenied(method);
  }
  if (requestedLaneId && !authorizedPtyLaneIds(runtime, session).has(requestedLaneId)) {
    ptyAccessDenied(method);
  }
  if (!requestedChatSessionId && callerChatSessionId) {
    scopedArgs.chatSessionId = callerChatSessionId;
  } else if (!requestedChatSessionId) {
    ptyAccessDenied(method);
  }
  return scopedArgs;
}

function scopeTerminalListArgs(
  runtime: AdeRuntime,
  session: SessionState,
  method: string,
  terminalArgs: Record<string, unknown>,
): Record<string, unknown> {
  const scopedArgs = { ...terminalArgs };
  const callerChatSessionId = asOptionalTrimmedString(session.identity.chatSessionId);
  const requestedChatSessionId = asOptionalTrimmedString(scopedArgs.chatSessionId);
  const requestedLaneId = extractLaneId(scopedArgs);
  const laneIds = authorizedPtyLaneIds(runtime, session);
  if (requestedChatSessionId && requestedChatSessionId !== callerChatSessionId) {
    ptyAccessDenied(method);
  }
  if (requestedLaneId && !laneIds.has(requestedLaneId)) {
    ptyAccessDenied(method);
  }
  if (!requestedChatSessionId && callerChatSessionId) {
    scopedArgs.chatSessionId = callerChatSessionId;
  } else if (!requestedLaneId && laneIds.size === 1) {
    scopedArgs.laneId = [...laneIds][0];
  } else if (!requestedChatSessionId && !requestedLaneId) {
    ptyAccessDenied(method);
  }
  return scopedArgs;
}

function scopeTerminalTargetArgs(
  runtime: AdeRuntime,
  session: SessionState,
  method: string,
  terminalArgs: Record<string, unknown>,
): Record<string, unknown> {
  const scopedArgs = { ...terminalArgs };
  const callerChatSessionId = asOptionalTrimmedString(session.identity.chatSessionId);
  const requestedChatSessionId = asOptionalTrimmedString(scopedArgs.chatSessionId);
  const terminalId = asOptionalTrimmedString(scopedArgs.terminalId);
  const ptyId = asOptionalTrimmedString(scopedArgs.ptyId);

  if (requestedChatSessionId && requestedChatSessionId !== callerChatSessionId) {
    ptyAccessDenied(method);
  }
  if (!requestedChatSessionId && !terminalId && !ptyId && callerChatSessionId) {
    scopedArgs.chatSessionId = callerChatSessionId;
  }
  if (terminalId || ptyId) {
    ensurePtyTargetAuthorized(runtime, session, method, {
      ...(terminalId ? { sessionId: terminalId } : {}),
      ...(ptyId ? { ptyId } : {}),
    });
    return scopedArgs;
  }
  if (asOptionalTrimmedString(scopedArgs.chatSessionId) !== callerChatSessionId || !callerChatSessionId) {
    ptyAccessDenied(method);
  }
  return scopedArgs;
}

function scopeTerminalAdeActionArgs(
  runtime: AdeRuntime,
  session: SessionState,
  action: string,
  terminalArgs: Record<string, unknown>,
): Record<string, unknown> {
  const method = `run_ade_action:terminal.${action}`;
  switch (action) {
    case "list":
      return scopeTerminalListArgs(runtime, session, method, terminalArgs);
    case "activeForChat":
    case "reattachChatCli":
      return scopeTerminalChatArgs(runtime, session, method, terminalArgs);
    case "read":
    case "preview":
    case "write":
    case "resize":
    case "signal":
      return scopeTerminalTargetArgs(runtime, session, method, terminalArgs);
    default:
      ptyAccessDenied(method);
  }
}

const SCOPED_CHAT_ACTIONS = new Set([
  "getChatEventHistory",
  "getChatEventHistoryPage",
  "sendMessage",
  "createScheduledWork",
  "listScheduledWork",
  "getScheduledWorkState",
  "cancelScheduledWork",
  "setScheduledWorkPaused",
  "requestSessionAttention",
  "setSessionStatusNote",
  // `settleSelfSession` / `unsettleSelfSession` used to be scoped here so a
  // bound agent could only settle its OWN row. Both actions were removed in
  // 2026-07: "is this work finished" is a subjective judgment agents are
  // unreliable at, so the surviving settle writers (`session.settleSession`,
  // `session.unsettleSession`, the bulk pair, `session.setSettleOverride`) are
  // all CTO-only and refuse a session-bound agent outright — no scoping needed.
  "interrupt",
  "interruptWithQueueMode",
  "restoreCancelledQueue",
]);

function scopeChatAdeActionArgs(
  session: SessionState,
  action: string,
  chatArgs: Record<string, unknown>,
  domain: "chat" | "session" = "chat",
): Record<string, unknown> {
  const method = `run_ade_action:${domain}.${action}`;
  if (!SCOPED_CHAT_ACTIONS.has(action)) return chatArgs;
  if (isUnboundAdeCliCaller(session)) return chatArgs;

  const scopedArgs = { ...chatArgs };
  const callerChatSessionId = asOptionalTrimmedString(session.identity.chatSessionId);
  const requestedSessionId = asOptionalTrimmedString(scopedArgs.sessionId);
  if (session.identity.role === "external" && !callerChatSessionId) {
    if (action === "sendMessage") return scopedArgs;
    chatAccessDenied(method, { callerChatSessionId, requestedSessionId });
  }

  if (!callerChatSessionId || (requestedSessionId && requestedSessionId !== callerChatSessionId)) {
    chatAccessDenied(method, { callerChatSessionId, requestedSessionId });
  }
  if (!requestedSessionId) scopedArgs.sessionId = callerChatSessionId;
  return scopedArgs;
}

function withTrustedSpawnDispatchMetadata(
  runtime: AdeRuntime,
  session: SessionState,
  chatArgs: Record<string, unknown>,
): Record<string, unknown> {
  const callerSessionId = asOptionalTrimmedString(session.identity.chatSessionId);
  const targetSessionId = asOptionalTrimmedString(chatArgs.sessionId);
  const existingMetadata = isRecord(chatArgs.metadata) ? { ...chatArgs.metadata } : {};
  // This marker controls whether a child completion may wake another agent.
  // Never trust caller-supplied provenance; derive it from the bound session
  // and the target's persisted direct-parent relationship.
  delete existingMetadata.spawnDispatch;
  const targetSession = targetSessionId ? runtime.sessionService.get(targetSessionId) : null;
  const targetParentSessionId = asOptionalTrimmedString(
    targetSession?.orchestrationParentSessionId,
  );
  if (callerSessionId && targetParentSessionId === callerSessionId) {
    existingMetadata.spawnDispatch = {
      parentSessionId: callerSessionId,
      dispatchedAt: new Date().toISOString(),
    };
  }
  if (!Object.keys(existingMetadata).length) {
    const { metadata: _metadata, ...withoutMetadata } = chatArgs;
    return withoutMetadata;
  }
  return { ...chatArgs, metadata: existingMetadata };
}

/** Search is a machine-readable discovery surface. Drop the old internal-only
 * callerScope field at the RPC edge so bound agents and unbound shells receive
 * the same project-wide results and cannot accidentally request silent scope
 * filtering. The multi-project router aggregates registered-project results. */
function scopeSearchAdeActionArgs(
  _session: SessionState,
  searchArgs: Record<string, unknown>,
): Record<string, unknown> {
  const { callerScope: _callerScope, ...unscopedArgs } = searchArgs;
  return unscopedArgs;
}

function scopeBuiltInBrowserAdeActionArgs(
  session: SessionState,
  action: string,
  browserArgs: Record<string, unknown>,
): Record<string, unknown> {
  const callerChatSessionId = asOptionalTrimmedString(session.identity.chatSessionId);
  const method = `run_ade_action:built_in_browser.${action}`;
  const browserActorToken = asOptionalTrimmedString(session.identity.browserActorToken);
  if (!callerChatSessionId || !browserActorToken) {
    builtInBrowserAccessDenied(method);
  }
  if (
    action === "getProfileDiagnostics"
    || action === "listPermissions"
    || action === "clearPermissions"
  ) {
    builtInBrowserAccessDenied(method);
  }
  const requestedChatSessionId = asOptionalTrimmedString(browserArgs.chatSessionId);
  if (requestedChatSessionId && requestedChatSessionId !== callerChatSessionId) {
    builtInBrowserAccessDenied(method);
  }
  if (browserArgs.force === true) {
    builtInBrowserAccessDenied(method);
  }

  // The capability registry intentionally lives only in Electron, where chat
  // and terminal launches issue and revoke tokens. The separate runtime strips
  // caller routing and carries the opaque token over its authenticated bridge;
  // desktopBridgeServer performs the authoritative lookup and scope restore.
  return {
    ...browserArgs,
    chatSessionId: callerChatSessionId,
    laneId: undefined,
    projectRoot: undefined,
    tabCollection: undefined,
    force: false,
    [BUILT_IN_BROWSER_ACTOR_CAPABILITY_PARAM]: browserActorToken,
  };
}

const EXTERNAL_SESSION_AUTH_FIND_LIMIT = 500;
const EXTERNAL_SESSION_PROVIDER_NAMES = new Set<string>(["claude", "codex", "cursor", "droid", "opencode"]);

function isExternalSessionProviderName(value: string | null): value is ExternalSessionProvider {
  return Boolean(value && EXTERNAL_SESSION_PROVIDER_NAMES.has(value));
}

function isUnboundAdeCliCaller(session: SessionState): boolean {
  // `ade actions run` is a local user-facing escape hatch. Unlike an agent
  // launched inside Work, it has no chat/run lane binding, so applying the
  // bound-agent scope here would make the documented external-session actions
  // unreachable. The caller id is minted by cli.ts for the direct `ade` client.
  const caller = resolveCallerContext(session);
  return (caller.role === "agent" || caller.role === "orchestrator")
    && /^ade-cli:\d+$/.test(caller.callerId ?? "")
    && !caller.chatSessionId
    && !caller.runId
    && !caller.stepId
    && !caller.attemptId
    && !caller.ownerId;
}

function realishPath(filePath: string): string {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function isPathInsideOrEqual(parent: string, candidate: string): boolean {
  const relative = path.relative(realishPath(parent), realishPath(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function authorizedExternalSessionsLaneId(
  runtime: AdeRuntime,
  session: SessionState,
  method: string,
  externalArgs: Record<string, unknown>,
): string {
  const laneIds = authorizedPtyLaneIds(runtime, session);
  const requestedLaneId = extractLaneId(externalArgs);
  if (requestedLaneId) {
    if (!laneIds.has(requestedLaneId)) externalSessionsAccessDenied(method);
    return requestedLaneId;
  }
  if (laneIds.size === 1) return [...laneIds][0]!;
  externalSessionsAccessDenied(method);
}

function resolveAuthorizedExternalSessionsLane(
  runtime: AdeRuntime,
  session: SessionState,
  method: string,
  externalArgs: Record<string, unknown>,
): { laneId: string; laneCwd: string } {
  const laneId = authorizedExternalSessionsLaneId(runtime, session, method, externalArgs);
  const laneCwd = resolveLaneWorktreePath(runtime, laneId);
  if (!laneCwd) externalSessionsAccessDenied(method);
  return { laneId, laneCwd: realishPath(laneCwd) };
}

function isExternalSessionSummaryLike(value: unknown): value is ExternalSessionSummary {
  if (!isRecord(value)) return false;
  const provider = asOptionalTrimmedString(value.provider);
  return Boolean(isExternalSessionProviderName(provider) && asOptionalTrimmedString(value.id));
}

function filterExternalSessionSummariesForLane(result: unknown, laneCwd: string): unknown {
  if (!Array.isArray(result)) return result;
  return result.filter((session) => {
    if (!isExternalSessionSummaryLike(session)) return false;
    const cwd = asOptionalTrimmedString(session.cwd);
    return Boolean(cwd && isPathInsideOrEqual(laneCwd, cwd));
  });
}

function scopeExternalSessionsListArgs(
  runtime: AdeRuntime,
  session: SessionState,
  listArgs: Record<string, unknown>,
): { scopedArgs: Record<string, unknown>; laneCwd: string } {
  const method = "run_ade_action:external-sessions.list";
  const { laneId, laneCwd } = resolveAuthorizedExternalSessionsLane(runtime, session, method, listArgs);
  return {
    scopedArgs: {
      ...listArgs,
      laneId,
      cwd: laneCwd,
      scope: "project",
    },
    laneCwd,
  };
}

function externalSessionImportUsesSourceRunCwd(provider: ExternalSessionProvider, mode: string): boolean {
  if (mode === "resume") return provider !== "codex";
  if (mode === "fork") return provider === "opencode";
  return false;
}

async function findExternalSessionSummaryForAuthorization(
  runtime: AdeRuntime,
  method: string,
  provider: ExternalSessionProvider,
  sessionId: string,
  laneId: string,
  laneCwd: string,
): Promise<ExternalSessionSummary | null> {
  const externalSessionsService = runtime.externalSessionsService;
  if (!externalSessionsService) externalSessionsAccessDenied(method);
  const sessions = await externalSessionsService.list({
    providers: [provider],
    laneId,
    cwd: laneCwd,
    scope: "project",
    limit: EXTERNAL_SESSION_AUTH_FIND_LIMIT,
  });
  return sessions.find((session) => session.id === sessionId) ?? null;
}

async function scopeExternalSessionsImportArgs(
  runtime: AdeRuntime,
  session: SessionState,
  importArgs: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const method = "run_ade_action:external-sessions.import";
  const { laneId, laneCwd } = resolveAuthorizedExternalSessionsLane(runtime, session, method, importArgs);
  const scopedArgs: Record<string, unknown> = { ...importArgs, laneId };
  delete scopedArgs.enforceLaneScopeCwd;
  const provider = asOptionalTrimmedString(scopedArgs.provider);
  const mode = asOptionalTrimmedString(scopedArgs.mode);
  const target = asOptionalTrimmedString(scopedArgs.target);
  const sessionId = asOptionalTrimmedString(scopedArgs.sessionId);
  scopedArgs.enforceLaneScopeCwd = laneCwd;
  const targetChatUsesSourceCwd = target === "chat" && (provider === "claude" || provider === "codex");
  if (
    (targetChatUsesSourceCwd || target === "cli")
    && isExternalSessionProviderName(provider)
    && mode
    && sessionId
    && (targetChatUsesSourceCwd || externalSessionImportUsesSourceRunCwd(provider, mode))
  ) {
    const summary = await findExternalSessionSummaryForAuthorization(
      runtime,
      method,
      provider,
      sessionId,
      laneId,
      laneCwd,
    );
    const runCwd = asOptionalTrimmedString(summary?.cwd);
    if (!runCwd || !isPathInsideOrEqual(laneCwd, runCwd)) externalSessionsAccessDenied(method);
  }
  return scopedArgs;
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
    prService: runtime.prService ?? null,
    fileService: runtime.fileService ?? null,
    issueTracker: runtime.linearIssueTracker ?? null,
    ctoMemoryService: runtime.ctoMemoryService ?? null,
    listChats: agentChatService.listSessions,
    getChatStatus: agentChatService.getSessionSummary,
    getChatTranscript: agentChatService.getChatTranscript,
    createChat: agentChatService.createSession,
    updateChatSession: agentChatService.updateSession,
    sendChatMessage: agentChatService.sendMessage,
    interruptChat: async (args) => {
      await agentChatService.interrupt(args);
    },
    steerChat: ({ sessionId, instruction }) => agentChatService.steer({ sessionId, text: instruction }),
    cancelSteer: ({ sessionId, steerId }) => agentChatService.cancelSteer({ sessionId, steerId }),
    listSubagents: ({ sessionId }) => agentChatService.listSubagents({ sessionId }),
    approveToolUse: ({ sessionId, toolUseId, decision }) =>
      agentChatService.approveToolUse({ sessionId, itemId: toolUseId, decision }),
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

type SpawnPermissionMode = "default" | "auto" | "plan" | "edit" | "full-auto" | "config-toml";

function parseSpawnPermissionMode(value: unknown): SpawnPermissionMode {
  const normalized = asTrimmedString(value).toLowerCase();
  if (normalized === "auto" || normalized === "plan" || normalized === "edit" || normalized === "full-auto" || normalized === "config-toml") return normalized;
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
    runContext: {
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
  const linearIssueLinks = Array.isArray(lane.linearIssueLinks)
    ? lane.linearIssueLinks
        .map(projectLaneLinearIssueLink)
        .filter((link): link is LaneLinearIssueLink => Boolean(link))
    : [];
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
    linearIssue: projectLaneLinearIssue(lane.linearIssue),
    linearIssueLinks,
    status: lane.status
  };
}

/**
 * Caller context resolved from environment variables.
 * Worker-like callers can provide ADE_RUN_ID/ADE_STEP_ID/ADE_ATTEMPT_ID
 * set in their environment. These provide automatic identity and context defaults.
 */
type CallerContext = {
  callerId: string | null;
  role: SessionIdentity["role"] | null;
  chatSessionId: string | null;
  standaloneChatSession: boolean;
  runId: string | null;
  stepId: string | null;
  attemptId: string | null;
  ownerId: string | null;
};

function resolveEnvCallerContext(): CallerContext {
  const envRole = normalizeAdeRuntimeRole(process.env.ADE_DEFAULT_ROLE);
  const envChatSessionId = process.env.ADE_CHAT_SESSION_ID?.trim() || null;
  const envRunId = process.env.ADE_RUN_ID?.trim() || null;
  const envStepId = process.env.ADE_STEP_ID?.trim() || null;
  const envAttemptId = process.env.ADE_ATTEMPT_ID?.trim() || null;
  return {
    callerId: envChatSessionId ?? envAttemptId ?? null,
    role: envRole
      ? resolveSessionBoundRole({
          defaultRole: envRole,
          requestedRole: null,
          chatSessionId: envChatSessionId,
        })
      : null,
    chatSessionId: envChatSessionId,
    standaloneChatSession: Boolean(envChatSessionId) && !envRunId && !envStepId && !envAttemptId,
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
    chatSessionId: session.identity.chatSessionId ?? envContext.chatSessionId,
    standaloneChatSession: session.identity.standaloneChatSession,
    runId: session.identity.runId ?? envContext.runId,
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

function isToolHiddenForStandaloneChat(name: string, callerCtx: CallerContext): boolean {
  return callerCtx.standaloneChatSession && STANDALONE_CHAT_HIDDEN_TOOL_NAMES.has(name);
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
  const keepVisibleTool = (tool: ToolSpec): boolean => (
    (!shouldHideLocalComputerUse || !LOCAL_COMPUTER_USE_TOOL_NAMES.has(tool.name))
  );
  const visibleBaseTools = TOOL_SPECS.filter(keepVisibleTool);
  const allVisibleTools = callerCtx.role === "cto"
    ? [...visibleBaseTools, ...CTO_OPERATOR_TOOL_SPECS, ...CTO_LINEAR_SYNC_TOOL_SPECS]
    : visibleBaseTools;

  return allVisibleTools.filter((tool) => !isToolHiddenForStandaloneChat(tool.name, callerCtx));
}

function parseInitializeIdentity(_runtime: AdeRuntime, params: unknown): SessionIdentity {
  const data = safeObject(params);
  const identity = safeObject(data.identity);
  const envContext = resolveEnvCallerContext();
  const requestedRole = normalizeAdeRuntimeRole(identity.role);
  const requestedChatSessionId = asOptionalTrimmedString(identity.chatSessionId);
  const resolvedChatSessionId = envContext.chatSessionId ?? requestedChatSessionId;
  const validRole = resolveSessionBoundRole({
    defaultRole: normalizeAdeRuntimeRole(process.env.ADE_DEFAULT_ROLE),
    requestedRole,
    chatSessionId: resolvedChatSessionId,
  });
  const resolvedRunId = envContext.runId ?? asOptionalTrimmedString(identity.runId);
  const resolvedStepId = envContext.stepId ?? asOptionalTrimmedString(identity.stepId);
  const resolvedAttemptId = envContext.attemptId ?? asOptionalTrimmedString(identity.attemptId);
  // Browser actor capabilities belong to the connecting CLI process. The
  // long-lived runtime daemon must never lend an inherited token to another
  // client, even if it was accidentally launched from an agent-owned shell.
  const browserActorToken = asOptionalTrimmedString(identity.browserActorToken);

  const standaloneChatSession = Boolean(resolvedChatSessionId)
    && !resolvedRunId
    && !resolvedStepId
    && !resolvedAttemptId;

  return {
    callerId: asOptionalTrimmedString(identity.callerId) ?? resolvedChatSessionId ?? envContext.attemptId ?? "unknown",
    role: validRole,
    chatSessionId: resolvedChatSessionId,
    standaloneChatSession,
    runId: resolvedRunId,
    stepId: resolvedStepId,
    attemptId: resolvedAttemptId,
    ownerId: asOptionalTrimmedString(identity.ownerId) ?? envContext.ownerId,
    browserActorToken,
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
      const logTail = await runtime.ptyService.readTranscriptTail({
        sessionId,
        maxBytes: maxLogBytes,
        raw: true,
        alignToLineBoundary: true,
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
      ? await runtime.ptyService.readTranscriptTail({
          sessionId,
          maxBytes: maxLogBytes,
          raw: true,
          alignToLineBoundary: true,
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
      windowsHide: true,
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
    validateComputerUseOwnerClaims(runtime, args.sessionState, args.toolArgs);
    const result = runtime.computerUseArtifactBrokerService.ingest({
      backend: {
        name: "screencapture",
        style: "local_fallback",
        toolName: args.toolName,
      },
      inputs: [
        {
          kind: args.kind,
          title: args.title,
          path: args.artifactPath,
          mimeType: args.mimeType,
          metadata: args.metadata,
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

    if (name === "getLinearQuickView") {
      const connection = await buildCliLinearConnectionStatus(runtime);
      if (!connection.connected) return emptyLinearQuickView(connection);
      try {
        return await requireLinearIssueTracker(runtime).getQuickView(connection);
      } catch (err) {
        return emptyLinearQuickView({
          ...connection,
          connected: false,
          viewerId: null,
          viewerName: null,
          checkedAt: nowIso(),
          message: err instanceof Error && err.message ? err.message : "Linear tracker error",
        });
      }
    }

    if (name === "getLinearIssuePickerData") {
      const tracker = requireLinearIssueTracker(runtime);
      const [projects, users, states] = await Promise.all([
        tracker.listProjects().catch(() => []),
        tracker.listUsers().catch(() => []),
        tracker.listWorkflowStates().catch(() => []),
      ]);
      return { projects, users, states };
    }

    if (name === "searchLinearIssues") {
      const tracker = requireLinearIssueTracker(runtime);
      const stateTypes = Array.isArray(toolArgs.stateTypes)
        ? assertStringArray(toolArgs.stateTypes, "stateTypes")
        : [];
      let first = 50;
      if (toolArgs.first !== undefined && toolArgs.first !== null) {
        if (typeof toolArgs.first !== "number" || !Number.isFinite(toolArgs.first) || !Number.isInteger(toolArgs.first) || toolArgs.first <= 0) {
          throw new JsonRpcError(
            JsonRpcErrorCode.invalidParams,
            "first must be a positive integer (1-50)",
          );
        }
        first = Math.min(50, toolArgs.first);
      }
      return await tracker.searchIssues({
        projectId: assertOptionalStringOrNull(toolArgs.projectId ?? null, "projectId"),
        projectSlug: assertOptionalStringOrNull(toolArgs.projectSlug ?? null, "projectSlug"),
        teamKey: assertOptionalStringOrNull(toolArgs.teamKey ?? null, "teamKey"),
        stateTypes,
        assigneeId: assertOptionalStringOrNull(toolArgs.assigneeId ?? null, "assigneeId"),
        priority: assertOptionalNumberOrNull(toolArgs.priority ?? null, "priority"),
        query: assertOptionalStringOrNull(toolArgs.query ?? null, "query"),
        first,
        after: assertOptionalStringOrNull(toolArgs.after ?? null, "after"),
        includeArchived: asBoolean(toolArgs.includeArchived, false),
      });
    }

    if (name === "getLinearIssueComments") {
      const issueId = assertNonEmptyString(toolArgs.issueId, "issueId");
      const tracker = requireLinearIssueTracker(runtime);
      return await tracker.fetchIssueComments(issueId);
    }

    throw new JsonRpcError(JsonRpcErrorCode.methodNotFound, `Unsupported tool: ${name}`);
  }

  if (name === "list_ade_actions") {
    const domain = asOptionalTrimmedString(toolArgs.domain) ?? "all";
    const services = getAdeActionDomainServices(runtime);
    const domains = domain === "all"
      ? (Object.keys(services) as AdeActionDomain[])
      : [domain as AdeActionDomain];
    const exposedDomains = domains.filter((entry) => !DISABLED_ADE_ACTION_DOMAINS.has(entry));
    const callerIsCto = callerHasRoleAtLeast(callerCtx.role, "cto");
    const isUserClient = isUserClientSession(session);
    const actions = exposedDomains.flatMap((entry) => {
      const service = services[entry];
      if (!service) return [];
      return listAllowedAdeActionNames(entry, service)
        .filter((action) => callerIsCto || !isCtoOnlyAdeAction(entry, action))
        .filter((action) => entry !== "analytics" || action !== "capture" || isUserClient)
        .map((action) => {
          const contract = getAdeActionInputContract(entry, action);
          return {
            domain: entry,
            action,
            name: `${entry}.${action}`,
            ...(contract?.description ? { description: contract.description } : {}),
            ...(contract?.input ? { input: contract.input } : {}),
            ...(contract?.example ? { example: contract.example } : {}),
            usage: `ade actions run ${entry}.${action} --input-json '{"key":"value"}' (or --scalar value / --args-list-json '[...]' for scalar or positional service methods)`,
          };
        });
    });
    return {
      count: actions.length,
      actions,
    };
  }

  if (name === "run_ade_action") {
    const domain = assertNonEmptyString(toolArgs.domain, "domain") as AdeActionDomain;
    const action = assertNonEmptyString(toolArgs.action, "action");
    if (DISABLED_ADE_ACTION_DOMAINS.has(domain)) {
      throw new JsonRpcError(JsonRpcErrorCode.invalidParams, `Domain '${domain}' is unavailable in this runtime.`);
    }
    const services = getAdeActionDomainServices(runtime);
    const service = services[domain];
    if (!service) {
      throw new JsonRpcError(JsonRpcErrorCode.invalidParams, `Domain '${domain}' is unavailable in this runtime.`);
    }
    let callable = service[action];
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
    const callerIsCto = callerHasRoleAtLeast(callerCtx.role, "cto");
    let scopedObjectArgs = rawObjectArgs;
    let scopedResultHandled = false;
    let result: unknown;
    const isUserClient = isUserClientSession(session);
    if (domain === "analytics" && action === "capture") {
      if (!isUserClient) {
        throw new JsonRpcError(
          JsonRpcErrorCode.invalidParams,
          "Product analytics capture is reserved for authenticated ADE user clients.",
        );
      }
      if (argsList || hasScalarArg) {
        throw new JsonRpcError(JsonRpcErrorCode.invalidParams, "analytics.capture requires object arguments.");
      }
      const {
        projectId: _untrustedProjectId,
        dedupeKey,
        ...safeAnalyticsArgs
      } = rawObjectArgs;
      const surface = usageClientSurfaceFromRpcName(session.clientName);
      scopedObjectArgs = {
        ...safeAnalyticsArgs,
        surface,
        projectId: runtime.projectId,
        ...(safeAnalyticsArgs.event === "ade_project_opened"
          ? { dedupeKey: `${surface}_project_opened:${runtime.projectId}` }
          : { dedupeKey }),
      };
    }
    if (domain === "chat" && (action === "readTranscript" || action === "readTranscriptPage")) {
      const chatArgs = requireObjectArgsForScopedAdeAction(
        domain,
        action,
        argsList,
        hasScalarArg,
        rawObjectArgs,
      );
      const callerSessionId = asOptionalTrimmedString(session.identity.chatSessionId);
      scopedObjectArgs = asOptionalTrimmedString(chatArgs.sessionId) || !callerSessionId
        ? chatArgs
        : { ...chatArgs, sessionId: callerSessionId };
    } else if (domain === "chat" && action === "messageSession") {
      scopedObjectArgs = withTrustedSpawnDispatchMetadata(
        runtime,
        session,
        requireObjectArgsForScopedAdeAction(domain, action, argsList, hasScalarArg, rawObjectArgs),
      );
    } else if (!callerIsCto && domain === "pty") {
      scopedObjectArgs = requireObjectArgsForScopedAdeAction(domain, action, argsList, hasScalarArg, rawObjectArgs);
      if (action === "list") {
        result = listAuthorizedPtySessions(runtime, session, `run_ade_action:pty.${action}`, scopedObjectArgs);
        scopedResultHandled = true;
      } else {
        authorizePtyAdeActionInvocation(runtime, session, action, scopedObjectArgs);
      }
    } else if (!callerIsCto && domain === "terminal") {
      scopedObjectArgs = scopeTerminalAdeActionArgs(
        runtime,
        session,
        action,
        requireObjectArgsForScopedAdeAction(domain, action, argsList, hasScalarArg, rawObjectArgs),
      );
    } else if (
      !callerIsCto
      && domain === "chat"
      && SCOPED_CHAT_ACTIONS.has(action)
    ) {
      const chatArgs = action === "sendMessage"
        ? withTrustedSpawnDispatchMetadata(
            runtime,
            session,
            requireObjectArgsForScopedAdeAction(domain, action, argsList, hasScalarArg, rawObjectArgs),
          )
        : requireObjectArgsForScopedAdeAction(
            domain,
            action,
            argsList,
            hasScalarArg,
            rawObjectArgs,
          );
      const callerSessionId = asOptionalTrimmedString(session.identity.chatSessionId);
      const requestedSessionId = asOptionalTrimmedString(chatArgs.sessionId);
      const legacyCrossSessionSend = action === "sendMessage"
        && callerSessionId != null
        && requestedSessionId != null
        && requestedSessionId !== callerSessionId;
      let legacyBlankChildKickoff = false;
      if (legacyCrossSessionSend) {
        const targetSession = runtime.sessionService.get(requestedSessionId);
        const targetParentSessionId = asOptionalTrimmedString(
          targetSession?.orchestrationParentSessionId,
        );
        const agentChatService = runtime.agentChatService;
        if (targetParentSessionId === callerSessionId && agentChatService) {
          try {
            const transcript = await agentChatService.getChatTranscript({
              sessionId: requestedSessionId,
              limit: 1,
              maxChars: 200,
            });
            legacyBlankChildKickoff = transcript.totalEntries === 0;
          } catch {
            // Compatibility routing is fail-closed. A target that cannot prove
            // it is the caller's still-blank child keeps the normal scope denial.
          }
        }
      }
      const legacyMessageSession = service.messageSession;
      if (
        legacyBlankChildKickoff
        && typeof legacyMessageSession === "function"
        && isAllowedAdeAction(domain, "messageSession")
      ) {
        // ADE <=1.2.41 created a fresh chat and then used `sendMessage` for its
        // kickoff. Newer scoped runtimes reserve that action for the caller's
        // own session, while `messageSession` is the deliberate peer-routing
        // contract. Preserve only the parent -> still-blank child kickoff; any
        // other cross-session use keeps the normal isolation denial.
        callable = legacyMessageSession;
        scopedObjectArgs = {
          ...chatArgs,
          kind: "auto",
        };
      } else {
        scopedObjectArgs = scopeChatAdeActionArgs(
          session,
          action,
          chatArgs,
        );
      }
    } else if (
      !callerIsCto
      && domain === "session"
      && SCOPED_CHAT_ACTIONS.has(action)
    ) {
      scopedObjectArgs = scopeChatAdeActionArgs(
        session,
        action,
        requireObjectArgsForScopedAdeAction(domain, action, argsList, hasScalarArg, rawObjectArgs),
        "session",
      );
    } else if (!callerIsCto && domain === "search" && action === "query") {
      scopedObjectArgs = scopeSearchAdeActionArgs(
        session,
        requireObjectArgsForScopedAdeAction(domain, action, argsList, hasScalarArg, rawObjectArgs),
      );
    } else if (domain === "built_in_browser") {
      scopedObjectArgs = scopeBuiltInBrowserAdeActionArgs(
        session,
        action,
        requireObjectArgsForScopedAdeAction(domain, action, argsList, hasScalarArg, rawObjectArgs),
      );
    } else if (!callerIsCto && domain === "external-sessions" && !isUnboundAdeCliCaller(session)) {
      const externalArgs = requireObjectArgsForScopedAdeAction(domain, action, argsList, hasScalarArg, rawObjectArgs);
      if (action === "list") {
        const scoped = scopeExternalSessionsListArgs(runtime, session, externalArgs);
        const rawResult = await (callable as (args?: Record<string, unknown>) => Promise<unknown>).call(
          service,
          scoped.scopedArgs,
        );
        result = filterExternalSessionSummariesForLane(rawResult, scoped.laneCwd);
        scopedResultHandled = true;
      } else if (action === "import") {
        scopedObjectArgs = await scopeExternalSessionsImportArgs(runtime, session, externalArgs);
      } else {
        externalSessionsAccessDenied(`run_ade_action:${domain}.${action}`);
      }
    }
    if (domain === "lane" && action === "create" && !argsList && !hasScalarArg) {
      // Same remote-first default as the `create_lane` tool and the sync
      // layer's `lanes.create`: a base-less `ade actions run lane.create`
      // must branch from the configured new-lane base, not the local tip.
      const hasExplicitBase = Boolean(
        asOptionalTrimmedString(scopedObjectArgs.baseBranch) ||
          asOptionalTrimmedString(scopedObjectArgs.startPoint) ||
          asOptionalTrimmedString(scopedObjectArgs.parentLaneId),
      );
      if (!hasExplicitBase) {
        const remoteBase = await resolveLaneCreateRemoteBase({
          laneService: runtime.laneService,
          gitService: runtime.gitService,
          projectConfigService: runtime.projectConfigService,
          onWarning: (warning) => console.warn(warning),
        });
        if (remoteBase) scopedObjectArgs = { ...scopedObjectArgs, baseBranch: remoteBase };
      }
    }
    if (!scopedResultHandled) {
      if (argsList) {
        result = await (callable as (...params: unknown[]) => Promise<unknown>).apply(service, argsList);
      } else if (hasScalarArg) {
        result = await (callable as (arg: unknown) => Promise<unknown>).call(service, toolArgs.arg);
      } else {
        result = await (callable as (args?: Record<string, unknown>) => Promise<unknown>).call(
          service,
          Object.keys(scopedObjectArgs).length > 0 ? scopedObjectArgs : undefined,
        );
      }
    }
    if (domain === "account" && action === "status") {
      result = scopeAccountStatusForRole(result, callerCtx.role);
    }
    const record = isRecord(result) ? result : null;
    const statusHints = {
      operationId: typeof record?.operationId === "string" ? record.operationId : null,
      testRunId: typeof record?.id === "string" && domain === "tests" ? record.id : null,
      chatSessionId: typeof record?.sessionId === "string" ? record.sessionId : null,
      runId: typeof record?.runId === "string" ? record.runId : null,
    };
    // Analytics control-plane calls are plumbing, not user product activity.
    // Recording capture/flush/consent here would recursively manufacture
    // feature-usage rows (and signal-exit flushes could consume event quota).
    if (isUserClient && domain !== "analytics") {
      const requestedSessionId = typeof scopedObjectArgs.sessionId === "string"
        ? scopedObjectArgs.sessionId
        : null;
      recordUsageInteraction(runtime.db, {
        projectId: runtime.projectId,
        client: usageClientSurfaceFromRpcName(session.clientName),
        action: usageActionFromRpcDomain(domain, action),
        feature: domain,
        sessionId: statusHints.chatSessionId ?? requestedSessionId,
        analyticsEligible: runtime.productAnalyticsService?.getStatus().effective === true,
      });
    }
    return {
      domain,
      action,
      result,
      statusHints,
    };
  }

  if (name === "start_cli_session") {
    const laneId = assertNonEmptyString(toolArgs.laneId, "laneId");
    const provider = parseCliSessionProvider(toolArgs.provider);
    const permissionMode = parseCliSessionPermissionMode(toolArgs.permissionMode);
    const orchestrationParentSessionId = toolArgs.orchestrationParentSessionId == null
      ? null
      : assertNonEmptyString(toolArgs.orchestrationParentSessionId, "orchestrationParentSessionId");
    const spawnKind = parseCliSessionSpawnKind(toolArgs.spawnKind);
    if (provider === "shell" && (orchestrationParentSessionId || spawnKind)) {
      throw new JsonRpcError(
        JsonRpcErrorCode.invalidParams,
        "Plain shell terminals do not record agent spawn lineage.",
      );
    }
    if (isCliProvider(provider) && orchestrationParentSessionId && !spawnKind) {
      throw new JsonRpcError(
        JsonRpcErrorCode.invalidParams,
        "spawnKind is required for a parented agent session: use subagent when the parent will need the result, or peer only for fire-and-forget work",
      );
    }
    if (!orchestrationParentSessionId && spawnKind) {
      throw new JsonRpcError(
        JsonRpcErrorCode.invalidParams,
        "spawnKind requires orchestrationParentSessionId",
      );
    }
    try {
      validateLaunchProfilePermissionMode(provider, permissionMode);
    } catch (err) {
      throw new JsonRpcError(JsonRpcErrorCode.invalidParams, err instanceof Error ? err.message : String(err));
    }
    const cols = clampInteger(toolArgs.cols, DEFAULT_PTY_COLS, 20, 400);
    const rows = clampInteger(toolArgs.rows, DEFAULT_PTY_ROWS, 4, 200);
    const initialInput = asOptionalTrimmedString(toolArgs.initialInput)?.slice(0, 20_000) ?? null;
    const model = asOptionalTrimmedString(toolArgs.model) ?? asOptionalTrimmedString(toolArgs.modelId);
    const reasoningEffort = asOptionalTrimmedString(toolArgs.reasoningEffort);
    const fastMode = asOptionalBoolean(toolArgs.fastMode) ?? asOptionalBoolean(toolArgs.codexFastMode);
    const initialInputMeta = deriveTrackedCliInitialInputSessionMeta({
      provider,
      title: asOptionalTrimmedString(toolArgs.title),
      initialInput,
    });
    const title = initialInputMeta.title || LAUNCH_PROFILE_TITLE[provider];
    const ptyService = runtime.ptyService;
    const preassignedSessionId = provider === "claude" ? randomUUID() : undefined;
    const laneWorktreePath = resolveLaneWorktreePath(runtime, laneId);
    const codexComputerUse = provider === "codex"
      ? await resolveCodexComputerUseMcpConfig()
      : null;

    const launchFields: Partial<TrackedCliLaunchCommand> = (() => {
      if (provider === "shell") {
        return resolveCleanShellLaunchFields({
          platform: process.platform,
          shell: process.env.SHELL,
          comSpec: process.env.ComSpec,
        });
      }
      if (!isCliProvider(provider)) return {};
      return buildTrackedCliLaunchCommand({
        provider,
        permissionMode,
        sessionId: preassignedSessionId,
        model,
        reasoningEffort,
        fastMode,
        initialPrompt: initialInput,
        laneWorktreePath,
        ...(provider === "codex" ? { codexComputerUse } : {}),
      });
    })();
    const toolType = LAUNCH_PROFILE_TOOL_TYPE[provider];
    const resumeMetadata: TerminalResumeMetadata | null = isCliProvider(provider)
      ? {
          provider,
          targetKind: provider === "codex" ? "thread" : "session",
          targetId: provider === "claude" ? preassignedSessionId ?? null : null,
          launch: parseTrackedCliLaunchConfig(launchFields.startupCommand ?? "", toolType) ?? {},
          ...(orchestrationParentSessionId ? { orchestrationParentSessionId } : {}),
          ...(spawnKind ? { spawnKind } : {}),
        }
      : null;

    const created = await ptyService.create({
      ...(preassignedSessionId ? { sessionId: preassignedSessionId } : {}),
      ...(preassignedSessionId ? { allowNewSessionId: true } : {}),
      laneId,
      cols,
      rows,
      title,
      tracked: toolArgs.tracked !== false,
      toolType,
      ...(resumeMetadata ? { resumeMetadata } : {}),
      ...(isCliProvider(provider) && orchestrationParentSessionId
        ? { spawnLineage: { parentChatSessionId: orchestrationParentSessionId, spawnKind } }
        : {}),
      ...(asOptionalTrimmedString(toolArgs.cwd) ? { cwd: asOptionalTrimmedString(toolArgs.cwd)! } : {}),
      ...(asOptionalTrimmedString(toolArgs.chatSessionId) ? { chatSessionId: asOptionalTrimmedString(toolArgs.chatSessionId) } : {}),
      ...launchFields,
    });

    const initialInputWritten = Boolean(initialInput && isCliProvider(provider));

    const autoTitleApplied = Boolean(initialInputMeta.promptTitle) && title === initialInputMeta.promptTitle;
    if (initialInputMeta.goal || autoTitleApplied) {
      const session = runtime.sessionService.get(created.sessionId) as TerminalSessionSummary | null;
      const metaPatch: Parameters<typeof runtime.sessionService.updateMeta>[0] = {
        sessionId: created.sessionId,
        ...(initialInputMeta.goal && !session?.goal?.trim().length ? { goal: initialInputMeta.goal } : {}),
        ...(autoTitleApplied ? { title: initialInputMeta.promptTitle!, manuallyNamed: false } : {}),
      };
      if (metaPatch.goal !== undefined || metaPatch.title !== undefined || metaPatch.manuallyNamed !== undefined) {
        runtime.sessionService.updateMeta(metaPatch);
      }
    }

    const session = runtime.sessionService.get(created.sessionId) as TerminalSessionSummary | null;
    const enrichedSession = session ? ptyService.enrichSessions([session])[0] ?? session : session;
    return {
      provider,
      laneId,
      title,
      permissionMode,
      model: provider === "claude" ? model ?? null : null,
      ptyId: created.ptyId,
      sessionId: created.sessionId,
      startupCommand: launchFields.startupCommand ?? null,
      initialInputWritten,
      session: enrichedSession ?? null,
    };
  }

  if (name === "send_to_session") {
    const sessionId = assertNonEmptyString(toolArgs.sessionId, "sessionId");
    const text = assertNonEmptyString(toolArgs.text, "text");
    return await runtime.ptyService.sendToSession({
      sessionId,
      text,
      cols: clampInteger(toolArgs.cols, DEFAULT_PTY_COLS, 20, 400),
      rows: clampInteger(toolArgs.rows, DEFAULT_PTY_ROWS, 4, 200),
    });
  }

  if (name === "get_ade_action_status") {
    const operationId = asOptionalTrimmedString(toolArgs.operationId);
    const testRunId = asOptionalTrimmedString(toolArgs.testRunId);
    const chatSessionId = asOptionalTrimmedString(toolArgs.chatSessionId);
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
    let baseBranch = asOptionalTrimmedString(toolArgs.baseBranch);
    let baseWarning: string | null = null;
    const branchName = asOptionalTrimmedString(toolArgs.branchName);
    if (!baseBranch && !parentLaneId) {
      // Base-less creates (`ade lanes create`, agent tool calls) must branch
      // from the project's configured new-lane base — remote-first, matching
      // desktop's create-lane dialog and the sync layer's `lanes.create` —
      // not from the possibly-stale LOCAL primary tip.
      baseBranch = await resolveLaneCreateRemoteBase({
        laneService: runtime.laneService,
        gitService: runtime.gitService,
        projectConfigService: runtime.projectConfigService,
        onWarning: (warning) => {
          baseWarning = warning;
        },
      });
    }
    let linearIssue: LaneLinearIssue | null = null;
    if (toolArgs.linearIssue !== undefined && toolArgs.linearIssue !== null) {
      if (typeof toolArgs.linearIssue !== "object" || Array.isArray(toolArgs.linearIssue)) {
        throw new JsonRpcError(
          JsonRpcErrorCode.invalidParams,
          "linearIssue must be a non-array object",
        );
      }
      linearIssue = parseLaneLinearIssue(toolArgs.linearIssue);
    }

    const lane = await runtime.laneService.create({
      name: nameArg,
      ...(description ? { description } : {}),
      ...(parentLaneId ? { parentLaneId } : {}),
      ...(baseBranch ? { baseBranch } : {}),
      ...(branchName ? { branchName } : {}),
      ...(linearIssue ? { linearIssue } : {})
    });

    return {
      lane: mapLaneSummary(lane as unknown as Record<string, unknown>),
      ...(baseWarning ? { warning: baseWarning } : {}),
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

    const title = assertNonEmptyString(toolArgs.title, "title");
    const body = assertNonEmptyString(toolArgs.body, "body");
    const waitForResolutionMs = Math.max(0, Math.floor(asNumber(toolArgs.waitForResolutionMs, 0)));
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
      awaitingUserResponse: boolean;
      blocking: boolean;
      outcome: "answered" | "declined" | "cancelled" | "timed_out";
      decision?: string;
      responseText?: string | null;
      answers?: Record<string, string[]>;
    }): Record<string, unknown> => ({
      decision: args.decision ?? (args.outcome === "answered" ? "accept" : args.outcome),
      outcome: args.outcome,
      resolved: !args.awaitingUserResponse,
      answered: args.outcome === "answered",
      declined: args.outcome === "declined",
      cancelled: args.outcome === "cancelled",
      timedOut: args.outcome === "timed_out",
      awaitingUserResponse: args.awaitingUserResponse,
      blocking: args.blocking,
      answers: args.answers ?? {},
      responseText: args.responseText ?? null,
    });

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
        "ask_user requires an active chat session (chatSessionId).",
      );
    }

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
    let outcome: "answered" | "declined" | "cancelled";
    if (result.decision === "decline") outcome = "declined";
    else if (result.decision === "cancel") outcome = "cancelled";
    else outcome = "answered";
    return buildAskUserResult({
      awaitingUserResponse: false,
      blocking: false,
      outcome,
      decision: result.decision,
      answers: result.answers,
      responseText: summarizeAskUserDecision(result.decision, result.responseText, answered),
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
    const target = asOptionalTrimmedString(toolArgs.target) ?? "local";
    if (target !== "local") {
      throw new JsonRpcError(JsonRpcErrorCode.invalidParams, "target must be local.");
    }
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
    const target = asOptionalTrimmedString(toolArgs.target) ?? "local";
    if (target !== "local") {
      throw new JsonRpcError(JsonRpcErrorCode.invalidParams, "target must be local.");
    }
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
    const backendStyle = assertComputerUseBackendStyle(toolArgs.backendStyle, "backendStyle");
    const backendName = assertNonEmptyString(toolArgs.backendName, "backendName");
    const inputs = Array.isArray(toolArgs.inputs) ? toolArgs.inputs.map((entry) => safeObject(entry)) : [];
    if (inputs.length === 0) {
      throw new JsonRpcError(JsonRpcErrorCode.invalidParams, "Provide inputs for computer-use ingestion.");
    }
    const authorized = await resolveAuthorizedComputerUseIngestRoot(runtime, session, toolArgs);
    validateComputerUseOwnerClaims(runtime, session, toolArgs);
    for (const input of inputs) {
      const localPath = asOptionalTrimmedString(input.path)
        ?? (() => {
          const uri = asOptionalTrimmedString(input.uri);
          return uri && !/^https?:\/\//i.test(uri) ? uri : null;
        })();
      if (!localPath || !path.isAbsolute(localPath)) continue;
      if (isPathWithinAuthorizedRoot(authorized.root, localPath)) continue;
      // Absolute proof paths may also come from broker-approved external
      // roots such as the OS temp directory or ~/.agent-browser. Preserve the
      // lane boundary here, then let the broker enforce its full jailed
      // allow-list and extension policy.
      if (isPathWithinAuthorizedRoot(runtime.paths.worktreesDir, localPath)) {
        throw new JsonRpcError(
          JsonRpcErrorCode.invalidParams,
          "Artifact paths from another lane worktree are not authorized for this caller",
        );
      }
    }
    const result = runtime.computerUseArtifactBrokerService.ingest({
      backend: {
        name: backendName,
        style: backendStyle,
        toolName: asOptionalTrimmedString(toolArgs.toolName),
        command: asOptionalTrimmedString(toolArgs.command),
      },
      callerRoot: authorized.callerRoot,
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
      owners: resolveComputerUseOwners(session, {
        ...toolArgs,
        ...(authorized.laneId ? { laneId: authorized.laneId } : {}),
      }),
    });
    return result;
  }

  if (name === "list_computer_use_artifacts") {
    const projectWideAuthorized = isProjectWideProofMaintenanceAuthorized(session);
    const authorizedOwners = resolveAuthorizedProofOwners(runtime, session);
    const requestedOwnerKind = asOptionalTrimmedString(toolArgs.ownerKind) as ComputerUseArtifactOwner["kind"] | null;
    const requestedOwnerId = asOptionalTrimmedString(toolArgs.ownerId);
    if (!projectWideAuthorized && !authorizedOwners.length) {
      throw new JsonRpcError(JsonRpcErrorCode.methodNotFound, "Proof listing requires an authenticated owner scope.");
    }
    if (
      !projectWideAuthorized
      && (requestedOwnerKind || requestedOwnerId)
      && !authorizedOwners.some((owner) => owner.kind === requestedOwnerKind && owner.id === requestedOwnerId)
    ) {
      throw new JsonRpcError(JsonRpcErrorCode.methodNotFound, "The requested proof owner is not authorized for this caller.");
    }
    if (!projectWideAuthorized) {
      const limit = Math.max(1, Math.min(200, Math.floor(asNumber(toolArgs.limit, 50))));
      const kind = asOptionalTrimmedString(toolArgs.kind) as any;
      const artifacts = new Map<string, any>();
      const owners = requestedOwnerKind && requestedOwnerId
        ? [{ kind: requestedOwnerKind, id: requestedOwnerId }]
        : authorizedOwners;
      for (const owner of owners) {
        for (const artifact of runtime.computerUseArtifactBrokerService.listArtifacts({
          ownerKind: owner.kind,
          ownerId: owner.id,
          kind,
          limit,
        })) {
          artifacts.set(artifact.id, artifact);
        }
      }
      return {
        artifacts: [...artifacts.values()]
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
          .slice(0, limit),
      };
    }
    return {
      artifacts: runtime.computerUseArtifactBrokerService.listArtifacts({
        ownerKind: requestedOwnerKind as any,
        ownerId: requestedOwnerId,
        kind: asOptionalTrimmedString(toolArgs.kind) as any,
        limit: asNumber(toolArgs.limit, 50),
      }),
    };
  }

  if (name === "delete_computer_use_artifacts") {
    const ids = [
      ...(asOptionalTrimmedString(toolArgs.artifactId) ? [asOptionalTrimmedString(toolArgs.artifactId)!] : []),
      ...(Array.isArray(toolArgs.artifactIds)
        ? toolArgs.artifactIds.map((entry) => asOptionalTrimmedString(entry)).filter((entry): entry is string => Boolean(entry))
        : []),
    ];
    if (!ids.length) {
      throw new JsonRpcError(JsonRpcErrorCode.invalidParams, "Provide artifactId or artifactIds to delete.");
    }
    if (!isProjectWideProofMaintenanceAuthorized(session)) {
      const authorizedOwners = resolveAuthorizedProofOwners(runtime, session);
      if (!authorizedOwners.length) {
        throw new JsonRpcError(JsonRpcErrorCode.methodNotFound, "Proof deletion requires an authenticated owner scope.");
      }
      for (const artifactId of ids) {
        const artifact = runtime.computerUseArtifactBrokerService.listArtifacts({ artifactId })[0] ?? null;
        if (artifact && !artifactMatchesAuthorizedOwners(artifact, authorizedOwners)) {
          throw new JsonRpcError(JsonRpcErrorCode.methodNotFound, "Artifact is not owned by this caller.");
        }
      }
    }
    return runtime.computerUseArtifactBrokerService.deleteArtifacts({ artifactIds: ids });
  }

  if (name === "list_broken_computer_use_artifacts") {
    const requestedLimit = Math.max(1, Math.min(2000, Math.floor(asNumber(toolArgs.limit, 200))));
    const broken = runtime.computerUseArtifactBrokerService.listBrokenArtifacts({
      limit: isProjectWideProofMaintenanceAuthorized(session) ? requestedLimit : 2000,
    });
    if (!isProjectWideProofMaintenanceAuthorized(session)) {
      const authorizedOwners = resolveAuthorizedProofOwners(runtime, session);
      if (!authorizedOwners.length) {
        throw new JsonRpcError(JsonRpcErrorCode.methodNotFound, "Broken-proof listing requires an authenticated owner scope.");
      }
      const authorizedArtifactIds = listAuthorizedProofArtifactIds(runtime, authorizedOwners);
      return {
        broken: broken
          .filter((entry) => authorizedArtifactIds.has(entry.artifactId))
          .slice(0, requestedLimit),
      };
    }
    return {
      broken,
    };
  }

  if (name === "prune_broken_computer_use_artifacts") {
    if (isProjectWideProofMaintenanceAuthorized(session)) {
      return runtime.computerUseArtifactBrokerService.pruneBrokenArtifacts();
    }
    const authorizedOwners = resolveAuthorizedProofOwners(runtime, session);
    if (!authorizedOwners.length) {
      throw new JsonRpcError(JsonRpcErrorCode.methodNotFound, "Broken-proof pruning requires an authenticated owner scope.");
    }
    const authorizedArtifactIds = listAuthorizedProofArtifactIds(runtime, authorizedOwners);
    const artifactIds = runtime.computerUseArtifactBrokerService.listBrokenArtifacts({ limit: 2000 })
      .filter((entry) => authorizedArtifactIds.has(entry.artifactId))
      .map((entry) => entry.artifactId);
    return artifactIds.length
      ? runtime.computerUseArtifactBrokerService.deleteArtifacts({ artifactIds })
      : { deleted: [], missing: [], failed: [], freedBytes: 0 };
  }

  if (name === "recover_computer_use_artifact") {
    const artifactId = assertNonEmptyString(toolArgs.artifactId, "artifactId");
    if (!isProjectWideProofMaintenanceAuthorized(session)) {
      const authorizedOwners = resolveAuthorizedProofOwners(runtime, session);
      const artifact = runtime.computerUseArtifactBrokerService.listArtifacts({ artifactId })[0] ?? null;
      if (!authorizedOwners.length || (artifact && !artifactMatchesAuthorizedOwners(artifact, authorizedOwners))) {
        throw new JsonRpcError(JsonRpcErrorCode.methodNotFound, "Artifact is not owned by this caller.");
      }
    }
    return runtime.computerUseArtifactBrokerService.recoverArtifact({
      artifactId,
    });
  }

  if (name === "get_computer_use_backend_status") {
    return runtime.computerUseArtifactBrokerService.getBackendStatus();
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
    const rawMode = asOptionalTrimmedString(toolArgs.mode);
    const mode = rawMode === "ff_only" ? "ff-only" : rawMode;
    if (mode && mode !== "ff-only" && mode !== "rebase" && mode !== "merge") {
      throw new JsonRpcError(JsonRpcErrorCode.invalidParams, "mode must be ff-only, rebase, or merge.");
    }
    const action = await runtime.gitService.pull({
      laneId,
      ...(mode ? { mode: mode as "ff-only" | "rebase" | "merge" } : {}),
    });
    return { laneId, action };
  }

  if (name === "git_push") {
    const laneId = requireLaneIdForTool(runtime, session, toolArgs, "git_push");
    const force = asBoolean(toolArgs.forceWithLease, asBoolean(toolArgs.force, false));
    const action = await runtime.gitService.push({ laneId, forceWithLease: force });
    return { laneId, action };
  }

  if (name === "git_undo_last_head_change") {
    const laneId = requireLaneIdForTool(runtime, session, toolArgs, "git_undo_last_head_change");
    const action = await runtime.gitService.undoLastHeadChange({ laneId });
    return { laneId, action };
  }

  if (name === "git_redo_last_head_change") {
    const laneId = requireLaneIdForTool(runtime, session, toolArgs, "git_redo_last_head_change");
    const action = await runtime.gitService.redoLastHeadChange({ laneId });
    return { laneId, action };
  }

  if (name === "git_list_branches") {
    const laneId = requireLaneIdForTool(runtime, session, toolArgs, "git_list_branches");
    const branches = await runtime.gitService.listBranches({ laneId });
    return { laneId, branches };
  }

  if (name === "git_get_user_identity") {
    const laneId = requireLaneIdForTool(runtime, session, toolArgs, "git_get_user_identity");
    const identity = await runtime.gitService.getUserIdentity({ laneId });
    return { laneId, identity };
  }

  if (name === "prs_list_open") {
    const prs = await requirePrService(runtime).listOpenPullRequests();
    return { prs };
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
    const stashOid = asOptionalTrimmedString(toolArgs.stashOid);
    const action = await runtime.gitService.stashApply({ laneId, stashRef, ...(stashOid ? { stashOid } : {}) });
    return { action };
  }

  if (name === "stash_pop") {
    const laneId = requireLaneIdForTool(runtime, session, toolArgs, "stash_pop");
    const stashRef = assertNonEmptyString(toolArgs.stashRef, "stashRef");
    const stashOid = assertNonEmptyString(toolArgs.stashOid, "stashOid");
    const action = await runtime.gitService.stashPop({ laneId, stashRef, stashOid });
    return { action };
  }

  if (name === "stash_drop") {
    const laneId = requireLaneIdForTool(runtime, session, toolArgs, "stash_drop");
    const stashRef = assertNonEmptyString(toolArgs.stashRef, "stashRef");
    const stashOid = assertNonEmptyString(toolArgs.stashOid, "stashOid");
    const action = await runtime.gitService.stashDrop({ laneId, stashRef, stashOid });
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
    const closeLinearIssueOnMerge = asBoolean(toolArgs.closeLinearIssueOnMerge, true);
    if (!title) title = await defaultPrTitleForLane(runtime, laneId, baseBranch);
    if (body == null) body = "";
    const draft = asBoolean(toolArgs.draft, false);
    const pr = await prSvc.createFromLane({
      laneId,
      title,
      body,
      draft,
      ...(baseBranch ? { baseBranch } : {}),
      ...(closeLinearIssueOnMerge ? { closeLinearIssueOnMerge } : {}),
    });
    return { pr, ...prLinkUrls(pr) };
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
    const [comments, reviews, checks, reviewThreads] = await Promise.all([
      prSvc.getComments(prId),
      prSvc.getReviews(prId),
      prSvc.getChecks(prId),
      prSvc.getReviewThreads(prId).catch(() => []),
    ]);
    return summarizePrReviewComments(prId, comments, reviews, checks, reviewThreads);
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
    if (provider === "codex" && permissionMode === "auto") {
      throw new JsonRpcError(
        JsonRpcErrorCode.invalidParams,
        "permissionMode auto is only supported for Claude spawn_agent sessions.",
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
    promptSegments.push(buildAdeInlineGuidanceForLane(laneWorktreePath));
    if (promptRunId || promptStepId || promptAttemptId) {
      promptSegments.push(
        `Run context: run=${promptRunId ?? "n/a"} step=${promptStepId ?? "n/a"} attempt=${promptAttemptId ?? "n/a"}.`
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
        commandArgs.push("--sandbox", "workspace-write", "--ask-for-approval", "on-request");
        commandPreviewParts.push("--sandbox", "workspace-write", "--ask-for-approval", "on-request");
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
      let claudePermission: string;
      switch (permissionMode) {
        case "plan":
          claudePermission = "plan";
          break;
        case "full-auto":
          claudePermission = "bypassPermissions";
          break;
        case "edit":
          claudePermission = "acceptEdits";
          break;
        case "auto":
          claudePermission = "auto";
          break;
        default:
          claudePermission = "default";
      }
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
    const skillRootsEnv = joinAdeAgentSkillRoots(getAdeAgentSkillRootsForPrompt({ cwd: laneWorktreePath }));
    if (skillRootsEnv) workerEnv[ADE_AGENT_SKILLS_DIRS_ENV] = skillRootsEnv;
    const envPrefixParts: string[] = [];
    const addWorkerEnv = (key: string, value: string | null | undefined) => {
      if (!value) return;
      workerEnv[key] = value;
      envPrefixParts.push(`${key}=${shellEscapeArg(value)}`);
    };
    addWorkerEnv("ADE_RUN_ID", runId);
    addWorkerEnv("ADE_STEP_ID", stepId);
    addWorkerEnv("ADE_ATTEMPT_ID", attemptId);
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
        hasMore: filtered.length > limit || result.hasMore,
        eventEpoch: result.eventEpoch,
        gap: result.gap === true,
        oldestCursor: result.oldestCursor ?? null
      };
    }
    return runtime.eventBuffer.drain(cursor, limit);
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

const APP_NAVIGATE_SUPPORTED_KINDS = new Set([
  "work",
  "chat",
  "file",
  "commit",
  "artifact",
  "lane",
  "pr",
  "route",
  "branch",
  "linear-issue",
]);

export function createAdeRpcRequestHandler(args: {
  runtime: AdeRuntime;
  serverVersion: string;
}): JsonRpcHandler & { dispose: () => void } {
  const { runtime, serverVersion } = args;

  const session: SessionState = {
    initialized: false,
    protocolVersion: DEFAULT_PROTOCOL_VERSION,
    clientName: "unknown",
    identity: {
      callerId: "unknown",
      role: "external",
      chatSessionId: null,
      standaloneChatSession: false,
      runId: null,
      stepId: null,
      attemptId: null,
      ownerId: null,
      browserActorToken: null,
    },
    askUserEvents: [],
    askUserRateLimit: {
      maxCalls: 6,
      windowMs: 60_000
    },
  };

  const listActions = async (): Promise<Record<string, unknown>> => {
    const actionSpecs = await listToolSpecsForSession(runtime, session);
    return {
      actions: actionSpecs.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: sanitizeToolSchema(tool.inputSchema),
      })),
    };
  };

  const callAction = async (actionName: string, actionArgs: Record<string, unknown>): Promise<unknown> => {
    if (READ_ONLY_TOOLS.has(actionName)) {
      return await runTool({ runtime, session, name: actionName, toolArgs: actionArgs });
    }
    if (MUTATION_TOOLS.has(actionName) || actionName === "spawn_agent" || actionName === "ask_user") {
      return await runTool({ runtime, session, name: actionName, toolArgs: actionArgs });
    }

    throw new JsonRpcError(JsonRpcErrorCode.methodNotFound, `Unsupported ADE action: ${actionName}`);
  };

  const handler = (async (request: JsonRpcRequest): Promise<unknown | null> => {
    const method = typeof request.method === "string" ? request.method : "";
    const params = safeObject(request.params);

    if (method === "ade/initialize") {
      session.initialized = true;
      session.protocolVersion = asOptionalTrimmedString(params.protocolVersion) ?? DEFAULT_PROTOCOL_VERSION;
      const clientInfo = safeObject(params.clientInfo);
      session.clientName = asOptionalTrimmedString(params.clientName)
        ?? asOptionalTrimmedString(clientInfo.name)
        ?? "unknown";
      session.identity = parseInitializeIdentity(runtime, params);
      const desktopBridgeAuthToken = asOptionalTrimmedString(params.desktopBridgeAuthToken);
      if (
        session.clientName === "ade-desktop-local"
        && desktopBridgeAuthToken
        && runtime.configureBuiltInBrowserDesktopBridgeAuth
      ) {
        const configured = await runtime.configureBuiltInBrowserDesktopBridgeAuth(desktopBridgeAuthToken);
        if (!configured) {
          runtime.logger.warn("built_in_browser_bridge.runtime_auth_rejected", {
            clientName: session.clientName,
          });
        }
      }
      const resourcesEnabled = session.identity.role !== "orchestrator";
      return {
        protocolVersion: session.protocolVersion,
        runtimeInfo: {
          name: "ade-rpc",
          version: serverVersion,
          minCompatibleProtocol: RUNTIME_COMPAT_LEVEL,
          protocolVersion: RUNTIME_COMPAT_LEVEL,
          buildHash:
            typeof process.env.ADE_RUNTIME_BUILD_HASH === "string" &&
            process.env.ADE_RUNTIME_BUILD_HASH.trim()
              ? process.env.ADE_RUNTIME_BUILD_HASH.trim()
              : null,
          defaultRole:
            normalizeAdeRuntimeRole(process.env.ADE_DEFAULT_ROLE),
          projectRoot: runtime.projectRoot,
          workspaceRoot: runtime.workspaceRoot ?? null,
          pid: process.pid
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

    if (method.startsWith("sync.")) {
      const syncService = runtime.syncService;
      if (!syncService) {
        throw new JsonRpcError(JsonRpcErrorCode.invalidRequest, "Sync service is not available.");
      }
      if (method === "sync.getStatus") {
        return await syncService.getStatus({
          includeTransferReadiness: params.includeTransferReadiness === true,
          forceTransferReadiness: params.forceTransferReadiness === true,
        });
      }
      if (method === "sync.runSelfProbe") {
        return await syncService.runSelfProbe();
      }
      if (method === "sync.refreshDiscovery") {
        return await syncService.refreshDiscovery();
      }
      if (method === "sync.listDevices") {
        return await syncService.listDevices();
      }
      if (method === "sync.updateLocalDevice") {
        const name = typeof params.name === "string" ? params.name : undefined;
        const deviceType = typeof params.deviceType === "string" ? params.deviceType : undefined;
        return await syncService.updateLocalDevice({
          ...(name !== undefined ? { name } : {}),
          ...(deviceType !== undefined ? { deviceType: deviceType as never } : {}),
        });
      }
      if (method === "sync.connectToBrain") {
        return await syncService.connectToBrain(params as Parameters<typeof syncService.connectToBrain>[0]);
      }
      if (method === "sync.disconnectFromBrain") {
        return await syncService.disconnectFromBrain();
      }
      if (method === "sync.forgetDevice") {
        const deviceId = typeof params.deviceId === "string" ? params.deviceId : "";
        return await syncService.forgetDevice(deviceId);
      }
      if (method === "sync.getTransferReadiness") {
        return await syncService.getTransferReadiness();
      }
      if (method === "sync.transferBrainToLocal") {
        return await syncService.transferBrainToLocal();
      }
      if (method === "sync.getPin") {
        return { pin: syncService.getPin() };
      }
      if (method === "sync.setPin") {
        const pin = typeof params.pin === "string" ? params.pin : "";
        return await syncService.setPin(pin);
      }
      if (method === "sync.generatePin") {
        return await syncService.generatePin();
      }
      if (method === "sync.clearPin") {
        return await syncService.clearPin();
      }
      if (method === "sync.getRuntimeName") {
        return { runtimeName: syncService.getRuntimeName() };
      }
      if (method === "sync.setRuntimeName") {
        if (typeof params.name !== "string") {
          throw new JsonRpcError(JsonRpcErrorCode.invalidParams, "name must be a string");
        }
        const name = params.name;
        return await syncService.setRuntimeName(name);
      }
      if (method === "sync.clearRuntimeName") {
        return await syncService.clearRuntimeName();
      }
      if (method === "sync.authorizeSshPairing") {
        return await syncService.authorizeSshPairing(params);
      }
      if (method === "sync.setActiveLanePresence") {
        const laneIds = Array.isArray(params.laneIds)
          ? params.laneIds.filter((laneId): laneId is string => typeof laneId === "string")
          : [];
        await syncService.setActiveLanePresence(laneIds);
        return null;
      }
    }

    if (method.startsWith("pty.")) {
      const ptyArgs = safeObject(params.args ?? params.arg ?? params);
      const ptyAction = method.slice("pty.".length);
      if (!isAllowedAdeAction("pty", ptyAction)) {
        throw new JsonRpcError(JsonRpcErrorCode.methodNotFound, `Unsupported PTY method: ${method}`);
      }
      if (!callerHasRoleAtLeast(session.identity.role, "agent")) {
        throw new JsonRpcError(JsonRpcErrorCode.methodNotFound, `Unsupported PTY method: ${method}`);
      }
      if (isCtoOnlyAdeAction("pty", ptyAction) && !callerHasRoleAtLeast(session.identity.role, "cto")) {
        throw new JsonRpcError(JsonRpcErrorCode.methodNotFound, `Unsupported PTY method: ${method}`);
      }
      if (method === "pty.create") {
        ensurePtyCreateAuthorized(runtime, session, method, ptyArgs);
        const result = await runtime.ptyService.create(ptyArgs as Parameters<typeof runtime.ptyService.create>[0]);
        return {
          ...result,
          session: runtime.sessionService.get(result.sessionId),
        };
      }
      if (method === "pty.sendToSession") {
        ensurePtyTargetAuthorized(runtime, session, method, ptyArgs);
        return await runtime.ptyService.sendToSession(ptyArgs as Parameters<typeof runtime.ptyService.sendToSession>[0]);
      }
      if (method === "pty.resumeSession") {
        ensurePtyTargetAuthorized(runtime, session, method, ptyArgs);
        return await runtime.ptyService.resumeSession(ptyArgs as Parameters<typeof runtime.ptyService.resumeSession>[0]);
      }
      if (method === "pty.write") {
        ensurePtyTargetAuthorized(runtime, session, method, ptyArgs);
        runtime.ptyService.write(ptyArgs as Parameters<typeof runtime.ptyService.write>[0]);
        return null;
      }
      if (method === "pty.resize") {
        ensurePtyTargetAuthorized(runtime, session, method, ptyArgs);
        runtime.ptyService.resize(ptyArgs as Parameters<typeof runtime.ptyService.resize>[0]);
        return null;
      }
      if (method === "pty.dispose") {
        ensurePtyTargetAuthorized(runtime, session, method, ptyArgs);
        return runtime.ptyService.dispose(ptyArgs as Parameters<typeof runtime.ptyService.dispose>[0]);
      }
      if (method === "pty.list") {
        return { sessions: listAuthorizedPtySessions(runtime, session, method, ptyArgs) };
      }
      throw new JsonRpcError(JsonRpcErrorCode.methodNotFound, `Unsupported PTY method: ${method}`);
    }

    if (method.startsWith("modelPicker.")) {
      // Backed by the per-project cr-sqlite DB (runtime.db) so favorites +
      // recents converge across desktop/TUI/iOS for a project via CRR sync.
      const store = getSharedModelPickerStore(runtime.db);
      if (method === "modelPicker.getFavorites") {
        return { favorites: store.getFavorites() };
      }
      if (method === "modelPicker.setFavorites") {
        const rawFavorites = (params as { favorites?: unknown }).favorites;
        const favoritesInput = Array.isArray(rawFavorites)
          ? rawFavorites.filter((entry): entry is string => typeof entry === "string")
          : [];
        return { favorites: store.setFavorites(favoritesInput) };
      }
      if (method === "modelPicker.toggleFavorite") {
        const modelId = typeof params.modelId === "string" ? params.modelId : "";
        return store.toggleFavorite(modelId);
      }
      if (method === "modelPicker.getRecents") {
        return { recents: store.getRecents() };
      }
      if (method === "modelPicker.pushRecent") {
        const modelId = typeof params.modelId === "string" ? params.modelId : "";
        return { recents: store.pushRecent(modelId) };
      }
      throw new JsonRpcError(JsonRpcErrorCode.methodNotFound, `Unknown modelPicker method: ${method}`);
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
            ...(error instanceof JsonRpcError && error.data !== undefined
              ? { data: error.data }
              : {}),
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

    if (method === "app/navigate") {
      const target = safeObject(params.target);
      const kind = asOptionalTrimmedString(target.kind);
      if (!kind) {
        throw new JsonRpcError(JsonRpcErrorCode.invalidParams, "app/navigate requires target.kind.");
      }
      if (!APP_NAVIGATE_SUPPORTED_KINDS.has(kind)) {
        throw new JsonRpcError(JsonRpcErrorCode.invalidParams, `Unsupported app navigation target kind: ${kind}.`);
      }
      if (kind === "lane" && !asOptionalTrimmedString(target.laneId)) {
        throw new JsonRpcError(JsonRpcErrorCode.invalidParams, "app/navigate target 'lane' requires laneId.");
      }
      if (kind === "file" && !asOptionalTrimmedString(target.path)) {
        throw new JsonRpcError(JsonRpcErrorCode.invalidParams, "app/navigate target 'file' requires path.");
      }
      if (kind === "commit" && !asOptionalTrimmedString(target.sha)) {
        throw new JsonRpcError(JsonRpcErrorCode.invalidParams, "app/navigate target 'commit' requires sha.");
      }
      if (kind === "artifact" && !asOptionalTrimmedString(target.artifactId)) {
        throw new JsonRpcError(JsonRpcErrorCode.invalidParams, "app/navigate target 'artifact' requires artifactId.");
      }
      if (kind === "route" && !asOptionalTrimmedString(target.route)) {
        throw new JsonRpcError(JsonRpcErrorCode.invalidParams, "app/navigate target 'route' requires route.");
      }
      if (
        kind === "branch"
        && (!asOptionalTrimmedString(target.repoOwner)
          || !asOptionalTrimmedString(target.repoName)
          || !asOptionalTrimmedString(target.branch))
      ) {
        throw new JsonRpcError(
          JsonRpcErrorCode.invalidParams,
          "app/navigate target 'branch' requires repoOwner, repoName, and branch.",
        );
      }
      if (kind === "linear-issue" && !asOptionalTrimmedString(target.issueIdentifier)) {
        throw new JsonRpcError(
          JsonRpcErrorCode.invalidParams,
          "app/navigate target 'linear-issue' requires issueIdentifier.",
        );
      }
      const normalizedTarget: Record<string, unknown> = { kind };
      const sessionId = asOptionalTrimmedString(target.sessionId);
      const laneId = asOptionalTrimmedString(target.laneId);
      if ((kind === "work" || kind === "chat" || kind === "lane") && sessionId) normalizedTarget.sessionId = sessionId;
      if ((kind === "work" || kind === "chat" || kind === "lane" || kind === "pr" || kind === "file" || kind === "commit") && laneId) normalizedTarget.laneId = laneId;
      if (kind === "work" || kind === "chat") {
        if (typeof target.event === "number" && Number.isSafeInteger(target.event) && target.event >= 0) normalizedTarget.event = target.event;
        if (typeof target.offset === "number" && Number.isSafeInteger(target.offset) && target.offset >= 0) normalizedTarget.offset = target.offset;
      }
      if (kind === "file") {
        // Same repo-relative rules as parseDeeplink: RPC callers must not be
        // able to smuggle traversal/absolute paths past the URL parser.
        const filePath = asOptionalTrimmedString(target.path) ?? "";
        if (!isValidRepoRelativePath(filePath)) {
          throw new JsonRpcError(JsonRpcErrorCode.invalidParams, "app/navigate target 'file' requires a repo-relative path.");
        }
        normalizedTarget.path = filePath;
        if (typeof target.line === "number" && Number.isSafeInteger(target.line) && target.line > 0) normalizedTarget.line = target.line;
      }
      if (kind === "commit") {
        const sha = asOptionalTrimmedString(target.sha) ?? "";
        if (!isValidCommitSha(sha)) {
          throw new JsonRpcError(JsonRpcErrorCode.invalidParams, "app/navigate target 'commit' requires a 7-40 hex sha.");
        }
        normalizedTarget.sha = sha.toLowerCase();
      }
      if (kind === "artifact") {
        normalizedTarget.artifactId = asOptionalTrimmedString(target.artifactId);
      }
      if (kind === "work" || kind === "chat" || kind === "lane" || kind === "commit" || kind === "artifact") {
        const envelope = safeObject(target.envelope);
        const repoOwner = asOptionalTrimmedString(envelope.repoOwner);
        const repoName = asOptionalTrimmedString(envelope.repoName);
        const branch = asOptionalTrimmedString(envelope.branch);
        const linearIssue = asOptionalTrimmedString(envelope.linearIssue);
        const normalizedEnvelope: Record<string, unknown> = {};
        if (repoOwner) normalizedEnvelope.repoOwner = repoOwner;
        if (repoName) normalizedEnvelope.repoName = repoName;
        if (branch) normalizedEnvelope.branch = branch;
        if (typeof envelope.prNumber === "number" && Number.isSafeInteger(envelope.prNumber) && envelope.prNumber > 0) {
          normalizedEnvelope.prNumber = envelope.prNumber;
        }
        if (linearIssue) normalizedEnvelope.linearIssue = linearIssue;
        if (Object.keys(normalizedEnvelope).length > 0) normalizedTarget.envelope = normalizedEnvelope;
      }
      if (kind === "pr") {
        const prId = asOptionalTrimmedString(target.prId);
        if (prId) normalizedTarget.prId = prId;
        if (typeof target.prNumber === "number") normalizedTarget.prNumber = target.prNumber;
        const repoOwner = asOptionalTrimmedString(target.repoOwner);
        const repoName = asOptionalTrimmedString(target.repoName);
        if (repoOwner) normalizedTarget.repoOwner = repoOwner;
        if (repoName) normalizedTarget.repoName = repoName;
      }
      if (kind === "branch") {
        normalizedTarget.repoOwner = asOptionalTrimmedString(target.repoOwner);
        normalizedTarget.repoName = asOptionalTrimmedString(target.repoName);
        normalizedTarget.branch = asOptionalTrimmedString(target.branch);
        if (typeof target.prNumber === "number") normalizedTarget.prNumber = target.prNumber;
      }
      if (kind === "linear-issue") {
        normalizedTarget.issueIdentifier = asOptionalTrimmedString(target.issueIdentifier);
        const branch = asOptionalTrimmedString(target.branch);
        if (branch) normalizedTarget.branch = branch;
      }
      if (kind === "route") {
        normalizedTarget.route = asOptionalTrimmedString(target.route);
      }
      const request = {
        target: normalizedTarget,
        source: asOptionalTrimmedString(params.source) ?? "ade-rpc",
      } as AppNavigationRequest;
      if (!runtime.appNavigationService) {
        return {
          ok: false,
          mode: "unavailable",
          message: "Desktop navigation is unavailable in this runtime.",
        };
      }
      return await runtime.appNavigationService.navigate(request);
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
