import { ADE_ACTION_ACCESS } from "../../../../desktop/src/shared/adeActionAccess";
import { isSecretBearingAdeAction } from "../../../../desktop/src/main/services/adeActions/actionPolicy";
import type { RemoteMcpScope } from "../../../../desktop/src/shared/types/remoteMcp";

/**
 * Which `ade` commands a remote AI app may run, by the scope of its connection.
 *
 * `write` is full access: the app can do what the person could do in a
 * terminal. The commands refused are the ones that would outlive or get
 * around the switch that grants the access (managing remote access itself,
 * minting account tokens, signing the machine in or out), or that cannot work
 * without a terminal and would cut the connection (the brain's own lifecycle,
 * interactive setup, `ade code`, a hard reset).
 *
 * Both scopes fail closed. Every top-level command is either in
 * FULL_ACCESS_COMMANDS or in BLOCKED_COMMANDS; a command in neither is refused,
 * so a new `ade` command is unavailable remotely until someone decides which
 * list it belongs in (and, if it only reads, adds it to READ_ONLY_COMMANDS).
 *
 * `read` is an allowlist of commands that only read. Anything not on the list
 * is refused, so a new command is read-only-unavailable until someone adds it.
 */


const MAX_REMOTE_ARGS = 64;
const MAX_REMOTE_ARG_CHARS = 8_000;

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
  ["account", "Account tokens outlive ADE MCP, so they are created on the computer itself."],
]);

/**
 * Every other top-level command, with the spellings the CLI accepts. Full
 * access runs these; read-only runs the subset in READ_ONLY_COMMANDS.
 */
const FULL_ACCESS_COMMANDS: ReadonlySet<string> = new Set([
  "action", "actions", "ade-browser", "agent", "agents", "app", "app-control", "apple", "apps", "archive",
  "archived", "artifact", "artifacts", "ask", "auth", "auto-update", "automation", "automations", "browser",
  "built-in-browser", "builtin-browser", "chat", "chats", "computer", "computer-use", "config", "coord",
  "coordinator", "create", "cursor", "desk", "diff", "diffs", "disk", "doctor", "drafts", "electron", "file",
  "files", "gh", "git", "github", "harness", "harnesses", "health", "help", "history", "init", "ios", "ios-sim",
  "issue", "jira", "lane", "lanes", "linear", "link", "mac-desk", "mac-desktop", "machine", "machines", "models", "new",
  "notify", "open", "operation", "operations", "pr", "project", "projects", "proof", "provider",
  "providers", "proxy", "prs", "pty", "quota", "quotas", "report-issue", "router", "scene", "scenes", "screen",
  "search", "secret", "secrets", "session", "sessions", "setting", "settings", "shell", "simulator", "skill",
  "skills", "status", "storage", "sync", "term", "terminal", "test", "tests", "tools", "tools-pane", "triage", "ui",
  "update", "updates", "usage", "version", "windows-desk", "windows-desktop", "work", "work-tools", "worktools",
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
  // `find` reads the built-in settings list; nothing reaches the brain.
  ["settings", new Set(["find", "search", "where"])],
  ["setting", new Set(["find", "search", "where"])],
  ["config", new Set(["find", "search", "where"])],
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
    "list", "inbox", "pending", "read", "show", "status", "launches", "launch-status", "waits", "subagents", "models",
    "linear-issues", "actions", "wait", "watch",
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
  ["usage", new Set(["limits", "limit", "left", "snapshot", "stats", "prices", "turns"])],
  ["usage budget", new Set(["get", "check", "cumulative"])],
  ["storage", new Set(["snapshot", "actions"])],
  ["archive", new Set(["list", "summary"])],
  ["skill", new Set(["list", "show"])],
  ["skills", new Set(["list", "show"])],
  ["work-tools", new Set(["state", "actions"])],
  ["sync", new Set(["status"])],
  ["update", new Set(["status"])],
  ["tools", new Set(["status"])],
  ["secrets", new Set(["list"])],
  ["providers", new Set(["actions"])],
  ["providers accounts", new Set(["list"])],
  ["router", new Set(["routes"])],
  ["models", new Set(["catalog", "sheet"])],
  ["proxy", new Set(["status"])],
  ["actions", new Set(["list"])],
]);

