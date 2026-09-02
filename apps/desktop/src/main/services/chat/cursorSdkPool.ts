import { fork, type ChildProcess, type ForkOptions } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "../logging/logger";
import { listPluginAgentSkillRoots } from "../plugins/pluginInstallService";
import { buildPackagedRuntimeNodeModulePaths } from "../runtime/packagedNodePath";
import { joinAdeAgentSkillRoots, splitAdeAgentSkillRoots } from "../../../shared/agentSkillRoots";
import { pathKey } from "../shared/pathCompare";
import { CURSOR_SDK_ONESHOT_POLICY } from "./cursorSdkPolicy";
import { terminateChildProcessTree } from "../shared/utils";
import type {
  CursorSdkCloudArtifactDescriptor,
  CursorSdkErrorDetail,
  CursorSdkHookDecision,
  CursorSdkHookRequest,
  CursorSdkModelParameterValue,
  CursorSdkPermissionPolicy,
  CursorSdkRuntime,
  CursorSdkSendPrompt,
  CursorSdkWorkerInit,
  CursorSdkWorkerRequest,
  CursorSdkWorkerResponse,
} from "./cursorSdkProtocol";

type PendingRpc = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  type: CursorSdkWorkerRequest["type"];
};

export type CursorSdkRuntimeMeta = {
  runtime: CursorSdkRuntime;
  runId?: string;
  agentId?: string;
  requestId?: string;
  sdkRequestId?: string;
  /** Terminal run store errorCode, present on run_result when a run errored. */
  errorCode?: string;
  errorDetail?: CursorSdkErrorDetail;
};

export type CursorSdkBridge = {
  onEvent: ((event: unknown, meta?: CursorSdkRuntimeMeta) => void) | null;
  onRunStarted:
    | ((
        event: {
          agentId: string;
          runId: string;
          modelSdkId?: string | null;
          modelParams?: CursorSdkModelParameterValue[];
        },
        meta?: CursorSdkRuntimeMeta,
      ) => void)
    | null;
  onRunResult: ((result: unknown, meta?: CursorSdkRuntimeMeta) => void) | null;
  onRunStatus:
    | ((
        event: { agentId: string; runId: string; status: string },
        meta?: CursorSdkRuntimeMeta,
      ) => void)
    | null;
  onCloudArtifact:
    | ((
        artifact: CursorSdkCloudArtifactDescriptor,
        meta?: CursorSdkRuntimeMeta,
      ) => void)
    | null;
  onHookRequest: ((request: CursorSdkHookRequest) => Promise<CursorSdkHookDecision>) | null;
};

export type CursorSdkPooled = {
  process: ChildProcess;
  bridge: CursorSdkBridge;
  agentId: string | null;
  runId: string | null;
  request: <T = unknown>(type: CursorSdkWorkerRequest["type"], payload?: unknown) => Promise<T>;
  sendPrompt: (payload: CursorSdkSendPrompt) => Promise<unknown>;
  updatePolicy: (policy: CursorSdkPermissionPolicy) => Promise<void>;
  cancel: () => Promise<void>;
  dispose: () => void;
  /** Resolves only after the worker process has actually exited. */
  waitForExit: () => Promise<void>;
};

let cursorSdkGenCounter = 0;
type CursorSdkPoolEntry = {
  ref: number;
  generation: number;
  pooled: CursorSdkPooled;
  cacheRoot: string;
  stateRoot: string;
  socketPath: string;
  cleanupStateRoot: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
};

const pools = new Map<string, CursorSdkPoolEntry>();
const pendingInits = new Map<string, Promise<CursorSdkPooled>>();
/** Poisoned/released workers still shutting down, keyed by pool key. */
const departingWorkers = new Map<string, Promise<void>>();
const STALE_INIT_RETRY_LIMIT = 2;
/**
 * How long the worker gets to answer the IPC `dispose` request before the pool
 * kills its process tree. It has to cover cancelling an in-flight run and
 * closing the SDK agent, and on Windows it is the only orderly path there is.
 */
const CURSOR_SDK_DISPOSE_GRACE_MS = 3_000;
/**
 * Gap between SIGTERM and SIGKILL once the dispose grace expires.
 *
 * Named here rather than left to `terminateChildProcessTree`'s default, because
 * the replacement wait below has to be derived from it: two independent numbers
 * would drift, and the drift is only observable as a failed turn an hour into a
 * session.
 */
const CURSOR_SDK_KILL_ESCALATION_MS = 1_500;
/**
 * Cap how long a replacement waits for the previous worker of the same pool key.
 *
 * This has to cover the whole teardown ladder, not just the dispose grace. A
 * worker that answers the IPC `dispose` exits in milliseconds and never reaches
 * this wait — but the worker the wait exists for is wedged (expired token,
 * transport-poisoned agent thread), so it ignores the IPC request *and* the
 * SIGTERM, and only dies at grace + escalation. Budgeting for the grace alone
 * made the wait expire ~1.5s before the process could possibly exit, so every
 * wedged recycle threw and failed the very turn it was recovering.
 */
export const CURSOR_SDK_REPLACE_WAIT_MS =
  CURSOR_SDK_DISPOSE_GRACE_MS + CURSOR_SDK_KILL_ESCALATION_MS + 1_000;
/**
 * Budget for a hook socket path, in bytes.
 *
 * POSIX `sun_path` holds 104 bytes on macOS/BSD and 108 on Linux, and libuv
 * rejects a longer `listen()` with EINVAL — not ENAMETOOLONG — so an over-long
 * path reads as a mysterious "invalid argument" at bind time. The budget sits
 * under the macOS limit to leave room for the trailing NUL and a tmpdir that is
 * a few bytes longer than the usual `/var/folders/<2>/<30>/T`.
 */
export const MAX_CURSOR_SDK_SOCKET_PATH_BYTES = 100;
/** Fallback socket root when the platform tmpdir is too deep to bind under. */
const SHORT_SOCKET_ROOT = "/tmp";
const CURSOR_SDK_WORKER_ENV_DENYLIST = [
  "CURSOR_API_KEY",
  "CURSOR_AUTH_TOKEN",
  "ADE_RUNTIME_SOCKET_PATH",
  "ADE_RPC_SOCKET_PATH",
  "ADE_DESKTOP_BRIDGE_SOCKET_PATH",
  "ADE_RUNTIME_BUILD_HASH",
  "ADE_RUNTIME_PARENT_PID",
  "ADE_RUNTIME_IDLE_EXIT_MS",
  "ADE_CLI_ENTRY_PATH",
  "ADE_CLI_JS",
  "ADE_CLI_INSTALL_NAME",
  "ADE_DEFAULT_ROLE",
  "ADE_DESKTOP_APP_NAME",
  "ADE_ALLOW_RUNTIME_SERVICE_SELF_MUTATION",
  "ADE_ALLOW_LOCAL_RELEASE_SERVICE_INSTALL",
  "ELECTRON_RUN_AS_NODE",
] as const;
const moduleDir =
  typeof __dirname === "string"
    ? __dirname
    : path.dirname(fileURLToPath(import.meta.url));

