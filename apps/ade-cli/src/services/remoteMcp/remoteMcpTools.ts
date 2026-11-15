import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildDeeplink, type DeeplinkOwnership } from "../../../../desktop/src/shared/deeplinks";
import { pathIsWithinRoot } from "../../../../desktop/src/shared/pathContainment";
import { redactOutgoingChatText } from "../../../../desktop/src/main/utils/redaction";
import { CHAT_SETTING_FIELDS } from "../../../../desktop/src/shared/chatTurnStatus";
import type { RemoteMcpToolResult } from "./remoteMcpForward";
import { MAX_OUTPUT_BYTES, MAX_STDIN_BYTES, type RemoteRunResult } from "./remoteMcpRunner";

/**
 * ADE MCP's typed tools: named inputs a client can check before calling. Each
 * one only builds the words of one `ade` command; the service runs it through
 * the same policy check and runner as the `ade` tool, so a typed tool can never
 * do more than the connection's scope allows. Write tools are listed only to
 * full-access connections.
 *
 * Every tool asks the CLI for JSON and returns `structuredContent` as
 * `{ project, result, next? }`: `result` is the CLI's JSON, trimmed to what a
 * model needs (the CLI's own lists can run past a megabyte); `next` is the
 * next step, written where the model decides it, instead of as a rule in the
 * tool text. The `result` shape of each tool is noted beside it; the ADE MCP
 * app renders these (it reads `structuredContent.view`, the tool's name, to
 * pick how), so keep them stable.
 *
 * Text here is paid for by every connected app before it does anything, and
 * the budget test (remoteMcpContextBudget.test.ts) holds it: state each rule
 * once, where it is read.
 */

type TypedToolInput = Record<string, unknown>;

type TypedToolBuild = { argv: string[] } | { error: string };

/**
 * Where a result came from: this computer's account machine key and the
 * project the command ran in. Links in results carry both, so opening one
 * goes to that computer and project from anywhere (desktop, web, phone).
 */
export type TypedShapeContext = { ownership: DeeplinkOwnership | null };

export type TypedTool = {
  name: string;
  title: string;
  description: string;
  /** JSON Schema of the inputs, without the shared `project`. */
  properties: Record<string, unknown>;
  required?: string[];
  /** Changes things: listed and run only for full-access connections. */
  write?: true;
  /** Answers for the whole computer, so it takes no `project`. */
  machineWide?: true;
  /** A list that takes `machine: "all"`: one row per computer of the account. */
  fanOut?: true;
  /** The ADE MCP app (remoteMcpApps.ts) can draw its result. */
  view?: true;
  /**
   * Without `project`, runs in each of the computer's recent projects and
   * merges the shaped results; with `project`, runs in that one only.
   */
  everyProject?: {
    merge: (parts: Array<{ project: { id: string; name: string }; result: unknown }>) => unknown;
  };
  build: (input: TypedToolInput) => TypedToolBuild;
  /** Reshapes the CLI's parsed JSON into `result`. */
  shape?: (value: unknown, input: TypedToolInput, context: TypedShapeContext) => unknown;
  /** The next step for the model, from the shaped result; null when there is none to give. */
  next?: (result: unknown, input: TypedToolInput) => string | null;
  /** Fills inputs the call left out from the model the person last launched a chat with. */
  launchDefaults?: (input: TypedToolInput, defaults: { provider: string; model: string; reasoningEffort?: string | null }) => TypedToolInput;
  /** What the command reads on stdin, so large text never goes through an argument. */
  stdin?: (input: TypedToolInput) => string | null;
  /** It creates something, so it must name where: `project`, and `machine` on the account address. */
  explicitTarget?: true;
  /** Exit codes that are answers, not failures (`chat status` exits 1 when idle). */
  okExitCodes?: readonly number[];
  /** How long to let the command run. */
  timeoutMs?: (input: TypedToolInput) => number;
  /** Raised for commands whose JSON is large before it is trimmed. */
  maxOutputBytes?: number;
  /**
   * A picture the command wrote, from its parsed (unshaped) JSON, sent beside
   * the text as an image block. Only files under the project's `.ade/cache`
   * or `.ade/artifacts` are read (`readToolImage`).
   */
  image?: (value: unknown) => string | null;
};

const LANE = { type: "string", description: "Lane id from lanes_list, not its name." };
const PR = { type: "string", description: "PR number, URL or ADE id." };
const SESSION = { type: "string", description: "Chat id (chat_list, inbox)." };
const RELATIVE_PATH = { type: "string", description: "Path in the lane's worktree." };
const LIMIT = (max: number, fallback: number) => ({
  type: "integer", minimum: 1, maximum: max, description: `Default ${fallback}.`,
});

const LARGE_OUTPUT_BYTES = 8 * 1024 * 1024;

const REASONING_EFFORT = { type: "string", description: "e.g. low, medium, high, xhigh." };
const PERMISSION_MODE = {
  type: "string",
  enum: ["full-auto", "bypass", "bypassPermissions", "auto", "edit", "plan", "default", "config-toml"],
};

/** The CLI's word for a permission mode; Claude's own name for its highest is accepted too. */
function permissionWord(value: string): string {
  return value === "bypass" || value === "bypassPermissions" ? "full-auto" : value;
}


const LANE_COMPACT_FIELDS = ["id", "name", "branchRef", "baseRef", "laneType", "archivedAt", "worktreePath"] as const;
const LANE_STATUS_FIELDS = ["dirty", "ahead", "behind", "comparedTo", "remoteBehind", "changedFileCount", "rebaseInProgress"] as const;

function compactLane(lane: Record<string, unknown>): Record<string, unknown> {
  const status = isRecord(lane.status) ? pick(lane.status, LANE_STATUS_FIELDS) : undefined;
  const primaryOffBase = lane.laneType === "primary" && nonEmptyString(lane.branchRef) !== nonEmptyString(lane.baseRef);
  return { ...pick(lane, LANE_COMPACT_FIELDS), ...(status ? { status } : {}), ...(primaryOffBase ? { primaryOffBase: true } : {}) };
}


/**
 * Commands whose output is text a shell or an agent wrote (chat reads,
 * statuses and previews, terminal output, search previews): secrets in it are
 * masked before it leaves through ADE MCP, typed tool or raw `ade` alike.
 */
const AGENT_OUTPUT_COMMANDS: Readonly<Record<string, ReadonlySet<string>>> = {
  chat: new Set(["read", "messages", "transcript", "list", "status", "wait", "inbox", "events"]),
  terminal: new Set(["read", "tail", "scrollback"]),
  files: new Set(["search"]),
};
const COMMAND_SPELLINGS: Readonly<Record<string, string>> = { chats: "chat", terminals: "terminal", file: "files" };

export function printsAgentOutput(argv: readonly string[]): boolean {
  const [command, sub] = argv;
  const canonical = command ? COMMAND_SPELLINGS[command] ?? command : "";
  return Boolean(sub && AGENT_OUTPUT_COMMANDS[canonical]?.has(sub));
}

/**
 * The refusal for a tool that creates something without naming its project,
 * listing the projects so the model can pick in one more call.
 */
export function explicitTargetRefusal(toolName: string, projects: ReadonlyArray<{ displayName: string; projectId: string }>): string {
  const choices = projects.length
    ? `Projects here, last opened first: ${projects.map((project) => `${project.displayName} (${project.projectId})`).join(", ")}. `
      + "Use the one the person named; if they named none, the first."
    : "No project is open on this machine; projects_clone adds one.";
  return `${toolName} needs \`project\`, because the default changes as the person works. ${choices}`;
}

