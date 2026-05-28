import { randomUUID } from "node:crypto";
import { execFile as execFileCallback, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type {
  IosElementContextItem,
  IosInspectableElement,
  IosInspectableFrame,
  IosInspectableScreen,
  IosInspectorSnapshot,
  IosScreenElement,
  IosScreenSnapshot,
  IosScreenSnapshotArgs,
  IosSimulatorClaimArgs,
  IosSimulatorOpenPreviewWorkspaceArgs,
  IosSimulatorListPreviewsArgs,
  IosSimulatorPreviewCapability,
  IosSimulatorPreviewTarget,
  IosSimulatorPreviewWindow,
  IosSimulatorRenderPreviewArgs,
  IosSimulatorRenderPreviewResult,
  IosSimulatorEventPayload,
  IosSimulatorDragArgs,
  IosSimulatorInspectPointArgs,
  IosSimulatorInspectResult,
  IosSimulatorLaunchProgress,
  IosSimulatorLaunchStepId,
  IosSimulatorLaunchStepStatus,
  IosSimulatorDevice,
  IosSimulatorLaunchArgs,
  IosSimulatorLaunchTarget,
  IosSimulatorListLaunchTargetsArgs,
  IosSimulatorShutdownArgs,
  IosSimulatorShutdownResult,
  IosSimulatorStreamBackend,
  IosSimulatorStartStreamArgs,
  IosSimulatorStreamStatus,
  IosSimulatorToolStatus,
  IosSimulatorScreenshot,
  IosSimulatorSelectResult,
  IosSimulatorSession,
  IosSimulatorStatus,
} from "../../../shared/types";
import { IOS_SIMULATOR_OWNED_BY_OTHER_SESSION_CODE } from "../../../shared/types/iosSimulator";
import { commandExists } from "../ai/utils";
import type { Logger } from "../logging/logger";

const execFile = promisify(execFileCallback);

const ADE_IOS_BUNDLE_ID = "com.ade.ios";
const ADE_IOS_PROJECT = path.join("apps", "ios", "ADE.xcodeproj");
const ADE_IOS_SCHEME = "ADE";
const ADE_IOS_INSPECTOR_SNAPSHOT_PATH = path.join("Documents", "ade-inspector-elements.json");
const IOS_APPLICATION_PRODUCT_TYPE = "com.apple.product-type.application";
const XCODE_MCP_DOCS_URL = "https://developer.apple.com/documentation/xcode/giving-external-agents-access-to-xcode";
const COMPANION_IDLE_STOP_MS = 30_000;
const TOOL_STATUS_CACHE_MS = 10_000;
const STATUS_THROTTLE_MS = 500;
const DEVICE_LIST_THROTTLE_MS = 500;
const SIMCTL_BOOTSTATUS_TIMEOUT_MS = 90_000;
const SIMCTL_INSTALL_TIMEOUT_MS = 180_000;
const INSTALL_HINT_XCODE = "Install Xcode from the App Store, then run xcode-select --install.";
const INSTALL_HINT_XCODE_CLI = "Run xcode-select --install to install the Xcode command line tools.";
const INSTALL_HINT_IDB = "Install Facebook idb: brew tap facebook/fb && brew install idb-companion && pipx install fb-idb.";
const INSTALL_HINT_IDB_COMPANION = "Install idb_companion: brew tap facebook/fb && brew install idb-companion.";
const XCODE_MCP_SESSION_ID = "906026e2-d248-4770-8654-032d0e1fbb54";
const XCODE_MCP_APPROVAL_TIMEOUT_MS = 90_000;

type RunCommand = (command: string, args: string[], options?: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv }) => Promise<{ stdout: string; stderr: string }>;
type SpawnProcess = typeof spawn;
type CommandExistsProbe = typeof commandExists;

export class IosSimulatorOwnedBySessionError extends Error {
  readonly code: typeof IOS_SIMULATOR_OWNED_BY_OTHER_SESSION_CODE = IOS_SIMULATOR_OWNED_BY_OTHER_SESSION_CODE;
  readonly currentChatSessionId: string | null;
  readonly currentSession: IosSimulatorSession | null;

  constructor(currentSession: IosSimulatorSession | null) {
    const owner = currentSession?.chatSessionId ?? null;
    super(`${IOS_SIMULATOR_OWNED_BY_OTHER_SESSION_CODE}: simulator is owned by chat session ${owner ?? "unknown"}.`);
    this.name = "IosSimulatorOwnedBySessionError";
    this.currentChatSessionId = owner;
    this.currentSession = currentSession;
  }
}

type CreateIosSimulatorServiceArgs = {
  projectRoot: string;
  logger: Logger;
  onEvent?: ((payload: IosSimulatorEventPayload) => void) | null;
};

type SimctlListDevicesJson = {
  devices?: Record<string, Array<{
    name?: string;
    udid?: string;
    state?: string;
    isAvailable?: boolean;
    availabilityError?: string;
  }>>;
};

type ResolvedLaunchTarget = {
  target: IosSimulatorLaunchTarget;
  projectPath: string | null;
  scheme: string | null;
  bundleId: string | null;
  appBundlePath: string | null;
  shouldBuild: boolean;
  shouldInstall: boolean;
};

type PbxApplicationTarget = {
  id: string;
  targetName: string;
  productName: string;
};

type XcodeSchemeDefinition = {
  name: string;
  blueprintIdentifiers: string[];
  blueprintNames: string[];
  buildableNames: string[];
};

type IosSourceMatch = {
  sourceFile: string;
  sourceLine: number;
  confidence: "exact" | "candidate";
  reason: string;
  snippet: string | null;
};

type InferredSwiftUITabItem = {
  label: string;
  sourceFile: string;
  sourceLine: number;
  snippet: string | null;
};

type RawIosInspectorSnapshot = {
  schemaVersion?: number;
  generatedAt?: string;
  screen?: {
    width?: number;
    height?: number;
    scale?: number;
  };
  elements?: Array<{
    id?: string;
    componentId?: string;
    sourceFile?: string;
    sourceLine?: number;
    frame?: Partial<IosInspectableElement["frame"]>;
    pixelFrame?: Partial<IosInspectableElement["pixelFrame"]>;
    metadata?: Record<string, unknown>;
    accessibilityIdentifier?: string | null;
  }>;
};

type JsonRpcMessage = {
  jsonrpc?: "2.0";
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string; code?: number; data?: unknown };
};

type McpToolCallResult = {
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
};

type XcodeMcpPendingRequest = {
  description: string;
  reject: (error: Error) => void;
  resolve: (value: unknown) => void;
  timer: NodeJS.Timeout;
};

type XcodeMcpBridge = {
  child: ChildProcess;
  initialized: boolean;
  initializing: Promise<void> | null;
  nextId: number;
  pending: Map<number | string, XcodeMcpPendingRequest>;
  stderr: string;
  stdoutBuffer: Buffer<ArrayBufferLike>;
};

type SwiftPreviewDefinition = {
  title: string;
  line: number;
  index: number;
  kind: IosSimulatorPreviewTarget["kind"];
  position: number;
};

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeRuntimeName(runtime: string): string {
  const tail = runtime.split(".").pop() ?? runtime;
  return tail.replace(/^iOS-/, "iOS ").replace(/-/g, ".");
}

function runtimeVersionScore(runtime: string): number {
  const match = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(runtime);
  if (!match) return 0;
  return (Number(match[1]) * 1_000_000)
    + (Number(match[2] ?? 0) * 1_000)
    + Number(match[3] ?? 0);
}

function isTerminatedByTimeout(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { killed?: unknown; signal?: unknown };
  return record.killed === true && record.signal === "SIGTERM";
}

function outputToString(value: unknown): string {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString();
  return "";
}

function commandFailureOutput(error: unknown): string {
  if (!error || typeof error !== "object") return error instanceof Error ? error.message : String(error);
  const record = error as { message?: unknown; stdout?: unknown; stderr?: unknown };
  return [
    outputToString(record.stderr),
    outputToString(record.stdout),
    typeof record.message === "string" ? record.message : null,
  ].filter((part): part is string => Boolean(part?.trim())).join("\n");
}

function buildFailureSummary(output: string): string {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const important = lines.filter((line) => (
    /\berror:|fatal error:|BUILD FAILED|The following build commands failed|Provisioning profile|No such module|CodeSign|Signing for|Command SwiftCompile failed|Command CompileSwiftSources failed/i.test(line)
  ));
  const selected = important.length ? important : lines.slice(-30);
  return selected.slice(-40).join("\n").slice(0, 4000);
}

function formatXcodeBuildFailure(error: unknown, context: { projectPath: string; scheme: string; deviceName: string }): Error {
  const output = commandFailureOutput(error);
  const summary = buildFailureSummary(output);
  const resultBundle = /Writing error result bundle to\s+([^\n]+\.xcresult)/i.exec(output)?.[1]?.trim() ?? null;
  const schemeMissing = /does not contain a scheme named/i.test(output);
  const nextAction = schemeMissing
    ? "ADE could not find that scheme in the project. Refresh the iOS simulator drawer and choose one of the listed schemes; if Xcode only has a user-local scheme, share it from Xcode so command-line builds can see it."
    : "Open the project in Xcode or rerun the shown xcodebuild command to see the full compiler output, then fix the build error and launch again.";
  return new Error([
    `Could not build ${context.scheme} for ${context.deviceName}.`,
    `Project: ${context.projectPath}`,
    `Scheme: ${context.scheme}`,
    resultBundle ? `Result bundle: ${resultBundle}` : null,
    summary ? `Build output:\n${summary}` : null,
    `Next action: ${nextAction}`,
  ].filter(Boolean).join("\n"));
}

const defaultRunCommand: RunCommand = async (command, args, options = {}) => {
  const result = await execFile(command, args, {
    cwd: options.cwd,
    env: options.env,
    timeout: options.timeoutMs ?? 30_000,
    maxBuffer: 50 * 1024 * 1024,
  });
  return {
    stdout: result.stdout?.toString() ?? "",
    stderr: result.stderr?.toString() ?? "",
  };
};

let run: RunCommand = defaultRunCommand;
let spawnProcess: SpawnProcess = spawn;
let commandExistsProbe: CommandExistsProbe = commandExists;

export function __testSetIosSimulatorProcessHooks(hooks: {
  run?: RunCommand;
  spawn?: SpawnProcess;
  commandExists?: CommandExistsProbe;
}): () => void {
  const previous = { run, spawnProcess, commandExistsProbe };
  if (hooks.run) run = hooks.run;
  if (hooks.spawn) spawnProcess = hooks.spawn;
  if (hooks.commandExists) commandExistsProbe = hooks.commandExists;
  return () => {
    run = previous.run;
    spawnProcess = previous.spawnProcess;
    commandExistsProbe = previous.commandExistsProbe;
  };
}

export function shouldOpenSimulatorAppForLaunch(keepSimulatorInBackground?: boolean | null): boolean {
  return keepSimulatorInBackground !== true;
}

export function resolveIosSimulatorStreamBackend(
  requestedBackend: "auto" | IosSimulatorStreamBackend,
): IosSimulatorStreamBackend {
  if (requestedBackend !== "auto") return requestedBackend;
  return "simulator-window-capture";
}

function encodeMcpMessage(message: JsonRpcMessage): Buffer {
  return Buffer.from(`${JSON.stringify(message)}\n`, "utf8");
}

function extractMcpMessages(buffer: Buffer<ArrayBufferLike>): { messages: JsonRpcMessage[]; rest: Buffer<ArrayBufferLike> } {
  const messages: JsonRpcMessage[] = [];
  let rest = buffer;
  while (rest.length) {
    const headerEnd = rest.indexOf("\r\n\r\n");
    if (headerEnd >= 0) {
      const header = rest.subarray(0, headerEnd).toString("utf8");
      const lengthMatch = /Content-Length:\s*(\d+)/i.exec(header);
      if (!lengthMatch) break;
      const length = Number(lengthMatch[1]);
      const start = headerEnd + 4;
      if (!Number.isFinite(length) || rest.length < start + length) break;
      const body = rest.subarray(start, start + length).toString("utf8");
      try {
        messages.push(JSON.parse(body) as JsonRpcMessage);
      } catch {
        // Ignore malformed frames from a crashing bridge; stderr carries details.
      }
      rest = rest.subarray(start + length);
      continue;
    }

    const newline = rest.indexOf("\n");
    if (newline < 0) break;
    const line = rest.subarray(0, newline).toString("utf8").trim();
    rest = rest.subarray(newline + 1);
    if (!line.startsWith("{")) continue;
    try {
      messages.push(JSON.parse(line) as JsonRpcMessage);
    } catch {
      // Keep scanning; this fallback handles line-delimited JSON-RPC bridges.
    }
  }
  return { messages, rest: Buffer.from(rest) };
}

function disposeXcodeMcpBridge(bridge: XcodeMcpBridge, reason: Error): void {
  for (const [id, pending] of bridge.pending) {
    clearTimeout(pending.timer);
    pending.reject(reason);
    bridge.pending.delete(id);
  }
  bridge.child.stdout?.removeAllListeners();
  bridge.child.stderr?.removeAllListeners();
  bridge.child.removeAllListeners();
  if (bridge.child.exitCode == null && bridge.child.signalCode == null) bridge.child.kill("SIGTERM");
}

function handleXcodeMcpMessage(bridge: XcodeMcpBridge, message: JsonRpcMessage): void {
  if (message.id == null) return;
  const pending = bridge.pending.get(message.id);
  if (!pending) return;
  bridge.pending.delete(message.id);
  clearTimeout(pending.timer);
  if (message.error) {
    pending.reject(new Error(message.error.message ?? `${pending.description} failed.`));
    return;
  }
  pending.resolve(message.result);
}

function createXcodeMcpBridge(onTerminated: (bridge: XcodeMcpBridge, reason: Error) => void): XcodeMcpBridge {
  const child = spawnProcess("xcrun", ["mcpbridge"], {
    env: {
      ...process.env,
      MCP_XCODE_SESSION_ID: XCODE_MCP_SESSION_ID,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const bridge: XcodeMcpBridge = {
    child,
    initialized: false,
    initializing: null,
    nextId: 1,
    pending: new Map(),
    stderr: "",
    stdoutBuffer: Buffer.alloc(0),
  };
  child.stderr?.on("data", (chunk: Buffer) => {
    bridge.stderr = `${bridge.stderr}${chunk.toString()}`.slice(-8000);
  });
  child.once("error", (error) => {
    onTerminated(bridge, error);
  });
  child.once("exit", (code, signal) => {
    const detail = bridge.stderr.trim();
    onTerminated(bridge, new Error(detail || `xcrun mcpbridge exited with ${signal ?? code ?? "unknown status"}.`));
  });
  child.stdout?.on("data", (chunk: Buffer) => {
    bridge.stdoutBuffer = Buffer.concat([bridge.stdoutBuffer, chunk]);
    const extracted = extractMcpMessages(bridge.stdoutBuffer);
    bridge.stdoutBuffer = extracted.rest;
    for (const message of extracted.messages) handleXcodeMcpMessage(bridge, message);
  });
  return bridge;
}

function sendXcodeMcpRequest(bridge: XcodeMcpBridge, method: string, params: unknown, timeoutMs: number, description: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = bridge.nextId++;
    const timer = setTimeout(() => {
      bridge.pending.delete(id);
      reject(new Error(`Timed out waiting for ${description}. If Xcode is showing an "Allow" prompt, click Allow and press Retry. If no prompt is visible, open Xcode > Settings > Intelligence and enable "Allow external agents to use Xcode tools" under Model Context Protocol.`));
    }, timeoutMs);
    timer.unref?.();
    bridge.pending.set(id, {
      description,
      reject,
      resolve,
      timer,
    });
    bridge.child.stdin?.write(encodeMcpMessage({
      jsonrpc: "2.0",
      id,
      method,
      params,
    }));
  });
}

async function ensureXcodeMcpInitialized(bridge: XcodeMcpBridge): Promise<void> {
  if (bridge.initialized) return;
  if (bridge.initializing) return bridge.initializing;
  bridge.initializing = (async () => {
    await sendXcodeMcpRequest(bridge, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: {
        name: "ADE iOS Simulator Preview Lab",
        version: "0.1.0",
      },
    }, 20_000, "Xcode MCP initialize");
    bridge.child.stdin?.write(encodeMcpMessage({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    }));
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 250);
      timer.unref?.();
    });
    bridge.initialized = true;
  })().finally(() => {
    bridge.initializing = null;
  });
  return bridge.initializing;
}

function textFromMcpResult(result: unknown): string {
  const record = isRecord(result) ? result : {};
  const toolResult = isRecord(record.result) ? record.result as McpToolCallResult : record as McpToolCallResult;
  const structured = isRecord(toolResult.structuredContent) ? JSON.stringify(toolResult.structuredContent) : null;
  const contentText = Array.isArray(toolResult.content)
    ? toolResult.content
      .map((entry) => typeof entry?.text === "string" ? entry.text : "")
      .filter(Boolean)
      .join("\n")
    : "";
  return structured ?? contentText;
}

