import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import type { FSWatcher } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as zlib from "node:zlib";
import {
  type MacosVmAgentGuide,
  type MacosVmAgentGuideArgs,
  type MacosVmBaseCreateArgs,
  type MacosVmBaseDeleteArgs,
  type MacosVmBaseMarkReadyArgs,
  type MacosVmBaseRecord,
  type MacosVmBaseStartArgs,
  type MacosVmBaseStopArgs,
  type MacosVmCaptureScreenshotArgs,
  type MacosVmCaptureScreenshotResult,
  type MacosVmClickArgs,
  type MacosVmContextItem,
  type MacosVmDeleteArgs,
  type MacosVmEventPayload,
  type MacosVmFocusBaseWindowArgs,
  type MacosVmFocusWindowArgs,
  type MacosVmIpswResolution,
  type MacosVmOperation,
  type MacosVmProviderStatus,
  type MacosVmProvisionArgs,
  type MacosVmRecord,
  type MacosVmRenameBaseArgs,
  type MacosVmSaveLaneAsSnapshotArgs,
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
  probeMacosIpswHostState,
  resolveMacosIpsw,
} from "./macosVmIpswResolver";

const APPLE_VIRTUALIZATION_DOCS = "https://developer.apple.com/documentation/virtualization/virtualize-macos-on-a-mac";
const APPLE_RUNNING_MACOS_VM_DOCS = "https://developer.apple.com/documentation/Virtualization/running-macos-in-a-virtual-machine-on-apple-silicon";
const APPLE_SHARED_DIRECTORIES_DOCS = "https://developer.apple.com/documentation/virtualization/vzvirtiofilesystemdeviceconfiguration";
const APPLE_GUEST_SHARED_PATH = "/Volumes/My Shared Files";
const MACOS_VM_HELPER_SOURCE_FILES = ["build.sh", "entitlements.plist", "macos-vm-helper.swift"] as const;
const DEFAULT_CPU_CORES = 2;
const DEFAULT_MEMORY = "4GB";
const DEFAULT_DISK_SIZE = "64GB";
const DEFAULT_DISPLAY = "1440x900";
const MACOS_VM_STATE_FILE = "records.json";
const DEFAULT_IPSW_DOWNLOAD_SIZE_BYTES = 18 * 1024 ** 3;
const MIRROR_WATCH_INITIAL_SUPPRESS_MS = 10_000;
const MIRROR_SYNC_EXCLUDES = [
  ".DS_Store",
  "._*",
  ".env",
  ".env.*",
  ".Spotlight-V100/***",
  ".fseventsd/***",
  "node_modules/***",
  "/.codex-derived-data/***",
  "/.electron-cache/***",
  "/.npm-cache/***",
  "/.pnpm-store/***",
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
  "/apps/ade-cli/dist/***",
  "/apps/ade-cli/node_modules/***",
  "/apps/desktop/dist/***",
  "/apps/desktop/native/ios-sim-helpers/build/***",
  "/apps/desktop/native/macos-vm-helper/build/***",
  "/apps/desktop/node_modules/***",
  "/apps/desktop/release/***",
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

type FetchText = (url: string) => Promise<string>;
type FetchContentLength = (url: string) => Promise<number | null>;

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
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  fetchText?: FetchText;
  fetchContentLength?: FetchContentLength;
};

type VmStoreFile = {
  version: 1;
  records: MacosVmRecord[];
};

type BaseStoreFile = {
  version: 1;
  bases: MacosVmBaseRecord[];
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

function parseSizeToBytes(value: string): number | null {
  const match = value.trim().match(/^(\d+)(GB|MB|TB)$/i);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = match[2]?.toUpperCase();
  const multiplier = unit === "TB"
    ? 1024 ** 4
    : unit === "GB"
      ? 1024 ** 3
      : 1024 ** 2;
  return amount * multiplier;
}

function formatSizeFromBytes(bytes: unknown, fallback: string): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) return fallback;
  const units: Array<[string, number]> = [["TB", 1024 ** 4], ["GB", 1024 ** 3], ["MB", 1024 ** 2]];
  for (const [unit, multiplier] of units) {
    if (bytes >= multiplier && bytes % multiplier === 0) return `${bytes / multiplier}${unit}`;
  }
  return `${Math.ceil(bytes / (1024 ** 3))}GB`;
}

function memoryPressureMessage(memory: string): string | null {
  const requestedBytes = parseSizeToBytes(memory);
  if (requestedBytes == null) return null;
  const hostBytes = os.totalmem();
  if (hostBytes <= 0) return null;
  if (requestedBytes > hostBytes * 0.4) {
    const requestedGb = Math.round(requestedBytes / (1024 ** 3));
    const hostGb = Math.round(hostBytes / (1024 ** 3));
    return `VM memory is set to ${requestedGb}GB on a ${hostGb}GB Mac. Lower it to 4GB or close apps before starting the VM.`;
  }
  return null;
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

function normalizeBaseName(value: string | null | undefined): string {
  return sanitizeVmName(value?.trim() || "default") || "default";
}

function baseDisplayName(name: string): string {
  return name === "default" ? "default" : normalizeBaseName(name);
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

function projectMirrorCacheKey(projectRoot: string): string {
  const resolved = path.resolve(projectRoot);
  const slug = sanitizeArtifactName(path.basename(resolved) || "project");
  const hash = createHash("sha256").update(resolved).digest("hex").slice(0, 12);
  return `${slug}-${hash}`;
}

function mirrorRootForProject(projectRoot: string): string {
  return path.join(os.tmpdir(), "ade-macos-vms", projectMirrorCacheKey(projectRoot));
}

function withTrailingSeparator(value: string): string {
  return value.endsWith(path.sep) ? value : `${value}${path.sep}`;
}

function isIgnoredMirrorSyncPath(value: string | Buffer | null | undefined): boolean {
  if (value == null) return false;
  const relative = String(value).replace(/\\/g, "/");
  const basename = path.basename(relative);
  const ignoredDirectories = [
    ".Spotlight-V100",
    ".codex-derived-data",
    ".electron-cache",
    ".fseventsd",
    ".npm-cache",
    ".pnpm-store",
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
    "apps/ade-cli/dist",
    "apps/ade-cli/node_modules",
    "apps/desktop/dist",
    "apps/desktop/native/ios-sim-helpers/build",
    "apps/desktop/native/macos-vm-helper/build",
    "apps/desktop/node_modules",
    "apps/desktop/release",
    "node_modules",
  ];
  if (ignoredDirectories.some((entry) => relative === entry || relative.startsWith(`${entry}/`))) return true;
  return basename === ".env"
    || (basename.startsWith(".env.") && basename !== ".env.example" && basename !== ".env.sample" && basename !== ".env.template")
    || relative === ".ade/local.yaml"
    || relative === ".DS_Store"
    || relative.endsWith("/.DS_Store")
    || path.basename(relative).startsWith("._")
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

function isProbablySleepingVmScreenshot(filePath: string): boolean {
  try {
    const buffer = fs.readFileSync(filePath);
    if (buffer.length < 33 || buffer.toString("ascii", 1, 4) !== "PNG") return false;
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    const bitDepth = buffer[24];
    const colorType = buffer[25];
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 80 || height < 80 || bitDepth !== 8) return false;
    const bytesPerPixel = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
    if (!bytesPerPixel) return false;

    const idatChunks: Buffer[] = [];
    let offset = 8;
    while (offset + 12 <= buffer.length) {
      const length = buffer.readUInt32BE(offset);
      const type = buffer.toString("ascii", offset + 4, offset + 8);
      const dataStart = offset + 8;
      const dataEnd = dataStart + length;
      if (dataEnd + 4 > buffer.length) break;
      if (type === "IDAT") idatChunks.push(buffer.subarray(dataStart, dataEnd));
      if (type === "IEND") break;
      offset = dataEnd + 4;
    }
    if (!idatChunks.length) return false;

    const inflated = zlib.inflateSync(Buffer.concat(idatChunks));
    const stride = width * bytesPerPixel;
    const expected = height * (stride + 1);
    if (inflated.length < expected) return false;

    const previous = Buffer.alloc(stride);
    const current = Buffer.alloc(stride);
    let brightSamples = 0;
    let samples = 0;
    const startY = Math.max(64, Math.floor(height * 0.08));
    const endY = Math.max(startY + 1, height - Math.max(16, Math.floor(height * 0.02)));
    const stepY = Math.max(8, Math.floor((endY - startY) / 80));
    const stepX = Math.max(8, Math.floor(width / 120));

    for (let y = 0; y < height; y += 1) {
      const rowOffset = y * (stride + 1);
      const filter = inflated[rowOffset];
      const row = inflated.subarray(rowOffset + 1, rowOffset + 1 + stride);
      for (let x = 0; x < stride; x += 1) {
        const left = x >= bytesPerPixel ? current[x - bytesPerPixel] : 0;
        const up = previous[x];
        const upLeft = x >= bytesPerPixel ? previous[x - bytesPerPixel] : 0;
        switch (filter) {
          case 0:
            current[x] = row[x];
            break;
          case 1:
            current[x] = (row[x] + left) & 0xff;
            break;
          case 2:
            current[x] = (row[x] + up) & 0xff;
            break;
          case 3:
            current[x] = (row[x] + Math.floor((left + up) / 2)) & 0xff;
            break;
          case 4: {
            const p = left + up - upLeft;
            const pa = Math.abs(p - left);
            const pb = Math.abs(p - up);
            const pc = Math.abs(p - upLeft);
            const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
            current[x] = (row[x] + predictor) & 0xff;
            break;
          }
          default:
            return false;
        }
      }

      if (y >= startY && y < endY && (y - startY) % stepY === 0) {
        for (let px = Math.floor(width * 0.05); px < Math.floor(width * 0.95); px += stepX) {
          const index = px * bytesPerPixel;
          const red = current[index] ?? 0;
          const green = current[index + 1] ?? 0;
          const blue = current[index + 2] ?? 0;
          if (Math.max(red, green, blue) > 48 || red + green + blue > 120) brightSamples += 1;
          samples += 1;
        }
      }

      previous.set(current);
    }

    return samples > 200 && brightSamples / samples < 0.01;
  } catch {
    return false;
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

function readBaseStoreFile(storePath: string): BaseStoreFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath, "utf8")) as Partial<BaseStoreFile>;
    const bases = Array.isArray(parsed.bases)
      ? parsed.bases.filter((base): base is MacosVmBaseRecord => isRecord(base) && typeof base.id === "string")
      : [];
    return { version: 1, bases };
  } catch {
    return { version: 1, bases: [] };
  }
}

function writeBaseStoreFile(storePath: string, store: BaseStoreFile): void {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const tmpPath = `${storePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, storePath);
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJsonFile(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

type HelperBuildInfo = {
  helper: string;
  buildDir: string;
  sourceHash?: string;
  osVersion?: string;
};

type HelperProgressPayload = {
  type?: string;
  stage?: string;
  message?: string;
  fraction?: number;
  restoreImage?: unknown;
};

type RuntimeStatusPayload = {
  type?: string;
  title?: string;
  event?: string;
  state?: string;
  pid?: number;
  updatedAt?: string;
  error?: string;
};

type HelperWindowPayload = {
  type?: string;
  windowId?: number;
  processId?: number;
  processName?: string;
  windowTitle?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
};

function parseHelperJson<T>(stdout: string): T | null {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const parsed = parseJsonLoose<T>(lines[index] ?? "");
    if (parsed) return parsed;
  }
  return null;
}

function parseHelperErrorMessage(stdout: string): string | null {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const parsed = parseJsonLoose<{ type?: string; message?: string }>(lines[index] ?? "");
    if (parsed?.type === "error" && parsed.message?.trim()) return parsed.message.trim();
  }
  return null;
}

function helperProgressMessage(payload: HelperProgressPayload): string | null {
  if (payload.message && payload.message.trim()) return payload.message.trim();
  if (payload.stage === "download") return "Downloading macOS restore image from Apple.";
  if (payload.stage === "configure") return "Creating the macOS VM bundle.";
  if (payload.stage === "install") {
    if (typeof payload.fraction === "number" && Number.isFinite(payload.fraction)) {
      return `Installing macOS into the VM disk (${Math.max(0, Math.min(100, Math.round(payload.fraction * 100)))}%).`;
    }
    return "Installing macOS into the VM disk.";
  }
  return null;
}

function isPidAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(Math.trunc(pid), 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "EPERM");
  }
}

function provisionErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/software update/i.test(message)) {
    return `${message} Use a restore IPSW that matches this Mac's current macOS build, or update the host Mac and retry latest.`;
  }
  return message;
}

