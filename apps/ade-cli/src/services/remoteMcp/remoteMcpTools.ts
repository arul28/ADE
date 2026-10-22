/**
 * ADE MCP's typed tools: the everyday reads, with named inputs a client can
 * check before calling. Each one only builds the words of an `ade` command;
 * the service runs it through the same policy check and runner as the `ade`
 * tool, so a typed tool can never do more than the connection's scope allows.
 *
 * Every tool asks the CLI for JSON and returns it as structured content,
 * trimmed to what a model needs (the CLI's own lists can run past a megabyte).
 */

export type TypedToolInput = Record<string, unknown>;

export type TypedToolBuild = { argv: string[] } | { error: string };

export type TypedTool = {
  name: string;
  title: string;
  description: string;
  /** JSON Schema of the inputs, without the shared `project`. */
  properties: Record<string, unknown>;
  required?: string[];
  build: (input: TypedToolInput) => TypedToolBuild;
  /** Reshapes the CLI's parsed JSON; the result is wrapped as `{ result }`. */
  shape?: (value: unknown, input: TypedToolInput) => unknown;
  /** Exit codes that are answers, not failures (`chat status` exits 1 when idle). */
  okExitCodes?: readonly number[];
  /** How long to let the command run. */
  timeoutMs?: (input: TypedToolInput) => number;
  /** Raised for commands whose JSON is large before it is trimmed. */
  maxOutputBytes?: number;
};

const LANE = {
  type: "string",
  description: "Lane id, from lanes_list.",
};
const PR = {
  type: "string",
  description: "Pull request: ADE id, number, #number, URL, or gh:owner/repo#number.",
};
const SESSION = {
  type: "string",
  description: "Chat session id, from chat_list.",
};
const RELATIVE_PATH = {
  type: "string",
  description: "Path relative to the lane's worktree root.",
};

const LARGE_OUTPUT_BYTES = 8 * 1024 * 1024;

