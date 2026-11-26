import type { ChatTranscriptGroupedEnvelope, ChatWorkLogEntry } from "../chatTranscriptRows";
import { humanizeProvider } from "../../usage/usageProviderNames";

/**
 * Plain words for what the CTO is doing, read off its tool calls.
 *
 * Pure: the CTO thread's calm rendering (the working line and the quiet
 * chips) and the CTO page's "Now" line read the same words.
 */

/**
 * The bare tool name, whatever namespace the provider wrapped it in:
 * `mcp__ade__scheduleWork` (Claude), `ade.scheduleWork` / `ade_cto.scheduleWork`
 * (Codex and the ACP hosts), `ade/scheduleWork`, or plain `scheduleWork`.
 */
export function ctoToolBaseName(toolName: string | null | undefined, mcpTool?: string | null): string {
  const fromMcp = mcpTool?.trim();
  if (fromMcp) return fromMcp;
  const raw = (toolName ?? "").trim();
  if (!raw) return "";
  const parts = raw.split(/__|[./:]/).filter(Boolean);
  return parts[parts.length - 1] ?? raw;
}

function entryToolName(entry: ChatWorkLogEntry): string {
  return ctoToolBaseName(entry.toolName, entry.mcp?.tool ?? null);
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Tool results arrive as objects or as JSON text, depending on the provider. */
export function ctoToolResultRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
    try {
      return ctoToolResultRecord(JSON.parse(trimmed));
    } catch {
      return null;
    }
  }
  // MCP content blocks, bare (`[{ type: "text", text }]`) or wrapped in
  // `{ content: [...] }`: the JSON result is the first text block.
  if (Array.isArray(value)) return mcpTextRecord(value);
  const direct = record(value);
  if (!direct) return null;
  return (Array.isArray(direct.content) ? mcpTextRecord(direct.content) : null) ?? direct;
}

function mcpTextRecord(blocks: readonly unknown[]): Record<string, unknown> | null {
  const text = record(blocks.find((part) => record(part)?.type === "text"))?.text;
  return typeof text === "string" ? ctoToolResultRecord(text) : null;
}

/** A finished call that did not do what it was asked: it errored, was stopped, or said `success: false`. */
function isFailedToolEntry(entry: ChatWorkLogEntry): boolean {
  if (entry.status === "failed" || entry.status === "interrupted") return true;
  const result = ctoToolResultRecord(entry.result);
  return result?.success === false || (typeof result?.error === "string" && result.error.trim().length > 0);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0]!.trim();
}

