import path from "node:path";
import type { Tool } from "ai";
import type { ModelDescriptor } from "../../../shared/modelRegistry";
import type { PermissionMode } from "./tools/universalTools";

const LOW_VALUE_DISCOVERY_TOOL_NAMES = new Set(["listDir", "glob", "grep"]);
const STARTER_TOOL_NAMES = [
  "memorySearch",
  "readFile",
  "grep",
  "glob",
  "listDir",
  "findRoutingFiles",
  "findPageComponents",
  "findAppEntryPoints",
  "summarizeFrontendStructure",
  "editFile",
  "writeFile",
  "askUser",
  "exitPlanMode",
  "memoryAdd",
] as const;
const NARROW_TOOL_NAMES = [
  "memorySearch",
  "readFile",
  "findRoutingFiles",
  "findPageComponents",
  "findAppEntryPoints",
  "summarizeFrontendStructure",
  "editFile",
  "writeFile",
  "askUser",
  "exitPlanMode",
  "memoryAdd",
] as const;
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
  "askUser",
  "exitPlanMode",
]);
const CODE_GLOB_EXTENSIONS = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs"]);
const EXACT_DUPLICATE_SUPPRESSION_THRESHOLD = 2;
const FAMILY_DUPLICATE_SUPPRESSION_THRESHOLD = 3;
const LOOP_CLAMP_THRESHOLD = 2;
const LOOP_FINALIZE_THRESHOLD = 4;
const FRONTEND_DIR_RE = /(?:^|\/)(?:src|app|pages|web|frontend|client)(?:\/|$)/i;
const FRONTEND_STRUCTURAL_FILE_RE = /(?:^|\/)(?:app|pages|routes?|router|layout|main|app|page|index)(?:\/|[._-]|$)/i;
const PAGE_COMPONENT_FILE_RE = /(?:^|\/)(?:about(?:[-_ ]me)?|home|page|screen|view|layout|route)(?:[._-]|$)/i;
const WEB_FILE_EXT_RE = /\.(?:tsx?|jsx?|vue|svelte)$/i;

type ToolCallLike = {
  toolName?: string;
  input?: unknown;
  args?: unknown;
};

type ToolResultLike = {
  toolName?: string;
  output?: unknown;
  result?: unknown;
};

type LowValueToolName = "listDir" | "glob" | "grep";

