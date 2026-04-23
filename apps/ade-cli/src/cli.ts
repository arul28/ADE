#!/usr/bin/env node
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import YAML from "yaml";
import { type JsonRpcHandler, type JsonRpcId, type JsonRpcRequest } from "./jsonrpc";

type JsonObject = Record<string, unknown>;

type GlobalOptions = {
  projectRoot: string | null;
  workspaceRoot: string | null;
  role: "cto" | "orchestrator" | "agent" | "external" | "evaluator";
  headless: boolean;
  requireSocket: boolean;
  pretty: boolean;
  text: boolean;
  timeoutMs: number;
};

type ParsedCli = {
  options: GlobalOptions;
  command: string[];
};

type InvocationStep = {
  key: string;
  method: string;
  params?: JsonObject;
  unwrapToolResult?: boolean;
  optional?: boolean;
};

type FormatterId =
  | "status"
  | "doctor"
  | "auth"
  | "lanes"
  | "lane-detail"
  | "git-status"
  | "diff-summary"
  | "file-read"
  | "files-tree"
  | "files-search"
  | "prs-list"
  | "pr-detail"
  | "pr-checks"
  | "pr-comments"
  | "run-defs"
  | "run-runtime"
  | "chat-list"
  | "tests-runs"
  | "proof-list"
  | "actions-list"
  | "action-result";

type CliPlan =
  | { kind: "help"; text: string }
  | { kind: "execute"; label: string; steps: InvocationStep[]; visualizer?: "lanes"; summary?: "status" | "doctor" | "auth"; formatter?: FormatterId };

type CliConnection = {
  mode: "desktop-socket" | "headless";
  projectRoot: string;
  workspaceRoot: string;
  socketPath: string;
  request: (method: string, params?: JsonObject) => Promise<unknown>;
  close: () => Promise<void> | void;
};

class CliUsageError extends Error {}

class CliToolError extends Error {
  details: unknown;

  constructor(message: string, details: unknown) {
    super(message);
    this.details = details;
  }
}

class CliExecutionError extends Error {
  details: JsonObject;

  constructor(message: string, details: JsonObject) {
    super(message);
    this.details = details;
  }
}

type ReadinessCheck = {
  ready: boolean;
  status: "ready" | "warning" | "missing" | "unavailable";
  message: string;
  nextAction?: string;
  details?: JsonObject;
};

const VERSION = "0.0.0";
const PROTOCOL_VERSION = "2025-06-18";
const SOURCE_FALLBACK_ENV = "ADE_CLI_SOURCE_FALLBACK_ACTIVE";
const CLI_ENTRY_PATH = typeof process.argv[1] === "string" ? path.resolve(process.argv[1]) : "";
const CLI_PACKAGE_ROOT = resolveCliPackageRoot(CLI_ENTRY_PATH);
const CLI_DIST_PATH = path.join(CLI_PACKAGE_ROOT, "dist", "cli.cjs");

function resolveCliPackageRoot(entryPath: string): string {
  const seen = new Set<string>();
  const starts = [
    entryPath ? path.dirname(entryPath) : null,
    process.cwd(),
  ];
  for (const start of starts) {
    if (!start) continue;
    let cursor = path.resolve(start);
    while (!seen.has(cursor)) {
      seen.add(cursor);
      const packageJson = path.join(cursor, "package.json");
      const srcCli = path.join(cursor, "src", "cli.ts");
      if (fs.existsSync(packageJson) && fs.existsSync(srcCli)) {
        return cursor;
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  }
  return path.resolve(process.cwd(), "apps", "ade-cli");
}

function isSourceCliEntryPath(modulePath: string): boolean {
  return /[/\\]src[/\\]cli\.ts$/i.test(modulePath);
}

function isSourceRuntimeInteropError(value: unknown): boolean {
  const message = typeof value === "string"
    ? value
    : value instanceof Error
      ? value.message
      : "";
  if (!message.length) return false;
  const lower = message.toLowerCase();
  return lower.includes("__filename is not defined in es module scope")
    || lower.includes("__filename is not defined")
    || lower.includes("__dirname is not defined");
}

function formatSpawnFailure(result: ReturnType<typeof spawnSync>, fallbackCommand: string): string {
  if (result.error) {
    return result.error.message;
  }
  const status = typeof result.status === "number" ? result.status : "unknown";
  const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
  const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
  const detail = stderr || stdout || "No output captured.";
  return `${fallbackCommand} exited with status ${status}: ${detail}`;
}

function latestMtimeMs(root: string): number {
  let latest = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return latest;
  }
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      latest = Math.max(latest, latestMtimeMs(fullPath));
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      latest = Math.max(latest, fs.statSync(fullPath).mtimeMs);
    } catch {
      // Ignore files that disappear while checking freshness.
    }
  }
  return latest;
}

function isBuiltCliFresh(): boolean {
  try {
    const distMtime = fs.statSync(CLI_DIST_PATH).mtimeMs;
    const sourceMtime = latestMtimeMs(path.join(CLI_PACKAGE_ROOT, "src"));
    return distMtime >= sourceMtime;
  } catch {
    return false;
  }
}

function maybeRunBuiltCliFallback(error: unknown, argv: string[]): { stdout: string; stderr: string; exitCode: number } | null {
  if (!(error instanceof CliExecutionError)) return null;
  if (process.env[SOURCE_FALLBACK_ENV] === "1") return null;
  if (!isSourceCliEntryPath(CLI_ENTRY_PATH)) return null;
  if (!isSourceRuntimeInteropError(asString(error.details.cause) ?? error.message)) return null;

  if (!isBuiltCliFresh()) {
    const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
    const buildResult = spawnSync(npmCommand, ["run", "build", "--silent"], {
      cwd: CLI_PACKAGE_ROOT,
      env: process.env,
      encoding: "utf8",
    });
    if (buildResult.error || buildResult.status !== 0 || !isBuiltCliFresh()) {
      error.details.nextAction = "Run `npm --prefix apps/ade-cli run build` and retry the command.";
      error.details.fallback = formatSpawnFailure(buildResult, "npm run build --silent");
      return null;
    }
  }

  const rerun = spawnSync(process.execPath, [CLI_DIST_PATH, ...argv], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      [SOURCE_FALLBACK_ENV]: "1",
    },
    encoding: "utf8",
  });
  if (rerun.error) {
    error.details.nextAction = "Run `node apps/ade-cli/dist/cli.cjs ...` directly to inspect the runtime failure.";
    error.details.fallback = rerun.error.message;
    return null;
  }

  return {
    stdout: typeof rerun.stdout === "string" ? rerun.stdout : "",
    stderr: typeof rerun.stderr === "string" ? rerun.stderr : "",
    exitCode: rerun.status ?? 1,
  };
}

const ADE_BANNER = String.raw`
     _    ____  _____
    / \  |  _ \| ____|
   / _ \ | | | |  _|
  / ___ \| |_| | |___
 /_/   \_\____/|_____|
`;

const TOP_LEVEL_HELP = `${ADE_BANNER}
  Agent-focused command-line interface for ADE.

  ADE CLI commands operate on the same project database and live desktop socket
  used by the ADE app. By default the CLI connects to the app socket when it is
  running; otherwise it falls back to a headless runtime for local-safe actions.

    $ ade help <command...>                         Display help for a command
    $ ade auth status                               Check local ADE CLI readiness
    $ ade doctor                                    Inspect project, socket, runtime, and tool availability
    $ ade lanes list | show | create | child        Work with lanes and lane stacks
    $ ade git status | commit | push | stash        Run ADE-aware git operations
    $ ade diff changes | file                       Inspect lane diffs
    $ ade files tree | read | write | search        Read and edit lane workspaces
    $ ade prs list | create | path-to-merge         Manage PRs, queues, and Path to Merge repair rounds
    $ ade run defs | ps | start | logs              Manage Run tab process definitions and runtime
    $ ade shell start | write | resize | close      Launch and control tracked shell sessions
    $ ade chat list | create | send | interrupt     Work with ADE agent chats
    $ ade agent spawn --lane <id> --prompt <text>   Launch an agent session in ADE
    $ ade cto state | chats                         Operate CTO state and Work chats
    $ ade linear workflows | run | sync             Operate Linear routing and sync workflows
    $ ade automations list | create | run | runs    Manage automation rules
    $ ade coordinator <tool>                        Call coordinator runtime tools
    $ ade tests list | run | stop | runs | logs     Run configured test suites
    $ ade proof status | list | screenshot | record Manage proof and computer-use artifacts
    $ ade memory add | search | pin                 Use ADE memory
    $ ade settings action <method>                  Call project config actions
    $ ade actions list | run | status               Escape hatch for every ADE service action

  Global options:
    --project-root <path>   ADE project root. Inside .ade/worktrees/<lane>, this resolves to the parent project.
    --workspace-root <path> Lane/worktree to treat as the active workspace.
    --headless              Skip the desktop socket and run an in-process ADE runtime.
    --socket                Require the desktop socket; fail instead of falling back to headless.
    --json                  Print machine-readable JSON. This is the default output mode.
    --text                  Print a compact human-readable summary when a formatter exists.
    --timeout-ms <ms>       Per-request timeout. Long agent/PR workflows may need several minutes.

  Common agent flows:
    $ ade doctor --text
    $ ade lanes list --text
    $ ade lanes create --name fix-login --description "Repair login redirect"
    $ ade git status --lane <lane> --text
    $ ade git stage --lane <lane> src/index.ts
    $ ade git commit --lane <lane> -m "Fix login redirect"
    $ ade prs create --lane <lane> --base main --draft
    $ ade prs path-to-merge <pr-id-or-number-or-url> --model <model> --max-rounds 3 --no-auto-merge
    $ ade proof record --seconds 20

  Generic ADE action JSON contract:
    Object-shaped call:
      $ ade actions run git.push --input-json '{"laneId":"lane-1","setUpstream":true}'
      $ ade actions run git.push --arg laneId=lane-1 --arg setUpstream=true
    JSON value fields:
      $ ade actions run pr.setLabels --arg prId=123 --arg-json 'labels=["ready","ship"]'
    Multi-parameter service call:
      $ ade actions run issue_inventory.savePipelineSettings --args-list-json '["pr-1",{"maxRounds":3}]'
    Single scalar parameter:
      $ ade actions run mission.get --scalar mission-1

    $ ade actions list --text
    $ ade actions list --domain pr --text
    $ ade actions run <domain.action> --input-json '{"key":"value"}'

  Start with: ade doctor --text
`;

