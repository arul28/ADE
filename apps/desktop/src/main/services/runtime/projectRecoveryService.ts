import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import {
  RECOVERY_COPY,
  REPAIR_STEP_LABELS,
  REPAIR_STEP_ORDER,
  stateForCode,
  type AdeLastFailureReport,
  type AdeRecoveryErrorCode,
  type ProjectRecoveryDiagnosis,
  type ProjectRepairReport,
  type RepairStepId,
  type RepairStepResult,
} from "../../../shared/types/recovery";
import { resolveMachineAdeLayout } from "../../../../../ade-cli/src/services/projects/machineLayout";
import {
  RUNTIME_SERVICE_START_WAIT_MS,
  RUNTIME_SERVICE_YOUNG_BRAIN_MS,
} from "../../../../../ade-cli/src/serviceManager/runtimeServiceBudgets";
import type { Logger } from "../logging/logger";
import type { LocalRuntimeConnectionPool } from "../localRuntime/localRuntimeConnectionPool";
import { RuntimeRpcClient, type RuntimeRpcTransport } from "../remoteRuntime/runtimeRpcClient";
import { isBackgroundItemBlocked } from "../../../shared/types/core";
import { readJsonWithRecovery } from "../state/durableFile";
import {
  classifySqliteOpenError,
  openKvDb,
  openReadonlyDatabase,
  runQuickCheck,
} from "../state/kvDb";
import { readVolumeSpace } from "../storage/volume";
import { isLocalReleaseBuildOutputError } from "../../../shared/runtimeErrors";
import { DESKTOP_CLIENT_NAMES } from "../../../shared/runtimeClientNames";
import { clearLastFailure, readLastFailure } from "./lastFailureStore";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const FRESH_FAILURE_MS = 5 * 60 * 1_000;
// How long a restarted brain gets to rebind the machine endpoint, shared by
// `repair()`'s restart_service step and `restartBrain()`. Generous on purpose:
// the installer reports a live-but-slow brain as `starting`, and this wait is
// where such a brain gets the rest of its time. It used to be 20s, which on a
// cold or slow machine expired against a healthy brain and turned into
// "didn't restart — try again".
const BRAIN_RESTART_TIMEOUT_MS = RUNTIME_SERVICE_START_WAIT_MS;
// A brain whose install/restart began less than this long ago and that is not
// answering yet is presumed to still be starting, not stuck.
const BRAIN_STARTING_WINDOW_MS = RUNTIME_SERVICE_YOUNG_BRAIN_MS;

const STEP_LABELS = REPAIR_STEP_LABELS;

const BACKGROUND_BLOCKED_NEXT_ACTION =
  "Your Mac is blocking ADE. Open System Settings, go to General, then Login Items, and turn on ADE under \"Allow in the Background\".";

// The recovery screen offers Restart ADE as the next rung; this only says to take it.
const RESTART_AND_RETRY = "Restart ADE next. It starts the background service fresh.";

const STEP_ORDER = REPAIR_STEP_ORDER;

const REPAIR_MIN_FREE_BYTES = (dbSize: number): number => Math.max(GIB, dbSize + 512 * MIB);
// Advice = repair gate + margin, so following the advice always satisfies repair.
const RECOMMENDED_FREE_BYTES = (dbSize: number): number => REPAIR_MIN_FREE_BYTES(dbSize) + GIB;

type SpaceStats = { bavail: number | bigint; bsize: number | bigint };
type QuickCheckResult = { healthy: boolean | null; detail: string };
type ChatCounts = { total: number; needingAttention: number };

/**
 * Which stage of the shared brain-restart sequence lost, if any. The sequence
 * reports the stage rather than the copy, because its two callers say
 * different things about the same stage: `repair()` speaks in repair steps and
 * `restartBrain()` throws.
 */
type BrainRestartOutcome =
  | { ok: true }
  /** The endpoint never came back inside the restart budget. */
  | { ok: false; reason: "unreachable" }
  /** macOS refused to start the agent (Login Items → Allow in the Background). */
  | { ok: false; reason: "background_blocked"; detail: string }
  | {
    ok: false;
    /**
     * "install_skipped" is its own reason because the installer declined on
     * purpose — nothing restarted and nothing is broken — so it needs copy of
     * its own rather than the installer's log line.
     */
    reason: "restart_error" | "install_skipped" | "ping_error";
    detail: string;
  };

