import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Tool } from "ai";
import type { ModelDescriptor } from "../../../shared/modelRegistry";
import type { PermissionMode } from "./tools/universalTools";

const LOW_VALUE_DISCOVERY_TOOL_NAMES = new Set(["listDir", "glob", "grep"]);
const HIGH_LEVEL_DISCOVERY_TOOL_NAMES = new Set([
  "findRoutingFiles",
  "findPageComponents",
  "findAppEntryPoints",
  "summarizeFrontendStructure",
]);
const DISCOVERY_TOOL_NAMES = new Set([
  ...LOW_VALUE_DISCOVERY_TOOL_NAMES,
  ...HIGH_LEVEL_DISCOVERY_TOOL_NAMES,
]);
const READ_ONLY_TOOL_NAMES = new Set([
  "memorySearch",
  "readFile",
  "grep",
  "glob",
  "listDir",
  "findRoutingFiles",
  "findPageComponents",
  "findAppEntryPoints",
  "summarizeFrontendStructure",
  "TodoWrite",
  "TodoRead",
  "askUser",
  "exitPlanMode",
]);
const CODE_GLOB_EXTENSIONS = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs"]);
const DOOM_LOOP_THRESHOLD = 3;
const FRONTEND_DIR_RE = /(?:^|\/)(?:src|app|pages|web|frontend|client)(?:\/|$)/i;
const FRONTEND_STRUCTURAL_FILE_RE = /(?:^|\/)(?:app|pages|routes?|router|layout|main|app|page|index)(?:\/|[._-]|$)/i;
const PAGE_COMPONENT_FILE_RE = /(?:^|\/)(?:about(?:[-_ ]me)?|home|page|screen|view|layout|route)(?:[._-]|$)/i;
const WEB_FILE_EXT_RE = /\.(?:tsx?|jsx?|vue|svelte)$/i;

type ToolCallLike = {
  toolName?: string;
  input?: unknown;
  args?: unknown;
  toolCallId?: string;
};

type ToolResultLike = {
  toolName?: string;
  output?: unknown;
  result?: unknown;
  input?: unknown;
  toolCallId?: string;
};

type DiscoveryToolName =
  | "listDir"
  | "glob"
  | "grep"
  | "findRoutingFiles"
  | "findPageComponents"
  | "findAppEntryPoints"
  | "summarizeFrontendStructure";

type PendingToolCall = {
  toolCallId: string;
  toolName: string;
  input: unknown;
  consumed: boolean;
};

export type UnifiedToolPhase =
  | "plan"
  | "edit"
  | "blocked";

export type UnifiedToolFamily =
  | "repo_overview"
  | "structure_search"
  | "broad_file_scan"
  | "broad_content_search"
  | "targeted_discovery"
  | "inspection"
  | "todo"
  | "write"
  | "other";

export type UnifiedToolPolicyDecision = {
  toolName: string;
  family?: UnifiedToolFamily;
  normalizedKey?: string;
  decision: "allow" | "stop_tools";
  reasonCode:
    | "allow"
    | "blocked_turn";
  reason: string;
  phase: UnifiedToolPhase;
  candidateCount: number;
  inspectedCount: number;
  cwd: string;
  suppressedResult?: unknown;
};

export type UnifiedTurnState = {
  phase: UnifiedToolPhase;
  candidateFiles: Set<string>;
  inspectedFiles: Set<string>;
  inspectedReadRanges: Set<string>;
  searchedDirectories: Set<string>;
  lastMeaningfulTodoHash: string | null;
  stopTools: boolean;
  recentExactToolCalls: string[];
};

export type UnifiedLoopStepProgress = "non_progress" | "narrowed" | "progress";

export type UnifiedLoopStepSummary = {
  score: number;
  progress: UnifiedLoopStepProgress;
  reasons: string[];
  candidateFiles: string[];
  narrowedDirectories: string[];
};

export type UnifiedLoopStepPolicy = {
  activeTools?: string[];
  toolChoice?: "none" | "required" | { type: "tool"; toolName: string };
};

type DiscoveryToolSignature = {
  toolName: DiscoveryToolName;
  family: UnifiedToolFamily;
  exactKey: string;
  normalizedKey: string;
  summary: string;
  directoryKey: string;
};

type TodoPolicyState = {
  hash: string;
  meaningful: boolean;
  count: number;
  inProgressCount: number;
};