export function clipWords(text: string, max = 48): string {
  const line = firstLine(text).replace(/^[-*]\s+/, "");
  if (line.length <= max) return line;
  const cut = line.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** The provider id a model id runs on (`anthropic/…` is `claude`), or null. */
function providerIdFromModelId(modelId: unknown): string | null {
  const id = str(modelId);
  if (!id) return null;
  const slash = id.indexOf("/");
  const prefix = slash > 0 ? id.slice(0, slash) : null;
  if (!prefix) return null;
  const known: Record<string, string> = { anthropic: "claude", openai: "codex" };
  return known[prefix] ?? prefix;
}

function providerFromModelId(modelId: unknown): string | null {
  const provider = providerIdFromModelId(modelId);
  return provider ? humanizeProvider(provider) : null;
}

export type CtoChipKind = "scheduled" | "cancelled" | "paused" | "resumed" | "tracking" | "done" | "started";

export type CtoToolChip = {
  /** The entry it came from; stable key for the row. */
  id: string;
  kind: CtoChipKind;
  /** "Scheduled", "Tracking", … */
  verb: string;
  /** What it was about, already clipped. Null when the call named nothing readable. */
  text: string | null;
  /** The call failed: the chip says it did not happen. */
  failed: boolean;
  /**
   * `started` only: a chat `spawnChat` started on another machine or on ADE
   * Cloud. No subagent card lands here for it, so the call draws the
   * "Started a new task" row itself.
   */
  remote?: CtoRemoteSpawn;
};

/** Where a chat `spawnChat` started on another machine or ADE Cloud runs. */
export type CtoRemoteSpawn = {
  sessionId: string | null;
  laneId: string | null;
  machineName: string;
  provider: string | null;
};

/**
 * A successful `spawnChat` that ran on another machine or ADE Cloud, read off
 * its result; null for a local spawn (its subagent card draws the row), a
 * failure, or anything else.
 */
export function ctoRemoteSpawnForEntry(entry: ChatWorkLogEntry): { remote: CtoRemoteSpawn; title: string | null } | null {
  if (entry.entryKind !== "tool" || entryToolName(entry) !== "spawnChat" || entry.status !== "completed") return null;
  const result = ctoToolResultRecord(entry.result);
  if (!result || result.success === false) return null;
  const cloud = result.adeCloud === true;
  // Every ADE Cloud lane has its own computer, but the person sees one machine: ADE Cloud.
  const machineName = cloud ? "ADE Cloud" : str(result.machineName);
  if (!machineName) return null;
  const args = record(entry.args) ?? {};
  return {
    remote: {
      sessionId: str(result.sessionId),
      laneId: str(result.laneId),
      machineName,
      // An ADE Cloud launch result names no provider; the model the CTO asked for does.
      provider: str(result.provider) ?? providerIdFromModelId(result.modelId) ?? providerIdFromModelId(args.modelId),
    },
    title: spawnTitle(args, result),
  };
}

function spawnTitle(args: Record<string, unknown>, result: Record<string, unknown> | null): string | null {
  const prompt = str(args.initialPrompt);
  return str(result?.requestedTitle) ?? str(args.title) ?? str(result?.laneName) ?? (prompt ? clipWords(prompt) : null);
}

/**
 * State-changing CTO tools that draw a chip instead of hiding in the tools
 * toggle. Notes, rules and skills draw none: the turn's "Learned" row lists
 * each of those changes with its Undo.
 */
const CHIP_TOOL_NAMES: ReadonlySet<string> = new Set([
  "scheduleWork",
  "cancelScheduledWork",
  "setScheduledWorkPaused",
  "trackWork",
  "finishWork",
  // Only a remote or ADE Cloud spawn (`ctoRemoteSpawnForEntry`) or a failed one draws.
  "spawnChat",
]);

export function isCtoChipEntry(entry: ChatWorkLogEntry): boolean {
  return entry.entryKind === "tool" && CHIP_TOOL_NAMES.has(entryToolName(entry));
}

export function hasCtoChipEntries(entries: readonly ChatWorkLogEntry[]): boolean {
  return entries.some(isCtoChipEntry);
}

/** True when a tool group has at least one finished state change to draw as a chip. */
export function drawsCtoChips(entries: readonly ChatWorkLogEntry[]): boolean {
  return hasCtoChipEntries(entries) && ctoChipsForEntries(entries).length > 0;
}

/** A tool group in the CTO thread that draws chips: it stays visible under the turn fold. */
export function keepCtoChipRowsVisible(row: ChatTranscriptGroupedEnvelope): boolean {
  return row.event.type === "work_log_group" && drawsCtoChips(row.event.entries);
}

const FAILED_VERB: Record<CtoChipKind, string> = {
  scheduled: "Couldn't schedule",
  cancelled: "Couldn't cancel",
  paused: "Couldn't pause",
  resumed: "Couldn't resume",
  tracking: "Couldn't track",
  done: "Couldn't finish",
  started: "Couldn't start",
};

/**
 * The chip for one finished state-changing CTO call, or null while it runs
 * (the working line shows it then) and for every other tool.
 */
export function ctoChipForEntry(entry: ChatWorkLogEntry): CtoToolChip | null {
  if (!isCtoChipEntry(entry)) return null;
  if (entry.status === "running") return null;
  const name = entryToolName(entry);
  if (name === "spawnChat") {
    const spawn = ctoRemoteSpawnForEntry(entry);
    if (spawn) {
      return { id: entry.id, kind: "started", verb: "Started a new task", text: spawn.title ? clipWords(spawn.title) : null, failed: false, remote: spawn.remote };
    }
    // A local spawn that started draws its row from its subagent card. One
    // that failed, on any machine, says so in the thread.
    if (!isFailedToolEntry(entry)) return null;
    const title = spawnTitle(record(entry.args) ?? {}, ctoToolResultRecord(entry.result));
    return { id: entry.id, kind: "started", verb: FAILED_VERB.started, text: title ? clipWords(title) : null, failed: true };
  }
  const args = record(entry.args) ?? {};
  const result = ctoToolResultRecord(entry.result);
  const payload = record(result?.result) ?? record(result?.item) ?? result;
  const failed = isFailedToolEntry(entry);
  // A declined confirm is not a failure of the call, but nothing changed.
  if (result?.declined === true || result?.cancelled === true) return null;

  let kind: CtoChipKind;
  let text: string | null = null;
  switch (name) {
    case "scheduleWork":
      kind = "scheduled";
      text = str(payload?.title) ?? str(args.reason) ?? str(args.prompt);
      break;
    case "cancelScheduledWork":
      kind = "cancelled";
      text = str(payload?.title) ?? str(payload?.reason) ?? str(payload?.prompt);
      break;
    case "setScheduledWorkPaused": {
      kind = args.paused === false ? "resumed" : "paused";
      text = str(payload?.title) ?? (args.scheduleId ? null : "every routine on that chat");
      break;
    }
    case "trackWork":
      kind = "tracking";
      text = str(args.text) ?? str(payload?.text);
      break;
    case "finishWork":
      kind = "done";
      text = str(payload?.text) ?? str(args.outcome);
      break;
    default:
      return null;
  }
  const verbs: Record<CtoChipKind, string> = {
    scheduled: "Scheduled",
    cancelled: "Cancelled",
    paused: "Paused",
    resumed: "Resumed",
    tracking: "Tracking",
    done: "Done",
    started: "Started a new task",
  };
  return {
    id: entry.id,
    kind,
    verb: failed ? FAILED_VERB[kind] : verbs[kind],
    text: text ? clipWords(text) : null,
    failed,
  };
}

export function ctoChipsForEntries(entries: readonly ChatWorkLogEntry[]): CtoToolChip[] {
  const chips: CtoToolChip[] = [];
  for (const entry of entries) {
    const chip = ctoChipForEntry(entry);
    if (chip) chips.push(chip);
  }
  return chips;
}

/**
 * One running step in plain words: "Checking PR #12", "Reading a chat",
 * "Starting a chat on Codex". Null for a tool this does not know; the caller
 * falls back to the generic label.
 */
export function ctoStepWords(toolName: string, rawArgs: unknown): string | null {
  const name = ctoToolBaseName(toolName);
  const args = record(rawArgs) ?? {};
  const prNumber = typeof args.prNumber === "number" ? args.prNumber : typeof args.number === "number" ? args.number : null;
  const pr = prNumber != null ? `PR #${prNumber}` : "a PR";
  const sessionIds = Array.isArray(args.sessionIds) ? args.sessionIds.length : 0;
  switch (name) {
    case "spawnChat": {
      const provider = providerFromModelId(args.modelId);
      return provider ? `Starting a chat on ${provider}` : "Starting a chat";
    }
    case "listChats":
      return "Looking over the chats";
    case "getChatStatus":
    case "getSessionLifecycle":
      return "Checking on a chat";
    case "getChatTranscript":
      return "Reading a chat";
    case "waitForChats":
      return sessionIds > 1 ? `Waiting on ${sessionIds} chats` : "Waiting on a chat";
    case "sendChatMessage":
    case "steerChat":
      return "Messaging a chat";
    case "interruptChat":
      return "Stopping a chat";
    case "handoffChatToModel":
      return "Handing off a chat";
    case "listLanes":
    case "inspectLane":
      return "Looking at the lanes";
    case "createLane":
      return "Making a lane";
    case "listPullRequests":
      return "Checking the PRs";
    case "getPullRequestStatus":
    case "getPullRequestDiff":
    case "watchPullRequest":
      return `Checking ${pr}`;
    case "commentOnPullRequest":
      return `Commenting on ${pr}`;
    case "createPrFromLane":
      return "Opening a PR";
    case "landPullRequest":
      return `Landing ${pr}`;
    case "approvePullRequest":
      return `Approving ${pr}`;
    case "readWorkspaceFile":
      return "Reading a file";
    case "searchWorkspaceText":
    case "searchCodebase":
    case "searchProject":
      return "Searching the project";
    case "readHistory":
      return "Reading our history";
    case "replyNow":
      // A short visible reply mid-turn; it lands as an ordinary text row, never a chip.
      return "Replying";
    case "noReply":
      return "Wrapping up";
    case "react":
      // The reaction itself lands on the person's bubble.
      return "Reacting";
    case "remember":
      return "Saving a note";
    case "forget":
      return "Dropping a note";
    case "addRule":
      return "Saving a rule";
    case "removeRule":
      return "Dropping a rule";
    case "saveSkill":
      return "Saving a skill";
    case "readSkill":
      return "Reading a skill";
    case "deleteSkill":
      return "Deleting a skill";
    case "searchMemory":
      return "Searching my archive";
    case "recallNote":
      return "Pinning a note again";
    case "trackWork":
      return "Noting open work";
    case "finishWork":
      return "Closing out open work";
    case "scheduleWork":
      return "Scheduling a check-in";
    case "listScheduledWork":
    case "getScheduledWorkState":
      return "Checking the schedule";
    case "cancelScheduledWork":
      return "Cancelling a routine";
    case "setScheduledWorkPaused":
      return args.paused === false ? "Resuming a routine" : "Pausing a routine";
    case "runTests":
      return "Running tests";
    case "listLinearIssues":
    case "getLinearIssue":
      return "Reading Linear";
    case "getUsageSnapshot":
    case "getUsageStats":
    case "getBudgetStatus":
      return "Checking usage";
    case "listMachines":
      return "Looking at your machines";
    case "runMachineAction":
      return "Acting on a machine";
    case "listComputerUseArtifacts":
    case "getArtifactPreview":
    case "reviewArtifact":
      return "Looking at proof";
    case "captureProof":
      return "Filing proof";
    case "showMedia":
      return "Adding a picture";
    case "getChatProof":
      return "Getting a chat's proof";
    case "gitStatus":
    case "gitListRecentCommits":
    case "gitListBranches":
      return "Checking git";
    case "getRecentEvents":
    case "getProjectHealthSummary":
      return "Catching up on the project";
    case "listSubagents":
      return "Checking helpers";
    case "Bash":
    case "PowerShell":
      return "Running a command";
    case "Read":
      return "Reading a file";
    case "Grep":
    case "Glob":
      return "Searching the project";
    case "ToolSearch":
    case "loadCtoTools":
      return "Finding the right tool";
    case "WebSearch":
    case "WebFetch":
      return "Searching the web";
    case "Task":
    case "Agent":
      return "Starting a helper";
    case "TodoWrite":
      return "Planning";
    default:
      return humanizeToolName(name);
  }
}

const TOOL_VERB_WORDS: Record<string, string> = {
  list: "Looking at",
  get: "Checking",
  read: "Reading",
  search: "Searching",
  find: "Finding",
  inspect: "Looking at",
  create: "Making",
  update: "Updating",
  set: "Setting",
  run: "Running",
  start: "Starting",
  send: "Sending",
  open: "Opening",
  check: "Checking",
  review: "Reviewing",
  fetch: "Fetching",
};

/**
 * A tool with no hand-written words still reads as a step: `listAutomationRules`
 * → "Looking at automation rules". Null when the name has no known verb, so
 * the caller falls back to "Working" rather than echoing a raw tool name.
 */
function humanizeToolName(name: string): string | null {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length < 2) return null;
  const verb = TOOL_VERB_WORDS[words[0]!];
  if (!verb) return null;
  return `${verb} ${words.slice(1).join(" ")}`;
}

/** The newest running step of a live turn, in plain words; null when none is running or known. */
export function ctoLatestStepWords(entries: readonly ChatWorkLogEntry[]): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.status !== "running" || entry.entryKind !== "tool" || !entry.toolName) continue;
    const words = ctoStepWords(entry.mcp?.tool ?? entry.toolName, entry.args);
    if (words) return words;
  }
  return null;
}

/** Every step of a live turn, oldest first, for the working line's expanded list. */
export function ctoStepList(entries: readonly ChatWorkLogEntry[]): Array<{ id: string; words: string; status: ChatWorkLogEntry["status"] }> {
  const steps: Array<{ id: string; words: string; status: ChatWorkLogEntry["status"] }> = [];
  for (const entry of entries) {
    let words: string | null = null;
    if (entry.entryKind === "tool" && entry.toolName) words = ctoStepWords(entry.mcp?.tool ?? entry.toolName, entry.args);
    if (!words && entry.entryKind === "command" && entry.command?.trim()) words = "Running a command";
    if (!words && entry.entryKind === "web_search") words = "Searching the web";
    if (!words) words = entry.label?.trim() || "Working";
    steps.push({ id: entry.id, words, status: entry.status });
  }
  return steps;
}