export type ProjectRecoveryConnectionPool = Pick<
  LocalRuntimeConnectionPool,
  "getStatus" | "installServiceBestEffort" | "uninstallServiceBestEffort" | "callSync" | "ensureProject" | "callActionForRoot"
>;

export type ProjectRecoveryServiceDeps = {
  adeHome: string;
  logger: Logger;
  connectionPool: ProjectRecoveryConnectionPool;
  socketPath?: string;
  statfs?: (targetPath: string) => Promise<SpaceStats>;
  databaseSize?: (dbPath: string) => Promise<number>;
  probeSocket?: (socketPath: string, timeoutMs: number) => Promise<boolean>;
  pingEndpoint?: (socketPath: string, timeoutMs: number) => Promise<boolean>;
  waitForSocketState?: (socketPath: string, reachable: boolean, timeoutMs: number) => Promise<boolean>;
  stopService?: () => Promise<void> | void;
  quickCheck?: (dbPath: string) => Promise<QuickCheckResult>;
  openDatabase?: typeof openKvDb;
  classifyOpenError?: typeof classifySqliteOpenError;
  readFailureReports?: (projectRoot: string) => Promise<{
    project: AdeLastFailureReport | null;
    machine: AdeLastFailureReport | null;
  }>;
  clearFailureReports?: (projectRoot: string) => Promise<void>;
  readChatCounts?: (projectRoot: string) => Promise<ChatCounts>;
  socketExists?: (socketPath: string) => boolean;
  /**
   * Fires when a diagnosis settles on a state the user cannot work through —
   * everything except `healthy` and the transient `brain_starting`. Automatic
   * diagnostics listens here; the callback owns its own budget, so a screen
   * that re-diagnoses on every poll costs nothing.
   *
   * Carries only what the one listener uses. `state` is derivable from `code`
   * and was passed unused, which is how a notification callback turns into a
   * second, informal copy of the diagnosis type.
   */
  onTerminalDiagnosis?: (input: {
    code: AdeRecoveryErrorCode;
    projectRoot: string;
  }) => void;
  now?: () => number;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toSafeBytes(value: number | bigint): number {
  const numberValue = typeof value === "bigint" ? Number(value) : value;
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : 0;
}

function freeBytes(stats: SpaceStats): number {
  return toSafeBytes(stats.bavail) * toSafeBytes(stats.bsize);
}

function newestFailure(
  project: AdeLastFailureReport | null,
  machine: AdeLastFailureReport | null,
): AdeLastFailureReport | null {
  if (!project) return machine;
  if (!machine) return project;
  const projectAt = Date.parse(project.at);
  const machineAt = Date.parse(machine.at);
  return !Number.isFinite(machineAt) || projectAt >= machineAt ? project : machine;
}

function isFreshFailure(report: AdeLastFailureReport | null, now: number): boolean {
  if (!report) return false;
  const at = Date.parse(report.at);
  return Number.isFinite(at) && now >= at && now - at <= FRESH_FAILURE_MS;
}

function diagnosisCopy(state: ProjectRecoveryDiagnosis["state"]): Pick<
  ProjectRecoveryDiagnosis,
  "headline" | "body" | "canAutoRepair"
> {
  const copy = RECOVERY_COPY[state] ?? RECOVERY_COPY.unknown_failure;
  return { headline: copy.headline, body: copy.body, canAutoRepair: copy.canAutoRepair };
}

function humanGb(bytes: number): string {
  const gb = Math.max(1, Math.ceil(bytes / GIB));
  return `${gb} GB`;
}

/**
 * User-facing copy for a restart the installer deliberately declined to run.
 *
 * The skips exist to protect a newer, protocol-compatible brain that is
 * already running — forcing past them would downgrade it — so the honest
 * remedy is to relaunch ADE, not to retry. The installer's own message is a
 * log line ("Skipped ADE service install because…") and never becomes the
 * sentence a person reads; the release-build block is the exception, since it
 * is already written as instructions.
 */
function skippedRestartCopy(installerMessage: string): string {
  if (isLocalReleaseBuildOutputError(installerMessage)) return installerMessage;
  return "A newer version of ADE is already running. Restart ADE to switch to it.";
}

function socketConnectOptions(socketPath: string): net.NetConnectOpts {
  if (!socketPath.startsWith("tcp://")) return { path: socketPath };
  const url = new URL(socketPath);
  return { host: url.hostname, port: Number(url.port) };
}

async function connectSocket(socketPath: string, timeoutMs: number): Promise<net.Socket> {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(socketConnectOptions(socketPath));
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Connection timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function defaultProbeSocket(socketPath: string, timeoutMs: number): Promise<boolean> {
  try {
    const socket = await connectSocket(socketPath, timeoutMs);
    socket.destroy();
    return true;
  } catch {
    return false;
  }
}

async function defaultPingEndpoint(socketPath: string, timeoutMs: number): Promise<boolean> {
  let socket: net.Socket | null = null;
  let client: RuntimeRpcClient | null = null;
  try {
    socket = await connectSocket(socketPath, timeoutMs);
    const connectedSocket = socket;
    const transport: RuntimeRpcTransport = {
      onData: (callback) => connectedSocket.on("data", callback),
      onClose: (callback) => connectedSocket.on("close", callback),
      onError: (callback) => connectedSocket.on("error", callback),
      write: (data) => connectedSocket.write(data),
      close: () => connectedSocket.end(),
    };
    client = new RuntimeRpcClient(transport, timeoutMs);
    await client.initialize(DESKTOP_CLIENT_NAMES.recovery, "0.0.0");
    const result = await client.call("ping", {}, { timeoutMs });
    return Boolean(result && typeof result === "object" && (result as { pong?: unknown }).pong === true);
  } catch {
    return false;
  } finally {
    client?.close();
    socket?.destroy();
  }
}

async function defaultWaitForSocketState(
  socketPath: string,
  reachable: boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await defaultProbeSocket(socketPath, 500) === reachable) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  return false;
}

async function defaultDatabaseSize(dbPath: string): Promise<number> {
  try {
    return (await fs.promises.stat(dbPath)).size;
  } catch {
    return 0;
  }
}

async function defaultQuickCheck(dbPath: string): Promise<QuickCheckResult> {
  if (!fs.existsSync(dbPath)) return { healthy: true, detail: "No project data file exists yet." };
  let db: ReturnType<typeof openReadonlyDatabase> | null = null;
  try {
    db = openReadonlyDatabase(dbPath);
    return runQuickCheck(db);
  } catch (error) {
    return { healthy: false, detail: errorMessage(error) };
  } finally {
    try { db?.close(); } catch { /* read-only close is best effort */ }
  }
}

function isPersistedChatState(value: unknown): value is {
  continuityRecovery?: { state?: unknown };
} {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function defaultReadChatCounts(projectRoot: string): Promise<ChatCounts> {
  const dir = path.join(projectRoot, ".ade", "cache", "chat-sessions");
  let names: string[];
  try {
    names = await fs.promises.readdir(dir);
  } catch {
    return { total: 0, needingAttention: 0 };
  }
  const sessionFiles = names.filter((name) => name.endsWith(".json"));
  let needingAttention = 0;
  for (const name of sessionFiles) {
    const recovered = readJsonWithRecovery(path.join(dir, name), isPersistedChatState);
    if (recovered.value?.continuityRecovery?.state === "required") needingAttention += 1;
  }
  return { total: sessionFiles.length, needingAttention };
}

export class ProjectRecoveryService {
  private readonly socketPath: string;
  private readonly statfs: (targetPath: string) => Promise<SpaceStats>;
  private readonly databaseSize: (dbPath: string) => Promise<number>;
  private readonly probeSocket: (socketPath: string, timeoutMs: number) => Promise<boolean>;
  private readonly pingEndpoint: (socketPath: string, timeoutMs: number) => Promise<boolean>;
  private readonly waitForSocketState: (socketPath: string, reachable: boolean, timeoutMs: number) => Promise<boolean>;
  private readonly stopService: () => Promise<void> | void;
  private readonly quickCheck: (dbPath: string) => Promise<QuickCheckResult>;
  private readonly openDatabase: typeof openKvDb;
  private readonly classifyOpenError: typeof classifySqliteOpenError;
  private readonly readFailureReports: NonNullable<ProjectRecoveryServiceDeps["readFailureReports"]>;
  private readonly clearFailureReports: NonNullable<ProjectRecoveryServiceDeps["clearFailureReports"]>;
  private readonly readChatCounts: (projectRoot: string) => Promise<ChatCounts>;
  private readonly socketExists: (socketPath: string) => boolean;
  private readonly now: () => number;
  /** Set for the whole of `repair()`; see `restartBrain()` for why. */
  private repairInFlight = false;
  /**
   * Settled-either-way handle on an in-flight `restartBrain()`. The flag above
   * only closes one direction (a restart started after repair began); a repair
   * started *during* a restart must wait for the install to finish, or that
   * install can bind a replacement brain to the socket while repair owns the
   * database.
   */
  private restartInFlight: Promise<void> | null = null;

  constructor(private readonly deps: ProjectRecoveryServiceDeps) {
    this.socketPath = deps.socketPath ?? resolveMachineAdeLayout({ ...process.env, ADE_HOME: deps.adeHome }).socketPath;
    this.statfs = deps.statfs ?? (async (targetPath) => {
      const volume = readVolumeSpace(targetPath);
      if (!volume) throw new Error(`Could not measure available storage for ${targetPath}.`);
      return { bavail: volume.freeBytes, bsize: 1 };
    });
    this.databaseSize = deps.databaseSize ?? defaultDatabaseSize;
    this.probeSocket = deps.probeSocket ?? defaultProbeSocket;
    this.pingEndpoint = deps.pingEndpoint ?? defaultPingEndpoint;
    this.waitForSocketState = deps.waitForSocketState ?? defaultWaitForSocketState;
    // Stop = spawn `serve --uninstall-service` via the pool's child-process
    // boundary; desktop must never import ade-cli service-manager code.
    this.stopService = deps.stopService ?? (() => deps.connectionPool.uninstallServiceBestEffort());
    this.quickCheck = deps.quickCheck ?? defaultQuickCheck;
    this.openDatabase = deps.openDatabase ?? openKvDb;
    this.classifyOpenError = deps.classifyOpenError ?? classifySqliteOpenError;
    this.readFailureReports = deps.readFailureReports ?? (async (projectRoot) => ({
      project: readLastFailure({ kind: "project", projectRoot }),
      machine: readLastFailure({ kind: "machine", env: { ...process.env, ADE_HOME: deps.adeHome } }),
    }));
    this.clearFailureReports = deps.clearFailureReports ?? (async (projectRoot) => {
      clearLastFailure({ kind: "project", projectRoot });
      clearLastFailure({ kind: "machine", env: { ...process.env, ADE_HOME: deps.adeHome } });
    });
    this.readChatCounts = deps.readChatCounts ?? defaultReadChatCounts;
    this.socketExists = deps.socketExists ?? fs.existsSync;
    this.now = deps.now ?? Date.now;
  }

  private async storage(projectRoot: string): Promise<{ free: number; dbSize: number }> {
    const dbPath = path.join(projectRoot, ".ade", "ade.db");
    const [projectStats, homeStats, dbSize] = await Promise.all([
      this.statfs(projectRoot),
      this.statfs(this.deps.adeHome),
      this.databaseSize(dbPath),
    ]);
    return { free: Math.min(freeBytes(projectStats), freeBytes(homeStats)), dbSize };
  }

  /**
   * Install the service, wait for the machine endpoint to come back, then ping
   * it — the one verified brain-restart sequence, shared by `repair()`'s
   * restart_service/verify_endpoint steps and by `restartBrain()`.
   *
   * `force` is more than the install flag. A forced restart is the only caller
   * that actually asked for a restart, so an install that resolves having
   * skipped is a failure for it; `repair()` tolerates a skip, because a
   * protocol-compatible brain that is already running satisfies its step.
   */
  private async restartServiceAndWait(force: boolean): Promise<BrainRestartOutcome> {
    try {
      await this.deps.connectionPool.installServiceBestEffort(force ? { forceRestart: true } : {});
      const installed = this.deps.connectionPool.getStatus().serviceInstall;
      if (installed.state === "failed" && installed.failureStep === "background_item_blocked") {
        // Waiting out the restart budget for a brain macOS will not start
        // only delays the one sentence that helps.
        return { ok: false, reason: "background_blocked", detail: installed.message?.trim() ?? "" };
      }
      if (force) {
        // `installServiceBestEffort` never rejects and can resolve having
        // skipped the install entirely, hence the status check.
        const install = this.deps.connectionPool.getStatus().serviceInstall;
        if (install.state !== "installed") {
          return {
            ok: false,
            reason: install.state === "skipped" ? "install_skipped" : "restart_error",
            detail: install.message?.trim() ?? "",
          };
        }
      }
      if (!await this.waitForSocketState(this.socketPath, true, BRAIN_RESTART_TIMEOUT_MS)) {
        return { ok: false, reason: "unreachable" };
      }
    } catch (error) {
      return { ok: false, reason: "restart_error", detail: errorMessage(error) };
    }
    try {
      // Bound the ping: RuntimeRpcClient's default is 10 minutes, and a brain
      // that binds the socket but never answers would otherwise park both this
      // call and any `repair()` waiting on it for that whole window.
      await this.deps.connectionPool.callSync("ping", {}, { timeoutMs: BRAIN_RESTART_TIMEOUT_MS });
    } catch (error) {
      return { ok: false, reason: "ping_error", detail: errorMessage(error) };
    }
    return { ok: true };
  }

  /**
   * Machine-scoped brain restart for the "Repair" button. Only the main
   * process can observe when the replacement brain is actually answering, so
   * the renderer awaits this instead of sleeping and hoping.
   *
   * Throws so the caller's error path fires, and rejects outright while a
   * `repair()` is running: repair stops the service and then does exclusive
   * database work, and reinstalling the brain underneath it would put a writer
   * back on the database mid-check (see the invariant on
   * `uninstallServiceBestEffort`). Repair wins; the button can be pressed again
   * after it finishes.
   */
  async restartBrain(): Promise<void> {
    if (this.repairInFlight) throw new Error("Recovery is already running.");
    const restart = this.restartServiceAndWait(true);
    // Never-rejecting handle so `repair()` can await it without inheriting a
    // restart failure; the real outcome is still thrown to this caller below.
    const settled = restart.then(() => undefined, () => undefined);
    this.restartInFlight = settled;
    void settled.then(() => {
      if (this.restartInFlight === settled) this.restartInFlight = null;
    });
    const outcome = await restart;
    if (outcome.ok) return;
    switch (outcome.reason) {
      case "install_skipped":
        throw new Error(skippedRestartCopy(outcome.detail));
      case "unreachable":
        throw new Error("ADE's background service didn't start again after the restart.");
      case "background_blocked":
        throw new Error(BACKGROUND_BLOCKED_NEXT_ACTION);
      default:
        throw new Error(outcome.detail.trim() || "ADE's background service couldn't restart.");
    }
  }

  async diagnose(projectRoot: string): Promise<ProjectRecoveryDiagnosis> {
    const normalizedRoot = path.resolve(projectRoot);
    const dbPath = path.join(normalizedRoot, ".ade", "ade.db");
    const [{ free, dbSize }, failures] = await Promise.all([
      this.storage(normalizedRoot),
      this.readFailureReports(normalizedRoot),
    ]);
    const latestFailure = newestFailure(failures.project, failures.machine);
    const freshFailure = isFreshFailure(latestFailure, this.now()) ? latestFailure : null;
    const socketReachable = await this.probeSocket(this.socketPath, 750);
    const endpointHealthy = socketReachable && await this.pingEndpoint(this.socketPath, 1_500);
    const serviceStatus = this.deps.connectionPool.getStatus();
    const installStartedAt = Date.parse(serviceStatus.serviceInstall.attemptStartedAt ?? "");
    // Time-bounded on purpose: the installer's `starting` flag alone would keep
    // a brain that wedged during boot reading as "starting" forever.
    //
    // Deliberately not gated on `!socketReachable`: the brain binds its RPC
    // socket before it can answer `ade/initialize`, so there is a real window
    // where the socket accepts connections and the ping still fails. Requiring
    // an unreachable socket made that window impossible to classify as
    // starting, and it fell through to "another program owns this" instead.
    // A negative age means the recorded attempt is in the future -- a clock
    // that moved backwards after it was written. Only the upper bound was
    // checked, so such a stamp read as "always inside the window" and
    // suppressed repair until the clock caught up with it.
    const startupAgeMs = this.now() - installStartedAt;
    const brainStarting =
      serviceStatus.serviceHealth.running === true
      && Number.isFinite(installStartedAt)
      && startupAgeMs >= 0
      && startupAgeMs < BRAIN_STARTING_WINDOW_MS;
    const dbCheck = endpointHealthy
      ? { healthy: null, detail: "Project data check skipped because the background service is using it." }
      : await this.quickCheck(dbPath);
    // A recorded sync-host failure says phone sync could not start. It says
    // nothing about whether the desktop can reach this brain, and the brain
    // deliberately keeps that record until sync really comes up — so a brain
    // that is bound, answering, and healthy routinely carries a fresh
    // `sync_host` failure. Repairing on it would kill a brain doing its job.
    // It stays in `lastFailure` and the technical detail either way.
    const actionableFailure =
      freshFailure && endpointHealthy && freshFailure.component === "sync_host" ? null : freshFailure;
    const technicalParts = [
      `freeBytes=${free}`,
      `dbSize=${dbSize}`,
      `socketPath=${this.socketPath}`,
      `socketReachable=${socketReachable}`,
      `endpointHealthy=${endpointHealthy}`,
      `serviceInstall=${serviceStatus.serviceInstall.state}${serviceStatus.serviceInstall.starting ? " (starting)" : ""}`,
      `serviceHealth=${serviceStatus.serviceHealth.state}`,
      ...(serviceStatus.serviceHealth.backgroundItem
        ? [`backgroundItem=${serviceStatus.serviceHealth.backgroundItem}`]
        : []),
      ...(serviceStatus.serviceInstall.failureStep
        ? [`serviceInstallFailureStep=${serviceStatus.serviceInstall.failureStep}`]
        : []),
      // launchctl's (or the Windows installer's) own words for a failed
      // install. Only ever in the fold: the screen names the cause in plain words.
      ...(serviceStatus.serviceInstall.state === "failed" && serviceStatus.serviceInstall.message?.trim()
        ? [`serviceInstallMessage=${serviceStatus.serviceInstall.message.trim()}`]
        : []),
      `database=${dbCheck.detail}`,
      ...(latestFailure ? [`lastFailure=${latestFailure.code}: ${latestFailure.message}${latestFailure.detail ? ` (${latestFailure.detail})` : ""}`] : []),
    ];

    let state: ProjectRecoveryDiagnosis["state"];
    let code: AdeRecoveryErrorCode;
    if (free < GIB) {
      state = "disk_full";
      code = "disk_full";
    } else if (actionableFailure) {
      state = stateForCode(actionableFailure.code);
      code = actionableFailure.code;
    } else if (dbCheck.healthy === false) {
      state = "db_repair_needed";
      code = "db_integrity";
    } else if (endpointHealthy) {
      state = "healthy";
      code = "unknown";
    } else if (brainStarting) {
      // Ahead of the owner, crash-loop and stale-socket branches: a brain that
      // the installer just started (or reported as still starting) and that
      // launchd/the supervisor shows running is booting, not broken. Repair
      // here would only kill it and start its clock over, and a socket it has
      // bound but cannot answer on yet is this brain's, not a stranger's.
      state = "brain_starting";
      code = "unknown";
    } else if (socketReachable) {
      state = "socket_owned_by_other";
      code = "socket_owned_by_other";
    } else if (isBackgroundItemBlocked(serviceStatus)) {
      // Ahead of every repairable state: macOS will not start the brain until
      // the person turns ADE back on under Login Items, and a repair that
      // reinstalls the agent only reruns the install that just failed.
      state = "background_blocked";
      code = "background_item_blocked";
    } else if (serviceStatus.serviceHealth.installed === false) {
      state = "brain_not_installed";
      code = "brain_not_installed";
    } else if (latestFailure?.code === "brain_crash_looping" || (latestFailure?.count ?? 0) >= 3) {
      state = "brain_crash_looping";
      code = "brain_crash_looping";
    } else if (this.socketExists(this.socketPath)) {
      state = "socket_stale_no_owner";
      code = "socket_stale_no_owner";
    } else if (serviceStatus.serviceHealth.installed === true && serviceStatus.serviceHealth.running === false) {
      // Installed and stopped with no crash on record. This used to read as
      // "keeps stopping", which sent people hunting for a crash that never
      // happened — the brain simply never started.
      state = "brain_not_running";
      code = "brain_not_running";
    } else {
      state = "unknown_failure";
      code = "unknown";
    }

    if (state !== "healthy" && state !== "brain_starting") {
      try {
        this.deps.onTerminalDiagnosis?.({ code, projectRoot: normalizedRoot });
      } catch {
        // A listener must never cost the user their diagnosis.
      }
    }

    const required = RECOMMENDED_FREE_BYTES(dbSize);
    return {
      state,
      code,
      ...diagnosisCopy(state),
      ...(state === "disk_full" || state === "insufficient_headroom"
        ? { requiresFreeSpaceBytes: required, freeBytes: free }
        : {}),
      ...(latestFailure ? { lastFailure: latestFailure } : {}),
      technicalDetail: technicalParts.join("\n"),
    };
  }

  async repair(
    projectRoot: string,
    opts: { onStep?: (step: RepairStepResult) => void } = {},
  ): Promise<ProjectRepairReport> {
    // Held across the whole run so a renderer-triggered `restartBrain()`
    // cannot reinstall the brain while the steps below own the database.
    this.repairInFlight = true;
    try {
      // A restart that started before the flag was set is not covered by it:
      // let its install finish before repair stops the service and takes the
      // database. Never fails repair — this is the user's last resort, so the
      // wait is bounded and repair proceeds regardless of how the restart ends.
      // Repair's own stop_service step is what actually guarantees exclusivity;
      // this wait only avoids racing an install that is already underway.
      if (this.restartInFlight) {
        await Promise.race([
          this.restartInFlight,
          new Promise<void>((resolve) => setTimeout(resolve, BRAIN_RESTART_TIMEOUT_MS)),
        ]);
      }
      return await this.runRepair(projectRoot, opts);
    } finally {
      this.repairInFlight = false;
    }
  }

  private async runRepair(
    projectRoot: string,
    opts: { onStep?: (step: RepairStepResult) => void },
  ): Promise<ProjectRepairReport> {
    const normalizedRoot = path.resolve(projectRoot);
    const dbPath = path.join(normalizedRoot, ".ade", "ade.db");
    const steps: RepairStepResult[] = [];
    let dbHealthy: boolean | null = null;
    let chatsTotal: number | null = null;
    let chatsNeedingAttention: number | null = null;

    const addStep = (id: RepairStepId, status: RepairStepResult["status"], detail?: string): void => {
      const step = { id, label: STEP_LABELS[id], status, ...(detail ? { detail } : {}) };
      steps.push(step);
      opts.onStep?.(step);
    };
    const fail = (
      id: RepairStepId,
      failureCode: AdeRecoveryErrorCode,
      nextAction: string,
      detail: string,
    ): ProjectRepairReport => {
      addStep(id, "failed", detail);
      for (const skippedId of STEP_ORDER.slice(STEP_ORDER.indexOf(id) + 1)) {
        addStep(skippedId, "skipped", "Not run because an earlier step needs attention.");
      }
      return {
        ok: false,
        steps,
        dbHealthy,
        chatsTotal,
        chatsNeedingAttention,
        filesRemoved: 0,
        failureCode,
        nextAction,
      };
    };

    let storage: { free: number; dbSize: number };
    try {
      storage = await this.storage(normalizedRoot);
    } catch (error) {
      return fail("check_space", "unknown", "ADE couldn't check the free space on this computer. Make sure the project folder is still there, then try again.", errorMessage(error));
    }
    const requiredSpace = REPAIR_MIN_FREE_BYTES(storage.dbSize);
    if (storage.free < requiredSpace) {
      return fail(
        "check_space",
        storage.free < GIB ? "disk_full" : "insufficient_headroom",
        `Free up about ${humanGb(requiredSpace - storage.free)} on this computer, then try again.`,
        `Available ${storage.free} bytes; repair requires ${requiredSpace} bytes.`,
      );
    }
    addStep("check_space", "ok", `${humanGb(storage.free)} available.`);

    const socketReachable = await this.probeSocket(this.socketPath, 750);
    if (socketReachable) {
      let isAdeEndpoint = false;
      try {
        isAdeEndpoint = await this.pingEndpoint(this.socketPath, 1_500);
      } catch (error) {
        return fail("stop_service", "unknown", "Quit any other copy of ADE, then try again.", errorMessage(error));
      }
      if (!isAdeEndpoint) {
        return fail(
          "stop_service",
          "socket_owned_by_other",
          "Quit any other copy of ADE, then try again.",
          "The machine endpoint is owned by a process that did not identify itself as ADE.",
        );
      }
      let stopped = false;
      try {
        await this.stopService();
        stopped = await this.waitForSocketState(this.socketPath, false, 10_000);
      } catch (error) {
        return fail("stop_service", "brain_crash_looping", RESTART_AND_RETRY, errorMessage(error));
      }
      if (!stopped) {
        return fail(
          "stop_service",
          "socket_owned_by_other",
          "Quit any other copy of ADE, then try again.",
          "ADE could not verify exclusive access to the project data.",
        );
      }
      addStep("stop_service", "ok", "The previous background service stopped.");
    } else {
      addStep("stop_service", "ok", "No running background service was found.");
    }

    let dbCheck: QuickCheckResult;
    try {
      dbCheck = await this.quickCheck(dbPath);
    } catch (error) {
      return fail(
        "validate_database",
        "db_integrity",
        "This project's ADE data is damaged. Your code is fine. Send a report so we can help.",
        errorMessage(error),
      );
    }
    dbHealthy = dbCheck.healthy;
    if (dbCheck.healthy === false) {
      return fail(
        "validate_database",
        "db_integrity",
        "This project's ADE data is damaged. Your code is fine. Send a report so we can help.",
        dbCheck.detail,
      );
    }
    addStep("validate_database", "ok", dbCheck.detail);

    try {
      const db = await this.openDatabase(dbPath, this.deps.logger);
      db.close();
      dbHealthy = true;
      addStep("resolve_migrations", "ok", "Interrupted saves were finished safely.");
    } catch (error) {
      const classified = this.classifyOpenError(error, { path: dbPath });
      const failureCode = classified === "unknown" ? "unknown" : classified;
      const nextAction = classified === "migration_unknown_state"
        ? "ADE found data it doesn't recognize from an interrupted save. Nothing was deleted. Send a report so we can help."
        : classified === "disk_full" || classified === "insufficient_headroom"
          ? "Free up more space on this computer, then try again."
          : "Nothing was deleted. Send a report so we can help.";
      return fail("resolve_migrations", failureCode, nextAction, errorMessage(error));
    }

    const restart = await this.restartServiceAndWait(false);
    if (!restart.ok && restart.reason === "background_blocked") {
      return fail("restart_service", "background_item_blocked", BACKGROUND_BLOCKED_NEXT_ACTION, restart.detail);
    }
    if (!restart.ok && restart.reason !== "ping_error") {
      return restart.reason === "unreachable"
        ? fail(
          "restart_service",
          "brain_crash_looping",
          RESTART_AND_RETRY,
          `The background service did not become reachable within ${Math.round(BRAIN_RESTART_TIMEOUT_MS / 1_000)} seconds.`,
        )
        : fail("restart_service", "brain_not_installed", RESTART_AND_RETRY, restart.detail);
    }
    addStep("restart_service", "ok", "The background service restarted.");

    if (!restart.ok) {
      return fail("verify_endpoint", "brain_crash_looping", RESTART_AND_RETRY, restart.detail);
    }
    addStep("verify_endpoint", "ok", "The background service answered.");

    try {
      await this.deps.connectionPool.ensureProject(normalizedRoot);
      await this.deps.connectionPool.callActionForRoot(normalizedRoot, {
        domain: "lane",
        action: "list",
        args: { includeArchived: false, includeStatus: false },
      });
      addStep("verify_project_rpc", "ok", "ADE opened this project's data.");
    } catch (error) {
      return fail("verify_project_rpc", "unknown", "Choose Try again to open the project again.", errorMessage(error));
    }

    try {
      const counts = await this.readChatCounts(normalizedRoot);
      chatsTotal = counts.total;
      chatsNeedingAttention = counts.needingAttention;
      addStep("reconcile_chats", "ok", `${counts.total} chats checked; ${counts.needingAttention} need attention.`);
    } catch (error) {
      return fail("reconcile_chats", "unknown", "Open ADE again. Your chats were not deleted.", errorMessage(error));
    }

    await this.clearFailureReports(normalizedRoot);
    return {
      ok: true,
      steps,
      dbHealthy,
      chatsTotal,
      chatsNeedingAttention,
      filesRemoved: 0,
    };
  }
}

export function createProjectRecoveryService(deps: ProjectRecoveryServiceDeps): ProjectRecoveryService {
  return new ProjectRecoveryService(deps);
}
