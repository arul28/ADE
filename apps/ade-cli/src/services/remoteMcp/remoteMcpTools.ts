import { buildDeeplink } from "../../../../desktop/src/shared/deeplinks";
import type { RemoteMcpToolResult } from "./remoteMcpForward";
import { MAX_OUTPUT_BYTES, type RemoteRunResult } from "./remoteMcpRunner";

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
  shape?: (value: unknown, input: TypedToolInput) => unknown;
  /** The next step for the model, from the shaped result; null when there is none to give. */
  next?: (result: unknown, input: TypedToolInput) => string | null;
  /** Fills inputs the call left out from the model the person last launched a chat with. */
  launchDefaults?: (input: TypedToolInput, defaults: { provider: string; model: string }) => TypedToolInput;
  /** Exit codes that are answers, not failures (`chat status` exits 1 when idle). */
  okExitCodes?: readonly number[];
  /** How long to let the command run. */
  timeoutMs?: (input: TypedToolInput) => number;
  /** Raised for commands whose JSON is large before it is trimmed. */
  maxOutputBytes?: number;
};

const LANE = { type: "string", description: "Lane id from lanes_list, not its name." };
const PR = { type: "string", description: "PR number, URL or ADE id." };
const SESSION = { type: "string", description: "Chat id (chat_list, inbox)." };
const RELATIVE_PATH = { type: "string", description: "Path in the lane's worktree." };
const LIMIT = (max: number, fallback: number) => ({
  type: "integer", minimum: 1, maximum: max, description: `Default ${fallback}.`,
});

const LARGE_OUTPUT_BYTES = 8 * 1024 * 1024;

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
function chatLink(sessionId: string | null, laneId: string | null): string | null {
  if (!sessionId) return null;
  return buildDeeplink({ kind: "session", sessionId, ...(laneId ? { laneId } : {}) });
}

