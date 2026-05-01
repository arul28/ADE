import fs from "node:fs";
import path from "node:path";

const ADE_HOOK_SCRIPT_NAME = "ade-tool-gate.cjs";

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

function windowsCmdQuote(value: string): string {
  if (/[\0\r\n]/.test(value)) {
    throw new Error("Cursor hook command paths cannot contain control characters.");
  }
  return `"${value.replace(/(["^&|<>%])/g, "^$1")}"`;
}

function buildHookCommand(nodePath: string | undefined, scriptPath: string): string {
  const explicitNode = nodePath?.trim();
  if (explicitNode) return `${shellQuote(explicitNode)} ${shellQuote(scriptPath)}`;
  if (process.versions.electron) {
    if (process.platform === "win32") {
      return `cmd /d /s /c "set ELECTRON_RUN_AS_NODE=1&& ${windowsCmdQuote(process.execPath)} ${windowsCmdQuote(scriptPath)}"`;
    }
    return `ELECTRON_RUN_AS_NODE=1 ${shellQuote(process.execPath)} ${shellQuote(scriptPath)}`;
  }
  return `${shellQuote(process.execPath)} ${shellQuote(scriptPath)}`;
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
  return command.includes(ADE_HOOK_SCRIPT_NAME);
}

export function cursorSdkHookScriptPath(userHomeDir: string): string {
  return path.join(userHomeDir, ".cursor", "hooks", ADE_HOOK_SCRIPT_NAME);
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
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
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
  const adeSession = process.env.ADE_CURSOR_SDK_SESSION_ID || process.env.ADE_CURSOR_SDK_LANE_ROOT;
  if (!adeSession && !process.env.ADE_CURSOR_SDK_SOCKET) {
    allow();
    return;
  }
  deny(error && error.message ? error.message : String(error));
});
`;
  fs.writeFileSync(scriptPath, source, { mode: 0o755 });
}

export function ensureCursorSdkUserHook(args: {
  userHomeDir: string;
  nodePath?: string;
}): { hooksPath: string; scriptPath: string; command: string; changed: boolean } {
  const scriptPath = cursorSdkHookScriptPath(args.userHomeDir);
  const hooksPath = cursorSdkHooksJsonPath(args.userHomeDir);
  writeCursorSdkHookBridgeScript(scriptPath);

  const config = readHooksFile(hooksPath);
  const hooks = readObject(config.hooks) ?? {};
  const existingPreToolUse = Array.isArray(hooks.preToolUse) ? hooks.preToolUse : [];
  const command = buildHookCommand(args.nodePath, scriptPath);
  const adeEntry = { command, failClosed: true };
  const nextPreToolUse = [
    ...existingPreToolUse.filter((entry) => !isAdeHookEntry(entry)),
    adeEntry,
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