function hashKey(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function resolveWorkerPath(): string {
  const candidates = [
    path.join(moduleDir, "cursorSdkWorker.cjs"),
    path.join(process.cwd(), "dist", "main", "cursorSdkWorker.cjs"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[0]!;
}

function socketPathFor(
  poolKey: string,
  instanceId: string,
  tempDir: string = os.tmpdir(),
  platform: NodeJS.Platform = process.platform,
): string {
  const trimmedInstance = instanceId.trim();
  if (!trimmedInstance) {
    throw new Error("Cursor SDK worker instance id is required.");
  }
  if (platform === "win32") {
    // Named pipes live in a flat kernel namespace with no `sun_path` budget, so
    // the two hashes stay separate and readable there.
    return `\\\\.\\pipe\\ade-cursor-sdk-${hashKey(poolKey)}-${hashKey(trimmedInstance)}`;
  }
  const userPart = typeof process.getuid === "function" ? String(process.getuid()) : hashKey(os.homedir());
  // One directory per worker instance, so a dying worker's close()/unlink and
  // the pool's `rmSync` of the socket directory cannot delete the replacement's
  // hook socket (same pool key, overlapping shutdown). Pool and instance share
  // a single segment: a second directory level costs 17 bytes, and the default
  // macOS tmpdir already spends 48 of the 104 `sun_path` bytes.
  const tail = path.join(`ade-cursor-sdk-${userPart}`, hashKey(`${poolKey}\n${trimmedInstance}`), "hook.sock");
  const preferred = path.join(tempDir, tail);
  if (Buffer.byteLength(preferred, "utf8") <= MAX_CURSOR_SDK_SOCKET_PATH_BYTES) return preferred;
  // A deep TMPDIR would otherwise fail at bind() with a bare EINVAL. `/tmp` is
  // world-writable, but `ensurePrivateSocketPath` creates every level 0700 and
  // refuses a directory this user does not own, so a squatter cannot answer
  // the worker's connect.
  return path.join(SHORT_SOCKET_ROOT, tail);
}

export function sanitizeCursorSdkWorkerBaseEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const key of CURSOR_SDK_WORKER_ENV_DENYLIST) {
    delete env[key];
  }
  return env;
}

export function isCursorSdkPooledAlive(pooled: CursorSdkPooled): boolean {
  return pooled.process.exitCode == null
    && !pooled.process.killed
    && pooled.process.connected !== false;
}

function pathEnvKey(env: NodeJS.ProcessEnv): string {
  if (process.platform !== "win32") return "PATH";
  if (env.PATH !== undefined) return "PATH";
  if (env.Path !== undefined) return "Path";
  return "PATH";
}

function prependPathDir(env: NodeJS.ProcessEnv, dir: string | null | undefined): void {
  if (!dir?.trim()) return;
  try {
    if (!fs.statSync(dir).isDirectory()) return;
  } catch {
    return;
  }
  const key = pathEnvKey(env);
  const current = env[key]?.trim();
  const parts = current ? current.split(path.delimiter) : [];
  if (parts.some((part) => path.resolve(part) === path.resolve(dir))) return;
  env[key] = current ? `${dir}${path.delimiter}${current}` : dir;
}

function prependPathEntries(existing: string | undefined, entries: readonly string[]): string | undefined {
  const next: string[] = [];
  const seen = new Set<string>();
  const add = (entry: string | undefined): void => {
    const trimmed = entry?.trim();
    if (!trimmed) return;
    const key = path.resolve(trimmed);
    if (seen.has(key)) return;
    seen.add(key);
    next.push(trimmed);
  };
  for (const entry of entries) add(entry);
  for (const entry of existing?.split(path.delimiter) ?? []) add(entry);
  return next.length ? next.join(path.delimiter) : existing;
}

function prependPathList(existing: string | undefined, root: string | null): string | undefined {
  if (!root) return existing;
  try {
    if (!fs.statSync(root).isDirectory()) return existing;
  } catch {
    return existing;
  }
  return prependPathEntries(existing, [root]);
}

function existingFilePath(candidate: string | null | undefined): string | null {
  const trimmed = candidate?.trim();
  if (!trimmed) return null;
  try {
    const resolved = path.resolve(trimmed);
    return fs.statSync(resolved).isFile() ? resolved : null;
  } catch {
    return null;
  }
}

function existingDirPath(candidate: string | null | undefined): string | null {
  const trimmed = candidate?.trim();
  if (!trimmed) return null;
  try {
    const resolved = path.resolve(trimmed);
    return fs.statSync(resolved).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

function commandFileName(name: string): string {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

function adeCommandNameCandidates(env: NodeJS.ProcessEnv): string[] {
  const names = [
    env.ADE_CLI_PATH ? path.basename(env.ADE_CLI_PATH, process.platform === "win32" ? ".cmd" : "") : "",
    env.ADE_CLI_INSTALL_NAME,
    env.ADE_PACKAGE_CHANNEL === "alpha" || env.ADE_PACKAGE_CHANNEL === "beta"
      ? `ade-${env.ADE_PACKAGE_CHANNEL}`
      : "",
    "ade",
    "ade-dev",
  ];
  return Array.from(new Set(names.map((name) => name?.trim()).filter((name): name is string => Boolean(name))));
}

function findAdeCommandInBinDir(binDir: string | null, env: NodeJS.ProcessEnv): string | null {
  if (!binDir) return null;
  for (const name of adeCommandNameCandidates(env)) {
    const candidate = existingFilePath(path.join(binDir, commandFileName(name)));
    if (!candidate) continue;
    return candidate;
  }
  return null;
}

function inferAdeCliBinDirFromEntry(cliEntry: string | null): string | null {
  if (!cliEntry) return null;
  return existingDirPath(path.join(path.dirname(cliEntry), "bin"));
}

function inferAdeCliEntryFromBinDir(binDir: string | null): string | null {
  if (!binDir) return null;
  return existingFilePath(path.resolve(binDir, "..", "cli.cjs"));
}

function uniqueExistingDirs(candidates: readonly (string | null | undefined)[]): string[] {
  const dirs: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const dir = existingDirPath(candidate);
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    dirs.push(dir);
  }
  return dirs;
}

function resourcesRootFromAdeCliBinDir(binDir: string | null): string | null {
  if (!binDir) return null;
  if (path.basename(binDir) !== "bin") return null;
  const cliDir = path.dirname(binDir);
  if (path.basename(cliDir) !== "ade-cli") return null;
  return path.resolve(cliDir, "..");
}

function resourcesRootFromAdeCliEntry(cliEntry: string | null): string | null {
  if (!cliEntry) return null;
  const cliDir = path.dirname(cliEntry);
  if (path.basename(cliDir) !== "ade-cli") return null;
  return path.resolve(cliDir, "..");
}

function inferPackagedResourcesRoots(env: NodeJS.ProcessEnv): string[] {
  const processWithResources = process as NodeJS.Process & { resourcesPath?: string };
  const envBinDir = existingDirPath(env.ADE_CLI_BIN_DIR);
  const envCliPath = existingFilePath(env.ADE_CLI_PATH);
  const envCliEntry = existingFilePath(env.ADE_CLI_ENTRY_PATH);
  const argvCliEntry = existingFilePath(typeof process.argv[1] === "string" ? process.argv[1] : null);
  return uniqueExistingDirs([
    processWithResources.resourcesPath,
    resourcesRootFromAdeCliBinDir(envBinDir),
    resourcesRootFromAdeCliBinDir(envCliPath ? path.dirname(envCliPath) : null),
    resourcesRootFromAdeCliEntry(envCliEntry),
    resourcesRootFromAdeCliEntry(argvCliEntry),
    path.basename(moduleDir) === "ade-cli" ? path.dirname(moduleDir) : null,
  ]).filter((resourcesRoot) =>
    buildPackagedRuntimeNodeModulePaths({ resourcesPath: resourcesRoot }).some((entry) => existingDirPath(entry) != null)
  );
}

function applyPackagedCursorSdkNodePath(env: NodeJS.ProcessEnv): void {
  const entries = inferPackagedResourcesRoots(env).flatMap((resourcesPath) =>
    buildPackagedRuntimeNodeModulePaths({ resourcesPath })
  );
  if (entries.length) env.NODE_PATH = prependPathEntries(env.NODE_PATH, entries);
}

function applyCurrentAdeCliEnv(
  env: NodeJS.ProcessEnv,
  sourceEnv: NodeJS.ProcessEnv = env,
  logger?: Pick<Logger, "warn"> | null,
): void {
  const envCliEntry = existingFilePath(sourceEnv.ADE_CLI_ENTRY_PATH ?? env.ADE_CLI_ENTRY_PATH);
  const argvCliEntry = existingFilePath(typeof process.argv[1] === "string" ? process.argv[1] : null);
  const binDir = existingDirPath(sourceEnv.ADE_CLI_BIN_DIR ?? env.ADE_CLI_BIN_DIR)
    ?? inferAdeCliBinDirFromEntry(envCliEntry)
    ?? inferAdeCliBinDirFromEntry(argvCliEntry);
  if (binDir) {
    env.ADE_CLI_BIN_DIR = binDir;
    prependPathDir(env, binDir);
    const commandPath = findAdeCommandInBinDir(binDir, sourceEnv)
      ?? findAdeCommandInBinDir(binDir, env);
    if (commandPath) env.ADE_CLI_PATH = commandPath;
  }
  const cliEntry = inferAdeCliEntryFromBinDir(binDir) ?? envCliEntry ?? argvCliEntry;
  if (cliEntry) env.ADE_CLI_ENTRY_PATH = cliEntry;
  else delete env.ADE_CLI_ENTRY_PATH;
  applyPackagedCursorSdkNodePath(env);
  const bundledSkillsRoot = binDir
    ? path.resolve(binDir, "..", "..", "agent-skills")
    : cliEntry
      ? path.resolve(path.dirname(cliEntry), "..", "agent-skills")
      : null;
  env.ADE_AGENT_SKILLS_DIRS = prependPathList(env.ADE_AGENT_SKILLS_DIRS, bundledSkillsRoot);
  // Plugin skill roots go LAST, the same order `appendPluginAgentSkillRoots`
  // uses for every other runtime: first-root-wins, so a plugin adds skills but
  // never shadows one ADE ships. Cursor is the only runtime that took the
  // bundled root and stopped here, which meant an installed plugin's skills
  // were present on Claude and Codex and silently absent on Cursor.
  const pluginSkillRoots = listPluginAgentSkillRoots({ env: sourceEnv, ...(logger ? { logger } : {}) });
  if (pluginSkillRoots.length) {
    env.ADE_AGENT_SKILLS_DIRS = joinAdeAgentSkillRoots([
      ...splitAdeAgentSkillRoots(env.ADE_AGENT_SKILLS_DIRS),
      ...pluginSkillRoots,
    ]);
  }
}

function ensurePrivateDirectory(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let fd: number | null = null;
  try {
    // Older Node/platform pairs can omit these open flags; fstat below still
    // verifies the directory shape when the constants are unavailable.
    fd = fs.openSync(
      dir,
      fs.constants.O_RDONLY
        | (fs.constants.O_DIRECTORY ?? 0)
        | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const stat = fs.fstatSync(fd);
    if (!stat.isDirectory()) {
      throw new Error(`Cursor SDK socket directory is not a private directory: ${dir}`);
    }
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new Error(`Cursor SDK socket directory is not owned by the current user: ${dir}`);
    }
    fs.fchmodSync(fd, 0o700);
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

function ensurePrivateSocketPath(socketPath: string): void {
  if (process.platform === "win32") return;
  const dirs: string[] = [];
  let dir = path.dirname(socketPath);
  for (let i = 0; i < 6; i += 1) {
    dirs.push(dir);
    if (path.basename(dir).startsWith("ade-cursor-sdk-")) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (let i = dirs.length - 1; i >= 0; i -= 1) {
    ensurePrivateDirectory(dirs[i]!);
  }
}

export function resolveCursorSdkUserHome(env: NodeJS.ProcessEnv = process.env): string {
  const preferred = process.platform === "win32"
    ? env.USERPROFILE?.trim() || env.HOME?.trim()
    : env.HOME?.trim() || env.USERPROFILE?.trim();
  return preferred || os.homedir();
}

export function buildCursorSdkPaths(args: {
  projectRoot: string;
  poolKey: string;
  instanceId: string;
  stateKey?: string;
  userHomeDir?: string;
  /** Overridable so the deep-tmpdir fallback is testable from any platform. */
  tempDir?: string;
  /** Overridable so the Windows named-pipe branch is testable from POSIX. */
  platform?: NodeJS.Platform;
}): { userHomeDir: string; cacheRoot: string; stateRoot: string; socketPath: string } {
  const keyHash = hashKey(args.stateKey ?? args.poolKey);
  const cacheRoot = path.join(args.projectRoot, ".ade", "cache", "cursor-sdk", keyHash);
  return {
    userHomeDir: args.userHomeDir?.trim() || resolveCursorSdkUserHome(),
    cacheRoot,
    stateRoot: path.join(cacheRoot, "state"),
    socketPath: socketPathFor(
      args.poolKey,
      args.instanceId,
      args.tempDir ?? os.tmpdir(),
      args.platform ?? process.platform,
    ),
  };
}

export function buildCursorSdkWorkerEnv(args: {
  baseEnv?: NodeJS.ProcessEnv;
  userHomeDir: string;
  stateRoot: string;
  socketPath: string;
  workspacePath: string;
  sessionId: string;
  logger?: Pick<Logger, "warn"> | null;
}): NodeJS.ProcessEnv {
  const baseEnv = args.baseEnv ?? process.env;
  const env: NodeJS.ProcessEnv = {
    ...sanitizeCursorSdkWorkerBaseEnv(baseEnv),
    HOME: args.userHomeDir,
    USERPROFILE: args.userHomeDir,
    ADE_DISABLE_RUNTIME_SERVICE_INSTALL: "1",
    ADE_CURSOR_SDK_SOCKET: args.socketPath,
    ADE_CURSOR_SDK_LANE_ROOT: args.workspacePath,
    ADE_CURSOR_SDK_SESSION_ID: args.sessionId,
    ADE_CURSOR_SDK_STATE_ROOT: args.stateRoot,
  };
  // ADE_HOME and ADE_PACKAGE_CHANNEL are re-asserted from the base environment
  // AFTER the sanitize, so a later denylist entry cannot silently drop them
  // again. They are not brain ownership: stripping ADE_RUNTIME_SOCKET_PATH
  // still stands, because the CLI derives the socket it may talk to from
  // ADE_HOME through `resolveMachineAdeLayout` rather than inheriting the one
  // handed to the brain. What ADE_HOME carries is WHICH APP'S STATE this agent
  // belongs to. Dropping it pointed an Alpha agent's injected `ade` at the
  // stable machine, where it could not reach the Alpha brain at all and fell
  // back to a headless in-process runtime.
  const channelHome = baseEnv.ADE_HOME?.trim();
  if (channelHome) env.ADE_HOME = channelHome;
  const packageChannel = baseEnv.ADE_PACKAGE_CHANNEL?.trim();
  if (packageChannel) env.ADE_PACKAGE_CHANNEL = packageChannel;
  applyCurrentAdeCliEnv(env, baseEnv, args.logger ?? null);
  delete env.ADE_CLI_ENTRY_PATH;
  return env;
}

export async function acquireCursorSdkConnection(args: {
  poolKey: string;
  stateKey?: string;
  projectRoot: string;
  workspacePath: string;
  baseEnv?: NodeJS.ProcessEnv;
  modelSdkId: string;
  modelParams?: CursorSdkModelParameterValue[];
  apiKey?: string | null;
  agentId?: string | null;
  agentName?: string | null;
  sessionId: string;
  policy: CursorSdkPermissionPolicy;
  mcpServers?: Record<string, unknown>;
  cleanupStateRoot?: boolean;
  logger?: Logger;
}): Promise<{ pooled: CursorSdkPooled; generation: number }> {
  for (let staleInitRetries = 0; ; staleInitRetries += 1) {
    const existing = pools.get(args.poolKey);
    if (existing && isCursorSdkPooledAlive(existing.pooled)) {
      clearCursorSdkIdleTimer(existing);
      existing.ref += 1;
      return { pooled: existing.pooled, generation: existing.generation };
    }
    if (existing) disposeCursorSdkPoolEntry(args.poolKey, existing);
    await waitForDepartingCursorSdkWorker(args.poolKey);

    let initOwner = false;
    let init = pendingInits.get(args.poolKey);
    if (!init) {
      initOwner = true;
      init = createCursorSdkConnection(args).finally(() => {
        pendingInits.delete(args.poolKey);
      });
      pendingInits.set(args.poolKey, init);
    }

    const pooled = await init;
    const entry = pools.get(args.poolKey);
    const live = entry?.pooled === pooled && isCursorSdkPooledAlive(pooled);
    if (!entry || !live) {
      if (initOwner) {
        throw new Error("Cursor SDK worker was disposed during initialization.");
      }
      if (staleInitRetries >= STALE_INIT_RETRY_LIMIT) {
        throw new Error("Cursor SDK worker initialization did not settle after retries.");
      }
      continue;
    }
    if (!initOwner) entry.ref += 1;
    return { pooled: entry.pooled, generation: entry.generation };
  }
}

async function createCursorSdkConnection(args: Parameters<typeof acquireCursorSdkConnection>[0]): Promise<CursorSdkPooled> {
  const workerPath = resolveWorkerPath();
  const instanceId = randomUUID();
  const paths = buildCursorSdkPaths({
    projectRoot: args.projectRoot,
    poolKey: args.poolKey,
    instanceId,
    stateKey: args.stateKey,
  });
  fs.mkdirSync(paths.stateRoot, { recursive: true });
  ensurePrivateSocketPath(paths.socketPath);

  // fork() forwards its options to spawn(), which supports windowsHide, but
  // the installed @types/node ForkOptions declaration omits that property.
  const child = fork(workerPath, [], {
    cwd: args.workspacePath,
    env: buildCursorSdkWorkerEnv({
      baseEnv: args.baseEnv,
      userHomeDir: paths.userHomeDir,
      stateRoot: paths.stateRoot,
      socketPath: paths.socketPath,
      workspacePath: args.workspacePath,
      sessionId: args.sessionId,
      logger: args.logger ?? null,
    }),
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    execArgv: [],
    windowsHide: true,
  } as ForkOptions & { windowsHide: boolean });
  const pending = new Map<string, PendingRpc>();
  let disposeTimer: NodeJS.Timeout | null = null;
  let killTimer: NodeJS.Timeout | null = null;
  const bridge: CursorSdkBridge = {
    onEvent: null,
    onRunStarted: null,
    onRunResult: null,
    onRunStatus: null,
    onCloudArtifact: null,
    onHookRequest: null,
  };
  const workerIpcClosedError = () => new Error("Cursor SDK worker IPC channel is closed.");
  const normalizeIpcSendError = (error: unknown): Error => (
    error instanceof Error ? error : new Error(String(error))
  );
  let lastStderr = "";
  let resolveExit!: () => void;
  let exitSettled = false;
  const settleExit = (): void => {
    if (exitSettled) return;
    exitSettled = true;
    resolveExit();
  };
  const exitPromise = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  const rememberStderr = (text: string): void => {
    const trimmed = text.trim();
    if (!trimmed) return;
    lastStderr = `${lastStderr}\n${trimmed}`.trim().slice(-4000);
  };
  const summarizeStderr = (): string | null => {
    const lines = lastStderr
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (!lines.length) return null;
    const meaningful = [
      lines.find((line) => /^(ConnectError|Error|TypeError|ReferenceError|SyntaxError):/.test(line)),
      lines.find((line) => line.includes("NGHTTP2_ENHANCE_YOUR_CALM")),
      lines.find((line) => line.includes("rawMessage:")),
      lines.find((line) => line.startsWith("Node.js ")),
    ].filter((line): line is string => Boolean(line));
    const unique = Array.from(new Set(meaningful));
    return (unique.length ? unique : lines.slice(0, 3)).join(" ");
  };
  const workerExitedError = (code: number | null, signal: NodeJS.Signals | null): Error => {
    const exitStatus = code ?? signal ?? "unknown";
    const detail = summarizeStderr();
    return new Error(detail
      ? `Cursor SDK worker exited (${exitStatus}). ${detail}`
      : `Cursor SDK worker exited (${exitStatus}).`);
  };
  const sendWorkerMessage = (
    message: CursorSdkWorkerRequest,
    onError?: (error: Error) => void,
  ): boolean => {
    if (child.exitCode != null || child.killed || child.connected === false) {
      onError?.(workerIpcClosedError());
      return false;
    }
    try {
      child.send(message, (error) => {
        if (error) onError?.(normalizeIpcSendError(error));
      });
      return true;
    } catch (error) {
      onError?.(normalizeIpcSendError(error));
      return false;
    }
  };
  const rejectPending = (error: Error) => {
    for (const [, waiter] of pending) waiter.reject(error);
    pending.clear();
  };
  const cleanupPoolEntry = (pooledRef: CursorSdkPooled) => {
    for (const [poolKey, entry] of pools) {
      if (entry.pooled === pooledRef) {
        pools.delete(poolKey);
        cleanupCursorSdkRuntimePaths(entry);
      }
    }
  };

  child.stdout?.on("data", (chunk) => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    if (text.trim()) args.logger?.debug("agent_chat.cursor_sdk_worker_stdout", { text: text.trim() });
  });
  child.stderr?.on("data", (chunk) => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    rememberStderr(text);
    if (text.trim()) args.logger?.warn("agent_chat.cursor_sdk_worker_stderr", { text: text.trim() });
  });

  const pooled: CursorSdkPooled = {
    process: child,
    bridge,
    agentId: null,
    runId: null,
    request: <T = unknown>(type: CursorSdkWorkerRequest["type"], payload?: unknown) => {
      const requestId = randomUUID();
      return new Promise<T>((resolve, reject) => {
        pending.set(requestId, {
          resolve: (value) => resolve(value as T),
          reject,
          type,
        });
        const sent = sendWorkerMessage({ type, requestId, payload } as CursorSdkWorkerRequest, (error) => {
          const waiter = pending.get(requestId);
          if (!waiter) return;
          pending.delete(requestId);
          waiter.reject(error);
        });
        if (!sent) {
          if (pending.delete(requestId)) {
            reject(workerIpcClosedError());
          }
        }
      });
    },
    sendPrompt: (payload) => pooled.request("send", payload),
    updatePolicy: (policy) => pooled.request("policy_update", policy),
    cancel: () => pooled.request("cancel"),
    dispose: () => {
      for (const [, waiter] of pending) waiter.reject(new Error("Cursor SDK worker disposed."));
      pending.clear();
      // Windows has no graceful SIGTERM: `child.kill()` is TerminateProcess, so
      // the worker's own signal handler never runs and the tools the SDK
      // spawned (shell commands, the bundled ripgrep) are left behind. The IPC
      // `dispose` request is therefore the only orderly shutdown path here, and
      // the escalation must kill the whole tree rather than a single pid.
      const escalate = (): void => {
        if (child.exitCode != null || child.killed) return;
        killTimer = terminateChildProcessTree(child, killTimer, CURSOR_SDK_KILL_ESCALATION_MS);
      };
      const sent = sendWorkerMessage({ type: "dispose", requestId: randomUUID() } as CursorSdkWorkerRequest);
      if (!sent) {
        escalate();
        return;
      }
      disposeTimer = setTimeout(escalate, CURSOR_SDK_DISPOSE_GRACE_MS);
      disposeTimer.unref();
    },
    waitForExit: () => exitPromise,
  };

  child.on("message", (raw: unknown) => {
    const message = raw as CursorSdkWorkerResponse;
    if (!message || typeof message !== "object" || !("type" in message)) return;
    if (message.type === "response") {
      const waiter = pending.get(message.requestId);
      if (!waiter) return;
      pending.delete(message.requestId);
      if (message.ok) waiter.resolve(message.result);
      else {
        const error = new Error(`Cursor SDK ${waiter.type} failed: ${message.error || "unknown error"}`) as Error & {
          code?: string;
          status?: number;
          isRetryable?: boolean;
          requestId?: string;
          operation?: string;
          endpoint?: string;
          cursorSdk?: CursorSdkErrorDetail;
        };
        if (message.errorCode) error.code = message.errorCode;
        if (message.errorDetail) {
          error.cursorSdk = message.errorDetail;
          if (message.errorDetail.code && !error.code) error.code = message.errorDetail.code;
          if (message.errorDetail.status != null) error.status = message.errorDetail.status;
          if (message.errorDetail.isRetryable != null) error.isRetryable = message.errorDetail.isRetryable;
          if (message.errorDetail.requestId) error.requestId = message.errorDetail.requestId;
          if (message.errorDetail.operation) error.operation = message.errorDetail.operation;
          if (message.errorDetail.endpoint) error.endpoint = message.errorDetail.endpoint;
        }
        waiter.reject(error);
      }
      return;
    }
    if (message.type === "ready") {
      pooled.agentId = message.agentId;
      return;
    }
    if (message.type === "run_started") {
      const runtime: CursorSdkRuntime = message.runtime ?? "local";
      if (runtime === "local") {
        pooled.agentId = message.agentId;
        pooled.runId = message.runId;
      }
      bridge.onRunStarted?.(
        {
          agentId: message.agentId,
          runId: message.runId,
          modelSdkId: message.modelSdkId,
          ...(message.modelParams?.length ? { modelParams: message.modelParams } : {}),
        },
        {
          runtime,
          runId: message.runId,
          agentId: message.agentId,
          requestId: message.requestId,
          sdkRequestId: message.sdkRequestId,
        },
      );
      return;
    }
    if (message.type === "sdk_event") {
      const runtime: CursorSdkRuntime = message.runtime ?? "local";
      bridge.onEvent?.(message.event, {
        runtime,
        runId: message.runId,
        agentId: message.agentId,
        requestId: message.requestId,
        sdkRequestId: message.sdkRequestId,
        ...(message.errorDetail ? { errorDetail: message.errorDetail } : {}),
      });
      return;
    }
    if (message.type === "run_result") {
      const runtime: CursorSdkRuntime = message.runtime ?? "local";
      bridge.onRunResult?.(message.result, {
        runtime,
        runId: message.runId,
        agentId: message.agentId,
        requestId: message.requestId,
        sdkRequestId: message.sdkRequestId,
        ...(message.errorCode ? { errorCode: message.errorCode } : {}),
        ...(message.errorDetail ? { errorDetail: message.errorDetail } : {}),
      });
      return;
    }
    if (message.type === "run_status") {
      bridge.onRunStatus?.(
        { agentId: message.agentId, runId: message.runId, status: message.status },
        {
          runtime: message.runtime,
          runId: message.runId,
          agentId: message.agentId,
          requestId: message.requestId,
          sdkRequestId: message.sdkRequestId,
        },
      );
      return;
    }
    if (message.type === "hook_request") {
      void (async () => {
        let decision;
        try {
          decision = bridge.onHookRequest
            ? await bridge.onHookRequest(message.request)
            : {
              permission: "deny" as const,
              user_message: "ADE is not ready to approve Cursor tool calls.",
              agent_message: "ADE is not ready to approve Cursor tool calls.",
            };
        } catch (err) {
          args.logger?.error?.("agent_chat.cursor_sdk_hook_error", {
            error: err instanceof Error ? err.message : String(err),
          });
          decision = {
            permission: "deny" as const,
            user_message: "Hook evaluation failed.",
            agent_message: "Hook evaluation failed due to an internal error.",
          };
        }
        sendWorkerMessage({
          type: "hook_response",
          requestId: message.requestId,
          payload: decision,
        } as CursorSdkWorkerRequest, (error) => {
          args.logger?.warn?.("agent_chat.cursor_sdk_hook_response_failed", {
            error: error.message,
          });
        });
      })();
      return;
    }
    if (message.type === "log") {
      const level = message.level === "error" ? "warn" : message.level;
      args.logger?.[level]?.("agent_chat.cursor_sdk_worker_log", {
        message: message.message,
        detail: message.detail,
      });
    }
  });

  child.on("error", (error) => {
    rejectPending(normalizeIpcSendError(error));
    if (child.pid == null) {
      cleanupPoolEntry(pooled);
      settleExit();
      return;
    }
    // A live worker with a broken IPC channel is still holding state/index.db.
    // Evict through dispose so the next acquire waits for a real `exit`.
    for (const [poolKey, entry] of pools) {
      if (entry.pooled === pooled) {
        disposeCursorSdkPoolEntry(poolKey, entry);
        return;
      }
    }
  });

  child.on("exit", (code, signal) => {
    // Never let an escalation fire after the worker is gone: on Windows that
    // would run `taskkill /T /F` against a recycled pid.
    if (disposeTimer) clearTimeout(disposeTimer);
    if (killTimer) clearTimeout(killTimer);
    disposeTimer = null;
    killTimer = null;
    rejectPending(workerExitedError(code, signal));
    settleExit();
    cleanupPoolEntry(pooled);
  });

  const initPayload: CursorSdkWorkerInit = {
    sessionId: args.sessionId,
    laneRoot: args.workspacePath,
    userHomeDir: paths.userHomeDir,
    stateRoot: paths.stateRoot,
    socketPath: paths.socketPath,
    modelSdkId: args.modelSdkId,
    ...(args.modelParams?.length ? { modelParams: args.modelParams } : {}),
    apiKey: args.apiKey ?? null,
    agentId: args.agentId ?? null,
    agentName: args.agentName ?? null,
    policy: args.policy,
    ...(args.mcpServers ? { mcpServers: args.mcpServers } : {}),
  };
  let result: { agentId: string };
  try {
    result = await pooled.request<{ agentId: string }>("init", initPayload);
  } catch (error) {
    // If init fails, the worker child is still alive — dispose it so we don't
    // leak a fork()'d process per failed connection attempt.
    pooled.dispose();
    await Promise.race([
      pooled.waitForExit(),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, CURSOR_SDK_REPLACE_WAIT_MS);
        timer.unref();
      }),
    ]).catch(() => {});
    // Unconditional: the callee decides what a failed init may reclaim. The
    // durable state is still gated on `cleanupStateRoot`, but this worker's
    // instance socket directory is dead either way, and skipping the call
    // entirely leaked one directory per failed init.
    cleanupCursorSdkRuntimePaths({
      cacheRoot: paths.cacheRoot,
      stateRoot: paths.stateRoot,
      socketPath: paths.socketPath,
      cleanupStateRoot: args.cleanupStateRoot === true,
    });
    throw error;
  }
  pooled.agentId = result.agentId;
  const generation = ++cursorSdkGenCounter;
  pools.set(args.poolKey, {
    ref: 1,
    generation,
    pooled,
    cacheRoot: paths.cacheRoot,
    stateRoot: paths.stateRoot,
    socketPath: paths.socketPath,
    cleanupStateRoot: args.cleanupStateRoot === true,
    idleTimer: null,
  });
  return pooled;
}

// Cleanup runs as soon as the connection is released, but `dispose()` only
// asks the worker to shut down — it is still alive, and on Windows a directory
// cannot be removed while a process holds handles inside it (the SDK's local
// platform keeps `state/index.db` and its -wal/-shm open). POSIX unlinks open
// files happily, so the first attempt always wins there. Retry in the
// background until the worker has actually exited, otherwise every one-shot
// catalog/cloud request leaks a `state/` directory into the project's
// `.ade/cache/cursor-sdk`.
const CURSOR_SDK_CLEANUP_RETRY_LIMIT = 40;
const CURSOR_SDK_CLEANUP_RETRY_DELAY_MS = 250;

function removeCursorSdkRuntimePath(target: string, attempt = 0): void {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    if (attempt >= CURSOR_SDK_CLEANUP_RETRY_LIMIT) return;
    setTimeout(
      () => removeCursorSdkRuntimePath(target, attempt + 1),
      CURSOR_SDK_CLEANUP_RETRY_DELAY_MS,
    ).unref();
  }
}