const PROJECT_FIELDS = ["projectId", "displayName", "rootPath", "lastOpenedAt", "exists", "gitOriginUrl"] as const;
const PR_FIELDS = [
  "id", "laneId", "githubPrNumber", "githubUrl", "title", "state", "baseBranch", "headBranch",
  "checksStatus", "reviewStatus", "mergeConflicts", "behindBaseBy", "createdAt", "updatedAt",
] as const;
const CHAT_FIELDS = [
  "sessionId", "laneId", "title", "provider", "model", "status", "currentTurnStartedAt",
  "lastActivityAt", "archivedAt", "orchestrationParentSessionId", "lastOutputPreview",
] as const;
const CHAT_WAIT_SUMMARY_FIELDS = [...CHAT_FIELDS, "awaitingInput", "pendingInputItemId"] as const;
const INBOX_FIELDS = [
  "sessionId", "title", "laneId", "lane", "model", "kind", "requestId", "text", "detail", "questions", "since", "link",
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
    description: "Projects on this computer, last opened first.",
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
    description: "Clones a GitHub repository here, with this computer's GitHub sign-in, as a new project.",
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
    },
    build: (input) => ({
      argv: ["lanes", "list", "--json", "--no-visual", ...(input.include_archived === true ? ["--include-archived"] : [])],
    }),
    shape: (value) => records(value, ["lanes"]),
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
    shape: (value, input) => records(value, ["sessions", "chats"])
      .sort((a, b) => timestamp(b.lastActivityAt) - timestamp(a.lastActivityAt))
      .slice(0, integer(input, "limit", 30, 200))
      .map((chat) => ({ ...pick(chat, CHAT_FIELDS), link: chatLink(nonEmptyString(chat.sessionId), nonEmptyString(chat.laneId)) })),
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
    description: "Whether a chat is running, idle or blocked, and what it is doing now.",
    properties: { session: SESSION },
    required: ["session"],
    build: (input) => {
      const session = word(input, "session");
      if ("error" in session) return session;
      return { argv: ["chat", "status", session.value, "--json"] };
    },
    // The CLI exits 1 for idle and 2 for blocked, for scripts; both are answers here.
    okExitCodes: [0, 1, 2],
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
    description: `Waits until a chat reaches a state (default idle), up to ${MAX_WAIT_SECONDS} s. Use it instead of polling.`,
    properties: {
      session: SESSION,
      for: { type: "string", enum: [...WAIT_TARGETS], description: "Default idle: its turn is done." },
      timeout_seconds: { type: "integer", minimum: 5, maximum: MAX_WAIT_SECONDS, description: "Default 120." },
    },
    required: ["session"],
    build: (input) => {
      const session = word(input, "session");
      if ("error" in session) return session;
      const target = WAIT_TARGETS.find((candidate) => candidate === input.for) ?? "idle";
      const seconds = Math.max(5, integer(input, "timeout_seconds", 120, MAX_WAIT_SECONDS));
      return { argv: ["chat", "wait", session.value, "--for", target, "--timeout-ms", String(seconds * 1000), "--json"] };
    },
    // Exit 1 is a wait that ended without the state (timed out, waits on the
    // person, no such chat yet): an answer with a next step, not a failure.
    okExitCodes: [0, 1],
    shape: (value) => {
      if (!isRecord(value)) return value;
      const { summary, ...rest } = value;
      return isRecord(summary) ? { ...rest, summary: pick(summary, CHAT_WAIT_SUMMARY_FIELDS) } : rest;
    },
    next: (result, input) => {
      if (!isRecord(result)) return null;
      if (result.ok === true) return (input.for ?? "idle") === "idle" ? "Done. chat_read shows what it did." : null;
      if (result.error === "waiting_on_user") return WAITS_ON_PERSON;
      if (result.error === "session_not_found") {
        return "No such chat yet. A chat from chat_start appears once its lane is set up: wait again in a minute. Otherwise check the id with chat_list.";
      }
      return "Not there yet. Call chat_wait again to keep waiting.";
    },
    // Room for the CLI to answer after its own wait ends.
    timeoutMs: (input) => (Math.max(5, integer(input, "timeout_seconds", 120, MAX_WAIT_SECONDS)) + 30) * 1000,
  },
  // result: the CLI's usage report ({ accounts: [{ provider, accountId, windows: [{ percentLeft, resetsAt, … }] }], notes })
  {
    name: "usage_limits",
    title: "Usage limits",
    description: "Subscription usage left on this computer, per account: percent left per window (5-hour, weekly, "
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
      return "Answer with chat_respond (session, request_id, and the item's project when it has one)"
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
    shape: (value, input) => {
      const unwrapped = unwrap(value);
      const record = isRecord(unwrapped) ? unwrapped : {};
      const sessionId = nonEmptyString(record.sessionId) ?? text(input, "session");
      return {
        sessionId,
        requestId: nonEmptyString(record.itemId),
        decision: nonEmptyString(record.decision),
        ...(nonEmptyString(record.kind) ? { kind: nonEmptyString(record.kind) } : {}),
        ...(nonEmptyString(record.title) ? { title: nonEmptyString(record.title) } : {}),
        link: chatLink(sessionId, null),
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
    shape: (value, input) => {
      const unwrapped = unwrap(value);
      const record = isRecord(unwrapped) ? unwrapped : {};
      const sessionId = nonEmptyString(record.sessionId) ?? text(input, "session");
      return {
        sessionId,
        delivery: nonEmptyString(record.delivery),
        routedAction: nonEmptyString(record.routedAction),
        link: chatLink(sessionId, null),
      };
    },
    next: () => "Sent. chat_wait returns when the chat is done.",
  },
  // result: { sessionId, laneId, lane, title, phase: "running"|"setting_up"|"failed"|"cancelled", error?, link }
  //   `phase` is the chat's, not the launch's: "running" means the agent started and works on the prompt.
  {
    name: "chat_start",
    title: "Start a chat",
    description: "Starts an agent chat on a new lane with a prompt.",
    view: true,
    write: true,
    properties: {
      prompt: { type: "string", description: "What the agent should do." },
      provider: { type: "string", description: "e.g. claude, codex. Default: the person's last-used model." },
      model: { type: "string", description: "Model id. Default: the person's last-used model." },
      base: { type: "string", description: "Branch to start from. Default the project's base." },
    },
    required: ["prompt"],
    // Neither given: start on what the person last used, as a new chat in ADE does.
    launchDefaults: (input, defaults) => (text(input, "provider") || text(input, "model")
      ? input
      : { ...input, provider: defaults.provider, model: defaults.model }),
    build: (input) => {
      const prompt = text(input, "prompt");
      if (!prompt) return { error: "Pass `prompt`." };
      const argv = ["chat", "launch", freeText("--prompt", prompt)];
      for (const [key, flag] of [["provider", "--provider"], ["model", "--model"], ["base", "--base"]] as const) {
        const value = optionalWord(input, key);
        if ("error" in value) return value;
        if (value.value) argv.push(freeText(flag, value.value));
      }
      return { argv: [...argv, "--wait", "--timeout-ms", String(START_WAIT_SECONDS * 1000), "--json"] };
    },
    // `--wait` exits 1 when the launch failed or is still setting up; the JSON says which.
    okExitCodes: [0, 1],
    timeoutMs: () => (START_WAIT_SECONDS + 30) * 1000,
    shape: (value) => {
      const record = isRecord(value) ? value : {};
      const launch = isRecord(record.launch) ? record.launch : record;
      const sessionId = nonEmptyString(launch.sessionId) ?? nonEmptyString(record.launchId);
      const laneId = nonEmptyString(launch.laneId);
      const error = nonEmptyString(launch.error) ?? (record.ok === false && record.error !== "timed_out" ? nonEmptyString(record.error) : null);
      return {
        sessionId,
        laneId,
        lane: nonEmptyString(launch.laneName),
        title: nonEmptyString(launch.title),
        phase: chatPhaseOfLaunch(nonEmptyString(record.phase) ?? nonEmptyString(launch.phase)),
        ...(error ? { error } : {}),
        link: chatLink(sessionId, laneId),
      };
    },
    next: (result) => {
      const record = isRecord(result) ? result : {};
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

/** A typed tool's run, parsed and shaped; null when it failed or its output is not whole JSON. */
export function parseTypedRun(tool: TypedTool, input: TypedToolInput, run: RemoteRunResult): { value: unknown } | null {
  const answered = !run.timedOut && !run.truncated && (tool.okExitCodes ?? [0]).includes(run.exitCode ?? -1);
  if (!answered) return null;
  try {
    const parsed: unknown = JSON.parse(run.stdout);
    return { value: tool.shape ? tool.shape(parsed, input) : parsed };
  } catch {
    return null;
  }
}

type TypedResultFrame = {
  /** The first text line: which project (or projects) the result is from. */
  headLine: string;
  /** `structuredContent.project`; null when the result spans projects or none is open. */
  project: Record<string, unknown> | null;
};

/** A typed tool's answer from its shaped result: the next step, the text, and `structuredContent`. */
export function shapedToolResult(
  tool: TypedTool,
  input: TypedToolInput,
  value: unknown,
  frame: TypedResultFrame,
): RemoteMcpToolResult {
  // The next step rides in the result, where the model decides it.
  const next = tool.next?.(value, input) ?? null;
  return {
    content: [{ type: "text", text: `${frame.headLine}\n${JSON.stringify(value)}${next ? `\nNext: ${next}` : ""}` }],
    structuredContent: { view: tool.name, project: frame.project, result: value, ...(next ? { next } : {}) },
    isError: false,
  };
}

/** A typed tool's answer from one run: the shaped result, or the command's own output when it failed. */
export function buildTypedToolResult(
  tool: TypedTool,
  input: TypedToolInput,
  run: RemoteRunResult,
  frame: TypedResultFrame,
): RemoteMcpToolResult {
  const parsed = parseTypedRun(tool, input, run);
  if (!parsed) {
    return { content: [{ type: "text", text: `${frame.headLine}\n${toolText(run, tool.maxOutputBytes)}` }], isError: true };
  }
  return shapedToolResult(tool, input, parsed.value, frame);
}