function objectFromMcpResult(result: unknown): Record<string, unknown> {
  const record = isRecord(result) ? result : {};
  const toolResult = isRecord(record.result) ? record.result as McpToolCallResult : record as McpToolCallResult;
  if (isRecord(toolResult.structuredContent)) return toolResult.structuredContent;
  const text = textFromMcpResult(result).trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (isRecord(parsed)) return parsed;
  } catch {
    // Some Xcode tools return human-readable text; regex readers handle that.
  }
  return { message: text };
}

async function cleanupOrphanedIdbCompanions(deviceUdid?: string | null): Promise<number> {
  if (process.platform !== "darwin") return 0;
  let stdout = "";
  try {
    ({ stdout } = await run("ps", ["-axo", "pid=,ppid=,command="], { timeoutMs: 5_000 }));
  } catch {
    return 0;
  }
  let stopped = 0;
  const stoppedPids: number[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    const command = match[3] ?? "";
    if (!Number.isFinite(pid) || pid <= 0 || parentPid !== 1) continue;
    if (!/\bidb_companion\b/.test(command) || !command.includes("--udid")) continue;
    if (deviceUdid && !command.includes(deviceUdid)) continue;
    try {
      process.kill(pid, "SIGTERM");
      stopped += 1;
      stoppedPids.push(pid);
    } catch {
      // Best effort cleanup; a process may exit between ps and kill.
    }
  }
  if (stoppedPids.length) {
    await delay(250);
    for (const pid of stoppedPids) {
      try {
        process.kill(pid, 0);
        process.kill(pid, "SIGKILL");
      } catch {
        // Already stopped.
      }
    }
  }
  return stopped;
}

async function readPlistValue(plistPath: string, key: string): Promise<string | null> {
  try {
    const { stdout } = await run("/usr/libexec/PlistBuddy", ["-c", `Print:${key}`, plistPath], { timeoutMs: 10_000 });
    const value = stdout.trim();
    return value.length ? value : null;
  } catch {
    return null;
  }
}

function targetId(parts: Array<string | null | undefined>): string {
  return Buffer.from(parts.filter(Boolean).join("|")).toString("base64url");
}

function decodeTargetId(id: string | null | undefined): string[] {
  if (!id) return [];
  try {
    return Buffer.from(id, "base64url").toString("utf8").split("|").filter(Boolean);
  } catch {
    return [];
  }
}

function normalizeProjectPath(root: string, rawProjectPath?: string | null): string | null {
  if (!rawProjectPath) return null;
  const resolved = path.isAbsolute(rawProjectPath) ? rawProjectPath : path.join(root, rawProjectPath);
  return resolved.endsWith(".xcodeproj") && fs.existsSync(resolved) ? resolved : null;
}

function relativeToRoot(root: string, absolutePath: string): string {
  const relative = path.relative(root, absolutePath);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? relative
    : absolutePath;
}

function readSourceSnippet(projectRoot: string, sourceFile: string | null, sourceLine: number | null): string | null {
  if (!sourceFile || !sourceLine) return null;
  const filePath = path.isAbsolute(sourceFile) ? sourceFile : path.join(projectRoot, sourceFile);
  const relative = path.relative(projectRoot, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  try {
    const text = fs.readFileSync(filePath, "utf8");
    const lines = text.split(/\r?\n/);
    const lineIndex = Math.max(0, sourceLine - 1);
    const start = Math.max(0, lineIndex - 3);
    const end = Math.min(lines.length, lineIndex + 4);
    return lines
      .slice(start, end)
      .map((line, index) => `${start + index + 1}: ${line}`)
      .join("\n");
  } catch {
    return null;
  }
}

function quotedSwiftLiteral(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collectSwiftFiles(root: string): string[] {
  const iosRoot = path.join(root, "apps", "ios");
  const startRoot = fs.existsSync(iosRoot) ? iosRoot : root;
  const files: string[] = [];
  const skip = new Set([".build", ".git", "DerivedData", "Build", "node_modules"]);
  const walk = (dir: string, depth: number) => {
    if (depth > 9) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (skip.has(entry.name)) continue;
      const next = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(next, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith(".swift")) {
        files.push(next);
      }
    }
  };
  walk(startRoot, 0);
  return files;
}

function resolveSwiftSourceFile(root: string, sourceFile?: string | null): string | null {
  const raw = sourceFile?.trim();
  if (!raw) return null;
  const candidates = [
    path.isAbsolute(raw) ? raw : path.join(root, raw),
    path.join(root, "apps", "ios", raw),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return path.resolve(candidate);
  }
  const normalized = raw.replace(/\\/g, "/");
  return collectSwiftFiles(root).find((filePath) => {
    const relativeRoot = relativeToRoot(root, filePath).replace(/\\/g, "/");
    const relativeIos = path.relative(path.join(root, "apps", "ios"), filePath).replace(/\\/g, "/");
    return relativeRoot.endsWith(normalized)
      || relativeIos.endsWith(normalized)
      || path.basename(filePath) === path.basename(normalized);
  }) ?? null;
}

function resolveIosProjectDir(root: string): string {
  const projectPath = path.join(root, ADE_IOS_PROJECT);
  return fs.existsSync(projectPath) ? path.dirname(projectPath) : root;
}

function sourceFilePathForXcode(projectRoot: string, absoluteSourceFile: string): string {
  const iosProjectDir = resolveIosProjectDir(projectRoot);
  const relativeToProject = path.relative(iosProjectDir, absoluteSourceFile);
  if (relativeToProject && !relativeToProject.startsWith("..") && !path.isAbsolute(relativeToProject)) {
    return relativeToProject;
  }
  return relativeToRoot(projectRoot, absoluteSourceFile);
}

export function parseXcodePreviewWindows(raw: string, projectRoot: string): IosSimulatorPreviewWindow[] {
  const windows: IosSimulatorPreviewWindow[] = [];
  const seen = new Set<string>();
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length);
  const addWindow = (tabIdentifier: string, line: string) => {
    if (!tabIdentifier || seen.has(tabIdentifier)) return;
    seen.add(tabIdentifier);
    const workspacePath = /workspacePath\s*:\s*([^,\n]+)/i.exec(line)?.[1]?.trim()
      ?? /((?:\/[^,\n\t]+?)(?:\.xcworkspace|\.xcodeproj|\/apps\/ios|\/[^,\n\t]+ADE[^,\n\t]*))/i.exec(line)?.[1]?.trim()
      ?? null;
    const title = /(?:title|name|window|workspace)\s*[:=]\s*"?([^,"\n]+)"?/i.exec(line)?.[1]?.trim() ?? null;
    windows.push({
      tabIdentifier,
      title,
      workspacePath,
      raw: line.trim(),
    });
  };

  for (const line of lines) {
    const tabMatch = /tabIdentifier\s*:\s*([^,\s\n]+)/i.exec(line);
    if (tabMatch?.[1]) addWindow(tabMatch[1].trim(), line);
  }

  const uuidPattern = /[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}/g;
  const fullTextMatches = [...raw.matchAll(uuidPattern)];
  const sourceLines = lines.length ? lines : [raw];
  for (const match of fullTextMatches) {
    const tabIdentifier = match[0];
    const line = sourceLines.find((candidate) => candidate.includes(tabIdentifier)) ?? raw.slice(Math.max(0, match.index - 240), Math.min(raw.length, match.index + 420));
    addWindow(tabIdentifier, line);
  }
  if (!windows.length && raw.trim()) {
    windows.push({
      tabIdentifier: "",
      title: null,
      workspacePath: raw.includes(projectRoot) ? projectRoot : null,
      raw: raw.trim(),
    });
  }
  return windows;
}

function parseSwiftPreviewDefinitions(text: string): SwiftPreviewDefinition[] {
  const definitions: SwiftPreviewDefinition[] = [];
  const lineForPosition = (position: number) => text.slice(0, position).split(/\r?\n/).length;
  const macroPattern = /#Preview(?:\s*\(\s*"((?:\\.|[^"\\])+)")?/g;
  let macroMatch: RegExpExecArray | null;
  while ((macroMatch = macroPattern.exec(text)) !== null) {
    const title = macroMatch[1]?.replace(/\\"/g, "\"").replace(/\\\\/g, "\\").trim();
    definitions.push({
      title: title?.length ? title : `Preview ${definitions.length + 1}`,
      line: lineForPosition(macroMatch.index),
      index: 0,
      kind: "preview-macro",
      position: macroMatch.index,
    });
  }
  const providerPattern = /struct\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*PreviewProvider\b/g;
  let providerMatch: RegExpExecArray | null;
  while ((providerMatch = providerPattern.exec(text)) !== null) {
    definitions.push({
      title: providerMatch[1] ?? `PreviewProvider ${definitions.length + 1}`,
      line: lineForPosition(providerMatch.index),
      index: 0,
      kind: "preview-provider",
      position: providerMatch.index,
    });
  }
  return definitions
    .sort((a, b) => a.position - b.position)
    .map((definition, index) => ({ ...definition, index }));
}

function previewProximity(projectRoot: string, previewFile: string, selectedFile: string | null): IosSimulatorPreviewTarget["proximity"] {
  if (!selectedFile) return "project";
  if (path.resolve(previewFile) === path.resolve(selectedFile)) return "selected-file";
  const selectedDir = path.dirname(selectedFile);
  const previewDir = path.dirname(previewFile);
  const selectedFeature = path.relative(path.join(projectRoot, "apps", "ios", "ADE", "Views"), selectedDir).split(path.sep)[0];
  const previewFeature = path.relative(path.join(projectRoot, "apps", "ios", "ADE", "Views"), previewDir).split(path.sep)[0];
  if (selectedDir === previewDir || (selectedFeature && selectedFeature === previewFeature)) return "feature-file";
  return "project";
}

function inferSwiftUITabItems(projectRoot: string | null | undefined): InferredSwiftUITabItem[] {
  if (!projectRoot) return [];
  const root = path.resolve(projectRoot);
  if (!fs.existsSync(root)) return [];
  const items: InferredSwiftUITabItem[] = [];
  const seen = new Set<string>();
  for (const filePath of collectSwiftFiles(root)) {
    let text = "";
    try {
      text = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index]?.includes(".tabItem")) continue;
      const searchEnd = Math.min(lines.length, index + 10);
      for (let cursor = index; cursor < searchEnd; cursor += 1) {
        const line = lines[cursor] ?? "";
        const match = /\b(?:Label|Text)\s*\(\s*"((?:\\.|[^"\\])+)"/.exec(line);
        if (!match?.[1]) continue;
        const label = match[1].replace(/\\"/g, "\"").replace(/\\\\/g, "\\").trim();
        if (!label || seen.has(label.toLowerCase())) continue;
        const sourceFile = relativeToRoot(root, filePath);
        const sourceLine = cursor + 1;
        seen.add(label.toLowerCase());
        items.push({
          label,
          sourceFile,
          sourceLine,
          snippet: readSourceSnippet(root, sourceFile, sourceLine),
        });
        break;
      }
    }
  }
  return items.slice(0, 12);
}

function sourceTermsForElement(element: IosScreenElement): string[] {
  const raw = [
    element.label,
    element.identifier,
    element.value,
    element.componentId,
  ];
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const value of raw) {
    const normalized = value?.trim();
    if (!normalized || normalized.length < 2 || seen.has(normalized.toLowerCase())) continue;
    const candidates = [
      normalized,
      ...normalized
        .split(/\s+[·•|]\s+|[,;:]/)
        .map((part) => part.trim())
        .filter((part) => part.length >= 3),
    ];
    for (const candidate of candidates) {
      const key = candidate.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      terms.push(candidate);
    }
  }
  return terms;
}

function swiftUiLiteralReason(trimmedLine: string, quoted: string): { reason: string; confidence: IosSourceMatch["confidence"] } | null {
  if (trimmedLine.startsWith("//") || trimmedLine.startsWith("///") || trimmedLine.startsWith("*")) return null;
  if (/^(?:(?:private|fileprivate|internal|public|static)\s+)*(?:let|var)\s+/.test(trimmedLine)) return null;
  const escaped = escapeRegExp(quoted);
  const modifier = (name: string) => (
    new RegExp(`\\.${name}\\s*\\([^\\n]*${escaped}`).test(trimmedLine)
    || new RegExp(`\\.${name}\\s*\\(\\s*Text\\s*\\(\\s*${escaped}`).test(trimmedLine)
  );
  const call = (name: string) => new RegExp(`\\b${name}\\s*\\(\\s*(?:verbatim:\\s*)?${escaped}`).test(trimmedLine);
  if (trimmedLine.includes(quoted)) {
    if (modifier("accessibilityLabel")) return { reason: `accessibilityLabel(${quoted})`, confidence: "exact" };
    if (modifier("accessibilityIdentifier")) return { reason: `accessibilityIdentifier(${quoted})`, confidence: "exact" };
    if (modifier("accessibilityValue")) return { reason: `accessibilityValue(${quoted})`, confidence: "exact" };
    if (modifier("accessibilityHint")) return { reason: `accessibilityHint(${quoted})`, confidence: "exact" };
    if (modifier("navigationTitle")) return { reason: `navigationTitle(${quoted})`, confidence: "exact" };
    for (const name of ["Text", "Button", "Label", "NavigationLink", "Toggle", "Picker", "Menu", "Section"]) {
      if (call(name)) return { reason: `${name}(${quoted})`, confidence: "exact" };
    }
    if (new RegExp(`\\bImage\\s*\\(\\s*systemName:\\s*${escaped}`).test(trimmedLine)) {
      return { reason: `Image(systemName: ${quoted})`, confidence: "exact" };
    }
  }
  return null;
}

function quotedSwiftStrings(line: string): string[] {
  const out: string[] = [];
  const pattern = /"((?:\\.|[^"\\])*)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line)) !== null) {
    out.push(match[1]?.replace(/\\"/g, "\"").replace(/\\\\/g, "\\") ?? "");
  }
  return out;
}

function swiftUiTermReason(trimmedLine: string, term: string): { reason: string; confidence: IosSourceMatch["confidence"] } | null {
  const exact = swiftUiLiteralReason(trimmedLine, quotedSwiftLiteral(term));
  if (exact) return exact;
  if (trimmedLine.startsWith("//") || trimmedLine.startsWith("///") || trimmedLine.startsWith("*")) return null;
  if (/^(?:(?:private|fileprivate|internal|public|static)\s+)*(?:let|var)\s+/.test(trimmedLine)) return null;
  const quoted = quotedSwiftStrings(trimmedLine);
  const lowerTerm = term.toLowerCase();
  const matchedLiteral = quoted.find((value) => value.toLowerCase().includes(lowerTerm));
  if (!matchedLiteral) return null;

  const quotedMatch = quotedSwiftLiteral(matchedLiteral);
  const construct = (name: string) => new RegExp(`\\.${name}\\s*\\(|\\b${name}\\s*\\(`).test(trimmedLine);
  if (construct("accessibilityLabel")) return { reason: `accessibilityLabel contains ${quotedSwiftLiteral(term)} in ${quotedMatch}`, confidence: "candidate" };
  if (construct("accessibilityIdentifier")) return { reason: `accessibilityIdentifier contains ${quotedSwiftLiteral(term)} in ${quotedMatch}`, confidence: "candidate" };
  if (construct("accessibilityValue")) return { reason: `accessibilityValue contains ${quotedSwiftLiteral(term)} in ${quotedMatch}`, confidence: "candidate" };
  if (construct("accessibilityHint")) return { reason: `accessibilityHint contains ${quotedSwiftLiteral(term)} in ${quotedMatch}`, confidence: "candidate" };
  if (construct("navigationTitle")) return { reason: `navigationTitle contains ${quotedSwiftLiteral(term)} in ${quotedMatch}`, confidence: "candidate" };
  for (const name of ["Text", "Button", "Label", "NavigationLink", "Toggle", "Picker", "Menu", "Section"]) {
    if (construct(name)) return { reason: `${name} contains ${quotedSwiftLiteral(term)} in ${quotedMatch}`, confidence: "candidate" };
  }
  return null;
}

function isTrustedSourceMatch(match: IosSourceMatch): boolean {
  return match.confidence === "exact" && !match.reason.startsWith("contains");
}

