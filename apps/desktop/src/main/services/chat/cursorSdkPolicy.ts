import path from "node:path";
import type { AgentChatSession } from "../../../shared/types";
import type {
  CursorSdkApprovalPolicy,
  CursorSdkChatMode,
  CursorSdkHookDecision,
  CursorSdkHookRequest,
  CursorSdkPermissionPolicy,
} from "./cursorSdkProtocol";

type CursorSessionModeInput = Pick<AgentChatSession, "cursorModeId" | "opencodePermissionMode" | "permissionMode">;

const READ_TOOL_NAMES = new Set([
  "read",
  "read_file",
  "readfile",
  "ls",
  "list",
  "glob",
  "grep",
  "search",
  "semsearch",
  "semantic_search",
  "read_lints",
]);

const WRITE_TOOL_NAMES = new Set([
  "write",
  "write_file",
  "edit",
  "delete",
  "move",
  "apply_patch",
  "update_todos",
  "create_plan",
]);

const SHELL_TOOL_NAMES = new Set(["shell", "bash", "terminal", "run_command", "command"]);
const TASK_TOOL_NAMES = new Set(["task", "subagent", "spawn_agent"]);
const NETWORK_TOOL_NAMES = new Set(["mcp", "fetch", "web", "web_search"]);

export function resolveCursorSdkChatMode(session: CursorSessionModeInput): CursorSdkChatMode {
  const explicit = typeof session.cursorModeId === "string" ? session.cursorModeId.trim().toLowerCase() : "";
  if (explicit === "ask" || explicit === "plan") return explicit;
  if (explicit === "agent" || explicit === "default") return "agent";
  const legacy = typeof session.opencodePermissionMode === "string"
    ? session.opencodePermissionMode
    : session.permissionMode === "plan"
      ? "plan"
      : session.permissionMode === "full-auto"
        ? "full-auto"
        : "edit";
  return legacy === "plan" ? "plan" : "agent";
}

export function resolveCursorSdkPolicy(session: CursorSessionModeInput): CursorSdkPermissionPolicy {
  const explicit = typeof session.cursorModeId === "string" ? session.cursorModeId.trim().toLowerCase() : "";
  const legacyFullAuto =
    !explicit.length
    && (session.opencodePermissionMode === "full-auto" || session.permissionMode === "full-auto");
  if (legacyFullAuto || explicit === "full-auto") {
    return {
      chatMode: "agent",
      approvalPolicy: "never",
      sandbox: "off",
      force: true,
      hardGuards: true,
    };
  }

  const chatMode = resolveCursorSdkChatMode(session);
  if (chatMode === "ask" || chatMode === "plan") {
    return {
      chatMode,
      approvalPolicy: "read-only",
      sandbox: "ade",
      force: false,
      hardGuards: true,
    };
  }

  return {
    chatMode: "agent",
    approvalPolicy: "on-request",
    sandbox: "ade",
    force: false,
    hardGuards: true,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length ? text : null;
}

function normalizeToolName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
}

function extractNestedRecord(record: Record<string, unknown>, keys: string[]): Record<string, unknown> | null {
  for (const key of keys) {
    const nested = asRecord(record[key]);
    if (nested) return nested;
  }
  return null;
}

export function summarizeCursorHook(raw: unknown, cwd: string): CursorSdkHookRequest {
  const record = asRecord(raw) ?? {};
  const nestedTool = extractNestedRecord(record, ["tool", "toolCall", "tool_call"]);
  const toolInput =
    record.toolInput
    ?? record.tool_input
    ?? record.input
    ?? record.args
    ?? nestedTool?.input
    ?? nestedTool?.args
    ?? null;
  const rawToolName =
    readString(record.toolName)
    ?? readString(record.tool_name)
    ?? readString(record.name)
    ?? readString(record.tool)
    ?? readString(nestedTool?.name)
    ?? readString(nestedTool?.toolName)
    ?? "unknown";
  const toolName = rawToolName.trim();
  const inputRecord = asRecord(toolInput);
  const command = readString(inputRecord?.command) ?? readString(inputRecord?.cmd);
  const pathValue =
    readString(inputRecord?.path)
    ?? readString(inputRecord?.filePath)
    ?? readString(inputRecord?.file_path)
    ?? readString(inputRecord?.targetPath)
    ?? readString(inputRecord?.target_path);
  const normalized = normalizeToolName(toolName);
  const risk =
    SHELL_TOOL_NAMES.has(normalized) ? "shell"
      : WRITE_TOOL_NAMES.has(normalized) ? "write"
      : READ_TOOL_NAMES.has(normalized) ? "read"
      : TASK_TOOL_NAMES.has(normalized) ? "task"
      : NETWORK_TOOL_NAMES.has(normalized) ? "network"
      : "unknown";
  const title = command
    ? command
    : pathValue
      ? `${toolName}: ${pathValue}`
      : toolName;
  return {
    id: "",
    toolName,
    title,
    summary: buildHookSummary(toolName, toolInput),
    cwd,
    raw,
    toolInput,
    risk,
  };
}

