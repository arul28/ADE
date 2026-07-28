import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type {
  AttentionAction,
  AttentionDestination,
  AttentionNotchSettings,
  AttentionSnapshot,
} from "../../../shared/types/attention";
import type { Logger } from "../logging/logger";

const MAX_HELPER_LINE_BYTES = 256 * 1024;
const MAX_RESTART_ATTEMPTS = 3;
const GRACEFUL_SHUTDOWN_MS = 500;

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
    };

type AttentionNotchHelperOptions = {
  executablePath: string;
  logger: Logger;
  onOutput: (output: AttentionNotchOutput) => void;
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
  private disposed = false;
  private restartAttempts = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private stableTimer: NodeJS.Timeout | null = null;
  private stdoutBuffer = "";
  private latestSnapshot: AttentionSnapshot | null = null;
  private latestSettings: AttentionNotchSettings | null = null;

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
      this.stdoutBuffer = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => this.consumeStdout(chunk));
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
        this.options.logger.info("attention.notch_helper_started", {
          pid: child.pid ?? null,
        });
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
      child.once("exit", (code, signal) => {
        if (this.stableTimer) {
          clearTimeout(this.stableTimer);
          this.stableTimer = null;
        }
        if (this.child === child) this.child = null;
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
    if (!settings.enabled && this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (!this.child && settings.enabled) {
      this.start();
    } else {
      this.write({ type: "settings", settings });
    }
  }

  setVisible(visible: boolean): void {
    this.write({ type: "visibility", visible });
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
    const child = this.child;
    this.child = null;
    if (!child) return;

    try {
      child.stdin.write(`${JSON.stringify({ type: "quit" })}\n`);
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

  private write(payload: unknown): void {
    const child = this.child;
    if (!child || !child.stdin.writable || child.stdin.destroyed) return;
    try {
      child.stdin.write(`${JSON.stringify(payload)}\n`);
    } catch (error) {
      this.options.logger.warn("attention.notch_helper_write_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
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
