import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isPathInside } from "../shared/pathCompare";
import { terminateChildProcessTree } from "../shared/utils";
import fs from "node:fs";
import path from "node:path";
import { isCaptureGestureSupported } from "../../../shared/captureGesturePlatformSupport";
import type {
  CaptureGestureFailure,
  CaptureGestureHealth,
  CaptureGestureShot,
  CaptureGestureSource,
} from "../../../shared/types/captureGesture";
import type { Logger } from "../logging/logger";
import {
  captureAttachmentFilename,
  captureFailureFor,
  captureGestureHealth,
  evaluateCaptureChord,
  parseCaptureHelperOutput,
  resolveCaptureHelperExecutablePath,
  type CaptureHelperInput,
  type CaptureHelperOutput,
} from "./captureGestureState";

export { resolveCaptureHelperExecutablePath };

/**
 * Supervisor for the native capture helper.
 *
 * Deliberately the same shape as `AttentionNotchHelper` — line cap, restart
 * budget, graceful-shutdown window, `windowsHide` — because the failure modes
 * of a supervised NDJSON child are identical and a second, subtly different
 * supervision policy in the same app is how one of them rots.
 *
 * One difference that is NOT cosmetic: this helper also runs on Windows, where
 * `child.kill("SIGTERM")` does not deliver a signal at all (Node maps it to
 * TerminateProcess only for `kill()`, and a message-loop process that is mid-
 * capture has no chance to clean up). Shutdown is therefore the in-band
 * `{"type":"quit"}` message on stdin, with a forced kill as the fallback if the
 * child has not exited when the grace window closes.
 */

/** Neither escalation timer may hold the event loop open on quit. */
function unrefTimer(timer: NodeJS.Timeout): void {
  timer.unref();
}

const MAX_HELPER_LINE_BYTES = 64 * 1024;
const MAX_RESTART_ATTEMPTS = 3;
const GRACEFUL_SHUTDOWN_MS = 500;
/** How long a shot must be in flight before another chord is allowed to land. */
const DEFAULT_CHORD_COOLDOWN_MS = 1_200;
/** A capture that never answers must not wedge the gesture forever. */
const CAPTURE_TIMEOUT_MS = 8_000;
/**
 * Refuse to read back an implausibly large PNG. A 6K display screenshot is
 * ~10 MB; the cap is generous but keeps a wedged helper from handing the
 * renderer a base64 string that costs more to send than the shot is worth.
 */
const MAX_CAPTURE_BYTES = 48 * 1024 * 1024;

export type CaptureHelperOptions = {
  executablePath: string;
  logger: Logger;
  /** Directory the helper writes PNGs into. Created if absent, emptied on dispose. */
  outputDirectory: string;
  onShot: (shot: CaptureGestureShot) => void;
  onFailure: (failure: CaptureGestureFailure) => void;
  platform?: NodeJS.Platform;
  restartDelayMs?: number;
  chordCooldownMs?: number;
  /** This process's pid, used to recognise ADE's own windows. Injectable for tests. */
  selfPid?: number;
};

export class CaptureHelper {
  private child: ChildProcessWithoutNullStreams | null = null;
  private childReady = false;
  private disposed = false;
  private enabled = false;
  private restartAttempts = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private stableTimer: NodeJS.Timeout | null = null;
  private captureTimer: NodeJS.Timeout | null = null;
  private stdoutBuffer = "";
  private permissionDenied = false;
  private captureInFlight = false;
  private lastCaptureAtMs: number | null = null;
  private pendingSource: CaptureGestureSource = "chord";

  constructor(private readonly options: CaptureHelperOptions) {}

  private get platform(): NodeJS.Platform {
    return this.options.platform ?? process.platform;
  }

  private get supported(): boolean {
    return isCaptureGestureSupported(this.platform);
  }

