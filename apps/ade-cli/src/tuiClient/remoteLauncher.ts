import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import net, { type AddressInfo } from "node:net";
import readline from "node:readline";
import readlinePromises from "node:readline/promises";
import { RemoteTargetRegistry, normalizeRemoteTargetRoutes } from "../../../desktop/src/main/services/remoteRuntime/remoteTargetRegistry";
import type {
  RemoteRuntimeProjectRecord,
  RemoteRuntimeTarget,
  RemoteRuntimeTargetRoute,
} from "../../../desktop/src/shared/types/remoteRuntime";
import type { AgentChatSessionSummary } from "../../../desktop/src/shared/types/chat";
import type { ChatTerminalSession } from "../../../desktop/src/shared/types/sessions";

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id?: number | string | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
  method?: string;
  params?: unknown;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
};

type RemoteRuntimeLayout = {
  channel: "alpha" | "beta" | null;
  homeDirName: string;
  homeDirExpr: string;
  binDirExpr: string;
  runtimeDirExpr: string;
  socketExpr: string;
  binaryExpr: string;
};

type RemoteRpcAttempt = {
  target: RemoteRuntimeTarget;
  route: RemoteRuntimeTargetRoute;
  layout: RemoteRuntimeLayout;
  command: string;
  sshArgs: string[];
  label: string;
};

type RemoteRpcSession = {
  client: ProcessJsonRpcClient;
  attempt: RemoteRpcAttempt;
};

type RemoteBridge = {
  socketUrl: string;
  close: () => Promise<void>;
};

type RemoteLaunchScope = "project" | "session";

type RemoteCliOptions = {
  help: boolean;
  scope: RemoteLaunchScope | null;
  targetQuery: string | null;
  projectQuery: string | null;
  sessionQuery: string | null;
  listTargets: boolean;
  listProjects: boolean;
  listSessions: boolean;
};

type RemoteSessionChoice = {
  sessionId: string;
  laneId: string;
  title: string;
  detail: string;
  status: string;
  lastActivityAt: string;
  kind: "chat" | "terminal";
};

export type RunAdeCodeCli = (argv: string[]) => Promise<number>;

const REMOTE_RPC_TIMEOUT_MS = 20_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function trimString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readFlagValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

export function parseRemoteAdeCodeArgs(argv: string[]): RemoteCliOptions {
  const options: RemoteCliOptions = {
    help: false,
    scope: null,
    targetQuery: null,
    projectQuery: null,
    sessionQuery: null,
    listTargets: false,
    listProjects: false,
    listSessions: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--list-targets" || arg === "--targets") {
      options.listTargets = true;
      continue;
    }
    if (arg === "--list-projects" || arg === "--projects") {
      options.listProjects = true;
      continue;
    }
    if (arg === "--list-sessions" || arg === "--sessions") {
      options.listSessions = true;
      options.scope = "session";
      continue;
    }
    if (arg === "--target" || arg === "--machine") {
      options.targetQuery = readFlagValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--project" || arg === "--project-root") {
      options.projectQuery = readFlagValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--session" || arg === "--chat") {
      options.sessionQuery = readFlagValue(argv, index, arg);
      options.scope = "session";
      index += 1;
      continue;
    }
    if (arg === "project" || arg === "session") {
      options.scope = arg;
      continue;
    }
    throw new Error(`Unknown ade code remote option: ${arg}`);
  }

  return options;
}

function printRemoteHelp(): void {
  process.stdout.write(`ade code remote

Launch ADE Code against a saved desktop remote machine.

Usage:
  ade code remote [project|session]
  ade code remote --target <machine> --project <project>
  ade code remote session --target <machine> --project <project> --session <session>
  ade code remote --list-targets

Flags:
  --target, --machine <id|name|host>       Select a saved remote machine.
  --project, --project-root <id|name|path> Select or register a remote project.
  --session, --chat <id|title>             Open a specific remote chat/session.
  --list-projects                         Print projects for the selected machine.
  --list-sessions                         Print sessions for the selected project.
`);
}

function canPrompt(): boolean {
  return process.stdin.isTTY === true && process.stderr.isTTY === true;
}

async function promptChoice<T>(title: string, entries: T[], describe: (entry: T, index: number) => string): Promise<T> {
  if (!entries.length) throw new Error(`${title}: no choices available.`);
  if (!canPrompt()) {
    if (entries.length === 1) return entries[0]!;
    throw new Error(`${title}: pass a flag to choose non-interactively.`);
  }
  if (entries.length === 1) return entries[0]!;

  return await promptInteractiveChoice(title, entries, describe);
}

