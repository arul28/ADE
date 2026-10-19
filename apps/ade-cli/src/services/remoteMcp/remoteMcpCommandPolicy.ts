import { ADE_ACTION_ACCESS } from "../../../../desktop/src/shared/adeActionAccess";
import { isSecretBearingAdeAction } from "../../../../desktop/src/main/services/adeActions/actionPolicy";
import type { RemoteMcpScope } from "../../../../desktop/src/shared/types/remoteMcp";

export type { RemoteMcpScope };

/**
 * Which `ade` commands a remote AI app may run, by the scope of its connection.
 *
 * `write` is full access: the app can do what the person could do in a
 * terminal. The only commands refused are the ones that would outlive or get
 * around the switch that grants the access (managing remote access itself,
 * minting account tokens, signing the machine in or out), or that cannot work
 * without a terminal and would cut the connection (the brain's own lifecycle,
 * interactive setup, `ade code`, a hard reset).
 *
 * `read` is an allowlist of commands that only read. Anything not on the list
 * is refused, so a new command is read-only-unavailable until someone adds it.
 */


export const MAX_REMOTE_ARGS = 64;
export const MAX_REMOTE_ARG_CHARS = 8_000;

/** Never runnable remotely, at any scope. */
const BLOCKED_COMMANDS: ReadonlyMap<string, string> = new Map([
  ["mcp", "ADE MCP is managed on the computer itself, not by a connected app."],
  ["login", "Signing this computer in or out is done on the computer itself."],
  ["logout", "Signing this computer in or out is done on the computer itself."],
  ["connect", "Linking this computer to an account is done on the computer itself."],
  ["setup", "Setup is interactive and runs on the computer itself."],
  ["reset", "Resetting ADE is done on the computer itself."],
  ["brain", "Starting or stopping ADE's brain would cut this connection."],
  ["serve", "Starting or stopping ADE's brain would cut this connection."],
  ["runtime", "Running another ADE runtime is not available remotely."],
  ["rpc", "The raw RPC stream is not available remotely."],
  ["code", "`ade code` needs a terminal."],
  ["desktop", "Opening the desktop app is done on the computer itself."],
]);

/** Blocked only with a particular subcommand. */
const BLOCKED_SUBCOMMANDS: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map([
  ["account", new Map([["token", "Account tokens outlive remote access, so they are created on the computer itself."]])],
]);

/**
 * The read-only allowlist. A key is the command, or `command subcommand` for
 * three-word commands; the value is the allowed subcommands, or `true` when the
 * command takes no subcommand (any following words are its own arguments).
 */
const READ_ONLY_COMMANDS: ReadonlyMap<string, ReadonlySet<string> | true> = new Map<string, ReadonlySet<string> | true>([
  ["help", true],
  ["doctor", true],
  ["search", true],
  ["auth", new Set(["status"])],
  ["machines", new Set(["list", "show"])],
  ["projects", new Set(["list"])],
  ["lanes", new Set(["list", "show", "actions", "reclaim-preview"])],
  ["lane", new Set(["list", "show", "actions", "reclaim-preview"])],
  ["git", new Set(["status", "branches", "is-reachable"])],
  ["diff", new Set(["changes", "file", "patch", "actions"])],
  ["files", new Set(["tree", "read", "search", "workspaces", "quick-open"])],
  ["operations", new Set(["status", "wait"])],
  ["prs", new Set(["list", "list-open", "show", "checks", "comments", "watch-status", "github-snapshot"])],
  ["prs stacks", new Set(["list"])],
  ["chat", new Set([
    "list", "read", "show", "status", "launches", "launch-status", "waits", "subagents", "models",
    "linear-issues", "actions",
  ])],
  ["terminal", new Set(["list", "read", "active"])],
  ["history", new Set(["list", "show", "commits"])],
  ["drafts", new Set(["list", "show"])],
  ["session", new Set(["show", "actions"])],
  ["linear", new Set(["issue", "issues"])],
  ["jira", new Set(["status", "list", "issue", "projects"])],
  ["issue", new Set(["list", "view"])],
  ["github", new Set(["actions"])],
  ["github issue", new Set(["list", "view"])],
  ["github app-auth", new Set(["status"])],
  ["automations", new Set(["list", "show", "runs", "run-show"])],
  ["automations webhook", new Set(["list", "deliveries", "delivery"])],
  ["tests", new Set(["list", "runs", "logs"])],
  ["proof", new Set(["status", "list", "broken"])],
  ["usage", new Set(["snapshot", "stats", "prices", "turns"])],
  ["usage budget", new Set(["get", "check", "cumulative"])],
  ["storage", new Set(["snapshot", "actions"])],
  ["archive", new Set(["list", "summary"])],
  ["skill", new Set(["list", "show"])],
  ["work-tools", new Set(["state", "actions"])],
  ["sync", new Set(["status"])],
  ["update", new Set(["status"])],
  ["tools", new Set(["status"])],
  ["secrets", new Set(["list"])],
  ["providers", new Set(["actions"])],
  ["providers accounts", new Set(["list"])],
  ["router", new Set(["routes"])],
  ["proxy", new Set(["status"])],
  ["actions", new Set(["list"])],
]);

