import { randomBytes } from "node:crypto";
import { spawn as nodeSpawn, spawnSync as nodeSpawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { createServer } from "node:net";
import path from "node:path";

import {
  killWindowsProcessTree,
  resolveCliSpawnInvocation,
  terminateProcessTree,
} from "../../../../desktop/src/main/services/shared/processExecution";
import { resolveMachineAdeLayout } from "../projects/machineLayout";
import {
  ensurePrivateDirectory,
  securePrivatePath,
  writePrivateFile,
  type PrivateFileSecurityOptions,
  type WindowsAclRunner,
} from "../../lib/trustedWindowsTools";
import {
  CLI_PROXY_API_RELEASE,
  resolvePlatformKey,
  type CliProxyApiRelease,
  type CliProxyApiPlatformKey,
  type CliProxyApiReleaseAsset,
} from "./cliProxyApiRelease";
import {
  configSummary,
  createCliProxyApiConfig,
  pathsFor,
  readCliProxyApiConfig,
  readCliProxyApiState,
  writeCliProxyApiConfig,
  writeCliProxyApiState,
  type CliProxyApiConfig,
  type CliProxyApiConfigSummary,
  type CliProxyApiState,
  type CliProxyApiSupervisorPaths,
} from "./cliProxyApiConfig";
import {
  defaultExtractArchive,
  installAsset,
  type CliProxyApiArchiveExtractor,
  type CliProxyApiSpawn,
} from "./cliProxyApiInstall";

const PROXY_HOST = "127.0.0.1" as const;
const HEALTH_PATH = "/healthz";
const DEFAULT_HEALTH_TIMEOUT_MS = 15_000;
const DEFAULT_HEALTH_REQUEST_TIMEOUT_MS = 1_000;
const DEFAULT_HEALTH_RETRY_DELAY_MS = 100;
const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 15_000;
export const PROXY_HEALTH_MAX_AGE_MS = 60_000;
const MAX_RESTART_BACKOFF_MS = 5_000;
const ADOPTED_PROCESS_STOP_TIMEOUT_MS = 2_000;

export type CliProxyApiSupervisorStatus = {
  installed: boolean;
  running: boolean;
  pid: number | null;
  port: number | null;
  apiKey: string | null;
  managementKey: string | null;
  version: string;
  platformKey: CliProxyApiPlatformKey;
  binaryPath: string;
  configPath: string;
  statePath: string;
};

export type CliProxyApiSupervisorOptions = {
  adeHome?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  release?: CliProxyApiRelease;
  fetchImpl?: typeof fetch;
  spawnImpl?: CliProxyApiSpawn;
  extractArchive?: CliProxyApiArchiveExtractor;
  healthTimeoutMs?: number;
  healthRequestTimeoutMs?: number;
  healthRetryDelayMs?: number;
  healthCheckIntervalMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  aclRunner?: WindowsAclRunner;
  currentUser?: string;
  isLivePid?: (pid: unknown) => boolean;
  processKill?: (pid: number, signal: NodeJS.Signals | 0) => void;
  killProcessTree?: (pid: number) => boolean;
  healthProbe?: (port: number) => boolean;
};

/**
 * CLIProxyAPI rewrites `remote-management.secret-key` in its own config file on
 * startup: its shipped `config.example.yaml` documents "If a plaintext value is
 * provided here, it will be hashed on startup". Re-reading the file after the
 * process is up therefore hands back a bcrypt digest, and sending that as the
 * management bearer token is rejected with HTTP 401 — which killed every
 * management call, including the `listAuthFiles` that `proxy start` reports
 * through. The digest is recognisable, so it is never mistaken for a key.
 */
export function isHashedManagementKey(value: string): boolean {
  return /^\$2[aby]?\$\d{2}\$/.test(value);
}

function readPersistedManagementKey(filePath: string): string | null {
  try {
    const value = fs.readFileSync(filePath, "utf8").trim();
    return /^[0-9a-f]{64}$/iu.test(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Is a pid still a process on this machine?
 *
 * `EPERM` counts as alive: the pid exists, this process just may not signal it.
 */
export function isLiveProxyPid(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The default bound on a synchronous health probe. Blocking, so: short. */
const PROXY_HEALTH_PROBE_TIMEOUT_MS = 1_500;

/**
 * Ask a loopback proxy whether it is healthy, synchronously.
 *
 * WHY synchronous, and why a child process: the launch resolver that needs this
 * answer (`harnessPresetProxyConnection`) is called from synchronous plan
 * building on five launch paths, and making it async would thread a promise
 * through every one of them for a probe that runs only when the persisted
 * health stamp has aged out. Node has no synchronous HTTP client, so the probe
 * runs in a short-lived Node child whose exit code carries the answer;
 * `ELECTRON_RUN_AS_NODE` makes that work when `process.execPath` is Electron.
 * The `timeout` bounds the whole thing, so a hung proxy costs one wait, once.
 */
export function probeProxyHealthSync(
  port: number,
  timeoutMs: number = PROXY_HEALTH_PROBE_TIMEOUT_MS,
): boolean {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return false;
  const script = [
    "const http = require('node:http');",
    `const req = http.request({ host: ${JSON.stringify(PROXY_HOST)}, port: ${port},`,
    ` path: ${JSON.stringify(HEALTH_PATH)}, method: 'GET', timeout: ${Math.max(1, timeoutMs)} },`,
    " (res) => { res.resume(); process.exit(res.statusCode >= 200 && res.statusCode < 300 ? 0 : 1); });",
    "req.on('error', () => process.exit(1));",
    "req.on('timeout', () => { req.destroy(); process.exit(1); });",
    "req.end();",
  ].join("");
  try {
    const result = nodeSpawnSync(process.execPath, ["-e", script], {
      timeout: Math.max(1, timeoutMs),
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
    return !result.error && result.status === 0;
  } catch {
    return false;
  }
}

function findFreeLoopbackPort(): Promise<number> {
  const server = createServer();
  return new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: PROXY_HOST, port: 0 }, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Could not determine the free CLIProxyAPI port"));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

/**
 * Return an auth directory only when it is a strict child of the supervisor's
 * private proxy directory. Values read from config.yaml are untrusted input:
 * the caller must never create or ACL a path outside the ADE-owned tree.
 */
export function ownedAuthDir(
  candidate: unknown,
  proxyDir: string,
  fallbackAuthDir = path.join(proxyDir, "auth"),
): string {
  const requested = typeof candidate === "string" ? candidate.trim() : "";
  if (!requested) return fallbackAuthDir;
  const root = path.resolve(proxyDir);
  const resolved = path.resolve(requested);
  const relative = path.relative(root, resolved);
  const outside = relative === ""
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative);
  return outside ? fallbackAuthDir : resolved;
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForHealth(args: {
  port: number;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  requestTimeoutMs: number;
  retryDelayMs: number;
  sleep: (milliseconds: number) => Promise<void>;
}): Promise<void> {
  const deadline = Date.now() + args.timeoutMs;
  let lastFailure = "no response";
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`CLIProxyAPI health check timed out: ${lastFailure}`);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.min(args.requestTimeoutMs, remaining));
    try {
      const response = await args.fetchImpl(`http://${PROXY_HOST}:${args.port}${HEALTH_PATH}`, {
        method: "GET",
        signal: controller.signal,
      });
      if (response.ok) return;
      lastFailure = `HTTP ${response.status}`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(timeout);
    }
    const delay = Math.min(args.retryDelayMs, Math.max(0, deadline - Date.now()));
    if (delay > 0) await args.sleep(delay);
  }
}

function isLiveChild(child: ChildProcess | null): child is ChildProcess {
  return child !== null
    && (child.exitCode === null || child.exitCode === undefined)
    && (child.signalCode === null || child.signalCode === undefined);
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (!isLiveChild(child)) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(finish, timeoutMs);
    child.once("close", finish);
    child.once("error", finish);
  });
}

async function waitForProcessExit(
  pid: number,
  timeoutMs: number,
  isLivePid: (pid: unknown) => boolean,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isLivePid(pid)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
}

export class CliProxyApiSupervisor {
  private readonly adeHome: string;
  private readonly platform: NodeJS.Platform;
  private readonly release: CliProxyApiRelease;
  private readonly platformKey: CliProxyApiPlatformKey;
  private readonly asset: CliProxyApiReleaseAsset;
  private readonly paths: CliProxyApiSupervisorPaths;
  private readonly fetchImpl: typeof fetch;
  private readonly spawnImpl: CliProxyApiSpawn;
  private readonly extractArchive: CliProxyApiArchiveExtractor;
  private readonly healthTimeoutMs: number;
  private readonly healthRequestTimeoutMs: number;
  private readonly healthRetryDelayMs: number;
  private readonly healthCheckIntervalMs: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly aclRunner?: WindowsAclRunner;
  private readonly currentUser?: string;
  private readonly isLivePid: (pid: unknown) => boolean;
  private readonly processKill: (pid: number, signal: NodeJS.Signals | 0) => void;
  private readonly killProcessTree: (pid: number) => boolean;
  private readonly healthProbe: (port: number) => boolean;
  private child: ChildProcess | null = null;
  /** A healthy proxy that was started by an earlier supervisor instance. */
  private adoptedPid: number | null = null;
  /**
   * The plaintext management key THIS run wrote into the config before the
   * proxy hashed it. It is also mirrored in `<adeHome>/proxy/.management-key`
   * with mode 0600 and the owner-only Windows ACL until stop removes it, so a
   * later supervisor can adopt the still-running proxy and keep managing it.
   */
  private managementKey: string | null = null;
  private startPromise: Promise<void> | null = null;
  private installPromise: Promise<string> | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private healthCheckPromise: Promise<void> | null = null;
  private restartAttempt = 0;
  private stopping = false;
  private readonly expectedTerminations = new WeakSet<ChildProcess>();

  constructor(options: CliProxyApiSupervisorOptions = {}) {
    this.adeHome = path.resolve(options.adeHome ?? resolveMachineAdeLayout().adeDir);
    this.platform = options.platform ?? process.platform;
    this.release = options.release ?? CLI_PROXY_API_RELEASE;
    this.platformKey = resolvePlatformKey(this.platform, options.arch ?? process.arch);
    this.asset = this.release.assets[this.platformKey];
    if (!this.asset) {
      throw new Error(`CLIProxyAPI release ${this.release.version} has no asset for ${this.platformKey}`);
    }
    this.paths = pathsFor(this.adeHome, this.release, this.asset);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.spawnImpl = options.spawnImpl ?? nodeSpawn;
    this.extractArchive = options.extractArchive ?? defaultExtractArchive;
    this.healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
    this.healthRequestTimeoutMs = options.healthRequestTimeoutMs ?? DEFAULT_HEALTH_REQUEST_TIMEOUT_MS;
    this.healthRetryDelayMs = options.healthRetryDelayMs ?? DEFAULT_HEALTH_RETRY_DELAY_MS;
    this.healthCheckIntervalMs = options.healthCheckIntervalMs ?? DEFAULT_HEALTH_CHECK_INTERVAL_MS;
    this.sleep = options.sleep ?? defaultSleep;
    this.aclRunner = options.aclRunner;
    this.currentUser = options.currentUser;
    this.isLivePid = options.isLivePid ?? isLiveProxyPid;
    this.processKill = options.processKill ?? ((pid, signal) => {
      process.kill(pid, signal);
    });
    this.killProcessTree = options.killProcessTree ?? killWindowsProcessTree;
    this.healthProbe = options.healthProbe ?? probeProxyHealthSync;
  }

  private secureDirectory(directoryPath: string): void {
    ensurePrivateDirectory(directoryPath, this.fileSecurity());
  }

  private fileSecurity(): PrivateFileSecurityOptions {
    return {
      platform: this.platform,
      aclRunner: this.aclRunner,
      currentUser: this.currentUser,
    };
  }

  getStatus(): CliProxyApiSupervisorStatus {
    const state = readCliProxyApiState(this.paths.statePath);
    let config: CliProxyApiConfigSummary | null = null;
    if (fs.existsSync(this.paths.configPath)) {
      try {
        config = configSummary(this.paths.configPath);
      } catch {
        config = null;
      }
    }
    const adoptedRunning = this.adoptedPid !== null && this.isLivePid(this.adoptedPid);
    if (!adoptedRunning) this.adoptedPid = null;
    const running = isLiveChild(this.child) || adoptedRunning;
    return {
      installed: fs.existsSync(this.paths.binaryPath),
      running,
      pid: running ? this.child?.pid ?? this.adoptedPid ?? null : null,
      port: state?.port ?? config?.port ?? null,
      apiKey: config?.apiKey ?? null,
      managementKey: this.managementKey
        ?? (config && !isHashedManagementKey(config.managementKey) ? config.managementKey : null),
      version: state?.version ?? this.release.version,
      platformKey: this.platformKey,
      binaryPath: this.paths.binaryPath,
      configPath: this.paths.configPath,
      statePath: this.paths.statePath,
    };
  }

  async ensureInstalled(): Promise<string> {
    if (fs.existsSync(this.paths.binaryPath)) return this.paths.binaryPath;
    if (this.installPromise) return this.installPromise;
    this.installPromise = this.installAsset();
    try {
      return await this.installPromise;
    } finally {
      this.installPromise = null;
    }
  }

  private async installAsset(): Promise<string> {
    return installAsset({
      paths: this.paths,
      asset: this.asset,
      platform: this.platform,
      fetchImpl: this.fetchImpl,
      spawnImpl: this.spawnImpl,
      extractArchive: this.extractArchive,
      secureDirectory: (directoryPath) => this.secureDirectory(directoryPath),
    });
  }

  async ensureRunning(): Promise<CliProxyApiSupervisorStatus> {
    if (isLiveChild(this.child)) return this.getStatus();
    if (this.adoptedPid !== null && this.isLivePid(this.adoptedPid)) return this.getStatus();
    const persisted = readCliProxyApiState(this.paths.statePath);
    const persistedPidIsLive = persisted?.pid !== null
      && persisted?.pid !== undefined
      && this.isLivePid(persisted.pid);
    const persistedHealthIsRecent = persisted?.healthyAt !== null
      && persisted?.healthyAt !== undefined
      && Date.now() >= persisted.healthyAt
      && Date.now() - persisted.healthyAt <= PROXY_HEALTH_MAX_AGE_MS;
    // The health timer belongs to the old supervisor process. If that timer
    // stopped while the proxy stayed alive, a fresh supervisor must verify the
    // loopback endpoint before adopting it; otherwise it can race a live
    // proxy on the persisted port and overwrite its management key.
    const persistedHealthIsLive = persistedPidIsLive
      && !persistedHealthIsRecent
      && this.healthProbe(persisted?.port ?? 0);
    if (persisted && persistedPidIsLive && (persistedHealthIsRecent || persistedHealthIsLive)) {
      this.managementKey = readPersistedManagementKey(this.paths.managementKeyPath);
      this.adoptedPid = persisted.pid;
      if (persistedHealthIsLive) {
        writeCliProxyApiState(this.paths.statePath, {
          ...persisted,
          healthyAt: Date.now(),
        }, this.fileSecurity());
      }
      if (this.restartTimer) {
        clearTimeout(this.restartTimer);
        this.restartTimer = null;
      }
      this.startHealthChecks();
      return this.getStatus();
    }
    if (this.startPromise) {
      await this.startPromise;
      return this.getStatus();
    }
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.stopping = false;
    this.startPromise = this.startProcess();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
    return this.getStatus();
  }

  private async ensureConfig(): Promise<CliProxyApiConfigSummary> {
    this.secureDirectory(this.paths.proxyDir);
    // A fresh plaintext key on every start, because the process about to read
    // this file replaces it with a hash (see `isHashedManagementKey`). The port
    // and the api-key are reused: launched CLIs are pointed at them, so they
    // must survive a restart.
    const managementKey = randomBytes(32).toString("hex");
    if (fs.existsSync(this.paths.configPath)) {
      const existing = configSummary(this.paths.configPath);
      const config: CliProxyApiConfig = {
        ...existing.config,
        "auth-dir": ownedAuthDir(existing.config["auth-dir"], this.paths.proxyDir, this.paths.authDir),
        "remote-management": { "allow-remote": false, "secret-key": managementKey },
      };
      this.secureDirectory(config["auth-dir"]);
      writeCliProxyApiConfig(this.paths.configPath, config, this.fileSecurity());
      writePrivateFile(this.paths.managementKeyPath, managementKey, this.fileSecurity());
      this.managementKey = managementKey;
      return { config, apiKey: existing.apiKey, managementKey, port: existing.port };
    }

    const config = createCliProxyApiConfig({
      port: await findFreeLoopbackPort(),
      apiKey: randomBytes(32).toString("hex"),
      managementKey,
      authDir: this.paths.authDir,
    });
    this.secureDirectory(config["auth-dir"]);
    writeCliProxyApiConfig(this.paths.configPath, config, this.fileSecurity());
    writePrivateFile(this.paths.managementKeyPath, managementKey, this.fileSecurity());
    this.managementKey = managementKey;
    return { config, apiKey: config["api-keys"][0]!, managementKey, port: config.port };
  }

  private async startProcess(): Promise<void> {
    const binaryPath = await this.ensureInstalled();
    const summary = await this.ensureConfig();
    const invocation = resolveCliSpawnInvocation(binaryPath, [], process.env, this.platform);
    let child: ChildProcess;
    try {
      child = this.spawnImpl(invocation.command, invocation.args, {
        cwd: this.paths.proxyDir,
        stdio: "ignore",
        windowsHide: true,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      });
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }
    this.child = child;
    this.attachChildLifecycle(child);
    writeCliProxyApiState(this.paths.statePath, {
      port: summary.port,
      version: this.release.version,
      pid: child.pid ?? null,
      startedAt: Date.now(),
      healthyAt: null,
    }, this.fileSecurity());

    try {
      await this.waitForProcessOrHealth(child, summary.port);
      this.markStateHealthy();
      this.startHealthChecks();
      this.restartAttempt = 0;
    } catch (error) {
      this.expectedTerminations.add(child);
      terminateProcessTree(child, "SIGTERM");
      await waitForChildExit(child, 2_000);
      throw error;
    }
  }

  private attachChildLifecycle(child: ChildProcess): void {
    child.once("error", () => {
      // Node emits close after an error; the close handler owns restart state.
    });
    child.once("close", () => {
      if (this.child !== child) return;
      this.child = null;
      this.stopHealthChecks();
      const expected = this.expectedTerminations.has(child);
      this.markStateStopped();
      if (!expected && !this.stopping) this.scheduleRestart();
    });
  }

  private async waitForProcessOrHealth(child: ChildProcess, port: number): Promise<void> {
    let cleanup = (): void => {};
    const processFailure = new Promise<never>((_, reject) => {
      const onError = (error: Error): void => {
        cleanup();
        reject(new Error(`CLIProxyAPI process failed to start: ${error.message}`));
      };
      const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
        cleanup();
        reject(new Error(`CLIProxyAPI process exited before health check (${code ?? signal ?? "unknown"})`));
      };
      child.once("error", onError);
      child.once("close", onClose);
      cleanup = (): void => {
        child.off("error", onError);
        child.off("close", onClose);
      };
    });
    try {
      await Promise.race([
        processFailure,
        waitForHealth({
          port,
          fetchImpl: this.fetchImpl,
          timeoutMs: this.healthTimeoutMs,
          requestTimeoutMs: this.healthRequestTimeoutMs,
          retryDelayMs: this.healthRetryDelayMs,
          sleep: this.sleep,
        }),
      ]);
    } finally {
      cleanup();
    }
  }

  private markStateStopped(): void {
    const state = readCliProxyApiState(this.paths.statePath);
    if (state) {
      writeCliProxyApiState(this.paths.statePath, {
        ...state,
        pid: null,
        healthyAt: null,
      }, this.fileSecurity());
    }
  }

  private markStateHealthy(pid: number | null = this.child?.pid ?? this.adoptedPid): void {
    const state = readCliProxyApiState(this.paths.statePath);
    if (!state || pid === null || state.pid === null || state.pid !== pid) return;
    writeCliProxyApiState(this.paths.statePath, {
      ...state,
      healthyAt: Date.now(),
    }, this.fileSecurity());
  }

  private stopHealthChecks(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    this.healthCheckPromise = null;
  }

  private startHealthChecks(): void {
    this.stopHealthChecks();
    if (this.healthCheckIntervalMs <= 0) return;
    this.healthTimer = setInterval(() => {
      void this.refreshHealth();
    }, this.healthCheckIntervalMs);
    this.healthTimer.unref?.();
  }

  private async refreshHealth(): Promise<void> {
    const child = this.child;
    const pid = child?.pid ?? this.adoptedPid;
    const state = readCliProxyApiState(this.paths.statePath);
    if (
      pid === undefined
      || pid === null
      || !state
      || state.pid !== pid
      || (child ? !isLiveChild(child) : !this.isLivePid(pid))
      || this.healthCheckPromise
    ) return;
    this.healthCheckPromise = waitForHealth({
      port: state.port,
      fetchImpl: this.fetchImpl,
      timeoutMs: this.healthRequestTimeoutMs,
      requestTimeoutMs: this.healthRequestTimeoutMs,
      retryDelayMs: 0,
      sleep: this.sleep,
    }).then(() => {
      if (
        !this.stopping
        && (this.child === child || (child === null && this.adoptedPid === pid))
      ) this.markStateHealthy(pid);
    }).catch(() => {
      // Keep the previous timestamp. The resolver will reject this state once
      // it ages out, even if a stale PID is still present.
    }).finally(() => {
      this.healthCheckPromise = null;
    });
    await this.healthCheckPromise;
  }

  private scheduleRestart(): void {
    if (this.stopping || this.restartTimer) return;
    this.restartAttempt += 1;
    const delay = Math.min(
      MAX_RESTART_BACKOFF_MS,
      250 * (2 ** Math.min(this.restartAttempt - 1, 4)),
    );
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.ensureRunning().catch(() => this.scheduleRestart());
    }, delay);
    this.restartTimer.unref?.();
  }

  private adoptedProcessStillMatchesProxy(pid: number): boolean {
    const state = readCliProxyApiState(this.paths.statePath);
    if (!state || state.pid !== pid || !this.isLivePid(pid)) return false;
    try {
      return this.healthProbe(state.port);
    } catch {
      return false;
    }
  }

  private killAdoptedProcess(pid: number, signal: NodeJS.Signals): void {
    if (this.platform === "win32") {
      this.killProcessTree(pid);
      return;
    }
    try {
      this.processKill(pid, signal);
    } catch {
      // The adopted process may have exited between the verification and kill.
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.stopHealthChecks();
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const child = this.child;
    if (child) {
      this.expectedTerminations.add(child);
      terminateProcessTree(child, "SIGTERM");
      await waitForChildExit(child, 2_000);
      if (this.child === child) this.child = null;
    }
    if (this.adoptedPid !== null) {
      const adoptedPid = this.adoptedPid;
      // A persisted PID is only an adoption hint. Re-read the state, verify
      // that the PID is still live, and confirm the loopback endpoint belongs
      // to this proxy immediately before every kill so PID reuse cannot make
      // ADE terminate an unrelated process.
      if (this.adoptedProcessStillMatchesProxy(adoptedPid)) {
        this.killAdoptedProcess(adoptedPid, "SIGTERM");
        await waitForProcessExit(adoptedPid, ADOPTED_PROCESS_STOP_TIMEOUT_MS, this.isLivePid);
        if (this.adoptedProcessStillMatchesProxy(adoptedPid)) {
          this.killAdoptedProcess(adoptedPid, "SIGKILL");
          await waitForProcessExit(adoptedPid, ADOPTED_PROCESS_STOP_TIMEOUT_MS, this.isLivePid);
        }
      }
      this.adoptedPid = null;
    }
    this.markStateStopped();
    try {
      fs.rmSync(this.paths.managementKeyPath, { force: true });
    } catch {
      // The state is still cleared; a later start will replace the key before
      // launching a fresh proxy process.
    }
    this.managementKey = null;
    this.stopping = false;
  }

  async dispose(): Promise<void> {
    await this.stop();
  }
}

export function createCliProxyApiSupervisor(
  options: CliProxyApiSupervisorOptions = {},
): CliProxyApiSupervisor {
  return new CliProxyApiSupervisor(options);
}