/** A string with something in it, trimmed; null for anything else. */
export function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function text(input: TypedToolInput, key: string): string | null {
  return nonEmptyString(input[key]);
}

function integer(input: TypedToolInput, key: string, fallback: number, max: number): number {
  const value = input[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(1, Math.round(value)));
}

/**
 * A value that will sit where the CLI reads a word. One starting with `-`
 * would be read as a flag, so it is refused rather than passed on.
 */
function word(input: TypedToolInput, key: string): { value: string } | { error: string } {
  const value = text(input, key);
  if (!value) return { error: `Pass \`${key}\`.` };
  if (value.startsWith("-")) return { error: `\`${key}\` cannot start with "-".` };
  return { value };
}

function optionalWord(input: TypedToolInput, key: string): { value: string | null } | { error: string } {
  if (!text(input, key)) return { value: null };
  return word(input, key);
}

/**
 * `--flag=<value>` for free text: in that one word the CLI reads the value
 * verbatim, so text that looks like a flag (`--json`, `--machine x`) stays text.
 */
function freeText(flag: string, value: string): string {
  return `${flag}=${value}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** `{ domain, action, result }` from `ade actions`-style plans, unwrapped. */
function unwrap(value: unknown): unknown {
  return isRecord(value) && "result" in value && (typeof value.domain === "string" || typeof value.action === "string")
    ? value.result
    : value;
}

/**
 * The rows of a CLI list. Most lists print a bare array; some wrap it
 * (`{ lanes }`, `{ prs }`), the same keys the CLI's own text output reads.
 */
function records(value: unknown, wrapperKeys: readonly string[] = []): Record<string, unknown>[] {
  if (isRecord(value)) {
    const wrapped = wrapperKeys.map((key) => value[key]).find(Array.isArray);
    if (wrapped) return records(wrapped);
  }
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord);
}

function pick(record: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (record[key] !== undefined) out[key] = record[key];
  }
  return out;
}

function timestamp(value: unknown): number {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

/** A link that opens the chat in ADE, for the model to hand the person. */
function chatLink(sessionId: string | null, laneId: string | null, context: TypedShapeContext): string | null {
  if (!sessionId) return null;
  return buildDeeplink({
    kind: "session",
    sessionId,
    ...(laneId ? { laneId } : {}),
    ...(context.ownership ? { ownership: context.ownership } : {}),
  });
}

/**
 * An engine's failure line without the local paths it names. The paths ADE
 * knows go whole first (they may hold spaces): the video, its project, the
 * home folder. Any other path-shaped word goes after.
 */
function withoutLocalPaths(text: string, videoPath: string | null): string {
  const projectRoot = videoPath?.match(/^(.*?)[\\/]\.ade[\\/]/)?.[1] ?? null;
  const known: Array<[string | null, string]> = [[videoPath, "<file>"], [projectRoot, "<project>"], [os.homedir(), "~"]];
  let redacted = text;
  for (const [value, label] of known) {
    if (value && value.length > 1) redacted = redacted.split(value).join(label);
  }
  // A path's own trailing colon is the message's ("<path>: Invalid data").
  return redacted.replace(/(?<![\w.~<>])(?:[A-Za-z]:)?[\\/][^\s'"]+/g, (found) => (found.endsWith(":") ? "<file>:" : "<file>"));
}

const PROJECT_FIELDS = ["projectId", "displayName", "rootPath", "lastOpenedAt", "exists", "gitOriginUrl"] as const;
const PR_FIELDS = [
  "id", "laneId", "githubPrNumber", "githubUrl", "title", "state", "baseBranch", "headBranch",
  "checksStatus", "reviewStatus", "mergeConflicts", "behindBaseBy", "createdAt", "updatedAt",
] as const;
const CHAT_FIELDS = [
  "sessionId", "laneId", "title", "provider", "model", "status", "currentTurnStartedAt",
  "lastActivityAt", "archivedAt", "orchestrationParentSessionId", "lastOutputPreview",
  // A tracked CLI session in the list: `kind: "cli"`, its process exit code and
  // parent. Without them a CLI row reads as a chat that never has events.
  "kind", "exitCode", "parentSessionId",
] as const;
const CHAT_WAIT_SUMMARY_FIELDS = [...CHAT_FIELDS, "awaitingInput", "pendingInputItemId"] as const;
/** What a proof review tells a remote model; the local paths stay on the computer. */
const PROOF_REVIEW_FIELDS = [
  "artifactId", "media", "title", "createdAt", "width", "height", "durationSeconds",
  "columns", "frames", "findings", "sheetError", "pages", "page", "yFrom", "yTo", "cropError",
] as const;
const INBOX_FIELDS = [
  "sessionId", "title", "laneId", "lane", "model", "kind", "requestId", "text", "detail", "questions", "since", "link", "signIn",
] as const;
const PR_STATES = ["open", "closed", "merged", "all"] as const;
// `terminal` (the chat closed for good) is left out: models picked it for
// "until it is done" and waited out the clock on a chat that went idle.
const WAIT_TARGETS = ["idle", "active", "awaiting-input"] as const;
const DECISIONS = { approve: "--approve", approve_for_session: "--approve-session", deny: "--deny" } as const;
/** A `decision` chat_respond knows; own keys only, so `toString` or `__proto__` is not one. */
function isDecision(value: unknown): value is keyof typeof DECISIONS {
  return typeof value === "string" && Object.hasOwn(DECISIONS, value);
}
const MAX_WAIT_SECONDS = 300;
/** Under the ~30 s many MCP clients allow one request. */
const DEFAULT_WAIT_SECONDS = 25;
/** How long chat_start waits for the new lane to be set up and the agent to start. */
const START_WAIT_SECONDS = 90;

const WAITS_ON_PERSON = "It waits on the person: see inbox.";

/** Lists the computers of the account; answered by the protocol, not a command. */
export const MACHINES_TOOL_NAME = "machines_list";

/** How long `projects_clone` lets the clone run: git's own five minutes, plus registering the project. */
const CLONE_TIMEOUT_MS = 6 * 60_000;

export const TYPED_TOOLS: readonly TypedTool[] = [
  // result: { projects: [{ projectId, displayName, rootPath, lastOpenedAt, exists, gitOriginUrl }], hiddenMissing }
  {
    name: "projects_list",
    title: "List projects",
    description: "Projects on this machine, last opened first.",
    machineWide: true,
    fanOut: true,
    properties: {
      include_missing: { type: "boolean", description: "Include projects whose folder is gone." },
    },
    build: () => ({ argv: ["projects", "list", "--include-missing", "--json"] }),
    shape: (value, input) => {
      const all = records(value)
        .sort((a, b) => Number(b.lastOpenedAt ?? 0) - Number(a.lastOpenedAt ?? 0))
        .map((project) => pick(project, PROJECT_FIELDS));
      const projects = input.include_missing === true ? all : all.filter((project) => project.exists !== false);
      return { projects, hiddenMissing: all.length - projects.length };
    },
    next: (result) => {
      const hidden = isRecord(result) && typeof result.hiddenMissing === "number" ? result.hiddenMissing : 0;
      return hidden > 0
        ? `${hidden} project${hidden === 1 ? " whose folder is" : "s whose folders are"} gone ${hidden === 1 ? "is" : "are"} hidden (include_missing lists them).`
        : null;
    },
  },
  // result: { projectId, displayName, rootPath, lastOpenedAt, gitOriginUrl }
  {
    name: "projects_clone",
    title: "Clone a repository",
    description: "Clones a GitHub repository here, with this machine's GitHub sign-in, as a new project.",
    machineWide: true,
    write: true,
    properties: {
      repo: { type: "string", description: "GitHub URL or owner/name." },
      path: { type: "string", description: "Parent folder. Default: beside other projects." },
      name: { type: "string", description: "Folder name." },
    },
    required: ["repo"],
    build: (input) => {
      const repo = word(input, "repo");
      if ("error" in repo) return repo;
      const argv = ["projects", "clone", repo.value];
      const folder = text(input, "path");
      if (folder) argv.push(freeText("--path", folder));
      const name = optionalWord(input, "name");
      if ("error" in name) return name;
      if (name.value) argv.push(freeText("--name", name.value));
      return { argv: [...argv, "--json"] };
    },
    timeoutMs: () => CLONE_TIMEOUT_MS,
    shape: (value) => pick(isRecord(unwrap(value)) ? unwrap(value) as Record<string, unknown> : {}, PROJECT_FIELDS),
    next: (result) => {
      const id = isRecord(result) ? nonEmptyString(result.projectId) : null;
      return id ? `Pass project "${id}" to the other tools; chat_start starts an agent in it.` : null;
    },
  },
  // result: the CLI's lane rows (id, name, branchRef, baseRef, status, …)
  {
    name: "lanes_list",
    title: "List lanes",
    description: "The project's lanes (git worktrees): id, branch, status.",
    fanOut: true,
    view: true,
    properties: {
      include_archived: { type: "boolean", description: "Include archived lanes." },
      full: { type: "boolean", description: "Whole lane records." },
    },
    build: (input) => ({
      argv: ["lanes", "list", "--json", "--no-visual", ...(input.include_archived === true ? ["--include-archived"] : [])],
    }),
    shape: (value, input) => (input.full === true ? records(value, ["lanes"]) : records(value, ["lanes"]).map(compactLane)),
  },
  // result: the CLI's new lane (id, name, branchRef, baseRef, worktreePath, …)
  {
    name: "lanes_create",
    title: "Create a lane",
    description: "Creates a lane (a git worktree on a new branch), as `ade lanes create` does.",
    write: true,
    explicitTarget: true,
    properties: {
      name: { type: "string" },
      from: { type: "string", description: "Branch to start from." },
      on: { type: "string", enum: ["local", "remote"] },
      branch_name: { type: "string" },
      existing_branch: { type: "string", description: "Use this branch instead of making one." },
    },
    required: ["name"],
    build: (input) => {
      const name = text(input, "name");
      if (!name) return { error: "Pass `name`." };
      const argv = ["lanes", "create", freeText("--name", name)];
      for (const [key, flag] of [["from", "--from"], ["on", "--on"], ["branch_name", "--branch-name"], ["existing_branch", "--existing-branch"]] as const) {
        const value = optionalWord(input, key);
        if ("error" in value) return value;
        if (value.value) argv.push(freeText(flag, value.value));
      }
      return { argv: [...argv, "--json"] };
    },
    timeoutMs: () => 180_000,
    shape: (value) => {
      const unwrapped = unwrap(value);
      const record = isRecord(unwrapped) && isRecord(unwrapped.lane) ? unwrapped.lane : unwrapped;
      return isRecord(record) ? compactLane(record) : record;
    },
    next: (result) => {
      const id = isRecord(result) ? nonEmptyString(result.id) : null;
      return id ? `Pass lane "${id}" to chat_start to start an agent in it.` : null;
    },
  },
  // result: the CLI's lane detail
  {
    name: "lanes_show",
    title: "Show a lane",
    description: "One lane: branch, base, changes, conflicts, rebase state.",
    properties: { lane: LANE },
    required: ["lane"],
    build: (input) => {
      const lane = word(input, "lane");
      if ("error" in lane) return lane;
      return { argv: ["lanes", "show", lane.value, "--json"] };
    },
  },
  // result: the CLI's file tree
  {
    name: "files_tree",
    title: "List files in a lane",
    description: "Files and folders in a lane, with git status.",
    properties: {
      lane: LANE,
      path: { type: "string", description: "Folder. Default the root." },
      depth: { type: "integer", minimum: 1, maximum: 10, description: "Levels to include." },
    },
    required: ["lane"],
    build: (input) => {
      const lane = word(input, "lane");
      if ("error" in lane) return lane;
      const folder = optionalWord(input, "path");
      if ("error" in folder) return folder;
      const argv = ["files", "tree", "--workspace", lane.value, "--json"];
      if (folder.value) argv.push("--path", folder.value);
      if (typeof input.depth === "number") argv.push("--depth", String(integer(input, "depth", 1, 10)));
      return { argv };
    },
  },
  // result: { path, content, isPartial, … }
  {
    name: "files_read",
    title: "Read a file in a lane",
    description: "Reads a file in a lane. Large files come back in part (isPartial).",
    properties: { lane: LANE, path: RELATIVE_PATH },
    required: ["lane", "path"],
    build: (input) => {
      const lane = word(input, "lane");
      if ("error" in lane) return lane;
      const file = word(input, "path");
      if ("error" in file) return file;
      return { argv: ["files", "read", "--workspace", lane.value, file.value, "--json"] };
    },
  },
  // result: { path, bytes, sha256 }
  {
    name: "files_write",
    title: "Write a file in a lane",
    description: `Writes a file in a lane, up to ${MAX_STDIN_BYTES / 1024} KB per call. Bigger: chunks with offset. Answers bytes and sha256.`,
    write: true,
    properties: {
      lane: LANE,
      path: RELATIVE_PATH,
      text: { type: "string" },
      base64: { type: "boolean", description: "`text` is base64." },
      offset: { type: "integer", minimum: 0, description: "Bytes already written. 0 replaces the file." },
    },
    required: ["lane", "path", "text"],
    build: (input) => {
      const lane = word(input, "lane");
      if ("error" in lane) return lane;
      const file = word(input, "path");
      if ("error" in file) return file;
      if (typeof input.text !== "string") return { error: "Pass `text`." };
      const offset = typeof input.offset === "number" && input.offset > 0 ? ["--offset", String(Math.floor(input.offset))] : [];
      return { argv: ["files", "write", "--workspace", lane.value, file.value, "--stdin", ...(input.base64 === true ? ["--base64"] : []), ...offset, "--json"] };
    },
    stdin: (input) => (typeof input.text === "string" ? input.text : null),
    shape: (value) => {
      const record = unwrap(value);
      return isRecord(record) ? pick(record, ["path", "bytes", "sha256"]) : record;
    },
  },
  // result: the CLI's matches (path, line, column, preview)
  {
    name: "files_search",
    title: "Search files in a lane",
    description: "Searches text in a lane's files: path, line and preview per match.",
    properties: {
      lane: LANE,
      query: { type: "string", description: "Text to find." },
      limit: LIMIT(500, 50),
    },
    required: ["lane", "query"],
    build: (input) => {
      const lane = word(input, "lane");
      if ("error" in lane) return lane;
      const query = word(input, "query");
      if ("error" in query) return query;
      const limit = integer(input, "limit", 50, 500);
      return { argv: ["files", "search", "--workspace", lane.value, "--query", query.value, "--limit", String(limit), "--json"] };
    },
  },
  // result: the CLI's change list
  {
    name: "diff_changes",
    title: "List a lane's changed files",
    description: "A lane's uncommitted files, or with `branch`, only what it committed since its base.",
    view: true,
    properties: {
      lane: LANE,
      branch: { type: "boolean", description: "Only commits since the base." },
    },
    required: ["lane"],
    build: (input) => {
      const lane = word(input, "lane");
      if ("error" in lane) return lane;
      return { argv: ["diff", "changes", "--lane", lane.value, ...(input.branch === true ? ["--mode", "branch"] : []), "--json"] };
    },
  },
  // result: the CLI's patch
  {
    name: "diff_patch",
    title: "Show a file's diff",
    description: "One changed file's patch in a lane. A new (untracked) file has none: use files_read.",
    view: true,
    properties: {
      lane: LANE,
      path: RELATIVE_PATH,
      mode: { type: "string", enum: ["unstaged", "staged"], description: "Default unstaged." },
    },
    required: ["lane", "path"],
    build: (input) => {
      const lane = word(input, "lane");
      if ("error" in lane) return lane;
      const file = word(input, "path");
      if ("error" in file) return file;
      const mode = input.mode === "staged" ? "staged" : "unstaged";
      return { argv: ["diff", "patch", "--lane", lane.value, file.value, "--mode", mode, "--json"] };
    },
  },
  // result: the CLI's git status
  {
    name: "git_status",
    title: "Git status of a lane",
    description: "A lane's branch against its upstream (ahead, behind). `full` adds changes and conflicts.",
    properties: {
      lane: LANE,
      full: { type: "boolean", description: "Add changes, conflicts, rebase state." },
    },
    required: ["lane"],
    build: (input) => {
      const lane = word(input, "lane");
      if ("error" in lane) return lane;
      return { argv: ["git", "status", "--lane", lane.value, ...(input.full === true ? ["--full"] : []), "--json"] };
    },
  },
  // result: [{ id, laneId, githubPrNumber, githubUrl, title, state, baseBranch, headBranch, checksStatus,
  //            reviewStatus, mergeConflicts, behindBaseBy, createdAt, updatedAt }]
  {
    name: "prs_list",
    title: "List pull requests",
    description: "The project's pull requests, newest first, with checks and review state.",
    view: true,
    properties: {
      state: { type: "string", enum: [...PR_STATES], description: "Default open." },
      lane: { ...LANE, description: "Only this lane's." },
      limit: LIMIT(200, 30),
    },
    build: () => ({ argv: ["prs", "list", "--json", "--compact"] }),
    maxOutputBytes: LARGE_OUTPUT_BYTES,
    // The CLI returns every pull request whatever the flags, so filter here.
    shape: (value, input) => {
      const state = PR_STATES.find((candidate) => candidate === input.state) ?? "open";
      const lane = text(input, "lane");
      const limit = integer(input, "limit", 30, 200);
      return records(value, ["prs", "pullRequests"])
        .filter((pr) => state === "all" || String(pr.state ?? "").toLowerCase() === state)
        .filter((pr) => !lane || pr.laneId === lane)
        .sort((a, b) => timestamp(b.updatedAt ?? b.createdAt) - timestamp(a.updatedAt ?? a.createdAt))
        .slice(0, limit)
        .map((pr) => pick(pr, PR_FIELDS));
    },
  },
  // result: the CLI's PR detail
  {
    name: "prs_show",
    title: "Show a pull request",
    description: "One pull request: body, labels, reviewers, linked issues.",
    view: true,
    properties: { pr: PR },
    required: ["pr"],
    build: (input) => {
      const pr = word(input, "pr");
      if ("error" in pr) return pr;
      return { argv: ["prs", "show", pr.value, "--json"] };
    },
  },
  // result: the CLI's checks (each check's status and link, plus counts)
  {
    name: "prs_checks",
    title: "Checks of a pull request",
    description: "A pull request's CI checks: each one's status and link, plus counts.",
    view: true,
    properties: { pr: PR },
    required: ["pr"],
    build: (input) => {
      const pr = word(input, "pr");
      if ("error" in pr) return pr;
      return { argv: ["prs", "checks", pr.value, "--json"] };
    },
  },
  // result: [{ sessionId, laneId, title, provider, model, status, currentTurnStartedAt, lastActivityAt,
  //            archivedAt, orchestrationParentSessionId, lastOutputPreview, link }]
  {
    name: "chat_list",
    title: "List chats",
    description: "Agent chats, most recently active first.",
    fanOut: true,
    view: true,
    properties: {
      lane: { ...LANE, description: "Only this lane's." },
      include_archived: { type: "boolean", description: "Include archived chats." },
      limit: LIMIT(200, 30),
    },
    build: (input) => {
      const lane = optionalWord(input, "lane");
      if ("error" in lane) return lane;
      const argv = ["chat", "list", "--json", "--compact"];
      if (lane.value) argv.push("--lane", lane.value);
      if (input.include_archived === true) argv.push("--include-archived");
      return { argv };
    },
    maxOutputBytes: LARGE_OUTPUT_BYTES,
    shape: (value, input, context) => records(value, ["sessions", "chats"])
      .sort((a, b) => timestamp(b.lastActivityAt) - timestamp(a.lastActivityAt))
      .slice(0, integer(input, "limit", 30, 200))
      .map((chat) => ({ ...pick(chat, CHAT_FIELDS), link: chatLink(nonEmptyString(chat.sessionId), nonEmptyString(chat.laneId), context) })),
  },
  // result: the CLI's transcript read (messages, newest last)
  {
    name: "chat_read",
    title: "Read a chat",
    description: "A chat's latest messages.",
    view: true,
    properties: {
      session: SESSION,
      limit: LIMIT(100, 20),
      max_chars: { type: "integer", minimum: 500, maximum: 50000, description: "Default 8000." },
    },
    required: ["session"],
    build: (input) => {
      const session = word(input, "session");
      if ("error" in session) return session;
      return {
        argv: [
          "chat", "read", session.value,
          "--limit", String(integer(input, "limit", 20, 100)),
          "--max-chars", String(Math.max(500, integer(input, "max_chars", 8000, 50_000))),
          "--json",
        ],
      };
    },
  },
  // result: the CLI's turn status ({ sessionId, phase: running|waiting|blocked|idle, currentTool, ask, subagents, … })
  {
    name: "chat_status",
    title: "Chat status",
    description: "Whether a chat is running, idle or blocked, what it is doing now, and its model, effort, permissions and account.",
    properties: { session: SESSION },
    required: ["session"],
    build: (input) => {
      const session = word(input, "session");
      if ("error" in session) return session;
      return { argv: ["chat", "status", session.value, "--json"] };
    },
    // The CLI exits 1 for idle and 2 for blocked, for scripts; both are answers here.
    okExitCodes: [0, 1, 2],
    shape: (value, _input, context) => {
      if (!isRecord(value) || !nonEmptyString(value.sessionId)) return value;
      return { ...value, link: chatLink(nonEmptyString(value.sessionId), nonEmptyString(value.laneId), context) };
    },
    next: (result) => {
      const phase = isRecord(result) ? nonEmptyString(result.phase) : null;
      if (phase === "blocked") return WAITS_ON_PERSON;
      if (phase === "running" || phase === "waiting") return "Still working. chat_wait returns when it is done.";
      return null;
    },
  },
  // result: { ok, sessionId, waitFor, elapsedMs, error?: "timed_out"|"waiting_on_user"|"session_not_found",
  //           summary?: { …chat_list fields, awaitingInput, pendingInputItemId } }
  {
    name: "chat_wait",
    title: "Wait for a chat",
    description: `Waits until a chat reaches a state (default idle). Answers within ${DEFAULT_WAIT_SECONDS} s by default, so a client's request limit can't cut it off; call again to keep waiting.`,
    properties: {
      session: SESSION,
      for: { type: "string", enum: [...WAIT_TARGETS], description: "Default idle: its turn is done." },
      timeout_seconds: { type: "integer", minimum: 5, maximum: MAX_WAIT_SECONDS, description: `Default ${DEFAULT_WAIT_SECONDS}.` },
    },
    required: ["session"],
    build: (input) => {
      const session = word(input, "session");
      if ("error" in session) return session;
      const target = WAIT_TARGETS.find((candidate) => candidate === input.for) ?? "idle";
      const seconds = Math.max(5, integer(input, "timeout_seconds", DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS));
      return { argv: ["chat", "wait", session.value, "--for", target, "--timeout-ms", String(seconds * 1000), "--json"] };
    },
    // Exit 1 is a wait that ended without the state (timed out, waits on the
    // person, no such chat yet): an answer with a next step, not a failure.
    okExitCodes: [0, 1],
    shape: (value, _input, context) => {
      if (!isRecord(value)) return value;
      const { summary, ...rest } = value;
      if (!isRecord(summary)) return rest;
      return { ...rest, summary: pick(summary, CHAT_WAIT_SUMMARY_FIELDS), link: chatLink(nonEmptyString(rest.sessionId), nonEmptyString(summary.laneId), context) };
    },
    next: (result, input) => {
      if (!isRecord(result)) return null;
      if (result.ok === true) return (input.for ?? "idle") === "idle" ? "Done. chat_read shows what it did; proof_review, a video or picture it made." : null;
      if (result.error === "waiting_on_user") return WAITS_ON_PERSON;
      if (result.error === "session_not_found") {
        return "No such chat yet. A chat from chat_start appears once its lane is set up: wait again in a minute. Otherwise check the id with chat_list.";
      }
      return "Not there yet. Call chat_wait again to keep waiting.";
    },
    // Room for the CLI to answer after its own wait ends.
    timeoutMs: (input) => (Math.max(5, integer(input, "timeout_seconds", DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS)) + 30) * 1000,
  },
  // result: { sessionId, cursor, phase, truncated,
  //           events: [{ sequence, at, kind: turn_started|turn_completed|turn_failed|turn_interrupted|input_needed|input_resolved|error, turnId?, message? }] }
  {
    name: "chat_events",
    title: "What happened in a chat",
    description: "Turn starts and ends, input needed and errors since `since`, at once. Pass the returned `cursor` as `since` next time.",
    properties: {
      session: SESSION,
      since: { type: "integer", minimum: 0, description: "The last `cursor`." },
      limit: LIMIT(200, 50),
    },
    required: ["session"],
    build: (input) => {
      const session = word(input, "session");
      if ("error" in session) return session;
      const since = typeof input.since === "number" && input.since >= 0 ? ["--since", String(Math.floor(input.since))] : [];
      return { argv: ["chat", "events", session.value, ...since, "--limit", String(integer(input, "limit", 50, 200)), "--json"] };
    },
    okExitCodes: [0, 1],
  },
  // result: { artifactId, media: "video"|"image", title, createdAt, width, height, durationSeconds,
  //           columns, frames: [{ t, why: "start"|"end"|"step"|"change"|"even", step }], findings,
  //           sheetError?, otherProof?: [{ id, kind, title, createdAt }], link }
  // The sheet (or the picture) rides beside the text as an image block: `image`.
  {
    name: "proof_review",
    title: "Look at a chat's proof",
    description: "A proof video's key moments as one image (the ends, each step's outcome, the biggest changes), "
      + "with each frame's time and why; a picture as itself. from/to (seconds) look closer.",
    properties: {
      session: { type: "string", description: "Chat id: its newest video, else its newest proof." },
      proof: { type: "string", description: "One proof id (otherProof) instead." },
      from: { type: "number", minimum: 0 },
      to: { type: "number", minimum: 0 },
      page: { type: "integer", minimum: 1, description: "A tall picture's page; the result says how many." },
      y_from: { type: "integer", minimum: 0, description: "A band of the picture, in pixels." },
      y_to: { type: "integer", minimum: 1 },
    },
    build: (input) => {
      const proof = optionalWord(input, "proof");
      if ("error" in proof) return proof;
      const session = optionalWord(input, "session");
      if ("error" in session) return session;
      if (!proof.value && !session.value) return { error: "Pass `session` (a chat id) or `proof`." };
      const seconds = (key: "from" | "to") => {
        const value = input[key];
        return typeof value === "number" && Number.isFinite(value) && value >= 0 ? [`--${key}`, String(value)] : [];
      };
      const whole = (key: "y_from" | "y_to", flag: string) => {
        const value = input[key];
        return typeof value === "number" && Number.isInteger(value) && value >= 0 ? [flag, String(value)] : [];
      };
      const band = [...whole("y_from", "--y-from"), ...whole("y_to", "--y-to")];
      // A tall picture comes a page at a time unless a band was asked for.
      const page = band.length ? [] : ["--page", String(integer(input, "page", 1, 10_000))];
      return {
        argv: [
          "proof", "review",
          ...(proof.value ? [proof.value] : ["--chat", session.value!]),
          ...seconds("from"), ...seconds("to"), ...page, ...band,
          "--json",
        ],
      };
    },
    shape: (value, _input, context) => {
      const record = unwrap(value);
      if (!isRecord(record)) return record;
      const sessionId = nonEmptyString(record.chatSessionId);
      const sheetError = nonEmptyString(record.sheetError);
      return {
        ...pick(record, PROOF_REVIEW_FIELDS),
        ...(sheetError ? { sheetError: withoutLocalPaths(sheetError, nonEmptyString(record.path)) } : {}),
        ...(Array.isArray(record.otherProof) && record.otherProof.length ? { otherProof: record.otherProof } : {}),
        link: chatLink(sessionId, nonEmptyString(record.laneId), context),
      };
    },
    next: (result) => {
      if (!isRecord(result)) return null;
      const watch = typeof result.link === "string" ? ` The person watches it in ADE: ${result.link}` : "";
      if (result.media !== "video") {
        const page = typeof result.page === "number" ? result.page : null;
        const pages = typeof result.pages === "number" ? result.pages : null;
        const more = page && pages && page < pages ? `This is page ${page} of ${pages}: page ${page + 1} shows the next part. ` : "";
        return `${more}To change it, chat_send the chat that made it.${watch}`;
      }
      if (typeof result.sheetError === "string") return `No frame sheet: ${result.sheetError}.${watch}`;
      return `Frames read left to right, ${String(result.columns)} a row (result.frames). To change the video, `
        + `chat_send its chat naming moments by time ("cut 0:12–0:18"), then chat_wait and look again. `
        + `For a closer look, proof_review with from/to.${watch}`;
    },
    image: (value) => {
      const record = unwrap(value);
      if (!isRecord(record)) return null;
      return nonEmptyString(record.media === "video" ? record.sheetPath : record.cropPath ?? record.path);
    },
    // Measuring the video decodes all of it once before the sheet is made.
    timeoutMs: () => 180_000,
  },
  // result: the CLI's usage report ({ accounts: [{ provider, accountId, windows: [{ percentLeft, resetsAt, … }] }], notes })
  {
    name: "usage_limits",
    title: "Usage limits",
    description: "Subscription usage left on this machine, per account: percent left per window (5-hour, weekly, "
      + "monthly), reset time, whether the pace lasts, and the account id to start a chat on.",
    machineWide: true,
    fanOut: true,
    view: true,
    properties: {
      provider: {
        type: "string",
        enum: ["claude", "codex", "cursor", "copilot", "grok", "opencode", "kimi", "muse"],
        description: "Only this provider.",
      },
    },
    build: (input) => {
      const provider = optionalWord(input, "provider");
      if ("error" in provider) return provider;
      return { argv: ["usage", "limits", ...(provider.value ? ["--provider", provider.value] : []), "--json"] };
    },
  },
  // result: { items: [{ sessionId, title, laneId, lane, model, kind: "question"|"approval"|"plan"|"ask",
  //           requestId: string|null, text, detail?, questions?: [{ id, question, header?, options?: [{ label,
  //           description?, recommended? }], multiSelect?, optionsOnly?, secret? }], since, link }] }
  {
    name: "inbox",
    title: "What waits on you",
    description: "Questions and approvals chats wait on the person for, with their options. Every recent project unless `project` is given.",
    fanOut: true,
    view: true,
    properties: {},
    build: () => ({ argv: ["chat", "inbox", "--json"] }),
    shape: (value) => ({ items: records(value, ["items"]).map((item) => pick(item, INBOX_FIELDS)) }),
    // Each item names its project, so chat_respond can pass it back.
    everyProject: {
      merge: (parts) => ({
        items: parts.flatMap(({ project, result }) =>
          records(result, ["items"]).map((item) => ({ ...item, project }))),
      }),
    },
    next: (result, input) => {
      const items = isRecord(result) && Array.isArray(result.items) ? result.items.filter(isRecord) : [];
      if (items.length === 0) return text(input, "project") ? "Nothing waits on the person in this project." : "Nothing waits on the person.";
      const asks = items.some((item) => item.kind === "ask");
      const signIns = items.filter((item) => isRecord(item.signIn));
      const signInNote = signIns.length
        ? ` A \`signIn\` item is the person's to answer in ADE (open its link); never ask them for the password here.`
        : "";
      if (signIns.length === items.length) return `Waiting on the person to sign in, in ADE.${signInNote}`;
      return signInNote.trim() + (signInNote ? " " : "") + "Answer with chat_respond (session, request_id, and the item's project when it has one)"
        + (asks ? "; an `ask` has no request: answer it with chat_send" : "")
        + ". Approve or deny as the person says.";
    },
  },
  // result: { sessionId, requestId, decision: "accept"|"accept_for_session"|"decline"|"cancel", kind?, title?, link }
  {
    name: "chat_respond",
    title: "Answer a chat",
    description: "Answers a chat's question or approval.",
    view: true,
    write: true,
    properties: {
      session: SESSION,
      request_id: { type: "string", description: "From inbox. Optional when the chat waits on one." },
      option: { type: "string", description: "Option number or label." },
      answers: {
        type: "object",
        description: "For several questions: question number (from 1) or id → option or text.",
      },
      text: { type: "string", description: "A free answer, a note on the option, or why you deny." },
      decision: { type: "string", enum: Object.keys(DECISIONS), description: "For an approval or plan." },
    },
    required: ["session"],
    build: (input) => {
      const session = word(input, "session");
      if ("error" in session) return session;
      const request = optionalWord(input, "request_id");
      if ("error" in request) return request;
      const argv = ["chat", "respond", session.value];
      if (request.value) argv.push(freeText("--item", request.value));
      const option = input.option;
      if (typeof option === "number" || (typeof option === "string" && option.trim())) {
        argv.push(freeText("--option", String(option).trim()));
      }
      if (isRecord(input.answers)) {
        for (const [question, answer] of Object.entries(input.answers)) {
          for (const value of Array.isArray(answer) ? answer : [answer]) {
            if (typeof value === "string" || typeof value === "number") argv.push(freeText("--answer", `${question}=${value}`));
          }
        }
      }
      const reply = text(input, "text");
      if (reply) argv.push(freeText("--text", reply));
      const decision = isDecision(input.decision) ? DECISIONS[input.decision] : undefined;
      if (input.decision !== undefined && !decision) return { error: `\`decision\` is one of ${Object.keys(DECISIONS).join(", ")}.` };
      if (decision) argv.push(decision);
      if (argv.length === 3 + (request.value ? 1 : 0)) {
        return { error: "Pass `option`, `answers`, `text` or `decision` (inbox shows what the chat asks)." };
      }
      return { argv: [...argv, "--json"] };
    },
    shape: (value, input, context) => {
      const unwrapped = unwrap(value);
      const record = isRecord(unwrapped) ? unwrapped : {};
      const sessionId = nonEmptyString(record.sessionId) ?? text(input, "session");
      return {
        sessionId,
        requestId: nonEmptyString(record.itemId),
        decision: nonEmptyString(record.decision),
        ...(nonEmptyString(record.kind) ? { kind: nonEmptyString(record.kind) } : {}),
        ...(nonEmptyString(record.title) ? { title: nonEmptyString(record.title) } : {}),
        link: chatLink(sessionId, null, context),
      };
    },
    next: (result) => {
      const record = isRecord(result) ? result : {};
      const verb = record.decision === "decline" || record.decision === "cancel"
        ? "Denied"
        : record.decision === "accept_for_session"
          ? "Approved for the rest of the chat"
          : record.kind === "approval" || record.kind === "permissions" || record.kind === "plan_approval" ? "Approved" : "Answered";
      const title = nonEmptyString(record.title)?.replace(/[.?!:]+$/, "");
      return `${verb}${title ? `: ${title}` : ""}. The chat goes on; chat_wait returns when it is done.`;
    },
  },
  // result: { sessionId, delivery: "sent"|"delivered"|"queued", routedAction: "sendMessage"|"steer"|"interrupt-replace", link }
  {
    name: "chat_send",
    title: "Message a chat",
    description: "Sends a message to a chat. Mid-turn, it steers the turn.",
    view: true,
    write: true,
    properties: {
      session: SESSION,
      text: { type: "string", description: "The message." },
    },
    required: ["session", "text"],
    build: (input) => {
      const session = word(input, "session");
      if ("error" in session) return session;
      const message = text(input, "text");
      if (!message) return { error: "Pass `text`." };
      return { argv: ["chat", "send", session.value, freeText("--text", message), "--json"] };
    },
    shape: (value, input, context) => {
      const unwrapped = unwrap(value);
      const record = isRecord(unwrapped) ? unwrapped : {};
      const sessionId = nonEmptyString(record.sessionId) ?? text(input, "session");
      return {
        sessionId,
        delivery: nonEmptyString(record.delivery),
        routedAction: nonEmptyString(record.routedAction),
        link: chatLink(sessionId, nonEmptyString(record.laneId), context),
      };
    },
    next: () => "Sent. chat_wait returns when the chat is done.",
  },
  // result: the CLI's stop answer
  {
    name: "chat_interrupt",
    title: "Stop a chat",
    description: "Stops a chat's current turn. Its messages stay.",
    write: true,
    properties: {
      session: SESSION,
      mode: {
        type: "string",
        enum: ["stop_only", "stop_and_clear", "stop_and_background", "stop_and_clear_and_background", "stop_and_clear_and_children", "stop_everything_and_children"],
        description: "Default stop_and_clear.",
      },
    },
    required: ["session"],
    build: (input) => {
      const session = word(input, "session");
      if ("error" in session) return session;
      const mode = optionalWord(input, "mode");
      if ("error" in mode) return mode;
      return { argv: ["chat", "interrupt", session.value, ...(mode.value ? [freeText("--mode", mode.value)] : []), "--json"] };
    },
  },
  // result: the CLI's updated chat
  {
    name: "chat_update",
    title: "Change a chat's settings",
    description: "Changes a chat's model, effort, permissions or title in place; its id stays.",
    write: true,
    properties: {
      session: SESSION,
      model: { type: "string", description: "Full model id, not a short name." },
      reasoning_effort: REASONING_EFFORT,
      permission_mode: PERMISSION_MODE,
      fast: { type: "boolean" },
      title: { type: "string" },
    },
    required: ["session"],
    build: (input) => {
      const session = word(input, "session");
      if ("error" in session) return session;
      const argv = ["chat", "update", session.value];
      for (const [key, flag] of [["model", "--model"], ["reasoning_effort", "--reasoning-effort"]] as const) {
        const value = optionalWord(input, key);
        if ("error" in value) return value;
        if (value.value) argv.push(freeText(flag, value.value));
      }
      const permission = optionalWord(input, "permission_mode");
      if ("error" in permission) return permission;
      if (permission.value) argv.push(freeText("--permissions", permissionWord(permission.value)));
      if (typeof input.fast === "boolean") argv.push(input.fast ? "--fast" : "--no-fast");
      const title = text(input, "title");
      if (title) argv.push(freeText("--title", title));
      if (argv.length === 3) return { error: "Pass what to change: `model`, `reasoning_effort`, `permission_mode`, `fast` or `title`." };
      return { argv: [...argv, "--json"] };
    },
  },
  // result: { sessionId, laneId, lane, title, phase: "running"|"setting_up"|"failed"|"cancelled", error?, link,
  //           model?, modelId?, reasoningEffort?, permissionMode?, claudePermissionMode?, fastMode?, instanceId?, notify? }
  //   `phase` is the chat's, not the launch's: "running" means the agent started and works on the prompt.
  {
    name: "chat_start",
    title: "Start a chat",
    description: "Starts an agent chat on a new lane (or `lane`). Permissions default to full-auto (bypass); the answer gives its real settings.",
    view: true,
    write: true,
    explicitTarget: true,
    properties: {
      prompt: { type: "string", description: "What the agent should do." },
      provider: { type: "string", description: "e.g. claude, codex. Default: the person's last-used model." },
      model: { type: "string", description: "Full model id (claude-opus-5-5), not a short name. Default: last-used." },
      reasoning_effort: REASONING_EFFORT,
      permission_mode: PERMISSION_MODE,
      fast: { type: "boolean" },
      instance: { type: "string", description: "Provider account id (usage_limits)." },
      lane: LANE,
      lane_name: { type: "string", description: "Name for a new lane." },
      base: { type: "string", description: "Branch a new lane starts from." },
      title: { type: "string" },
      notify_url: { type: "string", description: "https URL to POST to when the chat goes idle, needs input or fails." },
      notify_token: { type: "string", description: "Sent to notify_url as a bearer token." },
      dry_run: { type: "boolean", description: "Show the launch; start nothing." },
    },
    required: ["prompt"],
    // Neither given: start on what the person last used, as a new chat in ADE does.
    launchDefaults: (input, defaults) => (text(input, "provider") || text(input, "model")
      ? input
      : {
        ...input,
        provider: defaults.provider,
        model: defaults.model,
        ...(defaults.reasoningEffort && !text(input, "reasoning_effort") ? { reasoning_effort: defaults.reasoningEffort } : {}),
      }),
    build: (input) => {
      const prompt = text(input, "prompt");
      if (!prompt) return { error: "Pass `prompt`." };
      const lane = optionalWord(input, "lane");
      if ("error" in lane) return lane;
      if (lane.value && (text(input, "lane_name") || text(input, "base"))) {
        return { error: "`lane` runs in an existing lane; `lane_name` and `base` are for a new one." };
      }
      const argv = lane.value
        ? ["chat", "create", "--lane", lane.value, freeText("--prompt", prompt)]
        : ["chat", "launch", freeText("--prompt", prompt)];
      // Words go where the CLI reads a word; names, titles and keys are free text.
      const wordFlags = [
        ["provider", "--provider"], ["model", "--model"], ["reasoning_effort", "--reasoning-effort"], ["instance", "--instance"],
        ["base", "--from"], ["notify_url", "--notify-url"],
      ] as const;
      for (const [key, flag] of wordFlags) {
        const value = optionalWord(input, key);
        if ("error" in value) return value;
        if (value.value) argv.push(freeText(flag, value.value));
      }
      for (const [key, flag] of [["lane_name", "--lane-name"], ["title", "--title"]] as const) {
        const value = text(input, key);
        if (value) argv.push(freeText(flag, value));
      }
      // On stdin, so the key is never in a process list.
      if (text(input, "notify_token")) argv.push("--notify-token-stdin");
      argv.push(freeText("--permissions", permissionWord(text(input, "permission_mode") ?? "full-auto")));
      if (typeof input.fast === "boolean") argv.push(input.fast ? "--fast" : "--no-fast");
      if (input.dry_run === true) return { argv: [...argv, "--print-config", "--json"] };
      return { argv: lane.value ? [...argv, "--json"] : [...argv, "--wait", "--timeout-ms", String(START_WAIT_SECONDS * 1000), "--json"] };
    },
    stdin: (input) => text(input, "notify_token"),
    // `--wait` exits 1 when the launch failed or is still setting up; the JSON says which.
    okExitCodes: [0, 1],
    timeoutMs: () => (START_WAIT_SECONDS + 30) * 1000,
    shape: (value, input, context) => {
      if (input.dry_run === true) return { dryRun: true, launch: value };
      const record = isRecord(value) ? value : {};
      const launch = isRecord(record.launch) ? record.launch : record;
      const session = isRecord(record.session) ? record.session : {};
      const sessionId = nonEmptyString(launch.sessionId) ?? nonEmptyString(session.id) ?? nonEmptyString(session.sessionId) ?? nonEmptyString(record.launchId);
      const laneId = nonEmptyString(launch.laneId) ?? nonEmptyString(session.laneId);
      const error = nonEmptyString(launch.error) ?? (record.ok === false && record.error !== "timed_out" ? nonEmptyString(record.error) : null);
      // `chat create` has no launch to report on: the chat exists, and its prompt went.
      const phase = isRecord(record.launch) || nonEmptyString(record.phase)
        ? chatPhaseOfLaunch(nonEmptyString(record.phase) ?? nonEmptyString(launch.phase))
        : sessionId ? "running" : null;
      return {
        sessionId,
        laneId,
        lane: nonEmptyString(launch.laneName),
        title: nonEmptyString(launch.title) ?? nonEmptyString(session.title),
        phase,
        ...(error ? { error } : {}),
        ...pick(session, CHAT_SETTING_FIELDS),
        ...(isRecord(record.notify) ? { notify: record.notify } : {}),
        link: chatLink(sessionId, laneId, context),
      };
    },
    next: (result) => {
      const record = isRecord(result) ? result : {};
      if (record.dryRun === true) return "Nothing started. Call again without dry_run to start it.";
      if (record.phase === "running") return "The agent is working on it. chat_wait returns when it is done; give the person the link.";
      if (record.phase === "failed" || record.phase === "cancelled") return null;
      return "ADE is still setting up its lane; the agent starts after. Call chat_wait in a minute.";
    },
  },
];

