import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type {
  AttentionAction,
  AttentionDestination,
  AttentionNotchHealth,
  AttentionNotchSettings,
  AttentionSnapshot,
} from "../../../shared/types/attention";
import type { Logger } from "../logging/logger";

const MAX_HELPER_LINE_BYTES = 256 * 1024;
const MAX_RESTART_ATTEMPTS = 3;
const GRACEFUL_SHUTDOWN_MS = 500;
const DEFAULT_REFRESH_INTERVAL_MS = 15_000;
const IDLE_REFRESH_INTERVAL_MS = 60_000;
const MAX_PENDING_WRITES = 8;

export type AttentionNotchOutput =
  | {
      type: "open";
      itemId: string;
      destination: AttentionDestination;
      deepLink?: string | null;
    }
  | {
      type: "action";
      itemId: string;
      action: AttentionAction;
      destination: AttentionDestination;
      deepLink?: string | null;
    }
  | {
      type: "surface";
      displayId: number;
      surface: "physical_notch" | "menu_bar";
    }
  | {
      type: "protocol_error";
      message: string;
    }
  | {
      type: "open_center";
    }
  | {
      type: "refresh";
    }
  | {
      type: "settings";
      settings: AttentionNotchSettings;
    };

type AttentionNotchInput =
  | { type: "settings"; settings: AttentionNotchSettings }
  | { type: "snapshot"; snapshot: AttentionSnapshot }
  | { type: "visibility"; visible: boolean }
  | { type: "reanchor" }
  | { type: "quit" };

type AttentionNotchHelperOptions = {
  executablePath: string;
  logger: Logger;
  onOutput: (output: AttentionNotchOutput) => void;
  onRefreshRequested?: () => void;
  refreshIntervalMs?: number;
  idleRefreshIntervalMs?: number;
  restartDelayMs?: number;
  platform?: NodeJS.Platform;
};

export function resolveAttentionNotchExecutablePath(input: {
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
}): string {
  return input.isPackaged
    ? path.join(input.resourcesPath, "native", "ade-attention-notch")
    : path.join(input.appPath, "resources", "native", "ade-attention-notch");
}

export class AttentionNotchHelper {
  private child: ChildProcessWithoutNullStreams | null = null;
  private childReady = false;
  private disposed = false;
  private restartAttempts = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private stableTimer: NodeJS.Timeout | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private refreshTimerIntervalMs: number | null = null;
  private stdoutBuffer = "";
  private latestSnapshot: AttentionSnapshot | null = null;
  private latestSettings: AttentionNotchSettings | null = null;
  private lastProtocolError: string | null = null;
  private lastSurface: AttentionNotchHealth["surface"] = null;
  private screenAwake = true;
  private stdinBackpressured = false;
  private pendingWrites: AttentionNotchInput[] = [];

  constructor(private readonly options: AttentionNotchHelperOptions) {}