function terminalColumns(): number {
  return Math.max(40, process.stderr.columns || 80);
}

function truncateLine(value: string, width: number): string {
  if (value.length <= width) return value;
  if (width <= 3) return value.slice(0, Math.max(0, width));
  return `${value.slice(0, width - 3)}...`;
}

async function promptInteractiveChoice<T>(
  title: string,
  entries: T[],
  describe: (entry: T, index: number) => string,
): Promise<T> {
  const input = process.stdin;
  const output = process.stderr;
  const wasRaw = Boolean(input.isRaw);
  let selectedIndex = 0;
  let scrollOffset = 0;
  let renderedLines = 0;
  const visibleRows = Math.min(12, entries.length);

  const render = (): void => {
    if (renderedLines > 0) {
      output.write(`\x1b[${renderedLines}A`);
    }
    const width = terminalColumns();
    if (selectedIndex < scrollOffset) scrollOffset = selectedIndex;
    if (selectedIndex >= scrollOffset + visibleRows) scrollOffset = selectedIndex - visibleRows + 1;
    const shown = entries.slice(scrollOffset, scrollOffset + visibleRows);
    const lines = [
      `${title} (${selectedIndex + 1}/${entries.length})`,
      ...shown.map((entry, visibleIndex) => {
        const index = scrollOffset + visibleIndex;
        const prefix = index === selectedIndex ? "> " : "  ";
        return `${prefix}${truncateLine(describe(entry, index), Math.max(8, width - prefix.length))}`;
      }),
      "up/down select | enter choose | esc cancel",
    ];
    output.write(lines.map((line) => `\x1b[2K${line}`).join("\n"));
    output.write("\n");
    renderedLines = lines.length;
  };

  return await new Promise<T>((resolve, reject) => {
    const cleanup = (): void => {
      input.off("keypress", onKeypress);
      if (input.isTTY) input.setRawMode(wasRaw);
      input.pause();
    };

    const finish = (entry: T): void => {
      cleanup();
      output.write("\n");
      resolve(entry);
    };

    const fail = (error: Error): void => {
      cleanup();
      output.write("\n");
      reject(error);
    };

    const onKeypress = (_value: string, key: { name?: string; ctrl?: boolean }): void => {
      if (key.ctrl && key.name === "c") {
        fail(new Error(`${title}: cancelled.`));
        return;
      }
      if (key.name === "escape" || key.name === "q") {
        fail(new Error(`${title}: cancelled.`));
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        finish(entries[selectedIndex]!);
        return;
      }
      if (key.name === "up") {
        selectedIndex = (selectedIndex - 1 + entries.length) % entries.length;
        render();
        return;
      }
      if (key.name === "down" || key.name === "tab") {
        selectedIndex = (selectedIndex + 1) % entries.length;
        render();
      }
    };

    readline.emitKeypressEvents(input);
    if (input.isTTY) input.setRawMode(true);
    input.resume();
    input.on("keypress", onKeypress);
    render();
  });
}

async function promptText(title: string): Promise<string> {
  if (!canPrompt()) throw new Error(`${title}: pass --project <remote-path> non-interactively.`);
  const rl = readlinePromises.createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    while (true) {
      const answer = (await rl.question(`${title}: `)).trim();
      if (answer) return answer;
    }
  } finally {
    rl.close();
  }
}

function normalizeMatch(value: string): string {
  return value.trim().toLowerCase();
}

function findByQuery<T>(
  entries: T[],
  query: string,
  fields: (entry: T) => Array<string | null | undefined>,
  label: string,
): T {
  const needle = normalizeMatch(query);
  const exact = entries.filter((entry) =>
    fields(entry).some((field) => field && normalizeMatch(field) === needle),
  );
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) {
    throw new Error(`${label} '${query}' matches multiple entries.`);
  }
  const fuzzy = entries.filter((entry) =>
    fields(entry).some((field) => field && normalizeMatch(field).includes(needle)),
  );
  if (fuzzy.length === 1) return fuzzy[0]!;
  if (fuzzy.length > 1) {
    throw new Error(`${label} '${query}' matches multiple entries.`);
  }
  throw new Error(`${label} not found: ${query}`);
}

function routeKey(route: RemoteRuntimeTargetRoute): string {
  return `${route.hostname.toLowerCase().replace(/\.$/, "")}:${route.port ?? ""}`;
}