export function cleanupCursorSdkRuntimePaths(entry: {
  cacheRoot?: string;
  stateRoot: string;
  socketPath?: string;
  cleanupStateRoot: boolean;
}): void {
  const targets = new Set<string>();
  // The per-instance socket directory (`.../ade-cursor-sdk-<uid>/<instance>/hook.sock`)
  // dies with its worker no matter what happens to the durable state: the next
  // worker derives a fresh instance directory, so nothing can ever bind here
  // again. `cleanupStateRoot` is false for every ordinary chat pool — gating the
  // socket directory on it leaked one empty directory per worker into the
  // tmpdir for the life of the machine.
  //
  // Do not walk up to the per-user root — a replacement worker may already be
  // listening in a sibling directory there.
  if (process.platform !== "win32" && entry.socketPath) {
    targets.add(path.dirname(entry.socketPath));
  }
  // The durable Cursor state is the opposite: it has to survive a recycle, so
  // only an explicit teardown removes it.
  if (entry.cleanupStateRoot) {
    targets.add(entry.cacheRoot ?? entry.stateRoot);
  }
  for (const target of targets) {
    removeCursorSdkRuntimePath(target);
  }
}

/** Look up a pool entry, honouring an optional generation guard. */
function findCursorSdkPoolEntry(poolKey: string, generation?: number): CursorSdkPoolEntry | null {
  const entry = pools.get(poolKey);
  if (!entry) return null;
  if (generation !== undefined && entry.generation !== generation) return null;
  return entry;
}

