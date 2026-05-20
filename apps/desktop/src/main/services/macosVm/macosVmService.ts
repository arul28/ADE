import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import type { FSWatcher } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import {
  type MacosVmAgentGuide,
  type MacosVmAgentGuideArgs,
  type MacosVmCaptureScreenshotArgs,
  type MacosVmCaptureScreenshotResult,
  type MacosVmClickArgs,
  type MacosVmContextItem,
  type MacosVmDeleteArgs,
  type MacosVmDisplaySession,
  type MacosVmDisplaySessionArgs,
  type MacosVmDownloadProgress,
  type MacosVmEventPayload,
  type MacosVmFocusWindowArgs,
  type MacosVmGlobalLease,
  type MacosVmGuestReadiness,
  type MacosVmInstallRuntimeArgs,
  type MacosVmLifecycleState,
  type MacosVmOperation,
  type MacosVmProviderStatus,
  type MacosVmProvisionArgs,
  type MacosVmRecord,
  type MacosVmRestartArgs,
  type MacosVmRuntimeInstallStatus,
  type MacosVmSelectPointArgs,
  type MacosVmSelectPointResult,
  type MacosVmSetCredentialsArgs,
  type MacosVmGetCredentialsArgs,
  type MacosVmShareEntry,
  type MacosVmSharePolicy,
  type MacosVmStartArgs,
  type MacosVmStorageInfo,
  type MacosVmStatus,
  type MacosVmStatusArgs,
  type MacosVmStopArgs,
  type MacosVmStoredCredentialsSummary,
  type MacosVmToolStatus,
  type MacosVmTypeTextArgs,
  type MacosVmWindowFrame,
  type MacosVmWindowTarget,
  type MacosVmWipeArgs,
  type MacosVmWipeResult,
} from "../../../shared/types";
import { resolveAdeLayout } from "../../../shared/adeLayout";
import type { Logger } from "../logging/logger";
import {
  captureVncScreenshot,
  clickVnc,
  encodeRgbaPng,
  type DirectVncConnection,
  type DirectVncScreenshot,
  typeTextVnc,
} from "./rfbDirectClient";
import { createCredentialsStore, type CredentialsStore } from "./credentialsStore";
import {
  installAdeRuntimeInVm,
  type BootstrapRunner,
  type RuntimeBootstrapPhase,
} from "./runtimeBootstrap";

const APPLE_VIRTUALIZATION_DOCS = "https://developer.apple.com/documentation/virtualization";
const APPLE_SHARED_DIRECTORIES_DOCS = "https://developer.apple.com/documentation/virtualization/vzvirtiofilesystemdeviceconfiguration";
const LUME_DOCS = "https://cua.ai/docs/lume/guide/fundamentals/vm-management";
const LUME_INSTALL_DOCS = "https://cua.ai/docs/lume/guide/getting-started/installation";
const LUME_GUEST_SHARED_PATH = "/Volumes/My Shared Files";
const DEFAULT_CPU_CORES = 4;
const DEFAULT_MEMORY = "8GB";
const DEFAULT_DISK_SIZE = "80GB";
const DEFAULT_DISPLAY = "1920x1440";
const DEFAULT_PULL_IMAGE = "macos-tahoe-vanilla:latest";
const DEFAULT_CREATE_IPSW = "https://updates.cdn-apple.com/2025SummerFCS/fullrestores/093-10809/CFD6DD38-DAF0-40DA-854F-31AAD1294C6F/UniversalMac_15.6.1_24G90_Restore.ipsw";
const MACOS_VM_STATE_FILE = "records.json";
const MACOS_VM_GLOBAL_LEASE_FILE = "lease.json";
const MACOS_VM_VNC_CREDENTIALS_FILE = "macos-vm-vnc.v1.json";
const MACOS_VM_HEADLESS_WINDOW_TITLE = "Headless VNC";
const MACOS_VM_IPSW_CACHE_DIR = "ipsw";
const DISPLAY_PROXY_IDLE_MS = 60_000;
const DISPLAY_PROXY_MAX_MS = 12 * 60 * 60_000;
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