function targetRoutes(target: RemoteRuntimeTarget): RemoteRuntimeTargetRoute[] {
  const primary = normalizeRemoteTargetRoutes({
    hostname: target.hostname,
    port: target.port,
    routes: target.routes,
  });
  const primaryKey = `${target.hostname.toLowerCase().replace(/\.$/, "")}:${target.port ?? ""}`;
  return [...primary].sort((left, right) => {
    const rightSeen = right.lastSucceededAt ?? 0;
    const leftSeen = left.lastSucceededAt ?? 0;
    if (rightSeen !== leftSeen) return rightSeen - leftSeen;
    if (routeKey(left) === primaryKey) return -1;
    if (routeKey(right) === primaryKey) return 1;
    return left.hostname.localeCompare(right.hostname);
  });
}

function normalizeRemoteRuntimeChannel(value: unknown): "alpha" | "beta" | null {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized === "alpha" || normalized === "beta") return normalized;
  return null;
}

function inferRemoteRuntimeChannelFromVersion(version: string | null | undefined): "alpha" | "beta" | null {
  const normalized = version?.trim().toLowerCase() ?? "";
  if (normalized.includes("alpha")) return "alpha";
  if (normalized.includes("beta")) return "beta";
  return null;
}

function remoteRuntimeLayoutForChannel(channel: "alpha" | "beta" | null): RemoteRuntimeLayout {
  const homeDirName = channel === "alpha"
    ? ".ade-alpha"
    : channel === "beta"
      ? ".ade-beta"
      : ".ade";
  const homeDirExpr = `$HOME/${homeDirName}`;
  return {
    channel,
    homeDirName,
    homeDirExpr,
    binDirExpr: `${homeDirExpr}/bin`,
    runtimeDirExpr: `${homeDirExpr}/runtime`,
    socketExpr: `${homeDirExpr}/sock/ade.sock`,
    binaryExpr: `${homeDirExpr}/bin/ade`,
  };
}

export function remoteRuntimeLayoutCandidates(
  env: NodeJS.ProcessEnv = process.env,
  preferredChannel: "alpha" | "beta" | null = normalizeRemoteRuntimeChannel(env.ADE_PACKAGE_CHANNEL),
): RemoteRuntimeLayout[] {
  const channels = [
    preferredChannel,
    null,
    "beta" as const,
    "alpha" as const,
  ];
  const seen = new Set<string>();
  return channels
    .map((channel) => remoteRuntimeLayoutForChannel(channel))
    .filter((layout) => {
      if (seen.has(layout.homeDirName)) return false;
      seen.add(layout.homeDirName);
      return true;
    });
}

export function buildRemoteRuntimeRpcCommand(layout: RemoteRuntimeLayout, binaryExpr = layout.binaryExpr): string {
  const exports = [
    `export ADE_HOME="${layout.homeDirExpr}"`,
    `export PATH="${layout.binDirExpr}:$HOME/.local/bin:$HOME/.npm-global/bin\${PATH:+:$PATH}"`,
    `export ADE_DEFAULT_ROLE="cto"`,
    `export ADE_PTY_HOST_WORKER_COMMAND="${binaryExpr}"`,
  ];
  if (layout.channel) {
    exports.push(`export ADE_PACKAGE_CHANNEL="${layout.channel}"`);
  }
  exports.push("export ADE_DISABLE_RUNTIME_SERVICE_INSTALL=1");
  return [
    ...exports,
    "ADE_RUNTIME_ARCH=\"$(node -p 'process.platform + \"-\" + process.arch' 2>/dev/null || true)\"",
    `if [ -n "$ADE_RUNTIME_ARCH" ] && [ -d "${layout.runtimeDirExpr}/$ADE_RUNTIME_ARCH/node_modules" ]; then export NODE_PATH="${layout.runtimeDirExpr}/$ADE_RUNTIME_ARCH/node_modules\${NODE_PATH:+:$NODE_PATH}"; fi`,
    `exec ${binaryExpr} --socket ${layout.socketExpr} rpc --stdio`,
  ].join("; ");
}

function buildSshArgs(target: RemoteRuntimeTarget, route: RemoteRuntimeTargetRoute, command: string): string[] {
  const destination = target.sshUser?.trim()
    ? `${target.sshUser.trim()}@${route.hostname}`
    : route.hostname;
  const args = [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    "-o",
    "StrictHostKeyChecking=yes",
  ];
  const port = route.port ?? target.port;
  if (port) args.push("-p", String(port));
  if (target.sshKeyPath) args.push("-i", target.sshKeyPath);
  args.push(destination, command);
  return args;
}