function clearCursorSdkIdleTimer(entry: CursorSdkPoolEntry): void {
  if (!entry.idleTimer) return;
  clearTimeout(entry.idleTimer);
  entry.idleTimer = null;
}

/** Evict an entry from the map and tear its worker + runtime paths down. */
function disposeCursorSdkPoolEntry(poolKey: string, entry: CursorSdkPoolEntry): void {
  clearCursorSdkIdleTimer(entry);
  pools.delete(poolKey);
  // The one-shot LRU stamp lives exactly as long as the entry it ranks. A
  // delete of an absent key is free, so this needs no prefix guard.
  localOneShotLastUsedAt.delete(poolKey);
  trackDepartingCursorSdkWorker(poolKey, entry.pooled.waitForExit());
  entry.pooled.dispose();
  cleanupCursorSdkRuntimePaths(entry);
}

function trackDepartingCursorSdkWorker(poolKey: string, wait: Promise<void>): void {
  const tracked = wait.finally(() => {
    if (departingWorkers.get(poolKey) === tracked) departingWorkers.delete(poolKey);
  });
  departingWorkers.set(poolKey, tracked);
}

async function waitForDepartingCursorSdkWorker(poolKey: string): Promise<void> {
  const prior = departingWorkers.get(poolKey);
  if (!prior) return;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const outcome = await Promise.race([
    prior.then(() => "exited" as const),
    new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), CURSOR_SDK_REPLACE_WAIT_MS);
      timer.unref();
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (outcome === "timeout") {
    throw new Error("Cursor SDK worker did not exit before replacement.");
  }
}