/** Commands whose `<command> <word>` names a nested group, not a subcommand. */
const NESTED_GROUPS: ReadonlySet<string> = new Set([
  "prs stacks", "github issue", "github app-auth", "automations webhook", "usage budget", "providers accounts",
]);

type RemoteCommandVerdict =
  | { ok: true; args: string[] }
  | { ok: false; reason: string };

/**
 * Normalizes and checks one remote `ade` invocation. Returns the argv to run
 * (without the program name), or a sentence a model can act on.
 */
export function checkRemoteAdeCommand(
  input: unknown,
  scope: RemoteMcpScope,
  options: { hasStdin?: boolean } = {},
): RemoteCommandVerdict {
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
  // Only a plain command word may come first. Global flags (`--socket`,
  // `--headless`, `--role`, `--project-root`) take effect before it, and the
  // runner's own `--socket` takes a path-looking next word as the socket; a
  // command word can be neither, so every call stays on this brain, at the
  // caller's scope, in the chosen project.
  if (!COMMAND_WORD.test(args[0]!)) {
    return {
      ok: false,
      reason: "Start with the command word (e.g. \"lanes\"); options go after it. Use the `project` parameter to pick a project.",
    };
  }
  const command = COMMAND_ALIASES.get(args[0]!) ?? args[0]!;
  const blocked = BLOCKED_COMMANDS.get(command);
  if (blocked) return { ok: false, reason: `\`ade ${command}\` is not available remotely. ${blocked}` };
  if (!FULL_ACCESS_COMMANDS.has(args[0]!)) {
    return {
      ok: false,
      reason: `\`ade ${args[0]}\` isn't enabled for ADE MCP. Run \`ade help\` for the commands it can use.`,
    };
  }
  // ADE MCP is switched on per computer. Forwarding to another machine would
  // reach one whose owner may have it off.
  if (args.some((word) => MACHINE_TARGET_FLAG.test(word))) {
    return {
      ok: false,
      reason: "ADE MCP reaches only this computer. Connect to another computer's own ADE MCP server to work there.",
    };
  }
  const words = positionalWords(args);
  // It asks every computer of the account; ADE MCP's chat tools run it for a
  // connection and apply its own computer rules (remoteMcpProtocol.ts).
  if ((command === "chat" || command === "chats") && words[0] === "locate") {
    return { ok: false, reason: "ADE MCP reaches only this computer. The chat tools find a chat's computer by themselves." };
  }
  if (isServiceSignInCommand(command, words)) {
    return { ok: false, reason: `\`ade ${command} ${words.slice(0, 2).join(" ")}\` is not available remotely. ${SERVICE_SIGN_IN_REASON}` };
  }
  // Renaming, removing or re-pairing account machines outlives revoking the
  // connection, like account tokens; reading the roster is fine.
  if (command === "machines" && !MACHINE_READ_SUBCOMMANDS.has(words[0] ?? "list")) {
    return {
      ok: false,
      reason: `\`ade machines ${words[0]}\` is not available remotely. Changing the machines on your ADE account is done on a computer itself.`,
    };
  }
  if (command === "actions") {
    const actionVerdict = checkActionsCommand(words, scope);
    if (actionVerdict) return actionVerdict;
  }
  // With stdin closed, `files write --stdin` would write an empty file.
  if (!options.hasStdin && readsStdin(args)) {
    return {
      ok: false,
      reason: "This command reads its input from stdin. Pass the text as the `stdin` parameter.",
    };
  }
  if (scope === "write") return { ok: true, args };
  return checkReadOnly([command, ...args.slice(1)], words);
}