  start(): boolean {
    if (this.disposed || this.child || !this.enabled) return false;
    if (!this.supported) return false;
    if (!fs.existsSync(this.options.executablePath)) {
      this.options.logger.warn("capture.helper_missing", {
        executablePath: this.options.executablePath,
      });
      return false;
    }

    try {
      fs.mkdirSync(this.options.outputDirectory, { recursive: true });
    } catch (error) {
      this.options.logger.warn("capture.helper_output_dir_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }

    try {
      const child = spawn(this.options.executablePath, [], {
        // POSIX only: the helper shells out to `/usr/sbin/screencapture` per
        // shot, and a child of a child is not reachable from the parent unless
        // the helper LEADS A PROCESS GROUP — `process.kill(-pid)` needs the pid
        // to be a group id. Without this, a dispose mid-capture killed the
        // supervisor and orphaned the `screencapture` it was waiting on.
        // Windows stays attached: it has no process groups, `detached` there
        // means a new console (which `windowsHide` then has to suppress), and
        // the tree is reached by `taskkill /T` instead.
        detached: this.platform !== "win32",
        env: {
          ...process.env,
          LC_ALL: "en_US.UTF-8",
          ADE_CAPTURE_OUTPUT_DIR: this.options.outputDirectory,
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      this.child = child;
      this.childReady = false;
      this.stdoutBuffer = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => this.consumeStdout(chunk));
      child.stdin.on("error", (error) => {
        if (this.disposed) return;
        this.options.logger.warn("capture.helper_stdin_error", { error: error.message });
      });
      child.stderr.on("data", (chunk: string) => {
        this.options.logger.warn("capture.helper_stderr", { message: chunk.slice(0, 2_000) });
      });
      child.once("spawn", () => {
        this.childReady = true;
        this.options.logger.info("capture.helper_started", { pid: child.pid ?? null });
        this.stableTimer = setTimeout(() => {
          this.stableTimer = null;
          this.restartAttempts = 0;
        }, 30_000);
        this.stableTimer.unref();
        this.write({ type: "settings", enabled: this.enabled });
      });
      child.once("error", (error) => {
        this.options.logger.warn("capture.helper_error", { error: error.message });
      });
      child.once("close", (code, signal) => {
        // EVERY mutation below is guarded on this being the live child, not
        // just `this.child = null`. `stopChild()` hands the old child a 500 ms
        // grace window, so a toggle off/on inside that window has the new child
        // already spawned and healthy when the old one finally closes — and an
        // unguarded handler would then clear the NEW child's readiness, its
        // stability timer and its in-flight latch, and schedule a restart for a
        // process that never died.
        const current = this.child === child;
        this.options.logger.info("capture.helper_exited", {
          code,
          signal,
          disposed: this.disposed,
          superseded: !current,
        });
        if (!current) return;
        this.childReady = false;
        if (this.stableTimer) {
          clearTimeout(this.stableTimer);
          this.stableTimer = null;
        }
        this.child = null;
        this.clearCaptureTimer();
        // A child that died mid-capture never answers, so the in-flight latch
        // has to drop here or the next chord is refused forever.
        this.captureInFlight = false;
        if (!this.disposed && this.enabled) this.scheduleRestart();
      });
      return true;
    } catch (error) {
      this.options.logger.warn("capture.helper_spawn_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      this.scheduleRestart();
      return false;
    }
  }

  updateSettings(settings: { enabled: boolean }): void {
    if (this.disposed) return;
    const next = settings.enabled === true;
    const changed = next !== this.enabled;
    this.enabled = next;
    if (!next) {
      this.stopChild();
      return;
    }
    if (!this.child) {
      this.restartAttempts = 0;
      if (this.restartTimer) {
        clearTimeout(this.restartTimer);
        this.restartTimer = null;
      }
      this.start();
      return;
    }
    if (changed) this.write({ type: "settings", enabled: next });
  }

  /**
   * Take a shot right now, without a chord — what the command palette entry
   * runs. Returns false when the request was refused, so the caller can say so
   * instead of leaving the user waiting for an attachment that never arrives.
   */
  captureNow(): boolean {
    if (this.disposed || !this.supported) {
      this.options.onFailure({
        reason: "helper-unavailable",
        source: "command",
        message: "Screen capture isn’t available on this computer.",
      });
      return false;
    }
    if (!this.enabled) {
      this.options.onFailure({
        reason: "helper-unavailable",
        source: "command",
        message: "Turn the capture gesture on in Settings › General to capture a window.",
      });
      return false;
    }
    if (!this.child) {
      this.restartAttempts = 0;
      this.start();
    }
    if (!this.child || this.captureInFlight) {
      this.options.onFailure({
        reason: "helper-unavailable",
        source: "command",
        message: this.captureInFlight
          ? "A capture is already in progress."
          : "The capture helper isn’t running yet. Try again in a moment.",
      });
      return false;
    }
    this.requestCapture("command");
    return true;
  }

  getHealth(): CaptureGestureHealth {
    return captureGestureHealth({
      platform: this.platform,
      enabled: this.enabled,
      executableExists: this.supported && fs.existsSync(this.options.executablePath),
      running: this.child != null && this.childReady,
      permissionDenied: this.permissionDenied,
      exhaustedRestarts:
        this.child == null
        && this.restartAttempts >= MAX_RESTART_ATTEMPTS
        && this.restartTimer == null,
    });
  }

  retry(): CaptureGestureHealth {
    if (!this.disposed) {
      this.restartAttempts = 0;
      this.permissionDenied = false;
      if (this.restartTimer) {
        clearTimeout(this.restartTimer);
        this.restartTimer = null;
      }
      if (!this.child && this.enabled) this.start();
    }
    return this.getHealth();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopChild();
    this.purgeOutputDirectory();
  }

  /* ─────────────────────────── internals ─────────────────────────── */

  private stopChild(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.stableTimer) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }
    this.clearCaptureTimer();
    this.captureInFlight = false;
    const child = this.child;
    this.child = null;
    this.childReady = false;
    if (!child) return;

    // In-band quit first. Windows has no deliverable SIGTERM, so this message
    // is the ONLY orderly shutdown path there — the kill below is a backstop,
    // not the mechanism.
    let requestedQuit = false;
    try {
      child.stdin.write(`${JSON.stringify({ type: "quit" } satisfies CaptureHelperInput)}\n`);
      child.stdin.end();
      requestedQuit = true;
    } catch {
      requestedQuit = false;
    }
    // `terminateChildProcessTree`, never a bare `child.kill()`. It is the one
    // canonical helper that reaches the TREE on both platforms
    // (`windows-quirks.md` §3): `taskkill /PID <pid> /T /F` on Windows, where
    // `child.kill()` is a `TerminateProcess` on the leader alone; and
    // `process.kill(-pid, …)` on POSIX, which reaches the `screencapture` the
    // helper spawned and is why `detached` is set above. It escalates SIGTERM →
    // SIGKILL across the same grace window, and refuses a child whose
    // `exitCode` / `signalCode` is already set — the PID-reuse guard, which is
    // why the live child object is passed rather than a `{ pid }` snapshot.
    if (!requestedQuit) {
      // No orderly path left, so the grace window has already been spent.
      unrefTimer(terminateChildProcessTree(child, null, GRACEFUL_SHUTDOWN_MS));
      return;
    }
    const killTimer = setTimeout(() => {
      unrefTimer(terminateChildProcessTree(child, null, GRACEFUL_SHUTDOWN_MS));
    }, GRACEFUL_SHUTDOWN_MS);
    // Unref'd deliberately, and it is safe only because the quit message above
    // ALSO closed stdin: both helpers exit on EOF (`NSApp.terminate` on the
    // macOS read thread, `WM_QUIT` on the Windows loop), so a detached child
    // cannot outlive ADE even when the process exits before this timer fires.
    // The signal path is the fast way out, not the only one.
    killTimer.unref();
  }

  private scheduleRestart(): void {
    if (
      this.disposed
      || this.restartTimer
      || !this.enabled
      || this.restartAttempts >= MAX_RESTART_ATTEMPTS
    ) return;
    this.restartAttempts += 1;
    const delay = (this.options.restartDelayMs ?? 750) * this.restartAttempts;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.start();
    }, delay);
    this.restartTimer.unref();
  }

  private write(payload: CaptureHelperInput): void {
    const child = this.child;
    if (!child || !child.stdin.writable || child.stdin.destroyed) return;
    try {
      child.stdin.write(`${JSON.stringify(payload)}\n`);
    } catch (error) {
      this.options.logger.warn("capture.helper_write_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    if (Buffer.byteLength(this.stdoutBuffer, "utf8") > MAX_HELPER_LINE_BYTES) {
      this.options.logger.warn("capture.helper_output_overflow");
      this.stdoutBuffer = "";
      return;
    }
    while (true) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      const output = parseCaptureHelperOutput(line);
      if (!output) {
        this.options.logger.warn("capture.helper_invalid_output");
        continue;
      }
      this.handleOutput(output);
    }
  }

  private handleOutput(output: CaptureHelperOutput): void {
    switch (output.type) {
      case "ready":
        return;
      case "chord": {
        const decision = evaluateCaptureChord({
          enabled: this.enabled,
          captureInFlight: this.captureInFlight,
          lastCaptureAtMs: this.lastCaptureAtMs,
          nowMs: Date.now(),
          cooldownMs: this.options.chordCooldownMs ?? DEFAULT_CHORD_COOLDOWN_MS,
        });
        if (decision.action !== "capture") {
          this.options.logger.debug("capture.chord_ignored", { reason: decision.reason });
          return;
        }
        this.requestCapture("chord");
        return;
      }
      case "captured": {
        const settled = this.settleCapture();
        if (!settled) {
          // Late answer: the timeout already failed this capture. Delete the
          // orphaned PNG rather than leave it for the dispose-time purge.
          this.discardOrphanedCapture(output.path);
          this.options.logger.debug("capture.late_answer_dropped", { type: output.type });
          return;
        }
        this.deliverShot(output);
        return;
      }
      // Failures are NOT gated on an in-flight request. The Windows helper
      // emits `permission-denied` at startup when the keyboard hook is blocked
      // by policy, before any capture has been asked for, and that is the one
      // signal that tells the user why the gesture will never fire.
      case "permission-denied":
        this.permissionDenied = true;
        this.settleCapture();
        this.options.onFailure(captureFailureFor(output, this.pendingSource, this.platform));
        return;
      case "no-window":
      case "capture-failed":
        this.settleCapture();
        this.options.onFailure(captureFailureFor(output, this.pendingSource, this.platform));
        return;
    }
  }

  private requestCapture(source: CaptureGestureSource): void {
    this.pendingSource = source;
    this.captureInFlight = true;
    this.lastCaptureAtMs = Date.now();
    this.write({ type: "capture" });
    this.clearCaptureTimer();
    this.captureTimer = setTimeout(() => {
      this.captureTimer = null;
      // `captureInFlight` is the whole guard. A second request cannot start
      // while one is in flight (both entry points refuse), and `requestCapture`
      // clears this timer before arming the next one, so a fired timer always
      // belongs to the capture that is still latched.
      if (!this.captureInFlight) return;
      this.captureInFlight = false;
      this.options.onFailure({
        reason: "capture-failed",
        source,
        message: "The capture helper didn’t answer in time.",
      });
    }, CAPTURE_TIMEOUT_MS);
    this.captureTimer.unref();
  }

  /**
   * Close out the request the helper just answered.
   *
   * Returns false when there was nothing in flight — the answer arrived after
   * its own timeout already reported a failure (or after the child that owned
   * it died), so the caller must drop it rather than deliver a shot for a
   * capture the user has already been told did not happen.
   */
  private settleCapture(): boolean {
    const wasInFlight = this.captureInFlight;
    this.captureInFlight = false;
    this.lastCaptureAtMs = Date.now();
    this.clearCaptureTimer();
    return wasInFlight;
  }

  private clearCaptureTimer(): void {
    if (this.captureTimer) clearTimeout(this.captureTimer);
    this.captureTimer = null;
  }

  /**
   * Resolve a path the helper reported, or null when it is not ours to touch.
   *
   * `isPathInside`, not startsWith: Windows paths differ by case, separator and
   * 8.3 form, and a hand-rolled compare rejects a perfectly good capture. It
   * answers true for the directory itself, so no separate equality check.
   *
   * `this.platform` is passed rather than left to default to `process.platform`
   * — the whole point of the injectable platform is that the win32 folding
   * rules can be exercised from a macOS or Linux host, and a defaulted argument
   * silently tests the host's rules instead.
   */
  private resolveInsideOutputDirectory(capturedPath: string): string | null {
    const pathApi = this.platform === "win32" ? path.win32 : path.posix;
    const root = pathApi.resolve(this.options.outputDirectory);
    const resolved = pathApi.resolve(root, capturedPath);
    return isPathInside(resolved, root, this.platform) ? resolved : null;
  }

  /**
   * The same jail check, re-asked of the path the filesystem will actually
   * open.
   *
   * `resolveInsideOutputDirectory` is lexical: it answers about the NAME. A
   * symlink planted inside the capture directory has a name that passes and a
   * target that does not, so reading the "resolved" path still reads whatever
   * it points at. `realpathSync` collapses the links — on both sides, because
   * the capture directory itself often lives under a symlinked temp root
   * (`/var` → `/private/var` on macOS) and comparing a canonical path against
   * a lexical root would reject every legitimate capture there.
   *
   * Null when the path cannot be canonicalized at all: a capture file that is
   * not there is not one to read either, and the caller already reports that.
   */
  private canonicalizeInsideOutputDirectory(resolved: string): string | null {
    try {
      const pathApi = this.platform === "win32" ? path.win32 : path.posix;
      const realRoot = fs.realpathSync(pathApi.resolve(this.options.outputDirectory));
      const realPath = fs.realpathSync(resolved);
      return isPathInside(realPath, realRoot, this.platform) ? realPath : null;
    } catch {
      return null;
    }
  }

  /**
   * A capture that arrived too late still left a PNG behind. Remove it.
   *
   * Through BOTH checks, like every other read of a helper-named path. The
   * lexical one clears the name; a symlinked directory planted inside the
   * capture directory has a clean name and a target anywhere on disk, and an
   * unlink through it deletes a file that was never ADE's to touch.
   */
  private discardOrphanedCapture(capturedPath: string): void {
    const lexical = this.resolveInsideOutputDirectory(capturedPath);
    const resolved = lexical ? this.canonicalizeInsideOutputDirectory(lexical) : null;
    if (!resolved) return;
    try {
      fs.rmSync(resolved, { force: true });
    } catch {
      // Best effort: the dispose-time purge is the backstop.
    }
  }

  /**
   * Read the PNG the helper just wrote, hand it to the renderer as base64, and
   * delete it. The file is a transport detail between two processes on this
   * machine; the durable copy is the one `saveTempAttachment` stages into the
   * chat, and leaving these behind would quietly fill the temp directory with
   * screenshots of whatever the user was looking at.
   */
  private deliverShot(output: Extract<CaptureHelperOutput, { type: "captured" }>): void {
    const capturedPath = output.path;
    // Anything outside the directory ADE told the helper to use is not ours to
    // read or delete, however the helper came to name it.
    const lexical = this.resolveInsideOutputDirectory(capturedPath);
    // Canonicalized before anything opens it: the lexical check clears the
    // NAME, and a symlink inside the directory has a clean name and a target
    // anywhere on disk.
    const resolved = lexical ? this.canonicalizeInsideOutputDirectory(lexical) : null;
    if (!resolved) {
      // The path the HELPER named, not the resolved one: `resolved` is null by
      // construction on this branch, and the name the helper chose is the only
      // thing worth reading in the log.
      this.options.logger.warn("capture.helper_path_outside_output_dir", { path: capturedPath });
      this.options.onFailure({
        reason: "capture-failed",
        source: this.pendingSource,
        message: "The capture helper wrote to an unexpected location.",
      });
      return;
    }
    let pngBase64: string;
    try {
      const stat = fs.statSync(resolved);
      if (!stat.isFile() || stat.size === 0) throw new Error("Capture file is empty.");
      if (stat.size > MAX_CAPTURE_BYTES) throw new Error("Capture file is too large.");
      pngBase64 = fs.readFileSync(resolved).toString("base64");
    } catch (error) {
      this.options.logger.warn("capture.helper_read_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      this.options.onFailure({
        reason: "capture-failed",
        source: this.pendingSource,
        message: "ADE couldn’t read the captured image.",
      });
      return;
    } finally {
      try {
        fs.rmSync(resolved, { force: true });
      } catch {
        // Best effort: the dispose-time purge is the backstop.
      }
    }

    const capturedAt = new Date();
    const selfPid = this.options.selfPid ?? process.pid;
    this.options.onShot({
      pngBase64,
      filename: captureAttachmentFilename(capturedAt),
      capturedAt: capturedAt.toISOString(),
      source: this.pendingSource,
      appName: output.appName,
      windowTitle: output.windowTitle,
      bounds: output.bounds,
      isAdeWindow: output.ownerPid != null && output.ownerPid === selfPid,
    });
  }

  private purgeOutputDirectory(): void {
    try {
      fs.rmSync(this.options.outputDirectory, { recursive: true, force: true });
    } catch {
      // The directory is under the OS temp root; leaving it is not fatal.
    }
  }
}
