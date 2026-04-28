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
  IosInspectorSnapshot,
  IosSimulatorInspectPointArgs,
  IosSimulatorInspectResult,
  IosSimulatorDevice,
  IosSimulatorLaunchArgs,
  IosSimulatorStreamBackend,
  IosSimulatorStartStreamArgs,
  IosSimulatorStreamStatus,
  IosSimulatorScreenshot,
  IosSimulatorSelectResult,
  IosSimulatorSession,
  IosSimulatorStatus,
} from "../../../shared/types";
import { commandExists } from "../ai/utils";
import type { Logger } from "../logging/logger";

const execFile = promisify(execFileCallback);

const ADE_IOS_BUNDLE_ID = "com.ade.ios";
const ADE_IOS_PROJECT = path.join("apps", "ios", "ADE.xcodeproj");
const ADE_IOS_SCHEME = "ADE";
const ADE_IOS_INSPECTOR_SNAPSHOT_PATH = path.join("Documents", "ade-inspector-elements.json");

type CreateIosSimulatorServiceArgs = {
  projectRoot: string;
  logger: Logger;
  onEvent?: ((payload: import("../../../shared/types").IosSimulatorEventPayload) => void) | null;
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

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeRuntimeName(runtime: string): string {
  const tail = runtime.split(".").pop() ?? runtime;
  return tail.replace(/^iOS-/, "iOS ").replace(/-/g, ".");
}

async function run(command: string, args: string[], options: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<{ stdout: string; stderr: string }> {
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

function pngDimensions(buffer: Buffer): { width: number | null; height: number | null } {
  if (buffer.length < 24) return { width: null, height: null };
  if (buffer.toString("ascii", 1, 4) !== "PNG") return { width: null, height: null };
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function jpegDimensions(buffer: Buffer): { width: number | null; height: number | null } {
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker == null) break;
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > buffer.length) break;
    if (
      marker === 0xc0
      || marker === 0xc1
      || marker === 0xc2
      || marker === 0xc3
      || marker === 0xc5
      || marker === 0xc6
      || marker === 0xc7
      || marker === 0xc9
      || marker === 0xca
      || marker === 0xcb
      || marker === 0xcd
      || marker === 0xce
      || marker === 0xcf
    ) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + length;
  }
  return { width: null, height: null };
}

function normalizeLaunchMode(mode: unknown): "snapshot" | "live" {
  if (mode == null) return "snapshot";
  if (mode === "snapshot" || mode === "live") return mode;
  throw new Error("iOS Simulator launch mode must be `snapshot` or `live`.");
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

function containsPoint(frame: IosInspectableElement["pixelFrame"], x: number, y: number): boolean {
  return (
    x >= frame.x
    && y >= frame.y
    && x <= frame.x + frame.width
    && y <= frame.y + frame.height
  );
}

function findSmallestElementAt(elements: IosInspectableElement[], x: number, y: number): IosInspectableElement | null {
  const hits = elements.filter((element) => containsPoint(element.pixelFrame, x, y));
  hits.sort((a, b) => {
    const areaA = a.pixelFrame.width * a.pixelFrame.height;
    const areaB = b.pixelFrame.width * b.pixelFrame.height;
    if (areaA !== areaB) return areaA - areaB;
    return a.componentId.localeCompare(b.componentId);
  });
  return hits[0] ?? null;
}

async function findAdeAppBundle(root: string): Promise<string | null> {
  const candidates = [
    path.join(root, "Build", "Products", "Debug-iphonesimulator", "ADE.app"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  async function walk(dir: string, depth: number): Promise<string | null> {
    if (depth > 5) return null;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      const next = path.join(dir, entry.name);
      if (entry.isDirectory() && entry.name === "ADE.app") return next;
      if (entry.isDirectory()) {
        const found = await walk(next, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }
  return walk(root, 0);
}

export type IosSimulatorService = ReturnType<typeof createIosSimulatorService>;

export function createIosSimulatorService(args: CreateIosSimulatorServiceArgs) {
  let activeSession: IosSimulatorSession | null = null;
  let lastSelectedItem: IosElementContextItem | null = null;
  let streamProcess: ChildProcess | null = null;
  let streamTranscoderProcess: ChildProcess | null = null;
  let streamPollTimer: NodeJS.Timeout | null = null;
  let companionProcess: ChildProcess | null = null;
  let companionDeviceUdid: string | null = null;
  let companionAddress: string | null = null;
  let streamBuffer = Buffer.alloc(0);
  let streamFrameWaiters: Array<() => void> = [];
  let streamStatus: IosSimulatorStreamStatus = {
    deviceUdid: null,
    running: false,
    backend: null,
    fps: null,
    frameCount: 0,
    startedAt: null,
    lastFrameAt: null,
    lastError: null,
  };

  const emit = (payload: import("../../../shared/types").IosSimulatorEventPayload) => {
    args.onEvent?.(payload);
  };

  const setStreamStopped = (error: string | null = null): IosSimulatorStreamStatus => {
    streamProcess = null;
    streamTranscoderProcess = null;
    streamFrameWaiters.splice(0).forEach((resolve) => resolve());
    if (streamPollTimer) {
      clearInterval(streamPollTimer);
      streamPollTimer = null;
    }
    streamBuffer = Buffer.alloc(0);
    streamStatus = {
      ...streamStatus,
      running: false,
      backend: null,
      fps: null,
      lastError: error,
    };
    return streamStatus;
  };

  const stopChild = (child: ChildProcess | null) => {
    if (!child) return;
    child.removeAllListeners();
    child.stdout?.removeAllListeners();
    child.stderr?.removeAllListeners();
    child.stdin?.removeAllListeners();
    if (!child.killed) child.kill("SIGTERM");
  };

  const emitFrame = (frame: Buffer, backend: IosSimulatorStreamBackend, capturedAt: string, contentType: "jpeg" | "png") => {
    const dimensions = contentType === "jpeg" ? jpegDimensions(frame) : pngDimensions(frame);
    streamStatus = {
      ...streamStatus,
      frameCount: streamStatus.frameCount + 1,
      lastFrameAt: capturedAt,
      lastError: null,
    };
    emit({
      type: "stream-frame",
      frame: {
        deviceUdid: streamStatus.deviceUdid ?? "",
        dataUrl: `data:image/${contentType};base64,${frame.toString("base64")}`,
        width: dimensions.width,
        height: dimensions.height,
        capturedAt,
        frameCount: streamStatus.frameCount,
        backend,
      },
    });
    streamFrameWaiters.splice(0).forEach((resolve) => resolve());
  };

  const waitForNextStreamFrame = async (timeoutMs: number): Promise<void> => {
    if (streamStatus.frameCount > 0) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      streamFrameWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  };

  const stopCompanion = () => {
    stopChild(companionProcess);
    companionProcess = null;
    companionDeviceUdid = null;
    companionAddress = null;
  };

  const ensureCompanion = async (deviceUdid: string): Promise<string> => {
    if (companionProcess && companionDeviceUdid === deviceUdid && companionAddress) {
      return companionAddress;
    }
    if (!commandExists("idb_companion")) {
      throw new Error("idb_companion is required for live simulator streaming. Install it with: brew tap facebook/fb && brew install idb-companion");
    }
    stopCompanion();
    const port = await getFreePort();
    const address = `127.0.0.1:${port}`;
    let stderr = "";
    companionProcess = spawn("idb_companion", [
      "--udid",
      deviceUdid,
      "--grpc-port",
      String(port),
      "--log-level",
      "info",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    companionDeviceUdid = deviceUdid;
    companionAddress = address;
    companionProcess.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-4000);
    });
    companionProcess.stdout?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-4000);
    });
    companionProcess.once("exit", (code) => {
      if (companionDeviceUdid !== deviceUdid) return;
      companionProcess = null;
      companionDeviceUdid = null;
      companionAddress = null;
      if (streamStatus.running) {
        stopChild(streamProcess);
        stopChild(streamTranscoderProcess);
        const status = setStreamStopped(stderr.trim() || `idb_companion exited with code ${code ?? "unknown"}.`);
        emit({ type: "stream-error", status });
      }
    });
    await delay(1_200);
    if (!companionProcess || companionProcess.exitCode !== null) {
      throw new Error(stderr.trim() || "idb_companion failed to start.");
    }
    return address;
  };

  const extractJpegFrame = (): Buffer | null => {
    const start = streamBuffer.indexOf(Buffer.from([0xff, 0xd8]));
    if (start < 0) {
      if (streamBuffer.length > 1024 * 1024) streamBuffer = Buffer.alloc(0);
      return null;
    }
    if (start > 0) streamBuffer = streamBuffer.subarray(start);
    const end = streamBuffer.indexOf(Buffer.from([0xff, 0xd9]), 2);
    if (end < 0) {
      if (streamBuffer.length > 20 * 1024 * 1024) {
        streamBuffer = Buffer.alloc(0);
        streamStatus = { ...streamStatus, lastError: "Dropped an oversized partial simulator video frame." };
        emit({ type: "stream-error", status: streamStatus });
      }
      return null;
    }
    const frame = streamBuffer.subarray(0, end + 2);
    streamBuffer = streamBuffer.subarray(end + 2);
    return frame;
  };

  const handleStreamChunk = (chunk: Buffer) => {
    streamBuffer = Buffer.concat([streamBuffer, chunk]);
    let frame: Buffer | null = null;
    while ((frame = extractJpegFrame()) !== null) {
      emitFrame(frame, "idb-h264-ffmpeg-mjpeg", nowIso(), "jpeg");
    }
  };

  const listDevices = async (): Promise<IosSimulatorDevice[]> => {
    if (!commandExists("xcrun")) return [];
    const { stdout } = await run("xcrun", ["simctl", "list", "devices", "available", "--json"]);
    const parsed = JSON.parse(stdout) as SimctlListDevicesJson;
    const devices: IosSimulatorDevice[] = [];
    for (const [runtime, runtimeDevices] of Object.entries(parsed.devices ?? {})) {
      for (const device of runtimeDevices ?? []) {
        if (!device.udid || !device.name) continue;
        devices.push({
          udid: device.udid,
          name: device.name,
          runtime: normalizeRuntimeName(runtime),
          state: device.state ?? "Unknown",
          isAvailable: device.isAvailable !== false && !device.availabilityError,
        });
      }
    }
    return devices.sort((a, b) => {
      if (a.state === "Booted" && b.state !== "Booted") return -1;
      if (b.state === "Booted" && a.state !== "Booted") return 1;
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
    const bootedIphone = devices.find((device) => device.state === "Booted" && /iphone/i.test(device.name));
    if (bootedIphone) return bootedIphone;
    const iphone = devices.find((device) => /iphone/i.test(device.name));
    if (iphone) return iphone;
    const fallback = devices[0];
    if (!fallback) throw new Error("No available iOS Simulator devices were found.");
    return fallback;
  };

  const getStatus = async (): Promise<IosSimulatorStatus> => {
    const devices = await listDevices().catch(() => []);
    const activeDevice = activeSession
      ? devices.find((device) => device.udid === activeSession?.deviceUdid) ?? null
      : devices.find((device) => device.state === "Booted" && /iphone/i.test(device.name)) ?? null;
    const xcrunAvailable = commandExists("xcrun");
    const xcodebuildAvailable = commandExists("xcodebuild");
    const idbAvailable = commandExists("idb");
    const idbCompanionAvailable = commandExists("idb_companion");
    const ffmpegAvailable = commandExists("ffmpeg");
    return {
      platform: process.platform,
      supported: process.platform === "darwin" && xcrunAvailable && xcodebuildAvailable,
      tools: [
        { name: "xcrun", available: xcrunAvailable, detail: xcrunAvailable ? "Available for simulator boot, install, launch, screenshots, and built-in snapshot preview." : "Install Xcode command line tools." },
        { name: "xcodebuild", available: xcodebuildAvailable, detail: xcodebuildAvailable ? "Available for building ADE iOS." : "Install Xcode." },
        { name: "idb", available: idbAvailable, detail: idbAvailable ? "Available for optional low-latency video, taps, and text input." : "Install idb only for low-latency streaming and pointer/text control: pipx install --python /opt/homebrew/bin/python3.13 fb-idb." },
        { name: "idb_companion", available: idbCompanionAvailable, detail: idbCompanionAvailable ? "Available for optional idb simulator connections." : "Install only for idb control: brew tap facebook/fb && brew install idb-companion." },
        { name: "ffmpeg", available: ffmpegAvailable, detail: ffmpegAvailable ? "Available for optional idb H.264 transcoding." : "Install only for idb live video: brew install ffmpeg." },
      ],
      activeDevice,
      activeSession,
    };
  };

  const buildIfRequested = async (build: boolean | undefined): Promise<string | null> => {
    const derivedDataPath = path.join(args.projectRoot, ".ade", "cache", "ios-simulator", "DerivedData");
    if (build !== false) {
      const iosProjectPath = path.join(args.projectRoot, ADE_IOS_PROJECT);
      if (!fs.existsSync(iosProjectPath)) {
        throw new Error(`ADE iOS project was not found at ${iosProjectPath}. Open the ADE repository root before launching the simulator.`);
      }
      await fs.promises.mkdir(derivedDataPath, { recursive: true });
      args.logger.info("ios_simulator.build.start", { projectRoot: args.projectRoot, derivedDataPath });
      await run("xcodebuild", [
        "-project",
        ADE_IOS_PROJECT,
        "-scheme",
        ADE_IOS_SCHEME,
        "-configuration",
        "Debug",
        "-sdk",
        "iphonesimulator",
        "-derivedDataPath",
        derivedDataPath,
        "build",
      ], { cwd: args.projectRoot, timeoutMs: 10 * 60_000 });
      args.logger.info("ios_simulator.build.complete", { derivedDataPath });
    }
    return findAdeAppBundle(derivedDataPath);
  };

  const launch = async (launchArgs: IosSimulatorLaunchArgs = {}): Promise<IosSimulatorSession> => {
    if (process.platform !== "darwin") {
      throw new Error("iOS Simulator control is only available on macOS.");
    }
    if (!commandExists("xcrun") || !commandExists("xcodebuild")) {
      throw new Error("Xcode command line tools are required for iOS Simulator control.");
    }
    const device = await resolveDevice(launchArgs.deviceUdid);
    await run("xcrun", ["simctl", "boot", device.udid]).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!/Unable to boot device in current state|current state: Booted|already booted/i.test(message)) throw error;
    });
    spawn("open", ["-a", "Simulator"], { detached: true, stdio: "ignore" }).unref();

    const appBundle = await buildIfRequested(launchArgs.build);
    if (!appBundle) {
      throw new Error("Could not find ADE.app after building. Try launching with build=true from the ADE project root.");
    }
    await run("xcrun", ["simctl", "install", device.udid, appBundle], { timeoutMs: 60_000 });

    const session: IosSimulatorSession = {
      id: randomUUID(),
      deviceUdid: device.udid,
      deviceName: device.name,
      bundleId: ADE_IOS_BUNDLE_ID,
      chatSessionId: launchArgs.chatSessionId ?? null,
      mode: normalizeLaunchMode(launchArgs.mode),
      bridgeUrl: null,
      startedAt: nowIso(),
    };
    activeSession = session;
    await run("xcrun", ["simctl", "launch", device.udid, ADE_IOS_BUNDLE_ID, "--ade-inspector-mode", session.mode], {
      env: {
        ...process.env,
        SIMCTL_CHILD_ADE_INSPECTOR_SESSION_ID: session.id,
        SIMCTL_CHILD_ADE_INSPECTOR_MODE: session.mode,
      },
      timeoutMs: 60_000,
    });
    emit({ type: "session-started", session });
    return session;
  };

  const screenshot = async (arg: { deviceUdid?: string | null } = {}): Promise<IosSimulatorScreenshot> => {
    const device = await resolveDevice(arg.deviceUdid ?? activeSession?.deviceUdid);
    const tmpPath = path.join(os.tmpdir(), `ade-ios-sim-${device.udid}-${randomUUID()}.png`);
    await run("xcrun", ["simctl", "io", device.udid, "screenshot", "--type=png", tmpPath], { timeoutMs: 30_000 });
    const buffer = await fs.promises.readFile(tmpPath);
    fs.promises.unlink(tmpPath).catch(() => {});
    const dimensions = pngDimensions(buffer);
    return {
      deviceUdid: device.udid,
      dataUrl: `data:image/png;base64,${buffer.toString("base64")}`,
      width: dimensions.width,
      height: dimensions.height,
      capturedAt: nowIso(),
    };
  };

  const getAppContainerPath = async (deviceUdid?: string | null): Promise<{ device: IosSimulatorDevice; containerPath: string }> => {
    const device = await resolveDevice(deviceUdid ?? activeSession?.deviceUdid);
    const { stdout } = await run("xcrun", ["simctl", "get_app_container", device.udid, ADE_IOS_BUNDLE_ID, "data"], { timeoutMs: 20_000 });
    const containerPath = stdout.trim();
    if (!containerPath) {
      throw new Error("ADE iOS app data container was not found. Launch ADE iOS in the simulator first.");
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

  const contextItemFromElement = (
    element: IosInspectableElement,
    snapshot: IosInspectorSnapshot,
    screenshotDataUrl?: string | null,
  ): IosElementContextItem => ({
    kind: "ios_element",
    id: randomUUID(),
    componentId: element.componentId,
    sourceFile: element.sourceFile,
    sourceLine: element.sourceLine,
    frame: element.pixelFrame,
    metadata: {
      ...element.metadata,
      inspectorElementId: element.id,
      inspectorGeneratedAt: snapshot.generatedAt,
      deviceUdid: snapshot.deviceUdid,
      pointFrame: element.frame,
    },
    accessibilityIdentifier: element.accessibilityIdentifier ?? element.componentId,
    screenshotDataUrl: screenshotDataUrl ?? undefined,
    selectedAt: nowIso(),
  });

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
      deviceUdid,
      note: "No ADEInspectorKit frame match was reported; this context preserves the selected simulator coordinate and screenshot.",
    },
    accessibilityIdentifier: null,
    screenshotDataUrl: screenshotDataUrl ?? undefined,
    selectedAt: nowIso(),
  });

  const inspectPoint = async (point: IosSimulatorInspectPointArgs): Promise<IosSimulatorInspectResult> => {
    const x = normalizeCoordinate(point.x, "x");
    const y = normalizeCoordinate(point.y, "y");
    const snapshot = await readInspectorSnapshot({ deviceUdid: point.deviceUdid }).catch(() => null);
    if (!snapshot) return { item: null, source: "none", snapshot: null };

    const element = findSmallestElementAt(snapshot.elements, x, y);
    if (!element) return { item: null, source: "none", snapshot };

    let shot: IosSimulatorScreenshot | null = null;
    if (point.includeScreenshot) {
      shot = await screenshot({ deviceUdid: snapshot.deviceUdid });
    }
    return {
      item: contextItemFromElement(element, snapshot, shot?.dataUrl ?? null),
      source: "ade-inspector",
      snapshot,
    };
  };

  const getStreamStatus = (): IosSimulatorStreamStatus => streamStatus;

  const stopStream = async (): Promise<IosSimulatorStreamStatus> => {
    stopChild(streamProcess);
    stopChild(streamTranscoderProcess);
    const next = setStreamStopped(null);
    emit({ type: "stream-stopped", status: next });
    return next;
  };

  const captureStreamScreenshot = async (deviceUdid: string): Promise<Buffer> => {
    const tmpPath = path.join(os.tmpdir(), `ade-ios-sim-preview-${deviceUdid}-${randomUUID()}.png`);
    await run("xcrun", ["simctl", "io", deviceUdid, "screenshot", "--type=png", tmpPath], { timeoutMs: 20_000 });
    const buffer = await fs.promises.readFile(tmpPath);
    fs.promises.unlink(tmpPath).catch(() => {});
    return buffer;
  };

  const startSimctlPreview = async (device: IosSimulatorDevice, fps: number): Promise<IosSimulatorStreamStatus> => {
    await stopStream();
    const pollFps = Math.max(1, Math.min(5, Math.round(fps)));
    streamStatus = {
      deviceUdid: device.udid,
      running: true,
      backend: "simctl-screenshot-poll",
      fps: pollFps,
      frameCount: 0,
      startedAt: nowIso(),
      lastFrameAt: null,
      lastError: null,
    };
    emit({ type: "stream-started", status: streamStatus });
    let inFlight = false;
    const tick = async () => {
      if (inFlight || !streamStatus.running || streamStatus.backend !== "simctl-screenshot-poll") return;
      inFlight = true;
      try {
        const frame = await captureStreamScreenshot(device.udid);
        emitFrame(frame, "simctl-screenshot-poll", nowIso(), "png");
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        streamStatus = { ...streamStatus, lastError: detail };
        emit({ type: "stream-error", status: streamStatus });
      } finally {
        inFlight = false;
      }
    };
    await tick();
    streamPollTimer = setInterval(() => {
      void tick();
    }, Math.round(1000 / pollFps));
    return streamStatus;
  };

  const startIdbStream = async (device: IosSimulatorDevice, fps: number): Promise<IosSimulatorStreamStatus> => {
    if (!commandExists("idb")) {
      throw new Error("idb is required for live simulator streaming. Install it with: pipx install --python /opt/homebrew/bin/python3.13 fb-idb");
    }
    if (!commandExists("ffmpeg")) {
      throw new Error("ffmpeg is required to show the live idb H.264 stream in ADE. Install it with: brew install ffmpeg");
    }
    if (streamProcess && streamStatus.deviceUdid === device.udid && streamStatus.running) {
      return streamStatus;
    }
    await stopStream();
    const companion = await ensureCompanion(device.udid);
    streamStatus = {
      deviceUdid: device.udid,
      running: true,
      backend: "idb-h264-ffmpeg-mjpeg",
      fps,
      frameCount: 0,
      startedAt: nowIso(),
      lastFrameAt: null,
      lastError: null,
    };
    streamBuffer = Buffer.alloc(0);
    streamProcess = spawn("idb", [
      "--companion",
      companion,
      "video-stream",
      "--fps",
      String(fps),
      "--format",
      "h264",
      "--udid",
      device.udid,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    const child = streamProcess;
    streamTranscoderProcess = spawn("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "h264",
      "-i",
      "pipe:0",
      "-an",
      "-vf",
      `fps=${fps},format=yuvj420p`,
      "-q:v",
      "5",
      "-f",
      "image2pipe",
      "-vcodec",
      "mjpeg",
      "pipe:1",
    ], { stdio: ["pipe", "pipe", "pipe"] });
    const transcoder = streamTranscoderProcess;
    let stderr = "";
    let transcoderStderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      if (!transcoder.stdin?.destroyed) {
        transcoder.stdin?.write(chunk);
      }
    });
    child.stdout?.on("end", () => {
      transcoder.stdin?.end();
    });
    transcoder.stdout?.on("data", (chunk: Buffer) => handleStreamChunk(chunk));
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-4000);
    });
    transcoder.stderr?.on("data", (chunk: Buffer) => {
      transcoderStderr = `${transcoderStderr}${chunk.toString()}`.slice(-4000);
    });
    child.once("error", (error) => {
      const status = setStreamStopped(error.message);
      stopChild(transcoder);
      emit({ type: "stream-error", status });
    });
    transcoder.once("error", (error) => {
      const status = setStreamStopped(error.message);
      stopChild(child);
      emit({ type: "stream-error", status });
    });
    child.once("exit", (code, signal) => {
      if (streamProcess !== child) return;
      const detail = stderr.trim();
      const error = code === 0 || signal === "SIGTERM"
        ? null
        : detail || `idb video stream exited with code ${code ?? "unknown"}.`;
      stopChild(transcoder);
      const status = setStreamStopped(error);
      emit(error ? { type: "stream-error", status } : { type: "stream-stopped", status });
    });
    transcoder.once("exit", (code, signal) => {
      if (streamTranscoderProcess !== transcoder) return;
      if (signal === "SIGTERM" || code === 0) return;
      const detail = transcoderStderr.trim();
      stopChild(child);
      const status = setStreamStopped(detail || `ffmpeg stream transcoder exited with code ${code ?? "unknown"}.`);
      emit({ type: "stream-error", status });
    });
    emit({ type: "stream-started", status: streamStatus });
    await waitForNextStreamFrame(2_500);
    return streamStatus;
  };

  const startStream = async (streamArgs: IosSimulatorStartStreamArgs = {}): Promise<IosSimulatorStreamStatus> => {
    const device = await resolveDevice(streamArgs.deviceUdid ?? activeSession?.deviceUdid);
    const requestedFps = Math.max(1, Math.min(60, Math.round(Number(streamArgs.fps ?? 2))));
    if (!Number.isFinite(requestedFps)) {
      throw new Error("fps must be a number between 1 and 60.");
    }
    const backend = streamArgs.backend ?? "simctl-screenshot-poll";
    if (backend !== "auto" && backend !== "simctl-screenshot-poll" && backend !== "idb-h264-ffmpeg-mjpeg") {
      throw new Error("stream backend must be `auto`, `simctl-screenshot-poll`, or `idb-h264-ffmpeg-mjpeg`.");
    }
    if (streamProcess || streamPollTimer) {
      if (streamStatus.deviceUdid === device.udid && streamStatus.running) {
        return streamStatus;
      }
      await stopStream();
    }
    if (backend === "idb-h264-ffmpeg-mjpeg") {
      return startIdbStream(device, requestedFps);
    }
    if (backend === "auto" && commandExists("idb") && commandExists("idb_companion") && commandExists("ffmpeg")) {
      return startIdbStream(device, Math.max(1, Math.min(60, Math.round(Number(streamArgs.fps ?? 30)))));
    }
    return startSimctlPreview(device, requestedFps);
  };

  const tap = async (point: { deviceUdid?: string | null; x: number; y: number }): Promise<{ ok: true }> => {
    const device = await resolveDevice(point.deviceUdid ?? activeSession?.deviceUdid);
    const x = normalizeCoordinate(point.x, "x");
    const y = normalizeCoordinate(point.y, "y");
    if (!commandExists("idb")) {
      throw new Error("idb is required for pointer control. Install it with: pipx install --python /opt/homebrew/bin/python3.13 fb-idb");
    }
    const companion = await ensureCompanion(device.udid);
    await run("idb", ["--companion", companion, "ui", "tap", String(Math.round(x)), String(Math.round(y)), "--udid", device.udid], { timeoutMs: 20_000 });
    return { ok: true };
  };

  const typeText = async (input: { deviceUdid?: string | null; text: string }): Promise<{ ok: true }> => {
    const device = await resolveDevice(input.deviceUdid ?? activeSession?.deviceUdid);
    if (!commandExists("idb")) {
      throw new Error("idb is required for text input. Install it with: pipx install --python /opt/homebrew/bin/python3.13 fb-idb");
    }
    const companion = await ensureCompanion(device.udid);
    await run("idb", ["--companion", companion, "ui", "text", input.text, "--udid", device.udid], { timeoutMs: 20_000 });
    return { ok: true };
  };

  const selectPoint = async (point: { deviceUdid?: string | null; x: number; y: number }): Promise<IosSimulatorSelectResult> => {
    const x = normalizeCoordinate(point.x, "x");
    const y = normalizeCoordinate(point.y, "y");
    const shot = await screenshot({ deviceUdid: point.deviceUdid ?? activeSession?.deviceUdid });
    const snapshot = await readInspectorSnapshot({ deviceUdid: shot.deviceUdid }).catch(() => null);
    const element = snapshot ? findSmallestElementAt(snapshot.elements, x, y) : null;
    const item = element && snapshot
      ? contextItemFromElement(element, snapshot, shot.dataUrl)
      : coordinateFallbackItem({ x, y }, shot.deviceUdid, shot.dataUrl);
    lastSelectedItem = item;
    emit({ type: "selection", item });
    return { item, source: element ? "ade-inspector" : "coordinate-fallback" };
  };

  return {
    getStatus,
    listDevices,
    launch,
    screenshot,
    getInspectorSnapshot: readInspectorSnapshot,
    inspectPoint,
    startStream,
    stopStream,
    getStreamStatus,
    tap,
    typeText,
    selectPoint,
    getLastSelectedItem: () => lastSelectedItem,
    dispose: () => {
      stopChild(streamProcess);
      stopChild(streamTranscoderProcess);
      stopCompanion();
      setStreamStopped(null);
    },
  };
}