/**
 * Force-dispose a pooled worker regardless of its refcount, so the next
 * `acquireCursorSdkConnection` for this key forks a brand-new one.
 *
 * `isCursorSdkPooledAlive` only checks process liveness, which is not the same
 * as connection health: a run that dies with a transport error (NGHTTP2 reset,
 * `[internal] write ECANCELED`) leaves the worker process happily alive while
 * the server-side Cursor agent thread is wedged — every subsequent send then
 * hangs forever with zero stream events. Reference counting cannot express
 * that. Pool keys embed the session id, so the outstanding lease that a
 * refcount decrement would preserve belongs to the *same* session acquiring
 * twice, not to another chat. Callers therefore evict the entry outright.
 *
 * Returns true when an entry was actually disposed.
 */
export function poisonCursorSdkConnection(poolKey: string, generation?: number): boolean {
  const entry = findCursorSdkPoolEntry(poolKey, generation);
  if (!entry) return false;
  disposeCursorSdkPoolEntry(poolKey, entry);
  return true;
}

export function releaseCursorSdkConnection(poolKey: string, generation?: number): void {
  const entry = findCursorSdkPoolEntry(poolKey, generation);
  if (!entry) return;
  entry.ref -= 1;
  if (entry.ref < 0) entry.ref = 0;
  if (entry.ref <= 0) disposeCursorSdkPoolEntry(poolKey, entry);
}

