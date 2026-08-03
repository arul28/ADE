import fs from "node:fs";
import path from "node:path";

const ADE_HOOK_SCRIPT_NAME = "ade-tool-gate.cjs";
const ADE_HOOK_SHELL_COMMAND_NAME = "ade-tool-gate.sh";
const ADE_HOOK_WINDOWS_COMMAND_NAME = "ade-tool-gate.cmd";

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
      `Cannot install ADE Cursor hook because ${filePath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
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
  const preToolUse = hooks.preToolUse;
  if (preToolUse !== undefined && !Array.isArray(preToolUse)) {
    throw new Error(`Cannot install ADE Cursor hook because ${filePath}.hooks.preToolUse must be an array.`);
  }
  return config;
}

function isAdeHookEntry(value: unknown): boolean {
  const entry = readObject(value);
  const command = typeof entry?.command === "string" ? entry.command : "";
  return command.includes(ADE_HOOK_SCRIPT_NAME)
    || command.includes(ADE_HOOK_SHELL_COMMAND_NAME)
    || command.includes(ADE_HOOK_WINDOWS_COMMAND_NAME);
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

export function writeCursorSdkHookShellCommandScript(args: {
  commandPath: string;
  scriptPath: string;
  nodePath?: string;
  electronPath?: string;
}): void {
  ensureDir(path.dirname(args.commandPath));
  const source = `#!/bin/sh
drain_stdin() {
  if [ ! -t 0 ]; then
    cat >/dev/null 2>/dev/null || true
  fi
}

has_socket_arg=0
for arg in "$@"; do
  case "$arg" in
    --socket|--socket=*) has_socket_arg=1 ;;
  esac
done

if [ "$has_socket_arg" -eq 0 ] && [ -z "\${ADE_CURSOR_SDK_SOCKET:-}" ] && [ -z "\${ADE_CURSOR_SDK_SESSION_ID:-}" ] && [ -z "\${ADE_CURSOR_SDK_LANE_ROOT:-}" ]; then
  drain_stdin
  printf '%s' '{"permission":"allow"}'
  exit 0
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
printf '%s' '{"permission":"deny","user_message":"ADE Cursor policy gate requires Node.js for ADE-managed Cursor sessions.","agent_message":"ADE Cursor policy gate requires Node.js for ADE-managed Cursor sessions."}'
`;
  fs.writeFileSync(args.commandPath, source, { mode: 0o755 });
}

export function writeCursorSdkHookWindowsCommandScript(args: {
  commandPath: string;
  electronPath: string;
  scriptPath: string;
}): void {
  ensureDir(path.dirname(args.commandPath));
  // `%*` forwards whatever Cursor passed (notably `--socket <path>`), matching
  // the POSIX wrapper's `"$@"`. `setlocal` keeps ELECTRON_RUN_AS_NODE out of
  // any parent environment that reuses this cmd instance.
  const source = [
    "@echo off",
    "setlocal",
    "set ELECTRON_RUN_AS_NODE=1",
    `${windowsBatchQuote(args.electronPath)} ${windowsBatchQuote(args.scriptPath)} %*`,
    "exit /b %ERRORLEVEL%",
    "",
  ].join("\r\n");
  fs.writeFileSync(args.commandPath, source, { mode: 0o755 });
}

export const __buildCursorSdkHookCommandForTests = buildHookCommand;

export function ensureCursorSdkUserHook(args: {
  userHomeDir: string;
  nodePath?: string;
}): { hooksPath: string; scriptPath: string; command: string; changed: boolean } {
  const scriptPath = cursorSdkHookScriptPath(args.userHomeDir);
  const shellCommandPath = cursorSdkHookShellCommandPath(args.userHomeDir);
  const windowsCommandPath = cursorSdkHookWindowsCommandPath(args.userHomeDir);
  const hooksPath = cursorSdkHooksJsonPath(args.userHomeDir);
  writeCursorSdkHookBridgeScript(scriptPath);
  if (process.platform === "win32") {
    if (!args.nodePath?.trim() && process.versions.electron) {
      writeCursorSdkHookWindowsCommandScript({
        commandPath: windowsCommandPath,
        electronPath: process.execPath,
        scriptPath,
      });
    }
  } else {
    writeCursorSdkHookShellCommandScript({
      commandPath: shellCommandPath,
      scriptPath,
      nodePath: args.nodePath,
      electronPath: stableElectronHookRunnerPath(),
    });
  }

  const config = readHooksFile(hooksPath);
  const hooks = readObject(config.hooks) ?? {};
  const existingPreToolUse = Array.isArray(hooks.preToolUse) ? hooks.preToolUse : [];
  const command = buildHookCommand(args.nodePath, scriptPath, windowsCommandPath, shellCommandPath);
  const adeEntry = { command, failClosed: true };
  const nextPreToolUse = [
    adeEntry,
    ...existingPreToolUse.filter((entry) => !isAdeHookEntry(entry)),
  ];
  const nextConfig: CursorHooksConfig = {
    ...config,
    version: typeof config.version === "number" ? config.version : 1,
    hooks: {
      ...hooks,
      preToolUse: nextPreToolUse,
    },
  };
  const changed = JSON.stringify(config) !== JSON.stringify(nextConfig);
  if (changed || !fs.existsSync(hooksPath)) {
    writeJson(hooksPath, nextConfig);
  }
  return { hooksPath, scriptPath, command, changed };
}