export function buildHookSummary(toolName: string, toolInput: unknown): string {
  const inputRecord = asRecord(toolInput);
  const command = readString(inputRecord?.command) ?? readString(inputRecord?.cmd);
  if (command) return command;
  const pathValue =
    readString(inputRecord?.path)
    ?? readString(inputRecord?.filePath)
    ?? readString(inputRecord?.file_path)
    ?? readString(inputRecord?.targetPath)
    ?? readString(inputRecord?.target_path);
  if (pathValue) return `${toolName} ${pathValue}`;
  return toolName;
}

function collectPotentialPaths(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") return out;
  if (!value || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    for (const item of value) collectPotentialPaths(item, out);
    return out;
  }
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.toLowerCase();
    if (
      typeof raw === "string"
      && raw.trim().length > 0
      && (normalized === "path"
        || normalized.endsWith("path")
        || normalized === "file"
        || normalized === "filename")
    ) {
      out.push(raw.trim());
    } else {
      collectPotentialPaths(raw, out);
    }
  }
  return out;
}

function pathGuardReason(args: {
  laneRoot: string;
  cwd: string;
  value: unknown;
}): string | null {
  const laneRoot = path.resolve(args.laneRoot);
  const cwd = path.resolve(args.cwd || laneRoot);
  for (const candidate of collectPotentialPaths(args.value)) {
    const resolved = path.resolve(path.isAbsolute(candidate) ? candidate : cwd, path.isAbsolute(candidate) ? "" : candidate);
    const relative = path.relative(laneRoot, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return `Path is outside the active lane: ${candidate}`;
    }
    const normalizedRel = relative.split(path.sep).join("/");
    if (normalizedRel === ".ade/secrets" || normalizedRel.startsWith(".ade/secrets/")) {
      return `Path is protected by ADE: ${candidate}`;
    }
  }
  return null;
}

export function evaluateCursorSdkHook(args: {
  request: CursorSdkHookRequest;
  policy: CursorSdkPermissionPolicy;
  laneRoot: string;
  sessionAllowedTools?: Set<string>;
}): "allow" | "deny" | "ask" {
  const guardReason = args.policy.hardGuards
    ? pathGuardReason({
      laneRoot: args.laneRoot,
      cwd: args.request.cwd,
      value: args.request.toolInput ?? args.request.raw,
    })
    : null;
  if (guardReason) {
    args.request.reason = guardReason;
    return "deny";
  }

  const normalized = normalizeToolName(args.request.toolName);
  if (args.policy.approvalPolicy === "never") return "allow";
  if (args.policy.approvalPolicy === "read-only") {
    return args.request.risk === "read" ? "allow" : "deny";
  }
  if (args.request.risk === "read") return "allow";
  if (args.sessionAllowedTools?.has(normalized)) return "allow";
  return "ask";
}

export function denyCursorHook(reason: string): CursorSdkHookDecision {
  return {
    permission: "deny",
    user_message: reason,
    agent_message: reason,
  };
}

export function allowCursorHook(): CursorSdkHookDecision {
  return { permission: "allow" };
}

export function approvalPolicyLabel(policy: CursorSdkApprovalPolicy): string {
  if (policy === "never") return "Full auto";
  if (policy === "read-only") return "Read-only";
  return "On request";
}