function buildGenericSuppressedResult(message: string): { suppressed: true; message: string } {
  return { suppressed: true, message };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function toPortablePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function normalizeScopeToken(value: string, cwd?: string): string {
  const trimmed = value.trim();
  if (!trimmed.length) return "";
  const resolved = cwd && !path.isAbsolute(trimmed)
    ? path.resolve(cwd, trimmed)
    : path.resolve(trimmed);
  if (cwd) {
    const relative = path.relative(cwd, resolved);
    if (!relative.length) return ".";
    if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
      return toPortablePath(relative);
    }
  }
  return toPortablePath(resolved);
}

function normalizeFileToken(value: string, cwd?: string): string {
  const trimmed = value.trim();
  if (!trimmed.length) return "";
  const resolved = cwd && !path.isAbsolute(trimmed)
    ? path.resolve(cwd, trimmed)
    : path.resolve(trimmed);
  return toPortablePath(resolved);
}

function normalizeGlobFamily(pattern: string): string {
  const normalized = toPortablePath(pattern.trim().toLowerCase());
  return normalized.replace(/\*\*\/\*\.(ts|tsx|js|jsx|mjs|cjs)\b/g, (_match, ext: string) =>
    CODE_GLOB_EXTENSIONS.has(ext) ? "**/*.<code-ext>" : `**/*.${ext}`,
  );
}

function extractString(record: Record<string, unknown> | null, ...keys: string[]): string {
  if (!record) return "";
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length) return value.trim();
  }
  return "";
}

function extractBoolean(record: Record<string, unknown> | null, key: string): boolean {
  return Boolean(record && typeof record[key] === "boolean" && record[key]);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

function buildExactToolCallKey(toolName: string, input: unknown, cwd: string): string {
  if (toolName === "readFile") {
    const record = asRecord(input);
    const filePath = resolveFilePathFromInput(toolName, input, cwd) || extractString(record, "file_path", "path");
    const offset = typeof record?.offset === "number" ? record.offset : null;
    const limit = typeof record?.limit === "number" ? record.limit : null;
    return `readFile:${filePath}:${offset ?? ""}:${limit ?? ""}`;
  }
  return `${toolName}:${stableStringify(input)}`;
}

function countConsecutiveExactToolCalls(history: string[], key: string): number {
  let count = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index] !== key) break;
    count += 1;
  }
  return count;
}

function normalizeDiscoveryToolSignature(
  toolName: string,
  input: unknown,
  cwd?: string,
): DiscoveryToolSignature | null {
  const discoveryToolName = DISCOVERY_TOOL_NAMES.has(toolName)
    ? toolName as DiscoveryToolName
    : null;
  if (!discoveryToolName) return null;

  const record = asRecord(input);
  if (discoveryToolName === "listDir") {
    const dirPath = normalizeScopeToken(extractString(record, "path"), cwd) || ".";
    const recursive = extractBoolean(record, "recursive");
    const family = isBroadRootPath(dirPath) ? "repo_overview" : "targeted_discovery";
    return {
      toolName: discoveryToolName,
      family,
      exactKey: `listDir:${dirPath}:recursive=${recursive}`,
      normalizedKey: family === "repo_overview"
        ? `repo_overview:${dirPath}`
        : `targeted_discovery:${dirPath}`,
      summary: dirPath,
      directoryKey: dirPath,
    };
  }

  if (discoveryToolName === "glob") {
    const basePath = normalizeScopeToken(extractString(record, "path"), cwd) || ".";
    const pattern = extractString(record, "pattern").toLowerCase();
    const normalizedPattern = normalizeGlobFamily(pattern);
    const broad = isBroadRootPath(basePath) || isBroadSourceGlobFamily(normalizedPattern);
    const family = broad ? "broad_file_scan" : "targeted_discovery";
    return {
      toolName: discoveryToolName,
      family,
      exactKey: `glob:${basePath}:${pattern}`,
      normalizedKey: `${family}:${basePath}:${normalizedPattern}`,
      summary: `${basePath}:${pattern}`,
      directoryKey: basePath,
    };
  }

  if (discoveryToolName === "grep") {
    const searchPath = normalizeScopeToken(extractString(record, "path"), cwd) || ".";
    const pattern = extractString(record, "pattern").toLowerCase();
    const fileGlob = extractString(record, "glob").toLowerCase();
    const broad = isBroadRootPath(searchPath);
    const family = broad ? "broad_content_search" : "targeted_discovery";
    return {
      toolName: discoveryToolName,
      family,
      exactKey: `grep:${searchPath}:${pattern}:${fileGlob}`,
      normalizedKey: `${family}:${searchPath}:${pattern}:${fileGlob || "*"}`,
      summary: `${searchPath}:${pattern}`,
      directoryKey: searchPath,
    };
  }

  const basePath = normalizeScopeToken(extractString(record, "path"), cwd) || ".";
  const family = discoveryToolName === "summarizeFrontendStructure"
    ? "repo_overview"
    : "structure_search";
  return {
    toolName: discoveryToolName,
    family,
    exactKey: `${discoveryToolName}:${basePath}`,
    normalizedKey: `${family}:${basePath}`,
    summary: basePath,
    directoryKey: basePath,
  };
}

