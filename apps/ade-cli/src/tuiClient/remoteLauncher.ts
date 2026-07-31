import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import readlinePromises from "node:readline/promises";
import { RemoteTargetRegistry, normalizeRemoteTargetRoutes } from "../../../desktop/src/main/services/remoteRuntime/remoteTargetRegistry";
import {
  PairedRuntimeCompatibilityError,
  PairedRuntimeRelayAuthRequiredError,
  PairedRuntimeTransportUnavailableError,
} from "../../../desktop/src/main/services/remoteRuntime/pairedRuntimeErrors";
import { RuntimeRpcClient } from "../../../desktop/src/main/services/remoteRuntime/runtimeRpcClient";
import { AccountMachineDirectoryService } from "../services/account/accountMachineDirectoryService";
import {
  getSharedAccountAuthService,
  getSharedAccountDirectoryBaseUrl,
} from "../services/account/sharedAccountAuthService";
import {
  getSignedInAccountAccessToken,
  type AccountAuthService,
} from "../services/account/accountAuthService";
import type {
  RemoteRuntimeProjectRecord,
  RemoteRuntimeTarget,
  RemoteRuntimeTargetRoute,
} from "../../../desktop/src/shared/types/remoteRuntime";
import type { AdeAccountMachine } from "../../../desktop/src/shared/types/account";
import {
  accountMachineEndpointHost,
  accountMachineSecureSyncEndpoints,
} from "../../../desktop/src/shared/accountDirectory";
import type { AgentChatSessionSummary } from "../../../desktop/src/shared/types/chat";
import type { ChatTerminalSession } from "../../../desktop/src/shared/types/sessions";
import { defaultRelayUrl } from "../services/sync/syncCloudRelayStore";
import {
  ProcessJsonRpcClient,
  spawnRemoteRpcProcess,
  startRemoteBridge,
  startSyncRemoteBridge,
  type PairedRemoteBridgeConnection,
  type RemoteBridge,
  type RemoteRpcAttempt,
  type RemoteRpcSession,
  type RemoteRuntimeLayout,
} from "./remoteBridge";
import {
  assertRelayAccountUnchanged,
  openPairedCandidate,
  PairedRemoteConnectionUnavailableError,
  pairedConnectionLabel,
  pairedEndpointCandidatesForPreference,
  pairedRouteAccountProof,
  type AccountRelayProof,
  type AccountRelayProofResolver,
  type OpenedPairedCandidate,
  type RemoteRoutePreference,
} from "./pairedRemoteConnector";
import {
  attemptTimeoutMs,
  createRemoteLaunchBudget,
  REMOTE_CONNECT_TOTAL_TIMEOUT_MS,
  REMOTE_RPC_TIMEOUT_MS,
  RemoteLaunchTimeoutError,
  withBoundedAttempt,
  withTimeout,
  type RemoteLaunchBudget,
} from "./remoteLaunchBudget";

export {
  assertRelayAccountUnchanged,
  pairedConnectionLabel,
  pairedEndpointCandidatesForPreference,
  pairedRouteAccountProof,
};
export type { RemoteRoutePreference };

type RemoteRpcClientLike = {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  close(): void;
};

type OpenedRemoteSession = {
  client: RemoteRpcClientLike;
  mode: "ssh" | "paired";
  attempt?: RemoteRpcAttempt;
  connectionLabel?: string;
};