/**
 * A launch's phase as the chat's state. The launch "completes" when the agent
 * has started, which is when the chat starts running: reported as
 * "completed", apps read the chat as finished while it was still working.
 */
function chatPhaseOfLaunch(phase: string | null): string | null {
  if (phase === "completed") return "running";
  if (phase === "running" || phase === "awaiting-client") return "setting_up";
  return phase;
}

export function findTypedTool(name: unknown): TypedTool | null {
  return TYPED_TOOLS.find((tool) => tool.name === name) ?? null;
}

/** The tools whose results the ADE MCP app draws: those marked `view`, and machines_list. */
export const TOOLS_WITH_VIEWS: ReadonlySet<string> = new Set([
  ...TYPED_TOOLS.filter((tool) => tool.view).map((tool) => tool.name),
  MACHINES_TOOL_NAME,
]);

// ── Results ────────────────────────────────────────────────────────────────

/** A command's output as a model reads it: stdout, stderr, and why it stopped. */
export function toolText(result: RemoteRunResult, outputLimitBytes = MAX_OUTPUT_BYTES): string {
  const parts: string[] = [];
  const stdout = result.stdout.trimEnd();
  const stderr = result.stderr.trimEnd();
  if (stdout) parts.push(stdout);
  if (stderr) parts.push(stdout ? `stderr:\n${stderr}` : stderr);
  if (result.truncated) {
    parts.push(`[Output was cut off at ${Math.round(outputLimitBytes / 1024)} KB. Narrow the command, e.g. with --text, filters or --limit.]`);
  }
  if (result.timedOut) parts.push(`[Stopped: the command ran past its time limit after ${Math.round(result.durationMs / 1000)}s.]`);
  else if (result.exitCode !== 0) parts.push(`[exit code ${result.exitCode ?? "unknown"}]`);
  return parts.join("\n\n") || "(no output)";
}