/** Commands whose `<command> <word>` names a nested group, not a subcommand. */
const NESTED_GROUPS: ReadonlySet<string> = new Set([
  "prs stacks", "github issue", "github app-auth", "automations webhook", "usage budget", "providers accounts",
]);

export type RemoteCommandVerdict =
  | { ok: true; args: string[] }
  | { ok: false; reason: string };

/**
 * Normalizes and checks one remote `ade` invocation. Returns the argv to run
 * (without the program name), or a sentence a model can act on.
 */
export function checkRemoteAdeCommand(input: unknown, scope: RemoteMcpScope): RemoteCommandVerdict {
  if (!Array.isArray(input) || input.length === 0) {
    return { ok: false, reason: "Pass `args` as a non-empty list of words, e.g. [\"lanes\", \"list\", \"--text\"]." };
  }
  if (input.length > MAX_REMOTE_ARGS + 1) {
    return { ok: false, reason: `At most ${MAX_REMOTE_ARGS} arguments.` };
  }
  const args: string[] = [];
  for (const value of input) {
    if (typeof value !== "string") return { ok: false, reason: "Every argument must be a string." };
    if (value.length > MAX_REMOTE_ARG_CHARS) {
      return { ok: false, reason: `An argument is longer than ${MAX_REMOTE_ARG_CHARS} characters.` };
    }
    if (value.includes("\0")) return { ok: false, reason: "Arguments cannot contain NUL characters." };
    args.push(value);
  }
  // Models often include the program name.
  if (args[0] === "ade") args.shift();
  if (args.length === 0) return { ok: false, reason: "Name an ade command, e.g. [\"help\"]." };
  if (args.length > MAX_REMOTE_ARGS) return { ok: false, reason: `At most ${MAX_REMOTE_ARGS} arguments.` };
  const command = args[0]!;
  // Global flags (`--socket`, `--headless`, `--role`, `--project-root`) only
  // take effect before the command word. Refusing a leading flag keeps every
  // remote call on this brain, at the caller's scope, in the chosen project.
  if (command.startsWith("-")) {
    return {
      ok: false,
      reason: "Start with the command word (e.g. \"lanes\"); options go after it. Use the `project` parameter to pick a project.",
    };
  }
  const blocked = BLOCKED_COMMANDS.get(command);
  if (blocked) return { ok: false, reason: `\`ade ${command}\` is not available remotely. ${blocked}` };
  const sub = args[1];
  const blockedSub = sub ? BLOCKED_SUBCOMMANDS.get(command)?.get(sub) : undefined;
  if (blockedSub) return { ok: false, reason: `\`ade ${command} ${sub}\` is not available remotely. ${blockedSub}` };
  // The generic action door must not reach what the blocked commands wrap.
  if (command === "actions" && sub === "run") {
    const name = args[2] ?? "";
    if (name.startsWith("remote_mcp.")) {
      return { ok: false, reason: `\`${name}\` is not available remotely. ${BLOCKED_COMMANDS.get("mcp")}` };
    }
    if (name === "account.createToken") {
      return { ok: false, reason: `\`${name}\` is not available remotely. ${BLOCKED_SUBCOMMANDS.get("account")?.get("token")}` };
    }
  }
  if (scope === "write") return { ok: true, args };
  return checkReadOnly(args);
}