const COMMAND_WORD = /^[a-z][a-z0-9-]*$/;
/** Spellings the CLI treats as the same command. */
const COMMAND_ALIASES: ReadonlyMap<string, string> = new Map([["action", "actions"], ["machine", "machines"], ["gh", "github"]]);
/** `ade machines` subcommands that only read the roster. */
const MACHINE_READ_SUBCOMMANDS: ReadonlySet<string> = new Set(["list", "ls", "show", "view", "get", "info"]);
const MACHINE_TARGET_FLAG = /^--(?:machine|all-machines|machine-project)(?:=|$)/;
const SERVICE_SIGN_IN_REASON =
  "Signing this computer in or out of a service (GitHub, Linear, Jira, an AI provider) outlives ADE MCP, so it is done on the computer itself.";
/** `ade github` groups that manage the machine's GitHub App authorization. */
const GITHUB_AUTH_GROUPS: ReadonlySet<string> = new Set(["app-auth", "app", "auth"]);
/** Spellings of `ade github app-auth login` and `clear`. */
const GITHUB_AUTH_CHANGES: ReadonlySet<string> = new Set(["login", "authorize", "start", "clear", "logout", "sign-out"]);
/**
 * Service credential actions, by domain; `true` means every action. The CLI
 * runs full access as `cto`, which these actions otherwise allow.
 */
const SERVICE_SIGN_IN_ACTIONS: ReadonlyMap<string, ReadonlySet<string> | true> = new Map<string, ReadonlySet<string> | true>([
  ["github", new Set(["setToken", "clearToken", "startAppUserDeviceAuth", "pollAppUserDeviceAuth", "clearAppUserAuth"])],
  ["linear_credentials", true],
  ["linear_oauth", true],
  ["jira", new Set(["connect", "disconnect"])],
  // Installing the ADE agent in Linear runs an OAuth consent and stores its token.
  ["linear_agent", new Set(["startInstall", "uninstall"])],
  ["ai", new Set([
    "storeApiCredential", "removeApiCredential", "storeApiKey", "deleteApiKey",
    "setOpencodeProviderKey", "clearOpencodeProviderKey", "opencodeOAuthStart", "opencodeCloudConnect",
    "opencodeAccountRemove", "piLoginStart", "piLoginSubmit", "cursorAuthLogin", "cursorAuthLogout",
    "antigravitySignInStart", "antigravitySignInComplete",
  ])],
]);

/**
 * The whole `account_vault` domain, at every scope: it holds the account's
 * credentials, ADE MCP's own token hashes and its account secret.
 */
const ACCOUNT_VAULT_REASON = "The account vault holds your ADE account's credentials, so it is used on the computer itself.";

/** Spellings of `ade providers opencode accounts remove`, which signs OpenCode out. */
const OPENCODE_ACCOUNT_REMOVALS: ReadonlySet<string> = new Set(["remove", "rm", "delete"]);

/** Signing this machine in or out of a connected service. */
function isServiceSignInCommand(command: string, words: readonly string[]): boolean {
  if (command === "github") return GITHUB_AUTH_GROUPS.has(words[0] ?? "") && GITHUB_AUTH_CHANGES.has(words[1] ?? "");
  if (command === "jira") return words[0] === "connect" || words[0] === "disconnect";
  if (command === "providers") {
    return words[0] === "opencode" && (words[1] === "accounts" || words[1] === "account")
      && OPENCODE_ACCOUNT_REMOVALS.has(words[2] ?? "");
  }
  return false;
}

/** `ade actions` subcommands that call RPC tools by name, around the action table. */
const RAW_ACTION_DOORS: ReadonlySet<string> = new Set(["call", "direct", "tool"]);

/** The command's non-flag words after the command itself, the way the CLI reads them. */
function positionalWords(args: readonly string[]): string[] {
  return args.slice(1).filter((word) => word !== "--" && !word.startsWith("-"));
}

/** `<domain.action>` or `<domain> <action>`, as `ade actions run` accepts. */
function actionRunTarget(words: readonly string[]): { domain: string; action: string } | null {
  const first = words[1];
  if (!first) return null;
  const dot = first.indexOf(".");
  if (dot > 0) return { domain: first.slice(0, dot), action: first.slice(dot + 1) };
  return words[2] ? { domain: first, action: words[2] } : null;
}

/**
 * `ade actions` reaches every service action, so it must not reach what the
 * blocked commands wrap: managing ADE MCP, or account credentials and sign-out
 * that would outlive revoking the connection.
 */