export function releaseCursorSdkConnectionAfterIdle(
  poolKey: string,
  generation: number,
  idleMs: number,
): void {
  const entry = findCursorSdkPoolEntry(poolKey, generation);
  if (!entry) return;
  entry.ref -= 1;
  if (entry.ref < 0) entry.ref = 0;
  if (entry.ref > 0) return;
  clearCursorSdkIdleTimer(entry);
  entry.idleTimer = setTimeout(() => {
    const current = findCursorSdkPoolEntry(poolKey, generation);
    if (!current || current.ref > 0) return;
    disposeCursorSdkPoolEntry(poolKey, current);
  }, idleMs);
  (entry.idleTimer as { unref?: () => void }).unref?.();
}

export async function runCursorSdkCatalogRequest<T = unknown>(
  args: {
    projectRoot: string;
    workspacePath: string;
    apiKey?: string | null;
    type: "catalog.models" | "catalog.repositories";
    logger?: Logger;
  },
): Promise<T> {
  const poolKey = `catalog:${args.type}:${args.workspacePath}:${Date.now()}:${Math.random()}`;
  const { pooled, generation } = await acquireCursorSdkConnection({
    poolKey,
    projectRoot: args.projectRoot,
    workspacePath: args.workspacePath,
    modelSdkId: "default",
    apiKey: args.apiKey,
    sessionId: "catalog",
    cleanupStateRoot: true,
    policy: {
      chatMode: "agent",
      approvalPolicy: "never",
      sandbox: "off",
      fullAuto: true,
      hardGuards: false,
      orchestrationLead: false,
      autoReview: false,
    },
    logger: args.logger,
  });
  try {
    return await pooled.request<T>(args.type, { apiKey: args.apiKey ?? null });
  } finally {
    releaseCursorSdkConnection(poolKey, generation);
  }
}