const HELP_BY_COMMAND: Record<string, string> = {
  lanes: `${ADE_BANNER}
  Lanes

  Lanes are ADE-managed worktrees and branches. Most commands accept either
  --lane <lane-id> or a positional lane id.

    $ ade lanes list --text                         Show lane stack graph and branch names
    $ ade lanes show <lane> --text                  Inspect one lane status
    $ ade lanes create --name <name>                Create a lane from the current project context
    $ ade lanes child --lane <parent> --name <name> Create a child lane under a parent
    $ ade lanes import --branch <branch>            Register an existing branch/worktree
    $ ade lanes archive <lane>                      Archive a lane in ADE
    $ ade lanes unarchive <lane>                    Restore an archived lane
    $ ade lanes attach --path <worktree> --name <n> Attach an external worktree
    $ ade lanes actions --text                      List callable lane service methods
`,
  git: `${ADE_BANNER}
  Git

  Git commands run in the lane worktree and record ADE operations so the app can
  refresh lane state. Use --lane for anything other than the active workspace.

    $ ade git status --lane <lane> --text           Show ADE-aware sync status
    $ ade git stage --lane <lane> src/file.ts       Stage one file
    $ ade git stage-all --lane <lane>               Stage all current changes
    $ ade git unstage --lane <lane> src/file.ts     Unstage one file
    $ ade git commit --lane <lane> [-m <message>]   Commit, generating a message when omitted
    $ ade git push --lane <lane> --set-upstream     Push through ADE
    $ ade git stash push|list|apply|pop             Use ADE lane stash actions
    $ ade git rebase --lane <lane> --ai             Rebase with ADE conflict support
    $ ade diff changes --lane <lane> --text         Inspect changed files
`,
  diff: `${ADE_BANNER}
  Diffs

    $ ade diff changes --lane <lane> --text         Summarize staged/unstaged file changes
    $ ade diff file --lane <lane> <path> --text     Show one file diff
    $ ade diff file --mode staged <path>            Inspect staged diff for one file
    $ ade diff actions --text                       List diff service actions
`,
  prs: `${ADE_BANNER}
  Pull requests

  PR identifiers may be ADE PR ids, GitHub PR numbers, #numbers, or full PR URLs.
  Creating or linking a PR persists the lane mapping in ADE so the PR tab tracks it.

    $ ade prs list --text                           List PRs known to ADE
    $ ade prs create --lane <lane> --base main      Open and map a GitHub PR from a lane
    $ ade prs link --lane <lane> --url <pr-url>     Map an existing GitHub PR to a lane
    $ ade prs checks <pr> --text                    Show check status
    $ ade prs comments <pr> --text                  Show unresolved review work
    $ ade prs inventory <pr>                        Refresh ADE issue inventory
    $ ade prs path-to-merge <pr> --model <model> --max-rounds 3 --no-auto-merge
    $ ade prs resolve-thread <pr> --thread <id>     Resolve a review thread
    $ ade prs labels set <pr> ready-to-merge        Replace labels
    $ ade prs reviewers request <pr> alice bob      Request reviewers
`,
  run: `${ADE_BANNER}
  Run tab

  Run tab commands mirror ADE desktop process definitions and runtime state.
  They require the desktop socket when live process state is needed.

    $ ade run defs --text                           List configured run commands
    $ ade run ps --lane <lane> --text               List process runtime state
    $ ade run start <process> --lane <lane>         Start a process in a lane
    $ ade run stop <process> --lane <lane>          Stop a process in a lane
    $ ade run logs <process> --run <run> --text     Tail process logs
    $ ade run stack start --stack <id> --lane <lane> Start a process stack
    $ ade run start-all --lane <lane>               Start all configured processes
`,
  shell: `${ADE_BANNER}
  Shell sessions

  Shell commands create tracked PTY sessions that ADE can display and audit.

    $ ade shell start --lane <lane> -- npm test     Start a tracked shell session
    $ ade shell start --lane <lane> -c "npm test"   Start with a command string
    $ ade shell write <pty-id> --data "q"           Write data to a PTY
    $ ade shell resize <pty-id> --cols 120 --rows 36
    $ ade shell close <pty-id>                      Dispose a PTY
`,
  files: `${ADE_BANNER}
  Files

  File commands operate inside an ADE workspace id, usually a lane id.

    $ ade files workspaces --text                   List workspace roots
    $ ade files tree --workspace <lane> --path src  Show a workspace tree
    $ ade files read --workspace <lane> <path> --text Read a file
    $ ade files write --workspace <lane> <path> --stdin
    $ ade files write --workspace <lane> <path> --text "new content"
    $ ade files create --workspace <lane> <path> --text "content"
    $ ade files mkdir --workspace <lane> src/new
    $ ade files search --workspace <lane> -q <text> Search text in a workspace
    $ ade files quick-open --workspace <lane> -q app
`,
  chat: `${ADE_BANNER}
  Work chats

  Chat commands use ADE agent chat sessions. Live provider-backed chat normally
  requires the desktop socket because the app owns provider/session state.

    $ ade chat list --text                          List chat sessions
    $ ade chat create --lane <lane> --provider codex --model <model>
    $ ade chat send <session> --text "next step"    Send a message
    $ ade chat interrupt <session>                  Stop an active turn
    $ ade chat resume <session>                     Resume a session
    $ ade agent spawn --lane <lane> --prompt "fix"  Start a new agent work session
`,
  agent: `${ADE_BANNER}
  Agent sessions

    $ ade agent spawn --lane <lane> --prompt "Fix the failing test"
    $ ade agent spawn --lane <lane> --provider codex --model <model> --permissions workspace-write
    $ ade agent spawn --lane <lane> --context-file docs/context.md --prompt "continue"
    $ ade agent spawn --lane <lane> --tool=git --tool=files --prompt "review changes"
`,
  proof: `${ADE_BANNER}
  Proof and computer use

  Proof commands capture or ingest artifacts that ADE can attach to work.
  Local screenshot/video fallback is macOS-only; desktop socket mode has the
  best parity with the app.

    $ ade proof status --text                       Show proof backend capabilities
    $ ade proof list --text                         List captured artifacts
    $ ade proof screenshot                          Capture a screenshot artifact
    $ ade proof record --seconds 20                 Capture a short video proof
    $ ade proof launch --app "ADE"                  Launch an app for proof capture
    $ ade proof ingest --input-json '{"artifacts":[]}' Ingest external proof artifacts
`,
  tests: `${ADE_BANNER}
  Tests

    $ ade tests list --text                         List configured test suites
    $ ade tests run --lane <lane> --suite unit      Run a configured suite
    $ ade tests run --lane <lane> --command "npm test" --wait
    $ ade tests runs --lane <lane> --text           List recent test runs
    $ ade tests logs <run-id> --text                Tail a test run log
    $ ade tests stop <run-id>                       Stop an active test run
`,
  memory: `${ADE_BANNER}
  Memory

    $ ade memory add --category fact --content "User prefers concise summaries"
    $ ade memory search -q "release process" --text
    $ ade memory pin <memory-id>
    $ ade memory core --arg projectSummary="Current focus"
`,
  cto: `${ADE_BANNER}
  CTO and Work state

    $ ade cto state --text                          Read CTO identity, core memory, and recent sessions
    $ ade cto chats list --text                     List CTO work chats
    $ ade cto chats spawn --lane <lane> --prompt "plan this"
    $ ade cto chats send <session> --text "continue"
    $ ade actions run cto_state.updateCoreMemory --input-json '{"projectSummary":"..."}'
    $ ade actions run worker_agent.listAgents --input-json '{"includeDeleted":false}'
`,
  linear: `${ADE_BANNER}
  Linear workflows

    $ ade linear workflows --text                   List configured workflows
    $ ade linear sync dashboard --text              Show sync dashboard
    $ ade linear sync run                           Trigger a sync run
    $ ade linear sync queue --text                  List sync queue items
    $ ade linear sync resolve --queue-item <id> --action approve
    $ ade linear route worker --input-json '{"issueId":"LIN-123","workerId":"worker-1"}'
`,
  flow: `${ADE_BANNER}
  Flow policy

    $ ade flow policy get --text                    Read current workflow policy
    $ ade flow policy validate --input-json '{...}' Validate policy JSON
    $ ade flow policy save --input-json '{...}'     Save policy JSON
    $ ade flow policy revisions --text              List saved revisions
    $ ade flow policy rollback <revision-id>        Restore a prior revision
`,
  coordinator: `${ADE_BANNER}
  Coordinator runtime tools

  Coordinator tools expose orchestration operations used by mission agents.
  List tool names with:
    $ ade actions call list_ade_actions --input-json '{"domain":"orchestrator_core"}'

    $ ade coordinator <tool-name> --input-json '{"key":"value"}'
`,
  actions: `${ADE_BANNER}
  ADE actions

  Escape hatch for any exposed ADE service method. Use typed commands first
  when they exist; use actions when an agent needs exact service coverage.

  Argument shapes:
    Object args become one object parameter:
      $ ade actions run git.push --input-json '{"laneId":"lane-1","setUpstream":true}'
      $ ade actions run git.push --arg laneId=lane-1 --arg setUpstream=true
    --arg parses true/false/null/numbers; --arg-json parses a JSON value:
      $ ade actions run pr.setLabels --arg prId=123 --arg-json 'labels=["ready","ship"]'
    argsList is for service methods with multiple positional parameters:
      $ ade actions run issue_inventory.savePipelineSettings --args-list-json '["pr-1",{"maxRounds":3}]'
    scalar is for one non-object parameter:
      $ ade actions run mission.get --scalar mission-1

    $ ade actions list --text                       Domain-grouped action catalog
    $ ade actions list --domain git --text          Narrow the catalog
    $ ade actions run <domain.action> --input-json '{"key":"value"}'
    $ ade actions run <domain> <action> --input-json '{"key":"value"}'
    $ ade actions status --text                     Runtime action availability
`,
  automations: `${ADE_BANNER}
  Automations

    $ ade automations list [--json]                 List automation rules
    $ ade automations show <id> [--json]            Inspect a rule
    $ ade automations create --from-file <path>     Create from YAML (also accepts --stdin)
    $ ade automations update <id> --from-file <path>
    $ ade automations delete <id>                   Remove a local rule
    $ ade automations toggle <id> --enabled true|false
    $ ade automations run <id> [--dry-run]          Trigger a rule manually
    $ ade automations runs [--rule <id>] [--limit 50] [--json]
    $ ade automations run-show <runId> [--json]     Inspect a run
`,
};

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parseBooleanEnv(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function parsePrimitive(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(trimmed)) {
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) return parsed;
  }
  return value;
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new CliUsageError(`${label} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseObjectJson(value: string, label: string): JsonObject {
  const parsed = parseJson(value, label);
  if (!isRecord(parsed)) {
    throw new CliUsageError(`${label} must be a JSON object.`);
  }
  return parsed;
}

function parseAssignment(value: string, label: string): { key: string; value: string } {
  const index = value.indexOf("=");
  if (index <= 0) {
    throw new CliUsageError(`${label} must use key=value syntax.`);
  }
  const key = value.slice(0, index).trim();
  if (!key.length) {
    throw new CliUsageError(`${label} is missing a key.`);
  }
  return { key, value: value.slice(index + 1) };
}

const UNSAFE_ARG_PATH_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

function setPath(target: JsonObject, key: string, value: unknown): void {
  const parts = key.split(".").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) {
    throw new CliUsageError("Argument key cannot be empty.");
  }
  const unsafePart = parts.find((part) => UNSAFE_ARG_PATH_SEGMENTS.has(part));
  if (unsafePart) {
    throw new CliUsageError(`Argument key segment "${unsafePart}" is not allowed.`);
  }
  let cursor: JsonObject = target;
  for (const part of parts.slice(0, -1)) {
    const existing = cursor[part];
    if (!isRecord(existing)) {
      const next: JsonObject = {};
      cursor[part] = next;
      cursor = next;
      continue;
    }
    cursor = existing;
  }
  cursor[parts[parts.length - 1]!] = value;
}

function readValue(args: string[], names: string[]): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token) continue;
    const matchedName = names.find((name) => token === name || token.startsWith(`${name}=`));
    if (!matchedName) continue;
    if (token.includes("=")) {
      args.splice(index, 1);
      return token.slice(token.indexOf("=") + 1);
    }
    const value = args[index + 1];
    if (value == null) {
      throw new CliUsageError(`${token} requires a value.`);
    }
    args.splice(index, 2);
    return value;
  }
  return null;
}

function readFlag(args: string[], names: string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    if (!names.includes(args[index]!)) continue;
    args.splice(index, 1);
    return true;
  }
  return false;
}

function firstPositional(args: string[]): string | null {
  const index = args.findIndex((arg) => arg !== "--" && !arg.startsWith("-"));
  if (index < 0) return null;
  const [value] = args.splice(index, 1);
  return value ?? null;
}

function collectGenericObjectArgs(args: string[], base: JsonObject = {}): JsonObject {
  const input: JsonObject = { ...base };
  while (true) {
    const inputJson = readValue(args, ["--input-json", "--json-input", "--input"]);
    if (inputJson != null) {
      Object.assign(input, parseObjectJson(inputJson, "--input-json"));
      continue;
    }

    const rawArg = readValue(args, ["--arg", "--set"]);
    if (rawArg != null) {
      const { key, value } = parseAssignment(rawArg, "--arg");
      setPath(input, key, parsePrimitive(value));
      continue;
    }

    const jsonArg = readValue(args, ["--arg-json", "--set-json"]);
    if (jsonArg != null) {
      const { key, value } = parseAssignment(jsonArg, "--arg-json");
      setPath(input, key, parseJson(value, `--arg-json ${key}`));
      continue;
    }

    break;
  }
  return input;
}

function readLaneId(args: string[]): string | null {
  return readValue(args, ["--lane", "--lane-id"]) ?? null;
}

function readPrId(args: string[]): string | null {
  return readValue(args, ["--pr", "--pr-id"]) ?? null;
}

function readIntOption(args: string[], names: string[], fallback?: number): number | undefined {
  const value = readValue(args, names);
  if (value == null) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new CliUsageError(`${names[0]} must be an integer.`);
  }
  return parsed;
}

function readNumberOption(args: string[], names: string[], fallback?: number): number | undefined {
  const value = readValue(args, names);
  if (value == null) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new CliUsageError(`${names[0]} must be a number.`);
  }
  return parsed;
}

function requireValue(value: string | null, label: string): string {
  if (value && value.trim().length > 0) return value.trim();
  throw new CliUsageError(`${label} is required.`);
}

function isCommandTextValue(argv: string[], index: number, command: string[]): boolean {
  if (command.length === 0) return false;
  const token = argv[index];
  if (token?.startsWith("--text=")) return true;
  if (token !== "--text") return false;
  const next = argv[index + 1];
  return Boolean(next && next !== "--" && !next.startsWith("-"));
}

function maybePut(target: JsonObject, key: string, value: unknown): void {
  if (value !== undefined && value !== null && value !== "") {
    target[key] = value;
  }
}

function parseCliArgs(argv: string[]): ParsedCli {
  const command: string[] = [];
  const options: GlobalOptions = {
    projectRoot: null,
    workspaceRoot: null,
    role: (asString(process.env.ADE_DEFAULT_ROLE) as GlobalOptions["role"] | null) ?? "agent",
    headless: parseBooleanEnv(process.env.ADE_CLI_HEADLESS),
    requireSocket: false,
    pretty: true,
    text: false,
    timeoutMs: 10 * 60 * 1000,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    const inGlobalPrefix = command.length === 0;
    if (token === "--") {
      command.push(token, ...argv.slice(index + 1));
      break;
    }
    if (inGlobalPrefix && token === "--project-root") {
      options.projectRoot = path.resolve(requireValue(argv[index + 1] ?? null, "--project-root"));
      index += 1;
      continue;
    }
    if (inGlobalPrefix && token.startsWith("--project-root=")) {
      options.projectRoot = path.resolve(requireValue(token.slice("--project-root=".length), "--project-root"));
      continue;
    }
    if (inGlobalPrefix && token === "--workspace-root") {
      options.workspaceRoot = path.resolve(requireValue(argv[index + 1] ?? null, "--workspace-root"));
      index += 1;
      continue;
    }
    if (inGlobalPrefix && token.startsWith("--workspace-root=")) {
      options.workspaceRoot = path.resolve(requireValue(token.slice("--workspace-root=".length), "--workspace-root"));
      continue;
    }
    if (inGlobalPrefix && token === "--role") {
      options.role = parseRole(requireValue(argv[index + 1] ?? null, "--role"));
      index += 1;
      continue;
    }
    if (inGlobalPrefix && token.startsWith("--role=")) {
      options.role = parseRole(requireValue(token.slice("--role=".length), "--role"));
      continue;
    }
    if (inGlobalPrefix && (token === "--headless" || token === "--no-socket")) {
      options.headless = true;
      continue;
    }
    if (inGlobalPrefix && token === "--socket") {
      options.requireSocket = true;
      options.headless = false;
      continue;
    }
    if (token === "--compact") {
      options.pretty = false;
      continue;
    }
    if (token === "--pretty") {
      options.pretty = true;
      continue;
    }
    if (isCommandTextValue(argv, index, command)) {
      command.push(token);
      continue;
    }
    if (token === "--text") {
      options.text = true;
      continue;
    }
    if (token === "--json") {
      options.text = false;
      continue;
    }
    if (inGlobalPrefix && token === "--timeout-ms") {
      const parsed = Number.parseInt(requireValue(argv[index + 1] ?? null, "--timeout-ms"), 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new CliUsageError("--timeout-ms must be a positive integer.");
      }
      options.timeoutMs = parsed;
      index += 1;
      continue;
    }
    if (inGlobalPrefix && token.startsWith("--timeout-ms=")) {
      const parsed = Number.parseInt(requireValue(token.slice("--timeout-ms=".length), "--timeout-ms"), 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new CliUsageError("--timeout-ms must be a positive integer.");
      }
      options.timeoutMs = parsed;
      continue;
    }
    command.push(token);
  }

  return { options, command };
}

function parseRole(value: string): GlobalOptions["role"] {
  if (value === "cto" || value === "orchestrator" || value === "agent" || value === "external" || value === "evaluator") {
    return value;
  }
  throw new CliUsageError("--role must be one of cto, orchestrator, agent, external, or evaluator.");
}

function shellEscapeToken(value: string): string {
  if (!value.length) return "''";
  if (/^[a-zA-Z0-9_./:=@%+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function actionCallStep(key: string, name: string, args: JsonObject = {}): InvocationStep {
  return {
    key,
    method: "ade/actions/call",
    params: { name, arguments: args },
    unwrapToolResult: true,
  };
}

function actionStep(key: string, domain: string, action: string, args: JsonObject = {}): InvocationStep {
  return actionCallStep(key, "run_ade_action", { domain, action, args });
}

function actionArgsListStep(key: string, domain: string, action: string, argsList: unknown[]): InvocationStep {
  return actionCallStep(key, "run_ade_action", { domain, action, argsList });
}

function listActionsStep(key: string, domain?: string): InvocationStep {
  return actionCallStep(key, "list_ade_actions", domain ? { domain } : {});
}

function buildActionRunStep(args: string[]): InvocationStep {
  const target = firstPositional(args);
  if (!target) throw new CliUsageError("actions run requires <domain.action> or <domain> <action>.");

  let domain: string;
  let action: string;
  if (target.includes(".")) {
    const parts = target.split(".");
    domain = requireValue(parts.shift() ?? null, "domain");
    action = requireValue(parts.join("."), "action");
  } else {
    domain = target;
    action = requireValue(firstPositional(args), "action");
  }

  const argsListJson = readValue(args, ["--args-list-json", "--params-json"]);
  if (argsListJson != null) {
    const argsList = parseJson(argsListJson, "--args-list-json");
    if (!Array.isArray(argsList)) throw new CliUsageError("--args-list-json must be a JSON array.");
    return actionCallStep("result", "run_ade_action", { domain, action, argsList });
  }

  const scalarJson = readValue(args, ["--scalar-json", "--arg-value-json"]);
  if (scalarJson != null) {
    return actionCallStep("result", "run_ade_action", { domain, action, arg: parseJson(scalarJson, "--scalar-json") });
  }

  const scalar = readValue(args, ["--scalar", "--arg-value"]);
  if (scalar != null) {
    return actionCallStep("result", "run_ade_action", { domain, action, arg: parsePrimitive(scalar) });
  }

  return actionStep("result", domain, action, collectGenericObjectArgs(args));
}

function buildLanePlan(args: string[]): CliPlan {
  const sub = firstPositional(args) ?? "list";
  if (sub === "actions") {
    return { kind: "execute", label: "lane actions", steps: [listActionsStep("actions", "lane")] };
  }
  if (sub === "action") {
    return { kind: "execute", label: "lane action", steps: [buildActionRunStep(["lane", ...args])] };
  }
  if (sub === "list" || sub === "ls") {
    const input = collectGenericObjectArgs(args, {
      includeArchived: readFlag(args, ["--archived", "--include-archived"]),
    });
    const visual = readFlag(args, ["--visual", "--graph"]);
    const noVisual = readFlag(args, ["--no-visual"]);
    return {
      kind: "execute",
      label: "lanes list",
      steps: [actionCallStep("result", "list_lanes", input)],
      visualizer: visual || !noVisual ? "lanes" : undefined,
    };
  }
  if (sub === "show" || sub === "status") {
    const laneId = requireValue(readLaneId(args) ?? firstPositional(args), "laneId");
    return { kind: "execute", label: "lane status", steps: [actionCallStep("result", "get_lane_status", { laneId })] };
  }
  if (sub === "merge") {
    const laneId = requireValue(readLaneId(args) ?? firstPositional(args), "laneId");
    return { kind: "execute", label: "lane merge", steps: [actionCallStep("result", "merge_lane", collectGenericObjectArgs(args, { laneId, message: readValue(args, ["--message", "-m"]), deleteSourceLane: readFlag(args, ["--delete-source-lane", "--delete-source"]) }))] };
  }
  if (sub === "conflicts") {
    const mode = firstPositional(args) ?? "check";
    if (mode !== "check") return { kind: "execute", label: `lane conflicts ${mode}`, steps: [actionStep("result", "conflicts", mode, collectGenericObjectArgs(args, { laneId: readLaneId(args) }))] };
    const ids = args.filter((entry) => !entry.startsWith("-"));
    return { kind: "execute", label: "lane conflicts check", steps: [actionCallStep("result", "check_conflicts", collectGenericObjectArgs(args, { laneId: readLaneId(args), ...(ids.length ? { laneIds: ids } : {}), force: readFlag(args, ["--force"]) }))] };
  }
  if (sub === "create" || sub === "child") {
    const name = readValue(args, ["--name"]) ?? firstPositional(args);
    const input: JsonObject = {};
    input.name = requireValue(name, "name");
    maybePut(input, "description", readValue(args, ["--description", "--desc"]));
    maybePut(input, "parentLaneId", readValue(args, ["--parent", "--parent-lane", "--parent-lane-id"]) ?? (sub === "child" ? readLaneId(args) : null));
    if (sub === "child" && !input.parentLaneId) throw new CliUsageError("parent lane is required. Use --lane <parent> or --parent <parent>.");
    return { kind: "execute", label: "lane create", steps: [actionCallStep("result", "create_lane", collectGenericObjectArgs(args, input))] };
  }
  if (sub === "children") {
    const laneId = requireValue(readLaneId(args) ?? firstPositional(args), "laneId");
    return { kind: "execute", label: "lane children", steps: [actionArgsListStep("result", "lane", "getChildren", [laneId])] };
  }
  if (sub === "stack") {
    const laneId = requireValue(readLaneId(args) ?? firstPositional(args), "laneId");
    return { kind: "execute", label: "lane stack", steps: [actionArgsListStep("result", "lane", "getStackChain", [laneId])] };
  }
  if (sub === "refresh") {
    return { kind: "execute", label: "lane refresh", steps: [actionStep("result", "lane", "refreshSnapshots", collectGenericObjectArgs(args, { includeArchived: readFlag(args, ["--archived", "--include-archived"]) }))] };
  }
  if (sub === "rename") {
    const laneId = requireValue(readLaneId(args) ?? firstPositional(args), "laneId");
    return { kind: "execute", label: "lane rename", steps: [actionStep("result", "lane", "rename", collectGenericObjectArgs(args, { laneId, name: readValue(args, ["--name"]) ?? firstPositional(args) }))] };
  }
  if (sub === "reparent") {
    const laneId = requireValue(readLaneId(args) ?? firstPositional(args), "laneId");
    return { kind: "execute", label: "lane reparent", steps: [actionStep("result", "lane", "reparent", collectGenericObjectArgs(args, { laneId, newParentLaneId: readValue(args, ["--parent", "--parent-lane", "--parent-lane-id"]) ?? firstPositional(args) }))] };
  }
  if (sub === "appearance") {
    const laneId = requireValue(readLaneId(args) ?? firstPositional(args), "laneId");
    return { kind: "execute", label: "lane appearance", steps: [actionStep("result", "lane", "updateAppearance", collectGenericObjectArgs(args, { laneId, color: readValue(args, ["--color"]), icon: readValue(args, ["--icon"]) }))] };
  }
  if (sub === "archive" || sub === "unarchive") {
    const laneId = requireValue(readLaneId(args) ?? firstPositional(args), "laneId");
    return { kind: "execute", label: `lane ${sub}`, steps: [actionStep("result", "lane", sub, collectGenericObjectArgs(args, { laneId }))] };
  }
  if (sub === "delete" || sub === "rm") {
    const laneId = requireValue(readLaneId(args) ?? firstPositional(args), "laneId");
    return { kind: "execute", label: "lane delete", steps: [actionStep("result", "lane", "delete", collectGenericObjectArgs(args, { laneId, force: readFlag(args, ["--force"]), deleteBranch: readFlag(args, ["--delete-branch"]), deleteRemoteBranch: readFlag(args, ["--delete-remote-branch"]) }))] };
  }
  if (sub === "attach") {
    return { kind: "execute", label: "lane attach", steps: [actionStep("result", "lane", "attach", collectGenericObjectArgs(args, { worktreePath: readValue(args, ["--path"]) ?? firstPositional(args), name: readValue(args, ["--name"]) }))] };
  }
  if (sub === "adopt-attached") {
    const laneId = requireValue(readLaneId(args) ?? firstPositional(args), "laneId");
    return { kind: "execute", label: "lane adopt attached", steps: [actionStep("result", "lane", "adoptAttached", collectGenericObjectArgs(args, { laneId }))] };
  }
  if (sub === "split-unstaged") {
    return { kind: "execute", label: "lane split unstaged", steps: [actionStep("result", "lane", "createFromUnstaged", collectGenericObjectArgs(args, { sourceLaneId: readValue(args, ["--source", "--source-lane"]) ?? readLaneId(args), name: readValue(args, ["--name"]) ?? firstPositional(args) }))] };
  }
  if (sub === "import" || sub === "import-branch") {
    const input: JsonObject = {};
    input.branchRef = requireValue(readValue(args, ["--branch", "--branch-ref"]) ?? firstPositional(args), "branchRef");
    maybePut(input, "name", readValue(args, ["--name"]));
    maybePut(input, "description", readValue(args, ["--description", "--desc"]));
    maybePut(input, "baseBranch", readValue(args, ["--base", "--base-branch"]));
    return { kind: "execute", label: "lane import", steps: [actionCallStep("result", "import_lane", collectGenericObjectArgs(args, input))] };
  }
  if (sub === "unregistered" || sub === "list-unregistered") {
    return { kind: "execute", label: "unregistered lanes", steps: [actionCallStep("result", "list_unregistered_lanes", collectGenericObjectArgs(args))] };
  }
  return { kind: "execute", label: `lane ${sub}`, steps: [actionStep("result", "lane", sub, collectGenericObjectArgs(args))] };
}

function buildGitPlan(args: string[]): CliPlan {
  const sub = firstPositional(args) ?? "status";
  if (sub === "actions") {
    return { kind: "execute", label: "git actions", steps: [listActionsStep("actions", "git")] };
  }
  if (sub === "action") {
    return { kind: "execute", label: "git action", steps: [buildActionRunStep(["git", ...args])] };
  }

  const laneId = readLaneId(args);
  const withLane = (base: JsonObject = {}) => collectGenericObjectArgs(args, { ...base, ...(laneId ? { laneId } : {}) });

  if (sub === "status" || sub === "sync-status") return { kind: "execute", label: "git status", steps: [actionCallStep("result", "git_get_sync_status", withLane())] };
  if (sub === "fetch") return { kind: "execute", label: "git fetch", steps: [actionCallStep("result", "git_fetch", withLane())] };
  if (sub === "pull") return { kind: "execute", label: "git pull", steps: [actionCallStep("result", "git_pull", withLane())] };
  if (sub === "push") {
    const forceWithLease = readFlag(args, ["--force", "--force-with-lease"]);
    const setUpstream = readFlag(args, ["--set-upstream", "-u"]);
    return { kind: "execute", label: "git push", steps: [actionCallStep("result", "git_push", withLane({ forceWithLease, setUpstream }))] };
  }
  if (sub === "commit") {
    const input: JsonObject = {};
    maybePut(input, "message", readValue(args, ["--message", "-m"]));
    maybePut(input, "amend", readFlag(args, ["--amend"]));
    input.stageAll = !readFlag(args, ["--no-stage-all"]);
    return { kind: "execute", label: "git commit", steps: [actionCallStep("result", "commit_changes", withLane(input))] };
  }
  if (sub === "generate-message") {
    return { kind: "execute", label: "git commit message", steps: [actionCallStep("result", "generate_commit_message", withLane({ amend: readFlag(args, ["--amend"]) }))] };
  }
  if (sub === "branches" || sub === "branch") return { kind: "execute", label: "git branches", steps: [actionCallStep("result", "git_list_branches", withLane())] };
  if (sub === "checkout") {
    const branchName = requireValue(readValue(args, ["--branch", "--branch-name"]) ?? firstPositional(args), "branchName");
    return { kind: "execute", label: "git checkout", steps: [actionCallStep("result", "git_checkout_branch", withLane({ branchName }))] };
  }
  if (sub === "conflicts") return { kind: "execute", label: "git conflicts", steps: [actionCallStep("result", "get_lane_conflict_state", withLane())] };
  if (sub === "rebase") {
    const mode = firstPositional(args);
    if (mode === "continue") return { kind: "execute", label: "rebase continue", steps: [actionCallStep("result", "rebase_continue", withLane())] };
    if (mode === "abort") return { kind: "execute", label: "rebase abort", steps: [actionCallStep("result", "rebase_abort", withLane())] };
    return { kind: "execute", label: "rebase lane", steps: [actionCallStep("result", "rebase_lane", withLane({ aiAssisted: readFlag(args, ["--ai", "--ai-assisted"]) }))] };
  }
  if (sub === "merge") {
    const mode = requireValue(firstPositional(args), "merge action");
    if (mode !== "continue" && mode !== "abort") throw new CliUsageError("git merge supports continue or abort.");
    return { kind: "execute", label: `merge ${mode}`, steps: [actionStep("result", "git", mode === "continue" ? "mergeContinue" : "mergeAbort", withLane())] };
  }
  if (sub === "stash") {
    const action = firstPositional(args) ?? "list";
    const stashRef = readValue(args, ["--ref", "--stash-ref"]) ?? firstPositional(args);
    const message = readValue(args, ["--message", "-m"]);
    const common = withLane({
      ...(stashRef ? { stashRef } : {}),
      includeUntracked: !readFlag(args, ["--tracked-only"]),
      ...(message ? { message } : {}),
    });
    const toolNameByAction: Record<string, string> = {
      push: "stash_push",
      save: "stash_push",
      list: "list_stashes",
      ls: "list_stashes",
      apply: "stash_apply",
      pop: "stash_pop",
      drop: "stash_drop",
      clear: "stash_clear",
    };
    const toolName = toolNameByAction[action];
    if (!toolName) throw new CliUsageError(`Unknown stash action '${action}'.`);
    return { kind: "execute", label: `git stash ${action}`, steps: [actionCallStep("result", toolName, common)] };
  }
  if (sub === "diff") {
    return buildDiffPlan([...(laneId ? ["--lane", laneId] : []), ...args]);
  }

  if (sub === "stage" || sub === "unstage" || sub === "discard" || sub === "restore") {
    const pathArg = requireValue(readValue(args, ["--path"]) ?? firstPositional(args), "path");
    const actionBySub: Record<string, string> = {
      stage: "stageFile",
      unstage: "unstageFile",
      discard: "discardFile",
      restore: "restoreStagedFile",
    };
    return { kind: "execute", label: `git ${sub}`, steps: [actionStep("result", "git", actionBySub[sub]!, withLane({ path: pathArg }))] };
  }
  if (sub === "stage-all" || sub === "unstage-all") {
    const paths = args.filter((entry) => !entry.startsWith("-"));
    const action = sub === "stage-all" ? "stageAll" : "unstageAll";
    return { kind: "execute", label: `git ${sub}`, steps: [actionStep("result", "git", action, withLane({ paths }))] };
  }
  if (sub === "files" || sub === "commit-files") {
    const commitSha = requireValue(readValue(args, ["--commit", "--sha"]) ?? firstPositional(args), "commitSha");
    return { kind: "execute", label: "git commit files", steps: [actionStep("result", "git", "listCommitFiles", withLane({ commitSha }))] };
  }
  if (sub === "message" || sub === "commit-message" || sub === "show-message") {
    const commitSha = readValue(args, ["--commit", "--sha"]) ?? firstPositional(args);
    if (commitSha) return { kind: "execute", label: "git commit message", steps: [actionStep("result", "git", "getCommitMessage", withLane({ commitSha }))] };
    return { kind: "execute", label: "git commit message", steps: [actionCallStep("result", "generate_commit_message", withLane({ amend: readFlag(args, ["--amend"]) }))] };
  }
  if (sub === "history" || sub === "file-history") {
    const filePath = requireValue(readValue(args, ["--path"]) ?? firstPositional(args), "path");
    return { kind: "execute", label: "git file history", steps: [actionStep("result", "git", "getFileHistory", withLane({ path: filePath, limit: readIntOption(args, ["--limit"]) }))] };
  }
  if (sub === "revert" || sub === "cherry-pick") {
    const commitSha = requireValue(readValue(args, ["--commit", "--sha"]) ?? firstPositional(args), "commitSha");
    return { kind: "execute", label: `git ${sub}`, steps: [actionStep("result", "git", sub === "revert" ? "revertCommit" : "cherryPickCommit", withLane({ commitSha }))] };
  }
  const actionAliases: Record<string, string> = {
    commits: "listRecentCommits",
    sync: "sync",
  };
  return { kind: "execute", label: `git ${sub}`, steps: [actionStep("result", "git", actionAliases[sub] ?? sub, withLane())] };
}

function buildDiffPlan(args: string[]): CliPlan {
  const sub = firstPositional(args) ?? "changes";
  if (sub === "actions") return { kind: "execute", label: "diff actions", steps: [listActionsStep("actions", "diff")] };
  const laneId = readLaneId(args);
  const withLane = (base: JsonObject = {}) => collectGenericObjectArgs(args, { ...base, ...(laneId ? { laneId } : {}) });
  if (sub === "changes" || sub === "summary") {
    const id = requireValue(laneId ?? readValue(args, ["--lane", "--lane-id"]), "laneId");
    return {
      kind: "execute",
      label: "diff changes",
      steps: [actionArgsListStep("result", "diff", "getChanges", [id])],
    };
  }
  if (sub === "file") {
    const filePath = requireValue(readValue(args, ["--path"]) ?? firstPositional(args), "path");
    return {
      kind: "execute",
      label: "diff file",
      steps: [actionStep("result", "diff", "getFileDiff", withLane({
        filePath,
        mode: readValue(args, ["--mode"]) ?? "unstaged",
        compareRef: readValue(args, ["--compare-ref", "--base"]),
        compareTo: readValue(args, ["--compare-to", "--head"]),
      }))],
    };
  }
  return { kind: "execute", label: `diff ${sub}`, steps: [actionStep("result", "diff", sub, withLane())] };
}

function buildPrPlan(args: string[]): CliPlan {
  const sub = firstPositional(args) ?? "list";
  if (sub === "actions") return { kind: "execute", label: "PR actions", steps: [listActionsStep("actions", "pr")] };
  if (sub === "action") return { kind: "execute", label: "PR action", steps: [buildActionRunStep(["pr", ...args])] };

  const prId = readPrId(args);
  const withPr = (base: JsonObject = {}) => collectGenericObjectArgs(args, { ...base, ...(prId ? { prId } : {}) });

  if (sub === "list" || sub === "ls") return { kind: "execute", label: "PR list", steps: [actionStep("result", "pr", "listAll", collectGenericObjectArgs(args))] };
  if (sub === "show" || sub === "detail" || sub === "view") {
    const id = requireValue(prId ?? firstPositional(args), "prId");
    return { kind: "execute", label: "PR detail", steps: [actionArgsListStep("result", "pr", "getDetail", [id])] };
  }
  if (sub === "refresh") return { kind: "execute", label: "PR refresh", steps: [actionStep("result", "pr", "refresh", withPr({ prId: prId ?? firstPositional(args) }))] };
  if (sub === "create") {
    const laneId = readLaneId(args) ?? readValue(args, ["--lane-id"]);
    const input: JsonObject = {};
    input.laneId = requireValue(laneId, "laneId");
    maybePut(input, "baseBranch", readValue(args, ["--base", "--base-branch"]));
    maybePut(input, "title", readValue(args, ["--title"]));
    maybePut(input, "body", readValue(args, ["--body"]));
    input.draft = readFlag(args, ["--draft"]);
    return { kind: "execute", label: "PR create", steps: [actionCallStep("result", "create_pr_from_lane", collectGenericObjectArgs(args, input))] };
  }
  if (sub === "health") return { kind: "execute", label: "PR health", steps: [actionCallStep("result", "get_pr_health", withPr({ prId: prId ?? firstPositional(args) }))] };
  if (sub === "checks") return { kind: "execute", label: "PR checks", steps: [actionCallStep("result", "pr_get_checks", withPr({ prId: requireValue(prId ?? firstPositional(args), "prId") }))] };
  if (sub === "comments" || sub === "review-comments") return { kind: "execute", label: "PR comments", steps: [actionCallStep("result", "pr_get_review_comments", withPr({ prId: requireValue(prId ?? firstPositional(args), "prId") }))] };
  if (sub === "rerun" || sub === "rerun-failed-checks") return { kind: "execute", label: "PR rerun failed checks", steps: [actionCallStep("result", "pr_rerun_failed_checks", withPr({ prId: prId ?? firstPositional(args) }))] };
  if (sub === "comment") return { kind: "execute", label: "PR comment", steps: [actionCallStep("result", "pr_add_comment", withPr({ prId: prId ?? firstPositional(args), body: readValue(args, ["--body"]) }))] };
  if (sub === "reply") return { kind: "execute", label: "PR thread reply", steps: [actionCallStep("result", "pr_reply_to_review_thread", withPr({ prId: prId ?? firstPositional(args), threadId: readValue(args, ["--thread", "--thread-id"]), body: readValue(args, ["--body"]) }))] };
  if (sub === "resolve-thread") return { kind: "execute", label: "PR resolve thread", steps: [actionCallStep("result", "pr_resolve_review_thread", withPr({ prId: requireValue(prId ?? firstPositional(args), "prId"), threadId: requireValue(readValue(args, ["--thread", "--thread-id"]), "threadId") }))] };
  if (sub === "title" || sub === "update-title") return { kind: "execute", label: "PR update title", steps: [actionCallStep("result", "pr_update_title", withPr({ prId: prId ?? firstPositional(args), title: readValue(args, ["--title"]) }))] };
  if (sub === "body" || sub === "update-body") return { kind: "execute", label: "PR update body", steps: [actionCallStep("result", "pr_update_body", withPr({ prId: prId ?? firstPositional(args), body: readValue(args, ["--body"]) ?? "" }))] };
  if (sub === "link") {
    const laneId = readLaneId(args) ?? firstPositional(args);
    const prUrlOrNumber =
      readValue(args, ["--url", "--pr-url", "--number", "--pr-number"])
      ?? firstPositional(args);
    return {
      kind: "execute",
      label: "PR link",
      steps: [
        actionStep("result", "pr", "linkToLane", collectGenericObjectArgs(args, {
          laneId: requireValue(laneId, "laneId"),
          prUrlOrNumber: requireValue(prUrlOrNumber, "prUrlOrNumber"),
        })),
      ],
    };
  }

  const scalarPrActions: Record<string, string> = {
    status: "getStatus",
    files: "getFiles",
    "action-runs": "getActionRuns",
    activity: "getActivity",
    reviews: "getReviews",
    threads: "getReviewThreads",
    deployments: "getDeployments",
    github: "openInGitHub",
    "conflict-analysis": "getConflictAnalysis",
    "merge-context": "getMergeContext",
  };
  if (scalarPrActions[sub]) {
    const id = requireValue(prId ?? firstPositional(args), "prId");
    return { kind: "execute", label: `PR ${sub}`, steps: [actionArgsListStep("result", "pr", scalarPrActions[sub]!, [id])] };
  }
  if (sub === "draft-description") return { kind: "execute", label: "PR draft description", steps: [actionStep("result", "pr", "draftDescription", collectGenericObjectArgs(args, { laneId: readLaneId(args) ?? firstPositional(args) }))] };
  if (sub === "update-description") return { kind: "execute", label: "PR update description", steps: [actionStep("result", "pr", "updateDescription", withPr({ prId: prId ?? firstPositional(args), title: readValue(args, ["--title"]), body: readValue(args, ["--body"]) }))] };
  if (sub === "delete" || sub === "land" || sub === "close" || sub === "reopen") {
    const id = requireValue(prId ?? firstPositional(args), "prId");
    const actionBySub: Record<string, string> = { delete: "delete", land: "land", close: "closePr", reopen: "reopenPr" };
    return { kind: "execute", label: `PR ${sub}`, steps: [actionStep("result", "pr", actionBySub[sub]!, collectGenericObjectArgs(args, { prId: id, method: readValue(args, ["--method"]) }))] };
  }
  if (sub === "land-stack" || sub === "land-stack-enhanced") {
    return { kind: "execute", label: `PR ${sub}`, steps: [actionStep("result", "pr", sub === "land-stack" ? "landStack" : "landStackEnhanced", collectGenericObjectArgs(args, { rootLaneId: readValue(args, ["--root", "--root-lane"]) ?? firstPositional(args) }))] };
  }
  if (sub === "labels") {
    const mode = firstPositional(args) ?? "set";
    if (mode !== "set") throw new CliUsageError("prs labels supports set.");
    const id = requireValue(prId ?? firstPositional(args), "prId");
    return { kind: "execute", label: "PR labels set", steps: [actionStep("result", "pr", "setLabels", collectGenericObjectArgs(args, { prId: id, labels: args.filter((entry) => !entry.startsWith("-")) }))] };
  }
  if (sub === "reviewers") {
    const mode = firstPositional(args) ?? "request";
    if (mode !== "request") throw new CliUsageError("prs reviewers supports request.");
    const id = requireValue(prId ?? firstPositional(args), "prId");
    return { kind: "execute", label: "PR reviewers request", steps: [actionStep("result", "pr", "requestReviewers", collectGenericObjectArgs(args, { prId: id, reviewers: args.filter((entry) => !entry.startsWith("-")) }))] };
  }
  if (sub === "review") {
    const mode = firstPositional(args) ?? "submit";
    if (mode !== "submit") throw new CliUsageError("prs review supports submit.");
    const id = requireValue(prId ?? firstPositional(args), "prId");
    return { kind: "execute", label: "PR review submit", steps: [actionStep("result", "pr", "submitReview", collectGenericObjectArgs(args, { prId: id, event: readValue(args, ["--event"]) ?? "comment", body: readValue(args, ["--body"]) ?? "" }))] };
  }
  if (sub === "comment-react") {
    const id = requireValue(prId ?? firstPositional(args), "prId");
    return { kind: "execute", label: "PR comment react", steps: [actionStep("result", "pr", "reactToComment", collectGenericObjectArgs(args, { prId: id, commentId: readValue(args, ["--comment", "--comment-id"]), content: readValue(args, ["--content"]) }))] };
  }
  if (sub === "review-comment") {
    const mode = firstPositional(args) ?? "post";
    if (mode !== "post") throw new CliUsageError("prs review-comment supports post.");
    const id = requireValue(prId ?? firstPositional(args), "prId");
    return { kind: "execute", label: "PR review comment post", steps: [actionStep("result", "pr", "postReviewComment", collectGenericObjectArgs(args, { prId: id, threadId: readValue(args, ["--thread", "--thread-id"]), body: readValue(args, ["--body"]) }))] };
  }
  if (sub === "thread") {
    const mode = firstPositional(args) ?? "set-resolved";
    if (mode !== "set-resolved") throw new CliUsageError("prs thread supports set-resolved.");
    const id = requireValue(prId ?? firstPositional(args), "prId");
    return { kind: "execute", label: "PR thread set resolved", steps: [actionStep("result", "pr", "setReviewThreadResolved", collectGenericObjectArgs(args, { prId: id, threadId: readValue(args, ["--thread", "--thread-id"]), resolved: !readFlag(args, ["--unresolved"]) }))] };
  }
  if (sub === "ai-review-summary") return { kind: "execute", label: "PR AI review summary", steps: [actionStep("result", "pr", "aiReviewSummary", withPr({ prId: prId ?? firstPositional(args) }))] };
  if (sub === "mobile-snapshot") return { kind: "execute", label: "PR mobile snapshot", steps: [actionArgsListStep("result", "pr", "getMobileSnapshot", [])] };
  if (sub === "snapshots") {
    const mode = firstPositional(args) ?? "list";
    const action = mode === "refresh" ? "refreshSnapshots" : "listSnapshots";
    return { kind: "execute", label: `PR snapshots ${mode}`, steps: [actionStep("result", "pr", action, withPr({ prId: prId ?? firstPositional(args) }))] };
  }
  if (sub === "github-snapshot") return { kind: "execute", label: "PR GitHub snapshot", steps: [actionStep("result", "pr", "getGithubSnapshot", collectGenericObjectArgs(args, { force: readFlag(args, ["--force"]) }))] };
  if (sub === "conflicts") {
    const mode = firstPositional(args) ?? "list";
    if (mode === "list") return { kind: "execute", label: "PR conflicts list", steps: [actionArgsListStep("result", "pr", "listWithConflicts", [])] };
    const id = requireValue(prId ?? firstPositional(args), "prId");
    const action = mode === "analysis" ? "getConflictAnalysis" : "getMergeContext";
    return { kind: "execute", label: `PR conflicts ${mode}`, steps: [actionArgsListStep("result", "pr", action, [id])] };
  }

  if (sub === "path-to-merge" || sub === "resolve" || sub === "issue-resolution") {
    let mode = "start";
    let positionalPrId = firstPositional(args);
    if (positionalPrId === "start" || positionalPrId === "preview") {
      mode = positionalPrId;
      positionalPrId = firstPositional(args);
    }
    const id = requireValue(prId ?? positionalPrId, "prId");
    const scope = readValue(args, ["--scope"]) ?? "both";
    const modelId = requireValue(readValue(args, ["--model", "--model-id"]), "--model");
    const input: JsonObject = {
      prId: id,
      scope,
      modelId,
    };
    maybePut(input, "reasoning", readValue(args, ["--reasoning"]));
    maybePut(input, "permissionMode", readValue(args, ["--permission-mode", "--permissions"]));
    maybePut(input, "additionalInstructions", readValue(args, ["--instructions", "--additional-instructions"]));
    const maxRounds = readIntOption(args, ["--max-rounds", "--rounds"]);
    const autoMerge = readFlag(args, ["--auto-merge"]);
    const noAutoMerge = readFlag(args, ["--no-auto-merge"]);
    const mergeMethod = readValue(args, ["--merge-method"]);
    const steps: InvocationStep[] = [];
    if (maxRounds != null || autoMerge || noAutoMerge || mergeMethod) {
      steps.push(actionArgsListStep("pipelineSettings", "issue_inventory", "savePipelineSettings", [
        id,
        {
          ...(maxRounds != null ? { maxRounds } : {}),
          ...(autoMerge || noAutoMerge ? { autoMerge: autoMerge && !noAutoMerge } : {}),
          ...(mergeMethod ? { mergeMethod } : {}),
        },
      ]));
    }
    steps.push(actionCallStep("result", mode === "preview" ? "pr_preview_issue_resolution_prompt" : "pr_start_issue_resolution", collectGenericObjectArgs(args, input)));
    return { kind: "execute", label: `PR path-to-merge ${mode}`, steps };
  }

  if (sub === "pipeline") {
    const mode = firstPositional(args) ?? "get";
    const id = requireValue(prId ?? firstPositional(args), "prId");
    if (mode === "get") return { kind: "execute", label: "PR pipeline", steps: [actionArgsListStep("result", "issue_inventory", "getPipelineSettings", [id])] };
    if (mode === "delete") return { kind: "execute", label: "PR pipeline delete", steps: [actionArgsListStep("result", "issue_inventory", "deletePipelineSettings", [id])] };
    const maxRounds = readIntOption(args, ["--max-rounds", "--rounds"]);
    const mergeMethod = readValue(args, ["--merge-method"]);
    const settings = collectGenericObjectArgs(args, {
      ...(maxRounds != null ? { maxRounds } : {}),
      ...(mergeMethod ? { mergeMethod } : {}),
    });
    return { kind: "execute", label: "PR pipeline save", steps: [actionArgsListStep("result", "issue_inventory", "savePipelineSettings", [id, settings])] };
  }

  if (sub === "queue") {
    const mode = firstPositional(args) ?? "create";
    if (mode === "state" || mode === "list") {
      const groupId = requireValue(readValue(args, ["--group", "--group-id"]) ?? firstPositional(args), "groupId");
      return { kind: "execute", label: `queue ${mode}`, steps: [actionArgsListStep("result", "pr", mode === "state" ? "getQueueState" : "listGroupPrs", [groupId])] };
    }
    if (mode === "reorder") {
      return { kind: "execute", label: "queue reorder", steps: [actionStep("result", "pr", "reorderQueuePrs", collectGenericObjectArgs(args, { groupId: readValue(args, ["--group", "--group-id"]) ?? firstPositional(args) }))] };
    }
    if (mode === "land-next") {
      return { kind: "execute", label: "queue land next", steps: [actionCallStep("result", "land_queue_next", collectGenericObjectArgs(args, { groupId: readValue(args, ["--group", "--group-id"]) ?? firstPositional(args), method: readValue(args, ["--method"]) ?? "squash" }))] };
    }
    return { kind: "execute", label: "queue create", steps: [actionCallStep("result", "create_queue", collectGenericObjectArgs(args))] };
  }

  if (sub === "integration") {
    const mode = firstPositional(args) ?? "simulate";
    const integrationMap: Record<string, string> = {
      proposals: "listIntegrationProposals",
      workflows: "listIntegrationWorkflows",
      update: "updateIntegrationProposal",
      delete: "deleteIntegrationProposal",
      commit: "commitIntegration",
      "resolve-start": "startIntegrationResolution",
      "resolve-state": "getIntegrationResolutionState",
      "recheck-step": "recheckIntegrationStep",
    };
    if (integrationMap[mode]) {
      return { kind: "execute", label: `integration ${mode}`, steps: [actionStep("result", "pr", integrationMap[mode]!, collectGenericObjectArgs(args))] };
    }
    if (mode === "lane") {
      const laneMode = firstPositional(args) ?? "create";
      if (laneMode !== "create") throw new CliUsageError("prs integration lane supports create.");
      return { kind: "execute", label: "integration lane create", steps: [actionStep("result", "pr", "createIntegrationLane", collectGenericObjectArgs(args))] };
    }
    if (mode === "cleanup") {
      const cleanupMode = firstPositional(args) ?? "run";
      return { kind: "execute", label: `integration cleanup ${cleanupMode}`, steps: [actionStep("result", "pr", cleanupMode === "dismiss" ? "dismissIntegrationCleanup" : "cleanupIntegrationWorkflow", collectGenericObjectArgs(args))] };
    }
    const tool = mode === "create" ? "create_integration" : "simulate_integration";
    return { kind: "execute", label: `integration ${mode}`, steps: [actionCallStep("result", tool, collectGenericObjectArgs(args))] };
  }

  if (sub === "inventory") {
    const first = firstPositional(args);
    const knownModes = new Set(["refresh", "get", "new", "mark-sent", "mark-fixed", "dismiss", "escalate", "reset"]);
    const mode = first && knownModes.has(first) ? first : "refresh";
    const positionalPrId = mode === "refresh" ? first : firstPositional(args);
    if (mode === "refresh") {
      return { kind: "execute", label: "PR inventory", steps: [actionCallStep("result", "pr_refresh_issue_inventory", withPr({ prId: requireValue(prId ?? positionalPrId, "prId") }))] };
    }
    const actionByMode: Record<string, string> = {
      get: "getInventory",
      new: "getNewItems",
      "mark-sent": "markSentToAgent",
      "mark-fixed": "markFixed",
      dismiss: "markDismissed",
      escalate: "markEscalated",
      reset: "resetInventory",
    };
    const action = actionByMode[mode];
    if (!action) throw new CliUsageError("prs inventory supports get, new, mark-sent, mark-fixed, dismiss, escalate, or reset.");
    const id = requireValue(prId ?? positionalPrId, "prId");
    const itemIds = args.filter((entry) => !entry.startsWith("-"));
    const argsListByMode: Record<string, unknown[]> = {
      get: [id],
      new: [id],
      "mark-sent": [id, itemIds, readValue(args, ["--session", "--session-id"]) ?? "", readIntOption(args, ["--round"], 0) ?? 0],
      "mark-fixed": [id, itemIds],
      dismiss: [id, itemIds, readValue(args, ["--reason"]) ?? ""],
      escalate: [id, itemIds],
      reset: [id],
    };
    return { kind: "execute", label: `PR inventory ${mode}`, steps: [actionArgsListStep("result", "issue_inventory", action, argsListByMode[mode] ?? [id])] };
  }

  if (sub === "convergence") {
    const mode = firstPositional(args) ?? "status";
    const actionByMode: Record<string, string> = {
      status: "getConvergenceStatus",
      runtime: "getConvergenceRuntime",
      get: "getConvergenceRuntime",
      save: "saveConvergenceRuntime",
      reset: "resetConvergenceRuntime",
      reconcile: "reconcileConvergenceSessionExit",
    };
    const action = actionByMode[mode];
    if (!action) throw new CliUsageError("prs convergence supports status, runtime, save, reset, or reconcile.");
    const id = requireValue(prId ?? firstPositional(args), "prId");
    if (mode === "save") {
      return { kind: "execute", label: "PR convergence save", steps: [actionArgsListStep("result", "issue_inventory", action, [id, collectGenericObjectArgs(args)])] };
    }
    if (mode === "reconcile") {
      return { kind: "execute", label: "PR convergence reconcile", steps: [actionStep("result", "issue_inventory", action, collectGenericObjectArgs(args, { prId: id }))] };
    }
    return { kind: "execute", label: `PR convergence ${mode}`, steps: [actionArgsListStep("result", "issue_inventory", action, [id])] };
  }

  return { kind: "execute", label: `PR ${sub}`, steps: [actionStep("result", "pr", sub, withPr())] };
}

function buildRunPlan(args: string[]): CliPlan {
  const sub = firstPositional(args) ?? "ps";
  if (sub === "actions") return { kind: "execute", label: "run actions", steps: [listActionsStep("actions", "process")] };
  if (sub === "action") return { kind: "execute", label: "run action", steps: [buildActionRunStep(["process", ...args])] };
  if (sub === "defs" || sub === "definitions") return { kind: "execute", label: "process definitions", steps: [actionStep("result", "process", "listDefinitions", collectGenericObjectArgs(args))] };
  const laneId = readLaneId(args);
  const processId = readValue(args, ["--process", "--process-id"]) ?? firstPositional(args);
  const runId = readValue(args, ["--run", "--run-id"]);
  const withProcess = (base: JsonObject = {}) => collectGenericObjectArgs(args, {
    ...base,
    ...(laneId ? { laneId } : {}),
    ...(processId ? { processId } : {}),
    ...(runId ? { runId } : {}),
  });
  if (sub === "ps" || sub === "list" || sub === "runtime") {
    const id = requireValue(laneId, "laneId");
    return { kind: "execute", label: "process runtime", steps: [actionArgsListStep("result", "process", "listRuntime", [id])] };
  }
  if (sub === "start" || sub === "stop" || sub === "restart" || sub === "kill") {
    return { kind: "execute", label: `process ${sub}`, steps: [actionStep("result", "process", sub, withProcess({ laneId: requireValue(laneId, "laneId"), processId: requireValue(processId, "processId") }))] };
  }
  if (sub === "logs" || sub === "log") {
    return { kind: "execute", label: "process logs", steps: [actionStep("result", "process", "getLogTail", withProcess({ laneId: requireValue(laneId, "laneId"), processId: requireValue(processId, "processId"), maxBytes: readIntOption(args, ["--max-bytes", "--tail-bytes"], 80_000) }))] };
  }
  if (sub === "stack") {
    const mode = requireValue(firstPositional(args), "stack action");
    const stackId = requireValue(readValue(args, ["--stack", "--stack-id"]) ?? firstPositional(args), "stackId");
    const methodByMode: Record<string, string> = { start: "startStack", stop: "stopStack", restart: "restartStack" };
    const method = methodByMode[mode];
    if (!method) throw new CliUsageError("run stack supports start, stop, or restart.");
    return { kind: "execute", label: `stack ${mode}`, steps: [actionStep("result", "process", method, collectGenericObjectArgs(args, { laneId: requireValue(laneId, "laneId"), stackId }))] };
  }
  if (sub === "start-all" || sub === "stop-all") return { kind: "execute", label: `process ${sub}`, steps: [actionStep("result", "process", sub === "start-all" ? "startAll" : "stopAll", collectGenericObjectArgs(args, { ...(laneId ? { laneId } : {}) }))] };
  return { kind: "execute", label: `process ${sub}`, steps: [actionStep("result", "process", sub, withProcess())] };
}

function buildShellPlan(args: string[]): CliPlan {
  const sub = firstPositional(args) ?? "start";
  if (sub === "actions") return { kind: "execute", label: "shell actions", steps: [listActionsStep("actions", "pty")] };
  if (sub === "start" || sub === "create") {
    const laneId = readLaneId(args);
    const startupCommandIndex = args.indexOf("--");
    const startupCommand = startupCommandIndex >= 0
      ? args.splice(startupCommandIndex + 1).map(shellEscapeToken).join(" ")
      : readValue(args, ["--command", "-c"]);
    if (startupCommandIndex >= 0) args.splice(startupCommandIndex, 1);
    const input = collectGenericObjectArgs(args, {
      ...(laneId ? { laneId } : {}),
      cwd: readValue(args, ["--cwd"]),
      title: readValue(args, ["--title"]),
      startupCommand,
      toolType: readValue(args, ["--tool-type"]) ?? "shell",
      cols: readIntOption(args, ["--cols"], 120),
      rows: readIntOption(args, ["--rows"], 36),
      tracked: !readFlag(args, ["--untracked"]),
    });
    return { kind: "execute", label: "shell start", steps: [actionStep("result", "pty", "create", input)] };
  }
  if (sub === "write") return { kind: "execute", label: "shell write", steps: [actionStep("result", "pty", "write", collectGenericObjectArgs(args, { ptyId: requireValue(readValue(args, ["--pty", "--pty-id"]) ?? firstPositional(args), "ptyId"), data: readValue(args, ["--data"]) ?? "" }))] };
  if (sub === "resize") return { kind: "execute", label: "shell resize", steps: [actionStep("result", "pty", "resize", collectGenericObjectArgs(args, { ptyId: requireValue(readValue(args, ["--pty", "--pty-id"]) ?? firstPositional(args), "ptyId"), cols: readIntOption(args, ["--cols"], 120), rows: readIntOption(args, ["--rows"], 36) }))] };
  if (sub === "close" || sub === "dispose") return { kind: "execute", label: "shell close", steps: [actionStep("result", "pty", "dispose", collectGenericObjectArgs(args, { ptyId: requireValue(readValue(args, ["--pty", "--pty-id"]) ?? firstPositional(args), "ptyId"), sessionId: readValue(args, ["--session", "--session-id"]) }))] };
  return { kind: "execute", label: `shell ${sub}`, steps: [actionStep("result", "pty", sub, collectGenericObjectArgs(args))] };
}

function buildChatPlan(args: string[]): CliPlan {
  const sub = firstPositional(args) ?? "list";
  if (sub === "actions") return { kind: "execute", label: "chat actions", steps: [listActionsStep("actions", "chat")] };
  const sessionId = readValue(args, ["--session", "--session-id"]) ?? (sub !== "create" && sub !== "list" ? firstPositional(args) : null);
  const withSession = (base: JsonObject = {}) => collectGenericObjectArgs(args, { ...base, ...(sessionId ? { sessionId } : {}) });
  if (sub === "list" || sub === "ls") return { kind: "execute", label: "chat list", steps: [actionStep("result", "chat", "listSessions", collectGenericObjectArgs(args))] };
  if (sub === "show" || sub === "status") return { kind: "execute", label: "chat status", steps: [actionStep("result", "chat", "getSessionSummary", withSession())] };
  if (sub === "create" || sub === "spawn") return { kind: "execute", label: "chat create", steps: [actionStep("result", "chat", "createSession", collectGenericObjectArgs(args, { laneId: readLaneId(args), provider: readValue(args, ["--provider"]), modelId: readValue(args, ["--model", "--model-id"]), permissionMode: readValue(args, ["--permission-mode", "--permissions"]), surface: readValue(args, ["--surface"]) ?? "work" }))] };
  if (sub === "send") return { kind: "execute", label: "chat send", steps: [actionStep("result", "chat", "sendMessage", withSession({ sessionId: requireValue(sessionId, "sessionId"), text: requireValue(readValue(args, ["--text", "--message"]) ?? args.join(" "), "message text") }))] };
  if (sub === "interrupt") return { kind: "execute", label: "chat interrupt", steps: [actionStep("result", "chat", "interrupt", withSession({ sessionId: requireValue(sessionId, "sessionId") }))] };
  if (sub === "resume") return { kind: "execute", label: "chat resume", steps: [actionStep("result", "chat", "resumeSession", withSession())] };
  if (sub === "delete" || sub === "rm") return { kind: "execute", label: "chat delete", steps: [actionStep("result", "chat", "deleteSession", withSession())] };
  if (sub === "models") return { kind: "execute", label: "chat models", steps: [actionStep("result", "chat", "getAvailableModels", collectGenericObjectArgs(args))] };
  if (sub === "slash") return { kind: "execute", label: "chat slash commands", steps: [actionStep("result", "chat", "getSlashCommands", collectGenericObjectArgs(args))] };
  return { kind: "execute", label: `chat ${sub}`, steps: [actionStep("result", "chat", sub, withSession())] };
}

function buildTestsPlan(args: string[]): CliPlan {
  const sub = firstPositional(args) ?? "list";
  if (sub === "actions") return { kind: "execute", label: "test actions", steps: [listActionsStep("actions", "tests")] };
  if (sub === "list" || sub === "suites") return { kind: "execute", label: "test suites", steps: [actionStep("result", "tests", "listSuites", collectGenericObjectArgs(args))] };
  if (sub === "run") {
    const laneId = requireValue(readLaneId(args), "laneId");
    const suiteId = readValue(args, ["--suite", "--suite-id"]) ?? firstPositional(args);
    const command = readValue(args, ["--command", "-c"]);
    if (!suiteId && !command) throw new CliUsageError("tests run requires --suite <id> or --command <command>.");
    const input = collectGenericObjectArgs(args, {
      laneId,
      suiteId,
      command,
      waitForCompletion: readFlag(args, ["--wait"]),
      timeoutMs: readIntOption(args, ["--timeout-ms"]),
      maxLogBytes: readIntOption(args, ["--max-log-bytes"]),
    });
    return { kind: "execute", label: "test run", steps: [actionCallStep("result", "run_tests", input)] };
  }
  if (sub === "stop") return { kind: "execute", label: "test stop", steps: [actionStep("result", "tests", "stop", collectGenericObjectArgs(args, { runId: requireValue(readValue(args, ["--run", "--run-id"]) ?? firstPositional(args), "runId") }))] };
  if (sub === "runs") return { kind: "execute", label: "test runs", steps: [actionStep("result", "tests", "listRuns", collectGenericObjectArgs(args, { laneId: readLaneId(args), suiteId: readValue(args, ["--suite", "--suite-id"]), limit: readIntOption(args, ["--limit"]) }))] };
  if (sub === "logs" || sub === "log") return { kind: "execute", label: "test logs", steps: [actionStep("result", "tests", "getLogTail", collectGenericObjectArgs(args, { runId: requireValue(readValue(args, ["--run", "--run-id"]) ?? firstPositional(args), "runId"), maxBytes: readIntOption(args, ["--max-bytes"], 220_000) }))] };
  return { kind: "execute", label: `tests ${sub}`, steps: [actionStep("result", "tests", sub, collectGenericObjectArgs(args))] };
}

function readFileTextInput(args: string[]): string | undefined {
  const text = readValue(args, ["--text"]);
  if (text != null) return text;
  const filePath = readValue(args, ["--from-file"]);
  if (filePath != null) return fs.readFileSync(path.resolve(filePath), "utf8");
  if (readFlag(args, ["--stdin"])) return fs.readFileSync(0, "utf8");
  return undefined;
}

function buildFilesPlan(args: string[]): CliPlan {
  const sub = firstPositional(args) ?? "workspaces";
  if (sub === "actions") return { kind: "execute", label: "file actions", steps: [listActionsStep("actions", "file")] };
  const workspaceId = readValue(args, ["--workspace", "--workspace-id"]);
  const withWorkspace = (base: JsonObject = {}) => collectGenericObjectArgs(args, { ...base, ...(workspaceId ? { workspaceId } : {}) });

  if (sub === "workspaces" || sub === "workspace" || sub === "roots") {
    return { kind: "execute", label: "file workspaces", steps: [actionStep("result", "file", "listWorkspaces", collectGenericObjectArgs(args, { laneId: readLaneId(args) }))] };
  }
  if (sub === "tree" || sub === "ls") {
    return { kind: "execute", label: "file tree", steps: [actionStep("result", "file", "listTree", withWorkspace({ parentPath: readValue(args, ["--path"]) ?? firstPositional(args), depth: readIntOption(args, ["--depth"]), includeIgnored: readFlag(args, ["--include-ignored"]) }))] };
  }
  if (sub === "read" || sub === "cat") {
    return { kind: "execute", label: "file read", steps: [actionStep("result", "file", "readFile", withWorkspace({ path: requireValue(readValue(args, ["--path"]) ?? firstPositional(args), "path") }))] };
  }
  if (sub === "write") {
    const text = readFileTextInput(args);
    if (text == null) throw new CliUsageError("files write requires --text, --from-file, or --stdin.");
    return { kind: "execute", label: "file write", steps: [actionStep("result", "file", "writeWorkspaceText", withWorkspace({ path: requireValue(readValue(args, ["--path"]) ?? firstPositional(args), "path"), text }))] };
  }
  if (sub === "create") {
    return { kind: "execute", label: "file create", steps: [actionStep("result", "file", "createFile", withWorkspace({ path: requireValue(readValue(args, ["--path"]) ?? firstPositional(args), "path"), content: readFileTextInput(args) ?? "" }))] };
  }
  if (sub === "mkdir") {
    return { kind: "execute", label: "file mkdir", steps: [actionStep("result", "file", "createDirectory", withWorkspace({ path: requireValue(readValue(args, ["--path"]) ?? firstPositional(args), "path") }))] };
  }
  if (sub === "rename" || sub === "mv") {
    return { kind: "execute", label: "file rename", steps: [actionStep("result", "file", "rename", withWorkspace({ oldPath: readValue(args, ["--old", "--old-path"]) ?? firstPositional(args), newPath: readValue(args, ["--new", "--new-path"]) ?? firstPositional(args) }))] };
  }
  if (sub === "delete" || sub === "rm") {
    return { kind: "execute", label: "file delete", steps: [actionStep("result", "file", "deletePath", withWorkspace({ path: requireValue(readValue(args, ["--path"]) ?? firstPositional(args), "path") }))] };
  }
  if (sub === "quick-open") {
    return { kind: "execute", label: "file quick-open", steps: [actionStep("result", "file", "quickOpen", withWorkspace({ query: readValue(args, ["--query", "-q"]) ?? args.join(" "), limit: readIntOption(args, ["--limit"]), includeIgnored: readFlag(args, ["--include-ignored"]) }))] };
  }
  if (sub === "search") {
    return { kind: "execute", label: "file search", steps: [actionStep("result", "file", "searchText", withWorkspace({ query: requireValue(readValue(args, ["--query", "-q"]) ?? args.join(" "), "query"), limit: readIntOption(args, ["--limit"]), includeIgnored: readFlag(args, ["--include-ignored"]) }))] };
  }
  return { kind: "execute", label: `files ${sub}`, steps: [actionStep("result", "file", sub, withWorkspace())] };
}

function buildProofPlan(args: string[]): CliPlan {
  const sub = firstPositional(args) ?? "status";
  if (sub === "actions") return { kind: "execute", label: "proof actions", steps: [listActionsStep("actions", "computer_use_artifacts")] };
  if (sub === "status" || sub === "backends") return { kind: "execute", label: "proof backend status", steps: [actionCallStep("result", "get_computer_use_backend_status", collectGenericObjectArgs(args))] };
  if (sub === "environment") return { kind: "execute", label: "computer-use environment", steps: [actionCallStep("result", "get_environment_info", collectGenericObjectArgs(args))] };
  if (sub === "list" || sub === "ls") return { kind: "execute", label: "proof list", steps: [actionCallStep("result", "list_computer_use_artifacts", collectGenericObjectArgs(args))] };
  if (sub === "ingest") return { kind: "execute", label: "proof ingest", steps: [actionCallStep("result", "ingest_computer_use_artifacts", collectGenericObjectArgs(args))] };
  if (sub === "screenshot") return { kind: "execute", label: "computer-use screenshot", steps: [actionCallStep("result", "screenshot_environment", collectGenericObjectArgs(args))] };
  if (sub === "record") return { kind: "execute", label: "computer-use record", steps: [actionCallStep("result", "record_environment", collectGenericObjectArgs(args, { durationSec: readNumberOption(args, ["--seconds", "--duration-sec"]) }))] };
  if (sub === "launch") return { kind: "execute", label: "computer-use launch", steps: [actionCallStep("result", "launch_app", collectGenericObjectArgs(args, { app: readValue(args, ["--app"]) ?? firstPositional(args) }))] };
  if (sub === "interact") return { kind: "execute", label: "computer-use interact", steps: [actionCallStep("result", "interact_gui", collectGenericObjectArgs(args))] };
  return { kind: "execute", label: `proof ${sub}`, steps: [actionStep("result", "computer_use_artifacts", sub, collectGenericObjectArgs(args))] };
}

function buildMemoryPlan(args: string[]): CliPlan {
  const sub = firstPositional(args) ?? "search";
  if (sub === "actions") return { kind: "execute", label: "memory actions", steps: [listActionsStep("actions", "memory")] };
  if (sub === "add") return { kind: "execute", label: "memory add", steps: [actionCallStep("result", "memory_add", collectGenericObjectArgs(args, { content: requireValue(readValue(args, ["--content"]) ?? args.join(" "), "content"), category: requireValue(readValue(args, ["--category"]), "category"), scope: readValue(args, ["--scope"]) }))] };
  if (sub === "search") return { kind: "execute", label: "memory search", steps: [actionCallStep("result", "memory_search", collectGenericObjectArgs(args, { query: requireValue(readValue(args, ["--query", "-q"]) ?? args.join(" "), "query") }))] };
  if (sub === "pin") return { kind: "execute", label: "memory pin", steps: [actionCallStep("result", "memory_pin", collectGenericObjectArgs(args, { id: requireValue(readValue(args, ["--memory", "--memory-id", "--id"]) ?? firstPositional(args), "memory id") }))] };
  if (sub === "core") return { kind: "execute", label: "memory core", steps: [actionCallStep("result", "memory_update_core", collectGenericObjectArgs(args))] };
  return { kind: "execute", label: `memory ${sub}`, steps: [actionStep("result", "memory", sub, collectGenericObjectArgs(args))] };
}

function buildSettingsPlan(args: string[]): CliPlan {
  const sub = firstPositional(args) ?? "get";
  if (sub === "actions") return { kind: "execute", label: "settings actions", steps: [listActionsStep("actions", "project_config")] };
  if (sub === "action") return { kind: "execute", label: "settings action", steps: [buildActionRunStep(["project_config", ...args])] };
  return { kind: "execute", label: `settings ${sub}`, steps: [actionStep("result", "project_config", sub, collectGenericObjectArgs(args))] };
}

function buildActionsPlan(args: string[]): CliPlan {
  const sub = firstPositional(args) ?? "list";
  if (sub === "list" || sub === "ls") return { kind: "execute", label: "actions list", steps: [listActionsStep("result", readValue(args, ["--domain"]) ?? firstPositional(args) ?? undefined)] };
  if (sub === "call" || sub === "direct" || sub === "tool") {
    const toolName = requireValue(firstPositional(args), "toolName");
    return { kind: "execute", label: "action call", steps: [actionCallStep("result", toolName, collectGenericObjectArgs(args))] };
  }
  if (sub === "run") return { kind: "execute", label: "action run", steps: [buildActionRunStep(args)] };
  if (sub === "status") return { kind: "execute", label: "action status", steps: [actionCallStep("result", "get_ade_action_status", collectGenericObjectArgs(args))] };
  throw new CliUsageError("actions supports list, run, call, or status.");
}

function buildAgentPlan(args: string[]): CliPlan {
  const sub = firstPositional(args) ?? "spawn";
  if (sub === "spawn" || sub === "start") {
    const toolWhitelist = args
      .filter((entry) => entry.startsWith("--tool=") || entry.startsWith("--allow-tool="))
      .map((entry) => entry.slice(entry.indexOf("=") + 1).trim())
      .filter(Boolean);
    const laneId = requireValue(readLaneId(args), "laneId");
    const prompt = requireValue(readValue(args, ["--prompt"]) ?? args.join(" "), "prompt");
    return {
      kind: "execute",
      label: "agent spawn",
      steps: [actionCallStep("result", "spawn_agent", collectGenericObjectArgs(args, {
        laneId,
        provider: readValue(args, ["--provider"]) ?? "codex",
        model: readValue(args, ["--model"]),
        title: readValue(args, ["--title"]),
        prompt,
        permissionMode: readValue(args, ["--permission-mode", "--permissions"]),
        contextFilePath: readValue(args, ["--context-file"]),
        runId: readValue(args, ["--run", "--run-id"]),
        stepId: readValue(args, ["--step", "--step-id"]),
        attemptId: readValue(args, ["--attempt", "--attempt-id"]),
        maxPromptChars: readIntOption(args, ["--max-prompt-chars"]),
        ...(toolWhitelist.length ? { toolWhitelist } : {}),
      }))],
    };
  }
  return { kind: "execute", label: `agent ${sub}`, steps: [actionCallStep("result", sub.replace(/-/g, "_"), collectGenericObjectArgs(args))] };
}

function buildCtoPlan(args: string[]): CliPlan {
  const sub = firstPositional(args) ?? "state";
  if (sub === "state") return { kind: "execute", label: "CTO state", steps: [actionCallStep("result", "get_cto_state", collectGenericObjectArgs(args, { recentLimit: readIntOption(args, ["--recent-limit", "--limit"]) }))] };
  if (sub === "chats" || sub === "chat") {
    const mode = firstPositional(args) ?? "list";
    const toolByMode: Record<string, string> = {
      list: "listChats",
      spawn: "spawnChat",
      status: "getChatStatus",
      transcript: "readChatTranscript",
      send: "sendChatMessage",
      interrupt: "interruptChat",
      resume: "resumeChat",
      end: "endChat",
    };
    const tool = toolByMode[mode];
    if (!tool) throw new CliUsageError("cto chats supports list, spawn, status, transcript, send, interrupt, resume, or end.");
    return { kind: "execute", label: `CTO chats ${mode}`, steps: [actionCallStep("result", tool, collectGenericObjectArgs(args, { sessionId: readValue(args, ["--session", "--session-id"]) ?? firstPositional(args), text: readValue(args, ["--text", "--message"]) ?? args.join(" "), laneId: readLaneId(args), modelId: readValue(args, ["--model", "--model-id"]), initialPrompt: readValue(args, ["--prompt"]) }))] };
  }
  return { kind: "execute", label: `CTO ${sub}`, steps: [actionCallStep("result", sub.replace(/-/g, "_"), collectGenericObjectArgs(args))] };
}

function parseDraftInput(args: string[]): JsonObject {
  const text = readFileTextInput(args);
  if (text == null) {
    throw new CliUsageError("Provide a rule body via --from-file, --stdin, or --text.");
  }
  const trimmed = text.trim();
  if (!trimmed.length) {
    throw new CliUsageError("Rule body is empty.");
  }
  let parsed: unknown;
  try {
    parsed = trimmed.startsWith("{") || trimmed.startsWith("[")
      ? JSON.parse(trimmed)
      : YAML.parse(trimmed);
  } catch (error) {
    throw new CliUsageError(`Failed to parse rule body: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)) {
    throw new CliUsageError("Rule body must be an object.");
  }
  return parsed;
}

