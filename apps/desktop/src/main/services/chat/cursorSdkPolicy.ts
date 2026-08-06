import fs from "node:fs";
import path from "node:path";
import type { AgentChatSession } from "../../../shared/types";
import { cursorProjectSlug } from "../../../shared/cursorProjectSlug";
import {
  isOrchestrationLeadSession,
  ORCHESTRATION_LEAD_ALLOWED_CURSOR_TOOL_RISKS,
  ORCHESTRATION_LEAD_CURSOR_SETTING_SOURCES,
} from "../../../shared/orchestrationRuntimePolicy";
import type {
  CursorSdkApprovalPolicy,
  CursorSdkChatMode,
  CursorSdkHookDecision,
  CursorSdkHookRequest,
  CursorSdkPermissionPolicy,
} from "./cursorSdkProtocol";

type CursorSessionModeInput = Pick<AgentChatSession, "cursorModeId" | "opencodePermissionMode" | "permissionMode">
  & Partial<Pick<AgentChatSession, "interactionMode" | "orchestrationRole">>;

/** Mirrors `SettingSource` from `@cursor/sdk` (`local.settingSources`). */
export type CursorSdkSettingSource = "project" | "user" | "team" | "mdm" | "plugins" | "all";

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
  // Leads run under the same permissive `full-auto` profile as workers by
  // design; their protection is the risk gate in `evaluateCursorSdkHook`, which
  // this flag switches on.
  const orchestrationLead = isOrchestrationLeadSession(session);
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
      orchestrationLead,
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
      orchestrationLead,
    };
  }

  return {
    chatMode: "agent",
    approvalPolicy: "on-request",
    sandbox: "ade",
    force: false,
    hardGuards: true,
    orchestrationLead,
  };
}

/**
 * Ambient Cursor setting layers an agent may load (`local.settingSources`).
 *
 * The Cursor SDK derives `includeProjectMcp` / `includePluginMcp` from these
 * sources, so an orchestrator lead — which must see ADE-managed MCP servers
 * only — drops the `project` and `plugins` layers. `user` has to stay: ADE's
 * own preToolUse tool-gate hook is installed under the user's `~/.cursor` and
 * is the enforcement point for every Cursor lead denial (an MCP call arrives at
 * the gate as `MCP:<tool>`, classifies as risk `unknown`, and fails closed).
 * See ORCHESTRATION_LEAD_MCP_ISOLATION.cursor.
 */
export function cursorSdkSettingSources(
  policy: Pick<CursorSdkPermissionPolicy, "orchestrationLead">,
): CursorSdkSettingSource[] {
  if (!policy.orchestrationLead) return ["all"];
  return [...ORCHESTRATION_LEAD_CURSOR_SETTING_SOURCES];
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

function normalizedObjectKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isPathLikeKey(key: string): boolean {
  const normalized = normalizedObjectKey(key);
  return normalized === "path"
    || normalized === "paths"
    || normalized === "filepath"
    || normalized === "filepaths"
    || normalized === "file"
    || normalized === "files"
    || normalized === "filename"
    || normalized === "filenames"
    || normalized === "target"
    || normalized === "targetpath"
    || normalized === "targetpaths"
    || normalized === "targetdirectory"
    || normalized === "targetdirectories"
    || normalized === "directory"
    || normalized === "directories"
    || normalized === "dir"
    || normalized === "dirs"
    || normalized === "cwd"
    || normalized === "workingdirectory"
    || normalized === "root"
    || normalized === "roots"
    || normalized.endsWith("path")
    || normalized.endsWith("paths");
}

function isShellCommandKey(key: string): boolean {
  const normalized = normalizedObjectKey(key);
  return normalized === "command" || normalized === "cmd" || normalized === "shellcommand";
}

function shellWords(command: string): string[] {
  const words: string[] = [];
  const pattern = /"((?:\\.|[^"\\])*)"|'([^']*)'|`([^`]*)`|([^\s;&|()<>]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(command)) !== null) {
    const word = match[1] ?? match[2] ?? match[3] ?? match[4] ?? "";
    const trimmed = word.trim();
    if (trimmed.length > 0) words.push(trimmed);
  }
  return words;
}

function trimShellToken(token: string): string {
  return token.trim().replace(/^[=:,]+|[,:]+$/g, "");
}

/**
 * Windows shells use `\` as the path separator and `%VAR%` / `$env:VAR` for
 * expansion, so the POSIX-only token shapes below never match a Windows command
 * line. Backslash handling stays win32-gated because `\` is a legal filename
 * character (and a shell escape) on POSIX.
 */
const WINDOWS_HOME_PREFIX = /^(?:%(?:USERPROFILE|HOME)%|\$env:(?:USERPROFILE|HOME)|\$\{?env:(?:USERPROFILE|HOME)\}?)[\\/]/iu;