  start(): boolean {
    if (this.disposed || this.child || this.latestSettings?.enabled !== true) return false;
    if ((this.options.platform ?? process.platform) !== "darwin") return false;
    if (!fs.existsSync(this.options.executablePath)) {
      this.options.logger.warn("attention.notch_helper_missing", {
        executablePath: this.options.executablePath,
      });
      return false;
    }

    try {
      const child = spawn(this.options.executablePath, [], {
        env: {
          ...process.env,
          LC_ALL: "en_US.UTF-8",
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      this.child = child;
      this.childReady = false;
      this.stdoutBuffer = "";
      this.stdinBackpressured = false;
      this.pendingWrites = [];
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => this.consumeStdout(chunk));
      child.stdin.on("drain", () => this.flushPendingWrites(child));
      child.stdin.on("error", (error) => {
        if (!this.disposed) {
          this.options.logger.warn("attention.notch_helper_stdin_error", {
            error: error.message,
          });
        }
      });
      child.stderr.on("data", (chunk: string) => {
        this.options.logger.warn("attention.notch_helper_stderr", {
          message: chunk.slice(0, 2_000),
        });
      });
      child.once("spawn", () => {
        this.childReady = true;
        this.options.logger.info("attention.notch_helper_started", {
          pid: child.pid ?? null,
        });
        this.ensureRefreshTimer();
        this.stableTimer = setTimeout(() => {
          this.stableTimer = null;
          this.restartAttempts = 0;
        }, 30_000);
        this.stableTimer.unref();
        if (this.latestSettings) this.write({ type: "settings", settings: this.latestSettings });
        if (this.latestSnapshot) this.write({ type: "snapshot", snapshot: this.latestSnapshot });
      });
      child.once("error", (error) => {
        this.options.logger.warn("attention.notch_helper_error", {
          error: error.message,
        });
      });
      child.once("close", (code, signal) => {
        this.childReady = false;
        this.stopRefreshTimer();
        if (this.stableTimer) {
          clearTimeout(this.stableTimer);
          this.stableTimer = null;
        }
        if (this.child === child) this.child = null;
        this.stdinBackpressured = false;
        this.pendingWrites = [];
        this.options.logger.info("attention.notch_helper_exited", {
          code,
          signal,
          disposed: this.disposed,
        });
        if (!this.disposed) this.scheduleRestart();
      });
      return true;
    } catch (error) {
      this.options.logger.warn("attention.notch_helper_spawn_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      this.scheduleRestart();
      return false;
    }
  }

  getHealth(): AttentionNotchHealth {
    if (this.disposed || this.latestSettings?.enabled !== true) {
      return {
        state: "disabled",
        title: "ADE Notch is off",
        message: "Enable ADE Notch to show account activity on this Mac.",
        recovery: null,
        surface: null,
      };
    }
    if ((this.options.platform ?? process.platform) !== "darwin") {
      return {
        state: "unsupported",
        title: "ADE Notch requires macOS",
        message: "The native ambient surface is available on Mac.",
        recovery: null,
        surface: null,
      };
    }
    if (!fs.existsSync(this.options.executablePath)) {
      return {
        state: "missing",
        title: "ADE Notch needs reinstalling",
        message: "The native helper is missing from this ADE installation. Reinstall or update ADE, then restart the app.",
        recovery: "reinstall_or_update",
        surface: null,
      };
    }
    if (this.lastProtocolError) {
      return {
        state: "protocol_error",
        title: "ADE Notch needs an update",
        message: "The native helper is incompatible with this ADE build. Update ADE, then restart the app.",
        recovery: "reinstall_or_update",
        surface: this.lastSurface,
      };
    }
    if (this.child && this.childReady) {
      return {
        state: "running",
        title: "ADE Notch is active",
        message: this.lastSurface === "physical_notch"
          ? "Showing account activity in the MacBook notch."
          : "Showing account activity in the menu bar.",
        recovery: null,
        surface: this.lastSurface,
      };
    }
    if (!this.child && this.restartAttempts >= MAX_RESTART_ATTEMPTS && !this.restartTimer) {
      return {
        state: "crash_loop",
        title: "ADE Notch stopped",
        message: "The native helper repeatedly exited. Restart ADE; if it happens again, reinstall or update the app.",
        recovery: "reinstall_or_update",
        surface: null,
      };
    }
    return {
      state: "starting",
      title: "ADE Notch is starting",
      message: "ADE is preparing the native ambient surface.",
      recovery: "retry",
      surface: this.lastSurface,
    };
  }

  retry(): AttentionNotchHealth {
    if (this.disposed) return this.getHealth();
    this.restartAttempts = 0;
    this.lastProtocolError = null;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (!this.child && this.latestSettings?.enabled === true) this.start();
    return this.getHealth();
  }

  publishSnapshot(snapshot: AttentionSnapshot): void {
    this.latestSnapshot = snapshot;
    if (!this.child && this.latestSettings?.enabled === true) {
      this.start();
    } else if (this.child) {
      this.write({ type: "snapshot", snapshot });
    }
  }

  updateSettings(settings: AttentionNotchSettings): void {
    this.latestSettings = settings;
    if (!settings.enabled) {
      this.stopRefreshTimer();
      if (this.restartTimer) {
        clearTimeout(this.restartTimer);
        this.restartTimer = null;
      }
    }
    if (!this.child && settings.enabled) {
      this.start();
    } else {
      this.write({ type: "settings", settings });
      if (settings.enabled) this.ensureRefreshTimer();
    }
  }

  setVisible(visible: boolean): void {
    this.write({ type: "visibility", visible });
  }

  setScreenAwake(awake: boolean): void {
    if (this.screenAwake === awake) return;
    this.screenAwake = awake;
    this.ensureRefreshTimer();
  }

  reanchor(): void {
    this.write({ type: "reanchor" });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.stableTimer) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }
    this.stopRefreshTimer();
    const child = this.child;
    this.child = null;
    this.childReady = false;
    this.stdinBackpressured = false;
    this.pendingWrites = [];
    if (!child) return;

    try {
      const quit: AttentionNotchInput = { type: "quit" };
      child.stdin.write(`${JSON.stringify(quit)}\n`);
      child.stdin.end();
    } catch {
      child.kill("SIGTERM");
      return;
    }
    const killTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
      }
    }, GRACEFUL_SHUTDOWN_MS);
    killTimer.unref();
  }

  private write(payload: AttentionNotchInput): void {
    const child = this.child;
    if (!child || !child.stdin.writable || child.stdin.destroyed) return;
    if (this.stdinBackpressured) {
      this.enqueuePendingWrite(payload);
      return;
    }
    try {
      this.stdinBackpressured = !child.stdin.write(`${JSON.stringify(payload)}\n`);
    } catch (error) {
      this.options.logger.warn("attention.notch_helper_write_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private enqueuePendingWrite(payload: AttentionNotchInput): void {
    // Every helper command is state-setting/idempotent. Keep only the newest
    // value per type, append it after other controls to preserve causal order,
    // and retain a hard cap in case the protocol grows new command types.
    this.pendingWrites = this.pendingWrites.filter((entry) => entry.type !== payload.type);
    this.pendingWrites.push(payload);
    if (this.pendingWrites.length > MAX_PENDING_WRITES) {
      this.pendingWrites.splice(0, this.pendingWrites.length - MAX_PENDING_WRITES);
    }
  }

  private flushPendingWrites(child: ChildProcessWithoutNullStreams): void {
    if (this.child !== child || !child.stdin.writable || child.stdin.destroyed) return;
    this.stdinBackpressured = false;
    while (this.pendingWrites.length > 0 && !this.stdinBackpressured) {
      const next = this.pendingWrites.shift();
      try {
        this.stdinBackpressured = !child.stdin.write(`${JSON.stringify(next)}\n`);
      } catch (error) {
        this.options.logger.warn("attention.notch_helper_write_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        this.pendingWrites = [];
      }
    }
  }

  private consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    if (Buffer.byteLength(this.stdoutBuffer, "utf8") > MAX_HELPER_LINE_BYTES) {
      this.options.logger.warn("attention.notch_helper_output_overflow");
      this.stdoutBuffer = "";
      return;
    }

    while (true) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (isAttentionNotchOutput(parsed)) {
          if (parsed.type === "surface") {
            this.lastSurface = parsed.surface;
            this.ensureRefreshTimer();
          }
          if (parsed.type === "protocol_error") this.lastProtocolError = parsed.message;
          this.options.onOutput(parsed);
        } else {
          this.options.logger.warn("attention.notch_helper_invalid_output");
        }
      } catch {
        this.options.logger.warn("attention.notch_helper_invalid_json");
      }
    }
  }

  private scheduleRestart(): void {
    if (this.disposed || this.restartTimer || this.restartAttempts >= MAX_RESTART_ATTEMPTS) {
      return;
    }
    this.restartAttempts += 1;
    const delay = (this.options.restartDelayMs ?? 750) * this.restartAttempts;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.start();
    }, delay);
    this.restartTimer.unref();
  }

  private activeRefreshIntervalMs(): number {
    return (
      this.child
      && this.childReady
      && this.lastSurface != null
      && this.screenAwake
    )
      ? (this.options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS)
      : (this.options.idleRefreshIntervalMs ?? IDLE_REFRESH_INTERVAL_MS);
  }

  private ensureRefreshTimer(): void {
    if (
      this.disposed
      || this.latestSettings?.enabled !== true
      || !this.child
      || !this.childReady
      || !this.options.onRefreshRequested
    ) {
      return;
    }
    const intervalMs = this.activeRefreshIntervalMs();
    if (this.refreshTimer && this.refreshTimerIntervalMs === intervalMs) return;
    this.stopRefreshTimer();
    this.refreshTimer = setInterval(() => {
      try {
        this.options.onRefreshRequested?.();
      } catch (error) {
        this.options.logger.warn("attention.notch_refresh_request_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }, intervalMs);
    this.refreshTimerIntervalMs = intervalMs;
    this.refreshTimer.unref();
  }

  private stopRefreshTimer(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    this.refreshTimerIntervalMs = null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAttentionNotchOutput(value: unknown): value is AttentionNotchOutput {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "surface") {
    return (
      typeof value.displayId === "number"
      && (value.surface === "physical_notch" || value.surface === "menu_bar")
    );
  }
  if (value.type === "protocol_error") return typeof value.message === "string";
  if (value.type === "open_center" || value.type === "refresh") return true;
  if (value.type === "settings") {
    if (!isRecord(value.settings)) return false;
    const settings = value.settings;
    return (
      typeof settings.enabled === "boolean"
      && (
        settings.revealMode === "minimal"
        || settings.revealMode === "hover"
        || settings.revealMode === "click"
      )
      && typeof settings.expandedPanelEnabled === "boolean"
      && (
        settings.preferredDisplayId == null
        || typeof settings.preferredDisplayId === "number"
      )
      && typeof settings.hideDetails === "boolean"
      && typeof settings.celebrationsEnabled === "boolean"
      && typeof settings.soundsEnabled === "boolean"
    );
  }
  if (value.type !== "open" && value.type !== "action") return false;
  if (
    typeof value.itemId !== "string"
    || !isRecord(value.destination)
    || typeof value.destination.kind !== "string"
  ) {
    return false;
  }
  return value.type === "open" || isRecord(value.action);
}