function buildAutomationsPlan(args: string[]): CliPlan {
  const sub = firstPositional(args) ?? "list";

  if (sub === "list") {
    return { kind: "execute", label: "automations list", steps: [actionStep("result", "automations", "list")] };
  }

  if (sub === "show" || sub === "get") {
    const id = requireValue(readValue(args, ["--id"]) ?? firstPositional(args), "rule id");
    return { kind: "execute", label: `automations show ${id}`, steps: [actionStep("result", "automations", "get", { id })] };
  }

  if (sub === "create") {
    const draft = parseDraftInput(args);
    return {
      kind: "execute",
      label: "automations create",
      steps: [actionStep("result", "automations", "saveRule", { draft })],
    };
  }

  if (sub === "update") {
    const id = requireValue(readValue(args, ["--id"]) ?? firstPositional(args), "rule id");
    const draft = parseDraftInput(args);
    return {
      kind: "execute",
      label: `automations update ${id}`,
      steps: [actionStep("result", "automations", "saveRule", { draft: { ...draft, id } })],
    };
  }

  if (sub === "delete") {
    const id = requireValue(readValue(args, ["--id"]) ?? firstPositional(args), "rule id");
    return { kind: "execute", label: `automations delete ${id}`, steps: [actionStep("result", "automations", "deleteRule", { id })] };
  }

  if (sub === "toggle") {
    const id = requireValue(readValue(args, ["--id"]) ?? firstPositional(args), "rule id");
    const enabledRaw = readValue(args, ["--enabled"]);
    if (enabledRaw == null) {
      throw new CliUsageError("automations toggle requires --enabled <true|false>.");
    }
    if (enabledRaw !== "true" && enabledRaw !== "false") {
      throw new CliUsageError("automations toggle --enabled must be true or false.");
    }
    const enabled = enabledRaw === "true";
    return {
      kind: "execute",
      label: `automations toggle ${id}`,
      steps: [actionStep("result", "automations", "toggleRule", { id, enabled })],
    };
  }

  if (sub === "run") {
    const id = requireValue(readValue(args, ["--id"]) ?? firstPositional(args), "rule id");
    const dryRun = readFlag(args, ["--dry-run"]);
    const laneId = readLaneId(args);
    return {
      kind: "execute",
      label: `automations run ${id}`,
      steps: [actionStep("result", "automations", "triggerManually", {
        id,
        ...(dryRun ? { dryRun: true } : {}),
        ...(laneId ? { laneId } : {}),
      })],
    };
  }

  if (sub === "runs") {
    const automationId = readValue(args, ["--rule", "--automation", "--id"]);
    const limit = readIntOption(args, ["--limit"]);
    return {
      kind: "execute",
      label: "automations runs",
      steps: [actionStep("result", "automations", "listRuns", {
        ...(automationId ? { automationId } : {}),
        ...(typeof limit === "number" ? { limit } : {}),
      })],
    };
  }

  if (sub === "run-show" || sub === "run-detail") {
    const runId = requireValue(readValue(args, ["--run", "--run-id"]) ?? firstPositional(args), "run id");
    return {
      kind: "execute",
      label: `automations run-show ${runId}`,
      steps: [actionStep("result", "automations", "getRunDetail", { runId })],
    };
  }

  throw new CliUsageError(
    "automations supports list, show, create, update, delete, toggle, run, runs, or run-show.",
  );
}

