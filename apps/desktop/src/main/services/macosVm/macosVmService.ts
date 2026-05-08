import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import type { FSWatcher } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type MacosVmAgentGuide,
  type MacosVmAgentGuideArgs,
  type MacosVmCaptureScreenshotArgs,
  type MacosVmCaptureScreenshotResult,
  type MacosVmClickArgs,
  type MacosVmContextItem,
  type MacosVmDeleteArgs,
  type MacosVmEventPayload,
  type MacosVmFocusWindowArgs,
  type MacosVmLifecycleState,
  type MacosVmOperation,
  type MacosVmProviderStatus,
  type MacosVmProvisionArgs,
  type MacosVmRecord,
  type MacosVmSelectPointArgs,
  type MacosVmSelectPointResult,
  type MacosVmSharePolicy,
  type MacosVmStartArgs,
  type MacosVmStatus,
  type MacosVmStatusArgs,
  type MacosVmStopArgs,
  type MacosVmToolStatus,
  type MacosVmTypeTextArgs,
  type MacosVmWindowFrame,
  type MacosVmWindowTarget,
} from "../../../shared/types";
import { resolveAdeLayout } from "../../../shared/adeLayout";
import type { Logger } from "../logging/logger";
import {
  captureVncScreenshot,
  clickVnc,
  type DirectVncConnection,
  type DirectVncScreenshot,
  typeTextVnc,
} from "./rfbDirectClient";

const APPLE_VIRTUALIZATION_DOCS = "https://developer.apple.com/documentation/virtualization";
const APPLE_SHARED_DIRECTORIES_DOCS = "https://developer.apple.com/documentation/virtualization/vzvirtiofilesystemdeviceconfiguration";
const LUME_DOCS = "https://cua.ai/docs/lume/guide/fundamentals/vm-management";
const LUME_INSTALL_DOCS = "https://cua.ai/docs/lume/guide/getting-started/installation";
const LUME_GUEST_SHARED_PATH = "/Volumes/My Shared Files";
const DEFAULT_CPU_CORES = 4;
const DEFAULT_MEMORY = "8GB";
const DEFAULT_DISK_SIZE = "80GB";
const DEFAULT_DISPLAY = "1920x1200";
const DEFAULT_PULL_IMAGE = "macos-tahoe-vanilla:latest";
const MACOS_VM_STATE_FILE = "records.json";
const MACOS_VM_VNC_CREDENTIALS_FILE = "macos-vm-vnc.v1.json";
const MACOS_VM_HEADLESS_WINDOW_TITLE = "Headless VNC";
const MIRROR_SYNC_EXCLUDES = [
  "/.ade/local.yaml",
  "/.ade/local.secret.yaml",
  "/.ade/ade.db*",
  "/.ade/embeddings.db*",
  "/.ade/ade.sock",
  "/.ade/secrets/***",
  "/.ade/cache/***",
  "/.ade/artifacts/***",
  "/.ade/transcripts/***",
  "/.ade/worktrees/***",
  "/.ade/agents/***",
  "/.ade/cto/CURRENT.md",
  "/.ade/cto/MEMORY.md",
  "/.ade/cto/core-memory.json",
  "/.ade/cto/daily/***",
  "/.ade/cto/sessions.jsonl",
  "/.ade/cto/subordinate-activity.jsonl",
  "/.ade/cto/openclaw-*.json",
  "/.ade/context/***",
  "/.ade/memory/***",
  "/.ade/history/***",
  "/.ade/reflections/***",
  "/.git/***",
];

type LaneContext = {
  id: string;
  name: string;
  worktreePath: string;
};

type CommandResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

type CommandRunner = (
  command: string,
  args: string[],
  options: { timeoutMs: number; cwd?: string | null },
) => Promise<CommandResult>;

type DirectVncClient = {
  captureScreenshot(connection: DirectVncConnection, timeoutMs?: number): Promise<DirectVncScreenshot>;
  click(connection: DirectVncConnection, x: number, y: number, timeoutMs?: number): Promise<{ width: number; height: number; x: number; y: number }>;
  typeText(connection: DirectVncConnection, text: string, timeoutMs?: number): Promise<{ width: number; height: number; typedLength: number }>;
};

type SharePlan = {
  hostPath: string;
  guestPath: string;
  readOnly: boolean;
  allowed: boolean;
  blockedReason: string | null;
  syncMode: "direct" | "sanitized-mirror";
  mirrorPath: string | null;
  originalHostPath: string;
  excludedPaths: string[];
  detail: string | null;
};

type MirrorSyncSession = {
  laneId: string;
  laneRoot: string;
  mirrorPath: string;
  laneWatcher: FSWatcher | null;
  mirrorWatcher: FSWatcher | null;
  laneTimer: NodeJS.Timeout | null;
  mirrorTimer: NodeJS.Timeout | null;
  suppressUntilMs: number;
  syncing: boolean;
  disposed: boolean;
};

type CreateMacosVmServiceArgs = {
  projectRoot: string;
  logger: Logger;
  resolveLanes: () => Promise<LaneContext[]>;
  onEvent?: ((payload: MacosVmEventPayload) => void) | null;
  runCommand?: CommandRunner;
  directVncClient?: DirectVncClient;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
};

type VmStoreFile = {
  version: 1;
  records: MacosVmRecord[];
};

type VncCredentialStoreFile = {
  version: 1;
  credentials: Record<string, {
    laneId: string;
    vmName: string;
    password: string;
    updatedAt: string;
  }>;
};

type ExternalVmInfo = {
  name: string;
  state: MacosVmLifecycleState;
  ipAddress: string | null;
  vncUrl: string | null;
  raw: Record<string, unknown>;
};

function nowIso(): string {
  return new Date().toISOString();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeLifecycleState(value: unknown): MacosVmLifecycleState {
  const normalized = typeof value === "string" ? value.trim().toLowerCase().replace(/[\s-]+/g, "_") : "";
  if (normalized === "created" || normalized === "not_created") return "not_created";
  if (normalized === "creating") return "creating";
  if (normalized === "installing") return "installing";
  if (normalized === "stopped" || normalized === "shutoff" || normalized === "shutdown") return "stopped";
  if (normalized === "starting" || normalized === "booting") return "starting";
  if (normalized === "running" || normalized === "started") return "running";
  if (normalized === "stopping") return "stopping";
  if (normalized === "paused" || normalized === "suspended") return "paused";
  if (normalized === "failed" || normalized === "error") return "failed";
  return "unknown";
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asPositiveInteger(value: unknown, fallback: number, max = 64): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(max, parsed);
}

function normalizeSize(value: unknown, fallback: string): string {
  const raw = asString(value);
  if (!raw) return fallback;
  if (!/^\d+(?:GB|MB|TB)$/i.test(raw)) return fallback;
  return raw.toUpperCase();
}

function normalizeDisplay(value: unknown, fallback: string): string {
  const raw = asString(value);
  if (!raw) return fallback;
  if (!/^\d{3,5}x\d{3,5}$/i.test(raw)) return fallback;
  return raw.toLowerCase();
}

function sanitizeVmName(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return (normalized || "ade-vm").slice(0, 58).replace(/-+$/g, "") || "ade-vm";
}

function defaultVmName(projectRoot: string, lane: LaneContext): string {
  const project = path.basename(projectRoot) || "project";
  const lanePart = lane.name || lane.id;
  return sanitizeVmName(`ade-${project}-${lanePart}-${lane.id.slice(0, 8)}`);
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function sanitizeArtifactName(value: string): string {
  return sanitizeVmName(value).replace(/[^a-z0-9-]+/g, "-") || "macos-vm";
}

function withTrailingSeparator(value: string): string {
  return value.endsWith(path.sep) ? value : `${value}${path.sep}`;
}

function isIgnoredMirrorSyncPath(value: string | Buffer | null | undefined): boolean {
  if (value == null) return false;
  const relative = String(value).replace(/\\/g, "/");
  const ignoredDirectories = [
    ".ade/secrets",
    ".ade/cache",
    ".ade/artifacts",
    ".ade/transcripts",
    ".ade/worktrees",
    ".ade/agents",
    ".ade/cto/daily",
    ".ade/context",
    ".ade/memory",
    ".ade/history",
    ".ade/reflections",
    ".git",
  ];
  if (ignoredDirectories.some((entry) => relative === entry || relative.startsWith(`${entry}/`))) return true;
  return relative === ".ade/local.yaml"
    || relative === ".ade/local.secret.yaml"
    || relative === ".ade/ade.sock"
    || relative === ".ade/ade.db"
    || relative.startsWith(".ade/ade.db")
    || relative === ".ade/embeddings.db"
    || relative.startsWith(".ade/embeddings.db")
    || relative === ".ade/cto/CURRENT.md"
    || relative === ".ade/cto/MEMORY.md"
    || relative === ".ade/cto/core-memory.json"
    || relative === ".ade/cto/sessions.jsonl"
    || relative === ".ade/cto/subordinate-activity.jsonl"
    || /^\.ade\/cto\/openclaw-.*\.json$/.test(relative);
}

function readPngDataUrl(filePath: string): string | null {
  try {
    return `data:image/png;base64,${fs.readFileSync(filePath).toString("base64")}`;
  } catch {
    return null;
  }
}

function defaultRunCommand(command: string, args: string[], options: { timeoutMs: number; cwd?: string | null }): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? undefined,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, 500);
      finish({
        exitCode: null,
        signal: "SIGTERM",
        stdout,
        stderr: stderr || `${command} timed out after ${options.timeoutMs}ms.`,
      });
    }, options.timeoutMs);
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
      if (stdout.length > 2_000_000) stdout = stdout.slice(-1_000_000);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
      if (stderr.length > 2_000_000) stderr = stderr.slice(-1_000_000);
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (exitCode, signal) => finish({ exitCode, signal, stdout, stderr }));
  });
}