function remoteRpcAttempts(target: RemoteRuntimeTarget): RemoteRpcAttempt[] {
  const attempts: RemoteRpcAttempt[] = [];
  const seen = new Set<string>();
  const preferredChannel =
    inferRemoteRuntimeChannelFromVersion(target.runtimeBinaryVersion) ??
    normalizeRemoteRuntimeChannel(process.env.ADE_PACKAGE_CHANNEL);
  for (const route of targetRoutes(target)) {
    for (const layout of remoteRuntimeLayoutCandidates(process.env, preferredChannel)) {
      const commands = [
        buildRemoteRuntimeRpcCommand(layout, layout.binaryExpr),
        buildRemoteRuntimeRpcCommand(layout, "ade"),
      ];
      for (const command of commands) {
        const key = `${routeKey(route)}\0${layout.homeDirName}\0${command}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const sshArgs = buildSshArgs(target, route, command);
        attempts.push({
          target,
          route,
          layout,
          command,
          sshArgs,
          label: `${route.hostname}${route.port ? `:${route.port}` : ""} ${layout.homeDirName}`,
        });
      }
    }
  }
  return attempts;
}

function spawnRemoteRpcProcess(attempt: RemoteRpcAttempt): ChildProcessWithoutNullStreams {
  return spawn("ssh", attempt.sshArgs, {
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(resolve, reject).finally(() => {
      if (timer) clearTimeout(timer);
    });
  });
}

class ProcessJsonRpcClient {
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private readonly pending = new Map<number | string, PendingRequest>();
  private readonly stderrChunks: Buffer[] = [];
  private closed = false;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on("data", (chunk: Buffer | string) => this.handleData(chunk));
    child.stderr.on("data", (chunk: Buffer | string) => {
      this.stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"));
    });
    child.on("error", (error) => this.handleClosed(error));
    child.on("close", (code, signal) => {
      this.handleClosed(new Error(this.closeMessage(code, signal)));
    });
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Remote ADE RPC connection is closed."));
    const id = this.nextId++;
    const payload = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.child.stdin.write(`${JSON.stringify(payload)}\n`, "utf8", (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectAll(new Error("Remote ADE RPC connection closed."));
    this.child.stdin.end();
    this.child.kill();
  }

  private closeMessage(code: number | null, signal: NodeJS.Signals | null): string {
    const detail = this.stderrChunks.length
      ? Buffer.concat(this.stderrChunks).toString("utf8").trim().split("\n").slice(-4).join("\n")
      : "";
    const status = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
    return detail
      ? `Remote ADE RPC exited with ${status}: ${detail}`
      : `Remote ADE RPC exited with ${status}.`;
  }

  private handleClosed(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectAll(error);
  }

  private handleData(chunk: Buffer | string): void {
    this.buffer = Buffer.concat([
      this.buffer,
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"),
    ]);
    while (true) {
      const next = this.takeNextPayload();
      if (!next) return;
      const payload = next.trim();
      if (!payload) continue;
      let parsed: JsonRpcResponse | JsonRpcResponse[] | null = null;
      try {
        parsed = JSON.parse(payload) as JsonRpcResponse | JsonRpcResponse[];
      } catch {
        continue;
      }
      const responses = Array.isArray(parsed) ? parsed : [parsed];
      for (const response of responses) this.handleResponse(response);
    }
  }

  private takeNextPayload(): string | null {
    while (this.buffer.length && /\s/.test(String.fromCharCode(this.buffer[0]!))) {
      this.buffer = this.buffer.subarray(1);
    }
    if (!this.buffer.length) return null;
    const first = String.fromCharCode(this.buffer[0]!);
    if (first === "{" || first === "[") {
      const idx = this.buffer.indexOf(0x0a);
      if (idx < 0) return null;
      const payload = this.buffer.subarray(0, idx).toString("utf8");
      this.buffer = this.buffer.subarray(idx + 1);
      return payload;
    }

    const crlfBoundary = this.buffer.indexOf("\r\n\r\n");
    const lfBoundary = this.buffer.indexOf("\n\n");
    let boundary: { index: number; length: number } | null = null;
    if (crlfBoundary >= 0) boundary = { index: crlfBoundary, length: 4 };
    else if (lfBoundary >= 0) boundary = { index: lfBoundary, length: 2 };
    if (!boundary) return null;
    const header = this.buffer.subarray(0, boundary.index).toString("ascii");
    const match = /^content-length\s*:\s*(\d+)\s*$/im.exec(header);
    if (!match) {
      this.buffer = this.buffer.subarray(boundary.index + boundary.length);
      return "";
    }
    const length = Number.parseInt(match[1]!, 10);
    const bodyStart = boundary.index + boundary.length;
    const bodyEnd = bodyStart + length;
    if (this.buffer.length < bodyEnd) return null;
    const payload = this.buffer.subarray(bodyStart, bodyEnd).toString("utf8");
    this.buffer = this.buffer.subarray(bodyEnd);
    return payload;
  }

  private handleResponse(response: JsonRpcResponse): void {
    if (response.id == null) return;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    if (response.error) {
      pending.reject(new Error(response.error.message));
      return;
    }
    pending.resolve(response.result);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

async function initializeRemoteRpc(client: ProcessJsonRpcClient): Promise<void> {
  await client.request("ade/initialize", {
    protocolVersion: "2025-06-18",
    clientName: "ade-code-remote",
    identity: {
      role: "cto",
      callerId: `ade-code-remote:${process.pid}`,
    },
  });
  await client.request("ade/initialized");
}

async function openRemoteRpcSession(target: RemoteRuntimeTarget): Promise<RemoteRpcSession> {
  const errors: string[] = [];
  for (const attempt of remoteRpcAttempts(target)) {
    const client = new ProcessJsonRpcClient(spawnRemoteRpcProcess(attempt));
    try {
      await withTimeout(
        initializeRemoteRpc(client),
        REMOTE_RPC_TIMEOUT_MS,
        `Remote ADE RPC did not initialize within ${REMOTE_RPC_TIMEOUT_MS / 1000}s.`,
      );
      return { client, attempt };
    } catch (error) {
      client.close();
      errors.push(`${attempt.label}: ${errorMessage(error)}`);
    }
  }
  throw new Error(
    `Could not connect to remote ADE on ${target.name}. ` +
      `Tried ${errors.length} route/runtime combinations. ${errors.slice(0, 4).join(" | ")}`,
  );
}

function coerceProjects(value: unknown): RemoteRuntimeProjectRecord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const projectId = trimString(entry.projectId);
    const rootPath = trimString(entry.rootPath);
    if (!projectId || !rootPath) return [];
    return [{
      projectId,
      rootPath,
      displayName: trimString(entry.displayName) ?? rootPath.split("/").filter(Boolean).at(-1) ?? rootPath,
      addedAt: typeof entry.addedAt === "number" ? entry.addedAt : 0,
      lastOpenedAt: typeof entry.lastOpenedAt === "number" ? entry.lastOpenedAt : 0,
      gitOriginUrl: typeof entry.gitOriginUrl === "string" ? entry.gitOriginUrl : null,
    }];
  });
}

function sortProjects(projects: RemoteRuntimeProjectRecord[]): RemoteRuntimeProjectRecord[] {
  return [...projects].sort((left, right) => {
    const activity = (right.lastOpenedAt ?? 0) - (left.lastOpenedAt ?? 0);
    if (activity !== 0) return activity;
    return left.displayName.localeCompare(right.displayName, undefined, { sensitivity: "base" });
  });
}

async function listProjects(client: ProcessJsonRpcClient): Promise<RemoteRuntimeProjectRecord[]> {
  const raw = await withTimeout(
    client.request("projects.list", {}),
    REMOTE_RPC_TIMEOUT_MS,
    "Timed out listing remote projects.",
  );
  return sortProjects(coerceProjects(raw));
}

async function ensureProject(client: ProcessJsonRpcClient, query: string): Promise<RemoteRuntimeProjectRecord> {
  const raw = await withTimeout(
    client.request("projects.add", { rootPath: query }),
    REMOTE_RPC_TIMEOUT_MS,
    `Timed out registering remote project ${query}.`,
  );
  const project = coerceProjects([raw])[0] ?? null;
  if (!project) throw new Error("Remote ADE did not return a project record.");
  return project;
}

async function callProjectAction<T>(
  client: ProcessJsonRpcClient,
  projectId: string,
  domain: string,
  action: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const payload = await withTimeout(
    client.request("ade/actions/call", {
      projectId,
      name: "run_ade_action",
      arguments: { domain, action, args },
    }),
    REMOTE_RPC_TIMEOUT_MS,
    `Timed out running ${domain}.${action} on the remote project.`,
  );
  if (isRecord(payload) && payload.ok === false) {
    const message = isRecord(payload.error) ? trimString(payload.error.message) : null;
    throw new Error(message ?? `Remote action failed: ${domain}.${action}`);
  }
  return (isRecord(payload) && "result" in payload ? payload.result : payload) as T;
}

async function callProjectActionArgsList<T>(
  client: ProcessJsonRpcClient,
  projectId: string,
  domain: string,
  action: string,
  argsList: unknown[],
): Promise<T> {
  const payload = await withTimeout(
    client.request("ade/actions/call", {
      projectId,
      name: "run_ade_action",
      arguments: { domain, action, argsList },
    }),
    REMOTE_RPC_TIMEOUT_MS,
    `Timed out running ${domain}.${action} on the remote project.`,
  );
  if (isRecord(payload) && payload.ok === false) {
    const message = isRecord(payload.error) ? trimString(payload.error.message) : null;
    throw new Error(message ?? `Remote action failed: ${domain}.${action}`);
  }
  return (isRecord(payload) && "result" in payload ? payload.result : payload) as T;
}

function coerceChatSessions(value: unknown): AgentChatSessionSummary[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const sessionId = trimString(entry.sessionId);
    const laneId = trimString(entry.laneId);
    const provider = trimString(entry.provider);
    const model = trimString(entry.model);
    const status = trimString(entry.status);
    const startedAt = trimString(entry.startedAt);
    const lastActivityAt = trimString(entry.lastActivityAt);
    if (!sessionId || !laneId || !provider || !model || !status || !startedAt || !lastActivityAt) return [];
    return [{
      sessionId,
      laneId,
      provider: provider as AgentChatSessionSummary["provider"],
      model,
      title: trimString(entry.title),
      goal: trimString(entry.goal),
      status: status as AgentChatSessionSummary["status"],
      startedAt,
      endedAt: trimString(entry.endedAt),
      lastActivityAt,
      lastOutputPreview: trimString(entry.lastOutputPreview),
      summary: trimString(entry.summary),
      awaitingInput: typeof entry.awaitingInput === "boolean" ? entry.awaitingInput : undefined,
      pendingInputItemId: trimString(entry.pendingInputItemId),
      threadId: trimString(entry.threadId) ?? undefined,
      requestedCwd: trimString(entry.requestedCwd),
    }];
  });
}

function coerceTerminalSessions(value: unknown): ChatTerminalSession[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const terminalId = trimString(entry.terminalId);
    const laneId = trimString(entry.laneId);
    if (!terminalId || !laneId) return [];
    const status = trimString(entry.status) ?? "ended";
    return [{
      terminalId,
      ptyId: trimString(entry.ptyId),
      chatSessionId: trimString(entry.chatSessionId),
      laneId,
      laneName: trimString(entry.laneName) ?? laneId,
      title: trimString(entry.title) ?? terminalId,
      goal: trimString(entry.goal),
      toolType: trimString(entry.toolType) as ChatTerminalSession["toolType"],
      status: status as ChatTerminalSession["status"],
      runtimeState: (trimString(entry.runtimeState) ?? "idle") as ChatTerminalSession["runtimeState"],
      active: typeof entry.active === "boolean" ? entry.active : status === "running",
      startedAt: trimString(entry.startedAt) ?? new Date(0).toISOString(),
      endedAt: trimString(entry.endedAt),
      exitCode: typeof entry.exitCode === "number" && Number.isInteger(entry.exitCode) ? entry.exitCode : null,
      pid: typeof entry.pid === "number" && Number.isInteger(entry.pid) ? entry.pid : null,
      resumeCommand: trimString(entry.resumeCommand),
      resumeMetadata: isRecord(entry.resumeMetadata) ? entry.resumeMetadata as ChatTerminalSession["resumeMetadata"] : null,
      lastOutputPreview: trimString(entry.lastOutputPreview),
      summary: trimString(entry.summary),
    }];
  });
}

function terminalToChoice(session: ChatTerminalSession): RemoteSessionChoice {
  const status = session.status === "running"
    ? session.runtimeState === "idle" ? "idle" : "active"
    : "ended";
  return {
    sessionId: session.terminalId,
    laneId: session.laneId,
    title: session.title || session.goal || session.terminalId,
    detail: session.goal ?? session.summary ?? session.lastOutputPreview ?? "",
    status,
    lastActivityAt: session.endedAt ?? session.startedAt,
    kind: "terminal",
  };
}

const TRACKED_CLI_REMOTE_PROVIDERS = new Set(["claude", "codex", "cursor", "droid", "opencode"]);

function isTerminalSessionLaunchable(session: ChatTerminalSession): boolean {
  const toolType = session.toolType ?? "";
  // Chat-backed terminals surface through the chat session list instead.
  if (toolType === "codex-chat" || toolType === "claude-chat" || toolType === "opencode-chat" || toolType === "cursor" || toolType === "droid-chat") {
    return false;
  }
  // Any tracked provider CLI (claude/codex/cursor-cli/droid/opencode) is
  // launchable — mirrors trackedCliTerminalProvider in adeApi.ts.
  if (
    toolType.startsWith("codex")
    || toolType.startsWith("cursor")
    || toolType.startsWith("droid")
    || toolType.startsWith("opencode")
    || toolType.startsWith("claude")
  ) {
    return true;
  }
  const provider = isRecord(session.resumeMetadata) ? session.resumeMetadata.provider : null;
  if (typeof provider === "string" && TRACKED_CLI_REMOTE_PROVIDERS.has(provider)) return true;
  const resumeCommand = typeof session.resumeCommand === "string" ? session.resumeCommand.trim().toLowerCase() : "";
  return Boolean(resumeCommand && /\bclaude\b/.test(resumeCommand));
}

function chatToChoice(session: AgentChatSessionSummary): RemoteSessionChoice {
  return {
    sessionId: session.sessionId,
    laneId: session.laneId,
    title: session.title ?? session.goal ?? session.sessionId,
    detail: session.goal ?? session.summary ?? session.lastOutputPreview ?? `${session.provider} ${session.model}`,
    status: session.status,
    lastActivityAt: session.lastActivityAt,
    kind: "chat",
  };
}

async function listRemoteChatSessions(client: ProcessJsonRpcClient, projectId: string): Promise<AgentChatSessionSummary[]> {
  const args = {
    includeArchived: false,
    includeAutomation: true,
  };
  try {
    return coerceChatSessions(await callProjectAction(client, projectId, "chat", "listSessions", args));
  } catch {
    // Older remote action adapters called the positional chat service API with
    // the object args as laneId. Retry through run_ade_action's positional
    // argsList form so stale-but-compatible runtimes still expose ADE chats.
    return coerceChatSessions(await callProjectActionArgsList(client, projectId, "chat", "listSessions", [
      null,
      args,
    ]));
  }
}

export async function listRemoteSessions(client: ProcessJsonRpcClient, projectId: string): Promise<RemoteSessionChoice[]> {
  const chats = await listRemoteChatSessions(client, projectId).catch((error) => {
    if (canPrompt()) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Remote ADE chats unavailable: ${message}\n`);
    }
    return [];
  });
  const terminals = coerceTerminalSessions(await callProjectAction(client, projectId, "terminal", "list", {
    limit: 200,
  }).catch(() => []));
  return [
    ...chats.map(chatToChoice),
    ...terminals.filter(isTerminalSessionLaunchable).map(terminalToChoice),
  ].sort((left, right) => {
    const statusRank = (status: string): number => status === "active" || status === "running" ? 0 : status === "idle" ? 1 : 2;
    const rankDelta = statusRank(left.status) - statusRank(right.status);
    if (rankDelta !== 0) return rankDelta;
    const rightMs = Date.parse(right.lastActivityAt);
    const leftMs = Date.parse(left.lastActivityAt);
    return (Number.isFinite(rightMs) ? rightMs : 0) - (Number.isFinite(leftMs) ? leftMs : 0);
  });
}

