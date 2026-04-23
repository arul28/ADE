import { executableTool as tool, type ExecutableTool as Tool } from "./executableTool";
import { z } from "zod";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createReadFileRangeTool } from "./readFileRange";
import { createGrepSearchTool } from "./grepSearch";
import { createGlobSearchTool } from "./globSearch";
import { webFetchTool } from "./webFetch";
import { webSearchTool } from "./webSearch";
import { createMemoryTools, type MemoryWriteEvent, type TurnMemoryPolicyState } from "./memoryTools";
import type { createMemoryService } from "../../memory/memoryService";
import type { AgentChatApprovalDecision, AgentChatEvent, WorkerSandboxConfig, CtoCoreMemory } from "../../../../shared/types";
import { DEFAULT_WORKER_SANDBOX_CONFIG } from "../../orchestrator/orchestratorConstants";
import { getErrorMessage, isEnoentError, isWithinDir, resolvePathWithinRoot } from "../../shared/utils";
import { terminateProcessTree } from "../../shared/processExecution";

const execFileAsync = promisify(execFile);

export type PermissionMode = "plan" | "edit" | "full-auto";

export type AskUserToolOption = {
  label: string;
  value?: string;
  description?: string;
  recommended?: boolean;
  preview?: string;
  previewFormat?: "markdown" | "html";
};

export type AskUserToolQuestion = {
  id?: string;
  header?: string;
  question: string;
  options?: AskUserToolOption[];
  multiSelect?: boolean;
  allowsFreeform?: boolean;
  isSecret?: boolean;
  defaultAssumption?: string | null;
  impact?: string | null;
};

export type AskUserToolInput = {
  question?: string;
  title?: string;
  body?: string;
  questions?: AskUserToolQuestion[];
};

export type AskUserToolResult = {
  answer: string;
  answers?: Record<string, string[]>;
  responseText?: string | null;
  decision?: string;
  error?: string;
};

export type TodoToolItem = Extract<AgentChatEvent, { type: "todo_update" }>["items"][number];

export interface UniversalToolSetOptions {
  permissionMode: PermissionMode;
  memoryService?: ReturnType<typeof createMemoryService>;
  projectId?: string;
  runId?: string;
  stepId?: string;
  agentScopeOwnerId?: string;
  turnMemoryPolicyState?: TurnMemoryPolicyState;
  onMemoryWriteEvent?: (event: MemoryWriteEvent) => void;
  /** Optional CTO core-memory updater for fallback/unified runtimes. */
  onMemoryUpdateCore?: (patch: Partial<Omit<CtoCoreMemory, "version" | "updatedAt">>) => {
    version: number;
    updatedAt: string;
  };
  /** Callback invoked when askUser tool is called; must return the user's response */
  onAskUser?: (input: AskUserToolInput) => Promise<string | AskUserToolResult>;
  /** Optional callback for TodoWrite/TodoRead session state in interactive chat sessions. */
  onTodoUpdate?: (items: TodoToolItem[]) => void;
  getTodoItems?: () => TodoToolItem[];
  /** Optional callback for ADE-managed tool approvals in interactive chat sessions. */
  onApprovalRequest?: (request: ToolApprovalRequest) => Promise<ToolApprovalResult>;
  /** Sandbox config for API-model workers. CLI models skip this check. */
  sandboxConfig?: WorkerSandboxConfig;
}

// ── Permission helpers ──────────────────────────────────────────────

type ToolCategory = "read" | "write" | "bash";

type ToolApprovalRequest = {
  category: Exclude<ToolCategory, "read"> | "exitPlanMode";
  description: string;
  detail?: unknown;
};

type ToolApprovalResult = {
  approved: boolean;
  decision?: AgentChatApprovalDecision;
  reason?: string | null;
};

function requiresApproval(mode: PermissionMode, category: ToolCategory): boolean {
  switch (mode) {
    case "plan":
      return false;
    case "edit":
      return category === "bash";
    case "full-auto":
      return false;
  }
}

function approvalProp(
  mode: PermissionMode,
  category: ToolCategory,
  useManualApproval: boolean,
): { needsApproval: boolean } | Record<string, never> {
  const needs = requiresApproval(mode, category);
  if (!needs || useManualApproval) return {};
  return { needsApproval: true };
}

async function maybeRequestApproval(args: {
  mode: PermissionMode;
  category: Exclude<ToolCategory, "read">;
  onApprovalRequest?: (request: ToolApprovalRequest) => Promise<ToolApprovalResult>;
  description: string;
  detail?: unknown;
}): Promise<ToolApprovalResult> {
  if (!requiresApproval(args.mode, args.category)) {
    return { approved: true };
  }

  if (!args.onApprovalRequest) {
    return { approved: true };
  }

  try {
    return await args.onApprovalRequest({
      category: args.category,
      description: args.description,
      detail: args.detail,
    });
  } catch (err) {
    return {
      approved: false,
      reason: getErrorMessage(err) || "Approval request failed.",
    };
  }
}

// ── Worker sandbox enforcement ──────────────────────────────────────

/** Pre-compiled sandbox patterns to avoid regex recompilation on every bash call. */
type CompiledSandbox = {
  blocked: Array<{ re: RegExp; src: string }>;
  safe: RegExp[];
  protected: Array<{ re: RegExp; src: string }>;
};

const compiledSandboxCache = new WeakMap<WorkerSandboxConfig, CompiledSandbox>();

function compileSandbox(config: WorkerSandboxConfig): CompiledSandbox {
  const cached = compiledSandboxCache.get(config);
  if (cached) return cached;
  const compiled: CompiledSandbox = {
    blocked: config.blockedCommands.map((p) => ({ re: new RegExp(p, "i"), src: p })),
    safe: config.safeCommands.map((p) => new RegExp(p)),
    protected: config.protectedFiles.map((p) => ({ re: new RegExp(p, "i"), src: p })),
  };
  compiledSandboxCache.set(config, compiled);
  return compiled;
}

const WRITE_COMMAND_RE = /(?:>|>>|\btee\b|\bcp\s|\bmv\s|\brm\s|\bwrite\b|\bedit\b)/;
const MUTATING_BASH_RE = /\b(?:rm|mv|cp|mkdir|touch|chmod|chown|patch|install|uninstall|add|remove|upgrade|apply|commit|rebase|merge|reset|checkout|switch|restore|sed\s+-i|perl\s+-i)\b|>>?|tee\b/i;
const MUTATING_CMD_RE = /\b(?:copy|xcopy|robocopy|move|del|erase|rd|rmdir|md|mkdir|ren|rename)\b|>>?|tee\b/i;

const MEMORY_GUARD_REASON = "Search memory before mutating files or running mutating commands for this turn.";

type PathAccessMode = "read" | "write" | "unknown";
type PathReference = {
  raw: string;
  resolved: string;
  access: PathAccessMode;
};

type PowerShellInspection = {
  mutates: boolean;
  pathRefs: PathReference[];
  blockedReason?: string;
};

type PowerShellMutationKind =
  | "copy"
  | "move"
  | "new-item"
  | "out-file"
  | "path-write"
  | "provider-item"
  | "remove"
  | "rename";

const POWERSHELL_COMMAND_FLAGS = new Set(["-command", "-c"]);
const POWERSHELL_ENCODED_COMMAND_FLAGS = new Set(["-encodedcommand", "-enc", "-e"]);
const POWERSHELL_FILE_FLAGS = new Set(["-file"]);
const POWERSHELL_SEGMENT_SEPARATORS = new Set(["|", "||", "&&", ";"]);
const POWERSHELL_PUNCTUATION_TOKENS = new Set(["{", "}", "(", ")", ","]);
const POWERSHELL_SWITCH_PARAMETERS = new Set([
  "-append",
  "-confirm",
  "-debug",
  "-force",
  "-noclobber",
  "-nonewline",
  "-passthru",
  "-recurse",
  "-verbose",
  "-whatif",
]);
const POWERSHELL_MUTATION_KIND_BY_COMMAND = new Map<string, PowerShellMutationKind>([
  ["add-content", "path-write"],
  ["ac", "path-write"],
  ["clear-content", "path-write"],
  ["copy", "copy"],
  ["copy-item", "copy"],
  ["cpi", "copy"],
  ["cp", "copy"],
  ["move", "move"],
  ["move-item", "move"],
  ["mv", "move"],
  ["mi", "move"],
  ["new-item", "new-item"],
  ["ni", "new-item"],
  ["out-file", "out-file"],
  ["remove-item", "remove"],
  ["del", "remove"],
  ["erase", "remove"],
  ["rd", "remove"],
  ["ri", "remove"],
  ["rm", "remove"],
  ["rmdir", "remove"],
  ["rename-item", "rename"],
  ["ren", "rename"],
  ["rni", "rename"],
  ["set-content", "path-write"],
  ["set-item", "provider-item"],
  ["set-itemproperty", "provider-item"],
  ["new-itemproperty", "provider-item"],
  ["remove-itemproperty", "provider-item"],
  ["rename-itemproperty", "provider-item"],
  ["move-itemproperty", "provider-item"],
  ["clear-itemproperty", "provider-item"],
]);

function requiresTurnMemoryGuard(state?: TurnMemoryPolicyState): boolean {
  return !!state && state.classification === "required" && !state.orientationSatisfied && !state.explicitSearchPerformed;
}

function tokenizePowerShellCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  const pushCurrent = () => {
    if (current.length > 0) {
      tokens.push(current);
      current = "";
    }
  };

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "`") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === ">") {
      if (/^\d$/.test(current)) {
        const fd = current;
        current = "";
        const next = command[i + 1];
        if (next === ">") {
          tokens.push(`${fd}>>`);
          i += 1;
        } else {
          tokens.push(`${fd}>`);
        }
        continue;
      }
      pushCurrent();
      const next = command[i + 1];
      if (next === ">") {
        tokens.push(">>");
        i += 1;
      } else {
        tokens.push(">");
      }
      continue;
    }
    if (ch === "|" || ch === "&" || ch === ";") {
      pushCurrent();
      const next = command[i + 1];
      if ((ch === "|" || ch === "&") && next === ch) {
        tokens.push(`${ch}${ch}`);
        i += 1;
      } else {
        tokens.push(ch);
      }
      continue;
    }
    if (/\s/.test(ch)) {
      pushCurrent();
      continue;
    }
    if (POWERSHELL_PUNCTUATION_TOKENS.has(ch)) {
      pushCurrent();
      tokens.push(ch);
      continue;
    }
    current += ch;
  }

  pushCurrent();
  return tokens;
}