function checkActionsCommand(words: readonly string[], scope: RemoteMcpScope): RemoteCommandVerdict | null {
  const sub = words[0] ?? "list";
  if (RAW_ACTION_DOORS.has(sub)) {
    return { ok: false, reason: `\`ade actions ${sub}\` is not available remotely. Use \`ade actions run <domain.action>\`.` };
  }
  if (sub !== "run") return null;
  const target = actionRunTarget(words);
  if (!target) return null;
  const name = `${target.domain}.${target.action}`;
  if (target.domain === "remote_mcp") {
    return { ok: false, reason: `\`${name}\` is not available remotely. ${BLOCKED_COMMANDS.get("mcp")}` };
  }
  if (target.domain === "account" && target.action !== "status") {
    return { ok: false, reason: `\`${name}\` is not available remotely. ${BLOCKED_COMMANDS.get("account")}` };
  }
  if (target.domain === "account_vault") {
    return { ok: false, reason: `\`${name}\` is not available remotely. ${ACCOUNT_VAULT_REASON}` };
  }
  const signIn = SERVICE_SIGN_IN_ACTIONS.get(target.domain);
  if (signIn === true || signIn?.has(target.action)) {
    return { ok: false, reason: `\`${name}\` is not available remotely. ${SERVICE_SIGN_IN_REASON}` };
  }
  if (scope === "read") {
    const access = Object.hasOwn(ADE_ACTION_ACCESS, target.domain) ? ADE_ACTION_ACCESS[target.domain] : undefined;
    if (!access?.read.includes(target.action)) {
      return { ok: false, reason: `This connection is read-only, and \`${name}\` changes things.` };
    }
    if (isSecretBearingAdeAction(target.domain, target.action)) {
      return { ok: false, reason: `\`${name}\` returns a secret, so it is not available remotely.` };
    }
  }
  return null;
}

/** Flags that make a command read its input from stdin. */
const STDIN_FLAGS: ReadonlySet<string> = new Set(["--stdin", "--json-stdin", "--token-stdin"]);

/** `--stdin`, or `-` as the value of a file or prompt flag (`--body-file -`, `--prompt -`). */
function readsStdin(args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index]!;
    if (word === "--") return false;
    if (STDIN_FLAGS.has(word)) return true;
    const isInputFlag = /^--[a-z-]*(?:file|prompt)$/.test(word);
    if (isInputFlag && args[index + 1] === "-") return true;
    if (/^--[a-z-]*(?:file|prompt)=-$/.test(word)) return true;
  }
  return false;
}

/**
 * `<command> [<sub>…] --help` only prints help, so a read-only connection may
 * ask for any page. Only that exact shape: after a flag that takes a value
 * (`--project-root --help`), the CLI reads `--help` as the value and runs the
 * command.
 */
function asksForHelp(args: readonly string[]): boolean {
  const last = args[args.length - 1];
  if (last !== "--help" && last !== "-h") return false;
  return args.slice(0, -1).every((word) => COMMAND_WORD.test(word));
}

/** `chat wait` flags that arm, hold or cancel a wait instead of only watching. */
const CHAT_WAIT_WRITE_FLAGS = /^--(?:async|background|cancel|cancel-wait)(?:=|$)/;

function checkReadOnly(args: string[], words: readonly string[]): RemoteCommandVerdict {
  const refuse = (): RemoteCommandVerdict => ({
    ok: false,
    reason: `This connection is read-only, and \`ade ${args.slice(0, 3).filter((word) => !word.startsWith("-")).join(" ")}\` isn't one of the commands it can run. `
      + "Read-only connections can run: " + describeReadOnlyCommands() + ". "
      + "Ask the person to give this app full access in ADE Settings → ADE MCP if it needs more.",
  });
  const command = args[0]!;
  if (asksForHelp(args)) return { ok: true, args };
  const group = args[1] && !args[1].startsWith("-") ? `${command} ${args[1]}` : null;
  if (group && NESTED_GROUPS.has(group)) {
    const allowed = READ_ONLY_COMMANDS.get(group);
    const sub = args[2];
    if (allowed instanceof Set && sub && allowed.has(sub)) return { ok: true, args };
    return refuse();
  }
  if (command === "search" && args.some((word) => SEARCH_WRITE_FLAGS.has(word))) return refuse();
  const isChatWait = command === "chat" && (args[1] === "wait" || args[1] === "watch");
  if (isChatWait && args.some((word) => CHAT_WAIT_WRITE_FLAGS.test(word))) return refuse();
  const allowed = READ_ONLY_COMMANDS.get(command);
  if (allowed === true) return { ok: true, args };
  if (!(allowed instanceof Set)) return refuse();
  const sub = args[1];
  // `actions run` passed checkActionsCommand's read-only test before getting here.
  if (command === "actions" && sub === "run" && words[0] === "run") return { ok: true, args };
  if (sub && allowed.has(sub)) return { ok: true, args };
  return refuse();
}