async function selectTarget(targets: RemoteRuntimeTarget[], query: string | null): Promise<RemoteRuntimeTarget> {
  if (!targets.length) {
    throw new Error("No saved remote machines found. Add a remote connection in the ADE desktop app first.");
  }
  if (query) {
    return findByQuery(
      targets,
      query,
      (target) => [target.id, target.name, target.hostname],
      "Remote machine",
    );
  }
  if (targets.length === 1 && !canPrompt()) return targets[0]!;
  return await promptChoice(
    "Remote machines",
    targets,
    (target) => `${target.name} (${target.sshUser ? `${target.sshUser}@` : ""}${target.hostname}${target.port ? `:${target.port}` : ""})`,
  );
}

async function selectScope(options: RemoteCliOptions): Promise<RemoteLaunchScope> {
  if (options.scope) return options.scope;
  if (!canPrompt()) return "project";
  return await promptChoice(
    "Open",
    ["project", "session"] as const,
    (scope) => scope === "project"
      ? "Project - full ADE Code workspace"
      : "Session - choose a running/recent chat first",
  );
}

export async function selectProject(
  client: ProcessJsonRpcClient,
  projects: RemoteRuntimeProjectRecord[],
  query: string | null,
): Promise<RemoteRuntimeProjectRecord> {
  if (query) {
    try {
      return findByQuery(
        projects,
        query,
        (project) => [project.projectId, project.displayName, project.rootPath, project.gitOriginUrl],
        "Remote project",
      );
    } catch (error) {
      const message = errorMessage(error);
      if ((query.startsWith("/") || query.startsWith("~")) && message.startsWith("Remote project not found:")) {
        return await ensureProject(client, query);
      }
      throw error;
    }
  }
  if (!projects.length) {
    return await ensureProject(client, await promptText("Remote project root"));
  }
  if (projects.length === 1 && !canPrompt()) return projects[0]!;
  return await promptChoice(
    "Remote projects",
    projects,
    (project) => `${project.displayName} (${project.rootPath})`,
  );
}