function checkReadOnly(args: string[]): RemoteCommandVerdict {
  const refuse = (): RemoteCommandVerdict => ({
    ok: false,
    reason: `This connection is read-only, and \`ade ${args.slice(0, 3).filter((word) => !word.startsWith("-")).join(" ")}\` isn't one of the commands it can run. `
      + "Read-only connections can run: " + describeReadOnlyCommands() + ". "
      + "Ask the person to give this app full access in ADE Settings → ADE MCP if it needs more.",
  });
  const command = args[0]!;
  const group = args[1] && !args[1].startsWith("-") ? `${command} ${args[1]}` : null;
  if (group && NESTED_GROUPS.has(group)) {
    const allowed = READ_ONLY_COMMANDS.get(group);
    const sub = args[2];
    if (allowed instanceof Set && sub && allowed.has(sub)) return { ok: true, args };
    return refuse();
  }
  const allowed = READ_ONLY_COMMANDS.get(command);
  if (allowed === true) return { ok: true, args };
  if (!(allowed instanceof Set)) return refuse();
  const sub = args[1];
  if (command === "actions" && sub === "run") return checkReadOnlyActionRun(args, refuse);
  if (sub && allowed.has(sub)) return { ok: true, args };
  return refuse();
}

/**
 * `ade actions run <domain.action>` is allowed read-only when ADE declares the
 * action a read and its result carries no secret.
 */
function checkReadOnlyActionRun(args: string[], refuse: () => RemoteCommandVerdict): RemoteCommandVerdict {
  const name = args[2] ?? "";
  const dot = name.indexOf(".");
  if (dot <= 0) return refuse();
  const domain = name.slice(0, dot);
  const action = name.slice(dot + 1);
  const access = ADE_ACTION_ACCESS[domain];
  if (!access || !access.read.includes(action)) return refuse();
  if (isSecretBearingAdeAction(domain, action)) {
    return { ok: false, reason: `\`${name}\` returns a secret, so it is not available remotely.` };
  }
  return { ok: true, args };
}

let readOnlyDescription: string | null = null;

/** One line listing what a read-only connection can run, for errors and tool text. */
export function describeReadOnlyCommands(): string {
  if (readOnlyDescription) return readOnlyDescription;
  const parts: string[] = [];
  for (const [command, allowed] of READ_ONLY_COMMANDS) {
    if (allowed === true) parts.push(command);
    else parts.push(`${command} ${[...allowed].join("|")}`);
  }
  parts.push("actions run <a read-only action>");
  readOnlyDescription = parts.join(", ");
  return readOnlyDescription;
}

/**
 * Splits a single command string into words, honoring single and double
 * quotes and backslash escapes. For models that send `"lanes list --text"`
 * instead of a list. No expansion of any kind happens: the words go to the
 * CLI as argv, never to a shell.
 */
export function splitCommandLine(line: string): string[] | null {
  const words: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let hasWord = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (quote) {
      if (char === quote) {
        quote = null;
      } else if (char === "\\" && quote === "\"" && index + 1 < line.length) {
        index += 1;
        current += line[index];
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      hasWord = true;
      continue;
    }
    if (char === "\\" && index + 1 < line.length) {
      index += 1;
      current += line[index];
      hasWord = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (hasWord) {
        words.push(current);
        current = "";
        hasWord = false;
      }
      continue;
    }
    current += char;
    hasWord = true;
  }
  if (quote) return null;
  if (hasWord) words.push(current);
  return words;
}

/**
 * The words safe to keep in the activity log. Values that look like they set a
 * secret are replaced, and the whole line is bounded.
 */
export function redactedCommandForLog(args: readonly string[]): string {
  const out: string[] = [];
  const secretCommand = args[0] === "secrets" && (args[1] === "set" || args[1] === "request");
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index]!;
    if (secretCommand && index >= 3) {
      out.push("[redacted]");
      continue;
    }
    if (/(?:token|secret|password|api[-_]?key)=/i.test(word)) {
      out.push(word.replace(/=.*/, "=[redacted]"));
      continue;
    }
    out.push(/\s/.test(word) ? JSON.stringify(word) : word);
  }
  const line = out.join(" ");
  return line.length > 300 ? `${line.slice(0, 297)}...` : line;
}