function isWindowsPathLikeToken(cleaned: string): boolean {
  if (WINDOWS_HOME_PREFIX.test(cleaned)) return true;
  if (
    cleaned.startsWith("..\\")
    || cleaned.startsWith(".\\")
    || cleaned.startsWith("\\")
  ) return true;
  if (!cleaned.includes("\\")) return false;
  // `FOO=bar\baz` is an assignment, not a path argument.
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(cleaned)) return false;
  return true;
}

function looksLikePathToken(token: string): boolean {
  const cleaned = trimShellToken(token);
  if (!cleaned || cleaned.startsWith("-") || cleaned.includes("://")) return false;
  if (/^[A-Za-z]:[\\/]/.test(cleaned)) return true;
  if (
    cleaned === ".."
    || cleaned.startsWith("../")
    || cleaned.startsWith("./")
    || cleaned.startsWith("/")
    || cleaned.startsWith("~/")
    || cleaned === "~"
    || cleaned.startsWith("$HOME/")
    || cleaned.startsWith("${HOME}/")
  ) return true;
  if (process.platform === "win32" && isWindowsPathLikeToken(cleaned)) return true;
  if (!cleaned.includes("/")) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(cleaned)) return false;
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(cleaned)) return false;
  return true;
}

function isWindowsAbsolutePath(candidate: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(candidate.trim());
}

function collectShellCommandPaths(command: string, out: string[]): void {
  for (const word of shellWords(command)) {
    const token = trimShellToken(word);
    const flagValue = /^--?[A-Za-z0-9][A-Za-z0-9_-]*=(.+)$/.exec(token)?.[1];
    if (flagValue && looksLikePathToken(flagValue)) {
      out.push(flagValue);
      continue;
    }
    const assignmentValue = /^[A-Za-z_][A-Za-z0-9_]*=(.+)$/.exec(token)?.[1];
    if (assignmentValue && looksLikePathToken(assignmentValue)) {
      out.push(assignmentValue);
      continue;
    }
    if (looksLikePathToken(token)) out.push(token);
  }
}

function collectPotentialPaths(value: unknown, out: string[] = [], pathContext = false): string[] {
  if (typeof value === "string") {
    const text = value.trim();
    if (pathContext && text.length > 0) out.push(text);
    return out;
  }
  if (!value || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    for (const item of value) collectPotentialPaths(item, out, pathContext);
    return out;
  }
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const keyIsPathLike = isPathLikeKey(key);
    if (typeof raw === "string" && raw.trim().length > 0 && keyIsPathLike) {
      out.push(raw.trim());
    } else if (typeof raw === "string" && isShellCommandKey(key)) {
      collectShellCommandPaths(raw, out);
    } else {
      collectPotentialPaths(raw, out, pathContext || keyIsPathLike);
    }
  }
  return out;
}