function splitPowerShellSegments(tokens: string[]): string[][] {
  const segments: string[][] = [];
  let current: string[] = [];
  for (const token of tokens) {
    const normalizedToken = normalizePathToken(token);
    if (POWERSHELL_SEGMENT_SEPARATORS.has(token) || POWERSHELL_SEGMENT_SEPARATORS.has(normalizedToken)) {
      if (current.length > 0) segments.push(current);
      current = [];
      continue;
    }
    current.push(token);
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

function isPowerShellHostCommand(commandName: string): boolean {
  const baseName = path.win32.basename(normalizePathToken(commandName)).toLowerCase();
  return baseName === "powershell" || baseName === "powershell.exe" || baseName === "pwsh" || baseName === "pwsh.exe";
}

function isCmdHostCommand(commandName: string): boolean {
  const baseName = path.win32.basename(normalizePathToken(commandName)).toLowerCase();
  return baseName === "cmd" || baseName === "cmd.exe";
}

function isPowerShellScriptPath(value: string): boolean {
  return /\.ps1$/i.test(normalizePathToken(value));
}

function decodePowerShellEncodedCommand(value: string): string | null {
  const trimmed = normalizePathToken(value);
  if (!trimmed.length || !/^[a-z0-9+/=]+$/i.test(trimmed)) {
    return null;
  }
  try {
    const decoded = Buffer.from(trimmed, "base64").toString("utf16le");
    return decoded.trim().length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

function isPowerShellParameterToken(value: string): boolean {
  return /^-[a-z]/i.test(value);
}

function isPowerShellSwitchParameterToken(value: string): boolean {
  return POWERSHELL_SWITCH_PARAMETERS.has(value.toLowerCase());
}

function isPowerShellDynamicArgument(value: string): boolean {
  return value.startsWith("$") || value.startsWith("@(") || value.includes("$(");
}

function isPowerShellOpaquePathSyntax(value: string): boolean {
  const trimmed = value.trim();
  return (
    !trimmed.length ||
    trimmed === "@" ||
    trimmed === "$" ||
    POWERSHELL_PUNCTUATION_TOKENS.has(trimmed) ||
    trimmed.startsWith("(") ||
    trimmed.startsWith("@(") ||
    trimmed.includes("$(")
  );
}

function normalizePowerShellPathArgument(value: string): { path?: string; nonFilesystemProvider?: string; opaque?: string } {
  const normalized = normalizePathToken(value);
  if (!normalized.length) return {};
  if (isPowerShellDynamicArgument(normalized)) {
    return { opaque: normalized };
  }

  const fileSystemQualified = normalized.match(/^(?:microsoft\.powershell\.core\\)?filesystem::(.+)$/i);
  if (fileSystemQualified?.[1]) {
    return { path: fileSystemQualified[1] };
  }
  if (/^(?:microsoft\.powershell\.core\\)?registry::/i.test(normalized)) {
    return { nonFilesystemProvider: normalized };
  }
  if (/^[a-z]:/.test(normalized)) {
    return { path: normalized };
  }
  if (/^(?:[a-z][a-z0-9+.-]*::|[a-z][a-z0-9+.-]*:)/i.test(normalized)) {
    return { nonFilesystemProvider: normalized };
  }
  return { path: normalized };
}

function parsePowerShellArgs(args: string[]): { positional: string[]; named: Map<string, string[]> } {
  const positional: string[] = [];
  const named = new Map<string, string[]>();

  for (let i = 0; i < args.length; i += 1) {
    const raw = normalizePathToken(args[i] ?? "");
    if (!raw.length || POWERSHELL_PUNCTUATION_TOKENS.has(raw)) continue;

    const inlineMatch = raw.match(/^(-[a-z][a-z0-9-]*):(.*)$/i);
    if (inlineMatch) {
      const key = inlineMatch[1]!.toLowerCase();
      const value = normalizePathToken(inlineMatch[2] ?? "");
      named.set(key, value.length > 0 ? [value] : [""]);
      continue;
    }

    if (isPowerShellParameterToken(raw)) {
      const key = raw.toLowerCase();
      if (isPowerShellSwitchParameterToken(key)) {
        const values = named.get(key) ?? [];
        values.push("");
        named.set(key, values);
        continue;
      }
      const next = normalizePathToken(args[i + 1] ?? "");
      if (next.length > 0 && !isPowerShellParameterToken(next) && !POWERSHELL_PUNCTUATION_TOKENS.has(next)) {
        const values = named.get(key) ?? [];
        values.push(next);
        named.set(key, values);
        i += 1;
      } else {
        const values = named.get(key) ?? [];
        values.push("");
        named.set(key, values);
      }
      continue;
    }

    positional.push(raw);
  }

  return { positional, named };
}

function inspectPowerShellInvocations(
  command: string,
  cwd: string,
  pathApi: SandboxPathApi = getSandboxPathApi(cwd, command),
  depth = 0,
): PowerShellInspection {
  const refs = new Map<string, PathReference>();
  const accessPriority: Record<PathAccessMode, number> = {
    unknown: 0,
    read: 1,
    write: 2,
  };

  const addResolvedPath = (rawValue: string, access: PathAccessMode): { blockedReason?: string } => {
    if (access !== "read" && isPowerShellOpaquePathSyntax(rawValue)) {
      return { blockedReason: `PowerShell mutation uses an uninspectable path argument: ${rawValue}` };
    }
    const normalized = normalizePathToken(rawValue);
    if (!normalized.length || normalized.includes("://")) return {};

    const normalizedPath = normalizePowerShellPathArgument(normalized);
    if (normalizedPath.opaque) {
      if (access !== "read") {
        return { blockedReason: `PowerShell mutation uses a non-literal path argument: ${normalizedPath.opaque}` };
      }
      return {};
    }
    if (normalizedPath.nonFilesystemProvider) {
      if (access !== "read") {
        return { blockedReason: `PowerShell mutation targets non-filesystem provider path: ${normalizedPath.nonFilesystemProvider}` };
      }
      return {};
    }

    const candidate = normalizedPath.path;
    if (!candidate || candidate === "/dev/null") return {};
    const expandedPath =
      candidate === "~"
        ? os.homedir()
        : candidate.startsWith("~/")
          ? pathApi.join(os.homedir(), candidate.slice(2))
          : pathApi === path.win32 && candidate.startsWith("~\\")
            ? pathApi.join(os.homedir(), candidate.slice(2))
            : candidate;
    const resolved = pathApi.resolve(cwd, expandedPath);
    const key = `${candidate}::${resolved}`;
    const existing = refs.get(key);
    if (!existing || accessPriority[access] > accessPriority[existing.access]) {
      refs.set(key, { raw: candidate, resolved, access });
    }
    return {};
  };

  const addFirstNamedOrPositionalPath = (
    parsed: ReturnType<typeof parsePowerShellArgs>,
    flags: string[],
    positionalIndex: number | null,
    access: PathAccessMode,
    failOnMissing = true,
  ): { blockedReason?: string } => {
    for (const flag of flags) {
      const values = parsed.named.get(flag);
      if (values?.length) {
        return addResolvedPath(values[0]!, access);
      }
    }
    if (positionalIndex !== null && parsed.positional[positionalIndex]) {
      return addResolvedPath(parsed.positional[positionalIndex]!, access);
    }
    if (access !== "read" && failOnMissing) {
      return { blockedReason: "PowerShell mutation path argument is not inspectable by the worker sandbox" };
    }
    return {};
  };

  const mergeInspection = (inspection: PowerShellInspection) => {
    for (const entry of inspection.pathRefs) {
      const key = `${entry.raw}::${entry.resolved}`;
      const existing = refs.get(key);
      if (!existing || accessPriority[entry.access] > accessPriority[existing.access]) {
        refs.set(key, entry);
      }
    }
  };

  const inspectScriptFile = (rawScriptPath: string): PowerShellInspection => {
    const trimmed = rawScriptPath.trim();
    if (isPowerShellOpaquePathSyntax(trimmed) || isPowerShellDynamicArgument(trimmed)) {
      return {
        mutates: true,
        pathRefs: [...refs.values()],
        blockedReason: `PowerShell script path is not inspectable by the worker sandbox: ${trimmed}`,
      };
    }

    const normalizedPath = normalizePowerShellPathArgument(trimmed);
    if (normalizedPath.opaque || normalizedPath.nonFilesystemProvider || !normalizedPath.path) {
      return {
        mutates: true,
        pathRefs: [...refs.values()],
        blockedReason: `PowerShell script path is not inspectable by the worker sandbox: ${trimmed}`,
      };
    }

    const addScriptRef = addResolvedPath(normalizedPath.path, "read");
    if (addScriptRef.blockedReason) {
      return { mutates: true, pathRefs: [...refs.values()], blockedReason: addScriptRef.blockedReason };
    }

    const scriptPath = pathApi.resolve(cwd, normalizedPath.path);
    try {
      const realCwd = canonicalizePathForContainment(cwd, pathApi);
      const realScriptPath = canonicalizePathForContainment(scriptPath, pathApi);
      if (!isWithinDirForPathApi(pathApi, realCwd, realScriptPath)) {
        return {
          mutates: true,
          pathRefs: [...refs.values()],
          blockedReason: `PowerShell script file is outside the inspectable sandbox root: ${normalizedPath.path}`,
        };
      }
      if (!fs.existsSync(realScriptPath) || !fs.statSync(realScriptPath).isFile()) {
        return {
          mutates: true,
          pathRefs: [...refs.values()],
          blockedReason: `PowerShell script file is not inspectable by the worker sandbox: ${normalizedPath.path}`,
        };
      }
      const script = fs.readFileSync(realScriptPath, "utf-8");
      return inspectPowerShellScript(script);
    } catch {
      return {
        mutates: true,
        pathRefs: [...refs.values()],
        blockedReason: `PowerShell script file is not inspectable by the worker sandbox: ${normalizedPath.path}`,
      };
    }
  };

  const inspectPowerShellScript = (script: string): PowerShellInspection => {
    let scriptMutates = false;
    const tokens = tokenizePowerShellCommand(script);
    for (let i = 0; i < tokens.length; i += 1) {
      const token = normalizePathToken(tokens[i] ?? "");
      if (!token.length) continue;
      if (token === ">" || token === ">>" || /^\d>>?$/.test(token)) {
        scriptMutates = true;
        const writeTarget = addResolvedPath(tokens[i + 1] ?? "", "write");
        if (writeTarget.blockedReason) {
          return {
            mutates: true,
            pathRefs: [...refs.values()],
            blockedReason: writeTarget.blockedReason,
          };
        }
      }
    }

    for (const innerSegment of splitPowerShellSegments(tokens)) {
      let innerCommandIndex = 0;
      while (innerCommandIndex < innerSegment.length) {
        const token = normalizePathToken(innerSegment[innerCommandIndex] ?? "");
        if (!token.length || token === "&" || token === "." || POWERSHELL_PUNCTUATION_TOKENS.has(token)) {
          innerCommandIndex += 1;
          continue;
        }
        break;
      }
      if (innerCommandIndex >= innerSegment.length) continue;

      const innerCommandToken = normalizePathToken(innerSegment[innerCommandIndex] ?? "");
      const innerCommandName = innerCommandToken.toLowerCase();
      if (isPowerShellScriptPath(innerCommandToken)) {
        const scriptFileInspection = inspectScriptFile(innerCommandToken);
        mergeInspection(scriptFileInspection);
        if (scriptFileInspection.blockedReason) return { ...scriptFileInspection, pathRefs: [...refs.values()] };
        scriptMutates = scriptMutates || scriptFileInspection.mutates;
        continue;
      }

      const mutationKind = POWERSHELL_MUTATION_KIND_BY_COMMAND.get(innerCommandName);
      if (!mutationKind) continue;
      scriptMutates = true;

      const parsed = parsePowerShellArgs(innerSegment.slice(innerCommandIndex + 1));
      let result: { blockedReason?: string } = {};

      switch (mutationKind) {
        case "path-write":
          result = addFirstNamedOrPositionalPath(parsed, ["-path", "-literalpath", "-pspath", "-lp"], 0, "write");
          break;
        case "out-file":
          result = addFirstNamedOrPositionalPath(parsed, ["-filepath", "-literalpath", "-path", "-pspath", "-lp"], 0, "write");
          break;
        case "copy": {
          result = addFirstNamedOrPositionalPath(parsed, ["-path", "-literalpath", "-pspath", "-lp"], 0, "read");
          if (result.blockedReason) break;
          result = addFirstNamedOrPositionalPath(parsed, ["-destination"], 1, "write");
          break;
        }
        case "move": {
          result = addFirstNamedOrPositionalPath(parsed, ["-path", "-literalpath", "-pspath", "-lp"], 0, "write");
          if (result.blockedReason) break;
          result = addFirstNamedOrPositionalPath(parsed, ["-destination"], 1, "write");
          break;
        }
        case "remove":
          result = addFirstNamedOrPositionalPath(parsed, ["-path", "-literalpath", "-pspath", "-lp"], 0, "write");
          break;
        case "rename":
          result = addFirstNamedOrPositionalPath(parsed, ["-path", "-literalpath", "-pspath", "-lp"], 0, "write");
          if (result.blockedReason) break;
          result = addFirstNamedOrPositionalPath(parsed, ["-newname"], 1, "write");
          break;
        case "new-item":
          result = addFirstNamedOrPositionalPath(parsed, ["-path", "-literalpath", "-pspath", "-lp"], 0, "write", false);
          if (result.blockedReason) break;
          if (parsed.named.get("-name")?.[0]) {
            result = addResolvedPath(parsed.named.get("-name")![0]!, "write");
          }
          break;
        case "provider-item":
          result = addFirstNamedOrPositionalPath(parsed, ["-path", "-literalpath", "-pspath", "-lp"], 0, "write");
          break;
      }

      if (result.blockedReason) {
        return {
          mutates: true,
          pathRefs: [...refs.values()],
          blockedReason: result.blockedReason,
        };
      }
    }

    return { mutates: scriptMutates, pathRefs: [...refs.values()] };
  };

  const outerSegments = splitCommandSegments(tokenizeCommand(command, pathApi === path.win32));
  let mutates = false;

  for (const segment of outerSegments) {
    const commandName = normalizePathToken(segment[0] ?? "");
    if (!commandName.length) continue;

    if (isCmdHostCommand(commandName)) {
      if (depth >= 4) {
        return {
          mutates: true,
          pathRefs: [...refs.values()],
          blockedReason: "Nested cmd.exe /c command is not inspectable by the worker sandbox",
        };
      }
      const commandArgIndex = segment.findIndex((arg, index) => index > 0 && /^\/c$/i.test(normalizePathToken(arg)));
      if (commandArgIndex >= 0) {
        const nestedCommand = segment.slice(commandArgIndex + 1).join(" ").trim();
        if (!nestedCommand.length) {
          return {
            mutates: true,
            pathRefs: [...refs.values()],
            blockedReason: "cmd.exe /c payload is not inspectable by the worker sandbox",
          };
        }
        const nestedInspection = inspectPowerShellInvocations(nestedCommand, cwd, pathApi, depth + 1);
        mergeInspection(nestedInspection);
        if (nestedInspection.blockedReason) return { ...nestedInspection, pathRefs: [...refs.values()] };
        mutates = mutates || nestedInspection.mutates;
      }
      continue;
    }

    if (isPowerShellScriptPath(commandName)) {
      const scriptFileInspection = inspectScriptFile(commandName);
      mergeInspection(scriptFileInspection);
      if (scriptFileInspection.blockedReason) return { ...scriptFileInspection, pathRefs: [...refs.values()] };
      mutates = mutates || scriptFileInspection.mutates;
      continue;
    }

    if (!isPowerShellHostCommand(commandName)) continue;

    const args = segment.slice(1);
    let script: string | null = null;
    for (let i = 0; i < args.length; i += 1) {
      const flag = normalizePathToken(args[i] ?? "").toLowerCase();
      if (POWERSHELL_COMMAND_FLAGS.has(flag)) {
        const remainder = args.slice(i + 1).join(" ").trim();
        if (!remainder.length || remainder === "-") {
          return {
            mutates: true,
            pathRefs: [...refs.values()],
            blockedReason: "PowerShell -Command input is not inspectable by the worker sandbox",
          };
        }
        script = remainder;
        break;
      }
      if (POWERSHELL_ENCODED_COMMAND_FLAGS.has(flag)) {
        const decoded = decodePowerShellEncodedCommand(args[i + 1] ?? "");
        if (!decoded) {
          return {
            mutates: true,
            pathRefs: [...refs.values()],
            blockedReason: "PowerShell -EncodedCommand payload is not inspectable by the worker sandbox",
          };
        }
        script = decoded;
        break;
      }
      if (POWERSHELL_FILE_FLAGS.has(flag)) {
        const scriptPath = args[i + 1] ?? "";
        const scriptFileInspection = inspectScriptFile(scriptPath);
        mergeInspection(scriptFileInspection);
        if (scriptFileInspection.blockedReason) return { ...scriptFileInspection, pathRefs: [...refs.values()] };
        mutates = mutates || scriptFileInspection.mutates;
        script = null;
        break;
      }
    }

    if (!script) continue;
    const scriptInspection = inspectPowerShellScript(script);
    mergeInspection(scriptInspection);
    if (scriptInspection.blockedReason) return { ...scriptInspection, pathRefs: [...refs.values()] };
    mutates = mutates || scriptInspection.mutates;
  }

  return { mutates, pathRefs: [...refs.values()] };
}

function bashCommandLikelyMutates(
  command: string,
  cwd = process.cwd(),
  powerShellInspection?: PowerShellInspection,
): boolean {
  const inspection = powerShellInspection ?? inspectPowerShellInvocations(command, cwd);
  return inspection.mutates || !!inspection.blockedReason || MUTATING_BASH_RE.test(command) || MUTATING_CMD_RE.test(command) || WRITE_COMMAND_RE.test(command);
}

function resolveAllowedWriteRoots(cwd: string, sandboxConfig?: WorkerSandboxConfig, pathApi: SandboxPathApi = getSandboxPathApi(cwd)): string[] {
  const roots = new Set<string>([pathApi.resolve(cwd)]);
  if (sandboxConfig?.allowedPaths) {
    for (const allowedPath of sandboxConfig.allowedPaths) {
      if (typeof allowedPath !== "string" || allowedPath.trim().length === 0) continue;
      roots.add(pathApi.resolve(cwd, allowedPath));
    }
  }
  return [...roots];
}

type SandboxPathApi = typeof path | typeof path.win32;

function isWindowsPathLike(value: string): boolean {
  const trimmed = value.trim();
  return (
    /^[a-zA-Z]:$/.test(trimmed) ||
    /(?:^|[\s"'`(=])[a-zA-Z]:[\\/]/.test(value) ||
    trimmed.startsWith("\\\\")
  );
}

function getSandboxPathApi(cwd: string, commandOrPath = ""): SandboxPathApi {
  return process.platform === "win32" || isWindowsPathLike(cwd) || isWindowsPathLike(commandOrPath)
    ? path.win32
    : path;
}

function isWithinDirForPathApi(pathApi: SandboxPathApi, root: string, candidate: string): boolean {
  const normalizedRoot = pathApi === path.win32 ? root.toLowerCase() : root;
  const normalizedCandidate = pathApi === path.win32 ? candidate.toLowerCase() : candidate;
  const rel = pathApi.relative(normalizedRoot, normalizedCandidate);
  return rel === "" || (!rel.startsWith("..") && !pathApi.isAbsolute(rel));
}

function canonicalizePathForContainment(absPath: string, pathApi: SandboxPathApi = getSandboxPathApi(absPath)): string {
  const resolved = pathApi.resolve(absPath);
  if (pathApi === path.win32 && process.platform !== "win32") {
    return resolved;
  }
  try {
    return fs.realpathSync(resolved);
  } catch (error) {
    if (!isEnoentError(error)) {
      throw error;
    }
  }

  const parent = pathApi.dirname(resolved);
  if (parent === resolved) {
    return resolved;
  }
  return pathApi.join(canonicalizePathForContainment(parent, pathApi), pathApi.basename(resolved));
}

function toPortablePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function matchesProtectedPathPattern(
  pattern: { re: RegExp; src: string },
  cwd: string,
  filePath: string,
  targetPath: string,
  pathApi: SandboxPathApi = getSandboxPathApi(cwd, filePath),
): boolean {
  const resolvedCwd = pathApi.resolve(cwd);
  const normalizedRaw = normalizePathToken(filePath);
  const normalizedTarget = toPortablePath(targetPath);
  const relativeTarget = toPortablePath(pathApi.relative(resolvedCwd, targetPath));
  const candidates = new Set<string>([
    normalizedRaw,
    normalizedTarget,
    pathApi.basename(targetPath),
  ]);
  if (relativeTarget.length && !relativeTarget.startsWith("..") && !pathApi.isAbsolute(relativeTarget)) {
    candidates.add(relativeTarget);
  }
  return [...candidates].some((candidate) => candidate.length > 0 && pattern.re.test(candidate));
}

function resolveWritableTargetPath(
  cwd: string,
  filePath: string,
  sandboxConfig?: WorkerSandboxConfig,
): { targetPath: string | null; error?: string } {
  const pathApi = getSandboxPathApi(cwd, filePath);
  const targetPath = pathApi.resolve(cwd, filePath);
  const realCwd = canonicalizePathForContainment(cwd, pathApi);
  const realTargetPath = canonicalizePathForContainment(targetPath, pathApi);
  const allowedRoots = resolveAllowedWriteRoots(cwd, sandboxConfig, pathApi).map((allowedRoot) =>
    canonicalizePathForContainment(allowedRoot, pathApi),
  );
  const withinAllowedRoots = allowedRoots.some((allowedRoot) => isWithinDirForPathApi(pathApi, allowedRoot, realTargetPath));
  if (!withinAllowedRoots) {
    return {
      targetPath: null,
      error: `Write path is outside allowed roots: ${filePath}`,
    };
  }
  if (sandboxConfig) {
    const protectedPatterns = compileSandbox(sandboxConfig).protected;
    const matchedPattern = protectedPatterns.find((pattern) =>
      matchesProtectedPathPattern(pattern, realCwd, filePath, realTargetPath, pathApi),
    );
    if (matchedPattern) {
      return {
        targetPath: null,
        error: `Write path matches protected file pattern: ${matchedPattern.src}`,
      };
    }
  }
  return { targetPath };
}

function normalizePathToken(token: string): string {
  return token.trim().replace(/^[("'`]+/, "").replace(/[)"'`,;]+$/, "");
}

function tokenizeCommand(command: string, windowsMode = process.platform === "win32"): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | "`" | null = null;
  let escaped = false;

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (!windowsMode && ch === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "&" || ch === "|" || (!windowsMode && ch === ";")) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      const next = command[i + 1];
      if ((ch === "&" || ch === "|") && next === ch) {
        tokens.push(`${ch}${ch}`);
        i += 1;
        continue;
      }
      tokens.push(ch);
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }

  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

function looksLikePathToken(value: string, windowsMode = process.platform === "win32"): boolean {
  return (
    value.startsWith(".") ||
    value.startsWith("~") ||
    value.includes("/") ||
    (windowsMode && (
      /^[a-zA-Z]:(?:[\\/]|$)/.test(value) ||
      value.startsWith("\\\\") ||
      value.startsWith(".\\") ||
      value.startsWith("..\\") ||
      value.includes("\\")
    ))
  );
}

const COMMAND_SEPARATORS = new Set(["|", "||", "&&", ";", "&"]);

function splitCommandSegments(tokens: string[]): string[][] {
  const segments: string[][] = [];
  let current: string[] = [];
  for (const token of tokens) {
    const normalizedToken = normalizePathToken(token);
    if (COMMAND_SEPARATORS.has(token) || COMMAND_SEPARATORS.has(normalizedToken)) {
      if (current.length > 0) segments.push(current);
      current = [];
      continue;
    }
    current.push(token);
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

function collectPathReferences(
  command: string,
  cwd: string,
  pathApi: SandboxPathApi = getSandboxPathApi(cwd, command),
  powerShellInspection?: PowerShellInspection,
): PathReference[] {
  const refs = new Map<string, PathReference>();
  const windowsMode = pathApi === path.win32;
  const accessPriority: Record<PathAccessMode, number> = {
    unknown: 0,
    read: 1,
    write: 2,
  };
  const addPath = (rawValue: string, access: PathAccessMode = "unknown") => {
    const normalizedRaw = normalizePathToken(rawValue);
    if (!normalizedRaw.length) return;
    if (normalizedRaw === "/dev/null") return;
    if (normalizedRaw.includes("://")) return;

    const expandedPath =
      normalizedRaw === "~"
        ? os.homedir()
        : normalizedRaw.startsWith("~/")
          ? pathApi.join(os.homedir(), normalizedRaw.slice(2))
        : windowsMode && normalizedRaw.startsWith("~\\")
          ? pathApi.join(os.homedir(), normalizedRaw.slice(2))
          : normalizedRaw;
    const resolved = pathApi.resolve(cwd, expandedPath);
    const key = `${normalizedRaw}::${resolved}`;
    const existing = refs.get(key);
    if (!existing || accessPriority[access] > accessPriority[existing.access]) {
      refs.set(key, { raw: normalizedRaw, resolved, access });
    }
  };

  for (const token of tokenizeCommand(command, windowsMode)) {
    const value = normalizePathToken(token);
    if (!value.length) continue;
    if (value.startsWith("-")) continue;
    if (value === "|" || value === "||" || value === "&&" || value === ";" || value === "&") continue;
    if (
      value.includes("=")
      && !value.startsWith("./")
      && !value.startsWith("../")
      && !value.startsWith("/")
      && !value.startsWith(".")
      && !(windowsMode && (value.startsWith(".\\") || value.startsWith("..\\")))
    ) {
      continue;
    }
    if (looksLikePathToken(value, windowsMode)) {
      addPath(value, "unknown");
    }
  }

  for (const match of command.matchAll(/(?:^|[\s;|&])(?:\d?>|>>)([^\s'";|&<>]+)/g)) {
    if (match[1]) addPath(match[1], "write");
  }

  const markOperands = (commandName: string, args: string[]) => {
    const normalizedCommand = pathApi.basename(commandName).toLowerCase().replace(/\.(?:exe|cmd|bat)$/i, "");
    const normalizedArgs = args
      .map((value) => normalizePathToken(value))
      .filter((value) => value.length > 0 && !value.startsWith("-") && !(windowsMode && /^\/[a-z?]/i.test(value)));
    const pathOperands = normalizedArgs.filter((value) => looksLikePathToken(value, windowsMode));
    if (!pathOperands.length) return;

    switch (normalizedCommand) {
      case "cp":
      case "copy":
      case "xcopy":
      case "robocopy":
      case "install":
      case "ln": {
        const destination = [...normalizedArgs].reverse().find((value) => looksLikePathToken(value, windowsMode));
        if (destination) {
          pathOperands.slice(0, -1).forEach((value) => addPath(value, "read"));
          addPath(destination, "write");
        }
        return;
      }
      case "mv":
      case "move":
      case "ren":
      case "rename":
      case "rm":
      case "del":
      case "erase":
      case "mkdir":
      case "md":
      case "rmdir":
      case "rd":
      case "touch":
      case "chmod":
      case "chown":
      case "patch":
      case "truncate":
      case "tee":
        pathOperands.forEach((value) => addPath(value, "write"));
        return;
      case "sed":
        if (args.some((value) => value === "-i" || value.startsWith("-i"))) {
          pathOperands.forEach((value) => addPath(value, "write"));
        }
        return;
      case "perl":
        if (args.some((value) => value.startsWith("-i"))) {
          pathOperands.forEach((value) => addPath(value, "write"));
        }
        return;
      default:
        return;
    }
  };

  for (const segment of splitCommandSegments(tokenizeCommand(command, windowsMode))) {
    let commandIndex = 0;
    while (
      commandIndex < segment.length
      && normalizePathToken(segment[commandIndex] ?? "").includes("=")
      && !looksLikePathToken(normalizePathToken(segment[commandIndex] ?? ""), windowsMode)
    ) {
      commandIndex += 1;
    }
    if (commandIndex >= segment.length) continue;
    const commandName = normalizePathToken(segment[commandIndex] ?? "");
    const args = segment.slice(commandIndex + 1);
    if (!commandName.length) continue;
    markOperands(commandName, args);
  }

  const nestedPowerShellRefs = (powerShellInspection ?? inspectPowerShellInvocations(command, cwd, pathApi)).pathRefs;
  for (const entry of nestedPowerShellRefs) {
    const key = `${entry.raw}::${entry.resolved}`;
    const existing = refs.get(key);
    if (!existing || accessPriority[entry.access] > accessPriority[existing.access]) {
      refs.set(key, entry);
    }
  }

  return [...refs.values()];
}

function isNullDevicePath(resolved: string): boolean {
  if (resolved === "/dev/null") return true;
  if (process.platform === "win32") {
    const norm = resolved.replace(/\\/g, "/").toLowerCase();
    return norm === "nul" || norm.endsWith("/nul");
  }
  return false;
}

function isSystemExecutableSandboxPath(resolved: string): boolean {
  const norm = resolved.replace(/\\/g, "/");
  if (process.platform !== "win32") {
    return norm.startsWith("/usr/bin/") || norm.startsWith("/usr/local/bin/");
  }
  const lower = norm.toLowerCase();
  const systemRoot = (process.env.SystemRoot || process.env.windir || "C:\\Windows").replace(/\\/g, "/");
  const sr = systemRoot.toLowerCase();
  return lower.startsWith(`${sr}/system32/`) || lower.startsWith(`${sr}/syswow64/`);
}

/**
 * Check a bash command against the worker sandbox config.
 * Returns { allowed: true } or { allowed: false, reason: string }.
 */
export function checkWorkerSandbox(
  command: string,
  config: WorkerSandboxConfig,
  projectRoot: string,
): { allowed: boolean; reason?: string } {
  const compiled = compileSandbox(config);
  const pathApi = getSandboxPathApi(projectRoot, command);
  const powerShellInspection = inspectPowerShellInvocations(command, projectRoot, pathApi);

  // 1. Check blocked patterns first (always reject)
  for (const { re, src } of compiled.blocked) {
    if (re.test(command)) {
      return { allowed: false, reason: `Blocked command pattern: ${src}` };
    }
  }

  if (powerShellInspection.blockedReason) {
    return { allowed: false, reason: powerShellInspection.blockedReason };
  }

  const safeMatch = compiled.safe.some((re) => re.test(command));
  const commandMutates = bashCommandLikelyMutates(command, projectRoot, powerShellInspection);

  // 2. Validate file paths against allowedPaths (absolute + relative)
  const rootResolved = canonicalizePathForContainment(projectRoot, pathApi);
  const pathRefs = collectPathReferences(command, projectRoot, pathApi, powerShellInspection);
  for (const entry of pathRefs) {
    const p = entry.raw;
    const resolved = canonicalizePathForContainment(entry.resolved, pathApi);
    const isSystemExecutablePath = isSystemExecutableSandboxPath(resolved);
    if (isNullDevicePath(resolved)) continue;
    if (isSystemExecutablePath && (entry.access === "read" || (!commandMutates && entry.access !== "write"))) continue;

    const withinAllowed = config.allowedPaths.some((allowed) => {
      const allowedAbs = canonicalizePathForContainment(pathApi.resolve(projectRoot, allowed), pathApi);
      return isWithinDirForPathApi(pathApi, allowedAbs, resolved);
    });
    if (!withinAllowed && !isWithinDirForPathApi(pathApi, rootResolved, resolved)) {
      return { allowed: false, reason: `Path outside sandbox: ${p}` };
    }
  }

  // 3. Check protected files for write-like commands (safe commands do not bypass this)
  if (commandMutates) {
    const protectedRefs = pathRefs.filter((entry) => entry.access !== "read");
    for (const { re, src } of compiled.protected) {
      if (re.test(command)) {
        return { allowed: false, reason: `Command targets protected file pattern: ${src}` };
      }
      const targetsProtectedPath = protectedRefs.some((entry) => matchesProtectedPathPattern({ re, src }, projectRoot, entry.raw, entry.resolved, pathApi));
      if (targetsProtectedPath) {
        return { allowed: false, reason: `Command targets protected file pattern: ${src}` };
      }
    }
  }

  // 4. Safe patterns allow the remaining command.
  if (safeMatch) {
    return { allowed: true };
  }

  // 5. If blockByDefault, block commands that didn't match safe list
  if (config.blockByDefault) {
    return { allowed: false, reason: "Command not in safe list and blockByDefault is enabled" };
  }

  return { allowed: true };
}

// ── New tool implementations ────────────────────────────────────────

/** Spawn argv for worker shell execution (bash on Unix, cmd via ComSpec on Windows). */
export function resolveWorkerShellInvocation(command: string): { file: string; args: string[] } {
  if (process.platform === "win32") {
    const comSpec = process.env.ComSpec?.trim() || "cmd.exe";
    return { file: comSpec, args: ["/d", "/s", "/c", command] };
  }
  return { file: "bash", args: ["-c", command] };
}

function createBashTool(
  cwd: string,
  mode: PermissionMode,
  sandboxConfig?: WorkerSandboxConfig,
  onApprovalRequest?: (request: ToolApprovalRequest) => Promise<ToolApprovalResult>,
  turnMemoryPolicyState?: TurnMemoryPolicyState,
) {
  return tool({
    description:
      "Execute a shell command and return stdout/stderr. " +
      (process.platform === "win32"
        ? "On Windows, commands run via cmd.exe (ComSpec) with a 120-second timeout; on macOS/Linux they run in bash. "
        : "Commands run in a non-interactive bash shell with a 120-second timeout. "),
    inputSchema: z.object({
      command: z.string().describe("The shell command to execute"),
      timeout: z
        .number()
        .optional()
        .default(120_000)
        .describe("Timeout in milliseconds (max 600000)"),
    }),
    ...approvalProp(mode, "bash", Boolean(onApprovalRequest)),
    execute: async ({ command, timeout }) => {
      if (requiresTurnMemoryGuard(turnMemoryPolicyState) && bashCommandLikelyMutates(command)) {
        return {
          stdout: "",
          stderr: `EXECUTION DENIED: ${MEMORY_GUARD_REASON}`,
          exitCode: 126,
        };
      }

      const approval = await maybeRequestApproval({
        mode,
        category: "bash",
        onApprovalRequest,
        description: `Run command: ${command}`,
        detail: { command, cwd, timeout },
      });
      if (!approval.approved) {
        return {
          stdout: "",
          stderr: `EXECUTION DENIED: ${approval.reason ?? "Command was not approved."}`,
          exitCode: 126,
        };
      }

      // Enforce sandbox for API-model workers
      if (sandboxConfig) {
        const check = checkWorkerSandbox(command, sandboxConfig, cwd);
        if (!check.allowed) {
          return {
            stdout: "",
            stderr: `SANDBOX BLOCKED: ${check.reason}`,
            exitCode: 2,
          };
        }
      }
      const clampedTimeout = Math.min(timeout, 600_000);
      const killProc = (proc: ReturnType<typeof spawn>): void => {
        terminateProcessTree(proc, "SIGTERM");
      };
      try {
        const result = await new Promise<{ stdout: string; stderr: string; exitCode: number }>(
          (resolve, reject) => {
            const { file, args } = resolveWorkerShellInvocation(command);
            const proc = spawn(file, args, {
              cwd,
              stdio: ["ignore", "pipe", "pipe"],
              windowsVerbatimArguments: process.platform === "win32",
              env:
                process.platform === "win32"
                  ? { ...process.env }
                  : { ...process.env, TERM: "dumb" },
            });
            const timeoutId = setTimeout(() => {
              killProc(proc);
            }, clampedTimeout);

            let stdout = "";
            let stderr = "";

            proc.stdout.on("data", (d: Buffer) => {
              stdout += d.toString();
              // Cap output at 1MB
              if (stdout.length > 1_000_000) {
                killProc(proc);
              }
            });
            proc.stderr.on("data", (d: Buffer) => {
              stderr += d.toString();
              if (stderr.length > 1_000_000) {
                killProc(proc);
              }
            });

            proc.on("close", (code) => {
              clearTimeout(timeoutId);
              resolve({
                stdout: stdout.slice(0, 200_000),
                stderr: stderr.slice(0, 50_000),
                exitCode: code ?? 1,
              });
            });
            proc.on("error", (error) => {
              clearTimeout(timeoutId);
              reject(error);
            });
          }
        );
        return result;
      } catch (err) {
        return {
          stdout: "",
          stderr: `Command failed: ${getErrorMessage(err)}`,
          exitCode: 1,
        };
      }
    },
  });
}

function createWriteFileTool(
  cwd: string,
  mode: PermissionMode,
  sandboxConfig?: WorkerSandboxConfig,
  onApprovalRequest?: (request: ToolApprovalRequest) => Promise<ToolApprovalResult>,
  turnMemoryPolicyState?: TurnMemoryPolicyState,
) {
  return tool({
    description:
      "Create or overwrite a file with the given content. " +
      "Parent directories are created automatically.",
    inputSchema: z.object({
      file_path: z.string().describe("Path to the file (absolute or relative to project root)"),
      content: z.string().describe("The full content to write"),
    }),
    ...approvalProp(mode, "write", Boolean(onApprovalRequest)),
    execute: async ({ file_path, content }) => {
      if (requiresTurnMemoryGuard(turnMemoryPolicyState)) {
        return {
          success: false,
          message: `Execution denied: ${MEMORY_GUARD_REASON}`,
        };
      }

      const approval = await maybeRequestApproval({
        mode,
        category: "write",
        onApprovalRequest,
        description: `Write file: ${file_path}`,
        detail: {
          file_path,
          contentPreview: content.length > 400 ? `${content.slice(0, 400)}...` : content,
        },
      });
      if (!approval.approved) {
        return {
          success: false,
          message: `Execution denied: ${approval.reason ?? "Write was not approved."}`,
        };
      }

      try {
        const { targetPath, error } = resolveWritableTargetPath(cwd, file_path, sandboxConfig);
        if (!targetPath) {
          return {
            success: false,
            message: error ?? `Write path is outside allowed roots: ${file_path}`,
          };
        }
        await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.promises.writeFile(targetPath, content, "utf-8");
        return { success: true, message: `Wrote ${content.length} characters to ${targetPath}` };
      } catch (err) {
        return {
          success: false,
          message: `Error writing file: ${getErrorMessage(err)}`,
        };
      }
    },
  });
}

function createEditFileTool(
  cwd: string,
  mode: PermissionMode,
  sandboxConfig?: WorkerSandboxConfig,
  onApprovalRequest?: (request: ToolApprovalRequest) => Promise<ToolApprovalResult>,
  turnMemoryPolicyState?: TurnMemoryPolicyState,
) {
  return tool({
    description:
      "Make a targeted edit to a file by replacing an exact string match with new content. " +
      "The old_string must appear exactly once in the file unless replace_all is true.",
    inputSchema: z.object({
      file_path: z.string().describe("Path to the file (absolute or relative to project root)"),
      old_string: z.string().describe("The exact string to find and replace"),
      new_string: z.string().describe("The replacement string"),
      replace_all: z
        .boolean()
        .optional()
        .default(false)
        .describe("Replace all occurrences instead of requiring a unique match"),
    }),
    ...approvalProp(mode, "write", Boolean(onApprovalRequest)),
    execute: async ({ file_path, old_string, new_string, replace_all }) => {
      if (requiresTurnMemoryGuard(turnMemoryPolicyState)) {
        return {
          success: false,
          message: `Execution denied: ${MEMORY_GUARD_REASON}`,
        };
      }

      const approval = await maybeRequestApproval({
        mode,
        category: "write",
        onApprovalRequest,
        description: `Edit file: ${file_path}`,
        detail: {
          file_path,
          old_string_preview: old_string.length > 220 ? `${old_string.slice(0, 220)}...` : old_string,
          new_string_preview: new_string.length > 220 ? `${new_string.slice(0, 220)}...` : new_string,
          replace_all,
        },
      });
      if (!approval.approved) {
        return {
          success: false,
          message: `Execution denied: ${approval.reason ?? "Edit was not approved."}`,
        };
      }

      try {
        const { targetPath, error } = resolveWritableTargetPath(cwd, file_path, sandboxConfig);
        if (!targetPath) {
          return {
            success: false,
            message: error ?? `Write path is outside allowed roots: ${file_path}`,
          };
        }

        let content: string;
        try {
          content = await fs.promises.readFile(targetPath, "utf-8");
        } catch {
          return { success: false, message: `File not found: ${targetPath}` };
        }

        if (!content.includes(old_string)) {
          return {
            success: false,
            message: `The old_string was not found in ${targetPath}`,
          };
        }

        if (!replace_all) {
          const firstIdx = content.indexOf(old_string);
          const secondIdx = content.indexOf(old_string, firstIdx + 1);
          if (secondIdx !== -1) {
            return {
              success: false,
              message:
                `old_string appears multiple times in ${targetPath}. ` +
                "Provide more context to make the match unique, or set replace_all to true.",
            };
          }
        }

        const updated = replace_all
          ? content.split(old_string).join(new_string)
          : content.replace(old_string, new_string);

        await fs.promises.writeFile(targetPath, updated, "utf-8");
        return { success: true, message: `Successfully edited ${targetPath}` };
      } catch (err) {
        return {
          success: false,
          message: `Error editing file: ${getErrorMessage(err)}`,
        };
      }
    },
  });
}

function createListDirTool(cwd: string) {
  return tool({
    description:
      "List directory contents with file types and sizes. " +
      "Returns entries sorted alphabetically, directories first.",
    inputSchema: z.object({
      path: z.string().optional().default(".").describe("Repo-relative or absolute path to the directory"),
      recursive: z
        .boolean()
        .optional()
        .default(false)
        .describe("List recursively (max 1000 entries)"),
    }),
    execute: async ({ path: dirPath, recursive }) => {
      try {
        const repoRoot = fs.realpathSync(cwd);
        const targetDir = resolvePathWithinRoot(repoRoot, dirPath ?? ".", { allowMissing: false });
        const stat = fs.statSync(targetDir);
        if (!stat.isDirectory()) {
          return { entries: [], error: `Not a directory: ${targetDir}` };
        }

        const entries: Array<{
          name: string;
          type: "file" | "directory";
          size?: number;
          path: string;
          displayPath: string;
        }> = [];
        const maxEntries = 1000;

        function walk(dir: string, prefix: string) {
          if (entries.length >= maxEntries) return;
          let items: fs.Dirent[];
          try {
            items = fs.readdirSync(dir, { withFileTypes: true });
          } catch {
            return;
          }
          // Sort: directories first, then alphabetically
          items.sort((a, b) => {
            if (a.isDirectory() && !b.isDirectory()) return -1;
            if (!a.isDirectory() && b.isDirectory()) return 1;
            return a.name.localeCompare(b.name);
          });
          for (const item of items) {
            if (entries.length >= maxEntries) return;
            const relName = prefix ? `${prefix}/${item.name}` : item.name;
            const entryPath = path.join(dir, item.name);
            const displayPath = toPortablePath(path.relative(repoRoot, entryPath));
            if (item.isDirectory()) {
              entries.push({ name: relName, type: "directory", path: entryPath, displayPath });
              if (recursive && !item.name.startsWith(".") && item.name !== "node_modules") {
                walk(entryPath, relName);
              }
            } else {
              let size: number | undefined;
              try {
                size = fs.statSync(entryPath).size;
              } catch {
                // skip
              }
              entries.push({ name: relName, type: "file", size, path: entryPath, displayPath });
            }
          }
        }

        walk(targetDir, "");
        return {
          root: targetDir,
          displayRoot: toPortablePath(path.relative(repoRoot, targetDir)) || ".",
          entries,
          count: entries.length,
          truncated: entries.length >= maxEntries,
        };
      } catch (err) {
        return {
          entries: [],
          error: `Error listing directory: ${getErrorMessage(err)}`,
        };
      }
    },
  });
}

const FRONTEND_SCAN_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mts",
  ".cts",
  ".mjs",
  ".cjs",
  ".vue",
  ".svelte",
  ".astro",
  ".html",
]);

const FRONTEND_COMPONENT_EXTENSIONS = new Set([
  ".tsx",
  ".jsx",
  ".vue",
  ".svelte",
  ".astro",
]);

const FRONTEND_IGNORED_DIRECTORIES = new Set([
  ".ade",
  ".cache",
  ".git",
  ".hg",
  ".next",
  ".nuxt",
  ".parcel-cache",
  ".svelte-kit",
  ".svn",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "tmp",
  "vendor",
]);

const FRONTEND_SOURCE_ROOT_SEGMENTS = new Set([
  "src",
  "app",
  "pages",
  "client",
  "frontend",
  "web",
  "routes",
  "screens",
  "views",
]);

const MAX_FRONTEND_SCAN_FILES = 4_000;
const FRONTEND_TEXT_SNIPPET_BYTES = 12_000;

type FrontendRepoFile = {
  absolutePath: string;
  relativePath: string;
  extension: string;
  stem: string;
  snippet: string;
};

type FrontendRepoMatch = {
  path: string;
  displayPath: string;
  kind: string;
  score: number;
  evidence: string[];
  frameworkHints: string[];
};

type FrontendRepoAnalysis = {
  root: string;
  scannedFiles: number;
  truncated: boolean;
  topLevelDirectories: string[];
  topLevelFiles: string[];
  likelySourceRoots: string[];
  frameworkSignals: string[];
  routingFiles: FrontendRepoMatch[];
  pageComponents: FrontendRepoMatch[];
  appEntryPoints: FrontendRepoMatch[];
};

function clampPositiveInt(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value as number), 1), max);
}

function shouldSkipFrontendDir(name: string): boolean {
  return name.startsWith(".") || FRONTEND_IGNORED_DIRECTORIES.has(name);
}

function isRelevantFrontendFile(name: string): boolean {
  return FRONTEND_SCAN_EXTENSIONS.has(path.extname(name).toLowerCase());
}

function readTextSnippet(filePath: string): string {
  let fd: number | undefined;
  try {
    const stat = fs.statSync(filePath);
    if (stat.size <= 0) return "";
    const bytesToRead = Math.min(stat.size, FRONTEND_TEXT_SNIPPET_BYTES);
    const buffer = Buffer.alloc(bytesToRead);
    fd = fs.openSync(filePath, "r");
    const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, 0);
    return buffer.toString("utf-8", 0, bytesRead);
  } catch {
    return "";
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore close errors for best-effort snippets
      }
    }
  }
}

function resolveRepoAwareRoot(
  cwd: string,
  inputPath?: string,
): { root: string | null; error?: string } {
  try {
    const projectRoot = fs.realpathSync(cwd);
    const candidate = path.resolve(projectRoot, inputPath ?? ".");
    if (!fs.existsSync(candidate)) {
      return { root: null, error: `Directory not found: ${candidate}` };
    }
    const realCandidate = fs.realpathSync(candidate);
    if (realCandidate !== projectRoot && !isWithinDir(projectRoot, realCandidate)) {
      return { root: null, error: `Search path must stay within the repo root: ${candidate}` };
    }
    const stat = fs.statSync(realCandidate);
    if (!stat.isDirectory()) {
      return { root: null, error: `Not a directory: ${realCandidate}` };
    }
    return { root: realCandidate };
  } catch (err) {
    return {
      root: null,
      error: `Unable to resolve search root: ${getErrorMessage(err)}`,
    };
  }
}

function scanFrontendFiles(root: string): {
  files: FrontendRepoFile[];
  truncated: boolean;
  topLevelDirectories: string[];
  topLevelFiles: string[];
} {
  const files: FrontendRepoFile[] = [];
  const topLevelDirectories: string[] = [];
  const topLevelFiles: string[] = [];
  const stack = [root];
  let truncated = false;

  while (stack.length > 0 && !truncated) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));
    const isTopLevel = dir === root;

    for (const entry of entries) {
      const absolutePath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (isTopLevel && !shouldSkipFrontendDir(entry.name)) {
          topLevelDirectories.push(entry.name);
        }
        if (shouldSkipFrontendDir(entry.name)) {
          continue;
        }
        stack.push(absolutePath);
        continue;
      }

      if (entry.isSymbolicLink()) {
        continue;
      }

      if (isTopLevel) {
        topLevelFiles.push(entry.name);
      }

      if (!entry.isFile() || !isRelevantFrontendFile(entry.name)) {
        continue;
      }

      const relativePath = toPortablePath(path.relative(root, absolutePath));
      const extension = path.extname(entry.name).toLowerCase();
      files.push({
        absolutePath,
        relativePath,
        extension,
        stem: path.basename(entry.name, extension),
        snippet: readTextSnippet(absolutePath),
      });

      if (files.length >= MAX_FRONTEND_SCAN_FILES) {
        truncated = true;
        break;
      }
    }
  }

  return {
    files,
    truncated,
    topLevelDirectories: topLevelDirectories.slice(0, 20),
    topLevelFiles: topLevelFiles.slice(0, 20),
  };
}

function isIgnoredSourceVariant(relativePath: string): boolean {
  return /\.(?:d\.ts|test|spec|stories|story)\.[^.]+$/i.test(relativePath);
}

function detectFrameworkHints(file: FrontendRepoFile): string[] {
  const hints = new Set<string>();
  const normalizedPath = file.relativePath.toLowerCase();
  const snippet = file.snippet;

  if (file.extension === ".tsx" || file.extension === ".jsx") {
    hints.add("React");
  }
  if (file.extension === ".vue" || /\bcreateApp\s*\(|\bdefineComponent\s*\(/.test(snippet)) {
    hints.add("Vue");
  }
  if (file.extension === ".svelte") {
    hints.add("Svelte");
  }
  if (file.extension === ".astro") {
    hints.add("Astro");
  }
  if (
    normalizedPath.startsWith("app/") ||
    normalizedPath.includes("/app/") ||
    normalizedPath.startsWith("pages/") ||
    normalizedPath.includes("/pages/")
  ) {
    if (
      /(^|\/)app\/.+\/(page|layout|route|loading|error|not-found)\.[^.]+$/i.test(file.relativePath) ||
      /(^|\/)app\/(page|layout|route|loading|error|not-found)\.[^.]+$/i.test(file.relativePath) ||
      /(^|\/)pages\/(_app|_document|_error)\.[^.]+$/i.test(file.relativePath)
    ) {
      hints.add("Next.js");
    }
  }
  if (/\+(page|layout)\.[^.]+$/i.test(file.relativePath)) {
    hints.add("SvelteKit");
  }
  if (/\bcreateBrowserRouter\b|\bcreateHashRouter\b|\bRouterProvider\b|<Routes\b|\buseRoutes\s*\(/.test(snippet)) {
    hints.add("React Router");
  }
  if (/\bcreateFileRoute\b|\bcreateRootRoute\b|\brouteTree\b/.test(snippet)) {
    hints.add("TanStack Router");
  }
  if (/\bcreateRouter\s*\(|\bcreateWebHistory\s*\(|\bcreateWebHashHistory\s*\(/.test(snippet)) {
    hints.add("Vue Router");
  }

  return [...hints].sort();
}

function createFrontendMatch(
  file: FrontendRepoFile,
  kind: string,
  score: number,
  evidence: string[],
  frameworkHints: string[],
): FrontendRepoMatch {
  return {
    path: file.absolutePath,
    displayPath: file.relativePath,
    kind,
    score,
    evidence: [...new Set(evidence)],
    frameworkHints: [...new Set(frameworkHints)].sort(),
  };
}

function classifyRoutingFile(file: FrontendRepoFile): FrontendRepoMatch | null {
  const stem = file.stem.toLowerCase();
  const normalizedPath = file.relativePath;
  const evidence: string[] = [];
  const frameworkHints = detectFrameworkHints(file);
  let score = 0;

  if (
    /(^|\/)app\/.+\/(page|layout|route|loading|error|not-found)\.[^.]+$/i.test(normalizedPath) ||
    /(^|\/)app\/(page|layout|route|loading|error|not-found)\.[^.]+$/i.test(normalizedPath)
  ) {
    score += 6;
    evidence.push("Next app-router convention");
  }
  if (/(^|\/)pages\/(_app|_document|_error)\.[^.]+$/i.test(normalizedPath)) {
    score += 6;
    evidence.push("Next pages-router root");
  }
  if (/\+(page|layout)\.[^.]+$/i.test(normalizedPath)) {
    score += 6;
    evidence.push("SvelteKit route convention");
  }
  if (/(^|\/)(router|routes|routeTree|routing)\.[^.]+$/i.test(normalizedPath)) {
    score += 6;
    evidence.push("Router-style filename");
  }
  if (/(^|\/)routes\//i.test(normalizedPath)) {
    score += 3;
    evidence.push("routes directory");
    if (FRONTEND_COMPONENT_EXTENSIONS.has(file.extension)) {
      score += 2;
      evidence.push("Component file inside routes");
    }
  }
  if (/\bcreateBrowserRouter\b|\bcreateHashRouter\b|\bRouterProvider\b|<Routes\b|\buseRoutes\s*\(/.test(file.snippet)) {
    score += 5;
    evidence.push("React Router API");
  }
  if (/\bcreateFileRoute\b|\bcreateRootRoute\b|\brouteTree\b/.test(file.snippet)) {
    score += 5;
    evidence.push("TanStack Router API");
  }
  if (/\bcreateRouter\s*\(|\bcreateWebHistory\s*\(|\bcreateWebHashHistory\s*\(/.test(file.snippet)) {
    score += 5;
    evidence.push("Vue Router API");
  }
  if (/\bfrom\s+['"]@remix-run\/react['"]|\bloader\b|\baction\b/.test(file.snippet) && /(^|\/)routes?\//i.test(normalizedPath)) {
    score += 4;
    evidence.push("Route-module exports");
  }

  if (score < 5) {
    return null;
  }

  let kind = "routing-file";
  if (/(^|\/)(app\/layout|pages\/_app|pages\/_document)\.[^.]+$/i.test(normalizedPath)) {
    kind = "framework-routing-root";
  } else if (
    /(^|\/)app\/.+\/(page|layout|route)\.[^.]+$/i.test(normalizedPath) ||
    /\+(page|layout)\.[^.]+$/i.test(normalizedPath)
  ) {
    kind = "filesystem-route";
  } else if (
    stem === "router" ||
    stem === "routes" ||
    stem === "routetree" ||
    evidence.some((value) => value.includes("Router"))
  ) {
    kind = "router-config";
  } else if (/(^|\/)routes\//i.test(normalizedPath)) {
    kind = "route-module";
  }

  return createFrontendMatch(file, kind, score, evidence, frameworkHints);
}

function classifyPageComponent(file: FrontendRepoFile): FrontendRepoMatch | null {
  if (!FRONTEND_COMPONENT_EXTENSIONS.has(file.extension) || isIgnoredSourceVariant(file.relativePath)) {
    return null;
  }

  const stem = file.stem.toLowerCase();
  if (["layout", "_app", "_document", "_error", "router", "routes", "routing", "loading", "error", "not-found"].includes(stem)) {
    return null;
  }

  const normalizedPath = file.relativePath;
  const evidence: string[] = [];
  const frameworkHints = detectFrameworkHints(file);
  let score = 0;

  if (/(^|\/)pages\//i.test(normalizedPath)) {
    score += 4;
    evidence.push("pages directory");
  }
  if (/(^|\/)screens\//i.test(normalizedPath)) {
    score += 4;
    evidence.push("screens directory");
  }
  if (/(^|\/)views\//i.test(normalizedPath)) {
    score += 4;
    evidence.push("views directory");
  }
  if (/(^|\/)routes\//i.test(normalizedPath)) {
    score += 2;
    evidence.push("routes directory");
  }
  if (/(^|\/)app\/.+\/page\.[^.]+$/i.test(normalizedPath) || /(^|\/)app\/page\.[^.]+$/i.test(normalizedPath)) {
    score += 5;
    evidence.push("App-router page file");
  }
  if (/\+page\.[^.]+$/i.test(normalizedPath)) {
    score += 5;
    evidence.push("SvelteKit page file");
  }
  if (stem === "page" || stem.endsWith("page")) {
    score += 5;
    evidence.push("Page-style filename");
  }
  if (stem.endsWith("screen")) {
    score += 5;
    evidence.push("Screen-style filename");
  }
  if (stem.endsWith("view")) {
    score += 4;
    evidence.push("View-style filename");
  }
  if (stem === "index" && /(pages|routes|screens|views)\//i.test(normalizedPath)) {
    score += 3;
    evidence.push("Index file under route-like directory");
  }
  if (/<[A-Za-z][^>]*>|<template\b|<script\b/.test(file.snippet)) {
    score += 1;
    evidence.push("Component markup");
  }
  if (/\bexport\s+default\b|\bexport\s+function\b|\bconst\s+[A-Z][A-Za-z0-9_]*\s*=/.test(file.snippet)) {
    score += 1;
    evidence.push("Component export");
  }

  if (score < 5) {
    return null;
  }

  let kind = "page-component";
  if (stem.endsWith("screen")) {
    kind = "screen-component";
  } else if (stem.endsWith("view")) {
    kind = "view-component";
  } else if (/(^|\/)routes\//i.test(normalizedPath)) {
    kind = "route-component";
  }

  return createFrontendMatch(file, kind, score, evidence, frameworkHints);
}

function classifyAppEntryPoint(file: FrontendRepoFile): FrontendRepoMatch | null {
  if (isIgnoredSourceVariant(file.relativePath)) {
    return null;
  }

  const stem = file.stem.toLowerCase();
  const normalizedPath = file.relativePath;
  const evidence: string[] = [];
  const frameworkHints = detectFrameworkHints(file);
  let score = 0;

  if (["main", "index", "entry-client", "entry-server", "client", "server", "browser"].includes(stem)) {
    score += 5;
    evidence.push("Entry-style filename");
  }
  if (stem === "app") {
    score += 3;
    evidence.push("App-shell filename");
  }
  if (/^index\.html$/i.test(normalizedPath) || /(^|\/)index\.html$/i.test(normalizedPath)) {
    score += 4;
    evidence.push("HTML entry document");
  }
  if (/(^|\/)app\/layout\.[^.]+$/i.test(normalizedPath) || /(^|\/)pages\/_app\.[^.]+$/i.test(normalizedPath)) {
    score += 6;
    evidence.push("Framework root file");
  }
  if (/\bcreateRoot\s*\(|\bhydrateRoot\s*\(|\bReactDOM\.render\s*\(|\bcreateApp\s*\(|\bnew\s+Vue\s*\(|\.mount\s*\(|\bbootstrapApplication\s*\(/.test(file.snippet)) {
    score += 5;
    evidence.push("Client bootstrap code");
  }
  if (/\brenderToPipeableStream\b|\brenderToReadableStream\b|\brenderToString\b|\bcreateServer\b/.test(file.snippet)) {
    score += 4;
    evidence.push("Server render/bootstrap code");
  }

  if (score < 5) {
    return null;
  }

  let kind = "entry-point";
  if (/\brenderToPipeableStream\b|\brenderToReadableStream\b|\brenderToString\b|\bcreateServer\b/.test(file.snippet) || stem.includes("server")) {
    kind = "server-entry";
  } else if (/\bcreateRoot\s*\(|\bhydrateRoot\s*\(|\bReactDOM\.render\s*\(|\bcreateApp\s*\(|\bnew\s+Vue\s*\(|\.mount\s*\(|\bbootstrapApplication\s*\(/.test(file.snippet)) {
    kind = "bootstrap-entry";
  } else if (stem === "app" || /(^|\/)app\/layout\.[^.]+$/i.test(normalizedPath) || /(^|\/)pages\/_app\.[^.]+$/i.test(normalizedPath)) {
    kind = "app-shell";
  }

  return createFrontendMatch(file, kind, score, evidence, frameworkHints);
}

function dedupeAndSortMatches(matches: FrontendRepoMatch[]): FrontendRepoMatch[] {
  const deduped = new Map<string, FrontendRepoMatch>();
  for (const match of matches) {
    const existing = deduped.get(match.path);
    if (!existing || match.score > existing.score) {
      deduped.set(match.path, match);
    }
  }
  return [...deduped.values()].sort((a, b) => b.score - a.score || a.displayPath.localeCompare(b.displayPath));
}

function detectLikelySourceRoot(relativePath: string): string | null {
  const segments = toPortablePath(relativePath).split("/").filter(Boolean);
  for (let index = 0; index < segments.length - 1; index += 1) {
    if (FRONTEND_SOURCE_ROOT_SEGMENTS.has(segments[index])) {
      return segments.slice(0, index + 1).join("/");
    }
  }
  return null;
}

function analyzeFrontendRepo(root: string): FrontendRepoAnalysis {
  const { files, truncated, topLevelDirectories, topLevelFiles } = scanFrontendFiles(root);
  const frameworkSignals = new Set<string>();
  const sourceRootCounts = new Map<string, number>();
  const routingFiles: FrontendRepoMatch[] = [];
  const pageComponents: FrontendRepoMatch[] = [];
  const appEntryPoints: FrontendRepoMatch[] = [];

  for (const file of files) {
    const sourceRoot = detectLikelySourceRoot(file.relativePath);
    if (sourceRoot) {
      sourceRootCounts.set(sourceRoot, (sourceRootCounts.get(sourceRoot) ?? 0) + 1);
    }

    for (const hint of detectFrameworkHints(file)) {
      frameworkSignals.add(hint);
    }

    const routingFile = classifyRoutingFile(file);
    if (routingFile) {
      routingFiles.push(routingFile);
    }

    const pageComponent = classifyPageComponent(file);
    if (pageComponent) {
      pageComponents.push(pageComponent);
    }

    const appEntryPoint = classifyAppEntryPoint(file);
    if (appEntryPoint) {
      appEntryPoints.push(appEntryPoint);
    }
  }

  const likelySourceRoots = [...sourceRootCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([sourceRoot]) => sourceRoot)
    .slice(0, 8);

  return {
    root,
    scannedFiles: files.length,
    truncated,
    topLevelDirectories,
    topLevelFiles,
    likelySourceRoots,
    frameworkSignals: [...frameworkSignals].sort(),
    routingFiles: dedupeAndSortMatches(routingFiles),
    pageComponents: dedupeAndSortMatches(pageComponents),
    appEntryPoints: dedupeAndSortMatches(appEntryPoints),
  };
}

function buildFrontendStructureSummary(
  analysis: FrontendRepoAnalysis,
  sampleSize: number,
): string {
  const parts: string[] = [];
  if (analysis.frameworkSignals.length > 0) {
    parts.push(`Detected ${analysis.frameworkSignals.slice(0, 4).join(", ")}`);
  } else {
    parts.push("Detected frontend-oriented source files");
  }
  if (analysis.likelySourceRoots.length > 0) {
    parts.push(`Primary source roots: ${analysis.likelySourceRoots.slice(0, 4).join(", ")}`);
  }
  if (analysis.appEntryPoints.length > 0) {
    parts.push(`Likely entry points: ${analysis.appEntryPoints.slice(0, sampleSize).map((match) => match.displayPath).join(", ")}`);
  }
  if (analysis.routingFiles.length > 0) {
    parts.push(`Routing surfaces: ${analysis.routingFiles.slice(0, sampleSize).map((match) => match.displayPath).join(", ")}`);
  }
  if (analysis.pageComponents.length > 0) {
    parts.push(`Page-like components: ${analysis.pageComponents.slice(0, sampleSize).map((match) => match.displayPath).join(", ")}`);
  }
  if (analysis.truncated) {
    parts.push(`Scan truncated after ${analysis.scannedFiles} relevant files`);
  }
  return `${parts.join(". ")}.`;
}

function createFindRoutingFilesTool(cwd: string) {
  return tool({
    description:
      "Find likely frontend routing files, router configs, and framework route roots " +
      "without relying on shell search loops.",
    inputSchema: z.object({
      path: z.string().optional().describe("Optional repo-relative or absolute directory to scan"),
      limit: z.number().optional().default(20).describe("Maximum matches to return (1-50)"),
    }),
    execute: async ({ path: inputPath, limit }) => {
      const resolved = resolveRepoAwareRoot(cwd, inputPath);
      if (!resolved.root) {
        return { matches: [], error: resolved.error ?? "Unable to resolve search root." };
      }
      const maxMatches = clampPositiveInt(limit, 20, 50);
      const analysis = analyzeFrontendRepo(resolved.root);
      return {
        root: resolved.root,
        matches: analysis.routingFiles.slice(0, maxMatches),
        count: analysis.routingFiles.length,
        scannedFiles: analysis.scannedFiles,
        truncated: analysis.truncated,
        frameworkSignals: analysis.frameworkSignals,
      };
    },
  });
}

function createFindPageComponentsTool(cwd: string) {
  return tool({
    description:
      "Find likely frontend page, screen, and view components using file layout and content heuristics.",
    inputSchema: z.object({
      path: z.string().optional().describe("Optional repo-relative or absolute directory to scan"),
      limit: z.number().optional().default(20).describe("Maximum matches to return (1-50)"),
    }),
    execute: async ({ path: inputPath, limit }) => {
      const resolved = resolveRepoAwareRoot(cwd, inputPath);
      if (!resolved.root) {
        return { matches: [], error: resolved.error ?? "Unable to resolve search root." };
      }
      const maxMatches = clampPositiveInt(limit, 20, 50);
      const analysis = analyzeFrontendRepo(resolved.root);
      return {
        root: resolved.root,
        matches: analysis.pageComponents.slice(0, maxMatches),
        count: analysis.pageComponents.length,
        scannedFiles: analysis.scannedFiles,
        truncated: analysis.truncated,
      };
    },
  });
}

function createFindAppEntryPointsTool(cwd: string) {
  return tool({
    description:
      "Find likely frontend app entry points such as bootstrap files, framework roots, and app shells.",
    inputSchema: z.object({
      path: z.string().optional().describe("Optional repo-relative or absolute directory to scan"),
      limit: z.number().optional().default(20).describe("Maximum matches to return (1-50)"),
    }),
    execute: async ({ path: inputPath, limit }) => {
      const resolved = resolveRepoAwareRoot(cwd, inputPath);
      if (!resolved.root) {
        return { matches: [], error: resolved.error ?? "Unable to resolve search root." };
      }
      const maxMatches = clampPositiveInt(limit, 20, 50);
      const analysis = analyzeFrontendRepo(resolved.root);
      return {
        root: resolved.root,
        matches: analysis.appEntryPoints.slice(0, maxMatches),
        count: analysis.appEntryPoints.length,
        scannedFiles: analysis.scannedFiles,
        truncated: analysis.truncated,
        frameworkSignals: analysis.frameworkSignals,
      };
    },
  });
}

function createSummarizeFrontendStructureTool(cwd: string) {
  return tool({
    description:
      "Summarize the frontend structure of a repo or subdirectory, including source roots, framework hints, " +
      "entry points, routing files, and page-like components.",
    inputSchema: z.object({
      path: z.string().optional().describe("Optional repo-relative or absolute directory to scan"),
      sampleSize: z.number().optional().default(5).describe("Examples to include per category (1-10)"),
    }),
    execute: async ({ path: inputPath, sampleSize }) => {
      const resolved = resolveRepoAwareRoot(cwd, inputPath);
      if (!resolved.root) {
        return { summary: "", error: resolved.error ?? "Unable to resolve search root." };
      }
      const maxExamples = clampPositiveInt(sampleSize, 5, 10);
      const analysis = analyzeFrontendRepo(resolved.root);
      return {
        root: resolved.root,
        summary: buildFrontendStructureSummary(analysis, maxExamples),
        scannedFiles: analysis.scannedFiles,
        truncated: analysis.truncated,
        frameworkSignals: analysis.frameworkSignals,
        likelySourceRoots: analysis.likelySourceRoots,
        topLevelDirectories: analysis.topLevelDirectories,
        topLevelFiles: analysis.topLevelFiles,
        entryPoints: analysis.appEntryPoints.slice(0, maxExamples),
        routingFiles: analysis.routingFiles.slice(0, maxExamples),
        pageComponents: analysis.pageComponents.slice(0, maxExamples),
      };
    },
  });
}

function createGitStatusTool(cwd: string) {
  return tool({
    description: "Show the working tree status (staged, unstaged, untracked files).",
    inputSchema: z.object({}),
    execute: async () => {
      try {
        const { stdout } = await execFileAsync("git", ["status", "--porcelain=v1", "-u"], {
          cwd,
          timeout: 15_000,
        });
        const { stdout: branch } = await execFileAsync(
          "git",
          ["rev-parse", "--abbrev-ref", "HEAD"],
          { cwd, timeout: 5_000 }
        );
        return { branch: branch.trim(), status: stdout.trim(), clean: stdout.trim() === "" };
      } catch (err) {
        return { error: `git status failed: ${getErrorMessage(err)}` };
      }
    },
  });
}

function createGitDiffTool(cwd: string) {
  return tool({
    description:
      "Show file diffs. By default shows unstaged changes. " +
      "Use staged=true for staged changes, or provide a ref to diff against.",
    inputSchema: z.object({
      staged: z.boolean().optional().default(false).describe("Show staged changes"),
      ref: z.string().optional().describe("Git ref to diff against (e.g., 'HEAD~1', 'main')"),
      path: z.string().optional().describe("Limit diff to a specific file or directory"),
    }),
    execute: async ({ staged, ref, path: filePath }) => {
      try {
        const args = ["diff", "--stat", "--patch"];
        if (staged && !ref) args.push("--cached");
        if (ref) args.push(ref);
        if (filePath) {
          args.push("--");
          args.push(filePath);
        }
        const { stdout } = await execFileAsync("git", args, {
          cwd,
          timeout: 30_000,
          maxBuffer: 5 * 1024 * 1024,
        });
        const truncated = stdout.length > 200_000;
        return { diff: stdout.slice(0, 200_000), truncated };
      } catch (err) {
        return { diff: "", error: `git diff failed: ${getErrorMessage(err)}` };
      }
    },
  });
}

function createGitLogTool(cwd: string) {
  return tool({
    description: "Show recent commit history.",
    inputSchema: z.object({
      count: z.number().optional().default(10).describe("Number of commits to show"),
      oneline: z.boolean().optional().default(true).describe("One-line format"),
      ref: z.string().optional().describe("Branch or ref to show log for"),
    }),
    execute: async ({ count, oneline, ref }) => {
      try {
        const args = ["log", `-${Math.min(count, 100)}`];
        if (oneline) {
          args.push("--oneline");
        } else {
          args.push("--format=%H %an %ad %s", "--date=short");
        }
        if (ref) args.push(ref);
        const { stdout } = await execFileAsync("git", args, { cwd, timeout: 15_000 });
        return { log: stdout.trim() };
      } catch (err) {
        return { log: "", error: `git log failed: ${getErrorMessage(err)}` };
      }
    },
  });
}

const askUserToolOptionSchema = z.object({
  label: z.string().describe("User-facing option label"),
  value: z.string().optional().describe("Optional stable value to return for this option"),
  description: z.string().optional().describe("Optional short sentence explaining the option"),
  recommended: z.boolean().optional().describe("Whether this option should be highlighted as recommended"),
  preview: z.string().optional().describe("Optional preview content shown alongside the option"),
  previewFormat: z.enum(["markdown", "html"]).optional().describe("Preview rendering format"),
});

const askUserToolQuestionSchema = z.object({
  id: z.string().optional().describe("Optional stable identifier for this question"),
  header: z.string().optional().describe("Short question header shown in the UI"),
  question: z.string().describe("The question to ask the user"),
  options: z.array(askUserToolOptionSchema).optional().describe("Optional multiple-choice options"),
  multiSelect: z.boolean().optional().describe("Allow selecting more than one option"),
  allowsFreeform: z.boolean().optional().describe("Allow typing a custom answer"),
  isSecret: z.boolean().optional().describe("Hide typed input while the user answers"),
  defaultAssumption: z.string().nullable().optional().describe("Default assumption if the user skips this question"),
  impact: z.string().nullable().optional().describe("Why this question matters"),
});

const todoToolItemSchema = z.object({
  id: z.string().optional().describe("Stable todo id. Reuse ids when updating an existing task."),
  content: z.string().optional().describe("Primary task description."),
  description: z.string().optional().describe("Alternate task description field."),
  activeForm: z.string().optional().describe("Optional active-progress wording for the task."),
  text: z.string().optional().describe("Alternate text field for compatibility."),
  status: z.enum(["pending", "in_progress", "inProgress", "completed"]).describe("Task status."),
});

function normalizeTodoToolItems(todos: unknown): TodoToolItem[] | null {
  if (!Array.isArray(todos)) return null;
  return todos.flatMap((todo, index) => {
    if (!todo || typeof todo !== "object") return [];
    const record = todo as Record<string, unknown>;
    const description = [
      record.content,
      record.activeForm,
      record.description,
      record.text,
    ].find((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0)?.trim();
    if (!description) return [];

    const rawStatus = typeof record.status === "string" ? record.status : "";
    const status: TodoToolItem["status"] =
      rawStatus === "completed"
        ? "completed"
        : rawStatus === "in_progress" || rawStatus === "inProgress"
          ? "in_progress"
          : "pending";
    const explicitId = typeof record.id === "string" && record.id.trim().length > 0 ? record.id.trim() : null;
    return [{
      id: explicitId ?? `todo-${index}`,
      description,
      status,
    }];
  });
}

function createTodoWriteTool(args: {
  getItems?: () => TodoToolItem[];
  onUpdate?: (items: TodoToolItem[]) => void;
}) {
  let todoItems = args.getItems?.() ?? [];
  return tool({
    description:
      "Create or update the current task list for this chat. " +
      "Use this to track a short, concrete plan and keep exactly one item in progress when possible.",
    inputSchema: z.object({
      todos: z.array(todoToolItemSchema).describe("The full current task list."),
    }),
    execute: async ({ todos }) => {
      const normalized = normalizeTodoToolItems(todos);
      if (normalized == null) {
        return { updated: false, error: "Provide a todos array." };
      }
      todoItems = normalized;
      args.onUpdate?.(normalized);
      return {
        updated: true,
        count: normalized.length,
        todos: normalized.map((item) => ({
          id: item.id,
          content: item.description,
          status: item.status,
        })),
      };
    },
  });
}

function createTodoReadTool(args: {
  getItems?: () => TodoToolItem[];
}) {
  let todoItems = args.getItems?.() ?? [];
  return tool({
    description: "Read the current task list for this chat session.",
    inputSchema: z.object({}),
    execute: async () => {
      todoItems = args.getItems?.() ?? todoItems;
      return {
        count: todoItems.length,
        todos: todoItems.map((item) => ({
          id: item.id,
          content: item.description,
          status: item.status,
        })),
      };
    },
  });
}

function createAskUserTool(
  onAskUser?: (input: AskUserToolInput) => Promise<string | AskUserToolResult>,
) {
  return tool({
    description:
      "Ask the user a clarifying question when you need more information to proceed. " +
      "Use sparingly — only when truly blocked.",
    inputSchema: z.object({
      question: z.string().optional().describe("Simple text question to ask the user"),
      title: z.string().optional().describe("Optional modal title for a richer prompt"),
      body: z.string().optional().describe("Optional supporting context shown above the question list"),
      questions: z.array(askUserToolQuestionSchema).optional().describe("Optional structured questions with choices"),
    }).refine(
      (value) => {
        const question = typeof value.question === "string" ? value.question.trim() : "";
        const body = typeof value.body === "string" ? value.body.trim() : "";
        return question.length > 0 || body.length > 0 || Boolean(value.questions?.length);
      },
      { message: "Provide question, body, or questions." },
    ),
    execute: async (input) => {
      if (!onAskUser) {
        return { answer: "", error: "askUser callback not configured" };
      }
      try {
        const response = await onAskUser(input);
        if (typeof response === "string") {
          return { answer: response };
        }
        return {
          answer: response.answer ?? "",
          ...(response.answers ? { answers: response.answers } : {}),
          ...(response.responseText !== undefined ? { responseText: response.responseText } : {}),
          ...(response.decision !== undefined ? { decision: response.decision } : {}),
          ...(response.error !== undefined ? { error: response.error } : {}),
        };
      } catch (err) {
        return {
          answer: "",
          error: `Failed to get user response: ${getErrorMessage(err)}`,
        };
      }
    },
  });
}

function createExitPlanModeTool(
  onApprovalRequest?: (request: ToolApprovalRequest) => Promise<ToolApprovalResult>,
) {
  return tool({
    description:
      "Exit plan mode and request user approval to proceed with implementation. " +
      "Call this after you have written your plan and are ready for the user to review it. " +
      "The user will see a plan approval UI and can approve or reject your plan.",
    inputSchema: z.object({
      planDescription: z.string().optional().describe("A summary of the plan for the user to review"),
    }),
    execute: async ({ planDescription }) => {
      if (!onApprovalRequest) {
        return { approved: false, message: "No approval handler configured. Stay in plan mode and ask the user to review your plan in chat." };
      }
      const summary = planDescription?.trim() || "Plan ready for review.";
      let result: ToolApprovalResult;
      try {
        result = await onApprovalRequest({
          category: "exitPlanMode",
          description: summary,
          detail: { tool: "exitPlanMode", planContent: summary },
        });
      } catch (err) {
        const reason = getErrorMessage(err) || "Approval request failed.";
        return {
          approved: false,
          message: `Plan approval could not be requested. ${reason}`,
        };
      }
      if (result.approved) {
        return { approved: true, message: "User approved the plan. Proceed with implementation." };
      }
      const feedback = typeof result.reason === "string" && result.reason.trim().length > 0
        ? result.reason.trim()
        : "Please revise your approach and try again.";
      return { approved: false, message: `User rejected the plan. ${feedback}` };
    },
  });
}

function createMemoryUpdateCoreTool(
  onMemoryUpdateCore: NonNullable<UniversalToolSetOptions["onMemoryUpdateCore"]>
) {
  return tool({
    description:
      "Update identity core memory (Tier-1) when the standing CTO brief changes: project summary, conventions, user preferences, active focus, or persistent notes. Do not use this for one-off discoveries; save those with memoryAdd instead.",
    inputSchema: z.object({
      projectSummary: z.string().optional(),
      criticalConventions: z.array(z.string()).optional(),
      userPreferences: z.array(z.string()).optional(),
      activeFocus: z.array(z.string()).optional(),
      notes: z.array(z.string()).optional(),
    }),
    execute: async (patch) => {
      const hasAnyValue = Object.values(patch).some((value) => value !== undefined);
      if (!hasAnyValue) {
        return {
          updated: false,
          error: "At least one core-memory field is required.",
        };
      }
      const next = onMemoryUpdateCore(patch);
      return {
        updated: true,
        version: next.version,
        updatedAt: next.updatedAt,
      };
    },
  });
}

// ── Public factory ──────────────────────────────────────────────────

export function createUniversalToolSet(
  cwd: string,
  opts: UniversalToolSetOptions
): Record<string, Tool> {
  const {
    permissionMode,
    memoryService,
    projectId,
    runId,
    stepId,
    agentScopeOwnerId,
    turnMemoryPolicyState,
    onMemoryWriteEvent,
    onAskUser,
    onApprovalRequest,
    onMemoryUpdateCore,
    onTodoUpdate,
    getTodoItems,
    sandboxConfig,
  } = opts;
  const effectiveSandboxConfig = sandboxConfig ?? DEFAULT_WORKER_SANDBOX_CONFIG;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: Record<string, Tool<any, any>> = {
    // Read-only tools (auto-allowed in all modes)
    readFile: createReadFileRangeTool(cwd),
    grep: createGrepSearchTool(cwd),
    glob: createGlobSearchTool(cwd),
    listDir: createListDirTool(cwd),
    findRoutingFiles: createFindRoutingFilesTool(cwd),
    findPageComponents: createFindPageComponentsTool(cwd),
    findAppEntryPoints: createFindAppEntryPointsTool(cwd),
    summarizeFrontendStructure: createSummarizeFrontendStructureTool(cwd),
    gitStatus: createGitStatusTool(cwd),
    gitDiff: createGitDiffTool(cwd),
    gitLog: createGitLogTool(cwd),
    webFetch: webFetchTool,
    webSearch: webSearchTool,

    // Planning/task state
    TodoWrite: createTodoWriteTool({ getItems: getTodoItems, onUpdate: onTodoUpdate }),
    TodoRead: createTodoReadTool({ getItems: getTodoItems }),

    // Interactive
    askUser: createAskUserTool(onAskUser),
  };

  if (permissionMode === "plan") {
    tools.exitPlanMode = createExitPlanModeTool(onApprovalRequest);
  } else {
    tools.editFile = createEditFileTool(
      cwd,
      permissionMode,
      effectiveSandboxConfig,
      onApprovalRequest,
      turnMemoryPolicyState,
    );
    tools.writeFile = createWriteFileTool(
      cwd,
      permissionMode,
      effectiveSandboxConfig,
      onApprovalRequest,
      turnMemoryPolicyState,
    );
    tools.bash = createBashTool(
      cwd,
      permissionMode,
      effectiveSandboxConfig,
      onApprovalRequest,
      turnMemoryPolicyState,
    );
  }

  // Conditionally add memory tools
  if (memoryService && projectId) {
    const memTools = createMemoryTools(memoryService, projectId, {
      runId,
      stepId,
      agentScopeOwnerId,
      turnMemoryPolicyState,
      onMemoryWriteEvent,
    });
    if (permissionMode === "plan") {
      tools.memorySearch = memTools.memorySearch;
    } else {
      Object.assign(tools, memTools);
    }
  }

  if (onMemoryUpdateCore && permissionMode !== "plan") {
    tools.memoryUpdateCore = createMemoryUpdateCoreTool(onMemoryUpdateCore);
  }

  return tools;
}