function buildLinearPlan(args: string[]): CliPlan {
  const sub = firstPositional(args) ?? "workflows";
  if (sub === "workflows") return { kind: "execute", label: "Linear workflows", steps: [actionCallStep("result", "listLinearWorkflows", collectGenericObjectArgs(args))] };
  if (sub === "run") {
    const mode = firstPositional(args) ?? "status";
    const toolByMode: Record<string, string> = {
      status: "getLinearRunStatus",
      resolve: "resolveLinearRunAction",
      cancel: "cancelLinearRun",
      reroute: "rerouteLinearRun",
    };
    const tool = toolByMode[mode];
    if (!tool) throw new CliUsageError("linear run supports status, resolve, cancel, or reroute.");
    return { kind: "execute", label: `Linear run ${mode}`, steps: [actionCallStep("result", tool, collectGenericObjectArgs(args, { runId: readValue(args, ["--run", "--run-id"]) ?? firstPositional(args) }))] };
  }
  if (sub === "route") {
    const mode = firstPositional(args) ?? "cto";
    const toolByMode: Record<string, string> = {
      cto: "routeLinearIssueToCto",
      mission: "routeLinearIssueToMission",
      worker: "routeLinearIssueToWorker",
    };
    const tool = toolByMode[mode];
    if (!tool) throw new CliUsageError("linear route supports cto, mission, or worker.");
    return { kind: "execute", label: `Linear route ${mode}`, steps: [actionCallStep("result", tool, collectGenericObjectArgs(args))] };
  }
  if (sub === "sync") {
    const mode = firstPositional(args) ?? "dashboard";
    const toolByMode: Record<string, string> = {
      dashboard: "getLinearSyncDashboard",
      run: "runLinearSyncNow",
      queue: "listLinearSyncQueue",
      resolve: "resolveLinearSyncQueueItem",
      detail: "getLinearWorkflowRunDetail",
    };
    const tool = toolByMode[mode];
    if (!tool) throw new CliUsageError("linear sync supports dashboard, run, queue, resolve, or detail.");
    return { kind: "execute", label: `Linear sync ${mode}`, steps: [actionCallStep("result", tool, collectGenericObjectArgs(args))] };
  }
  if (sub === "ingress") {
    const mode = firstPositional(args) ?? "status";
    const toolByMode: Record<string, string> = {
      status: "getLinearIngressStatus",
      events: "listLinearIngressEvents",
      webhook: "ensureLinearWebhook",
    };
    const tool = toolByMode[mode];
    if (!tool) throw new CliUsageError("linear ingress supports status, events, or webhook.");
    return { kind: "execute", label: `Linear ingress ${mode}`, steps: [actionCallStep("result", tool, collectGenericObjectArgs(args))] };
  }
  return { kind: "execute", label: `Linear ${sub}`, steps: [actionStep("result", "linear_dispatcher", sub, collectGenericObjectArgs(args))] };
}