/** A typed tool's run, parsed (`raw`) and shaped (`value`); null when it failed or its output is not whole JSON. */
export function parseTypedRun(
  tool: TypedTool,
  input: TypedToolInput,
  run: RemoteRunResult,
  context: TypedShapeContext,
): { value: unknown; raw: unknown } | null {
  const answered = !run.timedOut && !run.truncated && (tool.okExitCodes ?? [0]).includes(run.exitCode ?? -1);
  if (!answered) return null;
  try {
    const parsed: unknown = JSON.parse(run.stdout);
    const shaped = tool.shape ? tool.shape(parsed, input, context) : parsed;
    const built = tool.build(input);
    return { value: "argv" in built && printsAgentOutput(built.argv) ? redactOutgoingChatText(shaped) : shaped, raw: parsed };
  } catch {
    return null;
  }
}

type TypedResultFrame = {
  /** The first text line: which project (or projects) the result is from. */
  headLine: string;
  /** `structuredContent.project`; null when the result spans projects or none is open. */
  project: Record<string, unknown> | null;
  /** Where the result came from, for its links. */
  context: TypedShapeContext;
};

/** A typed tool's answer from its shaped result: the next step, the text, and `structuredContent`. */
export function shapedToolResult(
  tool: TypedTool,
  input: TypedToolInput,
  value: unknown,
  frame: Pick<TypedResultFrame, "headLine" | "project">,
): RemoteMcpToolResult {
  // The next step rides in the result, where the model decides it.
  const next = tool.next?.(value, input) ?? null;
  return {
    content: [{ type: "text", text: `${frame.headLine}\n${JSON.stringify(value)}${next ? `\nNext: ${next}` : ""}` }],
    structuredContent: { view: tool.name, project: frame.project, result: value, ...(next ? { next } : {}) },
    isError: false,
  };
}

