/**
 * Wire types for the global capture gesture: main → renderer, and the settings
 * the renderer pushes back down.
 *
 * Lives in `shared/` rather than beside the supervisor because three processes
 * read it — the main-process supervisor, the preload bridge, and the renderer
 * coordinator that turns a capture into a CTO attachment.
 */

/** What started this capture. The renderer's feedback differs between them. */
export type CaptureGestureSource = "chord" | "command";

/**
 * One captured window, already written to disk by the native helper and read
 * back into base64 by the main process.
 *
 * The bytes travel inline rather than as a path because the renderer hands them
 * straight to `agentChat.saveTempAttachment`, which stages attachments into the
 * chat's own directory (and, for a remote-bound chat, onto the other machine).
 * A path would only be meaningful on the capturing machine.
 *
 * NOTE for renderer callers: ADE's `connect-src` does not include `data:`, so
 * `fetch(dataUrl)` on this payload fails. Decode `pngBase64` directly.
 */
export type CaptureGestureShot = {
  /** Raw base64 PNG — no `data:` prefix. */
  pngBase64: string;
  /** Suggested attachment filename, e.g. `ade-capture-2026-09-13-101500.png`. */
  filename: string;
  capturedAt: string;
  source: CaptureGestureSource;
  /** Owning application name as the OS reports it, when known. */
  appName: string | null;
  /** Window title as the OS reports it, when known. */
  windowTitle: string | null;
  /** Captured window bounds in screen points, for the flash/fly-in animation. */
  bounds: { x: number; y: number; width: number; height: number } | null;
  /**
   * True when the captured window belongs to ADE itself. The renderer attaches
   * its structured view state (tab, lane, PR, open file) only in this case —
   * over someone else's window ADE knows nothing worth attaching.
   */
  isAdeWindow: boolean;
};

export type CaptureGestureSettings = {
  enabled: boolean;
};

export type CaptureGestureHealthState =
  | "running"
  | "starting"
  | "disabled"
  | "unsupported"
  | "missing"
  | "permission_denied"
  | "crash_loop";

export type CaptureGestureHealth = {
  state: CaptureGestureHealthState;
  title: string;
  message: string;
  /** What the user can do about it, or null when there is nothing to do. */
  recovery: "retry" | "grant_permission" | "reinstall_or_update" | null;
};

/** A capture that could not be taken, surfaced to the renderer as a toast. */
export type CaptureGestureFailure = {
  reason: "permission-denied" | "no-window" | "capture-failed" | "helper-unavailable";
  message: string;
  source: CaptureGestureSource;
};