function resolveFilePathFromInput(toolName: string, input: unknown, cwd?: string): string {
  const record = asRecord(input);
  if (!record) return "";
  if (toolName === "readFile") return normalizeFileToken(extractString(record, "file_path"), cwd);
  if (toolName === "writeFile" || toolName === "editFile") {
    return normalizeFileToken(extractString(record, "file_path"), cwd);
  }
  return "";
}

function isBroadRootPath(filePath: string): boolean {
  return filePath === "" || filePath === "." || filePath === "/";
}

function isLikelyFrontendDirectory(filePath: string): boolean {
  return FRONTEND_DIR_RE.test(filePath);
}

function isLikelyCandidateFile(filePath: string): boolean {
  return WEB_FILE_EXT_RE.test(filePath)
    && (
      FRONTEND_STRUCTURAL_FILE_RE.test(filePath)
      || PAGE_COMPONENT_FILE_RE.test(filePath)
      || FRONTEND_DIR_RE.test(filePath)
    );
}

function collectPathsFromValue(value: unknown): string[] {
  if (!value) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectPathsFromValue(entry));
  }
  const record = asRecord(value);
  if (!record) return [];

  const directPath = extractString(record, "path", "file");
  const collected = directPath ? [directPath] : [];
  for (const key of ["files", "matches", "routingFiles", "pageComponents", "entryPoints", "candidates"]) {
    if (record[key] !== undefined) {
      collected.push(...collectPathsFromValue(record[key]));
    }
  }
  return collected;
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function extractToolCallInput(toolCall: ToolCallLike): unknown {
  return toolCall.input ?? toolCall.args;
}

function isBroadSourceGlobFamily(normalizedPattern: string): boolean {
  return normalizedPattern.includes("**/*.<code-ext>");
}

function claimPendingToolCall(
  pendingToolCalls: PendingToolCall[],
  toolResult: ToolResultLike,
): PendingToolCall | undefined {
  const resultToolName = typeof toolResult.toolName === "string" ? toolResult.toolName : "";
  const unresolved = pendingToolCalls.filter((toolCall) =>
    !toolCall.consumed && (!resultToolName || toolCall.toolName === resultToolName),
  );
  if (unresolved.length === 0) return undefined;

  const toolCallId = typeof toolResult.toolCallId === "string" ? toolResult.toolCallId : "";
  if (toolCallId) {
    const explicitMatch = unresolved.find((toolCall) => toolCall.toolCallId === toolCallId);
    if (explicitMatch) {
      explicitMatch.consumed = true;
      return explicitMatch;
    }
  }

  if (toolResult.input !== undefined) {
    const explicitMatch = unresolved.find((toolCall) =>
      isDeepStrictEqual(toolCall.input, toolResult.input),
    );
    if (explicitMatch) {
      explicitMatch.consumed = true;
      return explicitMatch;
    }
  }

  const fallbackMatch = unresolved[0];
  fallbackMatch.consumed = true;
  return fallbackMatch;
}

function filterToolNames(allToolNames: string[], allowed: Iterable<string>): string[] {
  const allowedSet = new Set(allowed);
  return allToolNames.filter((toolName) => allowedSet.has(toolName));
}

function filterOutHighLevelDiscoveryTools(allToolNames: string[]): string[] {
  return allToolNames.filter((toolName) => !HIGH_LEVEL_DISCOVERY_TOOL_NAMES.has(toolName));
}

function hasUnreadCandidateFiles(
  candidateFiles: Set<string>,
  inspectedFiles: Set<string>,
): boolean {
  return [...candidateFiles].some((candidate) => !inspectedFiles.has(candidate));
}