function buildFlowPlan(args: string[]): CliPlan {
  const sub = firstPositional(args) ?? "policy";
  if (sub !== "policy") return { kind: "execute", label: `flow ${sub}`, steps: [actionStep("result", "flow_policy", sub, collectGenericObjectArgs(args))] };
  const mode = firstPositional(args) ?? "get";
  const actionByMode: Record<string, string> = {
    get: "getPolicy",
    save: "savePolicy",
    validate: "validatePolicy",
    normalize: "normalizePolicy",
    revisions: "listRevisions",
    rollback: "rollbackRevision",
    diff: "diffPolicyPaths",
  };
  const action = actionByMode[mode];
  if (!action) throw new CliUsageError("flow policy supports get, save, validate, normalize, revisions, rollback, or diff.");
  return { kind: "execute", label: `flow policy ${mode}`, steps: [actionStep("result", "flow_policy", action, collectGenericObjectArgs(args))] };
}

function buildCoordinatorPlan(args: string[]): CliPlan {
  const toolName = requireValue(firstPositional(args), "coordinator tool").replace(/-/g, "_");
  return { kind: "execute", label: `coordinator ${toolName}`, steps: [actionCallStep("result", toolName, collectGenericObjectArgs(args))] };
}

function hasHelpFlag(args: string[]): boolean {
  const terminatorIndex = args.indexOf("--");
  const searchable = terminatorIndex >= 0 ? args.slice(0, terminatorIndex) : args;
  return searchable.includes("--help") || searchable.includes("-h");
}