type InitializeResponse = {
  runtimeInfo?: {
    version?: string | null;
    multiProject?: boolean;
  };
  capabilities?: {
    projects?: boolean;
  };
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
  routePreference: RemoteRoutePreference;
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

type AccountMachineResolver = Pick<
  AccountMachineDirectoryService,
  "listMachines" | "pairListedMachine"
>;

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

function localCliVersion(): string {
  const envVersion = process.env.ADE_CLI_VERSION?.trim();
  if (envVersion) return envVersion;
  let cursor = process.cwd();
  while (true) {
    const candidate = path.join(cursor, "package.json");
    try {
      const packageJson = JSON.parse(fs.readFileSync(candidate, "utf8")) as {
        name?: unknown;
        version?: unknown;
      };
      if (packageJson.name === "ade-cli" && typeof packageJson.version === "string" && packageJson.version.trim()) {
        return packageJson.version.trim();
      }
    } catch {}
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  try {
    const packageJson = JSON.parse(
      fs.readFileSync(path.resolve("apps/ade-cli/package.json"), "utf8"),
    ) as { version?: unknown };
    return typeof packageJson.version === "string" && packageJson.version.trim()
      ? packageJson.version.trim()
      : "0.0.0";
  } catch {
    return "0.0.0";
  }
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
    routePreference: "auto",
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
    if (arg === "--route") {
      const value = readFlagValue(argv, index, arg).toLowerCase();
      if (value === "auto") options.routePreference = "auto";
      else if (value === "lan" || value === "local") options.routePreference = "lan";
      else if (value === "tailnet" || value === "tailscale") options.routePreference = "tailnet";
      else if (value === "relay") options.routePreference = "relay";
      else {
        throw new Error(
          `Unknown ADE Code remote route: ${value}. Use auto, lan, tailscale, or relay.`,
        );
      }
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

Connect ADE Code to a Mac already saved in ADE Connections.

Local network and Tailscale connections work without an ADE account. ADE Relay
requires both Macs to be signed in to the same account. Advanced SSH is used
only when you explicitly save an SSH connection.

Usage:
  ade code remote [project|session]
  ade code remote --target <machine> --project <project>
  ade code remote session --target <machine> --project <project> --session <session>
  ade code remote --list-targets

Flags:
  --target, --machine <id|name|host>       Select a saved remote machine.
  --route <auto|lan|tailscale|relay>       Choose a path (default: automatic failover).
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

export function machineSelectionMode(
  entryCount: number,
  interactive: boolean,
): "auto" | "prompt" | "flag-required" {
  if (interactive) return "prompt";
  return entryCount === 1 ? "auto" : "flag-required";
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

export function buildSshArgs(target: RemoteRuntimeTarget, route: RemoteRuntimeTargetRoute, command: string): string[] {
  const destinationHost = target.hostname.trim();
  const destination = target.sshUser?.trim()
    ? `${target.sshUser.trim()}@${destinationHost}`
    : destinationHost;
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
  if (route.hostname.trim().toLowerCase().replace(/\.$/, "") !== destinationHost.toLowerCase().replace(/\.$/, "")) {
    // Keep the saved host as the OpenSSH config selector while dialing the
    // concrete LAN/tailnet route. This preserves Host-scoped User,
    // IdentityFile, agent, and proxy settings that make the desktop target
    // connect successfully.
    args.push("-o", `HostName=${route.hostname}`);
  }
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

function isSshAuthenticationError(error: unknown): boolean {
  return /permission denied|authentication failed|all configured authentication methods failed/i.test(
    errorMessage(error),
  );
}

async function initializeRemoteRpc(client: RemoteRpcClientLike): Promise<InitializeResponse> {
  const initialize = await client.request<InitializeResponse>("ade/initialize", {
    protocolVersion: "2025-06-18",
    clientName: "ade-code-remote",
    clientInfo: { name: "ade-code-remote", version: localCliVersion() },
    identity: {
      role: "cto",
      callerId: `ade-code-remote:${process.pid}`,
    },
  });
  const remoteVersion = typeof initialize?.runtimeInfo?.version === "string"
    ? initialize.runtimeInfo.version.trim()
    : "";
  const localVersion = localCliVersion();
  if (
    remoteVersion &&
    localVersion &&
    remoteVersion !== "0.0.0" &&
    localVersion !== "0.0.0" &&
    remoteVersion !== localVersion
  ) {
    process.stderr.write(
      `Warning: remote ADE is ${remoteVersion}, local ADE Code is ${localVersion}; continuing because required RPC capabilities are present.\n`,
    );
  }
  if (initialize?.runtimeInfo?.multiProject !== true && initialize?.capabilities?.projects !== true) {
    throw new Error(
      `Remote ADE service ${remoteVersion || "unknown"} does not support the projects capability required by ade code remote. Update ADE on the remote machine.`,
    );
  }
  await client.request("ade/initialized");
  return initialize;
}

export async function openRemoteRpcSession(
  target: RemoteRuntimeTarget,
  options: {
    budget?: RemoteLaunchBudget;
    totalTimeoutMs?: number;
    attemptTimeoutMs?: number;
    spawnProcess?: typeof spawnRemoteRpcProcess;
    signal?: AbortSignal;
  } = {},
): Promise<RemoteRpcSession> {
  const errors: string[] = [];
  const authFailedRoutes = new Set<string>();
  const budget = options.budget
    ?? createRemoteLaunchBudget(options.totalTimeoutMs, options.signal);
  for (const attempt of remoteRpcAttempts(target)) {
    const attemptRouteKey = routeKey(attempt.route);
    if (authFailedRoutes.has(attemptRouteKey)) continue;
    const maximumAttemptTimeoutMs = options.attemptTimeoutMs ?? REMOTE_RPC_TIMEOUT_MS;
    let timeoutMs: number;
    let timeoutConsumesRemainingBudget: boolean;
    try {
      timeoutMs = attemptTimeoutMs(budget, maximumAttemptTimeoutMs);
      timeoutConsumesRemainingBudget =
        budget.deadline - Date.now() <= maximumAttemptTimeoutMs;
    } catch (error) {
      errors.push(`total deadline: ${errorMessage(error)}`);
      break;
    }
    const client = new ProcessJsonRpcClient((options.spawnProcess ?? spawnRemoteRpcProcess)(attempt));
    try {
      await withTimeout(
        initializeRemoteRpc(client),
        timeoutMs,
        `Remote ADE RPC did not initialize within ${timeoutMs}ms.`,
        budget.signal,
      );
      return { client, attempt };
    } catch (error) {
      client.close();
      errors.push(`${attempt.label}: ${errorMessage(error)}`);
      // Authentication is independent of the remote ADE home/command. Trying
      // the same route against every channel only repeats the same failure and
      // turns a useful error into a multi-minute stall.
      if (isSshAuthenticationError(error)) authFailedRoutes.add(attemptRouteKey);
      // When this attempt was capped by the remaining total budget, its timeout
      // is terminal. A timer may fire a millisecond before the wall-clock
      // deadline; starting another near-zero attempt only spawns and kills an
      // extra SSH process without giving it a meaningful chance to initialize.
      if (error instanceof RemoteLaunchTimeoutError && timeoutConsumesRemainingBudget) {
        errors.push(
          `total deadline: Remote connection deadline exceeded after ${budget.totalTimeoutMs}ms.`,
        );
        break;
      }
    }
  }
  throw new Error(
    `Could not connect to remote ADE on ${target.name}. ` +
      `Tried ${errors.length} bounded route/runtime combinations. ${errors.slice(0, 8).join(" | ")}`,
  );
}

export async function getCurrentAccountRelayProof(
  account: Pick<AccountAuthService, "getStatus" | "getAccessToken"> = getSharedAccountAuthService(),
): Promise<AccountRelayProof | null> {
  const token = await getSignedInAccountAccessToken(account);
  if (!token) return null;
  const status = account.getStatus();
  const userId = status.userId?.trim() ?? "";
  if (!userId || (!status.signedIn && status.source !== "env-token")) return null;
  return { userId, token };
}

async function openPairedRemoteSession(
  target: RemoteRuntimeTarget,
  budget = createRemoteLaunchBudget(),
  getAccountRelayProof: AccountRelayProofResolver = getCurrentAccountRelayProof,
  routePreference: RemoteRoutePreference = "auto",
): Promise<OpenedRemoteSession> {
  const registry = new RemoteTargetRegistry();
  let opened: OpenedPairedCandidate<{
    client: RemoteRpcClientLike;
    initialized: InitializeResponse;
  }>;
  try {
    opened = await openPairedCandidate({
      target,
      budget,
      appVersion: localCliVersion(),
      getAccountRelayProof,
      routePreference,
      acceptTransport: async (transport) => {
        const runtimeClient = new RuntimeRpcClient(transport);
        const client: RemoteRpcClientLike = {
          request: async <T,>(method: string, params?: unknown): Promise<T> =>
            await runtimeClient.call(
              method,
              isRecord(params) ? params : undefined,
            ) as T,
          close: () => runtimeClient.close(),
        };
        try {
          const timeoutMs = attemptTimeoutMs(budget);
          const initialized = await withTimeout(
            initializeRemoteRpc(client),
            timeoutMs,
            `Paired ADE RPC did not initialize within ${timeoutMs}ms.`,
            budget.signal,
          );
          return { client, initialized };
        } catch (error) {
          client.close();
          const message = errorMessage(error);
          if (
            /connection|websocket|sync|rpc channel|timed out|ECONN|EHOSTUNREACH|ENETUNREACH/i.test(
              message,
            )
          ) {
            throw error;
          }
          throw new PairedRuntimeCompatibilityError(
            `The paired ADE runtime could not initialize compatibly: ${message}`,
            error,
          );
        }
      },
    });
  } catch (error) {
    if (error instanceof PairedRemoteConnectionUnavailableError) {
      const reference = error.diagnostic?.correlationId
        ? ` Connection reference: ${error.diagnostic.correlationId}.`
        : "";
      throw new PairedRuntimeTransportUnavailableError(
        `${error.message}${reference}`,
        error,
        error.diagnostic,
      );
    }
    throw error;
  }
  try {
    registry.update(target.id, {
      runtimeBinaryVersion:
        opened.value.initialized.runtimeInfo?.version?.trim()
        || target.runtimeBinaryVersion,
      lastConnectedAt: opened.connectedAt,
    });
  } catch (error) {
    process.stderr.write(
      `Warning: could not save paired target metadata: ${errorMessage(error)}\n`,
    );
  }
  return {
    mode: "paired",
    client: opened.value.client,
    connectionLabel: pairedConnectionLabel(opened.candidate),
  };
}

async function openPairedTransport(
  target: RemoteRuntimeTarget,
  budget = createRemoteLaunchBudget(),
  getAccountRelayProof: AccountRelayProofResolver = getCurrentAccountRelayProof,
  routePreference: RemoteRoutePreference = "auto",
): Promise<PairedRemoteBridgeConnection> {
  const opened = await openPairedCandidate({
    target,
    budget,
    appVersion: localCliVersion(),
    getAccountRelayProof,
    routePreference,
    acceptTransport: async (transport) => transport,
  });
  return {
    transport: opened.value,
    connectionLabel: pairedConnectionLabel(opened.candidate),
  };
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

async function listProjects(client: RemoteRpcClientLike): Promise<RemoteRuntimeProjectRecord[]> {
  const raw = await withTimeout(
    client.request("projects.list", {}),
    REMOTE_RPC_TIMEOUT_MS,
    "Timed out listing remote projects.",
  );
  return sortProjects(coerceProjects(raw));
}

async function ensureProject(client: RemoteRpcClientLike, query: string): Promise<RemoteRuntimeProjectRecord> {
  // The user explicitly selected this project for a remote session, so it is
  // a real workspace on that machine — same semantic as an interactive local
  // `ade code` attach (add() never demotes an existing recent row).
  const raw = await withTimeout(
    client.request("projects.add", {
      rootPath: query,
      catalogVisibility: "recent",
      registrationSource: "cli-explicit",
    }),
    REMOTE_RPC_TIMEOUT_MS,
    `Timed out registering remote project ${query}.`,
  );
  const project = coerceProjects([raw])[0] ?? null;
  if (!project) throw new Error("Remote ADE did not return a project record.");
  return project;
}

async function callProjectAction<T>(
  client: RemoteRpcClientLike,
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
  client: RemoteRpcClientLike,
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
      currentTurnStartedAt: trimString(entry.currentTurnStartedAt),
      startedAt,
      endedAt: trimString(entry.endedAt),
      lastActivityAt,
      lastOutputPreview: trimString(entry.lastOutputPreview),
      summary: trimString(entry.summary),
      nextWakeAt: trimString(entry.nextWakeAt),
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

async function listRemoteChatSessions(client: RemoteRpcClientLike, projectId: string): Promise<AgentChatSessionSummary[]> {
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

export async function listRemoteSessions(client: RemoteRpcClientLike, projectId: string): Promise<RemoteSessionChoice[]> {
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
    throw new Error(
      "No saved Macs yet. In ADE desktop, open Connections and choose Add machine. " +
        "You can sign in to find your Macs, pair directly, scan your network, or use advanced SSH setup.",
    );
  }
  if (query) {
    return findByQuery(
      targets,
      query,
      (target) => [target.id, target.name, target.hostname],
      "Remote machine",
    );
  }
  const selectionMode = machineSelectionMode(targets.length, canPrompt());
  if (selectionMode === "auto") return targets[0]!;
  if (selectionMode === "flag-required") {
    throw new Error("Choose a Mac: pass --target <id|name|host> non-interactively.");
  }
  return await promptInteractiveChoice(
    "Choose a Mac",
    targets,
    remoteTargetChoiceLabel,
  );
}

export function remoteTargetChoiceLabel(target: RemoteRuntimeTarget): string {
  if (target.transport === "paired") {
    return `${target.name} (paired · local network → Tailscale → ADE Relay)`;
  }
  const destination = `${target.sshUser ? `${target.sshUser}@` : ""}${target.hostname}${target.port ? `:${target.port}` : ""}`;
  return `${target.name} (advanced SSH: ${destination})`;
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
  client: RemoteRpcClientLike,
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
    process.stdout.write(`${target.id}\t${remoteTargetChoiceLabel(target)}\n`);
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

function normalizedHost(value: string | null | undefined): string {
  return value?.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "") ?? "";
}

function accountMachineHosts(machine: AdeAccountMachine): Set<string> {
  const hosts = new Set<string>();
  for (const endpoint of machine.reachableEndpoints) {
    const direct = normalizedHost(accountMachineEndpointHost(endpoint));
    if (direct) hosts.add(direct);
  }
  return hosts;
}

export function accountMachineMatchesRemoteTarget(
  machine: AdeAccountMachine,
  target: RemoteRuntimeTarget,
): boolean {
  const machineHosts = accountMachineHosts(machine);
  if (machineHosts.size === 0) return false;
  return [target.hostname, ...(target.routes ?? []).map((route) => route.hostname)]
    .some((hostname) => machineHosts.has(normalizedHost(hostname)));
}

function isLegacyAccountCreatedSshTarget(
  machine: AdeAccountMachine,
  target: RemoteRuntimeTarget,
): boolean {
  if (!isUncredentialedRoutedSshTarget(target)) return false;
  if (machine.name?.trim().toLowerCase() !== target.name.trim().toLowerCase()) return false;
  const machineHosts = accountMachineHosts(machine);
  const routes = target.routes ?? [];
  if (routes.some((route) => route.source === "manual")) return false;
  const targetHosts = [target.hostname, ...routes.map((route) => route.hostname)]
    .map(normalizedHost)
    .filter(Boolean);
  return targetHosts.length > 0 && targetHosts.every((host) => machineHosts.has(host));
}

function isUncredentialedRoutedSshTarget(target: RemoteRuntimeTarget): boolean {
  return target.transport === "ssh"
    && !target.sshUser?.trim()
    && !target.sshKeyPath?.trim()
    && Boolean(target.routes?.length);
}

function isUnverifiedLegacyAccountCandidate(target: RemoteRuntimeTarget): boolean {
  if (!isUncredentialedRoutedSshTarget(target)) return false;
  const primaryHost = normalizedHost(target.hostname);
  const routes = target.routes ?? [];
  return routes.some((route) => normalizedHost(route.hostname) === primaryHost)
    && routes.every((route) => route.source !== "manual");
}

export async function resolveRemoteTargetForLaunch(
  target: RemoteRuntimeTarget,
  options: {
    registry?: Pick<RemoteTargetRegistry, "get" | "remove">;
    accountMachines?: AccountMachineResolver;
    accountProjectRoots?: readonly string[];
    budget?: RemoteLaunchBudget;
  } = {},
): Promise<RemoteRuntimeTarget> {
  if (target.transport === "paired") return target;
  if (target.sshUser?.trim() || target.sshKeyPath?.trim()) return target;
  const registry = options.registry ?? new RemoteTargetRegistry();
  const accountMachines = options.accountMachines ?? new AccountMachineDirectoryService(
    getSharedAccountAuthService(),
    {
      appVersion: localCliVersion(),
      directoryBaseUrl: () => getSharedAccountDirectoryBaseUrl({
        projectRoots: () => options.accountProjectRoots ?? [],
      }),
    },
  );
  const directoryTimeoutMs = options.budget
    ? attemptTimeoutMs(options.budget, 10_000)
    : 10_000;
  const listed = await accountMachines.listMachines({
    signal: options.budget?.signal,
    timeoutMs: directoryTimeoutMs,
  });
  if (listed.state !== "ok") {
    if (isUnverifiedLegacyAccountCandidate(target)) {
      const directoryReason = listed.message?.trim();
      throw new PairedRuntimeTransportUnavailableError(
        `Could not verify whether ${target.name} is an account-created paired-only target because ` +
          `the account machine directory is ${listed.state.replaceAll("_", " ")}. ` +
          (directoryReason ? `${directoryReason} ` : "") +
          "ADE will not silently downgrade this uncredentialed discovered target to SSH. " +
          "Sign in again or save an explicit SSH user/key for a true SSH target.",
      );
    }
    return target;
  }
  const matches = listed.machines.filter((machine) =>
    accountMachineMatchesRemoteTarget(machine, target),
  );
  if (matches.length !== 1) return target;
  const machine = matches[0]!;
  const legacyAccountTarget = isLegacyAccountCreatedSshTarget(machine, target);
  if (!legacyAccountTarget) return target;
  const hasVerifiedRelayRoute = accountMachineSecureSyncEndpoints(
    machine,
    [defaultRelayUrl()],
  ).length > 0;
  if (!machine.online && !hasVerifiedRelayRoute) {
    throw new PairedRuntimeTransportUnavailableError(
      `${machine.name ?? target.name} is offline. This account-created target is paired-only and will not downgrade to SSH.`,
    );
  }
  try {
    const pairingBudget = options.budget ?? createRemoteLaunchBudget(10_000);
    const paired = await withBoundedAttempt(pairingBudget, 10_000, async (attempt) =>
      await accountMachines.pairListedMachine(machine, {
        connectTimeoutMs: attempt.timeoutMs,
        pairingTimeoutMs: attempt.timeoutMs,
        signal: attempt.signal,
      })
    );
    const pairedTarget = registry.get(paired.targetId);
    if (!pairedTarget || pairedTarget.transport !== "paired") {
      throw new Error("Account machine adoption did not persist a paired remote target.");
    }
    if (pairedTarget.id !== target.id) {
      registry.remove(target.id);
    }
    return pairedTarget;
  } catch (error) {
    throw new PairedRuntimeTransportUnavailableError(
      `Could not establish the paired runtime for ${machine.name ?? target.name}. ` +
        `This account-created target is paired-only and will not downgrade to SSH. ${errorMessage(error)}`,
      error,
    );
  }
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

export function hasExplicitSshFallback(target: RemoteRuntimeTarget): boolean {
  return Boolean(
    target.sshUser?.trim()
      || target.sshKeyPath?.trim()
      || target.routes?.some((route) => route.source === "manual"),
  );
}

export async function runAdeCodeRemote(
  argv: string[],
  runAdeCodeCli: RunAdeCodeCli,
  launchOptions: { accountProjectRoots?: readonly string[] } = {},
): Promise<number> {
  const options = parseRemoteAdeCodeArgs(argv);
  if (options.help) {
    printRemoteHelp();
    return 0;
  }

  const registry = new RemoteTargetRegistry();
  const targets = registry.list();
  if (options.listTargets) {
    printTargets(targets);
    return 0;
  }

  const selectedTarget = await selectTarget(targets, options.targetQuery);
  const controller = new AbortController();
  const cancel = (signal: NodeJS.Signals): void => {
    controller.abort(new Error(`Remote ADE connection cancelled by ${signal}.`));
  };
  const onSigint = () => cancel("SIGINT");
  const onSigterm = () => cancel("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  const removeSignalHandlers = (): void => {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  };
  const budget = createRemoteLaunchBudget(REMOTE_CONNECT_TOTAL_TIMEOUT_MS, controller.signal);
  const accountAuth = getSharedAccountAuthService({
    projectRoots: () => launchOptions.accountProjectRoots ?? [],
  });
  const getAccountRelayProof = async (): Promise<AccountRelayProof | null> =>
    await getCurrentAccountRelayProof(accountAuth);
  let target: RemoteRuntimeTarget;
  let remote: OpenedRemoteSession;
  try {
    target = await withTimeout(
      resolveRemoteTargetForLaunch(selectedTarget, {
        registry,
        budget,
        accountProjectRoots: launchOptions.accountProjectRoots,
      }),
      attemptTimeoutMs(budget, 10_000),
      "Timed out resolving the saved machine against the account directory.",
      controller.signal,
    );
    if (target.transport !== "paired" && options.routePreference !== "auto") {
      throw new Error(
        `--route ${options.routePreference} applies only to paired Macs. ` +
          `${target.name} is configured for advanced SSH.`,
      );
    }
    if (target.transport === "paired") {
      try {
        remote = await openPairedRemoteSession(
          target,
          budget,
          getAccountRelayProof,
          options.routePreference,
        );
      } catch (pairedError) {
        // A paired LAN/Tailscale address is not evidence that SSH was set up.
        // Fall back only when the user explicitly saved advanced SSH details.
        if (
          !hasExplicitSshFallback(target)
          || options.routePreference !== "auto"
          || !(
            pairedError instanceof PairedRuntimeTransportUnavailableError
            || pairedError instanceof PairedRuntimeCompatibilityError
            || pairedError instanceof PairedRuntimeRelayAuthRequiredError
          )
        ) {
          throw pairedError;
        }
        remote = { ...(await openRemoteRpcSession(target, { budget })), mode: "ssh" };
      }
    } else {
      remote = { ...(await openRemoteRpcSession(target, { budget })), mode: "ssh" };
    }
  } finally {
    removeSignalHandlers();
  }
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
    let connectionLabel = remote.connectionLabel ?? remote.attempt?.label ?? "saved connection";
    if (remote.mode === "paired") {
      const initialConnection = await openPairedTransport(
        target,
        createRemoteLaunchBudget(),
        getAccountRelayProof,
        options.routePreference,
      );
      connectionLabel = initialConnection.connectionLabel;
      let reportedConnectionLabel = connectionLabel;
      bridge = await startSyncRemoteBridge({
        target,
        initialConnection,
        openTransport: (currentTarget) => openPairedTransport(
          currentTarget,
          createRemoteLaunchBudget(),
          getAccountRelayProof,
          options.routePreference,
        ),
        onConnectionChanged: (nextConnectionLabel) => {
          if (nextConnectionLabel === reportedConnectionLabel) return;
          reportedConnectionLabel = nextConnectionLabel;
          process.stderr.write(
            `ADE Code remote switched connection path to ${nextConnectionLabel}.\n`,
          );
        },
      });
    } else {
      bridge = await startRemoteBridge({
        target,
        initialAttempt: remote.attempt,
        openRemoteRpcSession,
      });
    }
    process.stderr.write(
      `Connecting ADE Code to ${target.name} via ${connectionLabel} · ${project.displayName}${session ? ` · ${session.title}` : ""}\n`,
    );
    if (remote.mode === "paired" && options.routePreference === "auto") {
      process.stderr.write(
        "Automatic failover is enabled: local network → Tailscale → ADE Relay.\n",
      );
    }
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
