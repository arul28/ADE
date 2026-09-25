import { hasNonEmptyRecord } from "../../../shared/agentObservationNormalizers";
import type { AcpToolKind, AgentChatEvent } from "../../../shared/types/chat";
import type { SessionActivityValue } from "../../../shared/types/sessions";

/**
 * Detects what a live chat turn is doing from the tool calls it makes, so the
 * Work row reads "Testing" because tests are running, not because the agent
 * remembered to say so.
 *
 * Every provider's stream is already normalized into `tool_call`, `command`,
 * `file_change` and `subagent_started` events before it reaches here, so one
 * classifier serves Claude, Codex, OpenCode, Cursor, Droid, Pi and the ACP
 * providers alike. ACP tools also carry the protocol's own `toolKind`
 * (read / edit / execute / ...), which is used when the name says nothing.
 *
 * The rules were fitted against real transcripts, and each exists because of
 * a failure seen there:
 *
 *   - Reading never moves a turn out of a real activity. Agents read between
 *     every edit; only a long unbroken run of reads means the turn has gone
 *     back to exploring.
 *   - Test runners, review/test subagents, delegated implementation and watch
 *     loops are STRONG: one call is enough, because nothing else looks like
 *     them. Edits, typechecks, one-off `gh pr checks` and git commands are
 *     WEAK: they need a second hit, so a single `git push` after a test run
 *     does not flash "Shipping".
 *   - An edit shortly after a test run is part of a fix-and-rerun loop, which
 *     stays "Testing" instead of flickering between the two every few seconds.
 *   - Tool calls made inside a subagent (`parentItemId`) are ignored: the
 *     subagent's own start already says what the parent is waiting on, and a
 *     reviewer's reads must not turn the row into "Exploring".
 *
 * Debugging is never detected. Tool calls cannot tell it from testing; an
 * agent that knows it is debugging can still say so (see
 * `nextDetectedActivityReport`).
 */

type SignalStrength = "strong" | "weak";

type SessionActivitySignal =
  | { kind: "read" }
  | { kind: "activity"; activity: SessionActivityValue; strength: SignalStrength };

const READ: SessionActivitySignal = { kind: "read" };
const strong = (activity: SessionActivityValue): SessionActivitySignal => ({ kind: "activity", activity, strength: "strong" });
const weak = (activity: SessionActivityValue): SessionActivitySignal => ({ kind: "activity", activity, strength: "weak" });

const EDIT_TOOLS = new Set([
  "edit", "write", "multiedit", "str_replace", "str_replace_editor", "str_replace_based_edit_tool",
  "apply_patch", "patch", "delete", "delete_file", "notebookedit", "search_replace", "create_file",
  "edit_file", "write_file", "create", "move", "rename",
]);
const READ_TOOLS = new Set([
  "read", "grep", "glob", "ls", "list", "find", "read_file", "list_dir", "list_directory", "view",
  "codebase_search", "search", "file_search", "grep_search", "webfetch", "web_fetch", "fetch",
  "websearch", "web_search", "readlints", "read_lints", "lsp", "todowrite", "todoread", "updatetodos",
  // Plan-list upkeep happens throughout a turn (Codex ticks off steps with it),
  // so it says nothing about which activity the turn is in.
  "update_plan",
]);
const SHELL_TOOLS = new Set([
  "bash", "shell", "terminal", "run_terminal_cmd", "exec_command", "execute", "run_shell_command",
  "run_command", "command", "local_shell", "powershell",
]);
const PLAN_TOOLS = new Set(["exitplanmode", "enterplanmode", "create_plan"]);
const MONITOR_TOOLS = new Set(["schedulewakeup", "monitor", "croncreate"]);
const SUBAGENT_TOOLS = new Set(["agent", "task", "spawn_agent", "subagent"]);
const SKILL_TOOLS = new Set(["skill"]);

