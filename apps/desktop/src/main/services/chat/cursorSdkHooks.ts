import fs from "node:fs";
import path from "node:path";
import { getErrorMessage } from "../shared/utils";

const ADE_HOOK_SCRIPT_NAME = "ade-tool-gate.cjs";
const ADE_HOOK_SHELL_COMMAND_NAME = "ade-tool-gate.sh";
const ADE_HOOK_WINDOWS_COMMAND_NAME = "ade-tool-gate.cmd";
/**
 * The `preCompact` reporter has scripts of its own. `~/.cursor/hooks.json` and
 * `~/.cursor/hooks/` are shared with the Cursor IDE/CLI and with every ADE build
 * on the machine, and an older build rewrites the `ade-tool-gate.*` scripts with
 * its own permission gate. Pointing `preCompact` at the gate would run that gate
 * on every compaction; no ADE build rewrites these, and they answer `{}` on
 * every path, so a compaction is never blocked and never carries an ADE message.
 */
const ADE_PRECOMPACT_SCRIPT_NAME = "ade-precompact.cjs";
const ADE_PRECOMPACT_SHELL_COMMAND_NAME = "ade-precompact.sh";
const ADE_PRECOMPACT_WINDOWS_COMMAND_NAME = "ade-precompact.cmd";
/**
 * Set only in the environment of a Cursor agent that an ADE worker able to read
 * a `preCompact` report spawned. Without it the reporter answers `{}` and does
 * not connect, so an older build's socket never reads the report as a tool call.
 */
export const CURSOR_SDK_PRECOMPACT_ENV = "ADE_CURSOR_SDK_PRECOMPACT";
const ADE_HOOK_FILE_NAMES = [
  ADE_HOOK_SCRIPT_NAME,
  ADE_HOOK_SHELL_COMMAND_NAME,
  ADE_HOOK_WINDOWS_COMMAND_NAME,
  ADE_PRECOMPACT_SCRIPT_NAME,
  ADE_PRECOMPACT_SHELL_COMMAND_NAME,
  ADE_PRECOMPACT_WINDOWS_COMMAND_NAME,
];