function parseJsonLoose<T>(value: string): T | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const firstArray = trimmed.indexOf("[");
    const firstObject = trimmed.indexOf("{");
    const first = firstArray < 0 ? firstObject : firstObject < 0 ? firstArray : Math.min(firstArray, firstObject);
    if (first < 0) return null;
    try {
      return JSON.parse(trimmed.slice(first)) as T;
    } catch {
      return null;
    }
  }
}

function parseVmInfo(value: unknown): ExternalVmInfo | null {
  if (!isRecord(value)) return null;
  const name = asString(value.name ?? value.vmName ?? value.id);
  if (!name) return null;
  const rawIp = value.ip ?? value.ipAddress ?? value.ip_address ?? value.address;
  const rawVnc = value.vncUrl ?? value.vnc_url ?? value.vnc ?? value.displayUrl;
  return {
    name,
    state: normalizeLifecycleState(value.state ?? value.status ?? value.powerState),
    ipAddress: asString(rawIp),
    vncUrl: sanitizeVncUrl(asString(rawVnc)),
    raw: sanitizeExternalVmRaw(value),
  };
}

function parseVmList(stdout: string): ExternalVmInfo[] {
  const parsed = parseJsonLoose<unknown>(stdout);
  const rawList = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.vms)
      ? parsed.vms
      : isRecord(parsed) && Array.isArray(parsed.items)
        ? parsed.items
        : [];
  const infos = rawList.map(parseVmInfo).filter((item): item is ExternalVmInfo => item !== null);
  if (infos.length > 0) return infos;

  const parsedTextInfos: ExternalVmInfo[] = [];
  for (const line of stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean)) {
      const parts = line.split(/\s{2,}|\t+/).map((part) => part.trim()).filter(Boolean);
      if (parts.length < 2 || /^name$/i.test(parts[0] ?? "")) continue;
      parsedTextInfos.push({
        name: parts[0] ?? "",
        state: normalizeLifecycleState(parts[1]),
        ipAddress: parts.find((part) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(part)) ?? null,
        vncUrl: sanitizeVncUrl(parts.find((part) => /^vnc:\/\//i.test(part)) ?? null),
        raw: { line: sanitizeVncUrlsInText(line) },
      });
    }
  return parsedTextInfos.filter((item) => Boolean(item.name));
}

function parseVmGet(stdout: string, name: string): ExternalVmInfo | null {
  const parsed = parseJsonLoose<unknown>(stdout);
  const direct = parseVmInfo(parsed);
  if (direct) return direct;
  const list = parseVmList(stdout);
  return list.find((info) => info.name === name) ?? null;
}

function readStoreFile(storePath: string): VmStoreFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath, "utf8")) as Partial<VmStoreFile>;
    const records = Array.isArray(parsed.records)
      ? parsed.records.filter((record): record is MacosVmRecord => isRecord(record) && typeof record.id === "string")
      : [];
    return { version: 1, records };
  } catch {
    return { version: 1, records: [] };
  }
}

function writeStoreFile(storePath: string, store: VmStoreFile): void {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const tmpPath = `${storePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, storePath);
}

function readVncCredentialStore(storePath: string): VncCredentialStoreFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath, "utf8")) as Partial<VncCredentialStoreFile>;
    return {
      version: 1,
      credentials: isRecord(parsed.credentials) ? parsed.credentials as VncCredentialStoreFile["credentials"] : {},
    };
  } catch {
    return { version: 1, credentials: {} };
  }
}

function writeVncCredentialStore(storePath: string, store: VncCredentialStoreFile): void {
  fs.mkdirSync(path.dirname(storePath), { recursive: true, mode: 0o700 });
  const tmpPath = `${storePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmpPath, storePath);
  try {
    fs.chmodSync(storePath, 0o600);
  } catch {
    // Best effort. The file lives under .ade/secrets and is excluded from VM shares.
  }
}

function vncCredentialKey(laneId: string, vmName: string): string {
  return `${laneId}:${vmName}`;
}

function generateVncPassword(): string {
  return randomBytes(6).toString("base64url").slice(0, 8);
}

function parseDisplaySize(display: string | null | undefined): { width: number; height: number } {
  const match = /^(\d{3,5})x(\d{3,5})$/i.exec(display ?? "");
  if (!match) return { width: 1024, height: 768 };
  return {
    width: Math.max(1, Number(match[1])),
    height: Math.max(1, Number(match[2])),
  };
}

function parseVncUrl(value: string | null | undefined): { host: string; port: number; password: string | null } | null {
  const raw = value?.trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "vnc:") return null;
    const port = Number(parsed.port || "5900");
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
    return {
      host: parsed.hostname || "127.0.0.1",
      port,
      password: parsed.password ? decodeURIComponent(parsed.password) : null,
    };
  } catch {
    const match = /^(?:vnc:\/\/)?([^:/\s]+):(\d{1,5})$/i.exec(raw);
    if (!match) return null;
    const port = Number(match[2]);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
    return { host: match[1] ?? "127.0.0.1", port, password: null };
  }
}

function sanitizeVncUrl(value: string | null | undefined): string | null {
  const parsed = parseVncUrl(value);
  if (!parsed) return null;
  return `vnc://${parsed.host}:${parsed.port}`;
}

function sanitizeExternalVmRaw(value: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...value };
  for (const key of ["vncUrl", "vnc_url", "vnc", "displayUrl"]) {
    const sanitized = sanitizeVncUrl(asString(next[key]));
    if (sanitized) next[key] = sanitized;
  }
  return next;
}

function sanitizeVncUrlsInText(value: string): string {
  return value.replace(/vnc:\/\/(?:[^@\s/]*@)?([^:\s/]+):(\d{1,5})/gi, "vnc://$1:$2");
}

function commonLumePaths(env: NodeJS.ProcessEnv): string[] {
  const home = os.homedir();
  const entries = [
    env.ADE_LUME_PATH,
    ...String(env.PATH ?? "").split(path.delimiter).map((entry) => entry ? path.join(entry, "lume") : ""),
    path.join(home, ".local", "bin", "lume"),
    "/opt/homebrew/bin/lume",
    "/usr/local/bin/lume",
  ];
  return entries.filter((entry): entry is string => Boolean(entry?.trim()));
}

function resolveLumeCommand(env: NodeJS.ProcessEnv): string {
  for (const candidate of commonLumePaths(env)) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore inaccessible PATH entries
    }
  }
  return "lume";
}