// Shell patterns match at COMMAND POSITION only — the start of one segment of
// the command line (see `commandSegments`). Matching anywhere read
// `rg availableModels` as the `ava` runner and `cat vitest.config.ts` as a test
// run, and one strong false hit relabels the row.
/** An executable named by path or with a Windows extension: `./node_modules/.bin/vitest`, `npm.cmd`. */
const bin = (names: string) => `(?:\\S*[\\\\/])?(?:${names})(?:\\.cmd|\\.exe)?`;
const TEST_RUNNER = new RegExp(
  `^(?:${bin("vitest|jest|pytest|mocha|ava|rspec|phpunit")}|make\\s+test`
    + "|node\\b.*\\s--test\\b|playwright\\s+test|go\\s+test|cargo\\s+(?:test|nextest)|swift\\s+test"
    + "|deno\\s+test|bun\\s+test|dotnet\\s+test|(?:\\S*/)?mvnw?\\b.*\\btest\\b"
    + "|(?:\\S*[\\\\/])?gradlew?(?:\\.bat)?\\b.*\\btest\\b|xcodebuild\\b.*\\btest\\b"
    + `|${bin("npm|pnpm|yarn|bun")}\\s+(?:run\\s+)?test(?::\\S*)?)(?:\\s|$)`,
);
const STATIC_CHECK = new RegExp(
  "^(?:tsc|eslint|ruff|mypy|biome\\s+(?:check|lint)|cargo\\s+(?:check|clippy|build)|swift\\s+build"
    + `|xcodebuild|${bin("npm|pnpm|yarn|bun")}\\s+(?:run\\s+)?(?:typecheck|type-check|lint|build|check)(?::\\S*)?)(?:\\s|$)`,
);
const SHIP = new RegExp(
  "^(?:git\\s+(?:commit|push|rebase|cherry-pick|merge(?![-\\w]))|gh\\s+pr\\s+(?:create|merge|ready)"
    + "|ADE\\s+(?:prs\\s+(?:create|land|merge)|(?:lanes|git)\\s+(?:commit|push)))(?:\\s|$)",
);
const CHECK_STATUS = /^gh\s+(?:pr\s+checks|run\s+(?:view|list)|pr\s+view\b.*(?:checks|statusCheckRollup|mergeStateStatus))/;
const WATCH_SEGMENT = /^(?:gh\s+(?:pr\s+checks\b.*--watch|run\s+watch)|ADE\s+chat\s+wait|watch\s+-n)\b/;
const DRIVE_APP = /^(?:ADE\s+(?:app-control|browser|mac-desktop|apple|ios-sim|proof)|agent-browser)\b/;
const REVIEW_READ = /^gh\s+(?:pr\s+diff|api\s+\S*(?:comments|reviews))/;
/** The agent reporting its own status (`ade chat activity|note|ask`). */
const ADE_STATUS_COMMAND = /^ADE\s+chat\s+(?:activity|note|ask)\b/;

/** Prefixes that run the real command after them: `sudo -E`, `npx --yes`, `FOO=1`, `python -m`. */
const COMMAND_PREFIX = new RegExp(
  "^(?:\\w+=\\S*\\s+|(?:sudo|time|exec|env|command|nohup|(?:npx|bunx|pnpx|uvx)(?:\\.cmd|\\.exe)?|npm\\s+exec|pnpm\\s+(?:exec|dlx)"
    + "|yarn\\s+dlx|uv\\s+run|poetry\\s+run|python3?\\s+-m)(?:\\s+-\\S+)*\\s+)+",
);
/** A package manager naming a runner directly: `pnpm vitest`, `yarn jest`. */
const RUNNER_VIA_PACKAGE_MANAGER = /^(?:pnpm|yarn|bun)\s+(?=(?:vitest|jest|mocha|playwright)\b)/;
/**
 * Shells that wrap the real command line: `/bin/zsh -lc '…'` (Codex does this
 * for every command), `"C:\Program Files\Git\bin\bash.exe" -lc '…'`,
 * `powershell.exe -NoProfile -Command "…"`, `cmd /c …`.
 */