type CursorSdkCloudOneShotType = Extract<
  CursorSdkWorkerRequest,
  {
    type:
      | "cloud.agent.get"
      | "cloud.agents.list"
      | "cloud.runs.list"
      | "cloud.run.get"
      | "cloud.run.cancel"
      | "cloud.run.conversation"
      | "cloud.artifacts.list"
      | "cloud.artifacts.download"
      | "agent.getUsage";
  }
>["type"];

/** How long a one-shot worker (cloud request or local prompt) stays warm. */
export const CURSOR_SDK_ONESHOT_IDLE_MS = 60_000;

export async function runCursorSdkCloudRequest<T = unknown>(
  args: {
    projectRoot: string;
    workspacePath: string;
    apiKey?: string | null;
    type: CursorSdkCloudOneShotType;
    payload: Record<string, unknown>;
    logger?: Logger;
  },
): Promise<T> {
  // One worker per workspace, kept warm for a short idle window so list +
  // conversation + watched polls reuse it instead of forking Node (and a
  // throwaway state dir) on every tick.
  const poolKey = `cloud-oneshot:${args.workspacePath}`;
  const { pooled, generation } = await acquireCursorSdkConnection({
    poolKey,
    projectRoot: args.projectRoot,
    workspacePath: args.workspacePath,
    modelSdkId: "default",
    apiKey: args.apiKey,
    sessionId: "cloud-oneshot",
    cleanupStateRoot: true,
    policy: {
      chatMode: "agent",
      approvalPolicy: "never",
      sandbox: "off",
      fullAuto: true,
      hardGuards: false,
      orchestrationLead: false,
      autoReview: false,
    },
    logger: args.logger,
  });
  try {
    return await pooled.request<T>(args.type, { apiKey: args.apiKey ?? null, ...args.payload });
  } finally {
    releaseCursorSdkConnectionAfterIdle(poolKey, generation, CURSOR_SDK_ONESHOT_IDLE_MS);
  }
}

/**
 * The SDK agent name every local one-shot worker is created with.
 *
 * Fixed rather than per-feature: one warm worker serves every feature that runs
 * a one-shot on a workspace, and a pooled worker keeps the name it was created
 * with.
 */
export const CURSOR_SDK_ONESHOT_AGENT_NAME = "ADE one-shot";

/** Pool-key prefix for the warm workers that run ADE's one-off local prompts. */
const CURSOR_SDK_LOCAL_ONESHOT_PREFIX = "local-oneshot:";

/**
 * How many warm one-shot workers this process keeps at once.
 *
 * Each one is a forked Node process holding a Cursor SDK agent, kept alive for
 * `CURSOR_SDK_ONESHOT_IDLE_MS` after its last prompt. One worker per lane
 * worktree with no cap meant ten active lanes naming their chats forked ten
 * processes at once, so the set is bounded and the idle least-recently-used
 * worker is released to make room. A busy worker is never evicted.
 */
export const CURSOR_SDK_LOCAL_ONESHOT_MAX_WORKERS = 2;

/** Last acquire/release time per one-shot pool key, for the LRU choice above. */
const localOneShotLastUsedAt = new Map<string, number>();

/**
 * The pool key for a local one-shot worker.
 *
 * `pathKey` folds the case of the workspace path, so two spellings of one
 * Windows worktree share a worker instead of forking two. The API key is
 * hashed into the key because a warm worker keeps the key it was created with:
 * a rotated key has to fork a fresh worker rather than keep authenticating
 * with the old one.
 */
function cursorSdkLocalOneShotPoolKey(workspacePath: string, apiKey?: string | null): string {
  return `${CURSOR_SDK_LOCAL_ONESHOT_PREFIX}${pathKey(workspacePath)}:${hashKey(apiKey?.trim() || "").slice(0, 8)}`;
}

function touchLocalOneShotPoolKey(poolKey: string): void {
  if (!poolKey.startsWith(CURSOR_SDK_LOCAL_ONESHOT_PREFIX)) return;
  localOneShotLastUsedAt.set(poolKey, Date.now());
}

/**
 * Release idle one-shot workers until `poolKey` can be added under the cap.
 *
 * Best-effort, like every other budget in the app: when every other worker is
 * busy this yields rather than tearing down a live run.
 */
function enforceLocalOneShotWorkerBudget(poolKey: string): void {
  if (pools.has(poolKey)) return;
  for (;;) {
    const candidates = [...pools.entries()].filter(([key]) => (
      key !== poolKey && key.startsWith(CURSOR_SDK_LOCAL_ONESHOT_PREFIX)
    ));
    if (candidates.length < CURSOR_SDK_LOCAL_ONESHOT_MAX_WORKERS) return;
    let lruKey: string | null = null;
    let lruEntry: CursorSdkPoolEntry | null = null;
    let lruAt = Number.POSITIVE_INFINITY;
    for (const [key, entry] of candidates) {
      if (entry.ref > 0) continue;
      const at = localOneShotLastUsedAt.get(key) ?? 0;
      if (at >= lruAt) continue;
      lruKey = key;
      lruEntry = entry;
      lruAt = at;
    }
    if (!lruKey || !lruEntry) return;
    disposeCursorSdkPoolEntry(lruKey, lruEntry);
  }
}