/** `ade search` flags that rebuild the index instead of reading it. */
const SEARCH_WRITE_FLAGS: ReadonlySet<string> = new Set(["--rebuild", "--rebuild-index"]);

let readOnlyDescription: string | null = null;

/** One line listing what a read-only connection can run, for errors and tool text. */
function describeReadOnlyCommands(): string {
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

/** A flag whose value is a credential (`--api-key sk-…`). */
const SECRET_FLAG_NAME = /token|secret|password|api[-_]?key|credential/i;

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
    const previous = args[index - 1] ?? "";
    if (previous.startsWith("-") && SECRET_FLAG_NAME.test(previous)) {
      out.push("[redacted]");
      continue;
    }
    out.push(/\s/.test(word) ? JSON.stringify(word) : word);
  }
  const line = out.join(" ");
  return line.length > 300 ? `${line.slice(0, 297)}...` : line;
}

/** Describes which part of a command is available to an MCP connection. */
export function remoteCommandAvailability(
  topic: string,
  scope: RemoteMcpScope,
): { command: string; allowed: boolean; subcommands: readonly string[] | null; reason?: string } {
  const words = topic.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words[0] === "ade") words.shift();
  const requestedCommand = words[0] ?? "";
  const command = COMMAND_ALIASES.get(requestedCommand) ?? requestedCommand;
  const blocked = BLOCKED_COMMANDS.get(command);
  if (blocked) return { command, allowed: false, subcommands: null, reason: blocked };
  if (!FULL_ACCESS_COMMANDS.has(requestedCommand) && !FULL_ACCESS_COMMANDS.has(command)) {
    return {
      command,
      allowed: false,
      subcommands: null,
      reason: "This command is not enabled for ADE MCP.",
    };
  }
  const group = words[1] ? `${command} ${words[1]}` : null;
  const nestedGroup = group && NESTED_GROUPS.has(group) ? group : null;
  const policyCommand = nestedGroup ?? command;
  // A subcommand topic gets the same verdict as running it (`github app-auth
  // login` is refused even with full access).
  const namesOnlyGroup = nestedGroup !== null && words.length === 2;
  if (words.length >= 2 && !namesOnlyGroup) {
    const verdict = checkRemoteAdeCommand(words, scope, { hasStdin: true });
    if (!verdict.ok) return { command: policyCommand, allowed: false, subcommands: null, reason: verdict.reason };
  }
  if (scope === "write") return { command: policyCommand, allowed: true, subcommands: null };

  const allowed = nestedGroup
    ? READ_ONLY_COMMANDS.get(nestedGroup)
    : READ_ONLY_COMMANDS.get(command);
  if (allowed === true) return { command: policyCommand, allowed: true, subcommands: null };
  if (!(allowed instanceof Set)) {
    return {
      command: policyCommand,
      allowed: false,
      subcommands: null,
      reason: "This command is not available to read-only connections.",
    };
  }

  const subcommand = words[nestedGroup ? 2 : 1];
  if (subcommand && !allowed.has(subcommand)) {
    return {
      command: policyCommand,
      allowed: false,
      subcommands: [...allowed],
      reason: "This subcommand is not available to read-only connections.",
    };
  }
  return { command: policyCommand, allowed: true, subcommands: [...allowed] };
}