function findSourceMatchesForElement(projectRoot: string | null | undefined, element: IosScreenElement): IosSourceMatch[] {
  if (!projectRoot) return [];
  const root = path.resolve(projectRoot);
  if (!fs.existsSync(root)) return [];
  const terms = sourceTermsForElement(element);
  if (!terms.length) return [];
  const matches: IosSourceMatch[] = [];
  for (const filePath of collectSwiftFiles(root)) {
    let text = "";
    try {
      text = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (const term of terms) {
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        const trimmed = line.trim();
        const match = swiftUiTermReason(trimmed, term);
        if (!match) continue;
        const relativeFile = relativeToRoot(root, filePath);
        matches.push({
          sourceFile: relativeFile,
          sourceLine: index + 1,
          confidence: match.confidence,
          reason: match.reason,
          snippet: readSourceSnippet(root, relativeFile, index + 1),
        });
      }
    }
  }
  const score = (match: IosSourceMatch): number => {
    let value = match.confidence === "exact" ? 100 : 40;
    if (match.reason.startsWith("accessibilityLabel")) value += 40;
    if (match.reason.startsWith("accessibilityIdentifier")) value += 35;
    if (match.reason.startsWith("Button")) value += 25;
    if (match.reason.startsWith("Label")) value += 20;
    if (match.reason.startsWith("Text")) value += 15;
    if (/\/Views\//.test(match.sourceFile)) value += 10;
    return value;
  };
  const deduped = new Map<string, IosSourceMatch>();
  for (const match of matches) {
    const key = `${match.sourceFile}:${match.sourceLine}:${match.reason}`;
    if (!deduped.has(key)) deduped.set(key, match);
  }
  return Array.from(deduped.values())
    .sort((a, b) => score(b) - score(a) || a.sourceFile.localeCompare(b.sourceFile) || a.sourceLine - b.sourceLine)
    .slice(0, 5);
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundFrame(frame: IosInspectableFrame | null | undefined): IosInspectableFrame | null {
  if (!frame) return null;
  return {
    x: rounded(frame.x),
    y: rounded(frame.y),
    width: rounded(frame.width),
    height: rounded(frame.height),
  };
}

function frameCenter(frame: IosInspectableFrame): { x: number; y: number } {
  return {
    x: frame.x + (frame.width / 2),
    y: frame.y + (frame.height / 2),
  };
}

function frameContainsFrame(outer: IosInspectableFrame, inner: IosInspectableFrame): boolean {
  return (
    inner.x >= outer.x
    && inner.y >= outer.y
    && inner.x + inner.width <= outer.x + outer.width
    && inner.y + inner.height <= outer.y + outer.height
  );
}

function frameIntersectionArea(a: IosInspectableFrame, b: IosInspectableFrame): number {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return Math.max(0, right - left) * Math.max(0, bottom - top);
}

function frameDistance(a: IosInspectableFrame, b: IosInspectableFrame): number {
  const centerA = frameCenter(a);
  const centerB = frameCenter(b);
  return Math.hypot(centerA.x - centerB.x, centerA.y - centerB.y);
}

function compactScreenElement(element: IosScreenElement): Record<string, unknown> {
  return {
    id: element.id,
    source: element.source,
    layer: element.layer,
    label: element.label,
    value: element.value,
    role: element.role,
    elementType: element.elementType,
    identifier: element.identifier,
    componentId: element.componentId,
    sourceFile: element.sourceFile,
    sourceLine: element.sourceLine,
    frame: roundFrame(element.frame),
    screenshotFrame: roundFrame(element.pixelFrame),
  };
}

function nearbyScreenElements(snapshot: IosScreenSnapshot, selected: IosScreenElement, limit = 12): Array<Record<string, unknown>> {
  const selectedFrame = selected.pixelFrame;
  const relationFor = (otherFrame: IosInspectableFrame, intersection: number): string => {
    if (frameContainsFrame(otherFrame, selectedFrame)) return "ancestor-or-container";
    if (frameContainsFrame(selectedFrame, otherFrame)) return "descendant";
    if (intersection > 0) return "overlapping";
    return "nearby";
  };
  const relationBoostFor = (relation: string): number => {
    if (relation === "ancestor-or-container" || relation === "descendant") return -120;
    if (relation === "overlapping") return -80;
    return 0;
  };
  return snapshot.elements
    .filter((element) => element.id !== selected.id)
    .filter((element) => element.pixelFrame.width > 0 && element.pixelFrame.height > 0)
    .map((element) => {
      const intersection = frameIntersectionArea(selectedFrame, element.pixelFrame);
      const relation = relationFor(element.pixelFrame, intersection);
      const distance = frameDistance(selectedFrame, element.pixelFrame);
      const sameSourceBoost = element.source === selected.source ? 0 : 20;
      return {
        element,
        distance,
        relation,
        score: distance + sameSourceBoost + relationBoostFor(relation),
      };
    })
    .sort((a, b) => a.score - b.score)
    .slice(0, limit)
    .map(({ element, distance, relation }) => ({
      ...compactScreenElement(element),
      relation,
      distancePx: Math.round(distance),
    }));
}

function screenPacket(snapshot: IosScreenSnapshot): Record<string, unknown> {
  return {
    deviceUdid: snapshot.deviceUdid,
    capturedAt: snapshot.capturedAt,
    screenWidth: snapshot.screen.width,
    screenHeight: snapshot.screen.height,
    screenScale: snapshot.screen.scale,
    screenshotWidth: snapshot.screenshot.width,
    screenshotHeight: snapshot.screenshot.height,
  };
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTcpPort(host: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ host, port });
      const finish = (ok: boolean) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), 250);
      timer.unref?.();
      socket.once("connect", () => {
        clearTimeout(timer);
        finish(true);
      });
      socket.once("error", () => {
        clearTimeout(timer);
        finish(false);
      });
    });
    if (connected) return;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${host}:${port}.`);
}

function pngDimensions(buffer: Buffer): { width: number | null; height: number | null } {
  if (buffer.length < 24) return { width: null, height: null };
  if (buffer.toString("ascii", 1, 4) !== "PNG") return { width: null, height: null };
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function normalizeLaunchMode(mode: unknown): "snapshot" | "live" {
  if (mode == null) return "snapshot";
  if (mode === "snapshot" || mode === "live") return mode;
  throw new Error("iOS Simulator launch mode must be `snapshot` or `live`.");
}

function normalizeLaunchEnvironment(value: unknown): Record<string, string> {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("iOS Simulator launch environment must be an object.");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  const normalized: Record<string, string> = {};
  for (const [key, rawValue] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Invalid iOS Simulator launch environment key: ${key}`);
    }
    if (rawValue == null) continue;
    normalized[key] = String(rawValue);
  }
  return normalized;
}

function normalizeLaunchArguments(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new Error("iOS Simulator launch arguments must be an array.");
  }
  for (const item of value) {
    if (typeof item !== "string") {
      throw new Error("iOS Simulator launch arguments must be an array of strings.");
    }
  }
  return value as string[];
}

function normalizeCoordinate(value: unknown, label: string): number {
  const coordinate = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(coordinate) || coordinate < 0) {
    throw new Error(`${label} must be a non-negative number.`);
  }
  return coordinate;
}

function normalizeFrame(value: Partial<IosInspectableElement["frame"]> | undefined): IosInspectableElement["frame"] | null {
  if (!value) return null;
  const x = Number(value.x);
  const y = Number(value.y);
  const width = Number(value.width);
  const height = Number(value.height);
  if (![x, y, width, height].every(Number.isFinite)) return null;
  return { x, y, width, height };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" || typeof value === "boolean") return String(value);
  }
  return null;
}

function cleanClaimId(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readNumber(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function normalizeAnyFrame(value: unknown): IosInspectableFrame | null {
  if (!isRecord(value)) return null;
  const direct = normalizeFrame(value);
  if (direct) return direct;
  const origin = isRecord(value.origin) ? value.origin : null;
  const size = isRecord(value.size) ? value.size : null;
  if (!origin || !size) return null;
  const x = readNumber(origin, ["x"]);
  const y = readNumber(origin, ["y"]);
  const width = readNumber(size, ["width", "w"]);
  const height = readNumber(size, ["height", "h"]);
  if ([x, y, width, height].every((number) => number != null)) {
    return { x: x ?? 0, y: y ?? 0, width: width ?? 0, height: height ?? 0 };
  }
  return null;
}

function containsPoint(frame: IosInspectableElement["pixelFrame"] | IosScreenElement["pixelFrame"], x: number, y: number): boolean {
  return (
    x >= frame.x
    && y >= frame.y
    && x <= frame.x + frame.width
    && y <= frame.y + frame.height
  );
}

function hasSelectableIdentity(element: IosScreenElement): boolean {
  return Boolean(
    element.sourceFile
    || element.componentId
    || element.identifier
    || element.label
    || element.value,
  );
}

function findSmallestScreenElementAt(elements: IosScreenElement[], x: number, y: number): IosScreenElement | null {
  const hits = elements.filter((element) => containsPoint(element.pixelFrame, x, y));
  const byArea = (a: IosScreenElement, b: IosScreenElement) => {
    const areaA = a.pixelFrame.width * a.pixelFrame.height;
    const areaB = b.pixelFrame.width * b.pixelFrame.height;
    if (areaA !== areaB) return areaA - areaB;
    return (a.label ?? a.componentId ?? a.id).localeCompare(b.label ?? b.componentId ?? b.id);
  };
  const describedHits = hits.filter(hasSelectableIdentity);
  const inspectorHits = describedHits.filter((element) => element.source === "ade-inspector").sort(byArea);
  if (inspectorHits.length) return inspectorHits[0] ?? null;
  if (describedHits.length) return describedHits.sort(byArea)[0] ?? null;
  return hits.sort(byArea)[0] ?? null;
}

function inspectorElementToScreenElement(element: IosInspectableElement): IosScreenElement {
  return {
    id: `ade-inspector:${element.id}`,
    source: "ade-inspector",
    layer: "app",
    label: typeof element.metadata.label === "string" ? element.metadata.label : element.componentId,
    value: typeof element.metadata.value === "string" ? element.metadata.value : null,
    role: typeof element.metadata.role === "string" ? element.metadata.role : null,
    elementType: typeof element.metadata.elementType === "string" ? element.metadata.elementType : null,
    identifier: element.accessibilityIdentifier ?? element.componentId,
    frame: element.frame,
    pixelFrame: element.pixelFrame,
    componentId: element.componentId,
    sourceFile: element.sourceFile,
    sourceLine: element.sourceLine,
    metadata: {
      ...element.metadata,
      inspectorElementId: element.id,
    },
  };
}

function accessibilityElementSignature(element: IosScreenElement): string {
  const frame = element.pixelFrame;
  const label = element.label ?? "";
  const identifier = element.identifier ?? "";
  return [
    Math.round(frame.x),
    Math.round(frame.y),
    Math.round(frame.width),
    Math.round(frame.height),
    identifier || label || element.role || element.elementType || "",
  ].join(":");
}

function collectAccessibilityElements(raw: unknown): IosScreenElement[] {
  const elements: IosScreenElement[] = [];
  const visit = (value: unknown, indexPath: number[]) => {
    if (Array.isArray(value)) {
      value.forEach((child, index) => visit(child, [...indexPath, index]));
      return;
    }
    if (!isRecord(value)) return;
    const frame = normalizeAnyFrame(value.frame)
      ?? normalizeAnyFrame(value.rect)
      ?? normalizeAnyFrame(value.bounds);
    if (frame && frame.width > 0 && frame.height > 0) {
      const label = readString(value, ["label", "name", "title", "text", "accessibilityLabel", "AXLabel", "AXTitle"]);
      const identifier = readString(value, ["identifier", "accessibilityIdentifier", "id", "AXIdentifier", "AXUniqueId"]);
      const role = readString(value, ["role", "traits", "class", "type", "role_description"]);
      elements.push({
        id: `accessibility:${indexPath.join(".")}`,
        source: "accessibility",
        layer: "accessibility",
        label,
        value: readString(value, ["value", "placeholderValue", "placeholder", "text", "AXValue"]),
        role,
        elementType: readString(value, ["type", "className", "class"]),
        identifier,
        frame,
        pixelFrame: frame,
        componentId: null,
        sourceFile: null,
        sourceLine: null,
        metadata: value,
      });
    }
    for (const key of ["children", "subviews", "elements"]) {
      const child = value[key];
      if (child != null) visit(child, [...indexPath, elements.length]);
    }
  };
  visit(raw, []);
  return elements;
}

function inferAccessibilityScale(
  elements: IosScreenElement[],
  shot: IosSimulatorScreenshot,
): number | null {
  const width = shot.width ?? 0;
  const height = shot.height ?? 0;
  if (!elements.length || width <= 0 || height <= 0) return null;

  const logicalWidth = elements.reduce((max, element) => Math.max(max, element.frame.x + element.frame.width), 0);
  const logicalHeight = elements.reduce((max, element) => Math.max(max, element.frame.y + element.frame.height), 0);
  const candidates = [1, 2, 3, 4];
  const usableRatios = [
    logicalWidth > 0 ? width / logicalWidth : null,
    logicalHeight > 0 ? height / logicalHeight : null,
  ].filter((ratio): ratio is number => Boolean(ratio && Number.isFinite(ratio) && ratio > 0));
  if (!usableRatios.length) return null;

  const averageRatio = usableRatios.reduce((sum, ratio) => sum + ratio, 0) / usableRatios.length;
  const nearestDeviceScale = candidates
    .map((scale) => ({ scale, distance: Math.abs(scale - averageRatio) }))
    .sort((a, b) => a.distance - b.distance)[0];

  if (nearestDeviceScale && nearestDeviceScale.distance <= 0.65) {
    return nearestDeviceScale.scale;
  }
  return usableRatios[0] ?? null;
}

function scaleAccessibilityElementsToScreenshot(
  elements: IosScreenElement[],
  shot: IosSimulatorScreenshot,
): { elements: IosScreenElement[]; screen: IosInspectableScreen | null } {
  const width = shot.width ?? 0;
  const height = shot.height ?? 0;
  if (!elements.length || width <= 0 || height <= 0) {
    return { elements, screen: null };
  }
  const scale = inferAccessibilityScale(elements, shot);
  if (!scale || !Number.isFinite(scale) || scale <= 0) {
    return { elements, screen: null };
  }
  const nextElements = elements.map((element) => ({
    ...element,
    pixelFrame: {
      x: element.frame.x * scale,
      y: element.frame.y * scale,
      width: element.frame.width * scale,
      height: element.frame.height * scale,
    },
  }));
  return {
    elements: nextElements,
    screen: {
      width: width / scale,
      height: height / scale,
      scale,
    },
  };
}

function mergeScreenElements(inspectorElements: IosScreenElement[], accessibilityElements: IosScreenElement[]): IosScreenElement[] {
  const merged = new Map<string, IosScreenElement>();
  for (const element of inspectorElements) {
    merged.set(accessibilityElementSignature(element), element);
  }
  for (const element of accessibilityElements) {
    const signature = accessibilityElementSignature(element);
    const existing = merged.get(signature);
    if (!existing) {
      merged.set(signature, element);
      continue;
    }
    merged.set(signature, {
      ...existing,
      label: existing.label ?? element.label,
      value: existing.value ?? element.value,
      role: existing.role ?? element.role,
      elementType: existing.elementType ?? element.elementType,
      identifier: existing.identifier ?? element.identifier,
      metadata: {
        ...existing.metadata,
        accessibility: element.metadata,
      },
    });
  }
  return Array.from(merged.values()).sort((a, b) => {
    if (a.source !== b.source) return a.source === "ade-inspector" ? -1 : 1;
    const areaA = a.pixelFrame.width * a.pixelFrame.height;
    const areaB = b.pixelFrame.width * b.pixelFrame.height;
    if (areaA !== areaB) return areaA - areaB;
    return (a.label ?? a.componentId ?? a.id).localeCompare(b.label ?? b.componentId ?? b.id);
  });
}

function synthesizeSwiftUITabBarElements(projectRoot: string | null | undefined, elements: IosScreenElement[]): IosScreenElement[] {
  const inferredTabs = inferSwiftUITabItems(projectRoot);
  if (!inferredTabs.length) return [];
  const tabBars = elements.filter((element) => {
    const label = element.label?.toLowerCase() ?? "";
    const role = element.role?.toLowerCase() ?? "";
    const type = element.elementType?.toLowerCase() ?? "";
    return label === "tab bar" || (label.includes("tab") && (role.includes("group") || type.includes("group")));
  });
  const synthesized: IosScreenElement[] = [];
  for (const tabBar of tabBars) {
    if (tabBar.frame.width <= 0 || tabBar.pixelFrame.width <= 0) continue;
    const frameWidth = tabBar.frame.width / inferredTabs.length;
    const pixelWidth = tabBar.pixelFrame.width / inferredTabs.length;
    inferredTabs.forEach((tab, index) => {
      synthesized.push({
        id: `accessibility:synthetic-tab:${tab.label}:${index}`,
        source: "accessibility",
        layer: "accessibility",
        label: tab.label,
        value: null,
        role: "AXButton",
        elementType: "TabItem",
        identifier: `SwiftUI.TabItem.${tab.label}`,
        frame: {
          x: tabBar.frame.x + (frameWidth * index),
          y: tabBar.frame.y,
          width: frameWidth,
          height: tabBar.frame.height,
        },
        pixelFrame: {
          x: tabBar.pixelFrame.x + (pixelWidth * index),
          y: tabBar.pixelFrame.y,
          width: pixelWidth,
          height: tabBar.pixelFrame.height,
        },
        componentId: `TabItem.${tab.label}`,
        sourceFile: tab.sourceFile,
        sourceLine: tab.sourceLine,
        metadata: {
          synthetic: true,
          generatedFrom: "SwiftUI .tabItem source labels and the accessibility Tab Bar frame",
          tabBarElementId: tabBar.id,
          sourceSnippet: tab.snippet,
        },
      });
    });
  }
  return synthesized;
}

async function findAppBundles(root: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 5) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const next = path.join(dir, entry.name);
      if (entry.isDirectory() && entry.name.endsWith(".app")) {
        found.push(next);
        continue;
      }
      if (entry.isDirectory()) {
        await walk(next, depth + 1);
      }
    }
  }
  await walk(root, 0);
  return found;
}