type CursorHooksConfig = {
  version?: unknown;
  hooks?: unknown;
  [key: string]: unknown;
};

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function shellQuote(value: string): string {
  if (/[\0\r\n]/.test(value)) {
    throw new Error("Cursor hook command paths cannot contain control characters.");
  }
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

function shellSingleQuote(value: string): string {
  if (/[\0\r\n]/.test(value)) {
    throw new Error("Cursor hook command paths cannot contain control characters.");
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function windowsCmdQuote(value: string): string {
  if (/[\0\r\n"%]/.test(value)) {
    throw new Error("Cursor hook command paths cannot contain control characters or Windows cmd expansion characters.");
  }
  return `"${value}"`;
}

function windowsBatchQuote(value: string): string {
  if (/[\0\r\n"]/.test(value)) {
    throw new Error("Cursor hook command paths cannot contain control characters or double quotes.");
  }
  return `"${value.replace(/%/g, "%%")}"`;
}

function commandPathQuote(value: string): string {
  return process.platform === "win32" ? windowsCmdQuote(value) : shellQuote(value);
}

function buildHookCommand(
  nodePath: string | undefined,
  scriptPath: string,
  windowsCommandPath?: string,
  shellCommandPath?: string,
): string {
  if (process.platform !== "win32" && shellCommandPath) {
    // The POSIX wrapper embeds node/electron paths and can allow normal Cursor
    // sessions through before Node is needed.
    return `/bin/sh ${shellQuote(shellCommandPath)}`;
  }
  const explicitNode = nodePath?.trim();
  if (explicitNode) return `${commandPathQuote(explicitNode)} ${commandPathQuote(scriptPath)}`;
  if (process.versions.electron) {
    if (process.platform === "win32") {
      if (!windowsCommandPath) {
        throw new Error("Cursor hook command script is required for packaged Electron on Windows.");
      }
      return `cmd /d /c ${windowsCmdQuote(windowsCommandPath)}`;
    }
    return `ELECTRON_RUN_AS_NODE=1 ${shellQuote(process.execPath)} ${shellQuote(scriptPath)}`;
  }
  return `${commandPathQuote(process.execPath)} ${commandPathQuote(scriptPath)}`;
}

function readObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readHooksFile(filePath: string): CursorHooksConfig {
  if (!fs.existsSync(filePath)) return { version: 1, hooks: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(
      `Cannot install ADE Cursor hook because ${filePath} is not valid JSON: ${getErrorMessage(error)}`,
    );
  }
  const config = readObject(parsed);
  if (!config) {
    throw new Error(`Cannot install ADE Cursor hook because ${filePath} must contain a JSON object.`);
  }
  if (config.hooks !== undefined && !readObject(config.hooks)) {
    throw new Error(`Cannot install ADE Cursor hook because ${filePath}.hooks must be a JSON object.`);
  }
  const hooks = readObject(config.hooks) ?? {};
  // `preToolUse` is the permission gate, so a shape ADE cannot extend is fatal.
  // `preCompact` is telemetry only: `ensureCursorSdkUserHook` leaves an
  // unexpected value alone and skips ADE's entry instead.
  if (hooks.preToolUse !== undefined && !Array.isArray(hooks.preToolUse)) {
    throw new Error(`Cannot install ADE Cursor hook because ${filePath}.hooks.preToolUse must be an array.`);
  }
  return config;
}

/** ADE's gate or preCompact entry, including a `preCompact` entry an earlier build pointed at the gate. */
function isAdeHookEntry(value: unknown): boolean {
  const entry = readObject(value);
  const command = typeof entry?.command === "string" ? entry.command : "";
  return ADE_HOOK_FILE_NAMES.some((name) => command.includes(name));
}

export function cursorSdkHookScriptPath(userHomeDir: string): string {
  return path.join(userHomeDir, ".cursor", "hooks", ADE_HOOK_SCRIPT_NAME);
}

export function cursorSdkHookShellCommandPath(userHomeDir: string): string {
  return path.join(userHomeDir, ".cursor", "hooks", ADE_HOOK_SHELL_COMMAND_NAME);
}

export function cursorSdkHookWindowsCommandPath(userHomeDir: string): string {
  return path.join(userHomeDir, ".cursor", "hooks", ADE_HOOK_WINDOWS_COMMAND_NAME);
}

export function cursorSdkPreCompactScriptPath(userHomeDir: string): string {
  return path.join(userHomeDir, ".cursor", "hooks", ADE_PRECOMPACT_SCRIPT_NAME);
}

export function cursorSdkPreCompactShellCommandPath(userHomeDir: string): string {
  return path.join(userHomeDir, ".cursor", "hooks", ADE_PRECOMPACT_SHELL_COMMAND_NAME);
}

export function cursorSdkPreCompactWindowsCommandPath(userHomeDir: string): string {
  return path.join(userHomeDir, ".cursor", "hooks", ADE_PRECOMPACT_WINDOWS_COMMAND_NAME);
}

export function cursorSdkHooksJsonPath(userHomeDir: string): string {
  return path.join(userHomeDir, ".cursor", "hooks.json");
}

export function writeCursorSdkHookBridgeScript(scriptPath: string): void {
  ensureDir(path.dirname(scriptPath));
  const source = `#!/usr/bin/env node
const net = require("node:net");

function readStdin() {
  return new Promise((resolve, reject) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { text += chunk; });
    process.stdin.on("end", () => resolve(text));
    process.stdin.on("error", reject);
  });
}

function parseArg(name) {
  for (let i = 0; i < process.argv.length; i += 1) {
    const arg = process.argv[i];
    if (arg === name) return process.argv[i + 1] || null;
    if (arg.startsWith(name + "=")) return arg.slice(name.length + 1) || null;
  }
  return null;
}

function writeDecision(decision) {
  process.stdout.write(JSON.stringify(decision));
}

function allow() {
  writeDecision({ permission: "allow" });
}

function deny(reason) {
  writeDecision({
    permission: "deny",
    user_message: reason,
    agent_message: reason,
  });
}

function connectWithTimeout(socketPath) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath);
    const timeout = setTimeout(() => {
      client.destroy();
      reject(new Error("Timed out connecting to ADE Cursor policy gate."));
    }, 2000);
    client.once("connect", () => {
      clearTimeout(timeout);
      resolve(client);
    });
    client.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function main() {
  const socketPath = parseArg("--socket") || process.env.ADE_CURSOR_SDK_SOCKET || "";
  const adeSession = process.env.ADE_CURSOR_SDK_SESSION_ID || process.env.ADE_CURSOR_SDK_LANE_ROOT;
  if (!socketPath) {
    if (adeSession) deny("ADE Cursor policy gate is unavailable.");
    else allow();
    return;
  }

  const rawText = await readStdin();
  let payload = {};
  try {
    payload = rawText.trim() ? JSON.parse(rawText) : {};
  } catch (error) {
    payload = { parseError: error && error.message ? error.message : String(error), rawText };
  }

  const client = await connectWithTimeout(socketPath);
  client.write(JSON.stringify({
    payload,
    sessionId: process.env.ADE_CURSOR_SDK_SESSION_ID || null,
    laneRoot: process.env.ADE_CURSOR_SDK_LANE_ROOT || null,
  }) + "\\n");
  const responseTimeoutMs = Number(process.env.ADE_CURSOR_SDK_RESPONSE_TIMEOUT_MS) || 5000;
  const decision = await new Promise((resolve, reject) => {
    let responseText = "";
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      client.destroy();
      reject(new Error("Timed out waiting for ADE Cursor policy decision."));
    }, responseTimeoutMs);
    function settle(fn, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      fn(value);
    }
    client.setEncoding("utf8");
    client.on("data", (chunk) => {
      if (settled) return;
      responseText += chunk;
      const newline = responseText.indexOf("\\n");
      if (newline >= 0) {
        const line = responseText.slice(0, newline);
        try {
          settle(resolve, JSON.parse(line));
        } catch (error) {
          settle(reject, new Error("ADE could not parse the Cursor hook decision."));
        } finally {
          client.end();
        }
      }
    });
    client.once("error", (error) => settle(reject, error));
    client.once("close", () => {
      if (!responseText.includes("\\n")) settle(reject, new Error("ADE Cursor policy gate closed without a decision."));
    });
  });
  writeDecision(decision);
}

main().catch((error) => {
  const socketPath = parseArg("--socket") || process.env.ADE_CURSOR_SDK_SOCKET || "";
  const adeSession = process.env.ADE_CURSOR_SDK_SESSION_ID || process.env.ADE_CURSOR_SDK_LANE_ROOT;
  if (!socketPath && !adeSession) {
    allow();
    return;
  }
  deny(error && error.message ? error.message : String(error));
});
`;
  fs.writeFileSync(scriptPath, source, { mode: 0o755 });
}

function stableElectronHookRunnerPath(): string {
  if (!process.versions.electron) return "";
  const execPath = process.execPath?.trim();
  if (!execPath) return "";
  if (execPath.includes(`${path.sep}node_modules${path.sep}electron${path.sep}`)) return "";
  if (execPath.includes(`${path.sep}.ade${path.sep}worktrees${path.sep}`)) return "";
  return execPath;
}

/**
 * One POSIX wrapper template for both script sets. The wrapper answers
 * `unsetAnswer` without Node when `requiredEnv` is not set, or when no
 * `--socket` argument and none of `guardEnv` is set. Otherwise it runs the
 * script with the first Node runner it finds, and answers `noRunnerAnswer`
 * when there is none.
 */
function hookShellWrapperSource(args: {
  scriptPath: string;
  nodePath?: string;
  electronPath?: string;
  guardEnv: readonly string[];
  requiredEnv?: string;
  unsetAnswer: string;
  noRunnerAnswer: string;
}): string {
  const unsetGuard = args.guardEnv.map((name) => ` && [ -z "\${${name}:-}" ]`).join("");
  const unsetAnswer = `  drain_stdin
  printf '%s' ${shellSingleQuote(args.unsetAnswer)}
  exit 0`;
  const requiredGuard = args.requiredEnv
    ? `
if [ -z "\${${args.requiredEnv}:-}" ]; then
${unsetAnswer}
fi
`
    : "";
  return `#!/bin/sh
drain_stdin() {
  if [ ! -t 0 ]; then
    cat >/dev/null 2>/dev/null || true
  fi
}
${requiredGuard}
has_socket_arg=0
for arg in "$@"; do
  case "$arg" in
    --socket|--socket=*) has_socket_arg=1 ;;
  esac
done

if [ "$has_socket_arg" -eq 0 ]${unsetGuard}; then
${unsetAnswer}
fi

script_path=${shellSingleQuote(args.scriptPath)}
configured_node=${shellSingleQuote(args.nodePath?.trim() ?? "")}
configured_electron=${shellSingleQuote(args.electronPath?.trim() ?? "")}

if [ -n "\${ADE_CURSOR_SDK_NODE:-}" ] && [ -x "$ADE_CURSOR_SDK_NODE" ]; then
  exec "$ADE_CURSOR_SDK_NODE" "$script_path" "$@"
fi

if [ -n "$configured_node" ] && [ -x "$configured_node" ]; then
  exec "$configured_node" "$script_path" "$@"
fi

if command -v node >/dev/null 2>&1; then
  exec node "$script_path" "$@"
fi

if [ -n "$configured_electron" ] && [ -x "$configured_electron" ]; then
  ELECTRON_RUN_AS_NODE=1 exec "$configured_electron" "$script_path" "$@"
fi

drain_stdin
printf '%s' ${shellSingleQuote(args.noRunnerAnswer)}
`;
}

type HookWrapperRules = Pick<
  Parameters<typeof hookShellWrapperSource>[0],
  "guardEnv" | "requiredEnv" | "unsetAnswer" | "noRunnerAnswer"
>;

const GATE_NO_NODE_MESSAGE = "ADE Cursor policy gate requires Node.js for ADE-managed Cursor sessions.";

/** The tool gate lets non-ADE Cursor sessions through and fails closed for ADE's own. */
const GATE_WRAPPER: HookWrapperRules = {
  guardEnv: ["ADE_CURSOR_SDK_SOCKET", "ADE_CURSOR_SDK_SESSION_ID", "ADE_CURSOR_SDK_LANE_ROOT"],
  unsetAnswer: JSON.stringify({ permission: "allow" }),
  noRunnerAnswer: JSON.stringify({
    permission: "deny",
    user_message: GATE_NO_NODE_MESSAGE,
    agent_message: GATE_NO_NODE_MESSAGE,
  }),
};

/** The `preCompact` reporter answers `{}` on every path, including no Node runner. */
const PRECOMPACT_WRAPPER: HookWrapperRules = {
  guardEnv: ["ADE_CURSOR_SDK_SOCKET"],
  requiredEnv: CURSOR_SDK_PRECOMPACT_ENV,
  unsetAnswer: "{}",
  noRunnerAnswer: "{}",
};

function writeHookShellCommandScript(
  args: { commandPath: string; scriptPath: string; nodePath?: string; electronPath?: string },
  rules: HookWrapperRules,
): void {
  ensureDir(path.dirname(args.commandPath));
  fs.writeFileSync(args.commandPath, hookShellWrapperSource({ ...args, ...rules }), { mode: 0o755 });
}

export function writeCursorSdkHookShellCommandScript(args: {
  commandPath: string;
  scriptPath: string;
  nodePath?: string;
  electronPath?: string;
}): void {
  writeHookShellCommandScript(args, GATE_WRAPPER);
}

/**
 * The `preCompact` reporter: relays the hook payload to ADE's socket with
 * `adeHook: "preCompact"` and always answers `{}`, whatever ADE says and
 * whether or not ADE is reachable. It connects only when
 * `ADE_CURSOR_SDK_PRECOMPACT` is set. A hard deadline bounds the whole run.
 */
function writeCursorSdkPreCompactScript(scriptPath: string): void {
  ensureDir(path.dirname(scriptPath));
  const source = `#!/usr/bin/env node
const net = require("node:net");

let finished = false;
function finish() {
  if (finished) return;
  finished = true;
  process.stdout.write("{}", () => process.exit(0));
}
setTimeout(finish, 3000);

function parseArg(name) {
  for (let i = 0; i < process.argv.length; i += 1) {
    const arg = process.argv[i];
    if (arg === name) return process.argv[i + 1] || null;
    if (arg.startsWith(name + "=")) return arg.slice(name.length + 1) || null;
  }
  return null;
}

function readStdin() {
  return new Promise((resolve) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { text += chunk; });
    process.stdin.on("end", () => resolve(text));
    process.stdin.on("error", () => resolve(text));
  });
}

function report(socketPath, payload) {
  return new Promise((resolve) => {
    const client = net.createConnection(socketPath);
    const timeout = setTimeout(() => { client.destroy(); resolve(); }, 1500);
    const done = () => { clearTimeout(timeout); client.destroy(); resolve(); };
    client.once("connect", () => {
      client.write(JSON.stringify({
        payload,
        sessionId: process.env.ADE_CURSOR_SDK_SESSION_ID || null,
        laneRoot: process.env.ADE_CURSOR_SDK_LANE_ROOT || null,
        adeHook: "preCompact",
      }) + "\\n");
    });
    client.on("data", (chunk) => { if (String(chunk).includes("\\n")) done(); });
    client.once("error", done);
    client.once("close", done);
  });
}

async function main() {
  const rawText = await readStdin();
  if (!process.env.${CURSOR_SDK_PRECOMPACT_ENV}) return;
  const socketPath = parseArg("--socket") || process.env.ADE_CURSOR_SDK_SOCKET || "";
  if (!socketPath) return;
  let payload = {};
  try {
    payload = rawText.trim() ? JSON.parse(rawText) : {};
  } catch (error) {
    payload = { parseError: error && error.message ? error.message : String(error), rawText };
  }
  await report(socketPath, payload);
}

main().catch(() => undefined).then(finish);
`;
  fs.writeFileSync(scriptPath, source, { mode: 0o755 });
}

export function writeCursorSdkHookWindowsCommandScript(args: {
  commandPath: string;
  electronPath: string;
  scriptPath: string;
  /** Answer `{}` without starting Electron when this variable is not set. */
  requiredEnv?: string;
}): void {
  ensureDir(path.dirname(args.commandPath));
  // `%*` forwards whatever Cursor passed (notably `--socket <path>`), matching
  // the POSIX wrapper's `"$@"`. `setlocal` keeps ELECTRON_RUN_AS_NODE out of
  // any parent environment that reuses this cmd instance. `more` drains stdin,
  // like the POSIX wrapper's `drain_stdin`, before the early answer.
  const source = [
    "@echo off",
    "setlocal",
    ...(args.requiredEnv
      ? [`if not defined ${args.requiredEnv} (`, "  more >nul 2>nul", "  echo {}", "  exit /b 0", ")"]
      : []),
    "set ELECTRON_RUN_AS_NODE=1",
    `${windowsBatchQuote(args.electronPath)} ${windowsBatchQuote(args.scriptPath)} %*`,
    "exit /b %ERRORLEVEL%",
    "",
  ].join("\r\n");
  fs.writeFileSync(args.commandPath, source, { mode: 0o755 });
}

export const __buildCursorSdkHookCommandForTests = buildHookCommand;

/** Which hook script set ADE writes: the tool gate or the `preCompact` reporter. */
type HookScriptSet = {
  scriptPath: string;
  shellCommandPath: string;
  windowsCommandPath: string;
  writeScript: (scriptPath: string) => void;
  wrapper: HookWrapperRules;
};

/** Write one script set with its platform wrapper and return the hooks.json command that runs it. */
function installHookScripts(set: HookScriptSet, nodePath: string | undefined): string {
  set.writeScript(set.scriptPath);
  if (process.platform === "win32") {
    if (!nodePath?.trim() && process.versions.electron) {
      writeCursorSdkHookWindowsCommandScript({
        commandPath: set.windowsCommandPath,
        electronPath: process.execPath,
        scriptPath: set.scriptPath,
        requiredEnv: set.wrapper.requiredEnv,
      });
    }
  } else {
    writeHookShellCommandScript({
      commandPath: set.shellCommandPath,
      scriptPath: set.scriptPath,
      nodePath,
      electronPath: stableElectronHookRunnerPath(),
    }, set.wrapper);
  }
  return buildHookCommand(nodePath, set.scriptPath, set.windowsCommandPath, set.shellCommandPath);
}

export function ensureCursorSdkUserHook(args: {
  userHomeDir: string;
  nodePath?: string;
  /**
   * Also register the `preCompact` hook (default on). `false` removes ADE's
   * entry and leaves any of the user's own untouched.
   */
  preCompact?: boolean;
}): {
  hooksPath: string;
  scriptPath: string;
  command: string;
  /** The `preCompact` entry's command, or null when ADE registered none. */
  preCompactCommand: string | null;
  changed: boolean;
  /** True when the user's `hooks.preCompact` is not an array, so ADE left it alone. */
  preCompactSkipped: boolean;
  /**
   * Why ADE could not write the `preCompact` scripts, or null. ADE then
   * registers no `preCompact` entry; the tool gate is still installed.
   */
  preCompactError: string | null;
} {
  const scriptPath = cursorSdkHookScriptPath(args.userHomeDir);
  const hooksPath = cursorSdkHooksJsonPath(args.userHomeDir);
  const command = installHookScripts({
    scriptPath,
    shellCommandPath: cursorSdkHookShellCommandPath(args.userHomeDir),
    windowsCommandPath: cursorSdkHookWindowsCommandPath(args.userHomeDir),
    writeScript: writeCursorSdkHookBridgeScript,
    wrapper: GATE_WRAPPER,
  }, args.nodePath);

  const config = readHooksFile(hooksPath);
  const hooks = readObject(config.hooks) ?? {};
  const existingPreToolUse = Array.isArray(hooks.preToolUse) ? hooks.preToolUse : [];
  const adeEntry = { command, failClosed: true };
  const nextPreToolUse = [
    adeEntry,
    ...existingPreToolUse.filter((entry) => !isAdeHookEntry(entry)),
  ];
  // A `preCompact` value that is not an array is the user's, in a shape ADE
  // cannot extend: keep it exactly as written and register nothing there.
  const preCompactSkipped = hooks.preCompact !== undefined && !Array.isArray(hooks.preCompact);
  const otherHooks: Record<string, unknown> = { ...hooks };
  let preCompactHooks: Record<string, unknown> = {};
  let preCompactCommand: string | null = null;
  let preCompactError: string | null = null;
  if (!preCompactSkipped) {
    delete otherHooks.preCompact;
    // Also drops an entry an earlier build pointed at the gate scripts.
    const userPreCompact = (Array.isArray(hooks.preCompact) ? hooks.preCompact : [])
      .filter((entry) => !isAdeHookEntry(entry));
    if (args.preCompact !== false) {
      // Telemetry only: a failure here must never cost the permission gate.
      try {
        preCompactCommand = installHookScripts({
          scriptPath: cursorSdkPreCompactScriptPath(args.userHomeDir),
          shellCommandPath: cursorSdkPreCompactShellCommandPath(args.userHomeDir),
          windowsCommandPath: cursorSdkPreCompactWindowsCommandPath(args.userHomeDir),
          writeScript: writeCursorSdkPreCompactScript,
          wrapper: PRECOMPACT_WRAPPER,
        }, args.nodePath);
      } catch (error) {
        preCompactError = getErrorMessage(error);
      }
    }
    // Fail open: the SDK's `preCompact` response carries only an optional
    // message, and the reporter answers `{}` on every path.
    const nextPreCompact = preCompactCommand
      ? [{ command: preCompactCommand, failClosed: false }, ...userPreCompact]
      : userPreCompact;
    if (nextPreCompact.length) preCompactHooks = { preCompact: nextPreCompact };
  }
  const nextConfig: CursorHooksConfig = {
    ...config,
    version: typeof config.version === "number" ? config.version : 1,
    hooks: {
      ...otherHooks,
      preToolUse: nextPreToolUse,
      ...preCompactHooks,
    },
  };
  const changed = JSON.stringify(config) !== JSON.stringify(nextConfig);
  if (changed || !fs.existsSync(hooksPath)) {
    writeJson(hooksPath, nextConfig);
  }
  return { hooksPath, scriptPath, command, preCompactCommand, changed, preCompactSkipped, preCompactError };
}