/**
 * Serializes the one-shot local prompts that share a pool key.
 *
 * A worker holds exactly one `currentRun`, and a `resetConversation` send
 * replaces the agent underneath it, so two overlapping one-shots on the same
 * workspace would cancel and mis-attribute each other's run. Chat never queues
 * here: its pool keys carry the session id and it owns its worker outright.
 */
const cursorSdkLocalPromptQueues = new Map<string, Promise<unknown>>();

function runCursorSdkLocalPromptQueued<T>(poolKey: string, run: () => Promise<T>): Promise<T> {
  const prior = cursorSdkLocalPromptQueues.get(poolKey) ?? Promise.resolve();
  const next = prior.then(run, run);
  const tracked: Promise<unknown> = next.catch(() => undefined).finally(() => {
    if (cursorSdkLocalPromptQueues.get(poolKey) === tracked) {
      cursorSdkLocalPromptQueues.delete(poolKey);
    }
  });
  cursorSdkLocalPromptQueues.set(poolKey, tracked);
  return next;
}

export type CursorSdkLocalPromptResult = {
  text: string;
  agentId: string | null;
};

function readCursorSdkRunStatus(
  result: unknown,
): { status: string; text: string; errorMessage: string } {
  const record = result && typeof result === "object" ? result as Record<string, unknown> : {};
  const status = typeof record.status === "string" ? record.status : "";
  const text = typeof record.result === "string" ? record.result.trim() : "";
  // `RunResult.error` carries the terminal failure detail while `result` keeps
  // whatever partial text the model produced, so an error must be reported from
  // `error.message` rather than from the partial answer.
  const errorRecord = record.error && typeof record.error === "object"
    ? record.error as Record<string, unknown>
    : null;
  const errorMessage = typeof errorRecord?.message === "string" ? errorRecord.message.trim() : "";
  return { status, text, errorMessage };
}

/**
 * Run one self-contained local prompt on a pooled Cursor SDK worker.
 *
 * This is the only Cursor path for ADE's one-off model calls — titles, status
 * lines, lane names, summaries, commit messages, PR descriptions. It exists so
 * those calls get what chat already gets: a forked worker rather than the SDK
 * inside the host process, the sandbox-unsupported fallback, agent retries,
 * trimmed setting sources, a throwaway state root, and an agent that is closed
 * instead of leaked.
 *
 * The worker stays warm for a short idle window, so a naming chain of three
 * candidate models forks Node once. Each prompt still starts a fresh agent, so
 * no one-shot ever sees another one-shot's conversation.
 *
 * Every one-shot runs under `CURSOR_SDK_ONESHOT_POLICY` and answers as
 * `CURSOR_SDK_ONESHOT_AGENT_NAME`. Both are fixed because the worker is shared:
 * a pooled worker keeps the policy and the name it was created with, so neither
 * can be a per-call argument.
 */
export async function runCursorSdkLocalPrompt(args: {
  projectRoot: string;
  workspacePath: string;
  apiKey?: string | null;
  modelSdkId: string;
  modelParams?: CursorSdkModelParameterValue[];
  promptText: string;
  feature: string;
  timeoutMs: number;
  logger?: Logger;
}): Promise<CursorSdkLocalPromptResult> {
  // One worker per workspace and API key. The model rides on the send rather
  // than the pool key, because the worker applies
  // `CursorSdkSendPrompt.modelSdkId` to the run it starts — the same mechanism
  // a chat model switch uses.
  const poolKey = cursorSdkLocalOneShotPoolKey(args.workspacePath, args.apiKey);
  return await runCursorSdkLocalPromptQueued(poolKey, async () => {
    enforceLocalOneShotWorkerBudget(poolKey);
    const { pooled, generation } = await acquireCursorSdkConnection({
      poolKey,
      projectRoot: args.projectRoot,
      workspacePath: args.workspacePath,
      modelSdkId: args.modelSdkId,
      ...(args.modelParams?.length ? { modelParams: args.modelParams } : {}),
      apiKey: args.apiKey,
      // A fixed name, because the warm worker is shared by every feature that
      // runs a one-shot on this workspace.
      agentName: CURSOR_SDK_ONESHOT_AGENT_NAME,
      sessionId: `oneshot:${args.feature}`,
      cleanupStateRoot: true,
      policy: CURSOR_SDK_ONESHOT_POLICY,
      logger: args.logger,
    });
    // A one-shot answers from its prompt: ADE hands the model every excerpt it
    // needs. Deny tool calls with a reason the model can act on, rather than
    // leaving the bridge unset and returning the pool's "ADE is not ready"
    // default, which reads as a transient fault the model may retry.
    pooled.bridge.onHookRequest = async () => ({
      permission: "deny" as const,
      user_message: "ADE one-shot tasks do not run tools.",
      agent_message: "Tools are unavailable for this task. Answer from the prompt text alone.",
    });
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    /** Set by both failure causes below; the teardown reads it once. */
    let discardWorker = false;
    try {
      const sendPromise = pooled.sendPrompt({
        promptText: args.promptText,
        modelSdkId: args.modelSdkId,
        ...(args.modelParams?.length ? { modelParams: args.modelParams } : {}),
        resetConversation: true,
      });
      // The timeout wins the race and the send keeps running until the cancel
      // or the dispose lands. Claim its eventual rejection now, or it surfaces
      // as an unhandled rejection after this function has already returned.
      sendPromise.catch(() => undefined);
      let raw: unknown;
      try {
        raw = await Promise.race([
          sendPromise,
          new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(() => {
              discardWorker = true;
              pooled.cancel().catch(() => {});
              reject(new Error(`Cursor SDK task timed out after ${args.timeoutMs}ms.`));
            }, args.timeoutMs);
          }),
        ]);
      } catch (error) {
        // The send itself rejected rather than returning a run result. That is
        // the worker reporting its own fault — a failed agent reset, a closed
        // IPC channel — and the process stays alive through all of them, so the
        // pool's liveness check would keep handing the same broken worker out.
        discardWorker = true;
        throw error;
      }
      const { status, text, errorMessage } = readCursorSdkRunStatus(raw);
      if (status === "error") {
        throw new Error(errorMessage || text || "Cursor SDK task failed.");
      }
      if (status === "cancelled") {
        throw new Error("Cursor SDK task was cancelled.");
      }
      return { text, agentId: pooled.agentId };
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      pooled.bridge.onHookRequest = null;
      if (discardWorker) {
        // Timed out: the run is still streaming inside a worker that already
        // missed its deadline, and reusing it would hand the next one-shot a
        // worker mid-cancel. Rejected: the worker reported a fault of its own.
        // Either way the next one-shot has to fork a fresh worker.
        poisonCursorSdkConnection(poolKey, generation);
      } else {
        touchLocalOneShotPoolKey(poolKey);
        releaseCursorSdkConnectionAfterIdle(poolKey, generation, CURSOR_SDK_ONESHOT_IDLE_MS);
      }
    }
  });
}