async function selectSession(sessions: RemoteSessionChoice[], query: string | null): Promise<RemoteSessionChoice> {
  if (!sessions.length) throw new Error("No remote sessions found for this project.");
  if (query) {
    return findByQuery(
      sessions,
      query,
      (session) => [session.sessionId, session.title, session.detail],
      "Remote session",
    );
  }
  if (sessions.length === 1 && !canPrompt()) return sessions[0]!;
  return await promptChoice(
    "Remote sessions",
    sessions,
    (session) => `${session.title} [${session.kind}, ${session.status}] (${session.sessionId})`,
  );
}

function printTargets(targets: RemoteRuntimeTarget[]): void {
  for (const target of targets) {
    process.stdout.write(`${target.id}\t${target.name}\t${target.sshUser ? `${target.sshUser}@` : ""}${target.hostname}${target.port ? `:${target.port}` : ""}\n`);
  }
}

function printProjects(projects: RemoteRuntimeProjectRecord[]): void {
  for (const project of projects) {
    process.stdout.write(`${project.projectId}\t${project.displayName}\t${project.rootPath}\n`);
  }
}

function printSessions(sessions: RemoteSessionChoice[]): void {
  for (const session of sessions) {
    process.stdout.write(`${session.sessionId}\t${session.kind}\t${session.status}\t${session.title}\n`);
  }
}