const SHELL_WRAPPERS: RegExp[] = [
  /^(?:"[^"]*[\\/])?(?:\S*[\\/])?(?:ba|z|da)?sh(?:\.exe)?"?\s+-\w*c\s+(['"])([\s\S]*)\1\s*$/i,
  /^(?:\S*[\\/])?(?:powershell|pwsh)(?:\.exe)?\s+(?:-\w+\s+)*-c(?:ommand)?\s+(['"]?)([\s\S]*)\1\s*$/i,
  /^(?:\S*[\\/])?cmd(?:\.exe)?\s+\/c\s+()([\s\S]*)$/i,
];
/** A heredoc body is data, not commands: `cat <<'EOF' … EOF`. */
const HEREDOC_BODY = /<<-?\s*(['"]?)(\w+)\1[\s\S]*?\n\2\b/g;
/** The ADE CLI named through its environment variable, in any shell's spelling. */
const ADE_CLI_VARIABLE = /"\$(?:\{ADE_CLI_PATH\}|ADE_CLI_PATH|env:ADE_CLI_PATH)"|\$(?:\{ADE_CLI_PATH\}|ADE_CLI_PATH\b|env:ADE_CLI_PATH\b)/g;
/** A quoted executable at command position keeps its name: `"C:\Program Files\nodejs\npm.cmd" test`. */
const QUOTED_COMMAND = /(^|&&|\|\||[;|&(\n{])(\s*)"(?:[^"\n]*[\\/])?([^"\\/\s]+)"/g;
/** A quoted span is an argument (a commit message, an `echo`), never a command. */
const QUOTED_SPAN = /'[^']*'|"(?:[^"\\]|\\.)*"/g;
/** The ADE CLI named by path at command position: `ade`, `/usr/local/bin/ade`, `C:\tools\ade.exe`. */
const ADE_CLI_PATH_SPELLING = /^(?:\S*[\\/])?ade(?:\.exe|\.cmd)?(?=\s|$)/i;

function unwrapShell(command: string): string {
  let text = command.trim();
  // Two passes cover one wrapper inside another (`cmd /c powershell -Command …`).
  for (let pass = 0; pass < 2; pass += 1) {
    const inner = SHELL_WRAPPERS.map((wrapper) => text.match(wrapper)?.[2]).find((match) => match != null);
    if (inner == null) break;
    text = inner.trim();
  }
  return text;
}

/**
 * A polling loop anywhere in the line: `until …; do … sleep`, or PowerShell's
 * `while … Start-Sleep`. A linear scan, not one regex: two greedy wildcards
 * across a multi-kilobyte heredoc backtrack for seconds on the main process.
 */
function isWatchLoop(text: string): boolean {
  const loop = text.search(/\b(?:until|while)\b/);
  if (loop < 0) return false;
  const rest = text.slice(loop);
  if (/\bStart-Sleep\b/i.test(rest)) return true;
  const body = rest.search(/\bdo\b/);
  if (body < 0) return false;
  const loopBody = rest.slice(body);
  const end = loopBody.search(/\bdone\b/);
  return /\bsleep\b/.test(end < 0 ? loopBody : loopBody.slice(0, end));
}

/** The command line with its data (heredoc bodies, quoted arguments) blanked out. */
function commandCode(text: string): string {
  return text
    .replace(HEREDOC_BODY, "")
    .replace(ADE_CLI_VARIABLE, "ADE")
    .replace(QUOTED_COMMAND, "$1$2$3")
    .replace(QUOTED_SPAN, "Q");
}

/** The command code split into the commands it runs, each starting at its command name. */
function commandSegments(code: string): string[] {
  return code
    .split(/(?:&&|\|\||[;|&()\n{}])/)
    .map((segment) => segment
      .trim()
      .replace(COMMAND_PREFIX, "")
      .replace(RUNNER_VIA_PACKAGE_MANAGER, "")
      .replace(ADE_CLI_PATH_SPELLING, "ADE"))
    .filter((segment) => segment.length > 0);
}

/**
 * How much of a command line is classified. The command that runs is at the
 * front; the tail of a long line is heredoc or argument data. The cap also
 * bounds the scans below — an unterminated heredoc or quote in a 250 KB line
 * cost seconds on the main process.
 */
const MAX_CLASSIFIED_COMMAND_CHARS = 4_000;

/** Classify one shell command line. Unknown commands read as reading. */
function classifyShellCommand(command: string): SessionActivitySignal {
  // Unwrapped before the cap, so a long wrapped line keeps its closing quote.
  const code = commandCode(unwrapShell(command).slice(0, MAX_CLASSIFIED_COMMAND_CHARS));
  // The agent reporting its own status is not evidence; the commands chained
  // after it (`ade chat note …; npm test`) still are.
  const segments = commandSegments(code).filter((segment) => !ADE_STATUS_COMMAND.test(segment));
  const any = (pattern: RegExp) => segments.some((segment) => pattern.test(segment));
  // Shipping first: `git commit -m "fix jest flake"` is a commit, not a test run.
  if (any(SHIP)) return weak("shipping");
  if (any(TEST_RUNNER)) return strong("testing");
  if (isWatchLoop(code) || any(WATCH_SEGMENT)) return strong("monitoring");
  if (any(CHECK_STATUS)) return weak("monitoring");
  if (any(STATIC_CHECK) || any(DRIVE_APP)) return weak("testing");
  if (any(REVIEW_READ)) return weak("reviewing");
  return READ;
}

/** Classify a subagent or skill by what it was asked to do. */
function classifyDelegation(text: string): SessionActivitySignal {
  const lower = text.toLowerCase();
  if (/\b(review|audit|critique|verif|validat|double-check|second opinion|correctness|parity)/.test(lower)) return strong("reviewing");
  if (/\btest/.test(lower)) return strong("testing");
  if (/\b(implement|fix|apply|build|writ|refactor|migrat|port|add|creat|updat|chang)/.test(lower)) return strong("implementing");
  if (/\b(plan|design|spec)/.test(lower)) return strong("planning");
  if (/\b(ship|merg|release|deploy|land)/.test(lower)) return weak("shipping");
  return READ;
}

/**
 * A subagent's short description names the job; when it does not ("Track A
 * correctness"), the opening of its prompt usually does ("You are Track A of
 * the dual-review"). A prompt is long and wordy, so a match there is only a
 * weak signal: "Find where X is created" must not read as implementing.
 */
function classifyDelegationParts(description: string, prompt: string, agentType = ""): SessionActivitySignal {
  const type = agentType.trim().toLowerCase();
  if (type === "explore") return READ;
  if (type === "plan") return strong("planning");
  const fromDescription = classifyDelegation(description);
  if (fromDescription.kind === "activity" || !prompt) return fromDescription;
  const fromPrompt = classifyDelegation(prompt.slice(0, 240));
  return fromPrompt.kind === "activity" ? weak(fromPrompt.activity) : fromPrompt;
}

function stringField(record: unknown, keys: string[]): string {
  if (!record || typeof record !== "object") return "";
  const values = record as Record<string, unknown>;
  for (const key of keys) {
    const value = values[key];
    if (typeof value === "string" && value.trim()) return value;
    if (Array.isArray(value) && value.every((part) => typeof part === "string")) return value.join(" ");
  }
  return "";
}

function normalizeToolName(tool: string): string {
  // MCP tools arrive as `mcp__server__tool`; the bare tool name is what matters.
  const bare = tool.includes("__") ? tool.slice(tool.lastIndexOf("__") + 2) : tool;
  return bare.trim().toLowerCase();
}

/**
 * ACP's `ToolKind`, for tools whose name says nothing. Only the kinds the ACP
 * translator emits as `tool_call` arrive here: execute tools become `command`
 * events and edit/delete/move become `file_change`, both classified above.
 */
function classifyAcpToolKind(kind: AcpToolKind | undefined): SessionActivitySignal | null {
  switch (kind) {
    case "think":
    case "switch_mode":
      return weak("planning");
    case "read":
    case "search":
    case "fetch":
      return READ;
    default:
      return null;
  }
}

/**
 * The signal one normalized chat event carries, or null for events that say
 * nothing about the turn's activity (text, reasoning, results, and a tool call
 * whose arguments have not arrived yet — its later re-emit is classified).
 */
function classifySessionActivityEvent(event: AgentChatEvent): SessionActivitySignal | null {
  switch (event.type) {
    case "command":
      // Codex streams output deltas under the placeholder text "command"
      // before the real command line is known; that frame says nothing.
      if (event.command.trim() === "command") return null;
      return classifyShellCommand(event.command);
    case "file_change":
      return weak("implementing");
    case "web_search":
      return READ;
    case "subagent_started":
      if (event.taskType && event.taskType !== "subagent") return null;
      return classifyDelegationParts(`${event.description ?? ""} ${event.label ?? ""}`, "", event.agentType);
    case "tool_call": {
      if (event.parentItemId) return null;
      const name = normalizeToolName(event.tool);
      const args = event.args;
      if (EDIT_TOOLS.has(name)) return weak("implementing");
      if (READ_TOOLS.has(name)) return READ;
      if (PLAN_TOOLS.has(name)) return strong("planning");
      if (MONITOR_TOOLS.has(name)) return strong("monitoring");
      if (SHELL_TOOLS.has(name)) {
        if (!hasNonEmptyRecord(args)) return null;
        return classifyShellCommand(stringField(args, ["command", "cmd", "script", "shellCommand", "fullCommand", "input"]));
      }
      if (SUBAGENT_TOOLS.has(name)) {
        if (!hasNonEmptyRecord(args)) return null;
        return classifyDelegationParts(
          stringField(args, ["description"]),
          stringField(args, ["prompt", "task", "message"]),
          stringField(args, ["subagent_type", "agent_type"]),
        );
      }
      if (SKILL_TOOLS.has(name)) {
        if (!hasNonEmptyRecord(args)) return null;
        return classifyDelegationParts(stringField(args, ["skill", "name", "command"]), "");
      }
      return classifyAcpToolKind(event.toolKind) ?? READ;
    }
    default:
      return null;
  }
}

/** A long unbroken run of reads means the turn has gone back to exploring. */
const READ_STREAK_TO_EXPLORING = 12;
/** Weak signals only count while they are this recent. */
const WEAK_WINDOW_MS = 5 * 60_000;
const WEAK_WINDOW_SIZE = 6;
/** An edit this soon after a test run is part of the fix-and-rerun loop. */
const TEST_LOOP_MS = 2 * 60_000;
/** Enough to dedupe a turn's re-emitted tool calls without growing forever. */
const SEEN_ITEM_CAP = 2_000;

export type SessionActivityDetector = {
  /**
   * Feed one normalized event. Returns the turn's detected activity (null
   * before any evidence) and whether this event counted as new evidence —
   * streamed re-emits and non-tool frames do not.
   */
  observe(event: AgentChatEvent, atMs: number): { activity: SessionActivityValue | null; counted: boolean };
  /**
   * Forget the evidence. Called when the USER engages (a new message, a
   * steer, an answer) — not at every provider turn start: a subagent finishing
   * or a background wake starts a continuation turn mid-flow, and resetting
   * there made a testing run read "Exploring" for its first few calls.
   */
  reset(): void;
  readonly current: SessionActivityValue | null;
};

export function createSessionActivityDetector(): SessionActivityDetector {
  let state: SessionActivityValue | null = null;
  let readStreak = 0;
  let lastTestingAtMs = Number.NEGATIVE_INFINITY;
  let recentWeak: Array<{ activity: SessionActivityValue; atMs: number }> = [];
  const seenItemIds = new Set<string>();

  const reset = (): void => {
    state = null;
    readStreak = 0;
    lastTestingAtMs = Number.NEGATIVE_INFINITY;
    recentWeak = [];
    seenItemIds.clear();
  };

  /**
   * Providers re-emit the same tool call as it streams (args filling in,
   * status changing). Each item counts once, on its first classifiable frame.
   */
  const firstSighting = (event: AgentChatEvent): boolean => {
    if (event.type !== "tool_call" && event.type !== "command" && event.type !== "file_change") return true;
    const id = event.logicalItemId ?? event.itemId;
    if (!id) return true;
    if (seenItemIds.has(id)) return false;
    if (seenItemIds.size >= SEEN_ITEM_CAP) seenItemIds.clear();
    seenItemIds.add(id);
    return true;
  };

  /** Apply one counted signal and return the resulting state. */
  const apply = (signal: SessionActivitySignal, atMs: number): SessionActivityValue | null => {
    if (signal.kind === "read") {
      readStreak += 1;
      if (state === null || readStreak >= READ_STREAK_TO_EXPLORING) state = "exploring";
      return state;
    }

    readStreak = 0;
    const { activity } = signal;
    if (activity === "testing") lastTestingAtMs = atMs;

    if (signal.strength === "strong" || state === null) {
      state = activity;
      return state;
    }
    if (activity === "implementing" && state === "testing" && atMs - lastTestingAtMs < TEST_LOOP_MS) {
      return state;
    }
    recentWeak = [...recentWeak.filter((entry) => atMs - entry.atMs < WEAK_WINDOW_MS), { activity, atMs }]
      .slice(-WEAK_WINDOW_SIZE);
    if (recentWeak.filter((entry) => entry.activity === activity).length >= 2) state = activity;
    return state;
  };

  const observe = (event: AgentChatEvent, atMs: number) => {
    const signal = classifySessionActivityEvent(event);
    if (!signal || !firstSighting(event)) return { activity: state, counted: false };
    return { activity: apply(signal, atMs), counted: true };
  };

  return {
    observe,
    reset,
    get current() {
      return state;
    },
  };
}