function text(input: TypedToolInput, key: string): string | null {
  const value = input[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
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

function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object");
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

const PROJECT_FIELDS = ["projectId", "displayName", "rootPath", "lastOpenedAt", "exists", "gitOriginUrl"] as const;
const PR_FIELDS = [
  "id", "laneId", "githubPrNumber", "githubUrl", "title", "state", "baseBranch", "headBranch",
  "checksStatus", "reviewStatus", "mergeConflicts", "behindBaseBy", "createdAt", "updatedAt",
] as const;
const CHAT_FIELDS = [
  "sessionId", "laneId", "title", "provider", "model", "status", "currentTurnStartedAt",
  "lastActivityAt", "archivedAt", "orchestrationParentSessionId", "lastOutputPreview",
] as const;
const PR_STATES = ["open", "closed", "merged", "all"] as const;
const WAIT_TARGETS = ["idle", "active", "awaiting-input", "terminal"] as const;
const MAX_WAIT_SECONDS = 300;

export const TYPED_TOOLS: readonly TypedTool[] = [
  {
    name: "projects_list",
    title: "List projects",
    description: "Lists the projects on this computer, most recently opened first. Pass a project's name, id or path "
      + "as `project` to the other tools.",
    properties: {},
    build: () => ({ argv: ["projects", "list", "--json"] }),
    shape: (value) => records(value)
      .sort((a, b) => Number(b.lastOpenedAt ?? 0) - Number(a.lastOpenedAt ?? 0))
      .map((project) => pick(project, PROJECT_FIELDS)),
  },
  {
    name: "lanes_list",
    title: "List lanes",
    description: "Lists the project's lanes (git worktrees) with branch and status. Lane ids from here are the "
      + "`lane` input of the other tools.",
    properties: {
      include_archived: { type: "boolean", description: "Also list archived lanes." },
    },
    build: (input) => ({
      argv: ["lanes", "list", "--json", "--no-visual", ...(input.include_archived === true ? ["--include-archived"] : [])],
    }),
    shape: (value) => {
      const lanes = value && typeof value === "object" ? (value as { lanes?: unknown }).lanes : value;
      return records(lanes);
    },
  },
  {
    name: "lanes_show",
    title: "Show a lane",
    description: "One lane: branch, base, changes, conflicts and rebase state.",
    properties: { lane: LANE },
    required: ["lane"],
    build: (input) => {
      const lane = word(input, "lane");
      if ("error" in lane) return lane;
      return { argv: ["lanes", "show", lane.value, "--json"] };
    },
  },
  {
    name: "files_tree",
    title: "List files in a lane",
    description: "Lists files and folders in a lane's worktree, with their git change status.",
    properties: {
      lane: LANE,
      path: { ...RELATIVE_PATH, description: "Folder to list, relative to the worktree root. Defaults to the root." },
      depth: { type: "integer", minimum: 1, maximum: 10, description: "How many folder levels to include." },
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
  {
    name: "files_read",
    title: "Read a file in a lane",
    description: "Reads one file from a lane's worktree. Large files come back in part (`isPartial`).",
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
  {
    name: "files_search",
    title: "Search files in a lane",
    description: "Searches the text of a lane's files. Returns path, line, column and a preview for each match.",
    properties: {
      lane: LANE,
      query: { type: "string", description: "Text to find." },
      limit: { type: "integer", minimum: 1, maximum: 500, description: "Most matches to return. Default 50." },
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
  {
    name: "diff_changes",
    title: "List a lane's changed files",
    description: "Lists a lane's staged and unstaged changes, or with `branch`, everything changed since its base.",
    properties: {
      lane: LANE,
      branch: { type: "boolean", description: "Compare the whole branch with its base instead of the working tree." },
    },
    required: ["lane"],
    build: (input) => {
      const lane = word(input, "lane");
      if ("error" in lane) return lane;
      return { argv: ["diff", "changes", "--lane", lane.value, ...(input.branch === true ? ["--mode", "branch"] : []), "--json"] };
    },
  },
  {
    name: "diff_patch",
    title: "Show a file's diff",
    description: "The patch of one changed file in a lane. An untracked (new) file has no patch yet; read it with files_read.",
    properties: {
      lane: LANE,
      path: RELATIVE_PATH,
      mode: { type: "string", enum: ["unstaged", "staged"], description: "Which changes. Default unstaged." },
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
  {
    name: "git_status",
    title: "Git status of a lane",
    description: "Upstream state of a lane's branch (ahead, behind, diverged). With `full`, also changes and conflicts.",
    properties: {
      lane: LANE,
      full: { type: "boolean", description: "Include changes, conflicts and rebase state." },
    },
    required: ["lane"],
    build: (input) => {
      const lane = word(input, "lane");
      if ("error" in lane) return lane;
      return { argv: ["git", "status", "--lane", lane.value, ...(input.full === true ? ["--full"] : []), "--json"] };
    },
  },
  {
    name: "prs_list",
    title: "List pull requests",
    description: "Lists the project's pull requests, newest first, with checks and review state.",
    properties: {
      state: { type: "string", enum: [...PR_STATES], description: "Filter by state. Default open." },
      lane: { ...LANE, description: "Only the pull requests of this lane." },
      limit: { type: "integer", minimum: 1, maximum: 200, description: "Most to return. Default 30." },
    },
    build: () => ({ argv: ["prs", "list", "--json", "--compact"] }),
    maxOutputBytes: LARGE_OUTPUT_BYTES,
    // The CLI returns every pull request whatever the flags, so filter here.
    shape: (value, input) => {
      const state = PR_STATES.find((candidate) => candidate === input.state) ?? "open";
      const lane = text(input, "lane");
      const limit = integer(input, "limit", 30, 200);
      return records(value)
        .filter((pr) => state === "all" || String(pr.state ?? "").toLowerCase() === state)
        .filter((pr) => !lane || pr.laneId === lane)
        .sort((a, b) => timestamp(b.updatedAt ?? b.createdAt) - timestamp(a.updatedAt ?? a.createdAt))
        .slice(0, limit)
        .map((pr) => pick(pr, PR_FIELDS));
    },
  },
  {
    name: "prs_show",
    title: "Show a pull request",
    description: "One pull request's body, labels, reviewers and linked issues. Checks are in prs_checks.",
    properties: { pr: PR },
    required: ["pr"],
    build: (input) => {
      const pr = word(input, "pr");
      if ("error" in pr) return pr;
      return { argv: ["prs", "show", pr.value, "--json"] };
    },
  },
  {
    name: "prs_checks",
    title: "Checks of a pull request",
    description: "A pull request's CI checks: each one's status and link, plus counts.",
    properties: { pr: PR },
    required: ["pr"],
    build: (input) => {
      const pr = word(input, "pr");
      if ("error" in pr) return pr;
      return { argv: ["prs", "checks", pr.value, "--json"] };
    },
  },
  {
    name: "chat_list",
    title: "List chats",
    description: "Lists agent chats, most recently active first.",
    properties: {
      lane: { ...LANE, description: "Only chats in this lane." },
      include_archived: { type: "boolean", description: "Also list archived chats." },
      limit: { type: "integer", minimum: 1, maximum: 200, description: "Most to return. Default 30." },
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
    shape: (value, input) => records(value)
      .sort((a, b) => timestamp(b.lastActivityAt) - timestamp(a.lastActivityAt))
      .slice(0, integer(input, "limit", 30, 200))
      .map((chat) => pick(chat, CHAT_FIELDS)),
  },
  {
    name: "chat_read",
    title: "Read a chat",
    description: "The latest messages of a chat's transcript.",
    properties: {
      session: SESSION,
      limit: { type: "integer", minimum: 1, maximum: 100, description: "Most messages. Default 20." },
      max_chars: { type: "integer", minimum: 500, maximum: 50000, description: "Character budget. Default 8000." },
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
  {
    name: "chat_status",
    title: "Chat status",
    description: "Whether a chat is running, idle or blocked on a question, and what it is doing.",
    properties: { session: SESSION },
    required: ["session"],
    build: (input) => {
      const session = word(input, "session");
      if ("error" in session) return session;
      return { argv: ["chat", "status", session.value, "--json"] };
    },
    // The CLI exits 1 for idle and 2 for blocked, for scripts; both are answers here.
    okExitCodes: [0, 1, 2],
  },
  {
    name: "chat_wait",
    title: "Wait for a chat",
    description: `Waits until a chat reaches a state (default idle), up to ${MAX_WAIT_SECONDS} seconds, then returns `
      + "its summary. Call again to keep waiting.",
    properties: {
      session: SESSION,
      for: { type: "string", enum: [...WAIT_TARGETS], description: "The state to wait for. Default idle." },
      timeout_seconds: {
        type: "integer",
        minimum: 5,
        maximum: MAX_WAIT_SECONDS,
        description: "How long to wait. Default 120.",
      },
    },
    required: ["session"],
    build: (input) => {
      const session = word(input, "session");
      if ("error" in session) return session;
      const target = WAIT_TARGETS.find((candidate) => candidate === input.for) ?? "idle";
      const seconds = Math.max(5, integer(input, "timeout_seconds", 120, MAX_WAIT_SECONDS));
      return { argv: ["chat", "wait", session.value, "--for", target, "--timeout-ms", String(seconds * 1000), "--json"] };
    },
    // Room for the CLI to answer after its own wait ends.
    timeoutMs: (input) => (Math.max(5, integer(input, "timeout_seconds", 120, MAX_WAIT_SECONDS)) + 30) * 1000,
  },
];

export function findTypedTool(name: unknown): TypedTool | null {
  return TYPED_TOOLS.find((tool) => tool.name === name) ?? null;
}
