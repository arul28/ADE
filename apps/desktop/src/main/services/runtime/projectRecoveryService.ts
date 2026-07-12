import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import type { LocalRuntimeStatus } from "../../../shared/types";
import type {
  AdeLastFailureReport,
  AdeRecoveryErrorCode,
  ProjectRecoveryDiagnosis,
  ProjectRepairReport,
  RepairStepId,
  RepairStepResult,
} from "../../../shared/types/recovery";
import { resolveMachineAdeLayout } from "../../../../../ade-cli/src/services/projects/machineLayout";
import type { Logger } from "../logging/logger";
import type { LocalRuntimeConnectionPool } from "../localRuntime/localRuntimeConnectionPool";
import { RuntimeRpcClient, type RuntimeRpcTransport } from "../remoteRuntime/runtimeRpcClient";
import { readJsonWithRecovery } from "../state/durableFile";
import { classifySqliteOpenError, openKvDb } from "../state/kvDb";
import { clearLastFailure, readLastFailure } from "./lastFailureStore";

const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (dbPath: string, options?: { readOnly?: boolean }) => DatabaseSyncType;
};

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const FRESH_FAILURE_MS = 5 * 60 * 1_000;

const STEP_LABELS: Record<RepairStepId, string> = {
  check_space: "Checking storage space",
  stop_service: "Stopping ADE's background service",
  validate_database: "Checking project data",
  resolve_migrations: "Finishing interrupted saves",
  restart_service: "Restarting ADE's background service",
  verify_endpoint: "Checking the background service",
  verify_project_rpc: "Checking this project",
  reconcile_chats: "Checking chats",
};

const STEP_ORDER = Object.keys(STEP_LABELS) as RepairStepId[];

type SpaceStats = { bavail: number | bigint; bsize: number | bigint };
type QuickCheckResult = { healthy: boolean | null; detail: string };
type ChatCounts = { total: number; needingAttention: number };

export type ProjectRecoveryConnectionPool = Pick<
  LocalRuntimeConnectionPool,
  "getStatus" | "installServiceBestEffort" | "callSync" | "ensureProject" | "callActionForRoot"
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
  switch (state) {
    case "healthy":
      return {
        headline: "ADE is ready to open this project.",
        body: "No repair is needed.",
        canAutoRepair: false,
      };
    case "disk_full":
    case "insufficient_headroom":
      return {
        headline: "ADE stopped because your Mac ran out of storage while project data was being saved.",
        body: "ADE found your project data, but it needs to finish a repair before this project can open.",
        canAutoRepair: true,
      };
    case "db_repair_needed":
      return {
        headline: "This project's data needs a quick repair.",
        body: "Something interrupted ADE while it was saving. Your files and chats are still here.",
        canAutoRepair: true,
      };
    case "brain_crash_looping":
      return {
        headline: "ADE's background service keeps stopping.",
        body: "ADE can repair and restart it.",
        canAutoRepair: true,
      };
    case "brain_not_installed":
      return {
        headline: "ADE's background service isn't set up on this Mac.",
        body: "ADE can set it up now.",
        canAutoRepair: true,
      };
    case "socket_stale_no_owner":
      return {
        headline: "ADE's background service didn't shut down cleanly.",
        body: "ADE can clean up and restart it.",
        canAutoRepair: true,
      };
    case "socket_owned_by_other":
      return {
        headline: "Another copy of ADE is already managing projects on this Mac.",
        body: "Close other copies of ADE, then try again.",
        canAutoRepair: false,
      };
    default:
      return {
        headline: "ADE couldn't open this project.",
        body: "You can try a repair, or send the technical details to support.",
        canAutoRepair: true,
      };
  }
}