export function createMacosVmService(args: CreateMacosVmServiceArgs) {
  const platform = args.platform ?? process.platform;
  const arch = args.arch ?? process.arch;
  const env = args.env ?? process.env;
  const runCommand = args.runCommand ?? defaultRunCommand;
  const directVncClient: DirectVncClient = args.directVncClient ?? {
    captureScreenshot: captureVncScreenshot,
    click: clickVnc,
    typeText: typeTextVnc,
  };
  const layout = resolveAdeLayout(args.projectRoot);
  const storeDir = path.join(layout.cacheDir, "macos-vms");
  const storePath = path.join(storeDir, MACOS_VM_STATE_FILE);
  const vncCredentialStorePath = path.join(layout.secretsDir, MACOS_VM_VNC_CREDENTIALS_FILE);
  const projectRoot = path.resolve(args.projectRoot);
  const lumeCommand = resolveLumeCommand(env);
  const mirrorSyncSessions = new Map<string, MirrorSyncSession>();
  let disposed = false;

  const emit = (payload: MacosVmEventPayload): void => {
    if (disposed) return;
    try {
      args.onEvent?.(payload);
    } catch (error) {
      args.logger.warn("macos_vm.event_emit_failed", {
        err: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const emitOperation = (
    operation: MacosVmOperation,
    state: "started" | "completed" | "failed",
    laneId: string | null,
    vmName: string | null,
    message: string,
  ): void => {
    emit({ type: "operation", operation, state, laneId, vmName, message, occurredAt: nowIso() });
  };

  const loadRecords = (): MacosVmRecord[] => readStoreFile(storePath).records;

  const saveRecords = (records: MacosVmRecord[]): void => {
    writeStoreFile(storePath, { version: 1, records });
  };

  const upsertRecord = (record: MacosVmRecord): MacosVmRecord => {
    const records = loadRecords();
    const index = records.findIndex((entry) => entry.id === record.id || entry.laneId === record.laneId);
    const next = { ...record, updatedAt: nowIso() };
    if (index >= 0) records[index] = next;
    else records.push(next);
    saveRecords(records);
    emit({ type: "vm-updated", vm: next });
    return next;
  };

  const removeRecord = (laneId: string): MacosVmRecord | null => {
    const records = loadRecords();
    const record = records.find((entry) => entry.laneId === laneId) ?? null;
    saveRecords(records.filter((entry) => entry.laneId !== laneId));
    return record;
  };

  const readVncPassword = (laneId: string, vmName: string): string | null => {
    const store = readVncCredentialStore(vncCredentialStorePath);
    const credential = store.credentials[vncCredentialKey(laneId, vmName)];
    return typeof credential?.password === "string" && credential.password.length > 0 ? credential.password : null;
  };

  const getOrCreateVncPassword = (lane: LaneContext, record: MacosVmRecord): string => {
    const store = readVncCredentialStore(vncCredentialStorePath);
    const key = vncCredentialKey(lane.id, record.name);
    const existing = store.credentials[key];
    if (existing?.password) return existing.password;
    const password = generateVncPassword();
    store.credentials[key] = {
      laneId: lane.id,
      vmName: record.name,
      password,
      updatedAt: nowIso(),
    };
    writeVncCredentialStore(vncCredentialStorePath, store);
    return password;
  };

  const removeVncPassword = (laneId: string, vmName: string): void => {
    const store = readVncCredentialStore(vncCredentialStorePath);
    const key = vncCredentialKey(laneId, vmName);
    if (!store.credentials[key]) return;
    delete store.credentials[key];
    writeVncCredentialStore(vncCredentialStorePath, store);
  };

  const runLume = async (lumeArgs: string[], timeoutMs = 60_000): Promise<CommandResult> => {
    const result = await runCommand(lumeCommand, lumeArgs, { timeoutMs, cwd: projectRoot });
    if (result.exitCode !== 0) {
      const detail = (result.stderr || result.stdout || `${lumeCommand} exited with code ${result.exitCode ?? "unknown"}`).trim();
      throw new Error(detail);
    }
    return result;
  };

  const launchLumeRun = async (lumeArgs: string[]): Promise<{ pid: number | null }> => {
    if (args.runCommand) {
      await runLume(lumeArgs, 5_000);
      return { pid: null };
    }
    return new Promise<{ pid: number | null }>((resolve, reject) => {
      const child = spawn(lumeCommand, lumeArgs, {
        cwd: projectRoot,
        detached: true,
        env: { ...process.env, ...env },
        stdio: "ignore",
      });
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else {
          child.unref();
          resolve({ pid: child.pid ?? null });
        }
      };
      const timeout = setTimeout(() => finish(), 750);
      child.once("error", (error) => finish(error));
      child.once("spawn", () => finish());
    });
  };

  const runHostCommand = async (command: string, commandArgs: string[], timeoutMs = 5_000): Promise<CommandResult> => {
    const result = await runCommand(command, commandArgs, { timeoutMs, cwd: projectRoot });
    if (result.exitCode !== 0) {
      const detail = (result.stderr || result.stdout || `${command} exited with code ${result.exitCode ?? "unknown"}`).trim();
      throw new Error(detail);
    }
    return result;
  };

  const requireMacWindowControl = (): void => {
    if (platform !== "darwin") {
      throw new Error("macOS VM window control is only available from ADE on macOS.");
    }
  };

  const detectLume = async (): Promise<{ available: boolean; version: string | null; detail: string }> => {
    if (platform !== "darwin") {
      return { available: false, version: null, detail: "macOS virtual machines are only available from ADE on macOS." };
    }
    if (arch !== "arm64") {
      return { available: false, version: null, detail: "macOS guests require an Apple silicon Mac." };
    }
    try {
      const result = await runCommand(lumeCommand, ["--version"], { timeoutMs: 4_000, cwd: projectRoot });
      if (result.exitCode === 0) {
        const version = (result.stdout || result.stderr).trim().split(/\r?\n/)[0] ?? null;
        return { available: true, version: version || null, detail: version || "Lume is installed." };
      }
      return {
        available: false,
        version: null,
        detail: (result.stderr || result.stdout || "Lume is not available.").trim(),
      };
    } catch (error) {
      return {
        available: false,
        version: null,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  };

  const providerStatus = async (): Promise<MacosVmProviderStatus> => {
    const lume = await detectLume();
    return {
      kind: "lume",
      available: lume.available,
      version: lume.version,
      detail: lume.available
        ? "Lume is available. ADE will use it as the first macOS VM provider."
        : lume.detail,
      docsUrl: LUME_INSTALL_DOCS,
    };
  };

  const toolStatuses = async (): Promise<MacosVmToolStatus[]> => {
    const lume = await detectLume();
    const appleSupported = platform === "darwin" && arch === "arm64";
    return [
      {
        name: "apple-virtualization",
        available: appleSupported,
        detail: appleSupported
          ? "This Mac can run Apple Virtualization macOS guests."
          : "macOS guests require Apple silicon on macOS.",
        installHint: "Use an Apple silicon Mac running macOS 13 or later.",
        docsUrl: APPLE_VIRTUALIZATION_DOCS,
      },
      {
        name: "lume",
        available: lume.available,
        detail: lume.available ? (lume.version ?? "Lume is installed.") : lume.detail,
        installHint: "Install Lume from Cua, then refresh this panel.",
        docsUrl: LUME_INSTALL_DOCS,
      },
    ];
  };

  const listExternalVms = async (): Promise<ExternalVmInfo[]> => {
    try {
      const result = await runLume(["ls", "--format", "json"], 20_000);
      return parseVmList(result.stdout);
    } catch (firstError) {
      try {
        const result = await runLume(["ls"], 20_000);
        return parseVmList(result.stdout);
      } catch {
        args.logger.debug("macos_vm.lume_list_failed", {
          err: firstError instanceof Error ? firstError.message : String(firstError),
        });
        return [];
      }
    }
  };

  const getExternalVm = async (name: string): Promise<ExternalVmInfo | null> => {
    try {
      const result = await runLume(["get", name, "--format", "json"], 20_000);
      return parseVmGet(result.stdout, name);
    } catch {
      const infos = await listExternalVms();
      return infos.find((info) => info.name === name) ?? null;
    }
  };

  const waitForExternalVm = async (
    name: string,
    accepts: (info: ExternalVmInfo | null) => boolean,
    timeoutMs: number,
  ): Promise<ExternalVmInfo | null> => {
    const deadline = Date.now() + timeoutMs;
    let info = await getExternalVm(name);
    while (!accepts(info) && Date.now() < deadline) {
      await delay(1_000);
      info = await getExternalVm(name);
    }
    return info;
  };

  const mergeExternalInfo = (record: MacosVmRecord, info: ExternalVmInfo | null): MacosVmRecord => ({
    ...record,
    state: info?.state ?? record.state,
    ipAddress: info ? info.ipAddress : record.ipAddress,
    vncUrl: info ? info.vncUrl : record.vncUrl,
    sshCommand: info ? (info.ipAddress ? `ssh lume@${info.ipAddress}` : null) : record.sshCommand,
    metadata: {
      ...record.metadata,
      ...(info?.raw ? { lume: info.raw } : {}),
    },
  });

  const directVncConnectionForRecord = (record: MacosVmRecord): DirectVncConnection | null => {
    if (record.state !== "running") return null;
    const parsed = parseVncUrl(record.vncUrl);
    if (!parsed) return null;
    const password = parsed.password ?? readVncPassword(record.laneId, record.name);
    if (!password) return null;
    return {
      host: parsed.host,
      port: parsed.port,
      password,
    };
  };

  const directVncTargetForRecord = (
    lane: LaneContext,
    record: MacosVmRecord,
    size?: { width: number; height: number } | null,
  ): MacosVmWindowTarget => {
    const displaySize = size ?? parseDisplaySize(record.display);
    return {
      laneId: lane.id,
      vmName: record.name,
      windowTitleQuery: record.name,
      processName: "direct-vnc",
      windowTitle: `${MACOS_VM_HEADLESS_WINDOW_TITLE}: ${record.name}`,
      frame: {
        x: 0,
        y: 0,
        width: displaySize.width,
        height: displaySize.height,
      },
      focusedAt: nowIso(),
    };
  };

  const parseWindowTarget = (
    stdout: string,
    laneId: string,
    vmName: string,
    windowTitleQuery: string,
  ): MacosVmWindowTarget => {
    const [processNameRaw, windowTitleRaw, xRaw, yRaw, widthRaw, heightRaw] = stdout.trim().split("\t");
    const frameValues = [xRaw, yRaw, widthRaw, heightRaw].map((value) => Number.parseInt(value ?? "", 10));
    const hasFrame = frameValues.every((value) => Number.isFinite(value));
    const frame: MacosVmWindowFrame | null = hasFrame
      ? {
          x: frameValues[0]!,
          y: frameValues[1]!,
          width: Math.max(1, frameValues[2]!),
          height: Math.max(1, frameValues[3]!),
        }
      : null;
    return {
      laneId,
      vmName,
      windowTitleQuery,
      processName: processNameRaw?.trim() || "unknown",
      windowTitle: windowTitleRaw?.trim() || windowTitleQuery,
      frame,
      focusedAt: nowIso(),
    };
  };

  const getLane = async (laneId: string): Promise<LaneContext> => {
    const normalized = laneId.trim();
    if (!normalized) throw new Error("A lane is required to use a macOS VM.");
    const lane = (await args.resolveLanes()).find((entry) => entry.id === normalized);
    if (!lane) throw new Error(`Lane ${normalized} was not found.`);
    return {
      id: lane.id,
      name: lane.name,
      worktreePath: path.resolve(lane.worktreePath),
    };
  };

  const mirrorPathForLane = (lane: LaneContext): string =>
    path.join(storeDir, "shares", sanitizeArtifactName(lane.id), "worktree");

  const sharePlanForLane = (lane: LaneContext): SharePlan => {
    const originalHostPath = path.resolve(lane.worktreePath);
    const adeLocalStatePath = path.join(originalHostPath, ".ade");
    const hasAdeLocalState = fs.existsSync(adeLocalStatePath);
    const mirrorPath = hasAdeLocalState ? mirrorPathForLane(lane) : null;
    return {
      hostPath: mirrorPath ?? originalHostPath,
      guestPath: LUME_GUEST_SHARED_PATH,
      readOnly: false,
      allowed: true,
      blockedReason: null,
      syncMode: hasAdeLocalState ? "sanitized-mirror" : "direct",
      mirrorPath,
      originalHostPath,
      excludedPaths: hasAdeLocalState ? [...MIRROR_SYNC_EXCLUDES] : [],
      detail: hasAdeLocalState
        ? "This lane root contains ADE local state, so ADE mounts a sanitized mirror and keeps code synced without exposing secrets or runtime databases to the VM."
        : "ADE mounts the lane root directly because no .ade directory was found.",
    };
  };

  const sharePolicyForLane = (lane: LaneContext): MacosVmSharePolicy => sharePlanForLane(lane);

  const rsyncMirror = async (
    source: string,
    destination: string,
    options: { deleteExcluded?: boolean } = {},
  ): Promise<void> => {
    fs.mkdirSync(destination, { recursive: true });
    const rsyncArgs = [
      "-rlpt",
      "--delete",
      ...(options.deleteExcluded ? ["--delete-excluded"] : []),
      ...MIRROR_SYNC_EXCLUDES.flatMap((pattern) => ["--exclude", pattern]),
      withTrailingSeparator(source),
      withTrailingSeparator(destination),
    ];
    await runHostCommand("rsync", rsyncArgs, 15 * 60_000);
  };

  const syncLaneToMirror = async (lane: LaneContext, mirrorPath: string): Promise<void> => {
    await rsyncMirror(lane.worktreePath, mirrorPath, { deleteExcluded: true });
  };

  const syncMirrorToLane = async (lane: LaneContext, mirrorPath: string): Promise<void> => {
    if (!fs.existsSync(mirrorPath)) return;
    await rsyncMirror(mirrorPath, lane.worktreePath);
  };

  const terminateLumeRunProcess = async (record: MacosVmRecord): Promise<void> => {
    const pid = typeof record.metadata.lumeRunPid === "number" && Number.isFinite(record.metadata.lumeRunPid)
      ? Math.trunc(record.metadata.lumeRunPid)
      : null;
    if (pid && pid > 0) {
      await runHostCommand("kill", ["-TERM", String(pid)], 5_000).catch((error) => {
        args.logger.warn("macos_vm.stop_kill_pid_failed", {
          vmName: record.name,
          pid,
          err: error instanceof Error ? error.message : String(error),
        });
      });
      await delay(1_000);
    }
    const afterTerm = await getExternalVm(record.name).catch(() => null);
    if (afterTerm?.state === "running") {
      await runHostCommand("pkill", ["-TERM", "-f", `lume.*run ${record.name}`], 5_000).catch((error) => {
        args.logger.warn("macos_vm.stop_pkill_failed", {
          vmName: record.name,
          err: error instanceof Error ? error.message : String(error),
        });
      });
      await delay(1_500);
    }
    const afterPkill = await getExternalVm(record.name).catch(() => null);
    if (pid && pid > 0 && afterPkill?.state === "running") {
      await runHostCommand("kill", ["-KILL", String(pid)], 5_000).catch((error) => {
        args.logger.warn("macos_vm.stop_kill_force_failed", {
          vmName: record.name,
          pid,
          err: error instanceof Error ? error.message : String(error),
        });
      });
    }
  };

  const startMirrorSync = (lane: LaneContext, mirrorPath: string): void => {
    const existing = mirrorSyncSessions.get(lane.id);
    if (existing && !existing.disposed) return;
    const session: MirrorSyncSession = {
      laneId: lane.id,
      laneRoot: lane.worktreePath,
      mirrorPath,
      laneWatcher: null,
      mirrorWatcher: null,
      laneTimer: null,
      mirrorTimer: null,
      suppressUntilMs: 0,
      syncing: false,
      disposed: false,
    };
    const schedule = (direction: "lane-to-mirror" | "mirror-to-lane"): void => {
      if (session.disposed || session.syncing || Date.now() < session.suppressUntilMs) return;
      const key = direction === "lane-to-mirror" ? "laneTimer" : "mirrorTimer";
      const oppositeKey = direction === "lane-to-mirror" ? "mirrorTimer" : "laneTimer";
      if (session[key]) clearTimeout(session[key]);
      if (session[oppositeKey]) {
        clearTimeout(session[oppositeKey]);
        session[oppositeKey] = null;
      }
      session[key] = setTimeout(() => {
        session[key] = null;
        if (session.disposed || session.syncing) return;
        if (session[oppositeKey]) {
          clearTimeout(session[oppositeKey]);
          session[oppositeKey] = null;
        }
        session.syncing = true;
        session.suppressUntilMs = Date.now() + 1_500;
        const sync = direction === "lane-to-mirror"
          ? syncLaneToMirror(lane, mirrorPath)
          : syncMirrorToLane(lane, mirrorPath);
        void sync.catch((error) => {
          args.logger.warn("macos_vm.mirror_sync_failed", {
            laneId: lane.id,
            direction,
            err: error instanceof Error ? error.message : String(error),
          });
        }).finally(() => {
          session.syncing = false;
          session.suppressUntilMs = Date.now() + 1_500;
        });
      }, 750);
    };
    try {
      session.laneWatcher = fs.watch(lane.worktreePath, { recursive: true }, (_event, filename) => {
        if (isIgnoredMirrorSyncPath(filename)) return;
        schedule("lane-to-mirror");
      });
    } catch (error) {
      args.logger.warn("macos_vm.lane_watch_failed", {
        laneId: lane.id,
        err: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      fs.mkdirSync(mirrorPath, { recursive: true });
      session.mirrorWatcher = fs.watch(mirrorPath, { recursive: true }, (_event, filename) => {
        if (isIgnoredMirrorSyncPath(filename)) return;
        schedule("mirror-to-lane");
      });
    } catch (error) {
      args.logger.warn("macos_vm.mirror_watch_failed", {
        laneId: lane.id,
        err: error instanceof Error ? error.message : String(error),
      });
    }
    mirrorSyncSessions.set(lane.id, session);
  };

  const stopMirrorSync = async (lane: LaneContext, mirrorPath: string | null | undefined, flush = false): Promise<void> => {
    const session = mirrorSyncSessions.get(lane.id);
    if (session) {
      session.disposed = true;
      if (session.laneTimer) clearTimeout(session.laneTimer);
      if (session.mirrorTimer) clearTimeout(session.mirrorTimer);
      session.laneWatcher?.close();
      session.mirrorWatcher?.close();
      mirrorSyncSessions.delete(lane.id);
    }
    if (flush && mirrorPath) {
      await syncMirrorToLane(lane, mirrorPath);
    }
  };

  const ensureShareReady = async (lane: LaneContext): Promise<SharePlan> => {
    const share = sharePlanForLane(lane);
    if (share.syncMode === "sanitized-mirror" && share.mirrorPath) {
      await syncLaneToMirror(lane, share.mirrorPath);
      startMirrorSync(lane, share.mirrorPath);
    }
    return share;
  };

  const requireProviderReady = async (): Promise<void> => {
    const provider = await providerStatus();
    if (!provider.available) {
      throw new Error(`${provider.detail} Install Lume to provision and run lane VMs.`);
    }
  };

  const recordForLane = (lane: LaneContext, config: Partial<MacosVmProvisionArgs & MacosVmStartArgs> = {}): MacosVmRecord => {
    const existing = loadRecords().find((entry) => entry.laneId === lane.id);
    const share = sharePlanForLane(lane);
    const now = nowIso();
    const name = sanitizeVmName(config.name?.trim() || existing?.name || defaultVmName(projectRoot, lane));
    return {
      id: existing?.id ?? `macos-vm:${lane.id}`,
      provider: "lume",
      name,
      laneId: lane.id,
      laneName: lane.name,
      laneRoot: lane.worktreePath,
      state: existing?.state ?? "not_created",
      cpuCores: asPositiveInteger(config.cpuCores, existing?.cpuCores ?? DEFAULT_CPU_CORES),
      memory: normalizeSize(config.memory, existing?.memory ?? DEFAULT_MEMORY),
      diskSize: normalizeSize(config.diskSize, existing?.diskSize ?? DEFAULT_DISK_SIZE),
      display: normalizeDisplay(config.display, existing?.display ?? DEFAULT_DISPLAY),
      guestSharedPath: LUME_GUEST_SHARED_PATH,
      sharedDirectory: share.hostPath,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastStartedAt: existing?.lastStartedAt ?? null,
      lastStoppedAt: existing?.lastStoppedAt ?? null,
      ipAddress: existing?.ipAddress ?? null,
      sshCommand: existing?.sshCommand ?? null,
      vncUrl: existing?.vncUrl ?? null,
      lastError: existing?.lastError ?? null,
      metadata: {
        ...(existing?.metadata ?? {}),
        shareMode: share.syncMode,
        originalHostPath: share.originalHostPath,
        mirrorPath: share.mirrorPath,
        excludedPaths: share.excludedPaths,
        nativeHelperPlanned: true,
        appleDocs: APPLE_VIRTUALIZATION_DOCS,
      },
    };
  };

  const getStatus = async (statusArgs: MacosVmStatusArgs = {}): Promise<MacosVmStatus> => {
    const external = await listExternalVms();
    const externalByName = new Map(external.map((info) => [info.name, info]));
    const records = loadRecords().map((record) => mergeExternalInfo(record, externalByName.get(record.name) ?? null));
    saveRecords(records);
    const laneId = statusArgs.laneId?.trim() || null;
    const status: MacosVmStatus = {
      platform,
      arch,
      supported: platform === "darwin" && arch === "arm64",
      checkedAt: nowIso(),
      activeProvider: await providerStatus(),
      tools: await toolStatuses(),
      laneVm: laneId ? records.find((record) => record.laneId === laneId) ?? null : null,
      vms: records,
      docs: {
        appleVirtualization: APPLE_VIRTUALIZATION_DOCS,
        appleSharedDirectories: APPLE_SHARED_DIRECTORIES_DOCS,
        lume: LUME_DOCS,
      },
    };
    emit({ type: "status", status });
    return status;
  };

  const provision = async (provisionArgs: MacosVmProvisionArgs): Promise<MacosVmRecord> => {
    const lane = await getLane(provisionArgs.laneId);
    await ensureShareReady(lane);
    await requireProviderReady();

    let record = recordForLane(lane, provisionArgs);
    const existingInfo = await getExternalVm(record.name);
    if (existingInfo && !provisionArgs.force) {
      record = upsertRecord(mergeExternalInfo({ ...record, state: existingInfo.state }, existingInfo));
      emitOperation("provision", "completed", lane.id, record.name, "macOS VM already exists for this lane.");
      return record;
    }

    emitOperation("provision", "started", lane.id, record.name, "Provisioning lane macOS VM.");
    record = upsertRecord({ ...record, state: "creating", lastError: null });
    try {
      const mode = provisionArgs.mode === "create" ? "create" : "pull-image";
      if (mode === "pull-image") {
        const image = provisionArgs.sourceImage?.trim() || DEFAULT_PULL_IMAGE;
        await runLume(["pull", image, record.name], 60 * 60_000);
        await runLume([
          "set",
          record.name,
          "--cpu",
          String(record.cpuCores),
          "--memory",
          record.memory,
          "--disk-size",
          record.diskSize,
          "--display",
          record.display,
        ], 10 * 60_000);
      } else {
        const ipsw = provisionArgs.ipsw?.trim() || "latest";
        const createArgs = [
          "create",
          record.name,
          "--os",
          "macOS",
          "--ipsw",
          ipsw,
          "--cpu",
          String(record.cpuCores),
          "--memory",
          record.memory,
          "--disk-size",
          record.diskSize,
          "--display",
          record.display,
        ];
        const unattendedPreset = provisionArgs.unattendedPreset?.trim();
        if (unattendedPreset) createArgs.push("--unattended", unattendedPreset);
        await runLume(createArgs, 90 * 60_000);
      }
      const info = await getExternalVm(record.name);
      record = upsertRecord(mergeExternalInfo({ ...record, state: info?.state ?? "stopped", lastError: null }, info));
      emitOperation("provision", "completed", lane.id, record.name, "macOS VM is ready for this lane.");
      return record;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      record = upsertRecord({ ...record, state: "failed", lastError: message });
      emitOperation("provision", "failed", lane.id, record.name, message);
      throw error;
    }
  };

  const start = async (startArgs: MacosVmStartArgs): Promise<MacosVmRecord> => {
    const lane = await getLane(startArgs.laneId);
    await requireProviderReady();
    let record = recordForLane(lane, startArgs);
    const info = await getExternalVm(record.name);
    if (!info && startArgs.createIfMissing) {
      record = await provision({ ...startArgs, laneId: lane.id });
    } else if (!info) {
      throw new Error("Provision a macOS VM for this lane before starting it.");
    } else {
      await ensureShareReady(lane);
      record = mergeExternalInfo(record, info);
      if (info.state === "running") {
        record = upsertRecord({
          ...record,
          state: "running",
          lastStartedAt: record.lastStartedAt ?? nowIso(),
          lastError: null,
        });
        emitOperation("start", "completed", lane.id, record.name, "macOS VM is already running with the lane mounted.");
        return record;
      }
    }

    emitOperation("start", "started", lane.id, record.name, "Starting lane macOS VM.");
    record = upsertRecord({ ...record, state: "starting", lastError: null });
    try {
      const runArgs = ["run", record.name, "--shared-dir", record.sharedDirectory];
      if (startArgs.openDisplay === false) {
        const vncPassword = getOrCreateVncPassword(lane, record);
        runArgs.push("--no-display", "--vnc-password", vncPassword);
        record = upsertRecord({
          ...record,
          metadata: {
            ...record.metadata,
            controlBackend: "direct-vnc",
            vncCredentialStored: true,
          },
        });
      }
      const launch = await launchLumeRun(runArgs);
      if (launch.pid) {
        record = upsertRecord({
          ...record,
          metadata: {
            ...record.metadata,
            lumeRunPid: launch.pid,
          },
        });
      }
      const nextInfo = await waitForExternalVm(record.name, (info) => info?.state === "running", 120_000);
      if (nextInfo?.state !== "running") {
        throw new Error(`Timed out waiting for macOS VM to report running: ${record.name}`);
      }
      record = upsertRecord(mergeExternalInfo({
        ...record,
        state: nextInfo?.state ?? "running",
        lastStartedAt: nowIso(),
        lastError: null,
      }, nextInfo));
      emitOperation("start", "completed", lane.id, record.name, "macOS VM started with the lane mounted.");
      return record;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      record = upsertRecord({ ...record, state: "failed", lastError: message });
      emitOperation("start", "failed", lane.id, record.name, message);
      throw error;
    }
  };

  const stop = async (stopArgs: MacosVmStopArgs): Promise<MacosVmRecord | null> => {
    const lane = await getLane(stopArgs.laneId);
    const record = loadRecords().find((entry) => entry.laneId === lane.id) ?? null;
    if (!record) return null;
    await requireProviderReady();
    emitOperation("stop", "started", lane.id, record.name, "Stopping lane macOS VM.");
    const stopping = upsertRecord({ ...record, state: "stopping", lastError: null });
    try {
      const stopCommand = ["stop", record.name];
      let stopError: Error | null = null;
      try {
        await runLume(stopCommand, 5 * 60_000);
      } catch (error) {
        stopError = error instanceof Error ? error : new Error(String(error));
        await terminateLumeRunProcess(stopping);
      }
      const stoppedInfo = await waitForExternalVm(
        record.name,
        (info) => !info || info.state === "stopped" || info.state === "not_created",
        30_000,
      );
      if (stoppedInfo?.state === "running") {
        throw stopError ?? new Error(`Timed out waiting for macOS VM to stop: ${record.name}`);
      }
      await stopMirrorSync(lane, stopping.metadata.mirrorPath as string | null | undefined, true);
      const next = upsertRecord(mergeExternalInfo({
        ...stopping,
        state: stoppedInfo?.state ?? "stopped",
        lastStoppedAt: nowIso(),
        lastError: null,
        metadata: {
          ...stopping.metadata,
          lumeRunPid: null,
        },
      }, stoppedInfo));
      emitOperation("stop", "completed", lane.id, record.name, "macOS VM stopped.");
      return next;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      upsertRecord({ ...stopping, state: "failed", lastError: message });
      emitOperation("stop", "failed", lane.id, record.name, message);
      throw error;
    }
  };

  const deleteVm = async (deleteArgs: MacosVmDeleteArgs): Promise<{ deleted: boolean; previous: MacosVmRecord | null }> => {
    const lane = await getLane(deleteArgs.laneId);
    const record = loadRecords().find((entry) => entry.laneId === lane.id) ?? null;
    if (!record) return { deleted: false, previous: null };
    await requireProviderReady();
    emitOperation("delete", "started", lane.id, record.name, "Deleting lane macOS VM.");
    try {
      const deleteCommand = ["delete", record.name];
      if (deleteArgs.force) deleteCommand.push("--force");
      await runLume(deleteCommand, 10 * 60_000);
      await stopMirrorSync(lane, record.metadata.mirrorPath as string | null | undefined, true);
      removeVncPassword(lane.id, record.name);
      removeRecord(lane.id);
      emitOperation("delete", "completed", lane.id, record.name, "macOS VM deleted.");
      return { deleted: true, previous: record };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      upsertRecord({ ...record, lastError: message });
      emitOperation("delete", "failed", lane.id, record.name, message);
      throw error;
    }
  };

  const controlRecordForLane = async (
    laneId: string,
  ): Promise<{ lane: LaneContext; record: MacosVmRecord }> => {
    const lane = await getLane(laneId);
    const record = loadRecords().find((entry) => entry.laneId === lane.id) ?? recordForLane(lane);
    const currentInfo = await getExternalVm(record.name).catch(() => null);
    return { lane, record: mergeExternalInfo(record, currentInfo) };
  };

  const focusWindow = async (focusArgs: MacosVmFocusWindowArgs): Promise<MacosVmWindowTarget> => {
    const { lane, record } = await controlRecordForLane(focusArgs.laneId);
    if (directVncConnectionForRecord(record)) {
      const target = directVncTargetForRecord(lane, record);
      emitOperation("focus-window", "completed", lane.id, record.name, "Selected headless macOS VM VNC target.");
      return target;
    }
    requireMacWindowControl();
    const explicitWindowQuery = Boolean(focusArgs.windowTitleQuery?.trim());
    const query = focusArgs.windowTitleQuery?.trim() || record.name;
    const allowVncFallback = !explicitWindowQuery && Boolean(record.vncUrl || record.state === "running");
    const restrictToVmViewer = !explicitWindowQuery;
    const script = [
      `set queryText to ${appleScriptString(query)}`,
      `set allowVncFallback to ${allowVncFallback ? "true" : "false"}`,
      `set restrictToVmViewer to ${restrictToVmViewer ? "true" : "false"}`,
      "tell application \"System Events\"",
      "  repeat with proc in (application processes whose background only is false)",
      "    set procName to name of proc as text",
      "    if (not restrictToVmViewer) or procName is \"Screen Sharing\" or procName is \"Lume\" then",
      "      repeat with targetWindow in windows of proc",
      "        set windowTitle to \"\"",
      "        try",
      "          set windowTitle to name of targetWindow as text",
      "        end try",
      "        if windowTitle contains queryText then",
      "          set frontmost of proc to true",
      "          try",
      "            perform action \"AXRaise\" of targetWindow",
      "          end try",
      "          set windowPosition to {0, 0}",
      "          set windowSize to {0, 0}",
      "          try",
      "            set windowPosition to position of targetWindow",
      "            set windowSize to size of targetWindow",
      "          end try",
      "          return procName & tab & windowTitle & tab & ((item 1 of windowPosition) as text) & tab & ((item 2 of windowPosition) as text) & tab & ((item 1 of windowSize) as text) & tab & ((item 2 of windowSize) as text)",
      "        end if",
      "      end repeat",
      "      end if",
      "  end repeat",
      "  if allowVncFallback then",
      "    set fallbackCount to 0",
      "    set fallbackRow to \"\"",
      "    repeat with proc in (application processes whose background only is false)",
      "      set procName to name of proc as text",
      "      if procName is \"Screen Sharing\" or procName is \"Lume\" then",
      "        repeat with targetWindow in windows of proc",
      "          set windowTitle to \"\"",
      "          try",
      "            set windowTitle to name of targetWindow as text",
      "          end try",
      "          set isVncWindow to false",
      "          if windowTitle is \"Virtualization\" or windowTitle contains \"VNC\" or windowTitle contains \"vnc://\" then",
      "            set isVncWindow to true",
      "          end if",
      "          if isVncWindow then",
      "            set fallbackCount to fallbackCount + 1",
      "            if fallbackCount is 1 then",
      "              set frontmost of proc to true",
      "              try",
      "                perform action \"AXRaise\" of targetWindow",
      "              end try",
      "              set windowPosition to {0, 0}",
      "              set windowSize to {0, 0}",
      "              try",
      "                set windowPosition to position of targetWindow",
      "                set windowSize to size of targetWindow",
      "              end try",
      "              set fallbackRow to procName & tab & windowTitle & tab & ((item 1 of windowPosition) as text) & tab & ((item 2 of windowPosition) as text) & tab & ((item 1 of windowSize) as text) & tab & ((item 2 of windowSize) as text)",
      "            end if",
      "          end if",
      "        end repeat",
      "      end if",
      "    end repeat",
      "    if fallbackCount is 1 then return fallbackRow",
      "    if fallbackCount > 1 then error \"Multiple visible Lume/VNC macOS VM windows matched. Pass a windowTitleQuery to select one.\"",
      "  end if",
      "end tell",
      `error "No visible macOS VM window matched " & ${appleScriptString(query)}`,
    ].join("\n");
    const result = await runHostCommand("osascript", ["-e", script], 8_000);
    const target = parseWindowTarget(result.stdout, lane.id, record.name, query);
    emitOperation("focus-window", "completed", lane.id, record.name, `Focused macOS VM window "${target.windowTitle}".`);
    return target;
  };

  const captureScreenshot = async (
    captureArgs: MacosVmCaptureScreenshotArgs,
  ): Promise<MacosVmCaptureScreenshotResult> => {
    const { lane, record } = await controlRecordForLane(captureArgs.laneId);
    const directVnc = directVncConnectionForRecord(record);
    if (directVnc) {
      const screenshotDir = path.join(layout.artifactsDir, "macos-vms", lane.id);
      fs.mkdirSync(screenshotDir, { recursive: true });
      const outputPath = captureArgs.outputPath?.trim()
        ? path.resolve(captureArgs.outputPath)
        : path.join(screenshotDir, `${sanitizeArtifactName(record.name)}-${Date.now()}.png`);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      const screenshot = await directVncClient.captureScreenshot(directVnc, 15_000);
      fs.writeFileSync(outputPath, screenshot.pngData);
      const target = directVncTargetForRecord(lane, record, screenshot);
      emitOperation("screenshot", "completed", lane.id, record.name, "Captured macOS VM screenshot through headless VNC.");
      return {
        ok: true,
        laneId: lane.id,
        vmName: record.name,
        path: outputPath,
        dataUrl: readPngDataUrl(outputPath),
        capturedAt: nowIso(),
        captureMode: "direct-vnc",
        window: target,
      };
    }
    requireMacWindowControl();
    const target = await focusWindow(captureArgs);
    const screenshotDir = path.join(layout.artifactsDir, "macos-vms", target.laneId);
    fs.mkdirSync(screenshotDir, { recursive: true });
    const outputPath = captureArgs.outputPath?.trim()
      ? path.resolve(captureArgs.outputPath)
      : path.join(screenshotDir, `${sanitizeArtifactName(target.vmName)}-${Date.now()}.png`);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    let captureMode: MacosVmCaptureScreenshotResult["captureMode"] = "full-screen";
    if (target.frame) {
      const rect = [
        Math.max(0, target.frame.x),
        Math.max(0, target.frame.y),
        target.frame.width,
        target.frame.height,
      ].join(",");
      try {
        await runHostCommand("screencapture", ["-x", "-R", rect, outputPath], 10_000);
        captureMode = "window-region";
      } catch (error) {
        args.logger.warn("macos_vm.window_region_screenshot_failed", {
          vmName: target.vmName,
          err: error instanceof Error ? error.message : String(error),
        });
        await runHostCommand("screencapture", ["-x", outputPath], 10_000);
      }
    } else {
      await runHostCommand("screencapture", ["-x", outputPath], 10_000);
    }

    emitOperation("screenshot", "completed", target.laneId, target.vmName, "Captured macOS VM screenshot.");
    return {
      ok: true,
      laneId: target.laneId,
      vmName: target.vmName,
      path: outputPath,
      dataUrl: readPngDataUrl(outputPath),
      capturedAt: nowIso(),
      captureMode,
      window: target,
    };
  };

  const click = async (clickArgs: MacosVmClickArgs): Promise<{ ok: true; window: MacosVmWindowTarget; x: number; y: number }> => {
    const { lane, record } = await controlRecordForLane(clickArgs.laneId);
    const directVnc = directVncConnectionForRecord(record);
    if (directVnc) {
      const result = await directVncClient.click(directVnc, clickArgs.x, clickArgs.y, 10_000);
      const target = directVncTargetForRecord(lane, record, result);
      emitOperation("click", "completed", lane.id, record.name, `Clicked macOS VM through headless VNC at ${result.x},${result.y}.`);
      return { ok: true, window: target, x: result.x, y: result.y };
    }
    requireMacWindowControl();
    const target = await focusWindow(clickArgs);
    const coordinateSpace = clickArgs.coordinateSpace === "screen" ? "screen" : "window";
    if (coordinateSpace === "window" && !target.frame) {
      throw new Error("Cannot convert window-relative coordinates because ADE could not read the VM window frame.");
    }
    const screenX = Math.round(coordinateSpace === "screen" ? clickArgs.x : target.frame!.x + clickArgs.x);
    const screenY = Math.round(coordinateSpace === "screen" ? clickArgs.y : target.frame!.y + clickArgs.y);
    const script = `tell application "System Events" to click at {${screenX}, ${screenY}}`;
    await runHostCommand("osascript", ["-e", script], 3_000);
    emitOperation("click", "completed", target.laneId, target.vmName, `Clicked macOS VM at ${screenX},${screenY}.`);
    return { ok: true, window: target, x: screenX, y: screenY };
  };

  const typeText = async (typeArgs: MacosVmTypeTextArgs): Promise<{ ok: true; window: MacosVmWindowTarget }> => {
    const text = typeArgs.text;
    if (!text.trim().length) throw new Error("Text is required.");
    if (text.length > 20_000) throw new Error("Text is too long for macOS VM typing.");
    const { lane, record } = await controlRecordForLane(typeArgs.laneId);
    const directVnc = directVncConnectionForRecord(record);
    if (directVnc) {
      const result = await directVncClient.typeText(directVnc, text, Math.max(3_000, Math.min(30_000, text.length * 20)));
      const target = directVncTargetForRecord(lane, record, result);
      emitOperation("type-text", "completed", lane.id, record.name, "Typed text into macOS VM through headless VNC.");
      return { ok: true, window: target };
    }
    requireMacWindowControl();
    const target = await focusWindow(typeArgs);
    const script = `tell application "System Events" to keystroke ${appleScriptString(text)}`;
    await runHostCommand("osascript", ["-e", script], Math.max(3_000, Math.min(30_000, text.length * 20)));
    emitOperation("type-text", "completed", target.laneId, target.vmName, "Typed text into macOS VM window.");
    return { ok: true, window: target };
  };

  const contextItemForSelection = (
    args: {
      lane: LaneContext;
      record: MacosVmRecord;
      x: number;
      y: number;
      coordinateSpace: "window" | "screen";
      target: MacosVmWindowTarget;
      screenshot: MacosVmCaptureScreenshotResult | null;
      screenshotDataUrl: string | null;
      selectedAt: string;
    },
  ): MacosVmContextItem => {
    const selectedPoint = { x: args.x, y: args.y, coordinateSpace: args.coordinateSpace };
    return {
      kind: "macos_vm_target",
      id: `macos-vm-target:${args.lane.id}:${args.record.name}:point:${args.x}:${args.y}:${args.selectedAt}`,
      laneId: args.lane.id,
      laneName: args.lane.name,
      vmName: args.record.name,
      provider: args.record.provider,
      state: args.record.state,
      hostLanePath: args.record.laneRoot,
      guestLanePath: args.record.guestSharedPath,
      runCommand: `lume run ${shellQuote(args.record.name)} --shared-dir ${shellQuote(args.record.sharedDirectory)}`,
      sshCommand: args.record.sshCommand,
      vncUrl: args.record.vncUrl,
      windowTitleQuery: args.target.windowTitleQuery,
      screenshotDataUrl: args.screenshotDataUrl,
      selectedAt: args.selectedAt,
      metadata: {
        ipAddress: args.record.ipAddress,
        display: args.record.display,
        cpuCores: args.record.cpuCores,
        memory: args.record.memory,
        window: args.target,
        selectedPoint,
        screenshotPath: args.screenshot?.path ?? null,
        screenshotCaptureMode: args.screenshot?.captureMode ?? null,
        sharedDirectory: args.record.sharedDirectory,
        shareMode: args.record.metadata.shareMode ?? "direct",
        excludedPaths: args.record.metadata.excludedPaths ?? [],
        providerDocs: LUME_DOCS,
        appleVirtualizationDocs: APPLE_VIRTUALIZATION_DOCS,
        sharedDirectoryDocs: APPLE_SHARED_DIRECTORIES_DOCS,
        controlModel: "Use ADE macos-vm screenshot/click/type/select actions. ADE uses direct headless VNC when it has a managed VNC credential, then falls back to a visible VM viewer window.",
      },
    };
  };

  const selectPoint = async (selectArgs: MacosVmSelectPointArgs): Promise<MacosVmSelectPointResult> => {
    const { lane, record } = await controlRecordForLane(selectArgs.laneId);
    const coordinateSpace = selectArgs.coordinateSpace === "screen" ? "screen" : "window";
    const target = await focusWindow(selectArgs);
    if (coordinateSpace === "window" && !target.frame) {
      throw new Error("Cannot select window-relative coordinates because ADE could not read the VM window frame.");
    }
    const screenshot = selectArgs.includeScreenshot === false
      ? null
      : await captureScreenshot(selectArgs);
    const screenshotDataUrl = screenshot
      ? readPngDataUrl(screenshot.path)
      : null;
    const selectedAt = nowIso();
    const item = contextItemForSelection({
      lane,
      record,
      x: selectArgs.x,
      y: selectArgs.y,
      coordinateSpace,
      target,
      screenshot,
      screenshotDataUrl,
      selectedAt,
    });
    emitOperation("select-point", "completed", lane.id, record.name, `Selected macOS VM point ${selectArgs.x},${selectArgs.y}.`);
    return { item, source: screenshot?.captureMode === "direct-vnc" ? "direct-vnc" : "coordinate-fallback", screenshot };
  };

  const getAgentGuide = async (guideArgs: MacosVmAgentGuideArgs): Promise<MacosVmAgentGuide> => {
    const lane = await getLane(guideArgs.laneId);
    const record = loadRecords().find((entry) => entry.laneId === lane.id) ?? recordForLane(lane);
    const currentInfo = await getExternalVm(record.name).catch(() => null);
    const merged = mergeExternalInfo(record, currentInfo);
    const runCommandText = `lume run ${shellQuote(merged.name)} --shared-dir ${shellQuote(merged.sharedDirectory)}`;
    const sshLine = merged.sshCommand
      ? `- If SSH is enabled in the guest, connect with \`${merged.sshCommand}\` and work from \`${merged.guestSharedPath}\`.`
      : "- If SSH is enabled in the guest, get the VM IP from ADE or `lume get`, then SSH into the guest and work from `/Volumes/My Shared Files`.";
    const selectedAt = nowIso();
    const target: MacosVmContextItem = {
      kind: "macos_vm_target",
      id: `macos-vm-target:${lane.id}:${merged.name}`,
      laneId: lane.id,
      laneName: lane.name,
      vmName: merged.name,
      provider: merged.provider,
      state: merged.state,
      hostLanePath: merged.laneRoot,
      guestLanePath: merged.guestSharedPath,
      runCommand: runCommandText,
      sshCommand: merged.sshCommand,
      vncUrl: merged.vncUrl,
      windowTitleQuery: merged.name,
      selectedAt,
      metadata: {
        ipAddress: merged.ipAddress,
        display: merged.display,
        cpuCores: merged.cpuCores,
        memory: merged.memory,
        sharedDirectory: merged.sharedDirectory,
        shareMode: merged.metadata.shareMode ?? "direct",
        excludedPaths: merged.metadata.excludedPaths ?? [],
        providerDocs: LUME_DOCS,
        appleVirtualizationDocs: APPLE_VIRTUALIZATION_DOCS,
        sharedDirectoryDocs: APPLE_SHARED_DIRECTORIES_DOCS,
        controlModel: "Use ADE macos-vm screenshot/click/type actions. ADE uses direct headless VNC when it has a managed VNC credential, then falls back to a visible VM viewer window.",
      },
    };
    const text = [
      `Use the lane-tied macOS VM "${merged.name}" for GUI or isolated macOS validation.`,
      "",
      `- ADE lane: ${lane.name} (${lane.id})`,
      `- Host lane path: ${merged.laneRoot}`,
      `- Shared directory mounted into the VM: ${merged.sharedDirectory}`,
      `- Guest mount path: ${merged.guestSharedPath}`,
      `- Start command if needed: \`${runCommandText}\``,
      sshLine,
      "- For GUI computer use, prefer ADE's macos-vm screenshot/click/type tools. They target the headless VNC endpoint when available, then fall back to a visible Lume/VNC/macOS VM window.",
      `- ADE VM control commands: \`ade --socket macos-vm screenshot --lane ${shellQuote(lane.id)} --text\`, \`ade --socket macos-vm click --lane ${shellQuote(lane.id)} <x> <y>\`, and \`ade --socket macos-vm type --lane ${shellQuote(lane.id)} --value <text>\`. Coordinates are window-relative by default.`,
      `- To attach a screenshot-backed point context, use \`ade --socket macos-vm select --lane ${shellQuote(lane.id)} --x <x> --y <y> --text\`.`,
      merged.metadata.shareMode === "sanitized-mirror"
        ? "- This lane contains ADE local state, so ADE mounts a sanitized mirror and syncs code changes between the host lane and the VM without exposing secrets, runtime databases, or generated local history."
        : "- Keep edits inside the mounted lane folder so host and guest stay in sync through VirtioFS.",
      "- Do not copy host secrets into the VM. ADE excludes `.ade/secrets`, ADE runtime databases, caches, transcripts, generated memory/history, and `.git` from sanitized VM shares.",
    ].join("\n");
    emitOperation("agent-guide", "completed", lane.id, merged.name, "Built macOS VM agent guidance.");
    return { laneId: lane.id, vmName: merged.name, text, target };
  };

  return {
    getStatus,
    provision,
    start,
    stop,
    delete: deleteVm,
    getAgentGuide,
    focusWindow,
    captureScreenshot,
    click,
    selectPoint,
    typeText,
    getSharePolicy: async (laneIdOrArgs: string | { laneId?: string | null }): Promise<MacosVmSharePolicy> => {
      const laneId = typeof laneIdOrArgs === "string" ? laneIdOrArgs : laneIdOrArgs.laneId ?? "";
      return sharePolicyForLane(await getLane(laneId));
    },
    dispose: () => {
      disposed = true;
      for (const session of mirrorSyncSessions.values()) {
        session.disposed = true;
        if (session.laneTimer) clearTimeout(session.laneTimer);
        if (session.mirrorTimer) clearTimeout(session.mirrorTimer);
        session.laneWatcher?.close();
        session.mirrorWatcher?.close();
      }
      mirrorSyncSessions.clear();
    },
  };
}