function normalizeTodoPolicyState(
  input: unknown,
  lastMeaningfulTodoHash: string | null,
): TodoPolicyState | null {
  const record = asRecord(input);
  const todos = Array.isArray(record?.todos) ? record.todos : null;
  if (!todos) return null;

  const normalized = todos.flatMap((todo, index) => {
    const todoRecord = asRecord(todo);
    if (!todoRecord) return [];
    const description = [
      todoRecord.content,
      todoRecord.activeForm,
      todoRecord.description,
      todoRecord.text,
    ].find((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0)?.trim();
    if (!description) return [];

    const rawStatus = typeof todoRecord.status === "string" ? todoRecord.status : "";
    const status =
      rawStatus === "completed"
        ? "completed"
        : rawStatus === "in_progress" || rawStatus === "inProgress"
          ? "in_progress"
          : "pending";
    const explicitId = typeof todoRecord.id === "string" && todoRecord.id.trim().length > 0
      ? todoRecord.id.trim()
      : `todo-${index}`;
    return [{ id: explicitId, description, status }];
  });

  const hash = JSON.stringify(normalized);
  const inProgressCount = normalized.filter((todo) => todo.status === "in_progress").length;
  return {
    hash,
    meaningful:
      normalized.length > 0
      && normalized.length <= 5
      && inProgressCount <= 1
      && hash !== lastMeaningfulTodoHash,
    count: normalized.length,
    inProgressCount,
  };
}

function buildInitialMeaningfulTodoHash(
  items: Array<{ id?: string; description?: string; status?: string }> | undefined,
): string | null {
  if (!Array.isArray(items) || items.length === 0) return null;
  const normalized = normalizeTodoPolicyState({
    todos: items.map((item) => ({
      id: item.id,
      description: item.description,
      status: item.status,
    })),
  }, null);
  return normalized?.meaningful ? normalized.hash : null;
}

export class UnifiedToolLoopGovernor {
  private readonly localModel: boolean;
  private readonly readOnlyLocalModel: boolean;
  private readonly state: UnifiedTurnState = {
    phase: "plan",
    candidateFiles: new Set<string>(),
    inspectedFiles: new Set<string>(),
    inspectedReadRanges: new Set<string>(),
    searchedDirectories: new Set<string>(),
    lastMeaningfulTodoHash: null,
    stopTools: false,
    recentExactToolCalls: [],
  };

  constructor(
    private readonly args: {
      cwd: string;
      modelDescriptor: Pick<ModelDescriptor, "authTypes" | "harnessProfile">;
      permissionMode: PermissionMode;
      initialTodoItems?: Array<{ id?: string; description?: string; status?: string }>;
    },
  ) {
    this.localModel = args.modelDescriptor.authTypes.includes("local");
    this.readOnlyLocalModel =
      args.modelDescriptor.harnessProfile === "read_only" || args.permissionMode === "plan";
    this.state.lastMeaningfulTodoHash = buildInitialMeaningfulTodoHash(args.initialTodoItems);
  }

  shouldApply(): boolean {
    return this.localModel;
  }

  shouldStopFurtherToolUse(): boolean {
    return this.shouldApply() && (this.state.phase === "blocked" || this.state.stopTools);
  }

  buildBlockedToolSummary(): string {
    if (this.args.permissionMode === "plan") {
      return [
        "I am stopping tool use for this turn because the tool pattern became repetitive.",
        this.state.lastMeaningfulTodoHash
          ? "Use exitPlanMode to request implementation approval, or revise the short TodoWrite plan if something important is still missing."
          : "The next useful step is a short TodoWrite plan, one clarifying askUser question, or a concrete explanation of the blocker.",
      ].join(" ");
    }

    if (this.state.inspectedFiles.size > 0 || this.state.candidateFiles.size > 0) {
      return [
        "I am stopping tool use for this turn because the tool pattern became repetitive.",
        "Switch to a different concrete step or explain the exact blocker instead of repeating the same tool input.",
      ].join(" ");
    }

    return [
      "I am stopping tool use for this turn because the tool pattern became repetitive.",
      "The next useful response is the exact missing fact or a concrete next step instead of another broad search.",
    ].join(" ");
  }

  private buildDecision(args: {
    toolName: string;
    family?: UnifiedToolFamily;
    normalizedKey?: string;
    decision: UnifiedToolPolicyDecision["decision"];
    reasonCode: UnifiedToolPolicyDecision["reasonCode"];
    reason: string;
    suppressedResult?: unknown;
  }): UnifiedToolPolicyDecision {
    return {
      toolName: args.toolName,
      ...(args.family ? { family: args.family } : {}),
      ...(args.normalizedKey ? { normalizedKey: args.normalizedKey } : {}),
      decision: args.decision,
      reasonCode: args.reasonCode,
      reason: args.reason,
      phase: this.state.phase,
      candidateCount: this.state.candidateFiles.size,
      inspectedCount: this.state.inspectedFiles.size,
      cwd: this.args.cwd,
      ...(args.suppressedResult !== undefined ? { suppressedResult: args.suppressedResult } : {}),
    };
  }

  private rememberExactToolCall(toolName: string, input: unknown): void {
    const exactKey = buildExactToolCallKey(toolName, input, this.args.cwd);
    this.state.recentExactToolCalls.push(exactKey);
    if (this.state.recentExactToolCalls.length > DOOM_LOOP_THRESHOLD) {
      this.state.recentExactToolCalls.splice(
        0,
        this.state.recentExactToolCalls.length - DOOM_LOOP_THRESHOLD,
      );
    }
  }

  private buildPreferredDiscoveryGuidance(): string {
    if (this.args.permissionMode === "plan") {
      return this.state.lastMeaningfulTodoHash
        ? "Use exitPlanMode to request implementation approval, or revise the short TodoWrite plan if it is incomplete."
        : "Capture a short TodoWrite plan, ask one clarifying question if needed, or explain the exact blocker.";
    }
    if (hasUnreadCandidateFiles(this.state.candidateFiles, this.state.inspectedFiles) || this.state.inspectedFiles.size > 0) {
      return "Use a different concrete tool step or explain the blocker instead of repeating the same call.";
    }
    return "Explain the exact missing fact instead of broadening the search again.";
  }

  private buildDoomLoopReason(toolName: string): string {
    if (toolName === "readFile") {
      return `doom_loop: repeated identical readFile call 3 times with the same input. ${this.buildPreferredDiscoveryGuidance()}`;
    }

    if (toolName === "TodoWrite") {
      return "doom_loop: repeated identical TodoWrite call 3 times with the same input. Either update the task list materially or continue with the next concrete step.";
    }

    if (toolName === "TodoRead") {
      return "doom_loop: repeated identical TodoRead call 3 times with the same input. Use the current task list to continue the work instead of rereading it again.";
    }

    return `doom_loop: repeated identical ${toolName} call 3 times with the same input. ${this.buildPreferredDiscoveryGuidance()}`;
  }

  private noteReadFileInspection(input: unknown): { openedFile: string | null; repeatedReadRange: boolean } {
    const openedFile = resolveFilePathFromInput("readFile", input, this.args.cwd);
    if (!openedFile) {
      return { openedFile: null, repeatedReadRange: false };
    }

    const exactReadKey = buildExactToolCallKey("readFile", input, this.args.cwd);
    const repeatedReadRange = this.state.inspectedReadRanges.has(exactReadKey);
    this.state.inspectedFiles.add(openedFile);
    if (!repeatedReadRange) {
      this.state.inspectedReadRanges.add(exactReadKey);
      if (this.state.phase !== "edit" && this.state.phase !== "blocked") {
        this.state.phase = "plan";
      }
    }

    return { openedFile, repeatedReadRange };
  }

  private noteFileMutation(toolName: "writeFile" | "editFile", input: unknown): string | null {
    const changedFile = resolveFilePathFromInput(toolName, input, this.args.cwd);
    if (changedFile) {
      this.state.candidateFiles.add(changedFile);
      if (this.state.phase !== "blocked") {
        this.state.phase = "edit";
      }
    }
    return changedFile;
  }

  private noteTodoWriteResult(input: unknown): TodoPolicyState | null {
    const todoState = normalizeTodoPolicyState(input, this.state.lastMeaningfulTodoHash);
    if (todoState?.meaningful) {
      this.state.lastMeaningfulTodoHash = todoState.hash;
      if (this.state.phase !== "edit" && this.state.phase !== "blocked") {
        this.state.phase = "plan";
      }
    }
    return todoState;
  }

  evaluateToolCall(toolName: string, input: unknown): UnifiedToolPolicyDecision {
    if (!this.shouldApply()) {
      return this.buildDecision({
        toolName,
        decision: "allow",
        reasonCode: "allow",
        reason: "Loop policy disabled for this model.",
      });
    }

    if (this.state.phase === "blocked" || this.state.stopTools) {
      const reason = `doom_loop: tool use is blocked for the rest of this turn. ${this.buildPreferredDiscoveryGuidance()}`;
      return this.buildDecision({
        toolName,
        decision: "stop_tools",
        reasonCode: "blocked_turn",
        reason,
        suppressedResult: buildGenericSuppressedResult(reason),
      });
    }

    const exactToolKey = buildExactToolCallKey(toolName, input, this.args.cwd);
    if (countConsecutiveExactToolCalls(this.state.recentExactToolCalls, exactToolKey) >= DOOM_LOOP_THRESHOLD - 1) {
      const reason = this.buildDoomLoopReason(toolName);
      this.state.stopTools = true;
      this.state.phase = "blocked";
      return this.buildDecision({
        toolName,
        family: toolName === "readFile" ? "inspection" : undefined,
        normalizedKey: exactToolKey,
        decision: "stop_tools",
        reasonCode: "blocked_turn",
        reason,
        suppressedResult: buildGenericSuppressedResult(reason),
      });
    }

    const filePath = resolveFilePathFromInput(toolName, input, this.args.cwd);
    if (toolName === "readFile" && filePath) {
      this.rememberExactToolCall(toolName, input);
      return this.buildDecision({
        toolName,
        family: "inspection",
        normalizedKey: filePath,
        decision: "allow",
        reasonCode: "allow",
        reason: `Inspecting '${filePath}'.`,
      });
    }

    if ((toolName === "writeFile" || toolName === "editFile") && filePath) {
      this.rememberExactToolCall(toolName, input);
      return this.buildDecision({
        toolName,
        family: "write",
        normalizedKey: filePath,
        decision: "allow",
        reasonCode: "allow",
        reason: `Writing '${filePath}'.`,
      });
    }

    if (toolName === "TodoWrite") {
      this.rememberExactToolCall(toolName, input);
      const todoState = normalizeTodoPolicyState(input, this.state.lastMeaningfulTodoHash);
      return this.buildDecision({
        toolName,
        family: "todo",
        normalizedKey: todoState?.hash,
        decision: "allow",
        reasonCode: "allow",
        reason: todoState?.meaningful
          ? "Recorded a short, materially changed task list."
          : "TodoWrite allowed, but it only counts as progress when the short plan changes materially and stays concise.",
      });
    }

    const signature = normalizeDiscoveryToolSignature(toolName, input, this.args.cwd);
    if (!signature) {
      this.rememberExactToolCall(toolName, input);
      return this.buildDecision({
        toolName,
        decision: "allow",
        reasonCode: "allow",
        reason: "Tool is outside the discovery loop policy.",
      });
    }

    this.rememberExactToolCall(toolName, input);

    return this.buildDecision({
      toolName: signature.toolName,
      family: signature.family,
      normalizedKey: signature.normalizedKey,
      decision: "allow",
      reasonCode: "allow",
      reason: `Discovery allowed for '${signature.summary}'.`,
    });
  }

  recordStep(step: { toolCalls?: ToolCallLike[]; toolResults?: ToolResultLike[] }): UnifiedLoopStepSummary {
    const reasons: string[] = [];
    const candidateFiles: string[] = [];
    const narrowedDirectories: string[] = [];
    let usedActionTool = false;
    let usedDiscoveryTool = false;
    let score = 0;

    const pendingToolCalls: PendingToolCall[] = [];
    for (const toolCall of step.toolCalls ?? []) {
      const toolName = typeof toolCall.toolName === "string" ? toolCall.toolName : "";
      const input = extractToolCallInput(toolCall);
      if (!toolName) continue;

      pendingToolCalls.push({
        toolCallId: typeof toolCall.toolCallId === "string" ? toolCall.toolCallId : "",
        toolName,
        input,
        consumed: false,
      });

      if (DISCOVERY_TOOL_NAMES.has(toolName)) {
        usedDiscoveryTool = true;
      }

      if (HIGH_LEVEL_DISCOVERY_TOOL_NAMES.has(toolName)) {
        reasons.push(`used ${toolName}`);
        continue;
      }

      if (toolName === "listDir") {
        const signature = normalizeDiscoveryToolSignature(toolName, input, this.args.cwd);
        const dirPath = signature?.directoryKey ?? ".";
        const recursive = extractBoolean(asRecord(input), "recursive");
        if (recursive && isBroadRootPath(dirPath)) {
          score -= 2;
          reasons.push("repeated broad recursive directory enumeration");
        } else if (!isBroadRootPath(dirPath)) {
          narrowedDirectories.push(dirPath);
          reasons.push(`narrowed to ${dirPath}`);
        } else {
          score -= 1;
          reasons.push("listed the project root again");
        }
        continue;
      }

      if (toolName === "glob") {
        const signature = normalizeDiscoveryToolSignature(toolName, input, this.args.cwd);
        if (signature?.family === "broad_file_scan") {
          score -= 2;
          reasons.push("ran another broad source-file glob");
        } else {
          score -= 1;
          reasons.push("used glob discovery without narrowing to a concrete file");
        }
        continue;
      }

      if (toolName === "grep") {
        const signature = normalizeDiscoveryToolSignature(toolName, input, this.args.cwd);
        if (!signature || isBroadRootPath(signature.directoryKey)) {
          score -= 1;
          reasons.push("ran grep across a broad scope");
        } else {
          reasons.push(`searched inside ${signature.directoryKey}`);
        }
      }
    }

    for (const toolResult of step.toolResults ?? []) {
      const pairedCall = claimPendingToolCall(pendingToolCalls, toolResult);
      const toolName = typeof toolResult.toolName === "string" && toolResult.toolName.length > 0
        ? toolResult.toolName
        : pairedCall?.toolName ?? "";
      if (!toolName) continue;
      const pairedInput = pairedCall?.input;
      const output = toolResult.output ?? toolResult.result;
      const outputRecord = asRecord(output);
      const suppressedByPolicy = outputRecord?.suppressed === true;

      if (toolName === "writeFile" || toolName === "editFile") {
        if (!suppressedByPolicy) {
          usedActionTool = true;
          score += 4;
          reasons.push(`mutated ${toolName === "writeFile" ? "a file" : "an existing file"}`);
          const changedFile = this.noteFileMutation(toolName, pairedInput);
          if (changedFile) {
            candidateFiles.push(changedFile);
          }
          continue;
        }
      }

      if (toolName === "readFile") {
        if (!suppressedByPolicy) {
          usedActionTool = true;
          const { openedFile, repeatedReadRange } = this.noteReadFileInspection(pairedInput);
          if (openedFile) {
            if (repeatedReadRange) {
              score -= 2;
              reasons.push(`re-read the same range from ${openedFile}`);
            } else {
              const knownCandidateFiles = new Set([
                ...this.state.candidateFiles,
                ...candidateFiles,
              ]);
              if (isLikelyCandidateFile(openedFile) || knownCandidateFiles.has(openedFile)) {
                score += 2;
                reasons.push(`opened ${openedFile}`);
              } else {
                score += 1;
                reasons.push(`inspected ${openedFile}`);
              }
            }
          }
          continue;
        }
      }

      if (toolName === "TodoWrite") {
        if (!suppressedByPolicy) {
          usedActionTool = true;
          const todoState = this.noteTodoWriteResult(pairedInput);
          if (todoState?.meaningful) {
            score += 2;
            reasons.push("updated a short, materially changed task list");
          } else {
            score -= 1;
            reasons.push("updated the task list without materially changing the short plan");
          }
          continue;
        }
      }

      if (toolName === "TodoRead") {
        if (!suppressedByPolicy) {
          reasons.push("reviewed the current task list");
          continue;
        }
      }

      if (toolName === "listDir") {
        const pairedRecord = asRecord(pairedInput);
        const dirPath = normalizeScopeToken(extractString(pairedRecord, "path"), this.args.cwd) || ".";
        const outputRecord = asRecord(output);
        const entries = Array.isArray(outputRecord?.entries) ? outputRecord.entries : [];
        for (const entry of entries) {
          const entryRecord = asRecord(entry);
          const entryPath =
            normalizeFileToken(extractString(entryRecord, "path"), this.args.cwd)
            || normalizeFileToken(path.join(dirPath, extractString(entryRecord, "name")), this.args.cwd);
          if (!entryPath) continue;
          if (entryRecord?.type === "directory" && isLikelyFrontendDirectory(entryPath)) {
            narrowedDirectories.push(entryPath);
          }
          if (entryRecord?.type === "file" && isLikelyCandidateFile(entryPath)) {
            candidateFiles.push(entryPath);
          }
        }
      }

      if (
        toolName === "glob"
        || toolName === "grep"
        || toolName === "findRoutingFiles"
        || toolName === "findPageComponents"
        || toolName === "findAppEntryPoints"
        || toolName === "summarizeFrontendStructure"
      ) {
        const paths = collectPathsFromValue(output)
          .map((value) => normalizeFileToken(value, this.args.cwd))
          .filter((value) => value.length > 0);
        for (const candidate of paths) {
          if (isLikelyFrontendDirectory(candidate)) narrowedDirectories.push(candidate);
          if (isLikelyCandidateFile(candidate)) candidateFiles.push(candidate);
        }
      }

      if (outputRecord?.suppressed === true) {
        score -= 2;
        reasons.push(`policy suppressed ${toolName}`);
      }
    }

    const uniqueCandidates = dedupeStrings(candidateFiles);
    const uniqueDirectories = dedupeStrings(narrowedDirectories);
    const newCandidates = uniqueCandidates.filter((candidate) => !this.state.candidateFiles.has(candidate));
    const knownCandidates = uniqueCandidates.filter((candidate) => this.state.candidateFiles.has(candidate));
    const newDirectories = uniqueDirectories.filter((dir) => !this.state.searchedDirectories.has(dir));
    const knownDirectories = uniqueDirectories.filter((dir) => this.state.searchedDirectories.has(dir));

    if (newCandidates.length > 0) {
      newCandidates.forEach((candidate) => this.state.candidateFiles.add(candidate));
      score += 2;
      reasons.push(`found ${newCandidates.length} new concrete candidate file${newCandidates.length === 1 ? "" : "s"}`);
    } else if (knownCandidates.length > 0 && usedDiscoveryTool) {
      score -= 1;
      reasons.push(`revisited the same ${knownCandidates.length} candidate file${knownCandidates.length === 1 ? "" : "s"}`);
    }

    if (newDirectories.length > 0) {
      newDirectories.forEach((dir) => this.state.searchedDirectories.add(dir));
      score += 1;
      reasons.push(`narrowed the search to ${newDirectories.length} new relevant director${newDirectories.length === 1 ? "y" : "ies"}`);
    } else if (knownDirectories.length > 0 && usedDiscoveryTool && newCandidates.length === 0 && knownCandidates.length === 0) {
      score -= 1;
      reasons.push(`revisited the same ${knownDirectories.length} directory target${knownDirectories.length === 1 ? "" : "s"}`);
    }

    const progress: UnifiedLoopStepProgress = score >= 2
      ? "progress"
      : score >= 1
        ? "narrowed"
        : "non_progress";

    return {
      score,
      progress,
      reasons,
      candidateFiles: uniqueCandidates,
      narrowedDirectories: uniqueDirectories,
    };
  }

  buildStepPolicy(allToolNames: string[]): UnifiedLoopStepPolicy {
    if (!this.shouldApply()) return {};

    if (this.state.phase === "blocked" || this.state.stopTools) {
      return {
        activeTools: [],
        toolChoice: "none",
      };
    }

    let activeTools = this.readOnlyLocalModel
      ? filterToolNames(allToolNames, READ_ONLY_TOOL_NAMES)
      : [...allToolNames];

    if (this.state.inspectedFiles.size > 0 || this.state.phase === "edit") {
      activeTools = filterOutHighLevelDiscoveryTools(activeTools);
    }

    return {
      ...(activeTools.length ? { activeTools } : {}),
    };
  }
}

export function createUnifiedToolLoopGovernor(args: {
  cwd: string;
  modelDescriptor: Pick<ModelDescriptor, "authTypes" | "harnessProfile">;
  permissionMode: PermissionMode;
  initialTodoItems?: Array<{ id?: string; description?: string; status?: string }>;
}): UnifiedToolLoopGovernor {
  return new UnifiedToolLoopGovernor(args);
}

export function wrapToolsWithUnifiedLoopGovernor(
  tools: Record<string, Tool>,
  governor: UnifiedToolLoopGovernor,
  onDecision?: (decision: UnifiedToolPolicyDecision) => void,
): Record<string, Tool> {
  const wrapped: Record<string, Tool> = {};

  for (const [toolName, toolDef] of Object.entries(tools)) {
    const execute = (toolDef as { execute?: ((...args: any[]) => Promise<unknown>) | undefined }).execute;
    if (typeof execute !== "function") {
      wrapped[toolName] = toolDef;
      continue;
    }

    wrapped[toolName] = {
      ...(toolDef as Record<string, unknown>),
      execute: async (...args: any[]) => {
        const input = args[0];
        const decision = governor.evaluateToolCall(toolName, input);
        onDecision?.(decision);
        if (decision.decision !== "allow") {
          return decision.suppressedResult;
        }
        return execute(...args);
      },
    } as Tool;
  }

  return wrapped;
}