export type DuplicateSuppressionResult = {
  suppressed: boolean;
  reason?: "exact_duplicate" | "same_family";
  result?: unknown;
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
  toolChoice?: "none" | { type: "tool"; toolName: string };
  hiddenSteer?: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stableStringify(value: unknown): string {
  if (value == null) return String(value);
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

function toPortablePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function normalizePathToken(value: string, cwd?: string): string {
  const trimmed = value.trim();
  if (!trimmed.length) return "";
  const resolved = cwd && !path.isAbsolute(trimmed)
    ? path.resolve(cwd, trimmed)
    : path.resolve(trimmed);
  if (cwd) {
    const relative = path.relative(cwd, resolved);
    if (relative.length && !relative.startsWith("..") && !path.isAbsolute(relative)) {
      return toPortablePath(relative);
    }
  }
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

function normalizeLowValueToolSignature(
  toolName: string,
  input: unknown,
  cwd?: string,
): { exactKey: string; familyKey: string; summary: string } | null {
  const lowValueToolName = LOW_VALUE_DISCOVERY_TOOL_NAMES.has(toolName)
    ? toolName as LowValueToolName
    : null;
  if (!lowValueToolName) return null;

  const record = asRecord(input);
  if (lowValueToolName === "listDir") {
    const dirPath = normalizePathToken(extractString(record, "path"), cwd);
    const recursive = extractBoolean(record, "recursive");
    return {
      exactKey: `listDir:${dirPath}:recursive=${recursive}`,
      familyKey: `listDir:${dirPath}`,
      summary: dirPath || ".",
    };
  }

  if (lowValueToolName === "glob") {
    const basePath = normalizePathToken(extractString(record, "path"), cwd);
    const pattern = extractString(record, "pattern").toLowerCase();
    return {
      exactKey: `glob:${basePath}:${pattern}`,
      familyKey: `glob:${basePath}:${normalizeGlobFamily(pattern)}`,
      summary: `${basePath || "."}:${pattern}`,
    };
  }

  const searchPath = normalizePathToken(extractString(record, "path"), cwd);
  const pattern = extractString(record, "pattern").toLowerCase();
  const fileGlob = extractString(record, "glob").toLowerCase();
  return {
    exactKey: `grep:${searchPath}:${pattern}:${fileGlob}`,
    familyKey: `grep:${searchPath}:${pattern}`,
    summary: `${searchPath || "."}:${pattern}`,
  };
}

function buildSuppressedToolResult(
  toolName: LowValueToolName,
  summary: string,
  reason: "exact_duplicate" | "same_family",
): unknown {
  const message = reason === "exact_duplicate"
    ? `Suppressed duplicate ${toolName} call for '${summary}'. You already ran this search. Pick a concrete candidate file and inspect it instead of repeating discovery.`
    : `Suppressed near-duplicate ${toolName} call for '${summary}'. You already searched an equivalent file family. Narrow scope or inspect a candidate file next.`;

  if (toolName === "listDir") {
    return { entries: [], count: 0, truncated: false, suppressed: true, message };
  }
  if (toolName === "glob") {
    return { files: [], count: 0, suppressed: true, message };
  }
  return { matches: [], matchCount: 0, suppressed: true, message };
}

function resolveFilePathFromInput(toolName: string, input: unknown, cwd?: string): string {
  const record = asRecord(input);
  if (!record) return "";
  if (toolName === "readFile") return normalizePathToken(extractString(record, "file_path"), cwd);
  if (toolName === "writeFile" || toolName === "editFile") {
    return normalizePathToken(extractString(record, "file_path"), cwd);
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
    && (FRONTEND_STRUCTURAL_FILE_RE.test(filePath) || PAGE_COMPONENT_FILE_RE.test(filePath) || FRONTEND_DIR_RE.test(filePath));
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
  for (const key of ["files", "routingFiles", "pageComponents", "entryPoints", "candidates"]) {
    if (record[key] !== undefined) {
      collected.push(...collectPathsFromValue(record[key]));
    }
  }
  return collected;
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function filterToolNames(allToolNames: string[], allowed: Iterable<string>): string[] {
  const allowedSet = new Set(allowed);
  return allToolNames.filter((toolName) => allowedSet.has(toolName));
}

function takeFirstUnreadCandidate(
  candidateFiles: Set<string>,
  readFiles: Set<string>,
): string | null {
  for (const candidate of candidateFiles) {
    if (!readFiles.has(candidate)) return candidate;
  }
  return null;
}

export class UnifiedToolLoopGovernor {
  private readonly weakLocalModel: boolean;
  private readonly readOnlyLocalModel: boolean;
  private readonly exactCounts = new Map<string, number>();
  private readonly familyCounts = new Map<string, number>();
  private readonly candidateFiles = new Set<string>();
  private readonly narrowedDirectories = new Set<string>();
  private readonly readFiles = new Set<string>();
  private nonProgressSteps = 0;
  private meaningfulProgress = false;
  private broadDiscoverySeen = false;
  private suppressionCount = 0;

  constructor(
    private readonly args: {
      cwd: string;
      modelDescriptor: Pick<ModelDescriptor, "authTypes" | "harnessProfile">;
      permissionMode: PermissionMode;
    },
  ) {
    this.weakLocalModel =
      args.modelDescriptor.authTypes.includes("local")
      && args.modelDescriptor.harnessProfile !== "verified";
    this.readOnlyLocalModel = args.modelDescriptor.harnessProfile === "read_only" || args.permissionMode === "plan";
  }

  shouldApply(): boolean {
    return this.weakLocalModel;
  }

  noteToolCall(toolName: string, input: unknown): DuplicateSuppressionResult {
    const filePath = resolveFilePathFromInput(toolName, input, this.args.cwd);
    if (toolName === "readFile" && filePath) {
      this.readFiles.add(filePath);
    }

    const signature = normalizeLowValueToolSignature(toolName, input, this.args.cwd);
    if (!signature) {
      return { suppressed: false };
    }

    this.broadDiscoverySeen = true;
    const exactCount = this.exactCounts.get(signature.exactKey) ?? 0;
    const familyCount = this.familyCounts.get(signature.familyKey) ?? 0;
    this.exactCounts.set(signature.exactKey, exactCount + 1);
    this.familyCounts.set(signature.familyKey, familyCount + 1);

    const exactDuplicate = exactCount >= EXACT_DUPLICATE_SUPPRESSION_THRESHOLD;
    const familyDuplicate =
      toolName === "glob"
      && !exactDuplicate
      && familyCount >= FAMILY_DUPLICATE_SUPPRESSION_THRESHOLD;

    if (!exactDuplicate && !familyDuplicate) {
      return { suppressed: false };
    }

    this.suppressionCount += 1;
    const reason = exactDuplicate ? "exact_duplicate" : "same_family";
    return {
      suppressed: true,
      reason,
      result: buildSuppressedToolResult(
        toolName as LowValueToolName,
        signature.summary,
        reason,
      ),
    };
  }

  recordStep(step: { toolCalls?: ToolCallLike[]; toolResults?: ToolResultLike[] }): UnifiedLoopStepSummary {
    const reasons: string[] = [];
    const candidateFiles: string[] = [];
    const narrowedDirectories: string[] = [];
    let score = 0;

    const pendingInputs = new Map<string, unknown[]>();
    for (const toolCall of step.toolCalls ?? []) {
      const toolName = typeof toolCall.toolName === "string" ? toolCall.toolName : "";
      const input = toolCall.input ?? toolCall.args;
      if (!toolName) continue;

      const queue = pendingInputs.get(toolName) ?? [];
      queue.push(input);
      pendingInputs.set(toolName, queue);

      if (toolName === "writeFile" || toolName === "editFile") {
        score += 4;
        reasons.push(`mutated ${toolName === "writeFile" ? "a file" : "an existing file"}`);
        const filePath = resolveFilePathFromInput(toolName, input, this.args.cwd);
        if (filePath) candidateFiles.push(filePath);
        continue;
      }

      if (toolName === "readFile") {
        const filePath = resolveFilePathFromInput(toolName, input, this.args.cwd);
        if (filePath) {
          this.readFiles.add(filePath);
          if (isLikelyCandidateFile(filePath) || this.candidateFiles.has(filePath)) {
            score += 2;
            reasons.push(`opened ${filePath}`);
          } else {
            score += 1;
            reasons.push(`inspected ${filePath}`);
          }
        }
        continue;
      }

      if (toolName === "findRoutingFiles" || toolName === "findPageComponents" || toolName === "findAppEntryPoints" || toolName === "summarizeFrontendStructure") {
        score += 1;
        reasons.push(`used ${toolName}`);
        continue;
      }

      if (toolName === "listDir") {
        const signature = normalizeLowValueToolSignature(toolName, input, this.args.cwd);
        const dirPath = signature?.summary ?? "";
        const recursive = extractBoolean(asRecord(input), "recursive");
        if (recursive && isBroadRootPath(dirPath)) {
          score -= 2;
          reasons.push("repeated broad recursive directory enumeration");
        } else if (dirPath && !isBroadRootPath(dirPath)) {
          narrowedDirectories.push(dirPath);
          reasons.push(`narrowed to ${dirPath}`);
        } else {
          score -= 1;
          reasons.push("listed the project root again");
        }
        continue;
      }

      if (toolName === "glob") {
        const signature = normalizeLowValueToolSignature(toolName, input, this.args.cwd);
        const summary = signature?.summary ?? "";
        if (summary.includes("**/*.<code-ext>") || summary.includes("**/*.ts") || summary.includes("**/*.tsx") || summary.includes("**/*.js") || summary.includes("**/*.jsx")) {
          score -= 2;
          reasons.push("ran another broad source-file glob");
        } else {
          score -= 1;
          reasons.push("used glob discovery without narrowing to a concrete file");
        }
        continue;
      }

      if (toolName === "grep") {
        const searchPath = normalizePathToken(extractString(asRecord(input), "path"), this.args.cwd);
        if (!searchPath || isBroadRootPath(searchPath)) {
          score -= 1;
          reasons.push("ran grep across a broad scope");
        } else {
          reasons.push(`searched inside ${searchPath}`);
        }
      }
    }

    for (const toolResult of step.toolResults ?? []) {
      const toolName = typeof toolResult.toolName === "string" ? toolResult.toolName : "";
      if (!toolName) continue;
      const pairedInput = pendingInputs.get(toolName)?.shift();
      const output = toolResult.output ?? toolResult.result;

      if (toolName === "listDir") {
        const pairedRecord = asRecord(pairedInput);
        const dirPath = normalizePathToken(extractString(pairedRecord, "path"), this.args.cwd);
        const outputRecord = asRecord(output);
        const entries = Array.isArray(outputRecord?.entries) ? outputRecord.entries : [];
        for (const entry of entries) {
          const entryRecord = asRecord(entry);
          const name = extractString(entryRecord, "name");
          if (!name) continue;
          const normalized = normalizePathToken(path.join(dirPath || this.args.cwd, name), this.args.cwd);
          if (entryRecord?.type === "directory" && isLikelyFrontendDirectory(normalized)) {
            narrowedDirectories.push(normalized);
          }
          if (entryRecord?.type === "file" && isLikelyCandidateFile(normalized)) {
            candidateFiles.push(normalized);
          }
        }
      }

      if (toolName === "glob" || toolName === "grep" || toolName === "findRoutingFiles" || toolName === "findPageComponents" || toolName === "findAppEntryPoints" || toolName === "summarizeFrontendStructure") {
        const paths = collectPathsFromValue(output)
          .map((value) => normalizePathToken(value, this.args.cwd))
          .filter((value) => value.length > 0);
        for (const candidate of paths) {
          if (isLikelyFrontendDirectory(candidate)) narrowedDirectories.push(candidate);
          if (isLikelyCandidateFile(candidate)) candidateFiles.push(candidate);
        }
      }

      const outputRecord = asRecord(output);
      if (outputRecord?.suppressed === true) {
        score -= 2;
        reasons.push(`duplicate ${toolName} call was suppressed`);
      }
    }

    const uniqueCandidates = dedupeStrings(candidateFiles);
    const uniqueDirectories = dedupeStrings(narrowedDirectories);

    if (uniqueCandidates.length > 0) {
      uniqueCandidates.forEach((candidate) => this.candidateFiles.add(candidate));
      score += 2;
      reasons.push(`found ${uniqueCandidates.length} concrete candidate file${uniqueCandidates.length === 1 ? "" : "s"}`);
    } else if (uniqueDirectories.length > 0) {
      uniqueDirectories.forEach((dir) => this.narrowedDirectories.add(dir));
      score += 1;
      reasons.push(`narrowed the search to ${uniqueDirectories.length} relevant director${uniqueDirectories.length === 1 ? "y" : "ies"}`);
    }

    const progress: UnifiedLoopStepProgress = score >= 2
      ? "progress"
      : score >= 1
        ? "narrowed"
        : "non_progress";

    if (progress === "progress") {
      this.meaningfulProgress = true;
      this.nonProgressSteps = 0;
    } else if (progress === "narrowed") {
      this.nonProgressSteps = 0;
    } else {
      this.nonProgressSteps += 1;
    }

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

    let activeTools: string[] = [];
    if (this.readOnlyLocalModel) {
      activeTools = filterToolNames(allToolNames, READ_ONLY_TOOL_NAMES);
    } else if (this.nonProgressSteps >= LOOP_CLAMP_THRESHOLD || this.suppressionCount > 0) {
      activeTools = filterToolNames(allToolNames, NARROW_TOOL_NAMES);
    } else if (this.meaningfulProgress) {
      activeTools = [...allToolNames];
    } else {
      activeTools = filterToolNames(allToolNames, STARTER_TOOL_NAMES);
    }

    const unreadCandidate = takeFirstUnreadCandidate(this.candidateFiles, this.readFiles);
    const hiddenSteerParts: string[] = [];
    let toolChoice: UnifiedLoopStepPolicy["toolChoice"];

    if (this.nonProgressSteps >= LOOP_CLAMP_THRESHOLD || this.suppressionCount > 0) {
      hiddenSteerParts.push(
        "You already searched broadly in this repo.",
        "Do not run another broad listDir, glob, or grep call unless you are narrowing to a new directory that you have not inspected yet.",
      );
      if (unreadCandidate) {
        hiddenSteerParts.push(`Pick one concrete candidate file such as '${unreadCandidate}' and inspect it next.`);
        if (activeTools.includes("readFile")) {
          toolChoice = { type: "tool", toolName: "readFile" };
        }
      } else if (activeTools.includes("summarizeFrontendStructure")) {
        hiddenSteerParts.push("Use the higher-level frontend structure tools instead of primitive discovery.");
      }
    }

    if (this.nonProgressSteps >= LOOP_FINALIZE_THRESHOLD) {
      toolChoice = "none";
      hiddenSteerParts.push(
        "You are not making progress with tools.",
        "Stop using tools and explain the blocker or the single missing fact you still need.",
      );
    }

    return {
      ...(activeTools.length ? { activeTools } : {}),
      ...(toolChoice ? { toolChoice } : {}),
      ...(hiddenSteerParts.length ? { hiddenSteer: hiddenSteerParts.join(" ") } : {}),
    };
  }
}

export function createUnifiedToolLoopGovernor(args: {
  cwd: string;
  modelDescriptor: Pick<ModelDescriptor, "authTypes" | "harnessProfile">;
  permissionMode: PermissionMode;
}): UnifiedToolLoopGovernor {
  return new UnifiedToolLoopGovernor(args);
}

export function wrapToolsWithUnifiedLoopGovernor(
  tools: Record<string, Tool>,
  governor: UnifiedToolLoopGovernor,
  onSuppressed?: (args: { toolName: string; reason: "exact_duplicate" | "same_family" }) => void,
): Record<string, Tool> {
  const wrapped: Record<string, Tool> = {};

  for (const [toolName, toolDef] of Object.entries(tools)) {
    const execute = (toolDef as { execute?: ((input: unknown) => Promise<unknown>) | undefined }).execute;
    if (typeof execute !== "function") {
      wrapped[toolName] = toolDef;
      continue;
    }

    wrapped[toolName] = {
      ...(toolDef as Record<string, unknown>),
      execute: async (input: unknown) => {
        const suppression = governor.noteToolCall(toolName, input);
        if (suppression.suppressed) {
          if (suppression.reason) {
            onSuppressed?.({ toolName, reason: suppression.reason });
          }
          return suppression.result;
        }
        return execute(input);
      },
    } as Tool;
  }

  return wrapped;
}