function helperSourceDirCandidates(projectRoot: string): string[] {
  const resourcesPath = typeof process.resourcesPath === "string" ? process.resourcesPath : "";
  return [
    path.join(projectRoot, "apps", "desktop", "native", "macos-vm-helper"),
    path.resolve(__dirname, "../../../../native/macos-vm-helper"),
    resourcesPath ? path.join(resourcesPath, "macos-vm-helper") : "",
    resourcesPath ? path.join(resourcesPath, "native", "macos-vm-helper") : "",
  ].filter(Boolean);
}

function resolveHelperSourceDir(projectRoot: string): string {
  for (const candidate of helperSourceDirCandidates(projectRoot)) {
    try {
      if (MACOS_VM_HELPER_SOURCE_FILES.every((file) => fs.existsSync(path.join(candidate, file)))) {
        return candidate;
      }
    } catch {
      // Ignore inaccessible resource candidates.
    }
  }
  return path.join(projectRoot, "apps", "desktop", "native", "macos-vm-helper");
}

function helperSourceStamp(helperSourceDir: string): string {
  return MACOS_VM_HELPER_SOURCE_FILES.map((file) => {
    const filePath = path.join(helperSourceDir, file);
    try {
      const stat = fs.statSync(filePath);
      return `${file}:${stat.size}:${Math.trunc(stat.mtimeMs)}`;
    } catch {
      return `${file}:missing`;
    }
  }).join("|");
}

function nativeVmRoot(projectRoot: string, env: NodeJS.ProcessEnv): string {
  if (env.ADE_MACOS_VM_BUNDLE_ROOT?.trim()) return path.resolve(env.ADE_MACOS_VM_BUNDLE_ROOT);
  const projectKey = projectMirrorCacheKey(projectRoot);
  return path.join(os.homedir(), "Library", "Application Support", "ADE", "macos-vms", projectKey);
}

function nativeVmGlobalRoot(projectRoot: string, env: NodeJS.ProcessEnv): string {
  if (env.ADE_MACOS_VM_BUNDLE_ROOT?.trim()) return path.resolve(env.ADE_MACOS_VM_BUNDLE_ROOT);
  return path.dirname(nativeVmRoot(projectRoot, env));
}

function nativeVmBundlePath(root: string, lane: LaneContext, vmName: string): string {
  return path.join(root, sanitizeArtifactName(lane.id), `${sanitizeArtifactName(vmName)}.bundle`);
}