function stateForCode(code: AdeRecoveryErrorCode): ProjectRecoveryDiagnosis["state"] {
  switch (code) {
    case "disk_full": return "disk_full";
    case "insufficient_headroom": return "insufficient_headroom";
    case "db_integrity":
    case "migration_incomplete":
    case "migration_unknown_state": return "db_repair_needed";
    case "brain_crash_looping": return "brain_crash_looping";
    case "brain_not_installed": return "brain_not_installed";
    case "socket_stale_no_owner": return "socket_stale_no_owner";
    case "socket_owned_by_other": return "socket_owned_by_other";
    default: return "unknown_failure";
  }
}

function humanGb(bytes: number): string {
  const gb = Math.max(1, Math.ceil(bytes / GIB));
  return `${gb} GB`;
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
    await client.initialize("ade-desktop-recovery", "0.0.0");
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
  let db: DatabaseSyncType | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 5000");
    const rows = db.prepare("PRAGMA quick_check").all() as Array<Record<string, unknown>>;
    const messages = rows.map((row) => String(Object.values(row)[0] ?? "")).filter(Boolean);
    const healthy = messages.length === 1 && messages[0]?.toLowerCase() === "ok";
    return { healthy, detail: messages.join("\n") || "The project data check returned no result." };
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
  private readonly quickCheck: (dbPath: string) => Promise<QuickCheckResult>;
  private readonly openDatabase: typeof openKvDb;
  private readonly classifyOpenError: typeof classifySqliteOpenError;
  private readonly readFailureReports: NonNullable<ProjectRecoveryServiceDeps["readFailureReports"]>;
  private readonly clearFailureReports: NonNullable<ProjectRecoveryServiceDeps["clearFailureReports"]>;
  private readonly readChatCounts: (projectRoot: string) => Promise<ChatCounts>;
  private readonly socketExists: (socketPath: string) => boolean;
  private readonly now: () => number;

  constructor(private readonly deps: ProjectRecoveryServiceDeps) {
    this.socketPath = deps.socketPath ?? resolveMachineAdeLayout({ ...process.env, ADE_HOME: deps.adeHome }).socketPath;
    this.statfs = deps.statfs ?? ((targetPath) => fs.promises.statfs(targetPath));
    this.databaseSize = deps.databaseSize ?? defaultDatabaseSize;
    this.probeSocket = deps.probeSocket ?? defaultProbeSocket;
    this.pingEndpoint = deps.pingEndpoint ?? defaultPingEndpoint;
    this.waitForSocketState = deps.waitForSocketState ?? defaultWaitForSocketState;
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
    const dbCheck = endpointHealthy
      ? { healthy: null, detail: "Project data check skipped because the background service is using it." }
      : await this.quickCheck(dbPath);
    const technicalParts = [
      `freeBytes=${free}`,
      `dbSize=${dbSize}`,
      `socketPath=${this.socketPath}`,
      `socketReachable=${socketReachable}`,
      `endpointHealthy=${endpointHealthy}`,
      `serviceInstall=${serviceStatus.serviceInstall.state}`,
      `serviceHealth=${serviceStatus.serviceHealth.state}`,
      `database=${dbCheck.detail}`,
      ...(latestFailure ? [`lastFailure=${latestFailure.code}: ${latestFailure.message}${latestFailure.detail ? ` (${latestFailure.detail})` : ""}`] : []),
    ];

    let state: ProjectRecoveryDiagnosis["state"];
    let code: AdeRecoveryErrorCode;
    if (free < GIB) {
      state = "disk_full";
      code = "disk_full";
    } else if (freshFailure) {
      state = stateForCode(freshFailure.code);
      code = freshFailure.code;
    } else if (dbCheck.healthy === false) {
      state = "db_repair_needed";
      code = "db_integrity";
    } else if (endpointHealthy) {
      state = "healthy";
      code = "unknown";
    } else if (socketReachable) {
      state = "socket_owned_by_other";
      code = "socket_owned_by_other";
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
      state = "brain_crash_looping";
      code = "brain_crash_looping";
    } else {
      state = "unknown_failure";
      code = "unknown";
    }

    const required = Math.max(2 * GIB, dbSize + 512 * MIB);
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
      return fail("check_space", "unknown", "Check that this project and your ADE data folder are available, then run repair again.", errorMessage(error));
    }
    const requiredSpace = Math.max(GIB, storage.dbSize + 512 * MIB);
    if (storage.free < requiredSpace) {
      return fail(
        "check_space",
        storage.free < GIB ? "disk_full" : "insufficient_headroom",
        `Free up about ${humanGb(requiredSpace - storage.free)} on this Mac, then run repair again.`,
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
        return fail("stop_service", "unknown", "Close other copies of ADE, then try again.", errorMessage(error));
      }
      if (!isAdeEndpoint) {
        return fail(
          "stop_service",
          "socket_owned_by_other",
          "Close other copies of ADE, then try again.",
          "The machine endpoint is owned by a process that did not identify itself as ADE.",
        );
      }
      let stopped = false;
      try {
        await this.deps.connectionPool.installServiceBestEffort();
        stopped = await this.waitForSocketState(this.socketPath, false, 10_000);
      } catch (error) {
        return fail("stop_service", "brain_crash_looping", "Restart ADE, then run repair again.", errorMessage(error));
      }
      if (!stopped) {
        return fail(
          "stop_service",
          "socket_owned_by_other",
          "Close other copies of ADE, then try again.",
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
        "This project's data file is damaged. ADE kept your backup safe — contact support with the technical details.",
        errorMessage(error),
      );
    }
    dbHealthy = dbCheck.healthy;
    if (dbCheck.healthy === false) {
      return fail(
        "validate_database",
        "db_integrity",
        "This project's data file is damaged. ADE kept your backup safe — contact support with the technical details.",
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
      const classified = this.classifyOpenError(error);
      const failureCode = classified === "unknown" ? "unknown" : classified;
      const nextAction = classified === "migration_unknown_state"
        ? "ADE found data it doesn't recognize from an interrupted save. Contact support — nothing has been deleted."
        : classified === "disk_full" || classified === "insufficient_headroom"
          ? "Free up more storage on this Mac, then run repair again."
          : "Contact support with the technical details — nothing has been deleted.";
      return fail("resolve_migrations", failureCode, nextAction, errorMessage(error));
    }

    let restarted = false;
    try {
      await this.deps.connectionPool.installServiceBestEffort();
      restarted = await this.waitForSocketState(this.socketPath, true, 20_000);
    } catch (error) {
      return fail("restart_service", "brain_not_installed", "Restart ADE, then run repair again.", errorMessage(error));
    }
    if (!restarted) {
      return fail(
        "restart_service",
        "brain_crash_looping",
        "Restart ADE, then run repair again. If the service still stops, contact support.",
        "The background service did not become reachable within 20 seconds.",
      );
    }
    addStep("restart_service", "ok", "The background service restarted.");

    try {
      await this.deps.connectionPool.callSync("ping", {});
      addStep("verify_endpoint", "ok", "The background service answered.");
    } catch (error) {
      return fail("verify_endpoint", "brain_crash_looping", "Restart ADE, then run repair again.", errorMessage(error));
    }

    try {
      await this.deps.connectionPool.ensureProject(normalizedRoot);
      await this.deps.connectionPool.callActionForRoot(normalizedRoot, {
        domain: "lane",
        action: "list",
        args: { includeArchived: false, includeStatus: false },
      });
      addStep("verify_project_rpc", "ok", "ADE opened this project's data.");
    } catch (error) {
      return fail("verify_project_rpc", "unknown", "Try opening the project again. If it still fails, contact support.", errorMessage(error));
    }

    try {
      const counts = await this.readChatCounts(normalizedRoot);
      chatsTotal = counts.total;
      chatsNeedingAttention = counts.needingAttention;
      addStep("reconcile_chats", "ok", `${counts.total} chats checked; ${counts.needingAttention} need attention.`);
    } catch (error) {
      return fail("reconcile_chats", "unknown", "Open ADE again. Your chats have not been deleted.", errorMessage(error));
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