/**
 * A typed tool's answer from one run: the shaped result, or the command's own
 * output when it failed. `raw` is the parsed output (null on failure), which
 * names the picture `withToolImage` attaches.
 */
export function buildTypedToolResult(
  tool: TypedTool,
  input: TypedToolInput,
  run: RemoteRunResult,
  frame: TypedResultFrame,
): { answer: RemoteMcpToolResult; raw: unknown } {
  const parsed = parseTypedRun(tool, input, run, frame.context);
  if (!parsed) {
    const built = tool.build(input);
    const shown = "argv" in built && printsAgentOutput(built.argv)
      ? { ...run, stdout: redactOutgoingChatText(run.stdout), stderr: redactOutgoingChatText(run.stderr) }
      : run;
    return {
      answer: { content: [{ type: "text", text: `${frame.headLine}\n${toolText(shown, tool.maxOutputBytes)}` }], isError: true },
      raw: null,
    };
  }
  return { answer: shapedToolResult(tool, input, parsed.value, frame), raw: parsed.raw };
}

/**
 * Under this, a picture fits the relay's 4 MB answer once base64 grows it by a
 * third, with room for the text beside it. A proof sheet is far smaller.
 */
const MAX_TOOL_IMAGE_BYTES = 2_500_000;

const IMAGE_MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/**
 * A picture a command wrote, as an MCP image block, or a sentence saying why
 * it is not sent. Only an image file under the project's `.ade/cache` or
 * `.ade/artifacts` is read, after links are resolved: the path comes from the
 * command's output, and this must never become a way to read any file.
 */