async function startRemoteBridge(attempt: RemoteRpcAttempt): Promise<RemoteBridge> {
  const server = net.createServer((socket) => {
    const child = spawnRemoteRpcProcess(attempt);
    let settled = false;
    const teardown = (): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      child.kill();
    };
    socket.on("error", teardown);
    socket.on("close", teardown);
    child.on("error", teardown);
    child.on("close", teardown);
    child.stderr.resume();
    socket.pipe(child.stdin);
    child.stdout.pipe(socket);
  });
  server.maxConnections = 1;

  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      server.off("listening", onListening);
      server.off("error", onError);
    };
    const onListening = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    server.once("listening", onListening);
    server.once("error", onError);
    server.listen(0, "127.0.0.1");
  });

  const address = server.address() as AddressInfo | null;
  if (!address) {
    throw new Error("Remote bridge did not bind a local port.");
  }
  return {
    socketUrl: `tcp://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export function takeAdeCodeRemoteArgs(rest: string[]): string[] | null {
  const valueFlags = new Set([
    "--project-root",
    "--workspace-root",
    "--lane",
    "--socket",
    "--session",
    "--chat",
  ]);
  let skipNext = false;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!;
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (arg === "--") return null;
    if (arg.startsWith("-")) {
      const flag = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
      skipNext = !arg.includes("=") && valueFlags.has(flag);
      continue;
    }
    if (arg !== "remote") return null;
    return [...rest.slice(0, index), ...rest.slice(index + 1)];
  }
  return null;
}

export async function runAdeCodeRemote(argv: string[], runAdeCodeCli: RunAdeCodeCli): Promise<number> {
  const options = parseRemoteAdeCodeArgs(argv);
  if (options.help) {
    printRemoteHelp();
    return 0;
  }

  const targets = new RemoteTargetRegistry().list();
  if (options.listTargets) {
    printTargets(targets);
    return 0;
  }

  const target = await selectTarget(targets, options.targetQuery);
  const remote = await openRemoteRpcSession(target);
  let bridge: RemoteBridge | null = null;
  try {
    const projects = await listProjects(remote.client);
    if (options.listProjects) {
      printProjects(projects);
      return 0;
    }

    const scope = await selectScope(options);
    const project = await selectProject(remote.client, projects, options.projectQuery);
    let session: RemoteSessionChoice | null = null;
    if (scope === "session" || options.listSessions) {
      const sessions = await listRemoteSessions(remote.client, project.projectId);
      if (options.listSessions) {
        printSessions(sessions);
        return 0;
      }
      session = await selectSession(sessions, options.sessionQuery);
    }

    remote.client.close();
    bridge = await startRemoteBridge(remote.attempt);
    process.stderr.write(
      `Connecting ADE Code to ${target.name} · ${project.displayName}${session ? ` · ${session.title}` : ""}\n`,
    );
    return await runAdeCodeCli([
      "--project-root",
      project.rootPath,
      "--workspace-root",
      project.rootPath,
      "--socket",
      bridge.socketUrl,
      "--require-socket",
      "--remote",
      "--remote-label",
      target.name,
      ...(session?.laneId ? ["--lane", session.laneId] : []),
      ...(session?.sessionId ? ["--session", session.sessionId] : []),
    ]);
  } finally {
    remote.client.close();
    if (bridge) await bridge.close();
  }
}