async function findAppBundle(
  root: string,
  criteria: {
    bundleId?: string | null;
    scheme?: string | null;
    /**
     * Xcode product name produced by the app target ("MyApp" → "MyApp.app").
     * Preferred over `scheme` because schemes can build multiple `.app`
     * bundles or use a name that differs from the produced bundle.
     */
    productName?: string | null;
    appBundlePath?: string | null;
  },
): Promise<string | null> {
  if (criteria.appBundlePath && fs.existsSync(criteria.appBundlePath)) return criteria.appBundlePath;
  const appBundles = await findAppBundles(root);
  // productName is the most accurate hint (scheme name can drift from the
  // produced .app); fall back to scheme, then the well-known ADE.app name.
  const expectedNames = [
    criteria.productName ? `${criteria.productName}.app` : null,
    criteria.scheme ? `${criteria.scheme}.app` : null,
    "ADE.app",
  ].filter((value): value is string => Boolean(value));
  if (criteria.bundleId) {
    for (const appBundle of appBundles) {
      const bundleId = await readPlistValue(path.join(appBundle, "Info.plist"), "CFBundleIdentifier");
      if (bundleId === criteria.bundleId) return appBundle;
    }
  }
  for (const expectedName of expectedNames) {
    const match = appBundles.find((candidate) => path.basename(candidate) === expectedName);
    if (match) return match;
  }
  return appBundles[0] ?? null;
}

function unquotePbxValue(raw: string | null | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  return value.replace(/^"|"$/g, "").trim();
}

function readPbxAssignment(block: string, key: string): string | null {
  return unquotePbxValue(new RegExp(`\\n\\s*${escapeRegExp(key)} = ([^;]+);`).exec(block)?.[1]);
}

function normalizePbxName(value: string | null, fallback: string): string {
  if (!value || value.includes("$(")) return fallback;
  return value;
}

function parseApplicationTargetsFromPbxproj(projectPath: string): PbxApplicationTarget[] {
  const pbxPath = path.join(projectPath, "project.pbxproj");
  let text = "";
  try {
    text = fs.readFileSync(pbxPath, "utf8");
  } catch {
    return [];
  }
  const nativeTargetSection = /\/\* Begin PBXNativeTarget section \*\/([\s\S]*?)\/\* End PBXNativeTarget section \*\//.exec(text)?.[1] ?? "";
  const targets: PbxApplicationTarget[] = [];
  const targetBlocks = nativeTargetSection.matchAll(/^\s*([A-Za-z0-9]+) \/\* ([^*]+) \*\/ = \{([\s\S]*?)^\s*\};/gm);
  for (const match of targetBlocks) {
    const id = match[1]?.trim();
    const block = match[3] ?? "";
    if (!id) continue;
    if (!block.includes(`productType = "${IOS_APPLICATION_PRODUCT_TYPE}"`)) continue;
    const fallbackName = match[2]?.trim() ?? id;
    const targetName = normalizePbxName(readPbxAssignment(block, "name"), fallbackName);
    const productName = normalizePbxName(readPbxAssignment(block, "productName"), targetName);
    if (targetName) targets.push({ id, targetName, productName });
  }
  return targets;
}

function parseXmlAttributes(raw: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of raw.matchAll(/([A-Za-z_:][A-Za-z0-9_:.-]*)="([^"]*)"/g)) {
    attributes[match[1]] = match[2];
  }
  return attributes;
}

function readXcodeSchemeDefinitions(projectPath: string): XcodeSchemeDefinition[] {
  const schemeDirs = [
    path.join(projectPath, "xcshareddata", "xcschemes"),
  ];
  const xcuserdataDir = path.join(projectPath, "xcuserdata");
  try {
    for (const entry of fs.readdirSync(xcuserdataDir, { withFileTypes: true })) {
      if (entry.isDirectory()) schemeDirs.push(path.join(xcuserdataDir, entry.name, "xcschemes"));
    }
  } catch {
    // Shared schemes and target-name fallback cover normal projects.
  }

  const byName = new Map<string, XcodeSchemeDefinition>();
  for (const schemeDir of schemeDirs) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(schemeDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".xcscheme")) continue;
      const name = path.basename(entry.name, ".xcscheme");
      if (byName.has(name)) continue;
      const schemePath = path.join(schemeDir, entry.name);
      let text = "";
      try {
        text = fs.readFileSync(schemePath, "utf8");
      } catch {
        text = "";
      }
      const blueprintIdentifiers = new Set<string>();
      const blueprintNames = new Set<string>();
      const buildableNames = new Set<string>();
      for (const refMatch of text.matchAll(/<BuildableReference\b([^>]*)\/?>/g)) {
        const attrs = parseXmlAttributes(refMatch[1] ?? "");
        if (attrs.BlueprintIdentifier) blueprintIdentifiers.add(attrs.BlueprintIdentifier);
        if (attrs.BlueprintName) blueprintNames.add(attrs.BlueprintName);
        if (attrs.BuildableName) buildableNames.add(attrs.BuildableName);
      }
      byName.set(name, {
        name,
        blueprintIdentifiers: Array.from(blueprintIdentifiers),
        blueprintNames: Array.from(blueprintNames),
        buildableNames: Array.from(buildableNames),
      });
    }
  }
  return Array.from(byName.values());
}

function schemeMatchesApplicationTarget(scheme: XcodeSchemeDefinition, target: PbxApplicationTarget): boolean {
  if (scheme.blueprintIdentifiers.includes(target.id)) return true;
  if (scheme.blueprintNames.includes(target.targetName) || scheme.blueprintNames.includes(target.productName)) return true;
  if (scheme.buildableNames.includes(`${target.targetName}.app`) || scheme.buildableNames.includes(`${target.productName}.app`)) return true;
  return scheme.name === target.targetName || scheme.name === target.productName;
}

function schemesForApplicationTarget(projectPath: string, target: PbxApplicationTarget): string[] {
  const matchedSchemes = readXcodeSchemeDefinitions(projectPath)
    .filter((scheme) => schemeMatchesApplicationTarget(scheme, target))
    .map((scheme) => scheme.name);
  return matchedSchemes.length ? Array.from(new Set(matchedSchemes)) : [target.targetName];
}

async function discoverXcodeProjectPaths(projectRoot: string): Promise<string[]> {
  const projectPaths = new Set<string>();
  const addProjectPath = async (candidate: string) => {
    if (!candidate.endsWith(".xcodeproj")) return;
    try {
      const stat = await fs.promises.stat(candidate);
      if (!stat.isDirectory()) return;
      projectPaths.add(path.resolve(candidate));
    } catch {
      // Missing or unreadable projects are ignored during best-effort discovery.
    }
  };
  const scanDirectory = async (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(entries.map((entry) => addProjectPath(path.join(dir, entry.name))));
  };

  await addProjectPath(path.join(projectRoot, ADE_IOS_PROJECT));
  await scanDirectory(projectRoot);

  const appsRoot = path.join(projectRoot, "apps");
  await scanDirectory(appsRoot);
  let appEntries: fs.Dirent[];
  try {
    appEntries = await fs.promises.readdir(appsRoot, { withFileTypes: true });
  } catch {
    appEntries = [];
  }
  await Promise.all(appEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => scanDirectory(path.join(appsRoot, entry.name))));

  return Array.from(projectPaths);
}

function recoverStaleLaunchTarget(targetIdValue: string | null | undefined, targets: IosSimulatorLaunchTarget[]): IosSimulatorLaunchTarget | null {
  const parts = decodeTargetId(targetIdValue);
  if (parts[0] === "project" && parts[1]) {
    const matches = targets.filter((candidate) => candidate.kind === "project" && candidate.projectPath === parts[1]);
    if (matches.length === 1) return matches[0];
    const projectBasename = path.basename(parts[1]);
    const basenameMatches = targets.filter((candidate) => (
      candidate.kind === "project"
      && candidate.projectPath
      && path.basename(candidate.projectPath) === projectBasename
    ));
    return basenameMatches.length === 1 ? basenameMatches[0] : null;
  }
  if (parts[0] === "built" && parts[1]) {
    const matches = targets.filter((candidate) => candidate.kind === "built" && candidate.appBundlePath === parts[1]);
    return matches.length === 1 ? matches[0] : null;
  }
  if (parts[0] === "installed" && parts[2]) {
    return targets.find((candidate) => candidate.kind === "installed" && candidate.bundleId === parts[2]) ?? null;
  }
  return null;
}

export type IosSimulatorService = ReturnType<typeof createIosSimulatorService>;