export async function readToolImage(
  filePath: string,
  projectRoot: string,
): Promise<{ type: "image"; data: string; mimeType: string } | { error: string }> {
  let real: string;
  let root: string;
  try {
    real = await fs.promises.realpath(filePath);
    root = await fs.promises.realpath(projectRoot);
  } catch {
    return { error: "The picture is no longer on this machine." };
  }
  const allowed = [path.join(root, ".ade", "cache"), path.join(root, ".ade", "artifacts")];
  if (!allowed.some((dir) => pathIsWithinRoot(dir, real))) return { error: "The picture is outside the project's proof folders." };
  // The type comes from the file read, not from a link's name.
  const mimeType = IMAGE_MIME_TYPES[path.extname(real).toLowerCase()];
  if (!mimeType) return { error: "The file is not a picture ADE MCP sends." };
  const stat = await fs.promises.stat(real).catch(() => null);
  if (!stat?.isFile()) return { error: "The picture is no longer on this machine." };
  if (stat.size > MAX_TOOL_IMAGE_BYTES) {
    return { error: `The picture is ${(stat.size / 1_000_000).toFixed(1)} MB, more than ADE MCP sends (${MAX_TOOL_IMAGE_BYTES / 1_000_000} MB).` };
  }
  return { type: "image", data: (await fs.promises.readFile(real)).toString("base64"), mimeType };
}

/** A typed tool's answer with the picture it names (`TypedTool.image`) added, or a line saying why not. */
export async function withToolImage(
  tool: TypedTool,
  raw: unknown,
  answer: RemoteMcpToolResult,
  projectRoot: string,
): Promise<RemoteMcpToolResult> {
  if (!tool.image || answer.isError) return answer;
  const imagePath = tool.image(raw);
  if (!imagePath) return answer;
  const image = await readToolImage(imagePath, projectRoot);
  if ("error" in image) {
    return { ...answer, content: [...answer.content, { type: "text", text: `No picture attached: ${image.error}` }] };
  }
  return { ...answer, content: [...answer.content, image] };
}