function buildCliPlan(command: string[]): CliPlan {
  const args = [...command];
  const primary = firstPositional(args);
  if (!primary || primary === "-h" || primary === "--help") {
    return { kind: "help", text: TOP_LEVEL_HELP };
  }
  const aliases: Record<string, string> = {
    lane: "lanes",
    diff: "diff",
    diffs: "diff",
    file: "files",
    pr: "prs",
    process: "run",
    processes: "run",
    pty: "shell",
    chats: "chat",
    work: "chat",
    agents: "agent",
    test: "tests",
    computer: "proof",
    "computer-use": "proof",
    artifact: "proof",
    artifacts: "proof",
    setting: "settings",
    config: "settings",
    action: "actions",
    coord: "coordinator",
    automation: "automations",
  };
  const primaryHelpKey = aliases[primary] ?? primary;
  if (hasHelpFlag(args)) {
    return { kind: "help", text: HELP_BY_COMMAND[primaryHelpKey] ?? TOP_LEVEL_HELP };
  }
  if (primary === "help") {
    const topic = (firstPositional(args) ?? "").toLowerCase();
    const key = aliases[topic] ?? topic;
    return { kind: "help", text: key && HELP_BY_COMMAND[key] ? HELP_BY_COMMAND[key] : TOP_LEVEL_HELP };
  }
  if (primary === "version" || primary === "--version" || primary === "-v") {
    return { kind: "help", text: `ade ${VERSION}\n` };
  }
  if (primary === "status") {
    return { kind: "execute", label: "status", summary: "status", steps: [{ key: "ping", method: "ping" }] };
  }
  if (primary === "doctor") {
    return {
      kind: "execute",
      label: "doctor",
      summary: "doctor",
      steps: [
        { key: "ping", method: "ping" },
        { key: "rpcActions", method: "ade/actions/list" },
        listActionsStep("actions"),
        { ...actionStep("projectConfig", "project_config", "get"), optional: true },
      ],
    };
  }
  if (primary === "auth") {
    const sub = firstPositional(args) ?? "status";
    if (sub !== "status") throw new CliUsageError("auth currently supports status.");
    return {
      kind: "execute",
      label: "auth status",
      summary: "auth",
      steps: [
        { key: "actions", method: "ade/actions/list" },
        { ...actionStep("projectConfig", "project_config", "get"), optional: true },
      ],
    };
  }
  if (primary === "lanes" || primary === "lane") return buildLanePlan(args);
  if (primary === "git") return buildGitPlan(args);
  if (primary === "diff" || primary === "diffs") return buildDiffPlan(args);
  if (primary === "files" || primary === "file") return buildFilesPlan(args);
  if (primary === "prs" || primary === "pr") return buildPrPlan(args);
  if (primary === "run" || primary === "process" || primary === "processes") return buildRunPlan(args);
  if (primary === "shell" || primary === "pty") return buildShellPlan(args);
  if (primary === "chat" || primary === "chats" || primary === "work") return buildChatPlan(args);
  if (primary === "agent" || primary === "agents") return buildAgentPlan(args);
  if (primary === "cto") return buildCtoPlan(args);
  if (primary === "linear") return buildLinearPlan(args);
  if (primary === "automations" || primary === "automation") return buildAutomationsPlan(args);
  if (primary === "flow") return buildFlowPlan(args);
  if (primary === "coordinator" || primary === "coord") return buildCoordinatorPlan(args);
  if (primary === "ask") return { kind: "execute", label: "ask user", steps: [actionCallStep("result", "ask_user", collectGenericObjectArgs(args, { title: readValue(args, ["--title"]) ?? "ADE question", body: readValue(args, ["--body", "--question"]) ?? args.join(" ") }))] };
  if (primary === "tests" || primary === "test") return buildTestsPlan(args);
  if (primary === "proof" || primary === "computer-use" || primary === "artifacts") return buildProofPlan(args);
  if (primary === "memory") return buildMemoryPlan(args);
  if (primary === "settings" || primary === "config") return buildSettingsPlan(args);
  if (primary === "actions" || primary === "action") return buildActionsPlan(args);
  throw new CliUsageError(`Unknown command '${primary}'. Run 'ade help'.`);
}

function findAdeManagedWorktreeRoot(startDir: string): { projectRoot: string; workspaceRoot: string } | null {
  const resolved = path.resolve(startDir);
  const segments = resolved.split(path.sep);
  for (let index = segments.length - 2; index >= 0; index -= 1) {
    if (segments[index] !== ".ade" || segments[index + 1] !== "worktrees") continue;
    const projectRoot = segments.slice(0, index).join(path.sep) || path.sep;
    const worktreeName = segments[index + 2];
    if (!worktreeName) continue;
    const workspaceRoot = segments.slice(0, index + 3).join(path.sep) || path.sep;
    if (!fs.existsSync(path.join(projectRoot, ".ade"))) continue;
    return { projectRoot: path.resolve(projectRoot), workspaceRoot: path.resolve(workspaceRoot) };
  }
  return null;
}

function findProjectRoots(startDir: string): { projectRoot: string; workspaceRoot: string } {
  const managedWorktree = findAdeManagedWorktreeRoot(startDir);
  if (managedWorktree) return managedWorktree;

  let cursor = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(cursor, ".ade"))) {
      return { projectRoot: cursor, workspaceRoot: cursor };
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }

  const git = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: startDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const gitRoot = git.status === 0 ? git.stdout.trim() : "";
  const fallback = gitRoot ? path.resolve(gitRoot) : path.resolve(startDir);
  return { projectRoot: fallback, workspaceRoot: fallback };
}

function resolveRoots(options: GlobalOptions): { projectRoot: string; workspaceRoot: string } {
  const discovered = findProjectRoots(process.cwd());
  const projectFromEnv = process.env.ADE_PROJECT_ROOT?.trim()
    ? path.resolve(process.env.ADE_PROJECT_ROOT.trim())
    : null;
  const workspaceFromEnv = process.env.ADE_WORKSPACE_ROOT?.trim()
    ? path.resolve(process.env.ADE_WORKSPACE_ROOT.trim())
    : null;

  const projectRoot = options.projectRoot ?? projectFromEnv ?? discovered.projectRoot;
  const projectExplicitlyOverridden = options.projectRoot != null || projectFromEnv != null;

  const workspaceRoot =
    options.workspaceRoot
    ?? workspaceFromEnv
    ?? (projectExplicitlyOverridden ? projectRoot : discovered.workspaceRoot);

  return { projectRoot, workspaceRoot };
}

