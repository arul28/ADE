import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { runGit } from "../../desktop/src/main/services/git/git";
import type { ContextExportLevel, MissionInterventionStatus } from "../../desktop/src/shared/types";
import type { AdeMcpRuntime } from "./bootstrap";
import { JsonRpcError, JsonRpcErrorCode, type JsonRpcHandler, type JsonRpcRequest } from "./jsonrpc";

type ToolSpec = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

type SessionIdentity = {
  callerId: string;
  role: "orchestrator" | "agent" | "external";
  runId: string | null;
  attemptId: string | null;
  ownerId: string | null;
  allowMutations: boolean;
  allowSpawnAgent: boolean;
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
  }
];

const READ_ONLY_TOOLS = new Set([
  "read_context",
  "check_conflicts",
  "run_tests",
  "get_lane_status",
  "list_lanes"
]);

const MUTATION_TOOLS = new Set(["create_lane", "merge_lane", "commit_changes"]);

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

function extractLaneId(args: Record<string, unknown>): string | null {
  const fromPrimary = asOptionalTrimmedString(args.laneId);
  if (fromPrimary) return fromPrimary;
  const fromParent = asOptionalTrimmedString(args.parentLaneId);
  if (fromParent) return fromParent;
  return null;
}

function shellEscapeArg(value: string): string {
  if (!value.length) return "''";
  if (/^[a-zA-Z0-9_./:-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
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
    const abs = path.resolve(args.runtime.projectRoot, contextFilePathRaw);
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

function parseInitializeIdentity(params: unknown): SessionIdentity {
  const data = safeObject(params);
  const identity = safeObject(data.identity);
  const role = asTrimmedString(identity.role);

  return {
    callerId: asOptionalTrimmedString(identity.callerId) ?? "unknown",
    role: role === "orchestrator" || role === "agent" ? role : "external",
    runId: asOptionalTrimmedString(identity.runId),
    attemptId: asOptionalTrimmedString(identity.attemptId),
    ownerId: asOptionalTrimmedString(identity.ownerId),
    allowMutations: asBoolean(identity.allowMutations, false),
    allowSpawnAgent: asBoolean(identity.allowSpawnAgent, false)
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
  const match = TOOL_SPECS.find((entry) => entry.name === name);
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

function ensureMutationAuthorized(args: {
  runtime: AdeMcpRuntime;
  session: SessionState;
  laneId?: string | null;
  toolName: string;
}): void {
  if (args.session.identity.allowMutations) return;

  const now = nowIso();
  const baseWhere = [
    "project_id = ?",
    "state = 'active'",
    "expires_at > ?"
  ];
  const baseParams: Array<string> = [args.runtime.projectId, now];

  if (args.session.identity.runId) {
    baseWhere.push("run_id = ?");
    baseParams.push(args.session.identity.runId);
  }

  if (args.session.identity.ownerId) {
    baseWhere.push("owner_id = ?");
    baseParams.push(args.session.identity.ownerId);
  }

  const checkClaim = (scopeKind: "lane" | "env", scopeValues: string[]): boolean => {
    if (!scopeValues.length) return false;
    const placeholders = scopeValues.map(() => "?").join(", ");
    const row = args.runtime.db.get<{ count: number }>(
      `
        select count(*) as count
        from orchestrator_claims
        where ${baseWhere.join(" and ")}
          and scope_kind = ?
          and scope_value in (${placeholders})
      `,
      [...baseParams, scopeKind, ...scopeValues]
    );
    return Number(row?.count ?? 0) > 0;
  };

  if (args.laneId) {
    if (checkClaim("lane", [args.laneId, "*"])) {
      return;
    }
  }

  if (checkClaim("env", ["mcp:mutate", "lane:create", args.toolName, "*"])) {
    return;
  }

  throw new JsonRpcError(JsonRpcErrorCode.policyDenied, `Policy denied mutation tool '${args.toolName}'. Active claim required.`);
}

function ensureSpawnAuthorized(session: SessionState): void {
  if (session.identity.allowSpawnAgent) return;
  if (session.identity.role === "orchestrator") return;
  throw new JsonRpcError(
    JsonRpcErrorCode.policyDenied,
    "Policy denied spawn_agent. Only orchestrator sessions may spawn agents."
  );
}

function ensureAskUserAllowed(session: SessionState): void {
  const now = Date.now();
  const cutoff = now - session.askUserRateLimit.windowMs;
  session.askUserEvents = session.askUserEvents.filter((ts) => ts >= cutoff);
  if (session.askUserEvents.length >= session.askUserRateLimit.maxCalls) {
    throw new JsonRpcError(JsonRpcErrorCode.policyDenied, "ask_user rate limit exceeded.");
  }
  session.askUserEvents.push(now);
}

async function runTool(args: {
  runtime: AdeMcpRuntime;
  session: SessionState;
  name: string;
  toolArgs: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const { runtime, session, name, toolArgs } = args;

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
    ensureMutationAuthorized({ runtime, session, toolName: name, laneId: asOptionalTrimmedString(toolArgs.parentLaneId) });

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
    ensureMutationAuthorized({ runtime, session, laneId, toolName: name });

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
    ensureMutationAuthorized({ runtime, session, laneId: parentLaneId, toolName: name });

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
    ensureMutationAuthorized({ runtime, session, laneId, toolName: name });

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
    ensureSpawnAuthorized(session);

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
    const title = asOptionalTrimmedString(toolArgs.title) ?? `MCP Agent (${provider}${permissionMode === "plan" ? " · plan" : ""})`;
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
    }
    if (finalPrompt) {
      commandParts.push(shellEscapeArg(finalPrompt));
    }

    const startupCommand = commandParts.join(" ");

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
      runId: null,
      attemptId: null,
      ownerId: null,
      allowMutations: false,
      allowSpawnAgent: false
    },
    askUserEvents: [],
    askUserRateLimit: {
      maxCalls: 6,
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
        runId: session.identity.runId,
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
        tools: TOOL_SPECS.map((tool) => ({
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
          if (MUTATION_TOOLS.has(toolName)) {
            ensureMutationAuthorized({
              runtime,
              session,
              laneId: extractLaneId(toolArgs),
              toolName
            });
          }

          if (READ_ONLY_TOOLS.has(toolName) || MUTATION_TOOLS.has(toolName) || toolName === "spawn_agent" || toolName === "ask_user") {
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