export function createIosSimulatorService(args: CreateIosSimulatorServiceArgs) {
  let activeSession: IosSimulatorSession | null = null;
  let lastSelectedItem: IosElementContextItem | null = null;
  let companionProcess: ChildProcess | null = null;
  let companionDeviceUdid: string | null = null;
  let companionAddress: string | null = null;
  let companionReadyPromise: Promise<string> | null = null;
  let companionIdleTimer: NodeJS.Timeout | null = null;
  let streamRequestContext: Pick<IosSimulatorStreamStatus, "requestedBackend" | "fallbackReason" | "degradationReason"> = {
    requestedBackend: null,
    fallbackReason: null,
    degradationReason: null,
  };
  let controlQueue: Promise<void> = Promise.resolve();
  let activeLaunchId: string | null = null;
  let disposed = false;
  let xcodeMcpBridge: XcodeMcpBridge | null = null;
  const tempFiles = new Set<string>();
  const toolAvailabilityCache = new Map<string, { available: boolean; checkedAt: number }>();
  let cachedStatus: { value: IosSimulatorStatus; computedAt: number; inflight: Promise<IosSimulatorStatus> | null } = {
    value: {
      platform: process.platform,
      supported: false,
      tools: [],
      activeDevice: null,
      activeSession: null,
    },
    computedAt: 0,
    inflight: null,
  };
  let cachedDevices: { value: IosSimulatorDevice[]; computedAt: number; inflight: Promise<IosSimulatorDevice[]> | null } = {
    value: [],
    computedAt: 0,
    inflight: null,
  };
  let streamStatus: IosSimulatorStreamStatus = {
    deviceUdid: null,
    running: false,
    backend: null,
    fps: null,
    targetFps: null,
    frameCount: 0,
    startedAt: null,
    lastFrameAt: null,
    lastError: null,
    error: null,
    streamUrl: null,
    averageLatencyMs: null,
    latencyP50Ms: null,
    latencyP95Ms: null,
    helperPid: null,
    inputBackend: null,
  };

  void cleanupOrphanedIdbCompanions().then((stopped) => {
    if (stopped > 0) {
      args.logger.info("ios_simulator.cleaned_orphaned_idb_companions", { stopped });
    }
  }).catch((error) => {
    args.logger.debug("ios_simulator.orphaned_idb_companion_cleanup_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  });

  const emit = (payload: IosSimulatorEventPayload) => {
    args.onEvent?.(payload);
  };

  const cachedCommandExists = (command: string, ttlMs = TOOL_STATUS_CACHE_MS): boolean => {
    const nowMs = Date.now();
    const cached = toolAvailabilityCache.get(command);
    if (cached && nowMs - cached.checkedAt < ttlMs) return cached.available;
    const available = process.platform === "darwin" ? commandExistsProbe(command) : false;
    toolAvailabilityCache.set(command, { available, checkedAt: nowMs });
    return available;
  };

  const runSimctlWithTimeout = async (simctlArgs: string[], timeoutMs: number, timeoutMessage: string) => {
    try {
      await run("xcrun", ["simctl", ...simctlArgs], { timeoutMs });
    } catch (error) {
      if (isTerminatedByTimeout(error)) throw new Error(timeoutMessage);
      throw error;
    }
  };

  const waitForSimulatorBootStatus = (device: IosSimulatorDevice) =>
    runSimctlWithTimeout(
      ["bootstatus", device.udid, "-b"],
      SIMCTL_BOOTSTATUS_TIMEOUT_MS,
      `Simulator ${device.name} did not become ready within ${Math.round(SIMCTL_BOOTSTATUS_TIMEOUT_MS / 1000)}s. CoreSimulator may be stuck; shut down that simulator and launch again.`,
    );

  const installAppOnSimulator = (device: IosSimulatorDevice, appBundle: string) =>
    runSimctlWithTimeout(
      ["install", device.udid, appBundle],
      SIMCTL_INSTALL_TIMEOUT_MS,
      `Timed out installing the app on ${device.name} after ${Math.round(SIMCTL_INSTALL_TIMEOUT_MS / 1000)}s. CoreSimulator did not respond; shut down that simulator and launch again.`,
    );

  const trackTempFile = (filePath: string): string => {
    tempFiles.add(filePath);
    return filePath;
  };

  const releaseTempFile = (filePath: string) => {
    tempFiles.delete(filePath);
  };

  const cleanupTempFiles = () => {
    for (const filePath of [...tempFiles]) {
      tempFiles.delete(filePath);
      fs.promises.unlink(filePath).catch(() => {});
    }
  };

  const onXcodeMcpBridgeTerminated = (bridge: XcodeMcpBridge, reason: Error): void => {
    if (xcodeMcpBridge === bridge) xcodeMcpBridge = null;
    disposeXcodeMcpBridge(bridge, reason);
  };

  const getXcodeMcpBridge = (): XcodeMcpBridge => {
    if (xcodeMcpBridge && xcodeMcpBridge.child.exitCode == null && xcodeMcpBridge.child.signalCode == null) {
      return xcodeMcpBridge;
    }
    xcodeMcpBridge = createXcodeMcpBridge(onXcodeMcpBridgeTerminated);
    return xcodeMcpBridge;
  };

  const callXcodeMcpTool = async (toolName: string, toolArgs: Record<string, unknown>, timeoutMs: number): Promise<unknown> => {
    const bridge = getXcodeMcpBridge();
    await ensureXcodeMcpInitialized(bridge);
    return sendXcodeMcpRequest(bridge, "tools/call", {
      name: toolName,
      arguments: toolArgs,
    }, timeoutMs, `Xcode MCP ${toolName}`);
  };

  const resolveControlDeviceUdid = async (deviceUdid?: string | null): Promise<string> => {
    const udid = deviceUdid?.trim() || activeSession?.deviceUdid || streamStatus.deviceUdid;
    if (udid) return udid;
    return (await resolveDevice(null)).udid;
  };

  const enqueueControl = async <T>(action: string, runControl: () => Promise<T>): Promise<T> => {
    const queuedAt = Date.now();
    const task = controlQueue.then(async () => {
      const startedAt = Date.now();
      const queuedMs = startedAt - queuedAt;
      try {
        const result = await runControl();
        args.logger.debug("ios_simulator.control_completed", {
          action,
          queuedMs,
          durationMs: Date.now() - startedAt,
        });
        return result;
      } catch (error) {
        args.logger.debug("ios_simulator.control_failed", {
          action,
          queuedMs,
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    });
    controlQueue = task.then(() => undefined, () => undefined);
    return task;
  };

  const emitLaunchProgress = (
    launchId: string,
    step: IosSimulatorLaunchStepId,
    status: IosSimulatorLaunchStepStatus,
    message: string,
    detail?: string | null,
    extra: Partial<Pick<IosSimulatorLaunchProgress, "deviceUdid" | "targetId">> = {},
  ): IosSimulatorLaunchProgress => {
    const progress: IosSimulatorLaunchProgress = {
      launchId,
      step,
      status,
      message,
      detail: detail ?? null,
      deviceUdid: extra.deviceUdid ?? null,
      targetId: extra.targetId ?? null,
      updatedAt: nowIso(),
    };
    emit({ type: "launch-progress", progress });
    return progress;
  };

  const resolveProjectRoot = (projectRoot?: string | null): string => {
    const raw = projectRoot?.trim();
    const resolved = raw
      ? path.resolve(raw)
      : path.resolve(args.projectRoot);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Project root ${resolved} does not exist.`);
    }
    return resolved;
  };

  const setStreamStopped = (error: string | null = null): IosSimulatorStreamStatus => {
    streamStatus = {
      ...streamStatus,
      running: false,
      backend: null,
      requestedBackend: null,
      fallbackReason: null,
      degradationReason: null,
      fps: null,
      targetFps: null,
      lastError: error,
      error: error ? { code: "stream-stopped", exitCode: null, signal: null } : null,
      streamUrl: null,
      averageLatencyMs: null,
      latencyP50Ms: null,
      latencyP95Ms: null,
      helperPid: null,
      inputBackend: null,
    };
    return streamStatus;
  };

  const stopChild = (child: ChildProcess | null) => {
    if (!child) return;
    child.removeAllListeners();
    child.stdout?.removeAllListeners();
    child.stderr?.removeAllListeners();
    child.stdin?.removeAllListeners();
    if (child.exitCode == null && child.signalCode == null) {
      child.kill("SIGTERM");
      const killTimer = setTimeout(() => {
        if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
      }, 2_000);
      killTimer.unref?.();
    }
  };

  const stopCompanion = () => {
    if (companionIdleTimer) {
      clearTimeout(companionIdleTimer);
      companionIdleTimer = null;
    }
    stopChild(companionProcess);
    companionProcess = null;
    companionDeviceUdid = null;
    companionAddress = null;
    companionReadyPromise = null;
  };

  const scheduleCompanionIdleStop = () => {
    if (streamStatus.running) return;
    if (companionIdleTimer) clearTimeout(companionIdleTimer);
    companionIdleTimer = setTimeout(() => {
      if (!streamStatus.running) stopCompanion();
    }, COMPANION_IDLE_STOP_MS);
    companionIdleTimer.unref?.();
  };

  const ensureCompanion = async (deviceUdid: string): Promise<string> => {
    if (disposed) {
      throw new Error("iOS simulator service has been disposed.");
    }
    if (companionIdleTimer) {
      clearTimeout(companionIdleTimer);
      companionIdleTimer = null;
    }
    if (companionProcess && companionDeviceUdid === deviceUdid && companionAddress) {
      return companionReadyPromise ?? companionAddress;
    }
    if (!cachedCommandExists("idb_companion")) {
      throw new Error(`idb_companion is required for simulator accessibility and input. ${INSTALL_HINT_IDB_COMPANION}`);
    }
    const stopped = await cleanupOrphanedIdbCompanions(deviceUdid);
    if (stopped > 0) {
      args.logger.info("ios_simulator.cleaned_orphaned_idb_companions", { deviceUdid, stopped });
    }
    if (disposed) {
      throw new Error("iOS simulator service has been disposed.");
    }
    stopCompanion();
    const port = await getFreePort();
    if (disposed) {
      throw new Error("iOS simulator service has been disposed.");
    }
    const address = `127.0.0.1:${port}`;
    let stderr = "";
    const process = spawnProcess("idb_companion", [
      "--udid",
      deviceUdid,
      "--grpc-port",
      String(port),
      "--log-level",
      "info",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    companionProcess = process;
    companionDeviceUdid = deviceUdid;
    companionAddress = address;
    process.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-4000);
    });
    process.stdout?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-4000);
    });
    // Always attach an `error` listener so spawn failures (e.g. ENOENT when
    // idb_companion is not installed on CI) surface as a normal stream-error
    // instead of becoming an unhandled exception that fails the test runner.
    process.once("error", (error) => {
      if (companionProcess !== process) return;
      companionProcess = null;
      companionDeviceUdid = null;
      companionAddress = null;
      companionReadyPromise = null;
      const detail = error instanceof Error ? error.message : String(error);
      args.logger.debug("ios_simulator.idb_companion_spawn_failed", { deviceUdid, error: detail });
      if (streamStatus.running) {
        const status = setStreamStopped(stderr.trim() || detail);
        emit({ type: "stream-error", status });
      }
    });
    process.once("exit", (code) => {
      if (companionProcess !== process) return;
      companionProcess = null;
      companionDeviceUdid = null;
      companionAddress = null;
      companionReadyPromise = null;
      if (streamStatus.running) {
        const status = setStreamStopped(stderr.trim() || `idb_companion exited with code ${code ?? "unknown"}.`);
        emit({ type: "stream-error", status });
      }
    });
    companionReadyPromise = waitForTcpPort("127.0.0.1", port, 2_500).then(() => {
      if (companionProcess !== process || process.exitCode !== null) {
        throw new Error(stderr.trim() || "idb_companion failed to start.");
      }
      return address;
    }).finally(() => {
      if (companionProcess === process) companionReadyPromise = null;
    });
    return companionReadyPromise;
  };

  const computeListDevices = async (): Promise<IosSimulatorDevice[]> => {
    if (process.platform !== "darwin" || !cachedCommandExists("xcrun")) return [];
    const { stdout } = await run("xcrun", ["simctl", "list", "devices", "available", "--json"]);
    const parsed = JSON.parse(stdout) as SimctlListDevicesJson;
    const devices: IosSimulatorDevice[] = [];
    for (const [runtime, runtimeDevices] of Object.entries(parsed.devices ?? {})) {
      for (const device of runtimeDevices ?? []) {
        if (!device.udid || !device.name) continue;
        if (device.isAvailable === false || device.availabilityError) continue;
        devices.push({
          udid: device.udid,
          name: device.name,
          runtime: normalizeRuntimeName(runtime),
          state: device.state ?? "Unknown",
          isAvailable: true,
        });
      }
    }
    return devices.sort((a, b) => {
      if (a.state === "Booted" && b.state !== "Booted") return -1;
      if (b.state === "Booted" && a.state !== "Booted") return 1;
      return a.name.localeCompare(b.name);
    });
  };

  const listDevices = async (): Promise<IosSimulatorDevice[]> => {
    const nowMs = Date.now();
    if (cachedDevices.inflight) return cachedDevices.inflight;
    if (nowMs - cachedDevices.computedAt < DEVICE_LIST_THROTTLE_MS && cachedDevices.computedAt !== 0) {
      return cachedDevices.value;
    }
    const inflight = computeListDevices()
      .then((value) => {
        cachedDevices = { value, computedAt: Date.now(), inflight: null };
        return value;
      })
      .catch((error) => {
        cachedDevices = { ...cachedDevices, inflight: null };
        throw error;
      });
    cachedDevices = { ...cachedDevices, inflight };
    return inflight;
  };

  const listProjectLaunchTargets = async (projectRoot: string): Promise<IosSimulatorLaunchTarget[]> => {
    const projectPaths = await discoverXcodeProjectPaths(projectRoot);

    const targets: IosSimulatorLaunchTarget[] = [];
    for (const projectPath of projectPaths) {
      const appTargets = parseApplicationTargetsFromPbxproj(projectPath);
      for (const appTarget of appTargets) {
        const relativeProject = relativeToRoot(projectRoot, projectPath);
        for (const scheme of schemesForApplicationTarget(projectPath, appTarget)) {
          const bundleId = scheme === ADE_IOS_SCHEME && relativeProject === ADE_IOS_PROJECT
            ? ADE_IOS_BUNDLE_ID
            : null;
          targets.push({
            // appTarget.id is the PBXNativeTarget id — including it in the
            // target id keeps two app targets that share a scheme (or a scheme
            // whose name differs from the produced `.app`) from collapsing
            // onto the same id and confusing findAppBundle().
            id: targetId(["project", relativeProject, scheme, appTarget.id]),
            kind: "project",
            name: appTarget.productName || appTarget.targetName || scheme,
            bundleId,
            detail: scheme === appTarget.targetName
              ? `${scheme} · ${relativeProject}`
              : `${scheme} · ${relativeProject} · target ${appTarget.targetName}`,
            projectPath: relativeProject,
            scheme,
            productName: appTarget.productName || appTarget.targetName || null,
            appTargetId: appTarget.id,
            appBundlePath: null,
            installed: false,
            canBuild: true,
            canLaunch: true,
            source: "xcode-project",
          });
        }
      }
    }
    return targets;
  };

  const listBuiltLaunchTargets = async (projectRoot: string): Promise<IosSimulatorLaunchTarget[]> => {
    const derivedDataPath = path.join(projectRoot, ".ade", "cache", "ios-simulator", "DerivedData");
    const productRoot = path.join(derivedDataPath, "Build", "Products", "Debug-iphonesimulator");
    const appBundles = await findAppBundles(productRoot);
    const targets: IosSimulatorLaunchTarget[] = [];
    for (const appBundle of appBundles) {
      const infoPlist = path.join(appBundle, "Info.plist");
      const bundleId = await readPlistValue(infoPlist, "CFBundleIdentifier");
      if (!bundleId) continue;
      const displayName = await readPlistValue(infoPlist, "CFBundleDisplayName")
        ?? await readPlistValue(infoPlist, "CFBundleName")
        ?? path.basename(appBundle, ".app");
      targets.push({
        id: targetId(["built", appBundle, bundleId]),
        kind: "built",
        name: displayName,
        bundleId,
        detail: `${bundleId} · ${relativeToRoot(projectRoot, appBundle)}`,
        projectPath: null,
        scheme: null,
        productName: path.basename(appBundle, ".app") || null,
        appTargetId: null,
        appBundlePath: appBundle,
        installed: false,
        canBuild: false,
        canLaunch: true,
        source: "derived-data",
      });
    }
    return targets;
  };

  const listInstalledLaunchTargets = async (deviceUdid?: string | null): Promise<IosSimulatorLaunchTarget[]> => {
    if (!deviceUdid || !cachedCommandExists("xcrun")) return [];
    let stdout = "";
    try {
      ({ stdout } = await run("xcrun", ["simctl", "listapps", deviceUdid], { timeoutMs: 20_000 }));
    } catch {
      return [];
    }
    const targets: IosSimulatorLaunchTarget[] = [];
    const entries = stdout.matchAll(/"([^"]+)"\s*=\s*\{([\s\S]*?)\n\s*\};/g);
    for (const match of entries) {
      const bundleId = match[1];
      const body = match[2] ?? "";
      if (!bundleId || bundleId.startsWith("com.apple.")) continue;
      const name =
        /CFBundleDisplayName\s*=\s*"([^"]+)";/.exec(body)?.[1]
        ?? /CFBundleName\s*=\s*"([^"]+)";/.exec(body)?.[1]
        ?? bundleId;
      targets.push({
        id: targetId(["installed", deviceUdid, bundleId]),
        kind: "installed",
        name,
        bundleId,
        detail: `${bundleId} · installed on selected simulator`,
        projectPath: null,
        scheme: null,
        productName: null,
        appTargetId: null,
        appBundlePath: null,
        installed: true,
        canBuild: false,
        canLaunch: true,
        source: "simctl-listapps",
      });
    }
    return targets;
  };

  const listLaunchTargets = async (targetArgs: IosSimulatorListLaunchTargetsArgs = {}): Promise<IosSimulatorLaunchTarget[]> => {
    const projectRoot = resolveProjectRoot(targetArgs.projectRoot);
    const [projectTargets, builtTargets, installedTargets] = await Promise.all([
      listProjectLaunchTargets(projectRoot),
      listBuiltLaunchTargets(projectRoot),
      listInstalledLaunchTargets(targetArgs.deviceUdid ?? activeSession?.deviceUdid),
    ]);
    const byKey = new Map<string, IosSimulatorLaunchTarget>();
    const priority = { project: 0, built: 1, installed: 2 } satisfies Record<IosSimulatorLaunchTarget["kind"], number>;
    for (const target of [...projectTargets, ...builtTargets, ...installedTargets]) {
      const key = target.bundleId ?? target.id;
      const existing = byKey.get(key);
      if (!existing || priority[target.kind] < priority[existing.kind]) byKey.set(key, target);
    }
    return Array.from(byKey.values()).sort((a, b) => {
      if (a.kind === "project" && b.kind !== "project") return -1;
      if (b.kind === "project" && a.kind !== "project") return 1;
      return a.name.localeCompare(b.name);
    });
  };

  const resolveDevice = async (deviceUdid?: string | null): Promise<IosSimulatorDevice> => {
    const devices = await listDevices();
    if (deviceUdid) {
      const exact = devices.find((device) => device.udid === deviceUdid);
      if (exact) return exact;
      throw new Error(`Simulator device ${deviceUdid} is not available.`);
    }
    const ranked = [...devices].sort((a, b) => {
      if (a.state === "Booted" && b.state !== "Booted") return -1;
      if (b.state === "Booted" && a.state !== "Booted") return 1;
      const aIphone = /iphone/i.test(a.name) ? 1 : 0;
      const bIphone = /iphone/i.test(b.name) ? 1 : 0;
      if (aIphone !== bIphone) return bIphone - aIphone;
      const versionDelta = runtimeVersionScore(b.runtime) - runtimeVersionScore(a.runtime);
      if (versionDelta !== 0) return versionDelta;
      return a.name.localeCompare(b.name);
    });
    const fallback = ranked[0];
    if (!fallback) throw new Error("No available iOS Simulator devices were found.");
    return fallback;
  };

  const buildToolStatuses = (): IosSimulatorToolStatus[] => {
    const isDarwin = process.platform === "darwin";
    const xcrunAvailable = isDarwin && cachedCommandExists("xcrun");
    const xcodebuildAvailable = isDarwin && cachedCommandExists("xcodebuild");
    const idbAvailable = isDarwin && cachedCommandExists("idb");
    const idbCompanionAvailable = isDarwin && cachedCommandExists("idb_companion");
    return [
      {
        name: "xcrun",
        available: xcrunAvailable,
        detail: xcrunAvailable
          ? "Available for simulator boot, install, launch, screenshots, and built-in snapshot preview."
          : isDarwin
            ? "Xcode command line tools are not on PATH."
            : "Only available on macOS.",
        installHint: isDarwin ? INSTALL_HINT_XCODE_CLI : "iOS Simulator control requires macOS.",
      },
      {
        name: "xcodebuild",
        available: xcodebuildAvailable,
        detail: xcodebuildAvailable
          ? "Available for building iOS apps."
          : isDarwin
            ? "Install Xcode to build iOS apps."
            : "Only available on macOS.",
        installHint: isDarwin ? INSTALL_HINT_XCODE : "iOS Simulator control requires macOS.",
      },
      {
        name: "simulator_window",
        available: isDarwin,
        detail: isDarwin
          ? "Available for ADE's live Simulator.app window stream."
          : "Simulator window mirroring is only available on macOS.",
        installHint: isDarwin ? "" : "iOS Simulator control requires macOS.",
      },
      {
        name: "idb",
        available: idbAvailable,
        detail: idbAvailable
          ? "Available for accessibility reads and pointer/text control."
          : "Optional. Required for accessibility reads and pointer/text control.",
        installHint: INSTALL_HINT_IDB,
      },
      {
        name: "idb_companion",
        available: idbCompanionAvailable,
        detail: idbCompanionAvailable
          ? "Available for idb simulator connections."
          : "Optional. Required for idb control.",
        installHint: INSTALL_HINT_IDB_COMPANION,
      },
    ];
  };

  const computeStatus = async (): Promise<IosSimulatorStatus> => {
    const isDarwin = process.platform === "darwin";
    const tools = buildToolStatuses();
    const devices = isDarwin ? await listDevices().catch(() => []) : [];
    const activeDevice = activeSession
      ? devices.find((device) => device.udid === activeSession?.deviceUdid) ?? null
      : devices.find((device) => device.state === "Booted" && /iphone/i.test(device.name)) ?? null;
    if (isDarwin && !companionProcess && !disposed) {
      const stopped = await cleanupOrphanedIdbCompanions(activeDevice?.udid ?? null).catch(() => 0);
      if (stopped > 0) {
        args.logger.info("ios_simulator.cleaned_orphaned_idb_companions", {
          deviceUdid: activeDevice?.udid ?? null,
          stopped,
        });
      }
    }
    const xcrunAvailable = tools.find((tool) => tool.name === "xcrun")?.available ?? false;
    const xcodebuildAvailable = tools.find((tool) => tool.name === "xcodebuild")?.available ?? false;
    return {
      platform: process.platform,
      supported: isDarwin && xcrunAvailable && xcodebuildAvailable,
      tools,
      activeDevice,
      activeSession,
    };
  };

  const getStatus = async (): Promise<IosSimulatorStatus> => {
    const nowMs = Date.now();
    if (cachedStatus.inflight) return cachedStatus.inflight;
    if (nowMs - cachedStatus.computedAt < STATUS_THROTTLE_MS && cachedStatus.computedAt !== 0) {
      return {
        ...cachedStatus.value,
        activeSession,
      };
    }
    const inflight = computeStatus()
      .then((value) => {
        cachedStatus = { value, computedAt: Date.now(), inflight: null };
        return value;
      })
      .catch((error) => {
        cachedStatus = { ...cachedStatus, inflight: null };
        throw error;
      });
    cachedStatus = { ...cachedStatus, inflight };
    return inflight;
  };

  const isXcodeRunning = async (): Promise<boolean> => {
    if (process.platform !== "darwin") return false;
    try {
      const { stdout } = await run("pgrep", ["-x", "Xcode"], { timeoutMs: 3_000 });
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  };

  const findMcpbridge = async (): Promise<boolean> => {
    if (process.platform !== "darwin" || !cachedCommandExists("xcrun")) return false;
    try {
      const { stdout } = await run("xcrun", ["--find", "mcpbridge"], { timeoutMs: 5_000 });
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  };

  const readXcodeVersion = async (): Promise<string | null> => {
    if (process.platform !== "darwin" || !cachedCommandExists("xcodebuild")) return null;
    try {
      const { stdout } = await run("xcodebuild", ["-version"], { timeoutMs: 5_000 });
      return stdout.trim().replace(/\n/g, " · ") || null;
    } catch {
      return null;
    }
  };

  const listXcodePreviewWindows = async (projectRoot: string): Promise<IosSimulatorPreviewWindow[]> => {
    const result = await callXcodeMcpTool("XcodeListWindows", {}, XCODE_MCP_APPROVAL_TIMEOUT_MS);
    const object = objectFromMcpResult(result);
    const message = typeof object.message === "string" ? object.message : textFromMcpResult(result);
    return parseXcodePreviewWindows(message, projectRoot).filter((window) => window.tabIdentifier);
  };

  const pickPreviewWindow = (windows: IosSimulatorPreviewWindow[], projectRoot: string): IosSimulatorPreviewWindow | null => {
    if (!windows.length) return null;
    const iosRoot = path.join(projectRoot, "apps", "ios");
    return [...windows]
      .map((window) => {
        const raw = `${window.workspacePath ?? ""}\n${window.raw}`.toLowerCase();
        let score = 0;
        if (raw.includes(projectRoot.toLowerCase())) score += 100;
        if (raw.includes(iosRoot.toLowerCase())) score += 80;
        if (raw.includes("ade.xcodeproj") || raw.includes("ade.xcworkspace")) score += 60;
        if (raw.includes("ade")) score += 20;
        return { window, score };
      })
      .sort((a, b) => b.score - a.score)[0]?.window ?? windows[0] ?? null;
  };

  const getPreviewCapability = async (previewArgs: IosSimulatorListPreviewsArgs = {}): Promise<IosSimulatorPreviewCapability> => {
    const projectRoot = resolveProjectRoot(previewArgs.projectRoot);
    const [xcodeVersion, mcpbridgeAvailable, xcodeRunning] = await Promise.all([
      readXcodeVersion(),
      findMcpbridge(),
      isXcodeRunning(),
    ]);
    let windows: IosSimulatorPreviewWindow[] = [];
    let error: string | null = null;
    if (mcpbridgeAvailable && xcodeRunning) {
      try {
        windows = await listXcodePreviewWindows(projectRoot);
      } catch (failure) {
        error = failure instanceof Error ? failure.message : String(failure);
      }
    }
    const selectedWindow = pickPreviewWindow(windows, projectRoot);
    const setupSteps: string[] = [];
    if (process.platform !== "darwin") setupSteps.push("Use macOS for Xcode Preview rendering.");
    if (!xcodeVersion) setupSteps.push("Install Xcode 26.3 or newer.");
    if (!mcpbridgeAvailable) setupSteps.push("Install or select an Xcode that provides `xcrun mcpbridge`.");
    if (!xcodeRunning) setupSteps.push("Open apps/ios/ADE.xcodeproj in Xcode before rendering previews.");
    if (error) setupSteps.push("If Xcode shows an \"Allow\" prompt for ADE Preview Lab, click Allow and keep ADE open until the retry finishes.");
    if (error) setupSteps.push("If no prompt appears, open Xcode > Settings > Intelligence and enable \"Allow external agents to use Xcode tools\" under Model Context Protocol.");
    if (xcodeRunning && !error && !selectedWindow) setupSteps.push("Bring the Xcode window for apps/ios/ADE.xcodeproj forward, then retry.");
    return {
      platform: process.platform,
      supported: process.platform === "darwin" && Boolean(xcodeVersion) && mcpbridgeAvailable && xcodeRunning && Boolean(selectedWindow) && !error,
      docsUrl: XCODE_MCP_DOCS_URL,
      xcodeVersion,
      mcpbridgeAvailable,
      xcodeRunning,
      xcodeWindows: windows,
      selectedWindow,
      setupSteps,
      error,
      checkedAt: nowIso(),
    };
  };

  const listPreviewTargets = async (previewArgs: IosSimulatorListPreviewsArgs = {}): Promise<IosSimulatorPreviewTarget[]> => {
    const projectRoot = resolveProjectRoot(previewArgs.projectRoot);
    const selectedFile = resolveSwiftSourceFile(projectRoot, previewArgs.sourceFile);
    const swiftFiles = collectSwiftFiles(projectRoot);
    const filesWithPreviews = swiftFiles
      .map((filePath) => {
        let text = "";
        try {
          text = fs.readFileSync(filePath, "utf8");
        } catch {
          return null;
        }
        const definitions = parseSwiftPreviewDefinitions(text);
        return definitions.length ? { filePath, definitions } : null;
      })
      .filter((entry): entry is { filePath: string; definitions: SwiftPreviewDefinition[] } => Boolean(entry));
    const scoreFile = (filePath: string): number => {
      if (!selectedFile) return 0;
      if (path.resolve(filePath) === path.resolve(selectedFile)) return 1000;
      const selectedDir = path.dirname(selectedFile);
      const selectedBase = path.basename(selectedFile, ".swift").replace(/View$/, "");
      let score = 0;
      if (path.dirname(filePath) === selectedDir) score += 200;
      if (path.basename(filePath).toLowerCase().includes("preview")) score += 80;
      if (path.basename(filePath).toLowerCase().includes(selectedBase.toLowerCase())) score += 120;
      const selectedParts = selectedDir.split(path.sep);
      const fileParts = path.dirname(filePath).split(path.sep);
      if (selectedParts.some((part) => part && fileParts.includes(part) && /Views|Work|Lanes|PRs|Files|Cto/i.test(part))) score += 40;
      return score;
    };
    return filesWithPreviews
      .sort((a, b) => scoreFile(b.filePath) - scoreFile(a.filePath) || a.filePath.localeCompare(b.filePath))
      .flatMap(({ filePath, definitions }) => {
        const proximity = previewProximity(projectRoot, filePath, selectedFile);
        return definitions.map((definition) => {
          const sourceFile = relativeToRoot(projectRoot, filePath);
          const sourceFilePath = sourceFilePathForXcode(projectRoot, filePath);
          return {
            id: targetId(["preview", sourceFilePath, String(definition.index)]),
            title: definition.title,
            sourceFile,
            sourceFilePath,
            absoluteSourceFile: filePath,
            sourceLine: definition.line,
            previewDefinitionIndexInFile: definition.index,
            kind: definition.kind,
            proximity,
          };
        });
      })
      .slice(0, 50);
  };

  const renderPreview = async (renderArgs: IosSimulatorRenderPreviewArgs): Promise<IosSimulatorRenderPreviewResult> => {
    const projectRoot = resolveProjectRoot(renderArgs.projectRoot);
    const previewDefinitionIndexInFile = Math.max(0, Math.round(Number(renderArgs.previewDefinitionIndexInFile ?? 0)));
    const rawSourceFilePath = typeof renderArgs.sourceFilePath === "string" ? renderArgs.sourceFilePath.trim() : "";
    if (!rawSourceFilePath) {
      throw new Error("Xcode Preview rendering requires sourceFilePath. Run `ade ios-sim previews --source <swift-file> --text` to find a renderable preview, then pass that file to `ade ios-sim preview-render --source <swift-file>`.");
    }
    const resolvedSourceFile = resolveSwiftSourceFile(projectRoot, rawSourceFilePath);
    if (!resolvedSourceFile) {
      throw new Error(`Swift source file was not found: ${rawSourceFilePath}. Run \`ade --socket ios-sim snapshot --text\` to confirm the current simulator screen, then \`ade --socket ios-sim previews --source <swift-file> --text\` with a real Swift file before running \`ade --socket ios-sim preview-render --source <swift-file> --text\`.`);
    }
    const sourceFilePath = sourceFilePathForXcode(projectRoot, resolvedSourceFile);
    const capability = await getPreviewCapability({ projectRoot });
    const selectedWindow = renderArgs.tabIdentifier
      ? capability.xcodeWindows.find((window) => window.tabIdentifier === renderArgs.tabIdentifier) ?? null
      : capability.selectedWindow;
    const target = {
      sourceFilePath,
      previewDefinitionIndexInFile,
      tabIdentifier: selectedWindow?.tabIdentifier ?? renderArgs.tabIdentifier ?? null,
    };
    if (!capability.supported || !target.tabIdentifier) {
      return {
        ok: false,
        target,
        previewSnapshotPath: null,
        dataUrl: null,
        width: null,
        height: null,
        renderedAt: nowIso(),
        capability,
        error: capability.error ?? capability.setupSteps[0] ?? "Xcode Preview rendering is not ready.",
      };
    }

    try {
      const timeoutSec = Math.max(5, Math.min(240, Math.round(Number(renderArgs.timeoutSec ?? 120))));
      const result = await callXcodeMcpTool("RenderPreview", {
        tabIdentifier: target.tabIdentifier,
        sourceFilePath: target.sourceFilePath,
        previewDefinitionIndexInFile,
        timeout: timeoutSec,
      }, (timeoutSec + 5) * 1000);
      const object = objectFromMcpResult(result);
      const errorMessage = isRecord(object.error) && typeof object.error.message === "string"
        ? object.error.message
        : null;
      const previewSnapshotPath = typeof object.previewSnapshotPath === "string"
        ? object.previewSnapshotPath
        : /previewSnapshotPath["\s:=]+([^"\n,}]+)/.exec(textFromMcpResult(result))?.[1]?.trim() ?? null;
      if (errorMessage || !previewSnapshotPath) {
        return {
          ok: false,
          target,
          previewSnapshotPath: previewSnapshotPath ?? null,
          dataUrl: null,
          width: null,
          height: null,
          renderedAt: nowIso(),
          capability,
          error: errorMessage ?? "Xcode did not return a preview image.",
        };
      }
      const buffer = await fs.promises.readFile(previewSnapshotPath);
      const dimensions = pngDimensions(buffer);
      return {
        ok: true,
        target,
        previewSnapshotPath,
        dataUrl: `data:image/png;base64,${buffer.toString("base64")}`,
        width: dimensions.width,
        height: dimensions.height,
        renderedAt: nowIso(),
        capability,
        error: null,
      };
    } catch (failure) {
      return {
        ok: false,
        target,
        previewSnapshotPath: null,
        dataUrl: null,
        width: null,
        height: null,
        renderedAt: nowIso(),
        capability,
        error: failure instanceof Error ? failure.message : String(failure),
      };
    }
  };

  const openPreviewWorkspace = async (openArgs: IosSimulatorOpenPreviewWorkspaceArgs = {}): Promise<{ ok: true; path: string }> => {
    const projectRoot = resolveProjectRoot(openArgs.projectRoot);
    const projectPath = path.join(projectRoot, ADE_IOS_PROJECT);
    const openPath = fs.existsSync(projectPath) ? projectPath : path.join(projectRoot, "apps", "ios");
    if (process.platform !== "darwin") throw new Error("Xcode preview setup is only available on macOS.");
    spawnProcess("open", ["-a", "Xcode", openPath], { detached: true, stdio: "ignore" }).unref();
    return { ok: true, path: openPath };
  };

  const resolveLaunchTarget = async (launchArgs: IosSimulatorLaunchArgs, deviceUdid: string, projectRoot: string): Promise<ResolvedLaunchTarget> => {
    const targets = await listLaunchTargets({ deviceUdid, projectRoot });
    const explicitAppBundle = launchArgs.appBundlePath
      ? path.isAbsolute(launchArgs.appBundlePath)
        ? launchArgs.appBundlePath
        : path.join(projectRoot, launchArgs.appBundlePath)
      : null;
    let target: IosSimulatorLaunchTarget | null = null;

    if (launchArgs.targetId) {
      target = targets.find((candidate) => candidate.id === launchArgs.targetId) ?? null;
      target ??= recoverStaleLaunchTarget(launchArgs.targetId, targets);
      if (!target) throw new Error(`Launch target ${launchArgs.targetId} was not found. Refresh launchable iOS apps and try again.`);
    }
    if (!target && launchArgs.bundleId) {
      target = targets.find((candidate) => candidate.bundleId === launchArgs.bundleId) ?? null;
    }
    if (!target && explicitAppBundle) {
      const bundleId = await readPlistValue(path.join(explicitAppBundle, "Info.plist"), "CFBundleIdentifier");
      const displayName = await readPlistValue(path.join(explicitAppBundle, "Info.plist"), "CFBundleDisplayName")
        ?? await readPlistValue(path.join(explicitAppBundle, "Info.plist"), "CFBundleName")
        ?? path.basename(explicitAppBundle, ".app");
      target = {
        id: targetId(["built", explicitAppBundle, bundleId]),
        kind: "built",
        name: displayName,
        bundleId: bundleId ?? launchArgs.bundleId ?? null,
        detail: `${bundleId ?? "unknown bundle"} · ${relativeToRoot(projectRoot, explicitAppBundle)}`,
        projectPath: null,
        scheme: null,
        productName: path.basename(explicitAppBundle, ".app") || null,
        appTargetId: null,
        appBundlePath: explicitAppBundle,
        installed: false,
        canBuild: false,
        canLaunch: true,
        source: "derived-data",
      };
    }
    if (!target && (launchArgs.projectPath || launchArgs.scheme)) {
      const projectPath = normalizeProjectPath(projectRoot, launchArgs.projectPath ?? ADE_IOS_PROJECT);
      if (!projectPath) {
        throw new Error(`iOS project ${launchArgs.projectPath ?? ADE_IOS_PROJECT} was not found.`);
      }
      const relativeProject = relativeToRoot(projectRoot, projectPath);
      const scheme = launchArgs.scheme ?? ADE_IOS_SCHEME;
      target = {
        id: targetId(["project", relativeProject, scheme]),
        kind: "project",
        name: scheme,
        bundleId: relativeProject === ADE_IOS_PROJECT && scheme === ADE_IOS_SCHEME ? ADE_IOS_BUNDLE_ID : launchArgs.bundleId ?? null,
        detail: `${scheme} · ${relativeProject}`,
        projectPath: relativeProject,
        scheme,
        // Synthesized fallback target — caller didn't reference a discovered
        // PBX target, so we have no productName/appTargetId. findAppBundle
        // falls back to scheme/ADE.app, which is safe for the synthesized path.
        productName: null,
        appTargetId: null,
        appBundlePath: null,
        installed: false,
        canBuild: true,
        canLaunch: true,
        source: "xcode-project",
      };
    }
    target ??= targets.find((candidate) => candidate.kind === "project" && candidate.projectPath === ADE_IOS_PROJECT && candidate.scheme === ADE_IOS_SCHEME)
      ?? targets.find((candidate) => candidate.kind === "project")
      ?? targets[0]
      ?? null;
    if (!target) {
      throw new Error("No launchable iOS apps were found. Add a buildable application target to a root-level .xcodeproj or apps/*/*.xcodeproj project, or provide --app-bundle/--bundle-id.");
    }

    const projectPath = normalizeProjectPath(projectRoot, target.projectPath);
    const appBundlePath = target.appBundlePath
      ? path.isAbsolute(target.appBundlePath)
        ? target.appBundlePath
        : path.join(projectRoot, target.appBundlePath)
      : explicitAppBundle;
    return {
      target,
      projectPath,
      scheme: target.scheme ?? launchArgs.scheme ?? null,
      bundleId: launchArgs.bundleId ?? target.bundleId,
      appBundlePath,
      shouldBuild: target.kind === "project" && launchArgs.build !== false,
      shouldInstall: target.kind !== "installed",
    };
  };

  const buildProjectApp = async (target: ResolvedLaunchTarget, device: IosSimulatorDevice, projectRoot: string): Promise<string | null> => {
    const derivedDataPath = path.join(projectRoot, ".ade", "cache", "ios-simulator", "DerivedData");
    if (!target.projectPath || !target.scheme) {
      return target.appBundlePath;
    }
    if (target.shouldBuild) {
      const relativeProjectPath = relativeToRoot(projectRoot, target.projectPath);
      await fs.promises.mkdir(derivedDataPath, { recursive: true });
      args.logger.info("ios_simulator.build.start", {
        projectRoot,
        projectPath: relativeProjectPath,
        scheme: target.scheme,
        deviceUdid: device.udid,
        derivedDataPath,
      });
      try {
        await run("xcodebuild", [
          "-project",
          relativeProjectPath,
          "-scheme",
          target.scheme,
          "-configuration",
          "Debug",
          "-sdk",
          "iphonesimulator",
          "-destination",
          `platform=iOS Simulator,id=${device.udid}`,
          "-derivedDataPath",
          derivedDataPath,
          "build",
        ], { cwd: projectRoot, timeoutMs: 10 * 60_000 });
      } catch (error) {
        const formatted = formatXcodeBuildFailure(error, {
          projectPath: relativeProjectPath,
          scheme: target.scheme,
          deviceName: device.name,
        });
        args.logger.warn("ios_simulator.build.failed", {
          projectPath: relativeProjectPath,
          scheme: target.scheme,
          deviceUdid: device.udid,
          error: formatted.message,
        });
        throw formatted;
      }
      args.logger.info("ios_simulator.build.complete", { projectPath: relativeProjectPath, scheme: target.scheme, derivedDataPath });
    }
    return findAppBundle(derivedDataPath, {
      bundleId: target.bundleId,
      scheme: target.scheme,
      // productName lives on the underlying launch target (ResolvedLaunchTarget
      // wraps IosSimulatorLaunchTarget). Prefer it over scheme so a project
      // whose scheme builds multiple .app bundles, or whose scheme name
      // differs from the produced .app, still resolves to the right bundle.
      productName: target.target.productName,
      appBundlePath: target.appBundlePath,
    });
  };

  const attachToChatSession = (chatSessionId: string | null, callerChatSessionId: string | null = chatSessionId): IosSimulatorSession | null => {
    if (!activeSession) return null;
    // Ownership check applies symmetrically: callers passing null to detach
    // must still be the current owner, otherwise an unrelated chat could free
    // another chat's simulator binding. The caller's own chat id is supplied
    // via callerChatSessionId; for attach calls it is the same as the new
    // chatSessionId, for detach calls (chatSessionId === null) it identifies
    // the chat requesting the detach.
    if (
      activeSession.chatSessionId
      && callerChatSessionId
      && activeSession.chatSessionId !== callerChatSessionId
    ) {
      throw new IosSimulatorOwnedBySessionError(activeSession);
    }
    if (activeSession.chatSessionId === chatSessionId) return activeSession;
    activeSession = { ...activeSession, chatSessionId };
    emit({ type: "session-updated", session: activeSession });
    return activeSession;
  };

  const claim = async (claimArgs: IosSimulatorClaimArgs = {}): Promise<IosSimulatorStatus> => {
    if (!activeSession) return getStatus();
    const laneId = cleanClaimId(claimArgs.laneId);
    const chatSessionId = cleanClaimId(claimArgs.chatSessionId);
    if (!laneId && !chatSessionId) return getStatus();
    const nextLaneId = laneId || activeSession.laneId;
    const nextChatSessionId = chatSessionId || activeSession.chatSessionId;
    const changed = nextLaneId !== activeSession.laneId
      || nextChatSessionId !== activeSession.chatSessionId;
    activeSession = {
      ...activeSession,
      laneId: nextLaneId,
      chatSessionId: nextChatSessionId,
      claimedAt: changed ? nowIso() : activeSession.claimedAt,
    };
    emit({ type: "session-updated", session: activeSession });
    return getStatus();
  };

  const launch = async (launchArgs: IosSimulatorLaunchArgs = {}): Promise<IosSimulatorSession> => {
    if (process.platform !== "darwin") {
      throw new Error("iOS Simulator control is only available on macOS.");
    }
    if (!cachedCommandExists("xcrun") || !cachedCommandExists("xcodebuild")) {
      throw new Error("Xcode command line tools are required for iOS Simulator control. Install Xcode and run xcode-select --install.");
    }
    const incomingChatSessionId = launchArgs.chatSessionId ?? null;
    // Anonymous sessions (chatSessionId == null on either side) are intentionally
    // unowned — the CLI and tests routinely launch without a chat session id,
    // so any subsequent caller may take over without `force: true`. We only block
    // when both sides identify a chat session and they differ.
    if (
      activeSession
      && activeSession.chatSessionId
      && incomingChatSessionId
      && activeSession.chatSessionId !== incomingChatSessionId
      && !launchArgs.force
    ) {
      throw new IosSimulatorOwnedBySessionError(activeSession);
    }
    if (
      activeSession
      && launchArgs.force
      && (!incomingChatSessionId || activeSession.chatSessionId !== incomingChatSessionId)
    ) {
      await shutdown({ force: true }).catch((error) => {
        args.logger.warn("ios_simulator.shutdown_during_force_launch_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    const launchId = randomUUID();
    activeLaunchId = launchId;
    let currentStep: IosSimulatorLaunchStepId = "resolve-device";
    const projectRoot = resolveProjectRoot(launchArgs.projectRoot);
    try {
      emitLaunchProgress(launchId, "resolve-device", "running", "Finding installed simulator device...");
      const device = await resolveDevice(launchArgs.deviceUdid);
      emitLaunchProgress(launchId, "resolve-device", "complete", `${device.name} selected.`, device.runtime, { deviceUdid: device.udid });

      currentStep = "boot-simulator";
      if (device.state === "Booted") {
        emitLaunchProgress(launchId, "boot-simulator", "running", "Checking simulator readiness...", device.name, { deviceUdid: device.udid });
      } else {
        emitLaunchProgress(launchId, "boot-simulator", "running", "Booting simulator...", device.name, { deviceUdid: device.udid });
        await run("xcrun", ["simctl", "boot", device.udid]).catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          if (!/Unable to boot device in current state|current state: Booted|already booted/i.test(message)) throw error;
        });
      }
      await waitForSimulatorBootStatus(device);
      emitLaunchProgress(launchId, "boot-simulator", "complete", "Simulator services are ready.", device.name, { deviceUdid: device.udid });

      currentStep = "open-simulator";
      const openSimulatorInForeground = shouldOpenSimulatorAppForLaunch(launchArgs.keepSimulatorInBackground);
      if (openSimulatorInForeground) {
        emitLaunchProgress(launchId, "open-simulator", "running", "Opening Simulator.app...", null, { deviceUdid: device.udid });
        spawnProcess("open", ["-a", "Simulator"], { detached: true, stdio: "ignore" }).unref();
        emitLaunchProgress(launchId, "open-simulator", "complete", "Simulator.app is visible.", null, { deviceUdid: device.udid });
      } else {
        emitLaunchProgress(launchId, "open-simulator", "skipped", "Simulator.app was left in the background by request.", null, { deviceUdid: device.udid });
      }

      currentStep = "resolve-target";
      emitLaunchProgress(launchId, "resolve-target", "running", "Resolving launchable app...", null, { deviceUdid: device.udid });
      const target = await resolveLaunchTarget(launchArgs, device.udid, projectRoot);
      emitLaunchProgress(launchId, "resolve-target", "complete", `${target.target.name} selected.`, target.target.detail, { deviceUdid: device.udid, targetId: target.target.id });

      currentStep = "build-app";
      if (target.shouldBuild) {
        emitLaunchProgress(launchId, "build-app", "running", "Building iOS app...", target.target.detail, { deviceUdid: device.udid, targetId: target.target.id });
      } else {
        emitLaunchProgress(launchId, "build-app", "skipped", "Build skipped.", target.target.detail, { deviceUdid: device.udid, targetId: target.target.id });
      }
      const appBundle = target.shouldBuild || target.shouldInstall
        ? await buildProjectApp(target, device, projectRoot)
        : target.appBundlePath;
      emitLaunchProgress(launchId, "build-app", target.shouldBuild ? "complete" : "skipped", target.shouldBuild ? "Build complete." : "Using installed app.", appBundle ? relativeToRoot(projectRoot, appBundle) : null, { deviceUdid: device.udid, targetId: target.target.id });

      const bundleId = target.bundleId
        ?? (appBundle ? await readPlistValue(path.join(appBundle, "Info.plist"), "CFBundleIdentifier") : null);
      if (!bundleId) {
        throw new Error(`Could not determine the bundle identifier for ${target.target.name}. Select a built app bundle or pass --bundle-id.`);
      }
      currentStep = "install-app";
      if (target.shouldInstall) {
        emitLaunchProgress(launchId, "install-app", "running", "Installing app on simulator...", bundleId, { deviceUdid: device.udid, targetId: target.target.id });
        if (!appBundle) {
          throw new Error(`Could not find ${target.target.name}.app after building. Try launching with build=true from the project root.`);
        }
        await installAppOnSimulator(device, appBundle);
        emitLaunchProgress(launchId, "install-app", "complete", "App installed.", bundleId, { deviceUdid: device.udid, targetId: target.target.id });
      } else {
        emitLaunchProgress(launchId, "install-app", "skipped", "App already installed.", bundleId, { deviceUdid: device.udid, targetId: target.target.id });
      }

      const launchEnvironment = normalizeLaunchEnvironment(launchArgs.environment);
      const launchArguments = normalizeLaunchArguments(launchArgs.arguments);
      const startedAt = nowIso();
      const session: IosSimulatorSession = {
        id: randomUUID(),
        deviceUdid: device.udid,
        deviceName: device.name,
        bundleId,
        appName: target.target.name,
        appBundlePath: appBundle,
        targetId: target.target.id,
        projectRoot,
        laneId: launchArgs.laneId ?? null,
        chatSessionId: launchArgs.chatSessionId ?? null,
        mode: normalizeLaunchMode(launchArgs.mode),
        keepSimulatorInBackground: launchArgs.keepSimulatorInBackground ?? false,
        bridgeUrl: null,
        startedAt,
        claimedAt: launchArgs.laneId || launchArgs.chatSessionId ? startedAt : null,
      };
      activeSession = session;
      const childEnv: NodeJS.ProcessEnv = {
        ...process.env,
        ...Object.fromEntries(
          Object.entries(launchEnvironment).map(([key, value]) => [`SIMCTL_CHILD_${key}`, value]),
        ),
        ...(bundleId === ADE_IOS_BUNDLE_ID
          ? {
            SIMCTL_CHILD_ADE_INSPECTOR_SESSION_ID: session.id,
            SIMCTL_CHILD_ADE_INSPECTOR_MODE: session.mode,
          }
          : {}),
      };
      const simctlLaunchArgs = ["simctl", "launch", "--terminate-running-process", device.udid, bundleId];
      if (bundleId === ADE_IOS_BUNDLE_ID) {
        simctlLaunchArgs.push("--ade-inspector-mode", session.mode);
      }
      simctlLaunchArgs.push(...launchArguments);
      currentStep = "launch-app";
      emitLaunchProgress(launchId, "launch-app", "running", "Launching app...", bundleId, { deviceUdid: device.udid, targetId: target.target.id });
      await run("xcrun", simctlLaunchArgs, {
        env: childEnv,
        timeoutMs: 60_000,
      });
      emitLaunchProgress(launchId, "launch-app", "complete", "App launched.", bundleId, { deviceUdid: device.udid, targetId: target.target.id });
      emitLaunchProgress(launchId, "ready", "complete", "iOS simulator drawer is ready.", device.name, { deviceUdid: device.udid, targetId: target.target.id });
      emit({ type: "session-started", session });
      return session;
    } catch (error) {
      emitLaunchProgress(
        launchId,
        currentStep,
        "failed",
        error instanceof Error ? error.message : String(error),
        null,
      );
      if (activeSession && activeLaunchId === launchId) {
        activeSession = null;
        emit({ type: "session-updated", session: null });
      }
      throw error;
    } finally {
      if (activeLaunchId === launchId) activeLaunchId = null;
    }
  };

  const screenshot = async (arg: { deviceUdid?: string | null } = {}): Promise<IosSimulatorScreenshot> => {
    const device = await resolveDevice(arg.deviceUdid ?? activeSession?.deviceUdid);
    const tmpPath = trackTempFile(path.join(os.tmpdir(), `ade-ios-sim-${device.udid}-${randomUUID()}.png`));
    try {
      await run("xcrun", ["simctl", "io", device.udid, "screenshot", "--type=png", tmpPath], { timeoutMs: 30_000 });
      const buffer = await fs.promises.readFile(tmpPath);
      const dimensions = pngDimensions(buffer);
      return {
        deviceUdid: device.udid,
        dataUrl: `data:image/png;base64,${buffer.toString("base64")}`,
        width: dimensions.width,
        height: dimensions.height,
        capturedAt: nowIso(),
      };
    } finally {
      releaseTempFile(tmpPath);
      fs.promises.unlink(tmpPath).catch(() => {});
    }
  };

  const getAppContainerPath = async (deviceUdid?: string | null): Promise<{ device: IosSimulatorDevice; containerPath: string }> => {
    if (!activeSession) {
      throw new Error("Launch an iOS app before reading inspector context.");
    }
    const device = await resolveDevice(deviceUdid ?? activeSession?.deviceUdid);
    const { stdout } = await run("xcrun", ["simctl", "get_app_container", device.udid, activeSession.bundleId, "data"], { timeoutMs: 20_000 });
    const containerPath = stdout.trim();
    if (!containerPath) {
      throw new Error(`${activeSession.appName ?? activeSession.bundleId} data container was not found. Launch the app in the simulator first.`);
    }
    return { device, containerPath };
  };

  const readInspectorSnapshot = async (arg: { deviceUdid?: string | null } = {}): Promise<IosInspectorSnapshot | null> => {
    const { device, containerPath } = await getAppContainerPath(arg.deviceUdid);
    const snapshotPath = path.join(containerPath, ADE_IOS_INSPECTOR_SNAPSHOT_PATH);
    let data: string;
    try {
      data = await fs.promises.readFile(snapshotPath, "utf8");
    } catch (error) {
      const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
      if (code === "ENOENT") return null;
      throw error;
    }
    const raw = JSON.parse(data) as RawIosInspectorSnapshot;
    const scale = Number(raw.screen?.scale);
    const normalizedScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
    const elements: IosInspectableElement[] = [];
    for (const rawElement of raw.elements ?? []) {
      const frame = normalizeFrame(rawElement.frame);
      if (!rawElement.id || !rawElement.componentId || !frame) continue;
      const pixelFrame = normalizeFrame(rawElement.pixelFrame) ?? {
        x: frame.x * normalizedScale,
        y: frame.y * normalizedScale,
        width: frame.width * normalizedScale,
        height: frame.height * normalizedScale,
      };
      elements.push({
        id: rawElement.id,
        componentId: rawElement.componentId,
        sourceFile: rawElement.sourceFile ?? null,
        sourceLine: rawElement.sourceLine ?? null,
        frame,
        pixelFrame,
        metadata: rawElement.metadata ?? {},
        accessibilityIdentifier: rawElement.accessibilityIdentifier ?? rawElement.componentId,
      });
    }
    return {
      deviceUdid: device.udid,
      appContainerPath: containerPath,
      generatedAt: raw.generatedAt ?? nowIso(),
      screen: {
        width: Number(raw.screen?.width) || 0,
        height: Number(raw.screen?.height) || 0,
        scale: normalizedScale,
      },
      elements,
    };
  };

  const readAccessibilityElements = async (deviceUdid: string): Promise<IosScreenElement[]> => {
    if (!cachedCommandExists("idb")) {
      throw new Error(`idb is not installed. ${INSTALL_HINT_IDB}`);
    }
    const companion = await ensureCompanion(deviceUdid);
    try {
      const { stdout } = await run("idb", [
        "--companion",
        companion,
        "ui",
        "describe-all",
        "--json",
        "--nested",
        "--udid",
        deviceUdid,
      ], { timeoutMs: 20_000 });
      const parsed = JSON.parse(stdout) as unknown;
      return collectAccessibilityElements(parsed);
    } finally {
      scheduleCompanionIdleStop();
    }
  };

  const getScreenSnapshot = async (snapshotArgs: IosScreenSnapshotArgs = {}): Promise<IosScreenSnapshot> => {
    const hitX = snapshotArgs.x == null ? null : normalizeCoordinate(snapshotArgs.x, "x");
    const hitY = snapshotArgs.y == null ? null : normalizeCoordinate(snapshotArgs.y, "y");
    const shot = await screenshot({ deviceUdid: snapshotArgs.deviceUdid ?? activeSession?.deviceUdid });
    const providers: IosScreenSnapshot["providers"] = [
      {
        source: "screenshot",
        available: true,
        generatedAt: shot.capturedAt,
      },
    ];

    let inspectorSnapshot: IosInspectorSnapshot | null = null;
    let inspectorElements: IosScreenElement[] = [];
    try {
      inspectorSnapshot = await readInspectorSnapshot({ deviceUdid: shot.deviceUdid });
      inspectorElements = (inspectorSnapshot?.elements ?? []).map(inspectorElementToScreenElement);
      providers.push({
        source: "ade-inspector",
        available: Boolean(inspectorSnapshot),
        elementCount: inspectorElements.length,
        generatedAt: inspectorSnapshot?.generatedAt ?? null,
        error: inspectorSnapshot ? null : "No ADEInspector snapshot has been published by the active app.",
      });
    } catch (error) {
      providers.push({
        source: "ade-inspector",
        available: false,
        elementCount: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    let accessibilityElements: IosScreenElement[] = [];
    let accessibilityScreen: IosInspectableScreen | null = null;
    try {
      const rawAccessibilityElements = await readAccessibilityElements(shot.deviceUdid);
      const scaledAccessibility = scaleAccessibilityElementsToScreenshot(rawAccessibilityElements, shot);
      accessibilityElements = scaledAccessibility.elements;
      accessibilityScreen = scaledAccessibility.screen;
      providers.push({
        source: "accessibility",
        available: true,
        elementCount: accessibilityElements.length,
      });
    } catch (error) {
      providers.push({
        source: "accessibility",
        available: false,
        elementCount: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const projectRoot = snapshotArgs.projectRoot ?? activeSession?.projectRoot ?? args.projectRoot;
    const baseElements = mergeScreenElements(inspectorElements, accessibilityElements);
    const syntheticElements = synthesizeSwiftUITabBarElements(projectRoot, baseElements);
    const elements = syntheticElements.length
      ? mergeScreenElements(baseElements, syntheticElements)
      : baseElements;
    const screen = inspectorSnapshot?.screen ?? {
      width: accessibilityScreen?.width ?? shot.width ?? 0,
      height: accessibilityScreen?.height ?? shot.height ?? 0,
      scale: accessibilityScreen?.scale ?? 1,
    };
    const hitElement = hitX == null || hitY == null
      ? null
      : findSmallestScreenElementAt(elements, hitX, hitY);
    return {
      deviceUdid: shot.deviceUdid,
      capturedAt: shot.capturedAt,
      screenshot: shot,
      screen,
      elements,
      hitElement,
      providers,
      inspectorSnapshot,
    };
  };

  const contextItemFromScreenElement = (
    element: IosScreenElement,
    snapshot: IosScreenSnapshot,
    screenshotDataUrl?: string | null,
    projectRootOverride?: string | null,
  ): IosElementContextItem => {
    const projectRoot = projectRootOverride ?? activeSession?.projectRoot ?? args.projectRoot ?? null;
    const inspectedSnippet = projectRoot
      ? readSourceSnippet(projectRoot, element.sourceFile, element.sourceLine)
      : null;
    const sourceMatches = element.sourceFile && element.sourceLine
      ? [{
          sourceFile: element.sourceFile,
          sourceLine: element.sourceLine,
          confidence: "exact" as const,
          reason: "ADEInspector source metadata",
          snippet: inspectedSnippet,
        }]
      : findSourceMatchesForElement(projectRoot, element);
    const bestExactMatch = sourceMatches.find(isTrustedSourceMatch) ?? null;
    const bestCandidateMatch = sourceMatches.find((match) => match.confidence === "candidate") ?? null;
    const sourceFile = element.sourceFile ?? bestExactMatch?.sourceFile ?? null;
    const sourceLine = element.sourceLine ?? bestExactMatch?.sourceLine ?? null;
    const sourceSnippet = projectRoot
      ? readSourceSnippet(projectRoot, sourceFile, sourceLine)
      : bestExactMatch?.snippet ?? null;
    let sourceConfidence: "exact" | "candidate" | "none";
    if (sourceFile) {
      sourceConfidence = "exact";
    } else if (bestCandidateMatch) {
      sourceConfidence = "candidate";
    } else {
      sourceConfidence = "none";
    }
    let sourceResolution: string;
    if (element.sourceFile) {
      sourceResolution = "ade-inspector";
    } else if (bestExactMatch) {
      sourceResolution = "swift-exact-search";
    } else if (bestCandidateMatch) {
      sourceResolution = "swift-candidate-search";
    } else {
      sourceResolution = "none";
    }
    return {
      kind: "ios_element",
      id: randomUUID(),
      componentId: element.componentId ?? element.label ?? element.role ?? "Simulator element",
      sourceFile,
      sourceLine,
      frame: element.pixelFrame,
      metadata: {
        ...element.metadata,
        iosInspectPacketVersion: 1,
        screenElementId: element.id,
        screenElementSource: element.source,
        sourceResolution,
        sourceConfidence,
        sourceMatches,
        sourceCandidates: sourceMatches,
        screenSnapshotCapturedAt: snapshot.capturedAt,
        screen: screenPacket(snapshot),
        selectedElement: compactScreenElement(element),
        nearbyElements: nearbyScreenElements(snapshot, element),
        deviceUdid: snapshot.deviceUdid,
        chatSessionId: activeSession?.chatSessionId ?? null,
        label: element.label,
        value: element.value,
        role: element.role,
        elementType: element.elementType,
        sourceSnippet,
        selectionExplanation: "The user selected this UI element from the ADE iOS Simulator inspector. The screenshot or crop attachment is visual evidence for this packet; frames are in screenshot pixels.",
      },
      accessibilityIdentifier: element.identifier,
      screenshotDataUrl: screenshotDataUrl ?? undefined,
      selectedAt: nowIso(),
    };
  };

  const coordinateFallbackItem = (
    point: { x: number; y: number },
    deviceUdid: string,
    screenshotDataUrl?: string | null,
  ): IosElementContextItem => ({
    kind: "ios_element",
    id: randomUUID(),
    componentId: "Simulator coordinate",
    sourceFile: null,
    sourceLine: null,
    frame: { x: Math.round(point.x), y: Math.round(point.y), width: 1, height: 1 },
    metadata: {
      iosInspectPacketVersion: 1,
      deviceUdid,
      chatSessionId: activeSession?.chatSessionId ?? null,
      sourceConfidence: "none",
      selectedElement: {
        source: "coordinate",
        screenshotFrame: { x: Math.round(point.x), y: Math.round(point.y), width: 1, height: 1 },
      },
      note: "No accessibility or ADEInspectorKit frame match was reported; this context preserves the selected simulator coordinate and screenshot.",
    },
    accessibilityIdentifier: null,
    screenshotDataUrl: screenshotDataUrl ?? undefined,
    selectedAt: nowIso(),
  });

  const inspectPoint = async (point: IosSimulatorInspectPointArgs): Promise<IosSimulatorInspectResult> => {
    const x = normalizeCoordinate(point.x, "x");
    const y = normalizeCoordinate(point.y, "y");
    const screenSnapshot = await getScreenSnapshot({ deviceUdid: point.deviceUdid, x, y });
    const element = screenSnapshot.hitElement;
    if (!element) {
      return {
        item: null,
        source: "none",
        snapshot: screenSnapshot.inspectorSnapshot,
        screenSnapshot,
      };
    }
    return {
      item: contextItemFromScreenElement(element, screenSnapshot, point.includeScreenshot ? screenSnapshot.screenshot.dataUrl : null, point.projectRoot),
      source: element.source,
      snapshot: screenSnapshot.inspectorSnapshot,
      screenSnapshot,
    };
  };

  const getStreamStatus = (): IosSimulatorStreamStatus => streamStatus;

  const stopStream = async (): Promise<IosSimulatorStreamStatus> => {
    stopCompanion();
    const next = setStreamStopped(null);
    emit({ type: "stream-stopped", status: next });
    return next;
  };

  const shutdown = async (shutdownArgs: IosSimulatorShutdownArgs = {}): Promise<IosSimulatorShutdownResult> => {
    const previousSession = activeSession;
    try {
      await stopStream();
    } catch (error) {
      args.logger.debug("ios_simulator.stop_stream_during_shutdown_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    stopCompanion();
    cleanupTempFiles();
    if (shutdownArgs.force) {
      await cleanupOrphanedIdbCompanions(previousSession?.deviceUdid ?? null).catch(() => 0);
    }
    const released = activeSession !== null;
    activeSession = null;
    cachedStatus = { ...cachedStatus, computedAt: 0 };
    if (released || previousSession) {
      emit({ type: "session-updated", session: null });
      emit({ type: "session-released", previousSession });
    }
    return { released, previousSession };
  };

  const startedStreamStatus = (
    device: IosSimulatorDevice,
    targetFps: number,
  ): IosSimulatorStreamStatus => ({
    deviceUdid: device.udid,
    running: true,
    backend: "simulator-window-capture",
    requestedBackend: streamRequestContext.requestedBackend ?? null,
    fallbackReason: null,
    degradationReason: null,
    fps: null,
    targetFps,
    frameCount: 0,
    startedAt: nowIso(),
    lastFrameAt: null,
    lastError: null,
    error: null,
    streamUrl: null,
    averageLatencyMs: null,
    latencyP50Ms: null,
    latencyP95Ms: null,
    helperPid: null,
    inputBackend: null,
  });

  const startWindowCaptureStream = async (device: IosSimulatorDevice, fps: number): Promise<IosSimulatorStreamStatus> => {
    if (process.platform !== "darwin") {
      throw new Error("Simulator window streaming is only available on macOS.");
    }
    const requestedFps = Math.max(1, Math.min(60, Math.round(fps)));
    if (!Number.isFinite(requestedFps)) {
      throw new Error("fps must be a number between 1 and 60.");
    }
    if (streamStatus.running && streamStatus.deviceUdid === device.udid && streamStatus.backend === "simulator-window-capture") {
      return streamStatus;
    }
    await stopStream();
    spawnProcess("open", ["-g", "-a", "Simulator"], { detached: true, stdio: "ignore" }).unref();
    streamRequestContext = {
      requestedBackend: streamRequestContext.requestedBackend ?? "simulator-window-capture",
      fallbackReason: null,
      degradationReason: null,
    };
    streamStatus = startedStreamStatus(device, requestedFps);
    emit({ type: "stream-started", status: streamStatus });
    if (cachedCommandExists("idb") && cachedCommandExists("idb_companion")) {
      void ensureCompanion(device.udid).then(() => {
        if (!streamStatus.running || streamStatus.deviceUdid !== device.udid) {
          scheduleCompanionIdleStop();
        }
      }).catch((error) => {
        args.logger.debug("ios_simulator.control_prewarm_failed", {
          deviceUdid: device.udid,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    return streamStatus;
  };

  const startStream = async (streamArgs: IosSimulatorStartStreamArgs = {}): Promise<IosSimulatorStreamStatus> => {
    const device = await resolveDevice(streamArgs.deviceUdid ?? activeSession?.deviceUdid);
    const rawBackend = streamArgs.backend ?? "simulator-window-capture";
    if (rawBackend !== "auto" && rawBackend !== "simulator-window-capture") {
      throw new Error("stream backend must be `auto` or `simulator-window-capture`.");
    }
    const requestedBackend = resolveIosSimulatorStreamBackend(rawBackend);
    const requestedFps = Math.max(1, Math.min(60, Math.round(Number(streamArgs.fps ?? 60))));
    streamRequestContext = {
      requestedBackend,
      fallbackReason: null,
      degradationReason: null,
    };
    return startWindowCaptureStream(device, requestedFps);
  };

  const runIdbTap = async (deviceUdid: string, x: number, y: number): Promise<void> => {
    if (!cachedCommandExists("idb")) {
      throw new Error(`idb is required for pointer control. ${INSTALL_HINT_IDB}`);
    }
    const companion = await ensureCompanion(deviceUdid);
    try {
      await run("idb", ["--companion", companion, "ui", "tap", String(Math.round(x)), String(Math.round(y)), "--udid", deviceUdid], { timeoutMs: 20_000 });
    } finally {
      scheduleCompanionIdleStop();
    }
  };

  const runIdbText = async (deviceUdid: string, text: string): Promise<void> => {
    if (!cachedCommandExists("idb")) {
      throw new Error(`idb is required for text input. ${INSTALL_HINT_IDB}`);
    }
    const companion = await ensureCompanion(deviceUdid);
    try {
      await run("idb", ["--companion", companion, "ui", "text", text, "--udid", deviceUdid], { timeoutMs: 20_000 });
    } finally {
      scheduleCompanionIdleStop();
    }
  };

  const runIdbSwipe = async (deviceUdid: string, input: { startX: number; startY: number; endX: number; endY: number; durationMs?: number | null; delta?: number | null }): Promise<void> => {
    if (!cachedCommandExists("idb")) {
      throw new Error(`idb is required for pointer control. ${INSTALL_HINT_IDB}`);
    }
    const companion = await ensureCompanion(deviceUdid);
    const idbArgs = [
      "--companion",
      companion,
      "ui",
      "swipe",
      String(Math.round(input.startX)),
      String(Math.round(input.startY)),
      String(Math.round(input.endX)),
      String(Math.round(input.endY)),
      "--udid",
      deviceUdid,
    ];
    if (input.durationMs != null) {
      if (!Number.isFinite(input.durationMs)) throw new Error("durationMs must be a number.");
      idbArgs.push("--duration", String(Math.max(0.01, input.durationMs / 1000)));
    }
    if (input.delta != null) {
      if (!Number.isFinite(input.delta) || input.delta <= 0) throw new Error("delta must be a positive number.");
      idbArgs.push("--delta", String(input.delta));
    }
    try {
      await run("idb", idbArgs, { timeoutMs: 20_000 });
    } finally {
      scheduleCompanionIdleStop();
    }
  };

  const tap = async (point: { deviceUdid?: string | null; x: number; y: number }): Promise<{ ok: true }> => {
    const deviceUdid = await resolveControlDeviceUdid(point.deviceUdid);
    const x = normalizeCoordinate(point.x, "x");
    const y = normalizeCoordinate(point.y, "y");
    return enqueueControl("tap", async () => {
      await runIdbTap(deviceUdid, x, y);
      streamStatus = { ...streamStatus, inputBackend: "idb" };
      return { ok: true };
    });
  };

  const typeText = async (input: { deviceUdid?: string | null; text: string }): Promise<{ ok: true }> => {
    const deviceUdid = await resolveControlDeviceUdid(input.deviceUdid);
    return enqueueControl("text", async () => {
      await runIdbText(deviceUdid, input.text);
      streamStatus = { ...streamStatus, inputBackend: "idb" };
      return { ok: true };
    });
  };

  const drag = async (input: IosSimulatorDragArgs): Promise<{ ok: true }> => {
    const deviceUdid = await resolveControlDeviceUdid(input.deviceUdid);
    const startX = normalizeCoordinate(input.startX, "startX");
    const startY = normalizeCoordinate(input.startY, "startY");
    const endX = normalizeCoordinate(input.endX, "endX");
    const endY = normalizeCoordinate(input.endY, "endY");
    const durationMs = input.durationMs;
    const deltaValue = input.delta;
    return enqueueControl("drag", async () => {
      if (durationMs != null && !Number.isFinite(durationMs)) throw new Error("durationMs must be a number.");
      if (deltaValue != null && (!Number.isFinite(deltaValue) || deltaValue <= 0)) throw new Error("delta must be a positive number.");
      await runIdbSwipe(deviceUdid, {
        startX,
        startY,
        endX,
        endY,
        durationMs,
        delta: deltaValue,
      });
      streamStatus = { ...streamStatus, inputBackend: "idb" };
      return { ok: true };
    });
  };

  const selectPoint = async (point: { deviceUdid?: string | null; projectRoot?: string | null; x: number; y: number }): Promise<IosSimulatorSelectResult> => {
    const x = normalizeCoordinate(point.x, "x");
    const y = normalizeCoordinate(point.y, "y");
    const screenSnapshot = await getScreenSnapshot({ deviceUdid: point.deviceUdid ?? activeSession?.deviceUdid, projectRoot: point.projectRoot, x, y });
    const element = screenSnapshot.hitElement;
    const item = element
      ? contextItemFromScreenElement(element, screenSnapshot, screenSnapshot.screenshot.dataUrl, point.projectRoot)
      : coordinateFallbackItem({ x, y }, screenSnapshot.deviceUdid, screenSnapshot.screenshot.dataUrl);
    lastSelectedItem = item;
    emit({ type: "selection", item });
    return { item, source: element?.source ?? "coordinate-fallback" };
  };

  return {
    getStatus,
    claim,
    listDevices,
    listLaunchTargets,
    launch,
    attachToChatSession,
    shutdown,
    screenshot,
    getScreenSnapshot,
    getInspectorSnapshot: readInspectorSnapshot,
    inspectPoint,
    getPreviewCapability,
    listPreviewTargets,
    renderPreview,
    openPreviewWorkspace,
    startStream,
    stopStream,
    getStreamStatus,
    tap,
    typeText,
    drag,
    swipe: drag,
    selectPoint,
    getLastSelectedItem: () => lastSelectedItem,
    dispose: () => {
      disposed = true;
      stopCompanion();
      setStreamStopped(null);
      activeSession = null;
      activeLaunchId = null;
      cleanupTempFiles();
      toolAvailabilityCache.clear();
      if (xcodeMcpBridge) {
        const bridge = xcodeMcpBridge;
        xcodeMcpBridge = null;
        disposeXcodeMcpBridge(bridge, new Error("iOS simulator service disposed."));
      }
    },
  };
}