function nativeBaseBundlePath(root: string, baseName: string): string {
  return path.join(root, `${normalizeBaseName(baseName)}.bundle`);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function ipswCacheFilePath(restoreImagesDir: string, ipsw: string): string | null {
  try {
    const url = new URL(ipsw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const name = path.basename(decodeURIComponent(url.pathname));
    return name.toLowerCase().endsWith(".ipsw") ? path.join(restoreImagesDir, name) : null;
  } catch {
    return null;
  }
}

function bytesInPath(targetPath: string): number {
  try {
    const stat = fs.statSync(targetPath);
    if (stat.isFile()) return stat.size;
    if (!stat.isDirectory()) return 0;
    let total = 0;
    for (const entry of fs.readdirSync(targetPath)) {
      total += bytesInPath(path.join(targetPath, entry));
    }
    return total;
  } catch {
    return 0;
  }
}

function formatBytes(bytes: number | null | undefined): string | null {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return null;
  const gb = bytes / (1024 ** 3);
  return `${gb.toFixed(gb >= 10 ? 1 : 2)} GB`;
}

function ipswResolutionMessage(resolution: MacosVmIpswResolution): string {
  const size = formatBytes(resolution.sizeBytes);
  return [
    `Found the right installer for your Mac: macOS ${resolution.productVersion} (${resolution.build})`,
    size ? ` · ${size}` : "",
  ].join("");
}

export function createMacosVmService(args: CreateMacosVmServiceArgs) {
  const platform = args.platform ?? process.platform;
  const arch = args.arch ?? process.arch;
  const env = args.env ?? process.env;
  const runCommand = args.runCommand ?? defaultRunCommand;
  const layout = resolveAdeLayout(args.projectRoot);
  const storeDir = path.join(layout.cacheDir, "macos-vms");
  const storePath = path.join(storeDir, MACOS_VM_STATE_FILE);
  const projectRoot = path.resolve(args.projectRoot);
  const mirrorRoot = mirrorRootForProject(projectRoot);
  const helperSourceDir = resolveHelperSourceDir(projectRoot);
  const helperBuildScript = path.join(helperSourceDir, "build.sh");
  const vmBundleRoot = nativeVmRoot(projectRoot, env);
  const globalVmRoot = nativeVmGlobalRoot(projectRoot, env);
  const baseBundleRoot = path.join(globalVmRoot, "bases");
  const baseStorePath = path.join(baseBundleRoot, "bases.json");
  const restoreImagesDir = path.join(globalVmRoot, "restore-images");
  const mirrorSyncSessions = new Map<string, MirrorSyncSession>();
  const provisionTasks = new Map<string, Promise<MacosVmRecord>>();
  const baseProvisionTasks = new Map<string, Promise<MacosVmBaseRecord>>();
  const startAfterProvisionTasks = new Map<string, Promise<void>>();
  let helperBuildPromise: Promise<HelperBuildInfo> | null = null;
  let helperBuildStamp: string | null = null;
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
    state: "started" | "progress" | "completed" | "failed",
    laneId: string | null,
    vmName: string | null,
    message: string,
    detail: { stage?: string | null; progress?: number | null } = {},
  ): void => {
    emit({ type: "operation", operation, state, laneId, vmName, message, occurredAt: nowIso(), ...detail });
    const logFn = state === "failed" ? args.logger.warn : args.logger.info;
    logFn(`macos_vm.${operation.replace(/-/g, "_")}.${state}`, {
      laneId,
      vmName,
      message,
      ...(detail.stage != null ? { stage: detail.stage } : {}),
      ...(detail.progress != null ? { progress: detail.progress } : {}),
    });
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

  const loadBases = (): MacosVmBaseRecord[] => readBaseStoreFile(baseStorePath).bases;

  const saveBases = (bases: MacosVmBaseRecord[]): void => {
    writeBaseStoreFile(baseStorePath, { version: 1, bases });
  };

  const upsertBase = (base: MacosVmBaseRecord): MacosVmBaseRecord => {
    const bases = loadBases();
    const index = bases.findIndex((entry) => entry.id === base.id || normalizeBaseName(entry.name) === normalizeBaseName(base.name));
    const next = { ...base, name: normalizeBaseName(base.name), updatedAt: nowIso() };
    if (index >= 0) bases[index] = next;
    else bases.push(next);
    saveBases(bases);
    emit({ type: "base-updated", base: next });
    return next;
  };

  const removeBaseRecord = (name: string): MacosVmBaseRecord | null => {
    const normalized = normalizeBaseName(name);
    const bases = loadBases();
    const base = bases.find((entry) => normalizeBaseName(entry.name) === normalized) ?? null;
    saveBases(bases.filter((entry) => normalizeBaseName(entry.name) !== normalized));
    return base;
  };

  const baseRecordForName = (baseArgs: Partial<MacosVmBaseCreateArgs & MacosVmBaseStartArgs> = {}): MacosVmBaseRecord => {
    const name = normalizeBaseName(baseArgs.name);
    const existing = loadBases().find((entry) => normalizeBaseName(entry.name) === name);
    const now = nowIso();
    const bundlePath = typeof existing?.metadata.bundlePath === "string"
      ? existing.metadata.bundlePath
      : nativeBaseBundlePath(baseBundleRoot, name);
    return {
      id: existing?.id ?? `macos-vm-base:${name}`,
      provider: "apple-virtualization-helper",
      name,
      state: existing?.state ?? "not_created",
      cpuCores: asPositiveInteger(baseArgs.cpuCores, existing?.cpuCores ?? DEFAULT_CPU_CORES),
      memory: normalizeSize(baseArgs.memory, existing?.memory ?? DEFAULT_MEMORY),
      diskSize: normalizeSize(baseArgs.diskSize, existing?.diskSize ?? DEFAULT_DISK_SIZE),
      display: normalizeDisplay(baseArgs.display, existing?.display ?? DEFAULT_DISPLAY),
      guestSharedPath: APPLE_GUEST_SHARED_PATH,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastStartedAt: existing?.lastStartedAt ?? null,
      lastStoppedAt: existing?.lastStoppedAt ?? null,
      lastError: existing?.lastError ?? null,
      metadata: {
        ...(existing?.metadata ?? {}),
        bundlePath,
        nativeHelper: true,
        guestSetupCompleted: existing?.metadata.guestSetupCompleted === true,
        baseRole: "prepared-base",
        appleDocs: APPLE_VIRTUALIZATION_DOCS,
        appleRunningMacosVmDocs: APPLE_RUNNING_MACOS_VM_DOCS,
        sharedDirectoryDocs: APPLE_SHARED_DIRECTORIES_DOCS,
      },
    };
  };

  const reconcileRecordWithBundle = (record: MacosVmRecord): MacosVmRecord => {
    const bundlePath = typeof record.metadata.bundlePath === "string" ? record.metadata.bundlePath : null;
    if (!bundlePath || !fs.existsSync(path.join(bundlePath, "ade-vm.json"))) return record;
    const runtimeStatus = readJsonFile<RuntimeStatusPayload>(path.join(bundlePath, "runtime-status.json"));
    if (runtimeStatus?.state === "error" && ["running", "starting", "stopping", "paused"].includes(record.state)) {
      const detail = runtimeStatus.error?.trim()
        || (runtimeStatus.event ? `Apple Virtualization reported VM state error during ${runtimeStatus.event}.` : "Apple Virtualization reported VM state error.");
      return upsertRecord({
        ...record,
        state: "failed",
        lastError: detail,
        metadata: {
          ...record.metadata,
          nativeHelperPid: null,
          runtimeStatus,
        },
      });
    }
    if (runtimeStatus?.state === "stopped" && ["running", "starting", "stopping", "paused"].includes(record.state)) {
      return upsertRecord({
        ...record,
        state: "stopped",
        lastStoppedAt: nowIso(),
        metadata: {
          ...record.metadata,
          nativeHelperPid: null,
          runtimeStatus,
        },
      });
    }
    if (!["not_created", "creating", "installing", "unknown"].includes(record.state)) {
      return runtimeStatus ? { ...record, metadata: { ...record.metadata, runtimeStatus } } : record;
    }
    return upsertRecord({
      ...record,
      state: "stopped",
      lastError: null,
      metadata: {
        ...record.metadata,
        nativeProvisionPid: null,
        runtimeStatus: runtimeStatus ?? record.metadata.runtimeStatus,
        provisionStage: "completed",
        provisionProgress: 1,
        provisionMessage: "macOS VM is ready for this lane.",
      },
    });
  };

  const reconcileBaseWithBundle = (base: MacosVmBaseRecord): MacosVmBaseRecord => {
    const bundlePath = typeof base.metadata.bundlePath === "string" ? base.metadata.bundlePath : null;
    if (!bundlePath || !fs.existsSync(path.join(bundlePath, "ade-vm.json"))) return base;
    const runtimeStatus = readJsonFile<RuntimeStatusPayload>(path.join(bundlePath, "runtime-status.json"));
    const setupComplete = base.metadata.guestSetupCompleted === true;
    const stoppedState: MacosVmBaseRecord["state"] = setupComplete ? "ready" : "setup_required";
    if (runtimeStatus?.state === "error" && ["running", "starting", "stopping", "paused"].includes(base.state)) {
      const detail = runtimeStatus.error?.trim()
        || (runtimeStatus.event ? `Apple Virtualization reported base VM state error during ${runtimeStatus.event}.` : "Apple Virtualization reported base VM state error.");
      return upsertBase({
        ...base,
        state: "failed",
        lastError: detail,
        metadata: {
          ...base.metadata,
          nativeHelperPid: null,
          runtimeStatus,
        },
      });
    }
    if (runtimeStatus?.state === "stopped" && ["running", "starting", "stopping", "paused"].includes(base.state)) {
      return upsertBase({
        ...base,
        state: stoppedState,
        lastStoppedAt: nowIso(),
        metadata: {
          ...base.metadata,
          nativeHelperPid: null,
          runtimeStatus,
        },
      });
    }
    if (!["not_created", "creating", "installing", "unknown"].includes(base.state)) {
      return runtimeStatus ? { ...base, metadata: { ...base.metadata, runtimeStatus } } : base;
    }
    return upsertBase({
      ...base,
      state: stoppedState,
      lastError: null,
      metadata: {
        ...base.metadata,
        nativeProvisionPid: null,
        runtimeStatus: runtimeStatus ?? base.metadata.runtimeStatus,
        provisionStage: "completed",
        provisionProgress: 1,
        provisionMessage: setupComplete
          ? "Prepared macOS base is ready for lane cloning."
          : "Prepared base install is complete. Start it once, finish macOS Setup Assistant, then mark it ready.",
      },
    });
  };

  const currentRecordForLane = (laneId: string, fallback: MacosVmRecord): MacosVmRecord => (
    loadRecords().find((entry) => entry.laneId === laneId) ?? fallback
  );

  const removeRecord = (laneId: string): MacosVmRecord | null => {
    const records = loadRecords();
    const record = records.find((entry) => entry.laneId === laneId) ?? null;
    saveRecords(records.filter((entry) => entry.laneId !== laneId));
    return record;
  };

  const buildHelper = async (): Promise<HelperBuildInfo> => {
    const currentStamp = helperSourceStamp(helperSourceDir);
    if (helperBuildStamp && helperBuildStamp !== currentStamp) {
      helperBuildPromise = null;
    }
    helperBuildStamp = currentStamp;
    if (helperBuildPromise) return helperBuildPromise;
    helperBuildPromise = (async () => {
      const result = await runCommand(helperBuildScript, ["--print-json", "--smoke"], { timeoutMs: 120_000, cwd: helperSourceDir });
      if (result.exitCode !== 0) {
        const detail = (result.stderr || result.stdout || `${helperBuildScript} exited with code ${result.exitCode ?? "unknown"}`).trim();
        throw new Error(detail);
      }
      const parsed = parseHelperJson<HelperBuildInfo>(result.stdout);
      if (!parsed?.helper) throw new Error("macOS VM helper build did not report a helper path.");
      helperBuildStamp = currentStamp;
      return parsed;
    })().catch((error) => {
      helperBuildPromise = null;
      throw error;
    });
    return helperBuildPromise;
  };

  const runHelper = async <T>(command: string, helperArgs: string[], timeoutMs: number): Promise<T> => {
    const helper = await buildHelper();
    const result = await runCommand(helper.helper, [command, ...helperArgs], { timeoutMs, cwd: helper.buildDir || helperSourceDir });
    if (result.exitCode !== 0) {
      const detail = (parseHelperErrorMessage(result.stdout) || result.stderr || result.stdout || `${helper.helper} exited with code ${result.exitCode ?? "unknown"}`).trim();
      throw new Error(detail);
    }
    const parsed = parseHelperJson<T>(result.stdout);
    if (!parsed) throw new Error(`macOS VM helper did not return JSON for ${command}.`);
    return parsed;
  };

  const runHelperStreaming = async <T>(
    command: string,
    helperArgs: string[],
    timeoutMs: number,
    options: {
      onPayload?: (payload: HelperProgressPayload) => void;
      onSpawn?: (pid: number | null) => void;
    } = {},
  ): Promise<T> => {
    const helper = await buildHelper();
    return new Promise<T>((resolve, reject) => {
      const child = spawn(helper.helper, [command, ...helperArgs], {
        cwd: helper.buildDir || helperSourceDir,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...env },
      });
      let stdout = "";
      let stderr = "";
      let stdoutLineBuffer = "";
      let settled = false;

      const appendStdoutLine = (line: string): void => {
        const trimmed = line.trim();
        if (!trimmed) return;
        stdout += `${trimmed}\n`;
        if (stdout.length > 2_000_000) stdout = stdout.slice(-1_000_000);
        const payload = parseJsonLoose<HelperProgressPayload>(trimmed);
        if (payload) options.onPayload?.(payload);
      };

      const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (stdoutLineBuffer.trim()) appendStdoutLine(stdoutLineBuffer);
        if (exitCode !== 0) {
          const detail = (parseHelperErrorMessage(stdout) || stderr || stdout || `${helper.helper} exited with code ${exitCode ?? signal ?? "unknown"}`).trim();
          reject(new Error(detail));
          return;
        }
        const parsed = parseHelperJson<T>(stdout);
        if (!parsed) {
          reject(new Error(`macOS VM helper did not return JSON for ${command}.`));
          return;
        }
        resolve(parsed);
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
        }, 1_000);
        finish(null, "SIGTERM");
      }, timeoutMs);

      child.once("spawn", () => options.onSpawn?.(child.pid ?? null));
      child.stdout?.on("data", (chunk: Buffer | string) => {
        stdoutLineBuffer += chunk.toString();
        const lines = stdoutLineBuffer.split(/\r?\n/);
        stdoutLineBuffer = lines.pop() ?? "";
        for (const line of lines) appendStdoutLine(line);
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
      child.once("exit", finish);
    });
  };

  const launchHelperRun = async (helperArgs: string[]): Promise<{ pid: number | null }> => {
    const helper = await buildHelper();
    if (args.runCommand) {
      await runHelper("run", helperArgs, 5_000);
      return { pid: null };
    }
    return new Promise<{ pid: number | null }>((resolve, reject) => {
      const child = spawn(helper.helper, ["run", ...helperArgs], {
        cwd: helper.buildDir || helperSourceDir,
        detached: true,
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let settled = false;
      let stdoutLineBuffer = "";
      let stdout = "";
      let stderr = "";
      const detachPipes = (): void => {
        child.stdout?.removeAllListeners("data");
        child.stderr?.removeAllListeners("data");
        child.stdout?.destroy();
        child.stderr?.destroy();
      };
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else {
          detachPipes();
          child.unref();
          resolve({ pid: child.pid ?? null });
        }
      };
      const timeout = setTimeout(() => {
        try {
          child.kill("SIGTERM");
        } catch {
          // ignore
        }
        finish(new Error("Timed out waiting for native macOS VM start confirmation."));
      }, 30_000);
      child.once("error", (error) => finish(error));
      child.stdout?.on("data", (chunk: Buffer | string) => {
        stdoutLineBuffer += chunk.toString();
        const lines = stdoutLineBuffer.split(/\r?\n/);
        stdoutLineBuffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          stdout += `${trimmed}\n`;
          if (stdout.length > 200_000) stdout = stdout.slice(-100_000);
          const payload = parseJsonLoose<{ type?: string; message?: string }>(trimmed);
          if (payload?.type === "started") {
            finish();
            return;
          }
          if (payload?.type === "error") {
            finish(new Error(payload.message || "Native macOS VM start failed."));
            return;
          }
        }
      });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        stderr += chunk.toString();
        if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
      });
      child.once("exit", (exitCode, signal) => {
        if (settled) return;
        const detail = (parseHelperErrorMessage(stdout) || stderr || stdout || `${helper.helper} exited with code ${exitCode ?? signal ?? "unknown"}`).trim();
        finish(new Error(detail));
      });
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

  const detectAppleVirtualization = async (): Promise<{ available: boolean; version: string | null; detail: string }> => {
    if (platform !== "darwin") {
      return { available: false, version: null, detail: "macOS virtual machines are only available from ADE on macOS." };
    }
    if (arch !== "arm64") {
      return { available: false, version: null, detail: "macOS guests require an Apple silicon Mac." };
    }
    try {
      const result = await runHelper<{ osVersion?: string; supported?: boolean }>("doctor", [], 15_000);
      return result.supported === false
        ? { available: false, version: result.osVersion ?? null, detail: "Apple Virtualization is not available for macOS guests on this host." }
        : {
            available: true,
            version: result.osVersion ?? null,
            detail: "Apple Virtualization helper is available. ADE will create and run macOS VMs natively.",
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
    const apple = await detectAppleVirtualization();
    return {
      kind: "apple-virtualization-helper",
      available: apple.available,
      version: apple.version,
      detail: apple.detail,
      docsUrl: APPLE_VIRTUALIZATION_DOCS,
    };
  };

  const toolStatuses = async (): Promise<MacosVmToolStatus[]> => {
    const apple = await detectAppleVirtualization();
    const appleSupported = platform === "darwin" && arch === "arm64";
    return [
      {
        name: "apple-virtualization",
        available: appleSupported && apple.available,
        detail: appleSupported ? apple.detail : "macOS guests require Apple silicon on macOS.",
        installHint: "Use an Apple silicon Mac running macOS with Virtualization.framework support.",
        docsUrl: APPLE_VIRTUALIZATION_DOCS,
      },
    ];
  };

  const windowPayloadTarget = (
    payload: HelperWindowPayload,
    laneId: string,
    vmName: string,
    windowTitleQuery: string,
  ): MacosVmWindowTarget => {
    const frameValues = [payload.x, payload.y, payload.width, payload.height]
      .map((value) => (typeof value === "number" ? Math.round(value) : Number.NaN));
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
      processName: payload.processName?.trim() || "unknown",
      processId: typeof payload.processId === "number" ? payload.processId : null,
      windowId: typeof payload.windowId === "number" ? payload.windowId : null,
      windowTitle: payload.windowTitle?.trim() || windowTitleQuery,
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
    path.join(mirrorRoot, "shares", sanitizeArtifactName(lane.id), "worktree");

  const sharePlanForLane = (lane: LaneContext): SharePlan => {
    const originalHostPath = path.resolve(lane.worktreePath);
    const adeLocalStatePath = path.join(originalHostPath, ".ade");
    const hasAdeLocalState = fs.existsSync(adeLocalStatePath);
    const mirrorPath = hasAdeLocalState ? mirrorPathForLane(lane) : null;
    return {
      hostPath: mirrorPath ?? originalHostPath,
      guestPath: APPLE_GUEST_SHARED_PATH,
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
    options: { checksum?: boolean; delete?: boolean; deleteExcluded?: boolean; preserveMetadata?: boolean } = {},
  ): Promise<void> => {
    fs.mkdirSync(destination, { recursive: true });
    const rsyncArgs = [
      options.preserveMetadata === false ? "-rl" : "-rlpt",
      ...(options.checksum ? ["--checksum"] : []),
      ...(options.delete ?? true ? ["--delete"] : []),
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
    await rsyncMirror(mirrorPath, lane.worktreePath, { checksum: true, delete: false, preserveMetadata: false });
  };

  const terminateNativeHelperProcess = async (record: { name: string; metadata: Record<string, unknown> }): Promise<void> => {
    const pids = ["nativeProvisionPid", "nativeHelperPid"]
      .map((key) => record.metadata[key])
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
      .map((value) => Math.trunc(value))
      .filter((pid, index, values) => pid > 0 && values.indexOf(pid) === index);
    for (const pid of pids) {
      await runHostCommand("kill", ["-TERM", String(pid)], 5_000).catch((error) => {
        args.logger.warn("macos_vm.stop_kill_pid_failed", {
          vmName: record.name,
          pid,
          err: error instanceof Error ? error.message : String(error),
        });
      });
    }
    if (pids.length) await delay(1_000);
    for (const pid of pids) {
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
      suppressUntilMs: Date.now() + MIRROR_WATCH_INITIAL_SUPPRESS_MS,
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
    const flushPendingMirrorChanges = Boolean(flush && mirrorPath && session?.mirrorTimer);
    if (session) {
      session.disposed = true;
      if (session.laneTimer) clearTimeout(session.laneTimer);
      if (session.mirrorTimer) clearTimeout(session.mirrorTimer);
      session.laneWatcher?.close();
      session.mirrorWatcher?.close();
      mirrorSyncSessions.delete(lane.id);
    }
    if (flushPendingMirrorChanges && mirrorPath) {
      await syncMirrorToLane(lane, mirrorPath);
    }
  };

  const ensureShareReady = async (lane: LaneContext): Promise<SharePlan> => {
    const share = sharePlanForLane(lane);
    if (share.syncMode === "sanitized-mirror" && share.mirrorPath) {
      const existing = mirrorSyncSessions.get(lane.id);
      if (existing && !existing.disposed) {
        existing.syncing = true;
        existing.suppressUntilMs = Date.now() + 3_000;
        try {
          await syncLaneToMirror(lane, share.mirrorPath);
        } finally {
          existing.syncing = false;
          existing.suppressUntilMs = Date.now() + 3_000;
        }
      } else {
        await syncLaneToMirror(lane, share.mirrorPath);
      }
    }
    return share;
  };

  const refreshRecordShareForLane = (record: MacosVmRecord, lane: LaneContext): MacosVmRecord => {
    const share = sharePlanForLane(lane);
    if (
      (record.state === "running" || record.state === "starting")
      && share.syncMode === "sanitized-mirror"
      && share.mirrorPath
      && !mirrorSyncSessions.get(lane.id)
    ) {
      startMirrorSync(lane, share.mirrorPath);
      const session = mirrorSyncSessions.get(lane.id);
      if (session) {
        session.syncing = true;
        session.suppressUntilMs = Date.now() + MIRROR_WATCH_INITIAL_SUPPRESS_MS;
      }
      void syncLaneToMirror(lane, share.mirrorPath)
        .catch((error) => {
          args.logger.warn("macos_vm.mirror_resume_sync_failed", {
            laneId: lane.id,
            err: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          if (session && !session.disposed) {
            session.syncing = false;
            session.suppressUntilMs = Date.now() + 1_500;
          }
        });
    }
    return {
      ...record,
      laneName: lane.name,
      laneRoot: lane.worktreePath,
      guestSharedPath: APPLE_GUEST_SHARED_PATH,
      sharedDirectory: share.hostPath,
      metadata: {
        ...record.metadata,
        shareMode: share.syncMode,
        originalHostPath: share.originalHostPath,
        mirrorPath: share.mirrorPath,
        excludedPaths: share.excludedPaths,
        nativeHelper: true,
        appleDocs: APPLE_VIRTUALIZATION_DOCS,
        appleRunningMacosVmDocs: APPLE_RUNNING_MACOS_VM_DOCS,
        sharedDirectoryDocs: APPLE_SHARED_DIRECTORIES_DOCS,
      },
    };
  };

  const refreshRecordsShareState = async (records: MacosVmRecord[]): Promise<MacosVmRecord[]> => {
    if (records.length === 0) return records;
    try {
      const lanes = await args.resolveLanes();
      const laneById = new Map(lanes.map((lane) => [lane.id, lane]));
      return records.map((record) => {
        const lane = laneById.get(record.laneId);
        return lane ? refreshRecordShareForLane(record, lane) : record;
      });
    } catch (error) {
      args.logger.warn("macos_vm.share_state_refresh_failed", {
        err: error instanceof Error ? error.message : String(error),
      });
      return records;
    }
  };

  const requireProviderReady = async (): Promise<void> => {
    const provider = await providerStatus();
    if (!provider.available) {
      throw new Error(provider.detail);
    }
  };

  const requireHostCapacity = (record: { memory: string }): void => {
    const message = memoryPressureMessage(record.memory);
    if (message) throw new Error(message);
  };

  const resolveProvisionIpsw = async (
    requestedIpsw: string,
    operation: "base-create" | "provision",
    laneId: string | null,
    vmName: string,
    updateMetadata: (metadata: Record<string, unknown>) => void,
  ): Promise<{ ipsw: string; resolution: MacosVmIpswResolution | null }> => {
    const requested = requestedIpsw.trim() || "latest";
    if (requested !== "latest") {
      updateMetadata({
        ipsw: requested,
        ipswRequested: requested,
      });
      return { ipsw: requested, resolution: null };
    }

    const resolvingMessage = "Looking for the right macOS installer for your Mac…";
    updateMetadata({
      ipsw: "latest",
      ipswRequested: "latest",
      provisionStage: "resolve",
      provisionProgress: null,
      provisionMessage: resolvingMessage,
      provisionUpdatedAt: nowIso(),
    });
    emitOperation(operation, "progress", laneId, vmName, resolvingMessage, { stage: "resolve", progress: null });

    try {
      const host = await probeMacosIpswHostState(runCommand);
      updateMetadata({ ipswHostState: host });
      const resolution = await resolveMacosIpsw(host, {
        fetchText: args.fetchText,
        fetchContentLength: args.fetchContentLength,
      });
      if (!resolution) return { ipsw: "latest", resolution: null };

      const message = ipswResolutionMessage(resolution);
      updateMetadata({
        ipsw: resolution.url,
        ipswRequested: "latest",
        ipswResolution: resolution,
        ipswAlternatives: resolution.alternatives,
        ipswHostState: resolution.host,
        provisionStage: "download",
        provisionProgress: null,
        provisionMessage: message,
        provisionUpdatedAt: nowIso(),
      });
      emitOperation(operation, "progress", laneId, vmName, message, { stage: "download", progress: null });
      return { ipsw: resolution.url, resolution };
    } catch (error) {
      args.logger.warn("macos_vm.ipsw_resolver_failed", {
        laneId,
        vmName,
        err: error instanceof Error ? error.message : String(error),
      });
      updateMetadata({
        ipsw: "latest",
        ipswRequested: "latest",
        ipswResolutionError: error instanceof Error ? error.message : String(error),
      });
      return { ipsw: "latest", resolution: null };
    }
  };

  const startIpswDownloadProgressMonitor = (
    targetPath: string | null,
    expectedBytes: number | null | undefined,
    onProgress: (fraction: number) => void,
  ): (() => void) => {
    if (!targetPath) return () => {};
    const totalBytes = expectedBytes && expectedBytes > 0 ? expectedBytes : DEFAULT_IPSW_DOWNLOAD_SIZE_BYTES;
    let lastFraction = 0;
    const sample = (): void => {
      const bytesWritten = Math.max(bytesInPath(targetPath), bytesInPath(`${targetPath}.download`));
      if (bytesWritten <= 0) return;
      const fraction = Math.max(0, Math.min(0.95, bytesWritten / totalBytes));
      if (fraction <= lastFraction + 0.002) return;
      lastFraction = fraction;
      onProgress(fraction);
    };
    const timer = setInterval(sample, 1_500);
    sample();
    return () => clearInterval(timer);
  };

  const recordForLane = (lane: LaneContext, config: Partial<MacosVmProvisionArgs & MacosVmStartArgs> = {}): MacosVmRecord => {
    const existing = loadRecords().find((entry) => entry.laneId === lane.id);
    const share = sharePlanForLane(lane);
    const now = nowIso();
    const name = sanitizeVmName(config.name?.trim() || existing?.name || defaultVmName(projectRoot, lane));
    const bundlePath = typeof existing?.metadata.bundlePath === "string"
      ? existing.metadata.bundlePath
      : nativeVmBundlePath(vmBundleRoot, lane, name);
    return {
      id: existing?.id ?? `macos-vm:${lane.id}`,
      provider: "apple-virtualization-helper",
      name,
      laneId: lane.id,
      laneName: lane.name,
      laneRoot: lane.worktreePath,
      state: existing?.state ?? "not_created",
      cpuCores: asPositiveInteger(config.cpuCores, existing?.cpuCores ?? DEFAULT_CPU_CORES),
      memory: normalizeSize(config.memory, existing?.memory ?? DEFAULT_MEMORY),
      diskSize: normalizeSize(config.diskSize, existing?.diskSize ?? DEFAULT_DISK_SIZE),
      display: normalizeDisplay(config.display, existing?.display ?? DEFAULT_DISPLAY),
      guestSharedPath: APPLE_GUEST_SHARED_PATH,
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
        bundlePath,
        nativeHelper: true,
        appleDocs: APPLE_VIRTUALIZATION_DOCS,
        appleRunningMacosVmDocs: APPLE_RUNNING_MACOS_VM_DOCS,
        sharedDirectoryDocs: APPLE_SHARED_DIRECTORIES_DOCS,
      },
    };
  };

  const getStatus = async (statusArgs: MacosVmStatusArgs = {}): Promise<MacosVmStatus> => {
    const records = await refreshRecordsShareState(loadRecords().map(reconcileRecordWithBundle));
    const bases = loadBases().map(reconcileBaseWithBundle);
    const defaultBase = bases.find((base) => normalizeBaseName(base.name) === "default") ?? bases[0] ?? null;
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
      defaultBase,
      bases,
      docs: {
        appleVirtualization: APPLE_VIRTUALIZATION_DOCS,
        appleSharedDirectories: APPLE_SHARED_DIRECTORIES_DOCS,
      },
    };
    emit({ type: "status", status });
    return status;
  };

  const currentBaseForName = (name: string, fallback: MacosVmBaseRecord): MacosVmBaseRecord => (
    loadBases().find((entry) => normalizeBaseName(entry.name) === normalizeBaseName(name)) ?? fallback
  );

  const getReadyBase = (name?: string | null): MacosVmBaseRecord | null => {
    const bases = loadBases().map(reconcileBaseWithBundle);
    const normalized = name ? normalizeBaseName(name) : null;
    const base = normalized
      ? bases.find((entry) => normalizeBaseName(entry.name) === normalized) ?? null
      : bases.find((entry) => normalizeBaseName(entry.name) === "default" && entry.state === "ready")
        ?? bases.find((entry) => entry.state === "ready")
        ?? null;
    return base?.state === "ready" ? base : null;
  };

  const runBaseProvisionToCompletion = async (
    initialBase: MacosVmBaseRecord,
    baseArgs: MacosVmBaseCreateArgs,
  ): Promise<MacosVmBaseRecord> => {
    let base = initialBase;
    const bundlePath = String(base.metadata.bundlePath ?? "");
    let lastProgressEmitMs = 0;
    let lastProgressFraction: number | null = null;
    const updateFromProgress = (payload: HelperProgressPayload): void => {
      if (payload.type !== "progress") return;
      const stage = payload.stage ?? "provision";
      const fraction = typeof payload.fraction === "number" && Number.isFinite(payload.fraction)
        ? Math.max(0, Math.min(1, payload.fraction))
        : null;
      const now = Date.now();
      if (
        fraction != null
        && lastProgressFraction != null
        && Math.abs(fraction - lastProgressFraction) < 0.01
        && now - lastProgressEmitMs < 2_000
      ) {
        return;
      }
      lastProgressEmitMs = now;
      lastProgressFraction = fraction;
      const message = helperProgressMessage(payload) ?? "Provisioning prepared macOS base.";
      const state: MacosVmBaseRecord["state"] = stage === "install" ? "installing" : "creating";
      const current = currentBaseForName(base.name, base);
      base = upsertBase({
        ...current,
        state,
        lastError: null,
        metadata: {
          ...current.metadata,
          ipsw,
          guestSetupCompleted: false,
          provisionStage: stage,
          provisionProgress: fraction,
          provisionMessage: message,
          provisionUpdatedAt: nowIso(),
        },
      });
      emitOperation("base-create", "progress", null, base.name, message, { stage, progress: fraction });
    };

    const requestedIpsw = baseArgs.ipsw?.trim() || "latest";
    const resolvedIpsw = await resolveProvisionIpsw(
      requestedIpsw,
      "base-create",
      null,
      base.name,
      (metadata) => {
        const current = currentBaseForName(base.name, base);
        base = upsertBase({
          ...current,
          metadata: {
            ...current.metadata,
            ...metadata,
          },
        });
      },
    );
    const ipsw = resolvedIpsw.ipsw;
    const helperArgs = [
      "--bundle",
      bundlePath,
      "--ipsw",
      ipsw,
      "--restore-images-dir",
      restoreImagesDir,
      "--cpu",
      String(base.cpuCores),
      "--memory",
      base.memory,
      "--disk-size",
      base.diskSize,
      "--display",
      base.display,
    ];
    const stopDownloadMonitor = startIpswDownloadProgressMonitor(
      ipswCacheFilePath(restoreImagesDir, ipsw),
      resolvedIpsw.resolution?.sizeBytes ?? null,
      (fraction) => {
        updateFromProgress({
          type: "progress",
          stage: "download",
          fraction,
          message: resolvedIpsw.resolution
            ? `${ipswResolutionMessage(resolvedIpsw.resolution)} · downloading (${Math.round(fraction * 100)}%).`
            : `Downloading macOS restore image (${Math.round(fraction * 100)}%).`,
        });
      },
    );

    try {
      const result = args.runCommand
        ? await runHelper<{ restoreImage?: unknown }>("provision", helperArgs, 3 * 60 * 60_000)
        : await runHelperStreaming<{ restoreImage?: unknown }>("provision", helperArgs, 3 * 60 * 60_000, {
          onPayload: updateFromProgress,
          onSpawn: (pid) => {
            if (!pid) return;
            const current = currentBaseForName(base.name, base);
            base = upsertBase({
              ...current,
              metadata: {
                ...current.metadata,
                nativeProvisionPid: pid,
              },
            });
        },
      });
      stopDownloadMonitor();
      const current = currentBaseForName(base.name, base);
      const provisionedConfig = readJsonFile<{
        cpuCount?: number;
        memorySize?: number;
        diskSize?: number;
        display?: string;
      }>(path.join(bundlePath, "ade-vm.json"));
      base = upsertBase({
        ...current,
        state: "setup_required",
        cpuCores: asPositiveInteger(provisionedConfig?.cpuCount, current.cpuCores),
        memory: formatSizeFromBytes(provisionedConfig?.memorySize, current.memory),
        diskSize: formatSizeFromBytes(provisionedConfig?.diskSize, current.diskSize),
        display: normalizeDisplay(provisionedConfig?.display, current.display),
        lastError: null,
        metadata: {
          ...current.metadata,
          nativeProvisionPid: null,
          ipsw,
          ipswResolution: resolvedIpsw.resolution,
          restoreImage: result.restoreImage ?? null,
          guestSetupCompleted: false,
          provisionStage: "completed",
          provisionProgress: 1,
          provisionMessage: "Prepared base install is complete. Start it, finish macOS Setup Assistant, stop it, then mark it ready.",
          provisionedAt: nowIso(),
        },
      });
      emitOperation("base-create", "completed", null, base.name, "Prepared base installed. Complete macOS Setup Assistant once, then mark the base ready.");
      return base;
    } catch (error) {
      stopDownloadMonitor();
      const message = provisionErrorMessage(error);
      const current = currentBaseForName(base.name, base);
      base = upsertBase({
        ...current,
        state: "failed",
        lastError: message,
        metadata: {
          ...current.metadata,
          nativeProvisionPid: null,
          provisionMessage: message,
          provisionUpdatedAt: nowIso(),
        },
      });
      emitOperation("base-create", "failed", null, base.name, message);
      throw error;
    }
  };

  const createBase = async (baseArgs: MacosVmBaseCreateArgs = {}): Promise<MacosVmBaseRecord> => {
    await requireProviderReady();
    let base = baseRecordForName(baseArgs);
    requireHostCapacity(base);
    const bundlePath = String(base.metadata.bundlePath ?? "");
    if (bundlePath && fs.existsSync(path.join(bundlePath, "ade-vm.json")) && !baseArgs.force) {
      base = upsertBase({ ...reconcileBaseWithBundle(base), lastError: null });
      emitOperation("base-create", "completed", null, base.name, "Prepared macOS base already exists.");
      return base;
    }
    const activeTask = baseProvisionTasks.get(base.name);
    if (activeTask && !baseArgs.force) {
      emitOperation("base-create", "progress", null, base.name, "Prepared base provisioning is already running.", {
        stage: String(base.metadata.provisionStage ?? "provision"),
        progress: typeof base.metadata.provisionProgress === "number" ? base.metadata.provisionProgress : null,
      });
      return base;
    }
    if (baseArgs.force && bundlePath) {
      await terminateNativeHelperProcess(base);
      fs.rmSync(bundlePath, { recursive: true, force: true });
    }

    emitOperation("base-create", "started", null, base.name, "Provisioning prepared macOS base.");
    base = upsertBase({
      ...base,
      state: "creating",
      lastError: null,
      metadata: {
        ...base.metadata,
        nativeProvisionPid: null,
        guestSetupCompleted: false,
        provisionStage: "queued",
        provisionProgress: null,
        provisionMessage: "Provisioning prepared macOS base.",
        provisionUpdatedAt: nowIso(),
      },
    });
    const task = runBaseProvisionToCompletion(base, baseArgs).finally(() => {
      baseProvisionTasks.delete(base.name);
    });
    baseProvisionTasks.set(base.name, task);
    if (args.runCommand) return task;
    void task.catch((error) => {
      args.logger.warn("macos_vm.base_background_provision_failed", {
        baseName: base.name,
        err: error instanceof Error ? error.message : String(error),
      });
    });
    return base;
  };

  const startBase = async (baseArgs: MacosVmBaseStartArgs = {}): Promise<MacosVmBaseRecord> => {
    await requireProviderReady();
    let base = baseRecordForName(baseArgs);
    requireHostCapacity(base);
    const bundlePath = String(base.metadata.bundlePath ?? "");
    if (!fs.existsSync(path.join(bundlePath, "ade-vm.json"))) {
      throw new Error("Create the prepared macOS base before starting setup.");
    }
    emitOperation("base-start", "started", null, base.name, "Starting prepared macOS base.");
    base = upsertBase({ ...base, state: "starting", lastError: null });
    try {
      const title = `ADE macOS Base - ${baseDisplayName(base.name)}`;
      const runArgs = [
        "--bundle",
        bundlePath,
        "--title",
        title,
        "--cpu",
        String(base.cpuCores),
        "--memory",
        base.memory,
        "--display",
        base.display,
      ];
      if (baseArgs.openDisplay === false) runArgs.push("--headless");
      const launch = await launchHelperRun(runArgs);
      base = upsertBase({
        ...base,
        state: "running",
        lastStartedAt: nowIso(),
        lastError: null,
        metadata: {
          ...base.metadata,
          nativeHelperPid: launch.pid ?? base.metadata.nativeHelperPid ?? null,
          windowTitle: title,
        },
      });
      emitOperation("base-start", "completed", null, base.name, "Prepared base started. Finish Setup Assistant in the VM window, then stop and mark the base ready.");
      return base;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      base = upsertBase({ ...base, state: "failed", lastError: message });
      emitOperation("base-start", "failed", null, base.name, message);
      throw error;
    }
  };

  const stopBase = async (baseArgs: MacosVmBaseStopArgs = {}): Promise<MacosVmBaseRecord | null> => {
    const base = loadBases().find((entry) => normalizeBaseName(entry.name) === normalizeBaseName(baseArgs.name)) ?? null;
    if (!base) return null;
    emitOperation("base-stop", "started", null, base.name, "Stopping prepared macOS base.");
    const stopping = upsertBase({ ...base, state: "stopping", lastError: null });
    try {
      await terminateNativeHelperProcess(stopping);
      const nextState: MacosVmBaseRecord["state"] = stopping.metadata.guestSetupCompleted === true ? "ready" : "setup_required";
      const next = upsertBase({
        ...stopping,
        state: nextState,
        lastStoppedAt: nowIso(),
        lastError: null,
        metadata: {
          ...stopping.metadata,
          nativeProvisionPid: null,
          nativeHelperPid: null,
        },
      });
      emitOperation("base-stop", "completed", null, base.name, "Prepared base stopped.");
      return next;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      upsertBase({ ...stopping, state: "failed", lastError: message });
      emitOperation("base-stop", "failed", null, base.name, message);
      throw error;
    }
  };

  const markBaseReady = async (baseArgs: MacosVmBaseMarkReadyArgs = {}): Promise<MacosVmBaseRecord> => {
    let base = baseRecordForName(baseArgs);
    const bundlePath = String(base.metadata.bundlePath ?? "");
    if (!fs.existsSync(path.join(bundlePath, "ade-vm.json"))) {
      throw new Error("Create and complete setup for the prepared macOS base before marking it ready.");
    }
    if (base.state === "running" || base.state === "starting" || isPidAlive(base.metadata.nativeHelperPid)) {
      throw new Error("Stop the prepared base before marking it ready so lane clones copy a clean disk state.");
    }
    base = upsertBase({
      ...base,
      state: "ready",
      lastError: null,
      metadata: {
        ...base.metadata,
        guestSetupCompleted: true,
        setupCompletedAt: nowIso(),
        provisionMessage: "Prepared macOS base is ready for lane cloning.",
      },
    });
    emitOperation("base-mark-ready", "completed", null, base.name, "Prepared macOS base is ready. New lane VMs will clone it and boot to the configured desktop.");
    return base;
  };

  const preserveIpswFilesFromBundle = (bundlePath: string | null): void => {
    if (!bundlePath || !fs.existsSync(bundlePath)) return;
    fs.mkdirSync(restoreImagesDir, { recursive: true });
    for (const entry of fs.readdirSync(bundlePath)) {
      if (!entry.toLowerCase().endsWith(".ipsw")) continue;
      const source = path.join(bundlePath, entry);
      const destination = path.join(restoreImagesDir, entry);
      if (fs.existsSync(destination)) continue;
      try {
        fs.renameSync(source, destination);
      } catch {
        try {
          fs.copyFileSync(source, destination);
        } catch (error) {
          args.logger.warn("macos_vm.ipsw_cache_preserve_failed", {
            bundlePath,
            fileName: entry,
            err: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  };

  const deleteBase = async (baseArgs: MacosVmBaseDeleteArgs = {}): Promise<{ deleted: boolean; previous: MacosVmBaseRecord | null }> => {
    const base = loadBases().find((entry) => normalizeBaseName(entry.name) === normalizeBaseName(baseArgs.name)) ?? null;
    if (!base) return { deleted: false, previous: null };
    emitOperation("base-delete", "started", null, base.name, "Deleting prepared macOS base.");
    try {
      await terminateNativeHelperProcess(base);
      const bundlePath = typeof base.metadata.bundlePath === "string" ? base.metadata.bundlePath : null;
      preserveIpswFilesFromBundle(bundlePath);
      if (bundlePath) fs.rmSync(bundlePath, { recursive: true, force: true });
      removeBaseRecord(base.name);
      emitOperation("base-delete", "completed", null, base.name, "Prepared macOS base deleted.");
      return { deleted: true, previous: base };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      upsertBase({ ...base, lastError: message });
      emitOperation("base-delete", "failed", null, base.name, message);
      throw error;
    }
  };

  const clearIpswCache = async (): Promise<{ cleared: boolean; path: string; bytesFreed: number }> => {
    const bytesFreed = bytesInPath(restoreImagesDir);
    fs.rmSync(restoreImagesDir, { recursive: true, force: true });
    fs.mkdirSync(restoreImagesDir, { recursive: true });
    emitOperation("ipsw-cache-clear", "completed", null, null, "Cached macOS installer files cleared.");
    return { cleared: true, path: restoreImagesDir, bytesFreed };
  };

  const copyBundleFromBase = async (baseBundlePath: string, laneBundlePath: string): Promise<string> => {
    if (!fs.existsSync(path.join(baseBundlePath, "ade-vm.json"))) {
      throw new Error("Prepared base bundle is missing its ADE VM configuration.");
    }
    fs.rmSync(laneBundlePath, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(laneBundlePath), { recursive: true });
    const cloneArgs = ["-cR", baseBundlePath, laneBundlePath];
    try {
      await runHostCommand("cp", cloneArgs, 30 * 60_000);
      if (fs.existsSync(path.join(laneBundlePath, "ade-vm.json"))) return "clonefile";
    } catch (error) {
      args.logger.warn("macos_vm.base_clonefile_copy_failed", {
        err: error instanceof Error ? error.message : String(error),
      });
    }
    fs.rmSync(laneBundlePath, { recursive: true, force: true });
    try {
      await runHostCommand("cp", ["-R", baseBundlePath, laneBundlePath], 30 * 60_000);
      if (fs.existsSync(path.join(laneBundlePath, "ade-vm.json"))) return "copy";
    } catch (error) {
      args.logger.warn("macos_vm.base_copy_command_failed", {
        err: error instanceof Error ? error.message : String(error),
      });
    }
    fs.rmSync(laneBundlePath, { recursive: true, force: true });
    fs.cpSync(baseBundlePath, laneBundlePath, { recursive: true });
    return "node-copy";
  };

  const provisionFromBase = async (
    lane: LaneContext,
    initialRecord: MacosVmRecord,
    provisionArgs: MacosVmProvisionArgs,
  ): Promise<MacosVmRecord> => {
    let record = initialRecord;
    const base = getReadyBase(provisionArgs.baseName);
    if (!base) {
      const suffix = provisionArgs.baseName ? ` named "${normalizeBaseName(provisionArgs.baseName)}"` : "";
      throw new Error(`No prepared macOS base${suffix} is ready. Create the base, complete Setup Assistant once, stop it, then mark it ready.`);
    }
    if (base.state === "running" || base.state === "starting" || isPidAlive(base.metadata.nativeHelperPid)) {
      throw new Error("Stop the prepared base before cloning it into a lane VM.");
    }
    const baseBundlePath = typeof base.metadata.bundlePath === "string" ? base.metadata.bundlePath : "";
    const laneBundlePath = String(record.metadata.bundlePath ?? "");
    emitOperation("provision", "started", lane.id, record.name, `Cloning prepared macOS base "${base.name}" into this lane.`);
    record = upsertRecord({
      ...record,
      state: "creating",
      lastError: null,
      metadata: {
        ...record.metadata,
        source: "prepared-base",
        baseName: base.name,
        baseId: base.id,
        provisionStage: "clone",
        provisionProgress: null,
        provisionMessage: `Cloning prepared macOS base "${base.name}".`,
        provisionUpdatedAt: nowIso(),
      },
    });
    try {
      const copyMethod = await copyBundleFromBase(baseBundlePath, laneBundlePath);
      const clonedConfigPath = path.join(laneBundlePath, "ade-vm.json");
      const clonedConfig = readJsonFile<Record<string, unknown>>(clonedConfigPath) ?? {};
      writeJsonFile(clonedConfigPath, {
        ...clonedConfig,
        name: record.name,
        role: "lane",
        clonedFromBase: base.name,
        clonedFromBaseId: base.id,
        clonedAt: nowIso(),
        sharedPath: record.sharedDirectory,
      });
      record = upsertRecord({
        ...record,
        state: "stopped",
        cpuCores: base.cpuCores,
        memory: base.memory,
        diskSize: base.diskSize,
        display: base.display,
        lastError: null,
        metadata: {
          ...record.metadata,
          guestSetupCompleted: true,
          source: "prepared-base",
          baseName: base.name,
          baseId: base.id,
          cloneMethod: copyMethod,
          clonedAt: nowIso(),
          provisionStage: "completed",
          provisionProgress: 1,
          provisionMessage: "Lane macOS VM cloned from the prepared base.",
        },
      });
      emitOperation("provision", "completed", lane.id, record.name, "Lane macOS VM cloned from the prepared base.");
      return record;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      record = upsertRecord({ ...record, state: "failed", lastError: message });
      emitOperation("provision", "failed", lane.id, record.name, message);
      throw error;
    }
  };

  const runProvisionToCompletion = async (
    lane: LaneContext,
    initialRecord: MacosVmRecord,
    provisionArgs: MacosVmProvisionArgs,
  ): Promise<MacosVmRecord> => {
    let record = initialRecord;
    const bundlePath = String(record.metadata.bundlePath ?? "");
    let lastProgressEmitMs = 0;
    let lastProgressFraction: number | null = null;
    const updateFromProgress = (payload: HelperProgressPayload): void => {
      if (payload.type !== "progress") return;
      const stage = payload.stage ?? "provision";
      const fraction = typeof payload.fraction === "number" && Number.isFinite(payload.fraction)
        ? Math.max(0, Math.min(1, payload.fraction))
        : null;
      const now = Date.now();
      if (
        fraction != null
        && lastProgressFraction != null
        && Math.abs(fraction - lastProgressFraction) < 0.01
        && now - lastProgressEmitMs < 2_000
      ) {
        return;
      }
      lastProgressEmitMs = now;
      lastProgressFraction = fraction;
      const message = helperProgressMessage(payload) ?? "Provisioning lane macOS VM.";
      const state: MacosVmRecord["state"] = stage === "install" ? "installing" : "creating";
      const current = currentRecordForLane(lane.id, record);
      record = upsertRecord({
        ...current,
        state,
        lastError: null,
        metadata: {
          ...current.metadata,
          ipsw,
          provisionStage: stage,
          provisionProgress: fraction,
          provisionMessage: message,
          provisionUpdatedAt: nowIso(),
        },
      });
      emitOperation("provision", "progress", lane.id, record.name, message, { stage, progress: fraction });
    };

    const requestedIpsw = provisionArgs.ipsw?.trim() || "latest";
    const resolvedIpsw = await resolveProvisionIpsw(
      requestedIpsw,
      "provision",
      lane.id,
      record.name,
      (metadata) => {
        const current = currentRecordForLane(lane.id, record);
        record = upsertRecord({
          ...current,
          metadata: {
            ...current.metadata,
            ...metadata,
          },
        });
      },
    );
    const ipsw = resolvedIpsw.ipsw;
    const helperArgs = [
      "--bundle",
      bundlePath,
      "--ipsw",
      ipsw,
      "--restore-images-dir",
      restoreImagesDir,
      "--cpu",
      String(record.cpuCores),
      "--memory",
      record.memory,
      "--disk-size",
      record.diskSize,
      "--display",
      record.display,
      "--shared-dir",
      record.sharedDirectory,
    ];
    const stopDownloadMonitor = startIpswDownloadProgressMonitor(
      ipswCacheFilePath(restoreImagesDir, ipsw),
      resolvedIpsw.resolution?.sizeBytes ?? null,
      (fraction) => {
        updateFromProgress({
          type: "progress",
          stage: "download",
          fraction,
          message: resolvedIpsw.resolution
            ? `${ipswResolutionMessage(resolvedIpsw.resolution)} · downloading (${Math.round(fraction * 100)}%).`
            : `Downloading macOS restore image (${Math.round(fraction * 100)}%).`,
        });
      },
    );

    try {
      const result = args.runCommand
        ? await runHelper<{ restoreImage?: unknown }>("provision", helperArgs, 3 * 60 * 60_000)
        : await runHelperStreaming<{ restoreImage?: unknown }>("provision", helperArgs, 3 * 60 * 60_000, {
          onPayload: updateFromProgress,
          onSpawn: (pid) => {
            if (!pid) return;
            const current = currentRecordForLane(lane.id, record);
            record = upsertRecord({
              ...current,
              metadata: {
                ...current.metadata,
                nativeProvisionPid: pid,
              },
            });
        },
      });
      stopDownloadMonitor();
      const current = currentRecordForLane(lane.id, record);
      const provisionedConfig = readJsonFile<{
        cpuCount?: number;
        memorySize?: number;
        diskSize?: number;
        display?: string;
      }>(path.join(bundlePath, "ade-vm.json"));
      record = upsertRecord({
        ...current,
        state: "stopped",
        cpuCores: asPositiveInteger(provisionedConfig?.cpuCount, current.cpuCores),
        memory: formatSizeFromBytes(provisionedConfig?.memorySize, current.memory),
        diskSize: formatSizeFromBytes(provisionedConfig?.diskSize, current.diskSize),
        display: normalizeDisplay(provisionedConfig?.display, current.display),
        lastError: null,
        metadata: {
          ...current.metadata,
          nativeProvisionPid: null,
          ipsw,
          ipswResolution: resolvedIpsw.resolution,
          restoreImage: result.restoreImage ?? null,
          provisionStage: "completed",
          provisionProgress: 1,
          provisionMessage: "macOS VM is ready for this lane.",
          provisionedAt: nowIso(),
        },
      });
      emitOperation("provision", "completed", lane.id, record.name, "macOS VM is ready for this lane.");
      return record;
    } catch (error) {
      stopDownloadMonitor();
      const message = provisionErrorMessage(error);
      const current = currentRecordForLane(lane.id, record);
      record = upsertRecord({
        ...current,
        state: "failed",
        lastError: message,
        metadata: {
          ...current.metadata,
          nativeProvisionPid: null,
          provisionMessage: message,
          provisionUpdatedAt: nowIso(),
        },
      });
      emitOperation("provision", "failed", lane.id, record.name, message);
      throw error;
    }
  };

  const provision = async (provisionArgs: MacosVmProvisionArgs): Promise<MacosVmRecord> => {
    const lane = await getLane(provisionArgs.laneId);
    await ensureShareReady(lane);
    await requireProviderReady();
    if (provisionArgs.mode && provisionArgs.mode !== "create") {
      throw new Error("macOS VM provision mode must be create.");
    }

    let record = recordForLane(lane, provisionArgs);
    requireHostCapacity(record);
    const bundlePath = String(record.metadata.bundlePath ?? "");
    const shouldUseBase = provisionArgs.fromBase === true || Boolean(provisionArgs.baseName?.trim());
    if (bundlePath && fs.existsSync(path.join(bundlePath, "ade-vm.json")) && !provisionArgs.force) {
      record = upsertRecord({ ...reconcileRecordWithBundle(record), state: "stopped", lastError: null });
      emitOperation("provision", "completed", lane.id, record.name, "macOS VM already exists for this lane.");
      return record;
    }
    if (shouldUseBase) {
      return provisionFromBase(lane, record, provisionArgs);
    }
    const activeTask = provisionTasks.get(lane.id);
    if (activeTask && !provisionArgs.force) {
      emitOperation("provision", "progress", lane.id, record.name, "Provisioning is already running for this lane.", {
        stage: String(record.metadata.provisionStage ?? "provision"),
        progress: typeof record.metadata.provisionProgress === "number" ? record.metadata.provisionProgress : null,
      });
      return record;
    }
    if ((record.state === "creating" || record.state === "installing") && !provisionArgs.force && isPidAlive(record.metadata.nativeProvisionPid)) {
      emitOperation("provision", "progress", lane.id, record.name, String(record.metadata.provisionMessage ?? "Provisioning is already running for this lane."), {
        stage: typeof record.metadata.provisionStage === "string" ? record.metadata.provisionStage : "provision",
        progress: typeof record.metadata.provisionProgress === "number" ? record.metadata.provisionProgress : null,
      });
      return record;
    }
    if ((record.state === "creating" || record.state === "installing") && !provisionArgs.force) {
      record = upsertRecord({
        ...record,
        state: "failed",
        lastError: "Previous VM provisioning was interrupted before the VM bundle finished.",
        metadata: {
          ...record.metadata,
          nativeProvisionPid: null,
          provisionMessage: "Previous VM provisioning was interrupted; starting a new provision attempt.",
          provisionUpdatedAt: nowIso(),
        },
      });
    }

    emitOperation("provision", "started", lane.id, record.name, "Provisioning lane macOS VM.");
    record = upsertRecord({
      ...record,
      state: "creating",
      lastError: null,
      metadata: {
        ...record.metadata,
        nativeProvisionPid: null,
        provisionStage: "queued",
        provisionProgress: null,
        provisionMessage: "Provisioning lane macOS VM.",
        provisionUpdatedAt: nowIso(),
      },
    });
    const task = runProvisionToCompletion(lane, record, provisionArgs).finally(() => {
      provisionTasks.delete(lane.id);
    });
    provisionTasks.set(lane.id, task);
    if (args.runCommand) return task;
    void task.catch((error) => {
      args.logger.warn("macos_vm.background_provision_failed", {
        laneId: lane.id,
        vmName: record.name,
        err: error instanceof Error ? error.message : String(error),
      });
    });
    return record;
  };

  let start: (startArgs: MacosVmStartArgs) => Promise<MacosVmRecord>;

  const scheduleStartAfterProvision = (lane: LaneContext, startArgs: MacosVmStartArgs): void => {
    if (startAfterProvisionTasks.has(lane.id)) return;
    const task = (async () => {
      const deadlineMs = Date.now() + 3 * 60 * 60_000;
      emitOperation("start", "progress", lane.id, null, "Waiting for VM provisioning to finish before starting.");
      while (!disposed && Date.now() < deadlineMs) {
        const current = loadRecords().find((entry) => entry.laneId === lane.id) ?? null;
        if (!current) return;
        const currentBundlePath = typeof current.metadata.bundlePath === "string" ? current.metadata.bundlePath : "";
        if (currentBundlePath && fs.existsSync(path.join(currentBundlePath, "ade-vm.json"))) {
          await start({ ...startArgs, laneId: lane.id, createIfMissing: false });
          return;
        }
        if (current.state !== "creating" && current.state !== "installing") return;
        await delay(5_000);
      }
      if (!disposed) {
        const current = loadRecords().find((entry) => entry.laneId === lane.id) ?? null;
        if (current && (current.state === "creating" || current.state === "installing")) {
          const message = "Timed out waiting for VM provisioning to finish.";
          upsertRecord({ ...current, state: "failed", lastError: message });
          emitOperation("start", "failed", lane.id, current.name, message);
        }
      }
    })().catch((error) => {
      args.logger.warn("macos_vm.start_after_provision_failed", {
        laneId: lane.id,
        err: error instanceof Error ? error.message : String(error),
      });
    }).finally(() => {
      startAfterProvisionTasks.delete(lane.id);
    });
    startAfterProvisionTasks.set(lane.id, task);
  };

  start = async (startArgs: MacosVmStartArgs): Promise<MacosVmRecord> => {
    const lane = await getLane(startArgs.laneId);
    await requireProviderReady();
    let record = recordForLane(lane, startArgs);
    requireHostCapacity(record);
    const bundlePath = String(record.metadata.bundlePath ?? "");
    if (startArgs.mode && startArgs.mode !== "create") {
      throw new Error("macOS VM start mode must be create.");
    }
    if (!fs.existsSync(path.join(bundlePath, "ade-vm.json")) && startArgs.createIfMissing !== false) {
      const readyBase = startArgs.fromBase === false || startArgs.ipsw?.trim()
        ? null
        : getReadyBase(startArgs.baseName);
      const fromBase = startArgs.fromBase === true || Boolean(startArgs.baseName?.trim()) || Boolean(readyBase);
      record = await provision({ ...startArgs, laneId: lane.id, fromBase, baseName: startArgs.baseName ?? readyBase?.name });
      if (!args.runCommand) {
        scheduleStartAfterProvision(lane, startArgs);
        return record;
      }
    } else if (!fs.existsSync(path.join(bundlePath, "ade-vm.json"))) {
      throw new Error("Provision a macOS VM for this lane before starting it.");
    }
    await ensureShareReady(lane);

    emitOperation("start", "started", lane.id, record.name, "Starting lane macOS VM.");
    record = upsertRecord({ ...record, state: "starting", lastError: null });
    try {
      const runArgs = [
        "--bundle",
        bundlePath,
        "--title",
        record.name,
        "--cpu",
        String(record.cpuCores),
        "--memory",
        record.memory,
        "--display",
        record.display,
        "--shared-dir",
        record.sharedDirectory,
      ];
      if (startArgs.openDisplay === false) runArgs.push("--headless");
      const launch = await launchHelperRun(runArgs);
      if (launch.pid) {
        record = upsertRecord({
          ...record,
          metadata: {
            ...record.metadata,
            nativeHelperPid: launch.pid,
          },
        });
      }
      record = upsertRecord({
        ...record,
        state: "running",
        lastStartedAt: nowIso(),
        lastError: null,
      });
      const shareMode = typeof record.metadata.shareMode === "string" ? record.metadata.shareMode : null;
      const mirrorPath = typeof record.metadata.mirrorPath === "string" ? record.metadata.mirrorPath : null;
      if (shareMode === "sanitized-mirror" && mirrorPath) {
        startMirrorSync(lane, mirrorPath);
      }
      if (startArgs.openDisplay === true) {
        await focusWindow({ laneId: lane.id }).catch((error) => {
          args.logger.warn("macos_vm.open_display_failed", {
            vmName: record.name,
            err: error instanceof Error ? error.message : String(error),
          });
        });
      }
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
    emitOperation("stop", "started", lane.id, record.name, "Stopping lane macOS VM.");
    const stopping = upsertRecord({ ...record, state: "stopping", lastError: null });
    try {
      await terminateNativeHelperProcess(stopping);
      await stopMirrorSync(lane, stopping.metadata.mirrorPath as string | null | undefined, true);
      const next = upsertRecord({
        ...stopping,
        state: "stopped",
        lastStoppedAt: nowIso(),
        lastError: null,
        metadata: {
          ...stopping.metadata,
          nativeProvisionPid: null,
          nativeHelperPid: null,
        },
      });
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
    emitOperation("delete", "started", lane.id, record.name, "Deleting lane macOS VM.");
    try {
      await terminateNativeHelperProcess(record);
      const bundlePath = typeof record.metadata.bundlePath === "string" ? record.metadata.bundlePath : null;
      if (bundlePath) fs.rmSync(bundlePath, { recursive: true, force: true });
      await stopMirrorSync(lane, record.metadata.mirrorPath as string | null | undefined, false);
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
    return { lane, record };
  };

  const focusVisibleVmWindow = async (
    lane: LaneContext,
    record: MacosVmRecord,
    focusArgs: MacosVmFocusWindowArgs,
  ): Promise<MacosVmWindowTarget> => {
    requireMacWindowControl();
    const query = focusArgs.windowTitleQuery?.trim() || record.name;
    const payload = await runHelper<HelperWindowPayload>("window-info", ["--title", query, "--activate"], 15_000);
    const target = windowPayloadTarget(payload, lane.id, record.name, query);
    if (target.processName === "unknown" || !target.frame) {
      throw new Error(`No visible macOS VM window matched ${query}`);
    }
    return target;
  };

  const focusWindow = async (focusArgs: MacosVmFocusWindowArgs): Promise<MacosVmWindowTarget> => {
    const { lane, record } = await controlRecordForLane(focusArgs.laneId);
    const target = await focusVisibleVmWindow(lane, record, focusArgs);
    emitOperation("focus-window", "completed", lane.id, record.name, `Focused macOS VM window "${target.windowTitle}".`);
    return target;
  };

  /**
   * Focus the helper NSWindow that owns a prepared snapshot ("base") VM.
   *
   * The returned `MacosVmWindowTarget` carries `laneId: "base:<name>"` as a
   * sentinel — bases are not bound to a lane, but `MacosVmWindowTarget`
   * requires `laneId` for its lane-scoped consumers. Do NOT pass that string
   * back into lane-scoped APIs (focusWindow, click, typeText, etc.); those
   * resolve a real lane via `getLane(laneId)` and will throw.
   */
  const focusBaseWindow = async (focusArgs: MacosVmFocusBaseWindowArgs = {}): Promise<MacosVmWindowTarget> => {
    requireMacWindowControl();
    const name = normalizeBaseName(focusArgs.name);
    const base = loadBases().find((entry) => normalizeBaseName(entry.name) === name) ?? null;
    if (!base) {
      throw new Error(`No prepared macOS base named "${name}" was found.`);
    }
    const bundlePath = typeof base.metadata.bundlePath === "string" ? base.metadata.bundlePath : "";
    const runtimeStatus = bundlePath
      ? readJsonFile<RuntimeStatusPayload>(path.join(bundlePath, "runtime-status.json"))
      : null;
    const helperPid = typeof runtimeStatus?.pid === "number" && runtimeStatus.pid > 0
      ? runtimeStatus.pid
      : typeof base.metadata.nativeHelperPid === "number" && base.metadata.nativeHelperPid > 0
        ? base.metadata.nativeHelperPid
        : null;
    if (!isPidAlive(helperPid)) {
      throw new Error(`Prepared base "${baseDisplayName(base.name)}" is not running. Start it before focusing its window.`);
    }
    const expectedTitle = `ADE macOS Base - ${baseDisplayName(base.name)}`;
    const query = focusArgs.windowTitleQuery?.trim() || expectedTitle;
    const payload = await runHelper<HelperWindowPayload>(
      "window-info",
      ["--title", query, "--owner", "macos-vm-helper", "--activate"],
      15_000,
    );
    const target = windowPayloadTarget(payload, `base:${base.name}`, base.name, query);
    if (target.processName === "unknown" || !target.frame) {
      throw new Error(`No visible macOS VM window matched ${query}`);
    }
    emitOperation("focus-base-window", "completed", null, base.name, `Focused prepared base macOS VM window "${target.windowTitle}".`);
    return target;
  };

  const saveLaneVmAsSnapshot = async (snapshotArgs: MacosVmSaveLaneAsSnapshotArgs): Promise<MacosVmBaseRecord> => {
    const lane = await getLane(snapshotArgs.laneId);
    const record = loadRecords().find((entry) => entry.laneId === lane.id) ?? null;
    if (!record) {
      throw new Error(`Lane ${lane.id} does not have a macOS VM yet.`);
    }
    if (record.state !== "stopped") {
      throw new Error("Stop the lane macOS VM before saving it as a snapshot so the cloned disk state is consistent.");
    }
    const targetName = normalizeBaseName(snapshotArgs.name);
    const existingBase = loadBases().find((entry) => normalizeBaseName(entry.name) === targetName);
    if (existingBase) {
      throw new Error(`A macOS snapshot named "${baseDisplayName(targetName)}" already exists.`);
    }
    const laneBundlePath = typeof record.metadata.bundlePath === "string" ? record.metadata.bundlePath : "";
    if (!laneBundlePath || !fs.existsSync(path.join(laneBundlePath, "ade-vm.json"))) {
      throw new Error("Lane macOS VM bundle is missing its ADE VM configuration.");
    }
    const targetBundlePath = nativeBaseBundlePath(baseBundleRoot, targetName);
    const description = snapshotArgs.description?.trim() || null;
    const now = nowIso();
    emitOperation("base-save-from-lane", "started", lane.id, record.name, `Saving lane macOS VM as snapshot "${baseDisplayName(targetName)}".`);
    try {
      const copyMethod = await copyBundleFromBase(laneBundlePath, targetBundlePath);
      const clonedConfigPath = path.join(targetBundlePath, "ade-vm.json");
      const clonedConfig = readJsonFile<Record<string, unknown>>(clonedConfigPath) ?? {};
      writeJsonFile(clonedConfigPath, {
        ...clonedConfig,
        name: targetName,
        role: "prepared-base",
        savedFromLaneId: lane.id,
        savedFromLaneName: lane.name,
        savedFromVmName: record.name,
        savedAt: now,
      });
      try {
        fs.rmSync(path.join(targetBundlePath, "runtime-status.json"), { force: true });
      } catch {
        // ignore
      }
      const base: MacosVmBaseRecord = {
        id: `macos-vm-base:${targetName}`,
        provider: "apple-virtualization-helper",
        name: targetName,
        state: "ready",
        cpuCores: record.cpuCores,
        memory: record.memory,
        diskSize: record.diskSize,
        display: record.display,
        guestSharedPath: APPLE_GUEST_SHARED_PATH,
        createdAt: now,
        updatedAt: now,
        lastStartedAt: null,
        lastStoppedAt: null,
        lastError: null,
        metadata: {
          bundlePath: targetBundlePath,
          nativeHelper: true,
          guestSetupCompleted: true,
          baseRole: "saved-from-lane",
          savedFromLaneId: lane.id,
          savedFromLaneName: lane.name,
          savedFromVmName: record.name,
          savedAt: now,
          description,
          cloneMethod: copyMethod,
          appleDocs: APPLE_VIRTUALIZATION_DOCS,
          appleRunningMacosVmDocs: APPLE_RUNNING_MACOS_VM_DOCS,
          sharedDirectoryDocs: APPLE_SHARED_DIRECTORIES_DOCS,
          provisionStage: "completed",
          provisionProgress: 1,
          provisionMessage: "Saved from a lane macOS VM and ready for cloning.",
        },
      };
      const stored = upsertBase(base);
      emitOperation("base-save-from-lane", "completed", lane.id, record.name, `Saved lane macOS VM as snapshot "${baseDisplayName(targetName)}".`);
      return stored;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        fs.rmSync(targetBundlePath, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
      emitOperation("base-save-from-lane", "failed", lane.id, record.name, message);
      throw error;
    }
  };

  const renameBase = async (renameArgs: MacosVmRenameBaseArgs): Promise<MacosVmBaseRecord> => {
    const fromName = normalizeBaseName(renameArgs.from);
    const toName = normalizeBaseName(renameArgs.to);
    if (fromName === toName) {
      const existing = loadBases().find((entry) => normalizeBaseName(entry.name) === fromName);
      if (!existing) throw new Error(`No prepared macOS base named "${baseDisplayName(fromName)}" was found.`);
      return existing;
    }
    const bases = loadBases();
    const base = bases.find((entry) => normalizeBaseName(entry.name) === fromName);
    if (!base) {
      throw new Error(`No prepared macOS base named "${baseDisplayName(fromName)}" was found.`);
    }
    if (bases.some((entry) => normalizeBaseName(entry.name) === toName)) {
      throw new Error(`A macOS snapshot named "${baseDisplayName(toName)}" already exists.`);
    }
    if (base.state === "running" || base.state === "starting" || isPidAlive(base.metadata.nativeHelperPid)) {
      throw new Error("Stop the prepared base before renaming its snapshot.");
    }
    const previousBundlePath = typeof base.metadata.bundlePath === "string" ? base.metadata.bundlePath : "";
    const nextBundlePath = nativeBaseBundlePath(baseBundleRoot, toName);
    if (previousBundlePath && fs.existsSync(previousBundlePath) && previousBundlePath !== nextBundlePath) {
      if (fs.existsSync(nextBundlePath)) {
        throw new Error(`A bundle already exists at ${nextBundlePath}.`);
      }
      fs.mkdirSync(path.dirname(nextBundlePath), { recursive: true });
      fs.renameSync(previousBundlePath, nextBundlePath);
    }
    removeBaseRecord(base.name);
    const updated = upsertBase({
      ...base,
      id: `macos-vm-base:${toName}`,
      name: toName,
      metadata: {
        ...base.metadata,
        bundlePath: nextBundlePath,
        renamedFrom: base.name,
        renamedAt: nowIso(),
      },
    });
    emitOperation("base-rename", "completed", null, updated.name, `Renamed snapshot "${baseDisplayName(fromName)}" to "${baseDisplayName(toName)}".`);
    return updated;
  };

  const wakeSleepingVmDisplay = async (target: MacosVmWindowTarget): Promise<void> => {
    requireMacWindowControl();
    const title = target.windowTitle || target.windowTitleQuery || target.vmName;
    const processSelector = typeof target.processId === "number" && target.processId > 0
      ? `first process whose unix id is ${Math.floor(target.processId)}`
      : `process ${appleScriptString(target.processName || "macos-vm-helper")}`;
    const script = [
      'tell application "System Events"',
      `  set targetProcess to ${processSelector}`,
      "  tell targetProcess",
      "    set frontmost to true",
      "    try",
      `      perform action "AXRaise" of window ${appleScriptString(title)}`,
      "    end try",
      "  end tell",
      "  delay 0.05",
      "  key code 49",
      "end tell",
    ].join("\n");
    await runHostCommand("osascript", ["-e", script], 3_000);
  };

  const captureScreenshot = async (
    captureArgs: MacosVmCaptureScreenshotArgs,
  ): Promise<MacosVmCaptureScreenshotResult> => {
    requireMacWindowControl();
    let target = await focusWindow(captureArgs);
    const screenshotDir = path.join(layout.artifactsDir, "macos-vms", target.laneId);
    fs.mkdirSync(screenshotDir, { recursive: true });
    const outputPath = captureArgs.outputPath?.trim()
      ? path.resolve(captureArgs.outputPath)
      : path.join(screenshotDir, `${sanitizeArtifactName(target.vmName)}-${Date.now()}.png`);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    const captureOnce = async (): Promise<MacosVmCaptureScreenshotResult["captureMode"]> => {
      let captureMode: MacosVmCaptureScreenshotResult["captureMode"] = "full-screen";
      if (typeof target.windowId === "number" && target.windowId > 0) {
        try {
          const payload = await runHelper<HelperWindowPayload>(
            "capture-window",
            ["--title", target.windowTitleQuery, "--output", outputPath],
            15_000,
          );
          target = windowPayloadTarget(payload, target.laneId, target.vmName, target.windowTitleQuery);
          captureMode = "window-id";
        } catch (error) {
          args.logger.warn("macos_vm.window_id_screenshot_failed", {
            vmName: target.vmName,
            windowId: target.windowId,
            err: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (captureMode === "full-screen") {
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
      }
      return captureMode;
    };

    let captureMode = await captureOnce();
    if (isProbablySleepingVmScreenshot(outputPath)) {
      emitOperation("screenshot", "progress", target.laneId, target.vmName, "Waking idle macOS VM display.");
      try {
        await wakeSleepingVmDisplay(target);
        await delay(1_000);
        target = await focusWindow(captureArgs);
        captureMode = await captureOnce();
      } catch (error) {
        args.logger.warn("macos_vm.wake_sleeping_display_failed", {
          vmName: target.vmName,
          err: error instanceof Error ? error.message : String(error),
        });
      }
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
      runCommand: `ade --socket macos-vm start --lane ${shellQuote(args.lane.id)} --create --text`,
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
        providerDocs: APPLE_VIRTUALIZATION_DOCS,
        appleVirtualizationDocs: APPLE_VIRTUALIZATION_DOCS,
        appleRunningMacosVmDocs: APPLE_RUNNING_MACOS_VM_DOCS,
        sharedDirectoryDocs: APPLE_SHARED_DIRECTORIES_DOCS,
        controlModel: "Use ADE macos-vm screenshot/click/type/select actions. ADE targets the native Apple Virtualization VM window.",
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
    return { item, source: "coordinate-fallback", screenshot };
  };

  const getAgentGuide = async (guideArgs: MacosVmAgentGuideArgs): Promise<MacosVmAgentGuide> => {
    const lane = await getLane(guideArgs.laneId);
    const merged = loadRecords().find((entry) => entry.laneId === lane.id) ?? recordForLane(lane);
    const runCommandText = `ade --socket macos-vm start --lane ${shellQuote(lane.id)} --create --text`;
    const sshLine = merged.sshCommand
      ? `- If SSH is enabled in the guest, connect with \`${merged.sshCommand}\` and work from \`${merged.guestSharedPath}\`.`
      : "- SSH is not configured by ADE automatically; use the native VM window for first-boot setup and enable remote login in the guest if needed.";
    const setupLine = merged.metadata.guestSetupCompleted
      ? "- This VM has been marked as guest-setup complete and should boot to its configured desktop."
      : "- Raw Apple restore images boot into macOS Setup Assistant on first launch. Complete setup once for this VM; the native desktop-ready ADE flow should use a prepared local base cloned into lanes.";
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
        providerDocs: APPLE_VIRTUALIZATION_DOCS,
        appleVirtualizationDocs: APPLE_VIRTUALIZATION_DOCS,
        appleRunningMacosVmDocs: APPLE_RUNNING_MACOS_VM_DOCS,
        sharedDirectoryDocs: APPLE_SHARED_DIRECTORIES_DOCS,
        controlModel: "Use ADE macos-vm screenshot/click/type actions. ADE targets the native Apple Virtualization VM window.",
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
      setupLine,
      sshLine,
      "- For GUI computer use, prefer ADE's macos-vm screenshot/click/type tools. They target the native Apple Virtualization VM window.",
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
    createBase,
    startBase,
    stopBase,
    markBaseReady,
    deleteBase,
    renameBase,
    saveLaneVmAsSnapshot,
    clearIpswCache,
    provision,
    start,
    stop,
    delete: deleteVm,
    getAgentGuide,
    focusWindow,
    focusBaseWindow,
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