function commandExists(command: string): boolean {
  const result = spawnSync("which", [command], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 && result.stdout.trim().length > 0;
}

function runLocalCommand(command: string, args: string[], cwd: string): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5000,
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

function checkGitReadiness(projectRoot: string): ReadinessCheck {
  if (!commandExists("git")) {
    return {
      ready: false,
      status: "missing",
      message: "git is not available on PATH.",
      nextAction: "Install git and rerun ade doctor.",
    };
  }
  const inside = runLocalCommand("git", ["rev-parse", "--is-inside-work-tree"], projectRoot);
  if (!inside.ok || inside.stdout !== "true") {
    return {
      ready: false,
      status: "missing",
      message: "Project root is not inside a git worktree.",
      nextAction: "Run ade with --project-root pointing at a git repository.",
    };
  }
  const root = runLocalCommand("git", ["rev-parse", "--show-toplevel"], projectRoot);
  const branch = runLocalCommand("git", ["branch", "--show-current"], projectRoot);
  return {
    ready: true,
    status: "ready",
    message: `Git repository detected${branch.stdout ? ` on ${branch.stdout}` : ""}.`,
    details: {
      gitRoot: root.ok ? root.stdout : null,
      branch: branch.ok ? branch.stdout || null : null,
    },
  };
}

function getGitRemote(projectRoot: string): string | null {
  const remote = runLocalCommand("git", ["config", "--get", "remote.origin.url"], projectRoot);
  return remote.ok && remote.stdout ? remote.stdout : null;
}

function checkGitHubReadiness(projectRoot: string): ReadinessCheck {
  const remote = getGitRemote(projectRoot);
  const hasGitHubRemote = Boolean(remote && /github\.com[:/]/i.test(remote));
  const ghInstalled = commandExists("gh");
  const envTokenPresent = Boolean(process.env.ADE_GITHUB_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim());
  const ready = hasGitHubRemote && (ghInstalled || envTokenPresent);
  return {
    ready,
    status: ready ? "ready" : hasGitHubRemote ? "warning" : "unavailable",
    message: hasGitHubRemote
      ? ready
        ? "GitHub remote detected and a local auth mechanism is available."
        : "GitHub remote detected, but no gh CLI or GitHub token was found locally."
      : "No GitHub origin remote detected.",
    nextAction: ready
      ? undefined
      : hasGitHubRemote
        ? "Run gh auth login or set ADE_GITHUB_TOKEN/GITHUB_TOKEN for headless PR workflows."
        : "Add a GitHub origin remote if this project should use ADE PR workflows.",
    details: {
      ghInstalled,
      tokenEnvPresent: envTokenPresent,
      githubRemoteDetected: hasGitHubRemote,
    },
  };
}

function checkLinearReadiness(projectRoot: string): ReadinessCheck {
  const { resolveAdeLayout } = requireAdeLayout();
  const layout = resolveAdeLayout(projectRoot);
  const encryptedTokenPresent = fs.existsSync(path.join(layout.secretsDir, "linear-token.v1.bin"));
  const envTokenPresent = Boolean(
    process.env.ADE_LINEAR_API?.trim()
    || process.env.LINEAR_API_KEY?.trim()
    || process.env.ADE_LINEAR_TOKEN?.trim()
    || process.env.LINEAR_TOKEN?.trim()
  );
  const ready = encryptedTokenPresent || envTokenPresent;
  return {
    ready,
    status: ready ? "ready" : "warning",
    message: ready
      ? "Linear credentials are present locally."
      : "No Linear token was detected in local stores or environment variables.",
    nextAction: ready
      ? undefined
      : "Configure Linear in ADE desktop or set ADE_LINEAR_API/LINEAR_API_KEY for headless mode.",
    details: {
      encryptedTokenPresent,
      tokenEnvPresent: envTokenPresent,
    },
  };
}

function checkProviderReadiness(value: unknown): ReadinessCheck {
  const configResult = isRecord(value) && isRecord(value.result) ? value.result : value;
  const effective = isRecord(configResult) && isRecord(configResult.effective) ? configResult.effective : {};
  const ai = isRecord(effective.ai) ? effective.ai : {};
  const defaultProvider = asString(ai.defaultProvider) ?? asString(ai.mode);
  const defaultModel = asString(ai.defaultModel);
  const apiKeys = isRecord(ai.apiKeys) ? ai.apiKeys : {};
  const cliProviders = {
    claude: commandExists("claude"),
    codex: commandExists("codex"),
    opencode: commandExists("opencode"),
    cursor: commandExists("agent") || commandExists("cursor-agent"),
  };
  const apiKeyProviders = Object.keys(apiKeys).filter((key) => Boolean(asString(apiKeys[key])));
  const ready = Boolean(defaultProvider || defaultModel || apiKeyProviders.length || Object.values(cliProviders).some(Boolean));
  return {
    ready,
    status: ready ? "ready" : "warning",
    message: ready
      ? "AI provider configuration or provider CLI availability was detected locally."
      : "No AI provider configuration or provider CLI was detected locally.",
    nextAction: ready
      ? undefined
      : "Configure AI providers in ADE desktop or install/sign in to a provider CLI.",
    details: {
      defaultProvider,
      defaultModel,
      apiKeyProviders,
      cliProviders,
    },
  };
}

function checkComputerUseReadiness(): ReadinessCheck {
  const isDarwin = process.platform === "darwin";
  const screenshotReady = !isDarwin || commandExists("screencapture");
  const appLaunchReady = !isDarwin || commandExists("open");
  const guiReady = !isDarwin || commandExists("swift") || commandExists("osascript");
  const ready = isDarwin && screenshotReady && appLaunchReady && guiReady;
  return {
    ready,
    status: ready ? "ready" : isDarwin ? "warning" : "unavailable",
    message: ready
      ? "Local macOS computer-use fallback commands are available."
      : isDarwin
        ? "One or more local macOS computer-use fallback commands are missing."
        : "Local computer-use fallback is macOS-only.",
    nextAction: ready
      ? undefined
      : isDarwin
        ? "Install or expose screencapture/open/swift/osascript on PATH, or use an external proof backend."
        : "Use ADE desktop on macOS or an external proof backend for computer-use capture.",
    details: {
      platform: process.platform,
      screenshotReady,
      appLaunchReady,
      guiReady,
    },
  };
}

function checkPathReadiness(): ReadinessCheck {
  const which = runLocalCommand("which", ["ade"], process.cwd());
  const current = path.resolve(process.argv[1] ?? "");
  const whichPath = which.ok && which.stdout ? path.resolve(which.stdout.split("\n")[0]!) : null;
  const onPath = Boolean(whichPath);
  return {
    ready: onPath,
    status: onPath ? "ready" : "warning",
    message: onPath ? "ade is available on PATH." : "ade is not available on PATH.",
    nextAction: onPath
      ? undefined
      : "Run npm link in apps/ade-cli or the packaged install-path.sh script.",
    details: {
      currentCliPath: current || null,
      pathAde: whichPath,
      sameBinary: Boolean(whichPath && current && whichPath === current),
      electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE === "1",
      electronVersion: process.versions.electron ?? null,
    },
  };
}

function requireAdeLayout(): { resolveAdeLayout: (projectRoot: string) => { secretsDir: string } } {
  // The CLI loads the shared layout dynamically elsewhere; this CommonJS fallback
  // keeps readiness checks synchronous and local-only.
  return { resolveAdeLayout: (projectRoot: string) => ({ secretsDir: path.join(projectRoot, ".ade", "secrets") }) };
}

function actionDomainCounts(value: unknown): Record<string, number> {
  const actions = isRecord(value) && Array.isArray(value.actions) ? value.actions.filter(isRecord) : [];
  return actions.reduce<Record<string, number>>((acc, action) => {
    const domain = asString(action.domain) ?? "core";
    acc[domain] = (acc[domain] ?? 0) + 1;
    return acc;
  }, {});
}

function buildReadinessSnapshot(args: {
  connection: CliConnection;
  values: JsonObject;
  summary: "doctor" | "auth";
}): JsonObject {
  const { connection, values, summary } = args;
  const rpcActions = isRecord(values.rpcActions) && Array.isArray(values.rpcActions.actions) ? values.rpcActions.actions : [];
  const actions = isRecord(values.actions) && Array.isArray(values.actions.actions) ? values.actions.actions : [];
  const projectConfig = values.projectConfig;
  const adeDir = path.join(connection.projectRoot, ".ade");
  const sharedConfigPath = path.join(adeDir, "ade.yaml");
  const localConfigPath = path.join(adeDir, "local.yaml");
  const socketExists = fs.existsSync(connection.socketPath);
  const desktopSocketAvailable = connection.mode === "desktop-socket";
  const checks = {
    git: checkGitReadiness(connection.projectRoot),
    github: checkGitHubReadiness(connection.projectRoot),
    linear: checkLinearReadiness(connection.projectRoot),
    providers: checkProviderReadiness(projectConfig),
    computerUse: checkComputerUseReadiness(),
    path: checkPathReadiness(),
  };
  const recommendations = Object.entries(checks)
    .filter(([, check]) => check.nextAction)
    .map(([key, check]) => `${key}: ${check.nextAction}`);
  if (!desktopSocketAvailable) {
    recommendations.unshift("desktop: Start ADE desktop or pass --socket when Work chat, Path to Merge, Run tab state, or UI-owned proof state is required.");
  }
  const projectInitialized = fs.existsSync(adeDir);
  if (!projectInitialized) {
    recommendations.unshift("project: Run ade doctor from an ADE project or pass --project-root <repo>.");
  }
  const actionCountsByDomain = actionDomainCounts(values.actions);
  const ready = projectInitialized && checks.git.ready && actions.length > 0;

  return {
    ok: ready,
    cliVersion: VERSION,
    protocolVersion: PROTOCOL_VERSION,
    mode: connection.mode,
    selectedMode: connection.mode,
    requestedMode: desktopSocketAvailable ? "desktop-socket" : "headless",
    runtime: {
      node: process.version,
      execPath: process.execPath,
      electron: process.versions.electron ?? null,
      platform: process.platform,
      arch: process.arch,
    },
    projectRoot: connection.projectRoot,
    workspaceRoot: connection.workspaceRoot,
    project: {
      projectRoot: connection.projectRoot,
      workspaceRoot: connection.workspaceRoot,
      adeDir,
      projectInitialized,
      sharedConfigPath,
      sharedConfigPresent: fs.existsSync(sharedConfigPath),
      localConfigPath,
      localConfigPresent: fs.existsSync(localConfigPath),
    },
    desktop: {
      socketPath: connection.socketPath,
      socketExists,
      socketAvailable: desktopSocketAvailable,
      message: desktopSocketAvailable
        ? "Connected to live ADE desktop socket."
        : socketExists
          ? "Socket path exists but CLI is running in headless mode; the socket may be stale or unavailable."
          : "No live ADE desktop socket was detected.",
    },
    actions: {
      rpcActionCount: rpcActions.length,
      actionCount: actions.length,
      byDomain: actionCountsByDomain,
    },
    git: checks.git,
    github: checks.github,
    linear: checks.linear,
    providers: checks.providers,
    computerUse: checks.computerUse,
    path: checks.path,
    auth: {
      localProjectAccess: projectInitialized && actions.length > 0,
      providerSecretsExposed: false,
      note: "ADE CLI auth is local project access. Provider and integration readiness is reported as presence-only metadata.",
    },
    networkChecks: {
      performed: false,
      message: "Default doctor/auth checks do not call provider, GitHub, or Linear networks.",
    },
    recommendations,
    recommendation: recommendations[0] ?? (connection.mode === "desktop-socket"
      ? "Using live ADE desktop state."
      : "Headless mode is ready for local ADE actions; start ADE desktop for UI-owned runtime state."),
    summary,
  };
}

class SocketJsonRpcClient {
  private buffer: Buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  private constructor(private readonly socket: net.Socket, private readonly timeoutMs: number) {
    socket.on("data", (chunk) => this.onData(Buffer.from(chunk)));
    socket.on("error", (error) => this.rejectAll(error instanceof Error ? error : new Error(String(error))));
    socket.on("close", () => this.rejectAll(new Error("ADE desktop socket closed.")));
  }

  static connect(socketPath: string, timeoutMs: number): Promise<SocketJsonRpcClient> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Timed out connecting to ADE desktop socket at ${socketPath}.`));
      }, Math.min(timeoutMs, 5000));
      socket.once("connect", () => {
        clearTimeout(timer);
        resolve(new SocketJsonRpcClient(socket, timeoutMs));
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  request(method: string, params?: JsonObject): Promise<unknown> {
    const id = this.nextId;
    this.nextId += 1;
    const payload: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    };
    const body = `${JSON.stringify(payload)}\n`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}.`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(body, "utf8", (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  close(): void {
    this.socket.end();
  }

  private onData(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (true) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) break;
      const line = this.buffer.subarray(0, newline).toString("utf8").trim();
      this.buffer = this.buffer.subarray(newline + 1);
      if (!line) continue;
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      this.rejectAll(new Error(`Failed to parse ADE socket response: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    if (!isRecord(parsed)) return;
    const id = typeof parsed.id === "number" ? parsed.id : null;
    if (id == null) return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (isRecord(parsed.error)) {
      pending.reject(new Error(asString(parsed.error.message) ?? "ADE JSON-RPC request failed."));
      return;
    }
    pending.resolve(parsed.result);
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }
}

class InProcessJsonRpcClient {
  private nextId = 1;

  constructor(
    private readonly handler: JsonRpcHandler & { dispose?: () => void },
    private readonly runtime: { dispose: () => void },
    private readonly previousRole: string | undefined,
  ) {}

  async request(method: string, params?: JsonObject): Promise<unknown> {
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: this.nextId as JsonRpcId,
      method,
      ...(params !== undefined ? { params } : {}),
    };
    this.nextId += 1;
    return await this.handler(request);
  }

  close(): void {
    try { this.handler.dispose?.(); } catch {}
    try { this.runtime.dispose(); } catch {}
    if (this.previousRole == null) delete process.env.ADE_DEFAULT_ROLE;
    else process.env.ADE_DEFAULT_ROLE = this.previousRole;
  }
}

async function initializeConnection(connection: CliConnection, options: GlobalOptions): Promise<void> {
  await connection.request("ade/initialize", {
    protocolVersion: PROTOCOL_VERSION,
    clientInfo: { name: "ade-cli", version: VERSION },
    identity: {
      callerId: "ade-cli",
      role: options.role,
      computerUsePolicy: {
        mode: "auto",
        allowLocalFallback: options.role !== "external",
        retainArtifacts: true,
      },
    },
  });
}

async function createConnection(options: GlobalOptions): Promise<CliConnection> {
  const roots = resolveRoots(options);
  const { resolveAdeLayout } = await import("../../desktop/src/shared/adeLayout");
  const layout = resolveAdeLayout(roots.projectRoot);

  if (!options.headless && fs.existsSync(layout.socketPath)) {
    try {
      const socketClient = await SocketJsonRpcClient.connect(layout.socketPath, options.timeoutMs);
      const connection: CliConnection = {
        mode: "desktop-socket",
        projectRoot: roots.projectRoot,
        workspaceRoot: roots.workspaceRoot,
        socketPath: layout.socketPath,
        request: (method, params) => socketClient.request(method, params),
        close: () => socketClient.close(),
      };
      await initializeConnection(connection, options);
      return connection;
    } catch (error) {
      if (options.requireSocket) throw error;
    }
  }

  if (options.requireSocket) {
    throw new Error(`ADE desktop socket is not available at ${layout.socketPath}.`);
  }

  const previousRole = process.env.ADE_DEFAULT_ROLE;
  process.env.ADE_DEFAULT_ROLE = options.role;
  const [{ createAdeRuntime }, { createAdeRpcRequestHandler }] = await Promise.all([
    import("./bootstrap"),
    import("./adeRpcServer"),
  ]);
  const runtime = await createAdeRuntime({ projectRoot: roots.projectRoot, workspaceRoot: roots.workspaceRoot });
  const handler = createAdeRpcRequestHandler({
    runtime,
    serverVersion: VERSION,
    onActionsListChanged: () => {},
  });

  const inProcess = new InProcessJsonRpcClient(handler, runtime, previousRole);
  const connection: CliConnection = {
    mode: "headless",
    projectRoot: roots.projectRoot,
    workspaceRoot: roots.workspaceRoot,
    socketPath: layout.socketPath,
    request: (method, params) => inProcess.request(method, params),
    close: () => inProcess.close(),
  };
  await initializeConnection(connection, options);
  return connection;
}

function unwrapToolResult(result: unknown): unknown {
  if (!isRecord(result)) return result;
  if (result.isError === true) {
    const structured = result.structuredContent;
    const message = isRecord(structured) && isRecord(structured.error)
      ? asString(structured.error.message) ?? "ADE tool call failed."
      : "ADE tool call failed.";
    throw new CliToolError(message, structured ?? result);
  }
  if (result.ok === false && isRecord(result.error)) {
    const message = asString(result.error.message) ?? "ADE action call failed.";
    throw new CliToolError(message, result.error);
  }
  if (Object.prototype.hasOwnProperty.call(result, "structuredContent")) {
    return result.structuredContent;
  }
  return result;
}

function renderLaneGraph(result: unknown): string {
  const lanesRaw = isRecord(result) && Array.isArray(result.lanes) ? result.lanes : [];
  const lanes = lanesRaw.filter(isRecord);
  if (lanes.length === 0) return "ADE lanes\n(no lanes)";

  const byParent = new Map<string, JsonObject[]>();
  const byId = new Map<string, JsonObject>();
  for (const lane of lanes) {
    const id = asString(lane.id);
    if (!id) continue;
    byId.set(id, lane);
  }
  for (const lane of lanes) {
    const parentId = asString(lane.parentLaneId);
    const key = parentId && byId.has(parentId) ? parentId : "";
    const children = byParent.get(key) ?? [];
    children.push(lane);
    byParent.set(key, children);
  }
  for (const children of byParent.values()) {
    children.sort((left, right) => {
      const leftDepth = typeof left.stackDepth === "number" ? left.stackDepth : 0;
      const rightDepth = typeof right.stackDepth === "number" ? right.stackDepth : 0;
      if (leftDepth !== rightDepth) return leftDepth - rightDepth;
      return String(left.name ?? left.id ?? "").localeCompare(String(right.name ?? right.id ?? ""));
    });
  }

  const lines = ["ADE lanes"];
  const visit = (lane: JsonObject, prefix: string, isLast: boolean): void => {
    const name = asString(lane.name) ?? asString(lane.id) ?? "(unknown)";
    const branch = asString(lane.branchRef) ?? "";
    const status = asString(lane.status) ?? "";
    const archived = asString(lane.archivedAt) ? " archived" : "";
    lines.push(`${prefix}${isLast ? "\\- " : "|- "}${name}${branch ? ` [${branch}]` : ""}${status ? ` ${status}` : ""}${archived}`);
    const id = asString(lane.id);
    const children = id ? byParent.get(id) ?? [] : [];
    children.forEach((child, index) => visit(child, `${prefix}${isLast ? "   " : "|  "}`, index === children.length - 1));
  };
  const roots = byParent.get("") ?? [];
  roots.forEach((lane, index) => visit(lane, "", index === roots.length - 1));
  return lines.join("\n");
}

function truncateCell(value: string, width = 42): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= width) return normalized;
  if (width <= 3) return normalized.slice(0, width);
  return `${normalized.slice(0, width - 3)}...`;
}

function cell(value: unknown, width = 42): string {
  if (value == null) return "";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "string") return truncateCell(value, width);
  if (Array.isArray(value)) return truncateCell(value.map((entry) => cell(entry, 18)).filter(Boolean).join(", "), width);
  if (isRecord(value)) {
    const id = asString(value.id) ?? asString(value.name) ?? asString(value.title);
    return id ? truncateCell(id, width) : truncateCell(JSON.stringify(value), width);
  }
  return truncateCell(String(value), width);
}

function renderKeyValues(title: string, entries: Array<[string, unknown]>): string {
  const rows = entries.filter(([, value]) => value !== undefined && value !== null && value !== "");
  const labelWidth = Math.max(0, ...rows.map(([label]) => label.length));
  return [
    title,
    ...rows.map(([label, value]) => `${label.padEnd(labelWidth)}  ${cell(value, 96)}`),
  ].join("\n");
}

function renderTable(headers: string[], rows: unknown[][], emptyMessage: string): string {
  if (rows.length === 0) return emptyMessage;
  const widths = headers.map((header, index) => Math.max(
    header.length,
    ...rows.map((row) => cell(row[index], index === headers.length - 1 ? 64 : 28).length),
  ));
  const renderRow = (row: unknown[]) => row.map((entry, index) => cell(entry, index === headers.length - 1 ? 64 : 28).padEnd(widths[index] ?? 0)).join("  ").trimEnd();
  return [
    renderRow(headers),
    widths.map((width) => "-".repeat(width)).join("  "),
    ...rows.map(renderRow),
  ].join("\n");
}

function firstArray(value: unknown, keys: string[]): JsonObject[] {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (!isRecord(value)) return [];
  for (const key of keys) {
    const entry = value[key];
    if (Array.isArray(entry)) return entry.filter(isRecord);
  }
  return [];
}

function firstRecord(value: unknown, keys: string[]): JsonObject | null {
  if (!isRecord(value)) return null;
  for (const key of keys) {
    const entry = value[key];
    if (isRecord(entry)) return entry;
  }
  return null;
}

function statusWord(value: unknown): string {
  const raw = cell(value, 24).toLowerCase();
  if (!raw) return "";
  if (["success", "passing", "passed", "completed", "ready", "clean", "ok"].includes(raw)) return "OK";
  if (["failure", "failed", "failing", "error", "blocked", "dirty"].includes(raw)) return "FAIL";
  if (["pending", "running", "in_progress", "queued", "active"].includes(raw)) return "WAIT";
  return raw.toUpperCase();
}

function formatActionsList(value: unknown): string {
  const actions = firstArray(value, ["actions"]);
  if (actions.length === 0) return "ADE actions\n(no actions)";
  const byDomain = new Map<string, JsonObject[]>();
  for (const action of actions) {
    const name = asString(action.name);
    const domain = asString(action.domain) ?? (name?.includes(".") ? name.split(".")[0] : null) ?? "core";
    const list = byDomain.get(domain) ?? [];
    list.push(action);
    byDomain.set(domain, list);
  }
  const lines = [
    "ADE actions",
    "Use: ade actions run <domain.action> --input-json '{\"key\":\"value\"}'",
    "For multi-parameter methods: --args-list-json '[\"first\",{\"second\":true}]'",
  ];
  for (const [domain, list] of [...byDomain.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    lines.push("", `${domain}:`);
    for (const action of list.sort((left, right) => cell(left.action ?? left.name).localeCompare(cell(right.action ?? right.name)))) {
      const name = asString(action.action) ?? asString(action.name) ?? "(unknown)";
      const description = asString(action.description) ?? "";
      lines.push(`  ${name}${description ? ` - ${truncateCell(description, 86)}` : ""}`);
    }
  }
  return lines.join("\n");
}

function formatLaneDetail(value: unknown): string {
  const root = isRecord(value) ? value : {};
  const lane = firstRecord(value, ["lane"]) ?? (isRecord(value) ? value : {});
  return renderKeyValues("ADE lane", [
    ["id", lane.id],
    ["name", lane.name],
    ["branch", lane.branchRef ?? lane.branch],
    ["base", lane.baseBranch ?? lane.baseRef],
    ["status", lane.status ?? root.rebaseStatus],
    ["worktree", lane.worktreePath],
  ]);
}

function formatPrList(value: unknown): string {
  const prs = firstArray(value, ["prs", "pullRequests", "items", "results"]);
  return renderTable(
    ["PR", "state", "lane", "branch", "title"],
    prs.map((pr) => [
      pr.githubPrNumber ?? pr.number ?? pr.prNumber ?? pr.id,
      pr.state ?? pr.status,
      pr.laneId ?? pr.laneName,
      pr.headBranch ?? pr.headRefName ?? pr.branchRef ?? pr.branch,
      pr.title,
    ]),
    "ADE pull requests\n(no PRs)",
  );
}

function formatPrChecks(value: unknown): string {
  const checks = firstArray(value, ["checks", "items"]);
  const summary = isRecord(value) ? value.summary : null;
  const header = summary ? `ADE PR checks - ${cell(summary, 80)}` : "ADE PR checks";
  return `${header}\n${renderTable(
    ["status", "name", "details"],
    checks.map((check) => [
      statusWord(check.conclusion ?? check.status),
      check.name,
      check.detailsUrl ?? check.url ?? check.completedAt,
    ]),
    "(no checks)",
  )}`;
}

function formatPrComments(value: unknown): string {
  const threads = firstArray(value, ["reviewThreads", "threads"]);
  const comments = firstArray(value, ["comments", "issueComments"]);
  const lines = ["ADE PR comments"];
  if (threads.length > 0) {
    lines.push("", renderTable(
      ["thread", "state", "file", "comment"],
      threads.map((thread) => {
        const threadComments = Array.isArray(thread.comments) ? thread.comments.filter(isRecord) : [];
        const first = threadComments[0] ?? {};
        return [
          thread.id,
          thread.isResolved ? "resolved" : "open",
          `${cell(thread.path, 34)}${thread.line ? `:${thread.line}` : ""}`,
          first.body ?? thread.body,
        ];
      }),
      "(no review threads)",
    ));
  }
  if (comments.length > 0) {
    lines.push("", renderTable(
      ["id", "author", "comment"],
      comments.map((comment) => [comment.id, comment.author ?? comment.user, comment.body]),
      "(no issue comments)",
    ));
  }
  if (threads.length === 0 && comments.length === 0) lines.push("(no comments)");
  return lines.join("\n");
}

function formatFileTree(value: unknown): string {
  const entries = firstArray(value, ["entries", "nodes", "items", "children"]);
  return renderTable(
    ["type", "path", "size"],
    entries.map((entry) => [entry.type ?? (entry.isDirectory ? "dir" : "file"), entry.path ?? entry.name, entry.sizeBytes ?? entry.size]),
    "ADE files\n(no entries)",
  );
}

function formatFileRead(value: unknown): string {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return JSON.stringify(value, null, 2);
  const text = typeof value.text === "string" ? value.text : typeof value.content === "string" ? value.content : null;
  return text ?? JSON.stringify(value, null, 2);
}

function formatFilesSearch(value: unknown): string {
  const matches = firstArray(value, ["matches", "results", "items"]);
  return renderTable(
    ["file", "line", "match"],
    matches.map((match) => [match.path ?? match.filePath, match.line ?? match.lineNumber, match.preview ?? match.text ?? match.match]),
    "ADE file search\n(no matches)",
  );
}

function formatDiffSummary(value: unknown): string {
  const files = firstArray(value, ["files", "changes", "items"]);
  return renderTable(
    ["status", "file", "+", "-"],
    files.map((file) => [
      file.status ?? file.changeType ?? file.type,
      file.path ?? file.filePath ?? file.newPath ?? file.oldPath,
      file.additions ?? file.added ?? "",
      file.deletions ?? file.deleted ?? "",
    ]),
    "ADE diff\n(no changed files)",
  );
}

function formatRunTable(value: unknown, title: string): string {
  const rows = firstArray(value, ["processes", "definitions", "runtime", "runs", "items"]);
  return `${title}\n${renderTable(
    ["id", "status", "lane", "command"],
    rows.map((row) => [
      row.id ?? row.processId ?? row.runId ?? row.name,
      row.status ?? row.state,
      row.laneId ?? row.laneName,
      row.command ?? row.startupCommand ?? row.title,
    ]),
    "(none)",
  )}`;
}

function formatChatList(value: unknown): string {
  const sessions = firstArray(value, ["sessions", "chats", "items"]);
  return renderTable(
    ["session", "provider", "lane", "title"],
    sessions.map((session) => [session.id ?? session.sessionId, session.provider ?? session.modelId, session.laneId, session.title]),
    "ADE chats\n(no sessions)",
  );
}

function formatTestsRuns(value: unknown): string {
  const runs = firstArray(value, ["runs", "items"]);
  return renderTable(
    ["run", "status", "suite", "duration"],
    runs.map((run) => [run.id ?? run.runId, statusWord(run.status), run.suiteId ?? run.suiteName, run.durationMs]),
    "ADE test runs\n(no runs)",
  );
}

function formatProofList(value: unknown): string {
  const artifacts = firstArray(value, ["artifacts", "items"]);
  return renderTable(
    ["kind", "created", "title", "path"],
    artifacts.map((artifact) => [artifact.kind ?? artifact.type, artifact.createdAt, artifact.title ?? artifact.name, artifact.path ?? artifact.uri]),
    "ADE proof artifacts\n(no artifacts)",
  );
}

function formatTextOutput(value: unknown, formatter: FormatterId | undefined): string {
  if (typeof value === "string") return value;
  if (isRecord(value) && typeof value.visual === "string" && (!formatter || formatter === "lanes")) return value.visual;
  switch (formatter) {
    case "status":
      return renderKeyValues("ADE status", [
        ["ok", isRecord(value) ? value.ok : null],
        ["mode", isRecord(value) ? value.mode : null],
        ["project", isRecord(value) ? value.projectRoot : null],
        ["workspace", isRecord(value) ? value.workspaceRoot : null],
        ["socket", isRecord(value) ? value.socketPath : null],
      ]);
    case "doctor":
      {
        const project = isRecord(value) && isRecord(value.project) ? value.project : {};
        const desktop = isRecord(value) && isRecord(value.desktop) ? value.desktop : {};
        const actions = isRecord(value) && isRecord(value.actions) ? value.actions : {};
        const git = isRecord(value) && isRecord(value.git) ? value.git : {};
        const github = isRecord(value) && isRecord(value.github) ? value.github : {};
        const linear = isRecord(value) && isRecord(value.linear) ? value.linear : {};
        const providers = isRecord(value) && isRecord(value.providers) ? value.providers : {};
        const computerUse = isRecord(value) && isRecord(value.computerUse) ? value.computerUse : {};
        const pathStatus = isRecord(value) && isRecord(value.path) ? value.path : {};
        const recommendations = isRecord(value) && Array.isArray(value.recommendations) ? value.recommendations : [];
        return [
          renderKeyValues("ADE doctor", [
            ["ok", isRecord(value) ? value.ok : null],
            ["cli version", isRecord(value) ? value.cliVersion : null],
            ["mode", isRecord(value) ? value.mode : null],
            ["project", isRecord(value) ? value.projectRoot : null],
            ["workspace", isRecord(value) ? value.workspaceRoot : null],
            ["project initialized", project.projectInitialized],
            ["desktop socket", desktop.socketAvailable],
            ["socket path", desktop.socketPath],
            ["rpc actions", actions.rpcActionCount],
            ["service actions", actions.actionCount],
            ["git", git.message],
            ["github", github.message],
            ["linear", linear.message],
            ["providers", providers.message],
            ["computer use", computerUse.message],
            ["path", pathStatus.message],
            ["recommendation", isRecord(value) ? value.recommendation : null],
          ]),
          ...(recommendations.length ? ["", "Next actions", ...recommendations.map((entry) => `- ${cell(entry, 120)}`)] : []),
        ].join("\n");
      }
    case "auth":
      {
        const checks = isRecord(value) && isRecord(value.checks) ? value.checks : {};
        const git = isRecord(checks.git) ? checks.git : {};
        const github = isRecord(checks.github) ? checks.github : {};
        const linear = isRecord(checks.linear) ? checks.linear : {};
        const providers = isRecord(checks.providers) ? checks.providers : {};
        return renderKeyValues("ADE auth", [
          ["authenticated", isRecord(value) ? value.authenticated : null],
          ["mode", isRecord(value) ? value.authMode : null],
          ["role", isRecord(value) ? value.role : null],
          ["project", isRecord(value) ? value.projectRoot : null],
          ["actions", isRecord(value) ? value.availableActionCount : null],
          ["git", git.message],
          ["github", github.message],
          ["linear", linear.message],
          ["providers", providers.message],
          ["note", isRecord(value) ? value.note : null],
        ]);
      }
    case "lanes":
      return renderLaneGraph(value);
    case "lane-detail":
      return formatLaneDetail(value);
    case "git-status":
      return renderKeyValues("ADE git status", Object.entries(isRecord(value) ? value : {}));
    case "diff-summary":
      return formatDiffSummary(value);
    case "file-read":
      return formatFileRead(value);
    case "files-tree":
      return formatFileTree(value);
    case "files-search":
      return formatFilesSearch(value);
    case "prs-list":
      return formatPrList(value);
    case "pr-detail":
      return renderKeyValues("ADE pull request", Object.entries(firstRecord(value, ["pr", "detail"]) ?? (isRecord(value) ? value : {})).slice(0, 16));
    case "pr-checks":
      return formatPrChecks(value);
    case "pr-comments":
      return formatPrComments(value);
    case "run-defs":
      return formatRunTable(value, "ADE run definitions");
    case "run-runtime":
      return formatRunTable(value, "ADE process runtime");
    case "chat-list":
      return formatChatList(value);
    case "tests-runs":
      return formatTestsRuns(value);
    case "proof-list":
      return formatProofList(value);
    case "actions-list":
      return formatActionsList(value);
    case "action-result":
    default:
      if (isRecord(value)) return renderKeyValues("ADE result", Object.entries(value).slice(0, 24));
      return JSON.stringify(value, null, 2);
  }
}

function inferFormatter(plan: CliPlan & { kind: "execute" }): FormatterId | undefined {
  if (plan.formatter) return plan.formatter;
  if (plan.summary) return plan.summary;
  if (plan.visualizer === "lanes") return "lanes";
  const label = plan.label.toLowerCase();
  if (label === "lane status") return "lane-detail";
  if (label === "git status") return "git-status";
  if (label === "diff changes") return "diff-summary";
  if (label === "file read") return "file-read";
  if (label === "file tree" || label === "file workspaces") return "files-tree";
  if (label === "file search" || label === "file quick-open") return "files-search";
  if (label === "pr list") return "prs-list";
  if (label === "pr detail" || label === "pr health") return "pr-detail";
  if (label === "pr checks") return "pr-checks";
  if (label === "pr comments") return "pr-comments";
  if (label === "process definitions") return "run-defs";
  if (label === "process runtime") return "run-runtime";
  if (label === "chat list") return "chat-list";
  if (label === "test runs") return "tests-runs";
  if (label === "proof list") return "proof-list";
  if (label === "actions list") return "actions-list";
  if (label.endsWith("actions")) return "actions-list";
  return "action-result";
}

function summarizeExecution(args: {
  plan: CliPlan & { kind: "execute" };
  connection: CliConnection;
  values: JsonObject;
}): unknown {
  const { plan, connection, values } = args;
  if (plan.summary === "status") {
    return {
      ok: true,
      mode: connection.mode,
      projectRoot: connection.projectRoot,
      workspaceRoot: connection.workspaceRoot,
      socketPath: connection.socketPath,
      ping: values.ping,
    };
  }
  if (plan.summary === "doctor") {
    return buildReadinessSnapshot({ connection, values, summary: "doctor" });
  }
  if (plan.summary === "auth") {
    const readiness = buildReadinessSnapshot({ connection, values, summary: "auth" });
    const actions = isRecord(readiness.actions) ? readiness.actions : {};
    return {
      ok: readiness.ok,
      authenticated: isRecord(readiness.auth) ? readiness.auth.localProjectAccess : false,
      authMode: connection.mode === "desktop-socket" ? "local-desktop-socket" : "local-headless-project",
      role: process.env.ADE_DEFAULT_ROLE ?? "agent",
      projectRoot: connection.projectRoot,
      workspaceRoot: connection.workspaceRoot,
      socketPath: connection.socketPath,
      availableActionCount: actions.actionCount,
      checks: {
        git: readiness.git,
        github: readiness.github,
        linear: readiness.linear,
        providers: readiness.providers,
        computerUse: readiness.computerUse,
        path: readiness.path,
      },
      recommendations: readiness.recommendations,
      note: isRecord(readiness.auth) ? readiness.auth.note : "ADE CLI auth is local project access.",
    };
  }

  const result = values.result ?? values;
  if (
    isRecord(result)
    && Object.prototype.hasOwnProperty.call(result, "result")
    && asString(result.domain)
    && asString(result.action)
    && !plan.label.toLowerCase().startsWith("action ")
    && !plan.label.toLowerCase().endsWith(" action")
  ) {
    return result.result;
  }
  if (plan.visualizer === "lanes" && isRecord(result)) {
    return {
      ...result,
      visual: renderLaneGraph(result),
    };
  }
  return result;
}

async function executePlan(plan: CliPlan & { kind: "execute" }, options: GlobalOptions): Promise<unknown> {
  let connection: CliConnection;
  try {
    connection = await createConnection(options);
  } catch (error) {
    const roots = resolveRoots(options);
    const socketPath = path.join(roots.projectRoot, ".ade", "ade.sock");
    const requestedMode = options.requireSocket ? "desktop-socket" : options.headless ? "headless" : "auto";
    const cause = error instanceof Error ? error.message : String(error);
    const sourceRuntimeInterop = isSourceRuntimeInteropError(cause);
    throw new CliExecutionError(`Failed to initialize ADE CLI connection for ${plan.label}.`, {
      cause,
      requestedMode,
      projectRoot: roots.projectRoot,
      workspaceRoot: roots.workspaceRoot,
      socketPath,
      nextAction: options.requireSocket
        ? "Start ADE desktop for this project or remove --socket to allow headless mode."
        : sourceRuntimeInterop
          ? "Run `npm --prefix apps/ade-cli run build` and retry, or use `npm --prefix apps/ade-cli run cli:dev -- ...`."
          : "Verify --project-root points at an ADE project and run ade doctor --json.",
    });
  }
  try {
    const values: JsonObject = {};
    for (const step of plan.steps) {
      try {
        const raw = await connection.request(step.method, step.params);
        values[step.key] = step.unwrapToolResult ? unwrapToolResult(raw) : raw;
      } catch (error) {
        if (!step.optional) throw error;
        values[step.key] = {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    return summarizeExecution({ plan, connection, values });
  } catch (error) {
    if (error instanceof CliToolError || error instanceof CliUsageError || error instanceof CliExecutionError) throw error;
    throw new CliExecutionError(`Failed while running ${plan.label}.`, {
      cause: error instanceof Error ? error.message : String(error),
      mode: connection.mode,
      projectRoot: connection.projectRoot,
      workspaceRoot: connection.workspaceRoot,
      socketPath: connection.socketPath,
      nextAction: connection.mode === "desktop-socket"
        ? "Check ADE desktop logs or retry with --headless if the workflow does not need UI-owned state."
        : "Run ade doctor --json to inspect local project readiness, or start ADE desktop and retry with --socket.",
    });
  } finally {
    await connection.close();
  }
}

function formatOutput(value: unknown, options: GlobalOptions, formatter?: FormatterId): string {
  if (options.text) {
    return `${formatTextOutput(value, formatter)}\n`;
  }
  return `${JSON.stringify(value, null, options.pretty ? 2 : 0)}\n`;
}

async function runCli(argv: string[]): Promise<{ output: string; exitCode: number }> {
  const parsed = parseCliArgs(argv);
  const plan = buildCliPlan(parsed.command);
  if (plan.kind === "help") return { output: plan.text.endsWith("\n") ? plan.text : `${plan.text}\n`, exitCode: 0 };
  const originalConsole = {
    log: console.log,
    info: console.info,
    warn: console.warn,
  };
  const writeDiagnostic = (...args: unknown[]) => {
    process.stderr.write(`${args.map((arg) => typeof arg === "string" ? arg : JSON.stringify(arg)).join(" ")}\n`);
  };
  console.log = writeDiagnostic;
  console.info = writeDiagnostic;
  console.warn = writeDiagnostic;
  let result: unknown;
  try {
    result = await executePlan(plan, parsed.options);
  } finally {
    console.log = originalConsole.log;
    console.info = originalConsole.info;
    console.warn = originalConsole.warn;
  }
  return { output: formatOutput(result, parsed.options, inferFormatter(plan)), exitCode: 0 };
}

async function main(): Promise<void> {
  const writeDiagnostic = (...args: unknown[]) => {
    process.stderr.write(`${args.map((arg) => typeof arg === "string" ? arg : JSON.stringify(arg)).join(" ")}\n`);
  };
  console.log = writeDiagnostic;
  console.info = writeDiagnostic;
  console.warn = writeDiagnostic;
  try {
    const result = await runCli(process.argv.slice(2));
    process.stdout.write(result.output);
    process.exitCode = result.exitCode;
  } catch (error) {
    const fallback = maybeRunBuiltCliFallback(error, process.argv.slice(2));
    if (fallback) {
      if (fallback.stderr.length) process.stderr.write(fallback.stderr);
      if (fallback.stdout.length) process.stdout.write(fallback.stdout);
      process.exitCode = fallback.exitCode;
      return;
    }
    if (error instanceof CliUsageError) {
      process.stderr.write(`ade: ${error.message}\nRun 'ade help'.\n`);
      process.exitCode = 2;
      return;
    }
    if (error instanceof CliToolError) {
      process.stderr.write(`ade: ${error.message}\n`);
      if (error.details !== undefined) {
        process.stderr.write(`${JSON.stringify(error.details, null, 2)}\n`);
      }
      process.exitCode = 1;
      return;
    }
    if (error instanceof CliExecutionError) {
      process.stderr.write(`ade: ${error.message}\n`);
      process.stderr.write(`${JSON.stringify(error.details, null, 2)}\n`);
      process.exitCode = 1;
      return;
    }
    process.stderr.write(`ade: ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (/(^|[/\\])cli\.(?:ts|js|cjs)$/.test(process.argv[1] ?? "")) {
  void main();
}

export {
  buildCliPlan,
  findProjectRoots,
  formatOutput,
  parseCliArgs,
  renderLaneGraph,
  resolveRoots,
  runCli,
  summarizeExecution,
  unwrapToolResult,
};