function nearestExistingPath(filePath: string): string | null {
  let current = path.resolve(filePath);
  for (let depth = 0; depth < 128; depth += 1) {
    if (fs.existsSync(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

function realPathWithNearestExistingAncestor(filePath: string): string {
  const resolved = path.resolve(filePath);
  const existing = nearestExistingPath(resolved);
  if (!existing) return resolved;
  let realExisting: string;
  try {
    realExisting = fs.realpathSync.native(existing);
  } catch {
    realExisting = path.resolve(existing);
  }
  const remainder = path.relative(existing, resolved);
  return remainder ? path.resolve(realExisting, remainder) : realExisting;
}

function isWithinPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveCandidatePath(candidate: string, cwd: string, userHomeDir?: string | null): string {
  // Windows equivalents of `$HOME/…`. Without this the guard resolves
  // `%USERPROFILE%\.ssh\id_rsa` literally under the lane root and lets it pass.
  if (process.platform === "win32" && userHomeDir?.trim()) {
    const windowsHome = WINDOWS_HOME_PREFIX.exec(candidate);
    if (windowsHome) {
      return path.resolve(userHomeDir, candidate.slice(windowsHome[0].length));
    }
  }
  if (candidate === "~" && userHomeDir?.trim()) return path.resolve(userHomeDir);
  if (candidate.startsWith("~/") && userHomeDir?.trim()) {
    return path.resolve(userHomeDir, candidate.slice(2));
  }
  if (candidate.startsWith("$HOME/") && userHomeDir?.trim()) {
    return path.resolve(userHomeDir, candidate.slice("$HOME/".length));
  }
  if (candidate.startsWith("${HOME}/") && userHomeDir?.trim()) {
    return path.resolve(userHomeDir, candidate.slice("${HOME}/".length));
  }
  return path.resolve(path.isAbsolute(candidate) ? candidate : cwd, path.isAbsolute(candidate) ? "" : candidate);
}

export function cursorProjectSlugForPath(projectPath: string): string {
  return cursorProjectSlug(path.resolve(projectPath));
}

function cursorSupportReadRoots(laneRoot: string, userHomeDir?: string | null): string[] {
  const home = userHomeDir?.trim();
  if (!home) return [];
  const projectRoot = path.join(home, ".cursor", "projects", cursorProjectSlugForPath(laneRoot));
  return [
    path.join(projectRoot, "terminals"),
    path.join(projectRoot, "agent-transcripts"),
  ];
}

function cursorSupportProjectRoot(laneRoot: string, userHomeDir: string): string {
  return path.join(userHomeDir, ".cursor", "projects", cursorProjectSlugForPath(laneRoot));
}

function isAllowedCursorSupportRead(args: {
  candidatePath: string;
  laneRoot: string;
  userHomeDir?: string | null;
  risk: CursorSdkHookRequest["risk"];
}): boolean {
  if (args.risk !== "read") return false;
  const home = args.userHomeDir?.trim();
  if (!home) return false;
  const projectsRootReal = realPathWithNearestExistingAncestor(path.join(home, ".cursor", "projects"));
  const projectRootReal = realPathWithNearestExistingAncestor(cursorSupportProjectRoot(args.laneRoot, home));
  if (!isWithinPath(projectsRootReal, projectRootReal)) return false;
  const candidateReal = realPathWithNearestExistingAncestor(args.candidatePath);
  for (const supportRoot of cursorSupportReadRoots(args.laneRoot, home)) {
    const rootReal = realPathWithNearestExistingAncestor(supportRoot);
    if (isWithinPath(rootReal, candidateReal)) return true;
  }
  return false;
}

function pathGuardReason(args: {
  laneRoot: string;
  cwd: string;
  value: unknown;
  risk: CursorSdkHookRequest["risk"];
  userHomeDir?: string | null;
}): string | null {
  const laneRoot = path.resolve(args.laneRoot);
  const laneRootReal = realPathWithNearestExistingAncestor(laneRoot);
  const cwd = path.resolve(args.cwd || laneRoot);
  const secretsRoot = path.join(laneRoot, ".ade", "secrets");
  const secretsRootReal = realPathWithNearestExistingAncestor(secretsRoot);
  const candidates = collectPotentialPaths(args.value);
  // If the tool input is itself a non-empty string path (e.g. a Bash command's
  // `cd /etc`-style argument), include it as a candidate so the lane/protected
  // path checks below still apply.
  if (
    candidates.length === 0
    && typeof args.value === "string"
    && args.value.trim().length > 0
  ) {
    collectShellCommandPaths(args.value, candidates);
  }
  for (const candidate of candidates) {
    if (process.platform !== "win32" && isWindowsAbsolutePath(candidate)) {
      return `Path is outside the active lane: ${candidate}`;
    }
    const resolved = resolveCandidatePath(candidate, cwd, args.userHomeDir);
    const realResolved = realPathWithNearestExistingAncestor(resolved);
    const relative = path.relative(laneRoot, resolved);
    const realRelative = path.relative(laneRootReal, realResolved);
    if (
      relative.startsWith("..")
      || path.isAbsolute(relative)
      || realRelative.startsWith("..")
      || path.isAbsolute(realRelative)
    ) {
      if (isAllowedCursorSupportRead({
        candidatePath: resolved,
        laneRoot,
        userHomeDir: args.userHomeDir,
        risk: args.risk,
      })) {
        continue;
      }
      return `Path is outside the active lane: ${candidate}`;
    }
    const normalizedRel = relative.split(path.sep).join("/");
    const realSecretsRelative = path.relative(secretsRootReal, realResolved);
    const isSecretReal = realSecretsRelative === "" || (!realSecretsRelative.startsWith("..") && !path.isAbsolute(realSecretsRelative));
    if (
      normalizedRel === ".ade/secrets"
      || normalizedRel.startsWith(".ade/secrets/")
      || isSecretReal
    ) {
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
  userHomeDir?: string | null;
}): "allow" | "deny" | "ask" {
  const guardReason = args.policy.hardGuards
    ? pathGuardReason({
      laneRoot: args.laneRoot,
      cwd: args.request.cwd,
      value: args.request.toolInput ?? args.request.raw,
      risk: args.request.risk,
      userHomeDir: args.userHomeDir,
    })
    : null;
  if (guardReason) {
    args.request.reason = guardReason;
    return "deny";
  }

  const normalized = normalizeToolName(args.request.toolName);
  // An orchestrator lead never edits code or runs shell, whatever its approval
  // policy says. Allow-list by risk so an unrecognised tool name (risk
  // "unknown") is denied rather than waved through by `approvalPolicy: never`.
  if (args.policy.orchestrationLead) {
    if ((ORCHESTRATION_LEAD_ALLOWED_CURSOR_TOOL_RISKS as readonly string[]).includes(args.request.risk)) {
      return "allow";
    }
    args.request.reason =
      "Orchestrator lead sessions cannot use Cursor's edit, shell, or subagent tools. Delegate the work to a worker instead.";
    return "deny";
  }
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