type WindowCaptureSource = {
  id: string;
  name: string;
  thumbnailDataUrl: string | null;
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

type DisplayProxySession = {
  laneId: string;
  vmName: string;
  websocketUrl: string;
  password: string;
  width: number;
  height: number;
  expiresAt: number;
  close: () => void;
};

type CreateMacosVmServiceArgs = {
  projectRoot: string;
  logger: Logger;
  resolveLanes: () => Promise<LaneContext[]>;
  onEvent?: ((payload: MacosVmEventPayload) => void) | null;
  runCommand?: CommandRunner;
  validateProviderSignature?: boolean;
  directVncClient?: DirectVncClient;
  captureWindowSources?: (() => Promise<WindowCaptureSource[]>) | null;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  credentialsStore?: CredentialsStore;
  runtimeBootstrapRunner?: BootstrapRunner;
  onRuntimeReady?:
    | ((info: { vmName: string; ipAddress: string; username: string }) => void | Promise<void>)
    | null;
};

type VmStoreFile = {
  version: 1;
  records: MacosVmRecord[];
};

type VmGlobalLeaseFile = {
  version: 1;
  lease: MacosVmGlobalLease | null;
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
  sshAvailable: boolean | null;
  vncUrl: string | null;
  vncPassword: string | null;
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
  if (normalized === "installing" || normalized === "provisioning" || normalized === "ipsw_install") return "installing";
  if (normalized === "stopped" || normalized === "shutoff" || normalized === "shutdown") return "stopped";
  if (normalized === "starting" || normalized === "booting") return "starting";
  if (normalized === "running" || normalized === "started") return "running";
  if (normalized === "stopping") return "stopping";
  if (normalized === "paused" || normalized === "suspended") return "paused";
  if (normalized === "failed" || normalized === "error") return "failed";
  return "unknown";
}

function stateLabelForError(value: MacosVmLifecycleState): string {
  return value.replace(/_/g, " ");
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

function pngDataFromDataUrl(dataUrl: string | null | undefined): Buffer | null {
  if (!dataUrl) return null;
  const match = /^data:image\/png;base64,(.+)$/i.exec(dataUrl);
  if (!match) return null;
  return Buffer.from(match[1] ?? "", "base64");
}

function isVmWindowCaptureSource(sourceName: string, record: MacosVmRecord): boolean {
  const name = sourceName.toLowerCase();
  return name.includes(record.name.toLowerCase())
    || /\bvirtualization\b|\bscreen sharing\b|\blume\b|\bvnc\b/.test(name);
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
    || relative === ".ade/cto/subordinate-activity.jsonl";
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
  const parsedVnc = parseVncUrl(asString(rawVnc));
  const provisioningOperation = asString(value.provisioningOperation ?? value.provisioning_operation);
  const state = normalizeLifecycleState(value.state ?? value.status ?? value.powerState);
  const sshAvailable = typeof value.sshAvailable === "boolean"
    ? value.sshAvailable
    : typeof value.ssh_available === "boolean"
      ? value.ssh_available
      : null;
  return {
    name,
    state: state === "unknown" && provisioningOperation ? "installing" : state,
    ipAddress: asString(rawIp),
    sshAvailable,
    vncUrl: sanitizeVncUrl(asString(rawVnc)),
    vncPassword: parsedVnc?.password ?? null,
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
        sshAvailable: null,
        vncUrl: sanitizeVncUrl(parts.find((part) => /^vnc:\/\//i.test(part)) ?? null),
        vncPassword: parseVncUrl(parts.find((part) => /^vnc:\/\//i.test(part)) ?? null)?.password ?? null,
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

function guestReadinessForRecord(
  record: Pick<MacosVmRecord, "state" | "guestSharedPath" | "sshCommand" | "lastError" | "guestReadiness" | "runtimeInstall">,
  info: ExternalVmInfo | null,
): MacosVmGuestReadiness {
  const state = info?.state ?? record.state;
  const previousSshAvailable = state === "running" ? record.guestReadiness?.sshAvailable ?? null : null;
  const sshAvailable = info?.sshAvailable ?? previousSshAvailable ?? (record.sshCommand ? true : null);
  if (state === "running") {
    if (sshAvailable === true) {
      const runtimeState = record.runtimeInstall?.state ?? "not_installed";
      if (runtimeState === "installed") {
        return {
          state: "runtime_ready",
          canControlGui: true,
          canRunCode: true,
          sshAvailable,
          setupAssistantLikely: false,
          detail: "The guest is running and the ADE agent runtime is installed.",
          nextAction: `Open or create a VM lane to run agents inside the guest at ${record.guestSharedPath}.`,
        };
      }
      if (runtimeState === "installing") {
        return {
          state: "runtime_installing",
          canControlGui: true,
          canRunCode: false,
          sshAvailable,
          setupAssistantLikely: false,
          detail: record.runtimeInstall?.detail ?? "Installing the ADE agent runtime in the guest.",
          nextAction: "Wait for the runtime install to finish, then open a VM lane.",
        };
      }
      return {
        state: "code_ready",
        canControlGui: true,
        canRunCode: true,
        sshAvailable,
        setupAssistantLikely: false,
        detail: "The guest is running and reports SSH availability.",
        nextAction: `Save guest credentials and install the ADE agent runtime, or SSH into the guest and work from ${record.guestSharedPath}.`,
      };
    }
    if (sshAvailable === false) {
      return {
        state: "setup_required",
        canControlGui: true,
        canRunCode: false,
        sshAvailable,
        setupAssistantLikely: true,
        detail: "The guest is running, but SSH is unavailable. Fresh IPSW-created macOS VMs usually stop in Setup Assistant here.",
        nextAction: "Finish macOS Setup Assistant in the VM console, create the guest user, enable Remote Login if needed, then refresh.",
      };
    }
    return {
      state: "desktop_unverified",
      canControlGui: true,
      canRunCode: false,
      sshAvailable,
      setupAssistantLikely: false,
      detail: "The guest is running, but the provider did not report SSH readiness.",
      nextAction: "Use the VM console to confirm the desktop is usable and enable Remote Login before relying on guest command execution.",
    };
  }
  if (state === "creating" || state === "installing") {
    return {
      state: "provisioning",
      canControlGui: false,
      canRunCode: false,
      sshAvailable,
      setupAssistantLikely: false,
      detail: "macOS is still being created or installed.",
      nextAction: "Wait for provisioning to finish, then start the VM.",
    };
  }
  if (state === "starting") {
    return {
      state: "booting",
      canControlGui: false,
      canRunCode: false,
      sshAvailable,
      setupAssistantLikely: false,
      detail: "The VM is booting.",
      nextAction: "Wait for the VM to report running.",
    };
  }
  if (state === "failed") {
    return {
      state: "blocked",
      canControlGui: false,
      canRunCode: false,
      sshAvailable,
      setupAssistantLikely: false,
      detail: record.lastError ?? "The VM failed before the guest became usable.",
      nextAction: "Fix the provider error, retry start, or remove the VM and create a fresh VM lane.",
    };
  }
  if (state === "not_created") {
    return {
      state: "not_created",
      canControlGui: false,
      canRunCode: false,
      sshAvailable,
      setupAssistantLikely: false,
      detail: "No macOS guest has been created for this lane yet.",
      nextAction: "Create or start the VM from the VM tab.",
    };
  }
  if (state === "stopped" || state === "paused" || state === "stopping") {
    return {
      state: "not_running",
      canControlGui: false,
      canRunCode: false,
      sshAvailable,
      setupAssistantLikely: false,
      detail: `The VM is ${stateLabelForError(state)}.`,
      nextAction: "Start the VM to continue setup or guest work.",
    };
  }
  return {
    state: "unknown",
    canControlGui: false,
    canRunCode: false,
    sshAvailable,
    setupAssistantLikely: false,
    detail: "ADE could not determine guest readiness from the provider state.",
    nextAction: "Refresh VM status or capture a frame from the VM tab.",
  };
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

function parseGlobalLease(value: unknown): MacosVmGlobalLease | null {
  if (!isRecord(value)) return null;
  const projectRoot = asString(value.projectRoot);
  const laneId = asString(value.laneId);
  const vmId = asString(value.vmId);
  const vmName = asString(value.vmName);
  if (!projectRoot || !laneId || !vmId || !vmName) return null;
  return {
    projectRoot,
    laneId,
    laneName: asString(value.laneName) ?? laneId,
    vmId,
    vmName,
    updatedAt: asString(value.updatedAt) ?? nowIso(),
  };
}

function readGlobalLeaseFile(storePath: string): VmGlobalLeaseFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath, "utf8")) as Partial<VmGlobalLeaseFile>;
    return { version: 1, lease: parseGlobalLease(parsed.lease) };
  } catch {
    return { version: 1, lease: null };
  }
}

function writeGlobalLeaseFile(storePath: string, store: VmGlobalLeaseFile): void {
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

function displaySizeForRecord(record: MacosVmRecord): { width: number; height: number } {
  const lume = record.metadata.lume;
  const liveDisplay = isRecord(lume) ? asString(lume.display) : null;
  return parseDisplaySize(liveDisplay || record.display);
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

function sanitizeLumeRunText(value: string): string {
  return sanitizeVncUrlsInText(value).replace(/--vnc-password(?:=|\s+)\S+/g, "--vnc-password=<redacted>");
}

function commonLumePaths(env: NodeJS.ProcessEnv): string[] {
  const home = env.HOME?.trim() || os.homedir();
  const cuaAppBinary = path.join(home, ".local", "share", "lume", "lume.app", "Contents", "MacOS", "lume");
  const cuaCliWrapper = path.join(home, ".local", "bin", "lume");
  const entries = [
    env.ADE_LUME_PATH,
    cuaAppBinary,
    cuaCliWrapper,
    ...String(env.PATH ?? "").split(path.delimiter).map((entry) => entry ? path.join(entry, "lume") : ""),
    "/opt/homebrew/bin/lume",
    "/usr/local/bin/lume",
  ];
  return [...new Set(entries.filter((entry): entry is string => Boolean(entry?.trim())))];
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

function normalizeLumeUnavailableDetail(value: string): string {
  const detail = value.trim();
  if (/(no such file or directory|cannot execute|enoent|command not found|not found)/i.test(detail)) {
    return "Lume is not installed or its CLI shim is broken. Install Lume from Cua, then refresh this panel.";
  }
  return detail || "Lume is not available. Install Lume from Cua, then refresh this panel.";
}

function normalizeLumeVersion(value: string): string | null {
  const firstLine = value.trim().split(/\r?\n/)[0]?.trim() || "";
  const semver = /\b(?:lume\s*)?(v?\d+\.\d+\.\d+)\b/i.exec(firstLine)?.[1];
  return semver ?? (firstLine || null);
}

function describeLumeCommand(command: string): string {
  return command === "lume" ? "lume on PATH" : command;
}

function parseHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

function ipswCacheFilename(url: URL): string {
  const filename = decodeURIComponent(path.basename(url.pathname));
  const safe = filename.replace(/[^A-Za-z0-9._-]/g, "-");
  return safe.endsWith(".ipsw") ? safe : `${safe || "macos-restore"}.ipsw`;
}

function partialDownloadUrlMarkerPath(destination: string): string {
  return `${destination}.part.url`;
}

/**
 * Recover an interrupted IPSW download by promoting an existing `.part-*`
 * sibling to the stable `.part` name so `curl --continue-at -` can resume.
 *
 * IMPORTANT: only recover when we can prove the partial belongs to the same
 * remote URL — IPSW filenames are not content-addressed, so two unrelated
 * IPSWs can share a filename (e.g. when Apple rotates restore images). A
 * `.part.url` sidecar records the URL that produced the current `.part`;
 * if it does not match, we discard the partials rather than resuming into
 * incompatible bytes.
 */
function recoverLargestPartialDownload(cacheDir: string, destination: string, sourceUrl: string): void {
  const stablePartial = `${destination}.part`;
  const urlMarker = partialDownloadUrlMarkerPath(destination);
  if (fs.existsSync(stablePartial)) {
    // If the existing partial does not match the requested URL, drop it so
    // curl restarts from byte 0 instead of resuming into the wrong content.
    let storedUrl: string | null = null;
    try {
      storedUrl = fs.readFileSync(urlMarker, "utf8").trim();
    } catch {
      storedUrl = null;
    }
    if (storedUrl !== sourceUrl) {
      try {
        fs.rmSync(stablePartial, { force: true });
        fs.rmSync(urlMarker, { force: true });
      } catch {
        // ignore — curl will overwrite on next attempt
      }
    } else {
      return;
    }
  }
  const prefix = `${path.basename(destination)}.part-`;
  let largest: { path: string; size: number } | null = null;
  try {
    for (const entry of fs.readdirSync(cacheDir)) {
      if (!entry.startsWith(prefix)) continue;
      const candidate = path.join(cacheDir, entry);
      const size = fs.statSync(candidate).size;
      if (!largest || size > largest.size) largest = { path: candidate, size };
    }
  } catch {
    return;
  }
  if (!largest || largest.size <= 0) return;
  fs.renameSync(largest.path, stablePartial);
  try {
    fs.writeFileSync(urlMarker, sourceUrl, "utf8");
  } catch {
    // Best-effort: if we cannot write the marker we may re-resume against
    // a stale partial later. That is the existing behavior; the marker is
    // an additive safeguard.
  }
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
  const credentialsStore = args.credentialsStore ?? createCredentialsStore({ platform });
  const runtimeBootstrapRunner = args.runtimeBootstrapRunner;
  const layout = resolveAdeLayout(args.projectRoot);
  const storeDir = path.join(layout.cacheDir, "macos-vms");
  const storePath = path.join(storeDir, MACOS_VM_STATE_FILE);
  const adeHome = env.ADE_HOME?.trim() || process.env.ADE_HOME?.trim() || path.join(layout.cacheDir, "runtime-home");
  const globalLeasePath = path.join(adeHome, "cache", "macos-vms", MACOS_VM_GLOBAL_LEASE_FILE);
  const vncCredentialStorePath = path.join(layout.secretsDir, MACOS_VM_VNC_CREDENTIALS_FILE);
  const projectRoot = path.resolve(args.projectRoot);
  const lumeCommand = resolveLumeCommand(env);
  const mirrorSyncSessions = new Map<string, MirrorSyncSession>();
  const displayProxySessions = new Map<string, DisplayProxySession>();
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

  const loadRecords = (): MacosVmRecord[] => readStoreFile(storePath).records.map((record) => ({
    ...record,
    guestReadiness: record.guestReadiness ?? guestReadinessForRecord(record, null),
  }));

  const saveRecords = (records: MacosVmRecord[]): void => {
    writeStoreFile(storePath, { version: 1, records });
  };

  const readGlobalLease = (): MacosVmGlobalLease | null => readGlobalLeaseFile(globalLeasePath).lease;

  const writeGlobalLease = (lease: MacosVmGlobalLease | null): void => {
    writeGlobalLeaseFile(globalLeasePath, { version: 1, lease });
  };

  const recordToGlobalLease = (record: MacosVmRecord): MacosVmGlobalLease => ({
    projectRoot,
    laneId: record.laneId,
    laneName: record.laneName,
    vmId: record.id,
    vmName: record.name,
    updatedAt: nowIso(),
  });

  const markLaneAttachment = (
    record: MacosVmRecord,
    validLaneIds: ReadonlySet<string>,
  ): MacosVmRecord => ({
    ...record,
    laneState: validLaneIds.has(record.laneId) ? "attached" : "missing",
  });

  const leaseMatchesCurrentProjectLane = (lease: MacosVmGlobalLease, lane: LaneContext): boolean => (
    path.resolve(lease.projectRoot) === projectRoot && lease.laneId === lane.id
  );

  const reconcileGlobalLease = (
    externalByName: Map<string, ExternalVmInfo>,
    records = loadRecords(),
  ): MacosVmGlobalLease | null => {
    const current = readGlobalLease();
    if (current) {
      const currentProjectLease = path.resolve(current.projectRoot) === projectRoot;
      const localRecord = records.find((record) => record.name === current.vmName || record.laneId === current.laneId) ?? null;
      if (currentProjectLease && localRecord) {
        if (localRecord.laneState === "missing") {
          if (externalByName.has(current.vmName)) return current;
          writeGlobalLease(null);
          return null;
        }
        const refreshed = recordToGlobalLease(localRecord);
        writeGlobalLease(refreshed);
        return refreshed;
      }
      if (externalByName.has(current.vmName)) return current;
      if (currentProjectLease) {
        writeGlobalLease(null);
        return null;
      }
      return current;
    }

    const localRecord = records.find((record) => record.laneState !== "missing" && record.state === "running")
      ?? records.find((record) => record.laneState !== "missing")
      ?? null;
    if (!localRecord) return null;
    const lease = recordToGlobalLease(localRecord);
    writeGlobalLease(lease);
    return lease;
  };

  const ensureGlobalLeaseAvailable = async (lane: LaneContext): Promise<void> => {
    const external = await listExternalVms();
    const externalByName = new Map(external.map((info) => [info.name, info]));
    const validLaneIds = new Set((await args.resolveLanes()).map((entry) => entry.id));
    const records = loadRecords().map((record) => markLaneAttachment(record, validLaneIds));
    const blockingRecord = records.find((record) => record.laneId !== lane.id) ?? null;
    if (blockingRecord?.laneState === "missing") {
      throw new Error(
        `A stale Mac VM record still points at deleted lane ${blockingRecord.laneName}. Remove it from the VM tab before attaching a new VM lane.`,
      );
    }
    if (blockingRecord) {
      throw new Error(
        `Mac VM is already attached to ${blockingRecord.laneName}. Finish or delete that VM before creating another VM lane.`,
      );
    }
    const lease = reconcileGlobalLease(externalByName, records);
    if (!lease || leaseMatchesCurrentProjectLane(lease, lane)) return;
    throw new Error(
      `Mac VM is already attached to ${lease.laneName} in ${lease.projectRoot}. Finish or delete that VM before creating another VM lane.`,
    );
  };

  const claimGlobalLease = (record: MacosVmRecord): void => {
    writeGlobalLease(recordToGlobalLease(record));
  };

  const clearGlobalLeaseForRecord = (record: MacosVmRecord): void => {
    const lease = readGlobalLease();
    if (!lease) return;
    if (lease.vmName !== record.name && lease.laneId !== record.laneId) return;
    writeGlobalLease(null);
  };

  const upsertRecord = (record: MacosVmRecord): MacosVmRecord => {
    const records = loadRecords();
    const index = records.findIndex((entry) => entry.id === record.id || entry.laneId === record.laneId);
    const next = {
      ...record,
      guestReadiness: guestReadinessForRecord(record, null),
      updatedAt: nowIso(),
    };
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

  const saveVncPassword = (laneId: string, vmName: string, password: string): void => {
    if (!password.trim()) return;
    const store = readVncCredentialStore(vncCredentialStorePath);
    store.credentials[vncCredentialKey(laneId, vmName)] = {
      laneId,
      vmName,
      password,
      updatedAt: nowIso(),
    };
    writeVncCredentialStore(vncCredentialStorePath, store);
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

  const resolveCreateIpsw = async (lane: LaneContext, record: MacosVmRecord, ipsw: string): Promise<string> => {
    const url = parseHttpUrl(ipsw);
    if (!url) return ipsw;
    const cacheDir = path.join(storeDir, MACOS_VM_IPSW_CACHE_DIR);
    fs.mkdirSync(cacheDir, { recursive: true });
    const destination = path.join(cacheDir, ipswCacheFilename(url));
    try {
      if (fs.statSync(destination).size > 0) {
        emitOperation("provision", "started", lane.id, record.name, `Using cached macOS restore image ${path.basename(destination)}.`);
        return destination;
      }
    } catch {
      // Download below.
    }
    const sourceUrl = url.toString();
    recoverLargestPartialDownload(cacheDir, destination, sourceUrl);
    const partial = `${destination}.part`;
    emitOperation("provision", "started", lane.id, record.name, `Downloading macOS restore image ${path.basename(destination)} from Apple.`);
    // Probe Content-Length up front via a HEAD request so the progress bar
    // can show "X / Y GB" and a real ETA. Apple's CDN serves Content-Length
    // on HEAD reliably; if it fails for any reason we degrade to the
    // bytes-only display rather than blocking the download.
    const startedAt = nowIso();
    let totalBytes: number | null = null;
    try {
      const headResult = await runCommand("/usr/bin/curl", [
        "--head",
        "--silent",
        "--show-error",
        "--location",
        url.toString(),
      ], { timeoutMs: 15_000 });
      if (headResult.exitCode === 0) {
        const match = /^content-length:\s*(\d+)/im.exec(headResult.stdout);
        if (match) {
          const parsed = Number.parseInt(match[1], 10);
          if (Number.isFinite(parsed) && parsed > 0) totalBytes = parsed;
        }
      }
    } catch {
      // Best-effort; download still proceeds without total.
    }
    let lastDownloadedBytes = 0;
    let lastSampleMs = Date.now();
    const progressTimer = setInterval(() => {
      try {
        const size = fs.statSync(partial).size;
        const now = Date.now();
        const elapsedMs = Math.max(1, now - lastSampleMs);
        const deltaBytes = Math.max(0, size - lastDownloadedBytes);
        const bytesPerSecond = (deltaBytes / elapsedMs) * 1000;
        const etaSeconds = totalBytes != null && bytesPerSecond > 0
          ? Math.max(0, Math.round((totalBytes - size) / bytesPerSecond))
          : null;
        lastDownloadedBytes = size;
        lastSampleMs = now;
        const progress: MacosVmDownloadProgress = {
          source: "ipsw",
          downloadedBytes: size,
          totalBytes,
          etaSeconds,
          startedAt,
          updatedAt: new Date(now).toISOString(),
          resumable: true,
        };
        emit({ type: "download-progress", vmName: record.name, progress });
      } catch {
        // The partial file may not exist yet; ignore until curl creates it.
      }
    }, 500);
    progressTimer.unref?.();
    // Stamp the URL marker so future `recoverLargestPartialDownload` calls
    // can detect when the partial belongs to a different remote and discard
    // it rather than resuming into incompatible bytes.
    try {
      fs.writeFileSync(partialDownloadUrlMarkerPath(destination), sourceUrl, "utf8");
    } catch {
      // Best-effort.
    }
    try {
      const result = await runCommand("/usr/bin/curl", [
        "--fail",
        "--location",
        "--continue-at",
        "-",
        "--silent",
        "--show-error",
        "--output",
        partial,
        url.toString(),
      ], { timeoutMs: 2 * 60 * 60_000, cwd: projectRoot });
      if (result.exitCode !== 0) {
        const detail = (result.stderr || result.stdout || `curl exited with code ${result.exitCode ?? "unknown"}`).trim();
        throw new Error(detail);
      }
      fs.renameSync(partial, destination);
      // The download is complete; the URL marker is no longer needed.
      try {
        fs.rmSync(partialDownloadUrlMarkerPath(destination), { force: true });
      } catch {
        // ignore
      }
      // Emit a final 100% progress event so renderers can clear the bar.
      try {
        const size = fs.statSync(destination).size;
        emit({
          type: "download-progress",
          vmName: record.name,
          progress: {
            source: "ipsw",
            downloadedBytes: size,
            totalBytes: size,
            etaSeconds: 0,
            startedAt,
            updatedAt: nowIso(),
            resumable: false,
          },
        });
      } catch {
        // Best-effort progress emit.
      }
      return destination;
    } catch (error) {
      throw error;
    } finally {
      clearInterval(progressTimer);
    }
  };

  /**
   * On service init, check for a `.part` file in the IPSW cache. If present,
   * emit a `resume-available` event so the renderer can offer to resume the
   * download.
   */
  const checkForResumableDownload = (): void => {
    try {
      const cacheDir = path.join(storeDir, MACOS_VM_IPSW_CACHE_DIR);
      if (!fs.existsSync(cacheDir)) return;
      for (const entry of fs.readdirSync(cacheDir)) {
        if (!entry.endsWith(".part")) continue;
        const partPath = path.join(cacheDir, entry);
        let bytesAvailable = 0;
        try {
          bytesAvailable = fs.statSync(partPath).size;
        } catch {
          continue;
        }
        if (bytesAvailable <= 0) continue;
        emit({
          type: "resume-available",
          vmName: null,
          source: "ipsw",
          bytesAvailable,
        });
      }
    } catch (error) {
      args.logger.debug("macos_vm.resume_check_failed", {
        err: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const launchLumeRun = async (lumeArgs: string[]): Promise<{ pid: number | null }> => {
    if (args.runCommand) {
      await runLume(lumeArgs, 5_000);
      return { pid: null };
    }
    fs.mkdirSync(storeDir, { recursive: true });
    const logPath = path.join(storeDir, `lume-run-${process.pid}-${Date.now()}.log`);
    const outputFd = fs.openSync(logPath, "a");
    return new Promise<{ pid: number | null }>((resolve, reject) => {
      let logClosed = false;
      const closeLog = (): void => {
        if (logClosed) return;
        logClosed = true;
        try {
          fs.closeSync(outputFd);
        } catch {
          // Best effort cleanup.
        }
      };
      const removeLog = (): void => {
        try {
          fs.rmSync(logPath, { force: true });
        } catch {
          // Best effort cleanup.
        }
      };
      const child = spawn(lumeCommand, lumeArgs, {
        cwd: projectRoot,
        detached: true,
        env: { ...process.env, ...env },
        stdio: ["ignore", outputFd, outputFd],
      });
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        closeLog();
        removeLog();
        if (error) reject(error);
        else {
          child.unref();
          resolve({ pid: child.pid ?? null });
        }
      };
      const providerOutput = (): string => {
        closeLog();
        let detail = "";
        try {
          detail = fs.readFileSync(logPath, "utf8").trim();
        } catch {
          detail = "";
        }
        if (detail) return sanitizeLumeRunText(detail);
        return `Lume run exited before the VM reported running: ${sanitizeLumeRunText(lumeArgs.join(" "))}`;
      };
      const timeout = setTimeout(() => finish(), 1_500);
      child.once("error", (error) => finish(error));
      child.once("exit", (exitCode, signal) => {
        // `lume run` can return cleanly after launching the VM, especially
        // in `--no-display` mode where there's no GUI to keep alive.
        // Treat a zero exit as a successful kickoff; the caller still verifies
        // the VM reached `running` via waitForExternalVm. Only non-zero
        // exits are real failures and need the provider output surfaced.
        if (exitCode === 0) {
          finish();
        } else {
          finish(new Error(`${providerOutput()} (exit ${exitCode ?? signal ?? "unknown"})`));
        }
      });
    });
  };

  const ensureVmDisplaySize = async (record: MacosVmRecord): Promise<void> => {
    await runLume(["set", record.name, "--display", record.display], 2 * 60_000);
  };

  const countConnectedScreenSharingClients = async (connection: DirectVncConnection): Promise<number> => {
    if (platform !== "darwin") return 0;
    try {
      const result = await runCommand("/usr/sbin/lsof", [
        "-nP",
        "-Fpcn",
        `-iTCP:${connection.port}`,
        "-sTCP:ESTABLISHED",
      ], { timeoutMs: 5_000, cwd: projectRoot });
      if (result.exitCode !== 0) return 0;
      const pids = new Set<string>();
      let currentPid = "";
      for (const line of result.stdout.split(/\r?\n/)) {
        if (line.startsWith("p")) {
          currentPid = line.slice(1).trim();
          continue;
        }
        if (line.startsWith("c") && line.slice(1).trim() === "Screen Sharing") {
          pids.add(currentPid || `unknown-${pids.size}`);
        }
      }
      return pids.size;
    } catch {
      return 0;
    }
  };

  const minimizeExternalVncClientWindows = async (record: MacosVmRecord): Promise<void> => {
    if (platform !== "darwin") return;
    const script = [
      "delay 0.8",
      "tell application \"System Events\"",
      "  if exists process \"Screen Sharing\" then",
      "    tell process \"Screen Sharing\"",
      "      repeat with targetWindow in windows",
      "        set windowTitle to \"\"",
      "        try",
      "          set windowTitle to name of targetWindow as text",
      "        end try",
      `        if windowTitle is "Virtualization" or windowTitle contains ${appleScriptString(record.name)} then`,
      "          try",
      "            set value of attribute \"AXMinimized\" of targetWindow to true",
      "          end try",
      "        end if",
      "      end repeat",
      "    end tell",
      "  end if",
      "end tell",
    ].join("\n");
    try {
      const result = await runCommand("/usr/bin/osascript", ["-e", script], { timeoutMs: 5_000, cwd: projectRoot });
      if (result.exitCode !== 0) {
        const detail = (result.stderr || result.stdout || `/usr/bin/osascript exited with code ${result.exitCode ?? "unknown"}`).trim();
        throw new Error(detail);
      }
    } catch (error) {
      args.logger.warn("macos_vm.hide_external_vnc_failed", {
        vmName: record.name,
        err: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const closeStaleExternalVncClientWindows = async (record: MacosVmRecord): Promise<void> => {
    if (platform !== "darwin") return;
    const script = [
      "set matchedWindowCount to 0",
      "tell application \"System Events\"",
      "  if exists process \"Screen Sharing\" then",
      "    tell process \"Screen Sharing\"",
      "      repeat with targetWindow in windows",
      "        set windowTitle to \"\"",
      "        try",
      "          set windowTitle to name of targetWindow as text",
      "        end try",
      `        if windowTitle is "Virtualization" or windowTitle contains ${appleScriptString(record.name)} then`,
      "          set matchedWindowCount to matchedWindowCount + 1",
      "          try",
      "            perform action \"AXClose\" of targetWindow",
      "          on error",
      "            try",
      "              click button 1 of targetWindow",
      "            end try",
      "          end try",
      "        end if",
      "      end repeat",
      "    end tell",
      "  end if",
      "end tell",
      "if matchedWindowCount > 0 then",
      "  tell application \"Screen Sharing\" to quit",
      "  delay 0.5",
      "end if",
      "return matchedWindowCount as text",
    ].join("\n");
    try {
      const result = await runCommand("/usr/bin/osascript", ["-e", script], { timeoutMs: 5_000, cwd: projectRoot });
      if (result.exitCode !== 0) {
        const detail = (result.stderr || result.stdout || `/usr/bin/osascript exited with code ${result.exitCode ?? "unknown"}`).trim();
        throw new Error(detail);
      }
      const matchedWindowCount = Number.parseInt(result.stdout.trim(), 10);
      if (matchedWindowCount > 0) {
        const killResult = await runCommand("/usr/bin/pkill", ["-x", "Screen Sharing"], { timeoutMs: 5_000, cwd: projectRoot });
        if (killResult.exitCode !== 0 && killResult.exitCode !== 1) {
          const detail = (killResult.stderr || killResult.stdout || `/usr/bin/pkill exited with code ${killResult.exitCode ?? "unknown"}`).trim();
          throw new Error(detail);
        }
      }
    } catch (error) {
      args.logger.warn("macos_vm.close_stale_external_vnc_failed", {
        vmName: record.name,
        err: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const openExternalVncClient = async (lane: LaneContext, record: MacosVmRecord): Promise<void> => {
    const connection = directVncConnectionForRecord(record);
    if (!connection?.password) return;
    const connectedScreenSharingClients = await countConnectedScreenSharingClients(connection);
    if (connectedScreenSharingClients === 1) {
      await minimizeExternalVncClientWindows(record);
      emitOperation("focus-window", "completed", lane.id, record.name, "macOS Screen Sharing is already connected and hidden behind ADE's embedded VM display.");
      return;
    }
    await closeStaleExternalVncClientWindows(record);
    const viewerUrl = `vnc://:${encodeURIComponent(connection.password)}@${connection.host}:${connection.port}`;
    try {
      const result = await runCommand("/usr/bin/open", [viewerUrl], { timeoutMs: 10_000, cwd: projectRoot });
      if (result.exitCode !== 0) {
        const detail = (result.stderr || result.stdout || `/usr/bin/open exited with code ${result.exitCode ?? "unknown"}`).trim();
        throw new Error(detail);
      }
      await minimizeExternalVncClientWindows(record);
      emitOperation("focus-window", "completed", lane.id, record.name, "Attached and hid macOS Screen Sharing behind ADE's embedded VM display.");
    } catch (error) {
      args.logger.warn("macos_vm.open_external_vnc_failed", {
        vmName: record.name,
        err: error instanceof Error ? error.message : String(error),
      });
    }
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

  const validateLumeSignature = args.validateProviderSignature ?? !args.runCommand;

  const detectLume = async (): Promise<{ available: boolean; version: string | null; detail: string; command: string }> => {
    if (platform !== "darwin") {
      return {
        available: false,
        version: null,
        detail: "macOS virtual machines are only available from ADE on macOS.",
        command: lumeCommand,
      };
    }
    if (arch !== "arm64") {
      return {
        available: false,
        version: null,
        detail: "macOS guests require an Apple silicon Mac.",
        command: lumeCommand,
      };
    }
    try {
      const result = await runCommand(lumeCommand, ["--version"], { timeoutMs: 4_000, cwd: projectRoot });
      if (result.exitCode === 0) {
        const version = normalizeLumeVersion(result.stdout || result.stderr);
        if (validateLumeSignature) {
          const signature = await runCommand("/usr/bin/codesign", ["-d", "--entitlements", ":-", lumeCommand], {
            timeoutMs: 4_000,
            cwd: projectRoot,
          });
          const signatureOutput = `${signature.stdout}\n${signature.stderr}`;
          if (
            signature.exitCode !== 0 ||
            !signatureOutput.includes("com.apple.security.virtualization") ||
            !signatureOutput.includes("com.apple.vm.networking")
          ) {
            return {
              available: false,
              version: version ?? null,
              detail: `ADE found Lume at ${lumeCommand}, but it is not the signed Cua app bundle with Apple Virtualization entitlements. Install Lume from Cua's installer or set ADE_LUME_PATH to the signed lume.app binary.`,
              command: lumeCommand,
            };
          }
        }
        return { available: true, version: version || null, detail: version || "Lume is installed.", command: lumeCommand };
      }
      return {
        available: false,
        version: null,
        detail: normalizeLumeUnavailableDetail(result.stderr || result.stdout),
        command: lumeCommand,
      };
    } catch (error) {
      return {
        available: false,
        version: null,
        detail: normalizeLumeUnavailableDetail(error instanceof Error ? error.message : String(error)),
        command: lumeCommand,
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
        ? `Lume ${lume.version ?? ""}`.trim() + ` is available at ${describeLumeCommand(lume.command)}. ADE will use it as the first macOS VM provider.`
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
        detail: lume.available
          ? `${lume.version ?? "Lume is installed."} (${describeLumeCommand(lume.command)})`
          : lume.detail,
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

  const mergeExternalInfo = (record: MacosVmRecord, info: ExternalVmInfo | null): MacosVmRecord => {
    if (!info) {
      const wasLive = record.state === "running" || record.state === "starting" || record.state === "stopping";
      const next = {
        ...record,
        state: wasLive ? "stopped" : record.state,
        ipAddress: wasLive ? null : record.ipAddress,
        vncUrl: wasLive ? null : record.vncUrl,
        sshCommand: wasLive ? null : record.sshCommand,
        lastError: record.lastError,
      };
      return {
        ...next,
        guestReadiness: guestReadinessForRecord(next, null),
      };
    }
    if (info.vncPassword) saveVncPassword(record.laneId, record.name, info.vncPassword);
    const healthyState = info.state === "running" || info.state === "stopped" || info.state === "paused";
    const next = {
      ...record,
      state: info.state,
      lastStartedAt: info.state === "running" ? record.lastStartedAt ?? nowIso() : record.lastStartedAt,
      lastError: healthyState ? null : record.lastError,
      ipAddress: info.ipAddress,
      vncUrl: info.vncUrl,
      sshCommand: info.ipAddress && info.sshAvailable !== false ? `ssh lume@${info.ipAddress}` : null,
      metadata: {
        ...record.metadata,
        ...(info.raw ? { lume: info.raw } : {}),
      },
    };
    return {
      ...next,
      guestReadiness: guestReadinessForRecord(next, info),
    };
  };

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
    const displaySize = size ?? displaySizeForRecord(record);
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

  const closeDisplayProxySession = (key: string): void => {
    const session = displayProxySessions.get(key);
    if (!session) return;
    displayProxySessions.delete(key);
    session.close();
  };

  const closeDisplayProxySessionsForRecord = (record: MacosVmRecord): void => {
    closeDisplayProxySession(record.id);
    closeDisplayProxySession(record.laneId);
  };

  const createDisplayProxySession = async (
    lane: LaneContext,
    record: MacosVmRecord,
    connection: DirectVncConnection,
    password: string,
  ): Promise<DisplayProxySession> => {
    const displaySize = displaySizeForRecord(record);
    const token = randomBytes(16).toString("hex");
    const sockets = new Set<net.Socket>();
    const expiresAt = Date.now() + DISPLAY_PROXY_MAX_MS;
    const wss = new WebSocketServer({
      host: "127.0.0.1",
      port: 0,
      clientTracking: true,
    });
    let idleTimer: NodeJS.Timeout | null = null;
    const maxTimer = setTimeout(() => closeDisplayProxySession(record.id), DISPLAY_PROXY_MAX_MS);
    maxTimer.unref?.();
    const scheduleIdleClose = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => closeDisplayProxySession(record.id), DISPLAY_PROXY_IDLE_MS);
      idleTimer.unref?.();
    };

    const closeSession = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      for (const client of wss.clients) {
        try {
          client.close();
        } catch {
          // ignore close races
        }
      }
      for (const socket of sockets) socket.destroy();
      try {
        wss.close();
      } catch {
        // ignore close races
      }
    };

    scheduleIdleClose();
    wss.on("connection", (ws, request) => {
      const requestUrl = new URL(request.url ?? "/", "ws://127.0.0.1");
      if (requestUrl.pathname !== `/${token}`) {
        ws.close(1008, "Invalid macOS VM display session.");
        return;
      }
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      const vncSocket = net.createConnection({ host: connection.host, port: connection.port });
      sockets.add(vncSocket);
      const closeBoth = (): void => {
        sockets.delete(vncSocket);
        vncSocket.destroy();
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close();
        }
        if (wss.clients.size === 0) scheduleIdleClose();
      };
      vncSocket.on("data", (chunk) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
      });
      vncSocket.on("error", (error) => {
        args.logger.warn("macos_vm.display_proxy_vnc_error", {
          vmName: record.name,
          err: error instanceof Error ? error.message : String(error),
        });
        closeBoth();
      });
      vncSocket.on("close", closeBoth);
      ws.on("message", (data) => {
        if (!vncSocket.writable) return;
        if (Buffer.isBuffer(data)) {
          vncSocket.write(data);
        } else if (data instanceof ArrayBuffer) {
          vncSocket.write(Buffer.from(data));
        } else if (Array.isArray(data)) {
          vncSocket.write(Buffer.concat(data));
        } else {
          vncSocket.write(Buffer.from(String(data)));
        }
      });
      ws.on("error", closeBoth);
      ws.on("close", closeBoth);
    });
    wss.on("error", (error) => {
      args.logger.warn("macos_vm.display_proxy_error", {
        vmName: record.name,
        err: error instanceof Error ? error.message : String(error),
      });
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out starting macOS VM display proxy.")), 5_000);
      wss.once("listening", () => {
        clearTimeout(timeout);
        resolve();
      });
      wss.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
    const address = wss.address();
    if (!address || typeof address === "string") {
      closeSession();
      clearTimeout(maxTimer);
      throw new Error("macOS VM display proxy did not bind to a local TCP port.");
    }
    const session: DisplayProxySession = {
      laneId: lane.id,
      vmName: record.name,
      websocketUrl: `ws://127.0.0.1:${address.port}/${token}`,
      password,
      width: displaySize.width,
      height: displaySize.height,
      expiresAt,
      close: () => {
        clearTimeout(maxTimer);
        closeSession();
      },
    };
    displayProxySessions.set(record.id, session);
    return session;
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

  const sharePlanForLane = (lane: LaneContext): SharePlan => {
    const originalHostPath = path.resolve(lane.worktreePath);
    const containsAdeState = fs.existsSync(path.join(originalHostPath, ".ade"));
    if (containsAdeState) {
      const mirrorPath = path.join(storeDir, "shares", sanitizeArtifactName(lane.id), "worktree");
      return {
        hostPath: mirrorPath,
        guestPath: LUME_GUEST_SHARED_PATH,
        readOnly: false,
        allowed: true,
        blockedReason: null,
        syncMode: "sanitized-mirror",
        mirrorPath,
        originalHostPath,
        excludedPaths: MIRROR_SYNC_EXCLUDES,
        detail: "ADE mounts a sanitized rsync mirror because the lane root contains ADE local state.",
      };
    }
    return {
      hostPath: originalHostPath,
      guestPath: LUME_GUEST_SHARED_PATH,
      readOnly: false,
      allowed: true,
      blockedReason: null,
      syncMode: "direct",
      mirrorPath: null,
      originalHostPath,
      excludedPaths: [],
      detail: "ADE mounts the lane worktree directly into the VM.",
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
    // Use the absolute path to match the rest of this file (curl, ssh, open,
    // osascript). rsync ships with every macOS install at /usr/bin/rsync,
    // so we do not need PATH resolution and bypassing PATH closes a minor
    // hijack vector in unusual user environments.
    await runHostCommand("/usr/bin/rsync", rsyncArgs, 15 * 60_000);
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
      laneState: "attached",
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
      guestReadiness: existing?.guestReadiness ?? guestReadinessForRecord({
        state: existing?.state ?? "not_created",
        guestSharedPath: LUME_GUEST_SHARED_PATH,
        sshCommand: existing?.sshCommand ?? null,
        lastError: existing?.lastError ?? null,
        guestReadiness: existing?.guestReadiness,
      }, null),
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
    const validLaneIds = new Set((await args.resolveLanes()).map((entry) => entry.id));
    const records = loadRecords()
      .map((record) => mergeExternalInfo(record, externalByName.get(record.name) ?? null))
      .map((record) => markLaneAttachment(record, validLaneIds));
    saveRecords(records);
    const globalLease = reconcileGlobalLease(externalByName, records);
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
      globalLease,
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
    await ensureGlobalLeaseAvailable(lane);
    await ensureShareReady(lane);
    await requireProviderReady();

    let record = recordForLane(lane, provisionArgs);
    const existingInfo = await getExternalVm(record.name);
    if (existingInfo && !provisionArgs.force) {
      record = upsertRecord(mergeExternalInfo({ ...record, state: existingInfo.state }, existingInfo));
      claimGlobalLease(record);
      emitOperation("provision", "completed", lane.id, record.name, "macOS VM already exists for this lane.");
      return record;
    }

    emitOperation("provision", "started", lane.id, record.name, "Provisioning lane macOS VM.");
    record = upsertRecord({ ...record, state: "creating", lastError: null });
    try {
      const mode = provisionArgs.mode === "pull-image" ? "pull-image" : "create";
      if (mode === "pull-image") {
        const image = provisionArgs.sourceImage?.trim() || DEFAULT_PULL_IMAGE;
        emitOperation("provision", "started", lane.id, record.name, `Downloading prepared macOS image ${image}. First run can take several minutes.`);
        try {
          await runLume(["pull", image, record.name], 60 * 60_000);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(
            `Lume could not pull ${image} into VM ${record.name}. The image may be incompatible with this Lume version. ${message}`,
          );
        }
        const pulledInfo = await getExternalVm(record.name);
        if (!pulledInfo) {
          throw new Error(
            `Lume finished pulling ${image}, but did not create a VM named ${record.name}. The image may be incompatible with this Lume version.`,
          );
        }
        emitOperation("provision", "started", lane.id, record.name, "Configuring VM CPU, memory, disk, and display.");
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
        const ipsw = provisionArgs.ipsw?.trim() || env.ADE_MACOS_VM_IPSW_URL?.trim() || DEFAULT_CREATE_IPSW;
        emitOperation("provision", "started", lane.id, record.name, "Installing macOS from Apple's IPSW. First run can take a long time.");
        const resolvedIpsw = await resolveCreateIpsw(lane, record, ipsw);
        const createArgs = [
          "create",
          record.name,
          "--os",
          "macOS",
          "--ipsw",
          resolvedIpsw,
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
      claimGlobalLease(record);
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
    await ensureGlobalLeaseAvailable(lane);
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
        if (startArgs.openDisplay !== false) {
          await openExternalVncClient(lane, record);
          record = upsertRecord({
            ...record,
            metadata: {
              ...record.metadata,
              controlBackend: "vnc-window-and-embedded",
              externalVncClientRequested: true,
              externalVncClientHidden: true,
            },
          });
        }
        claimGlobalLease(record);
        emitOperation("start", "completed", lane.id, record.name, "macOS VM is already running with the lane mounted.");
        return record;
      }
      if (info.state === "installing" || info.state === "creating") {
        record = upsertRecord(record);
        claimGlobalLease(record);
        throw new Error("macOS VM is still installing. Wait for provisioning to finish before starting it.");
      }
      if (info.state === "starting" || info.state === "stopping") {
        record = upsertRecord(record);
        claimGlobalLease(record);
        throw new Error(`macOS VM is currently ${stateLabelForError(info.state)}. Wait for it to finish before starting it.`);
      }
    }

    emitOperation("start", "started", lane.id, record.name, "Starting lane macOS VM.");
    record = upsertRecord({ ...record, state: "starting", lastError: null });
    try {
      await ensureVmDisplaySize(record);
      const runArgs = ["run", record.name, "--shared-dir", record.sharedDirectory];
      const vncPassword = getOrCreateVncPassword(lane, record);
      if (startArgs.openDisplay === false) {
        runArgs.push("--no-display");
      }
      runArgs.push(`--vnc-password=${vncPassword}`);
      if (startArgs.openDisplay === false) {
        record = upsertRecord({
          ...record,
          metadata: {
            ...record.metadata,
            controlBackend: "direct-vnc",
            vncCredentialStored: true,
          },
        });
      } else {
        record = upsertRecord({
          ...record,
          metadata: {
            ...record.metadata,
            controlBackend: "vnc-window-and-embedded",
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
      if (startArgs.openDisplay !== false) {
        await openExternalVncClient(lane, record);
        record = upsertRecord({
          ...record,
          metadata: {
            ...record.metadata,
            externalVncClientRequested: true,
            externalVncClientHidden: true,
          },
        });
      }
      claimGlobalLease(record);
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
    closeDisplayProxySessionsForRecord(record);
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
      await closeStaleExternalVncClientWindows(stopping);
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
    const laneId = deleteArgs.laneId?.trim() || null;
    const vmName = deleteArgs.vmName?.trim() || null;
    if (!laneId && !vmName) throw new Error("A lane id or VM name is required to remove a macOS VM.");
    const record = loadRecords().find((entry) =>
      (laneId && entry.laneId === laneId) || (vmName && entry.name === vmName),
    ) ?? null;
    if (!record) {
      if (!vmName) return { deleted: false, previous: null };
      const provider = await providerStatus();
      if (!provider.available) throw new Error(`${provider.detail} Install Lume to delete this VM.`);
      const externalInfo = await getExternalVm(vmName);
      if (!externalInfo) return { deleted: false, previous: null };
      emitOperation("delete", "started", null, vmName, "Deleting macOS VM.");
      const deleteCommand = ["delete", vmName];
      if (deleteArgs.force) deleteCommand.push("--force");
      await runLume(deleteCommand, 10 * 60_000);
      const lease = readGlobalLease();
      if (lease?.vmName === vmName) writeGlobalLease(null);
      emitOperation("delete", "completed", null, vmName, "macOS VM deleted.");
      return { deleted: true, previous: null };
    }
    closeDisplayProxySessionsForRecord(record);
    let laneMissingForDelete = false;
    const lane = await getLane(record.laneId).catch((): LaneContext => {
      laneMissingForDelete = true;
      return {
        id: record.laneId,
        name: record.laneName,
        worktreePath: path.resolve(record.laneRoot),
      };
    });
    const provider = await providerStatus();
    if (!provider.available && !laneMissingForDelete) {
      throw new Error(`${provider.detail} Install Lume to delete this VM.`);
    }
    const externalInfo = provider.available ? await getExternalVm(record.name) : null;
    emitOperation("delete", "started", lane.id, record.name, "Deleting lane macOS VM.");
    try {
      if (externalInfo) {
        const deleteCommand = ["delete", record.name];
        if (deleteArgs.force) deleteCommand.push("--force");
        await runLume(deleteCommand, 10 * 60_000);
      }
      await stopMirrorSync(lane, record.metadata.mirrorPath as string | null | undefined, true);
      removeVncPassword(lane.id, record.name);
      removeRecord(lane.id);
      clearGlobalLeaseForRecord(record);
      emitOperation(
        "delete",
        "completed",
        lane.id,
        record.name,
        externalInfo ? "macOS VM deleted." : "Stale macOS VM record removed.",
      );
      return { deleted: true, previous: record };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      upsertRecord({ ...record, lastError: message });
      emitOperation("delete", "failed", lane.id, record.name, message);
      throw error;
    }
  };

  // ---------------------------------------------------------------------------
  // Singleton-VM lifecycle: restart / wipe / install-runtime / credentials.
  // ---------------------------------------------------------------------------

  const findRecordByNameOrLane = (vmName: string | null, laneId: string | null): MacosVmRecord | null => {
    const records = loadRecords();
    if (vmName) {
      const byName = records.find((entry) => entry.name === vmName);
      if (byName) return byName;
    }
    if (laneId) {
      const byLane = records.find((entry) => entry.laneId === laneId);
      if (byLane) return byLane;
    }
    return null;
  };

  const restart = async (restartArgs: MacosVmRestartArgs): Promise<MacosVmRecord | null> => {
    const vmName = restartArgs.vmName?.trim() || null;
    const laneId = restartArgs.laneId?.trim() || null;
    const record = findRecordByNameOrLane(vmName, laneId);
    if (!record) {
      throw new Error("No Mac VM is currently attached. Create a VM lane first.");
    }
    const lane: LaneContext = {
      id: record.laneId,
      name: record.laneName,
      worktreePath: path.resolve(record.laneRoot),
    };

    emitOperation("restart", "started", lane.id, record.name, "Restarting macOS VM.");
    try {
      // 1. Stop. Reuse the existing stop() path so mirror sync, display proxy,
      //    and lume-run cleanup follow the same code path. If stop fails and
      //    force was requested, surface the error from terminateLumeRunProcess.
      const stoppedInfo = await getExternalVm(record.name).catch(() => null);
      if (stoppedInfo?.state === "running" || stoppedInfo?.state === "starting") {
        try {
          await stop({ laneId: lane.id, force: restartArgs.force ?? null });
        } catch (stopError) {
          if (!restartArgs.force) throw stopError;
          await terminateLumeRunProcess(record);
        }
      }

      // 2. Sweep stale share entries so the next start mounts a clean share set.
      const beforeStart = loadRecords().find((entry) => entry.laneId === lane.id) ?? record;
      const liveEntries = (beforeStart.shareEntries ?? []).filter((entry) => entry.state === "live");
      const sweptRecord = upsertRecord({
        ...beforeStart,
        shareEntries: liveEntries,
      });

      // 3. Start. start() will recreate the share mount and re-emit phase events.
      const started = await start({
        laneId: lane.id,
        openDisplay: false,
        createIfMissing: false,
      });
      emitOperation("restart", "completed", lane.id, started.name, "macOS VM restarted.");
      return started;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const after = loadRecords().find((entry) => entry.laneId === lane.id);
      if (after) upsertRecord({ ...after, lastError: message });
      emitOperation("restart", "failed", lane.id, record.name, message);
      throw error;
    }
  };

  /**
   * Recursively remove `target`, skipping paths the process cannot touch.
   * macOS auto-creates a root-owned `.Trashes/` inside any directory that
   * was mounted as a Lume shared volume; the Electron main process can't
   * remove that without sudo. Rather than failing the whole wipe, we walk
   * the tree, remove what we can, and return the list of survivors so the
   * renderer can hand the user a copyable `sudo rm -rf` to finish up.
   */
  const safeRmRecursive = async (target: string): Promise<string[]> => {
    if (!fs.existsSync(target)) return [];
    const unreachable: string[] = [];
    try {
      await fsp.rm(target, { recursive: true, force: true });
      return [];
    } catch {
      // Fall through to per-entry walk.
    }
    const walk = async (current: string): Promise<boolean> => {
      let stat: fs.Stats;
      try {
        stat = await fsp.lstat(current);
      } catch {
        // Already gone, or unreadable — treat as needing sudo.
        unreachable.push(current);
        return false;
      }
      if (stat.isDirectory()) {
        let entries: string[];
        try {
          entries = await fsp.readdir(current);
        } catch {
          unreachable.push(current);
          return false;
        }
        let allRemoved = true;
        for (const entry of entries) {
          const child = path.join(current, entry);
          const ok = await walk(child);
          if (!ok) allRemoved = false;
        }
        if (!allRemoved) return false;
        try {
          await fsp.rmdir(current);
          return true;
        } catch {
          unreachable.push(current);
          return false;
        }
      }
      try {
        await fsp.rm(current, { force: true });
        return true;
      } catch {
        unreachable.push(current);
        return false;
      }
    };
    await walk(target);
    return unreachable;
  };

  const wipe = async (wipeArgs: MacosVmWipeArgs): Promise<MacosVmWipeResult> => {
    if (!wipeArgs.confirm) {
      throw new Error("Wipe requires explicit confirmation. Pass { confirm: true }.");
    }
    const vmName = wipeArgs.vmName?.trim() || null;
    const laneId = wipeArgs.laneId?.trim() || null;
    const record = findRecordByNameOrLane(vmName, laneId);

    // Paths cleared on every wipe — covers both the no-record path and the
    // post-deleteVm path so a stale partial download or orphan share gets
    // swept either way.
    const sweepPaths = (): string[] => [
      path.join(storeDir, MACOS_VM_IPSW_CACHE_DIR),
      path.join(storeDir, "shares"),
      path.join(storeDir, MACOS_VM_STATE_FILE),
      path.join(layout.artifactsDir, "macos-vms"),
      vncCredentialStorePath,
      path.join(adeHome, "cache", "macos-vms"),
    ];

    const sweep = async (): Promise<string[]> => {
      const unreachable: string[] = [];
      for (const target of sweepPaths()) {
        try {
          const survivors = await safeRmRecursive(target);
          unreachable.push(...survivors);
        } catch (error) {
          args.logger.warn("macos_vm.wipe_sweep_failed", {
            target,
            err: error instanceof Error ? error.message : String(error),
          });
          unreachable.push(target);
        }
      }
      return unreachable;
    };

    if (!record) {
      const unreachablePaths = await sweep();
      return { wiped: false, previousVm: null, unreachablePaths };
    }
    const lane: LaneContext = {
      id: record.laneId,
      name: record.laneName,
      worktreePath: path.resolve(record.laneRoot),
    };
    emitOperation("wipe", "started", lane.id, record.name, "Wiping macOS VM and clearing image caches.");
    try {
      await deleteVm({ laneId: lane.id, force: true });
      // Clear keychain credentials.
      await credentialsStore.clearCredentials(record.name).catch((error) => {
        args.logger.warn("macos_vm.wipe_clear_credentials_failed", {
          vmName: record.name,
          err: error instanceof Error ? error.message : String(error),
        });
      });
      const unreachablePaths = await sweep();
      const detail = unreachablePaths.length === 0
        ? "macOS VM wiped. Setup repeats on next VM lane."
        : `macOS VM wiped; ${unreachablePaths.length} path(s) need a manual sudo cleanup.`;
      emitOperation("wipe", "completed", lane.id, record.name, detail);
      return { wiped: true, previousVm: record, unreachablePaths };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emitOperation("wipe", "failed", lane.id, record.name, message);
      throw error;
    }
  };

  const ESTIMATED_IPSW_BYTES = 16_800_000_000; // ~16 GB observed for macOS 15 IPSW
  const ESTIMATED_FULL_SETUP_BYTES = 50_000_000_000; // IPSW + post-install VM disk
  const RECOMMENDED_FREE_BYTES = 60_000_000_000; // leaves headroom for OS use

  const measureVolume = async (target: string): Promise<{
    path: string;
    availableBytes: number;
    totalBytes: number;
    volumeId: number;
  }> => {
    // Walk up to the first existing ancestor so statfs doesn't ENOENT.
    let probe = path.resolve(target);
    while (probe !== path.dirname(probe) && !fs.existsSync(probe)) {
      probe = path.dirname(probe);
    }
    const stats = await fsp.statfs(probe);
    const dirStats = fs.statSync(probe);
    return {
      path: probe,
      availableBytes: stats.bavail * stats.bsize,
      totalBytes: stats.blocks * stats.bsize,
      volumeId: dirStats.dev,
    };
  };

  const measureExistingIpswBytes = (ipswPath: string): number => {
    try {
      if (!fs.existsSync(ipswPath)) return 0;
      let maxBytes = 0;
      for (const entry of fs.readdirSync(ipswPath)) {
        if (!entry.endsWith(".ipsw") && !entry.endsWith(".part")) continue;
        try {
          const size = fs.statSync(path.join(ipswPath, entry)).size;
          if (size > maxBytes) maxBytes = size;
        } catch {
          // ignore individual entry failures
        }
      }
      return maxBytes;
    } catch {
      return 0;
    }
  };

  const getStorageInfo = async (): Promise<MacosVmStorageInfo> => {
    const ipswPath = path.join(storeDir, MACOS_VM_IPSW_CACHE_DIR);
    // Lume stores VMs under ~/.lume/<vmName>/disk.img; ~/.lume may not exist
    // pre-Lume-install, so measureVolume walks to the nearest ancestor.
    const lumeRoot = path.join(os.homedir(), ".lume");
    const [ipswCache, vmDisk] = await Promise.all([
      measureVolume(ipswPath),
      measureVolume(lumeRoot),
    ]);
    return {
      ipswCache,
      vmDisk,
      estimatedIpswBytes: ESTIMATED_IPSW_BYTES,
      estimatedFullSetupBytes: ESTIMATED_FULL_SETUP_BYTES,
      recommendedFreeBytes: RECOMMENDED_FREE_BYTES,
      existingIpswBytes: measureExistingIpswBytes(ipswPath),
    };
  };

  const setCredentials = async (
    credentialsArgs: MacosVmSetCredentialsArgs,
  ): Promise<{ ok: true }> => {
    const vmName = credentialsArgs.vmName.trim();
    const username = credentialsArgs.username.trim();
    if (!vmName) throw new Error("vmName is required to save guest credentials.");
    if (!username) throw new Error("username is required to save guest credentials.");
    if (!credentialsArgs.password) throw new Error("password is required to save guest credentials.");
    const record = findRecordByNameOrLane(vmName, null);
    const laneId = record?.laneId ?? null;
    emitOperation("set-credentials", "started", laneId, vmName, "Saving guest credentials in Keychain.");
    try {
      await credentialsStore.saveCredentials(vmName, username, credentialsArgs.password);
      emitOperation("set-credentials", "completed", laneId, vmName, "Guest credentials saved.");
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emitOperation("set-credentials", "failed", laneId, vmName, message);
      throw error;
    }
  };

  const getCredentials = async (
    credentialsArgs: MacosVmGetCredentialsArgs,
  ): Promise<MacosVmStoredCredentialsSummary> => {
    const vmName = credentialsArgs.vmName.trim();
    if (!vmName) throw new Error("vmName is required to load guest credentials.");
    const stored = await credentialsStore.loadCredentials(vmName);
    return {
      vmName,
      username: stored?.username ?? null,
      hasPassword: Boolean(stored?.password),
      savedAt: stored?.savedAt ?? null,
    };
  };

  const installRuntime = async (
    installArgs: MacosVmInstallRuntimeArgs,
  ): Promise<MacosVmRuntimeInstallStatus> => {
    const vmName = installArgs.vmName?.trim() || null;
    const laneId = installArgs.laneId?.trim() || null;
    const baseRecord = findRecordByNameOrLane(vmName, laneId);
    if (!baseRecord) {
      throw new Error("No Mac VM is currently attached. Create a VM lane first.");
    }
    const info = await getExternalVm(baseRecord.name).catch(() => null);
    const record = mergeExternalInfo(baseRecord, info);
    if (record.state !== "running") {
      throw new Error("The VM must be running before installing the agent runtime.");
    }
    if (!record.ipAddress) {
      throw new Error("The VM is running, but ADE could not resolve its IP address. Try refreshing the VM status.");
    }
    const stored = await credentialsStore.loadCredentials(record.name);
    if (!stored?.password) {
      throw new Error("Save guest credentials before installing the agent runtime.");
    }

    const startedAt = nowIso();
    let status: MacosVmRuntimeInstallStatus = {
      state: "installing",
      detail: "Installing the ADE agent runtime in the guest.",
      startedAt,
      completedAt: null,
      lastError: null,
    };
    upsertRecord({ ...record, runtimeInstall: status });
    emit({ type: "runtime-install", vmName: record.name, status });
    emitOperation("install-runtime", "started", record.laneId, record.name, status.detail);

    try {
      const onPhase = (phase: RuntimeBootstrapPhase, message: string): void => {
        status = { ...status, detail: `${phase}: ${message}` };
        upsertRecord({ ...record, runtimeInstall: status });
        emit({ type: "runtime-install", vmName: record.name, status });
      };
      await installAdeRuntimeInVm({
        ipAddress: record.ipAddress,
        username: stored.username,
        password: stored.password,
        vmName: record.name,
        onProgress: onPhase,
        runner: runtimeBootstrapRunner,
      });

      // NOTE: v1 of the bootstrap script only drops a host-side success marker
      // in the guest — no `ade-runtime` binary is downloaded or installed yet
      // (see runtimeBootstrap.ts GUEST_BOOTSTRAP_SCRIPT TODO). Advancing the
      // state to "installed" would propagate through `guestReadinessForRecord`
      // as `state: "runtime_ready"` / `canRunCode: true`, and any caller that
      // acts on that signal would attempt to invoke a missing binary. Until
      // the real download/install lands, mark the install as failed with an
      // explanatory error so the UI and agent guidance reflect reality.
      const completedAt = nowIso();
      const stubDetail = "Runtime install bootstrap is a stub: the guest marker was written, but no ade-runtime binary was downloaded yet.";
      status = {
        state: "failed",
        detail: stubDetail,
        startedAt,
        completedAt,
        lastError: stubDetail,
      };
      const updated = upsertRecord({ ...record, runtimeInstall: status });
      emit({ type: "runtime-install", vmName: updated.name, status });
      emitOperation("install-runtime", "failed", record.laneId, record.name, stubDetail);

      return status;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failedAt = nowIso();
      status = {
        state: "failed",
        detail: "Failed to install the ADE agent runtime in the guest.",
        startedAt,
        completedAt: failedAt,
        lastError: message,
      };
      upsertRecord({ ...record, runtimeInstall: status });
      emit({ type: "runtime-install", vmName: record.name, status });
      emitOperation("install-runtime", "failed", record.laneId, record.name, message);
      throw error;
    }
  };

  const markShareStale = (markArgs: { laneId: string }): MacosVmRecord | null => {
    const laneId = markArgs.laneId.trim();
    if (!laneId) return null;
    const records = loadRecords();
    // A share entry could live on any VM record (singleton model means we only
    // expect one). Iterate to defensively find the entry.
    for (const record of records) {
      const shareEntries = record.shareEntries ?? [];
      let mutated = false;
      const nextEntries: MacosVmShareEntry[] = shareEntries.map((entry) => {
        if (entry.laneId !== laneId || entry.state === "stale") return entry;
        mutated = true;
        return { ...entry, state: "stale" as const };
      });
      if (mutated) {
        return upsertRecord({ ...record, shareEntries: nextEntries });
      }
    }
    return null;
  };

  const controlRecordForLane = async (
    laneId: string,
  ): Promise<{ lane: LaneContext; record: MacosVmRecord }> => {
    const lane = await getLane(laneId);
    const record = loadRecords().find((entry) => entry.laneId === lane.id) ?? recordForLane(lane);
    const currentInfo = await getExternalVm(record.name).catch(() => null);
    return { lane, record: mergeExternalInfo(record, currentInfo) };
  };

  const focusWindowInternal = async (
    focusArgs: MacosVmFocusWindowArgs,
    options: { preferHostWindow?: boolean } = {},
  ): Promise<MacosVmWindowTarget> => {
    const { lane, record } = await controlRecordForLane(focusArgs.laneId);
    if (!options.preferHostWindow && directVncConnectionForRecord(record)) {
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
      "  if restrictToVmViewer then",
      "    set candidateNames to {\"Virtualization\", \"Lume\", \"Screen Sharing\"}",
      "  else",
      "    set candidateNames to name of (application processes whose background only is false)",
      "  end if",
      "  repeat with procNameItem in candidateNames",
      "    set procName to procNameItem as text",
      "    if exists application process procName then",
      "      tell application process procName",
      "      repeat with targetWindow in windows",
      "        set windowTitle to \"\"",
      "        try",
      "          set windowTitle to name of targetWindow as text",
      "        end try",
      "        if windowTitle contains queryText then",
      "          set frontmost of application process procName to true",
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
      "      end tell",
      "      end if",
      "  end repeat",
      "  if allowVncFallback then",
      "    set fallbackCount to 0",
      "    set fallbackRow to \"\"",
      "    repeat with procNameItem in {\"Virtualization\", \"Lume\", \"Screen Sharing\"}",
      "      set procName to procNameItem as text",
      "      if exists application process procName then",
      "        tell application process procName",
      "        repeat with targetWindow in windows",
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
      "              set frontmost of application process procName to true",
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
      "        end tell",
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

  const focusWindow = async (focusArgs: MacosVmFocusWindowArgs): Promise<MacosVmWindowTarget> =>
    focusWindowInternal(focusArgs);

  const getDisplaySession = async (sessionArgs: MacosVmDisplaySessionArgs): Promise<MacosVmDisplaySession> => {
    const { lane, record } = await controlRecordForLane(sessionArgs.laneId);
    const directVnc = directVncConnectionForRecord(record);
    if (!directVnc?.password) {
      throw new Error("This VM is running, but Lume did not expose a VNC display that ADE can embed.");
    }
    closeDisplayProxySessionsForRecord(record);
    const proxy = await createDisplayProxySession(lane, record, directVnc, directVnc.password);
    emitOperation("focus-window", "completed", lane.id, record.name, "Opened embedded macOS VM display session.");
    return {
      ok: true,
      laneId: lane.id,
      vmName: record.name,
      websocketUrl: proxy.websocketUrl,
      password: proxy.password,
      width: proxy.width,
      height: proxy.height,
      expiresAt: new Date(proxy.expiresAt).toISOString(),
    };
  };

  const captureHostWindowScreenshot = async (
    captureArgs: MacosVmCaptureScreenshotArgs,
    target: MacosVmWindowTarget,
  ): Promise<MacosVmCaptureScreenshotResult> => {
    requireMacWindowControl();
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
      imageState: "unknown",
      imageDetail: null,
      window: target,
    };
  };

  const captureElectronWindowScreenshot = async (
    captureArgs: MacosVmCaptureScreenshotArgs,
    lane: LaneContext,
    record: MacosVmRecord,
  ): Promise<MacosVmCaptureScreenshotResult | null> => {
    if (!args.captureWindowSources) return null;
    let sources: WindowCaptureSource[];
    try {
      sources = await args.captureWindowSources();
    } catch (error) {
      args.logger.warn("macos_vm.desktop_capturer_sources_failed", {
        vmName: record.name,
        err: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
    const explicitQuery = captureArgs.windowTitleQuery?.trim().toLowerCase();
    const vmName = record.name.toLowerCase();
    const candidates = sources
      .map((source) => {
        const name = source.name.toLowerCase();
        if (!isVmWindowCaptureSource(source.name, record)) return { source, score: 0 };
        const score = explicitQuery && name.includes(explicitQuery)
          ? 5
          : name.includes(vmName)
            ? 4
            : 3;
        return { source, score };
      })
      .filter((entry) => entry.score > 0 && Boolean(entry.source.thumbnailDataUrl))
      .sort((a, b) => b.score - a.score);
    const match = candidates[0]?.source;
    const pngData = pngDataFromDataUrl(match?.thumbnailDataUrl);
    if (!match || !pngData) return null;

    const screenshotDir = path.join(layout.artifactsDir, "macos-vms", lane.id);
    fs.mkdirSync(screenshotDir, { recursive: true });
    const outputPath = captureArgs.outputPath?.trim()
      ? path.resolve(captureArgs.outputPath)
      : path.join(screenshotDir, `${sanitizeArtifactName(record.name)}-${Date.now()}.png`);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, pngData);
    const target: MacosVmWindowTarget = {
      laneId: lane.id,
      vmName: record.name,
      windowTitleQuery: captureArgs.windowTitleQuery?.trim() || record.name,
      processName: "desktop-capturer",
      windowTitle: match.name,
      frame: null,
      focusedAt: nowIso(),
    };
    emitOperation("screenshot", "completed", lane.id, record.name, `Captured macOS VM window "${match.name}".`);
    return {
      ok: true,
      laneId: lane.id,
      vmName: record.name,
      path: outputPath,
      dataUrl: readPngDataUrl(outputPath),
      capturedAt: nowIso(),
      captureMode: "window-region",
      imageState: "unknown",
      imageDetail: null,
      window: target,
    };
  };

  const captureDiagnosticBlankScreenshot = async (
    captureArgs: MacosVmCaptureScreenshotArgs,
    lane: LaneContext,
    record: MacosVmRecord,
    imageDetail: string,
  ): Promise<MacosVmCaptureScreenshotResult> => {
    const displaySize = displaySizeForRecord(record);
    const rgba = Buffer.alloc(displaySize.width * displaySize.height * 4);
    for (let offset = 3; offset < rgba.length; offset += 4) rgba[offset] = 255;
    const screenshotDir = path.join(layout.artifactsDir, "macos-vms", lane.id);
    fs.mkdirSync(screenshotDir, { recursive: true });
    const outputPath = captureArgs.outputPath?.trim()
      ? path.resolve(captureArgs.outputPath)
      : path.join(screenshotDir, `${sanitizeArtifactName(record.name)}-${Date.now()}.png`);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, encodeRgbaPng(displaySize.width, displaySize.height, rgba));
    const target = directVncTargetForRecord(lane, record, displaySize);
    emitOperation("screenshot", "completed", lane.id, record.name, "Captured diagnostic black macOS VM frame.");
    return {
      ok: true,
      laneId: lane.id,
      vmName: record.name,
      path: outputPath,
      dataUrl: readPngDataUrl(outputPath),
      capturedAt: nowIso(),
      captureMode: "direct-vnc",
      imageState: "blank",
      imageDetail,
      window: target,
    };
  };

  const captureScreenshot = async (
    captureArgs: MacosVmCaptureScreenshotArgs,
  ): Promise<MacosVmCaptureScreenshotResult> => {
    const { lane, record } = await controlRecordForLane(captureArgs.laneId);
    const directVnc = directVncConnectionForRecord(record);
    if (directVnc) {
      try {
        const screenshotDir = path.join(layout.artifactsDir, "macos-vms", lane.id);
        fs.mkdirSync(screenshotDir, { recursive: true });
        const outputPath = captureArgs.outputPath?.trim()
          ? path.resolve(captureArgs.outputPath)
          : path.join(screenshotDir, `${sanitizeArtifactName(record.name)}-${Date.now()}.png`);
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        const screenshot = await directVncClient.captureScreenshot(directVnc, 15_000);
        fs.writeFileSync(outputPath, screenshot.pngData);
        const target = directVncTargetForRecord(lane, record, screenshot);
        const directResult: MacosVmCaptureScreenshotResult = {
          ok: true,
          laneId: lane.id,
          vmName: record.name,
          path: outputPath,
          dataUrl: readPngDataUrl(outputPath),
          capturedAt: nowIso(),
          captureMode: "direct-vnc",
          imageState: screenshot.imageState,
          imageDetail: screenshot.imageState === "blank"
            ? "The VNC server returned an all-black frame. The VM provider is running, but macOS has not exposed a usable desktop yet. This can happen while a first-boot image is still initializing or when the selected base image is incompatible with this Mac."
            : null,
          window: target,
        };
        if (screenshot.imageState !== "blank") {
          emitOperation("screenshot", "completed", lane.id, record.name, "Captured macOS VM screenshot through headless VNC.");
          return directResult;
        }
        try {
          const electronCapture = await captureElectronWindowScreenshot(captureArgs, lane, record);
          if (electronCapture) return electronCapture;
          const hostTarget = await focusWindowInternal(captureArgs, { preferHostWindow: true });
          return await captureHostWindowScreenshot(captureArgs, hostTarget);
        } catch (error) {
          args.logger.warn("macos_vm.direct_vnc_blank_window_fallback_failed", {
            vmName: record.name,
            err: error instanceof Error ? error.message : String(error),
          });
          emitOperation("screenshot", "completed", lane.id, record.name, "Captured blank macOS VM screenshot through headless VNC.");
          return directResult;
        }
      } catch (directError) {
        args.logger.warn("macos_vm.direct_vnc_screenshot_failed", {
          vmName: record.name,
          err: directError instanceof Error ? directError.message : String(directError),
        });
        try {
          const electronCapture = await captureElectronWindowScreenshot(captureArgs, lane, record);
          if (electronCapture) return electronCapture;
          const hostTarget = await focusWindowInternal(captureArgs, { preferHostWindow: true });
          return await captureHostWindowScreenshot(captureArgs, hostTarget);
        } catch (fallbackError) {
          args.logger.warn("macos_vm.direct_vnc_error_window_fallback_failed", {
            vmName: record.name,
            err: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
          });
          return await captureDiagnosticBlankScreenshot(
            captureArgs,
            lane,
            record,
            "ADE could not read a usable VM frame through VNC, and macOS window capture is unavailable. The VM may still be visible in Lume's external Virtualization window.",
          );
        }
      }
    }
    try {
      const electronCapture = await captureElectronWindowScreenshot(captureArgs, lane, record);
      if (electronCapture) return electronCapture;
      const target = await focusWindowInternal(captureArgs, { preferHostWindow: true });
      return await captureHostWindowScreenshot(captureArgs, target);
    } catch (error) {
      args.logger.warn("macos_vm.window_screenshot_failed", {
        vmName: record.name,
        err: error instanceof Error ? error.message : String(error),
      });
      return await captureDiagnosticBlankScreenshot(
        captureArgs,
        lane,
        record,
        "ADE could not find or capture a VM viewer window for this running VM.",
      );
    }
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
        controlModel: "Use the ADE VM tab or an agent runtime running inside the VM. Host-side screenshot/click/type tools are legacy diagnostics only.",
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
        guestReadiness: merged.guestReadiness,
        shareMode: merged.metadata.shareMode ?? "direct",
        excludedPaths: merged.metadata.excludedPaths ?? [],
        providerDocs: LUME_DOCS,
        appleVirtualizationDocs: APPLE_VIRTUALIZATION_DOCS,
        sharedDirectoryDocs: APPLE_SHARED_DIRECTORIES_DOCS,
        controlModel: "Use the ADE VM tab or an agent runtime running inside the VM. Host-side screenshot/click/type tools are legacy diagnostics only.",
      },
    };
    const text = [
      `Use the lane-tied macOS VM "${merged.name}" for GUI or isolated macOS validation.`,
      "",
      `- ADE lane: ${lane.name} (${lane.id})`,
      `- Host lane path: ${merged.laneRoot}`,
      `- Shared directory mounted into the VM: ${merged.sharedDirectory}`,
      `- Guest mount path: ${merged.guestSharedPath}`,
      `- Guest readiness: ${merged.guestReadiness?.state ?? "unknown"}${merged.guestReadiness?.canRunCode ? " (code-ready)" : ""}`,
      `- Start command if needed: \`${runCommandText}\``,
      sshLine,
      merged.guestReadiness?.state === "setup_required"
        ? "- First boot is still in macOS Setup Assistant. Use the VM console to finish setup before expecting SSH or guest-side coding."
        : null,
      "- For GUI computer use, run the agent/runtime inside a VM-backed lane or use the ADE VM tab console directly.",
      "- Host-side screenshot/click/type VM commands are legacy diagnostics, not the default agent control model.",
      "- Keep edits inside the mounted lane folder so host and guest stay in sync through VirtioFS.",
      "- The VM lane is a direct mount of the lane worktree. Do not copy unrelated host secrets into the VM.",
    ].filter((line): line is string => typeof line === "string").join("\n");
    emitOperation("agent-guide", "completed", lane.id, merged.name, "Built macOS VM agent guidance.");
    return { laneId: lane.id, vmName: merged.name, text, target };
  };

  // Surface any resumable IPSW download on startup so the renderer can offer
  // a "Resume download" prompt. Deferred to the next tick so subscribers can
  // attach before the event fires.
  setImmediate(() => {
    if (disposed) return;
    checkForResumableDownload();
  });

  return {
    getStatus,
    provision,
    start,
    stop,
    delete: deleteVm,
    restart,
    wipe,
    installRuntime,
    setCredentials,
    getCredentials,
    getStorageInfo,
    markShareStale,
    getAgentGuide,
    focusWindow,
    getDisplaySession,
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
      for (const session of displayProxySessions.values()) session.close();
      displayProxySessions.clear();
    },
  };
}
