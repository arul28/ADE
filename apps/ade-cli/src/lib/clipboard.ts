// ---------------------------------------------------------------------------
// Cross-platform clipboard helper used by CLI commands and the TUI.
//
// Picks the right system clipboard binary for darwin (pbcopy), win32 (clip),
// or Linux (wl-copy / xclip). Returns `false` when no usable binary is found
// or when the helper does not finish in time, instead of throwing — callers
// decide how to surface the failure (they print the text/URL instead).
//
// Wayland caveat: `wl-copy` forks a daemon that owns the selection until the
// clipboard is overwritten. If that daemon inherits our stdout/stderr pipes,
// `spawnSync` waits for those pipes to close and blocks for as long as the
// selection lives — `ade report-issue --open` and the TUI `/report-issue`
// keybinds would hang forever. Discarding stdout/stderr (so the daemon holds
// no pipe of ours) plus a bounded timeout keeps the call finite on every
// platform. `xclip`/`xsel` daemonize the same way, so they share the shape.
// ---------------------------------------------------------------------------

import { spawnSync } from "node:child_process";

/** Upper bound on how long a clipboard helper may run before we give up. */
export const CLIPBOARD_TIMEOUT_MS = 3_000;

export type CopyToClipboardSpawnOptions = {
  input: string;
  windowsHide?: boolean;
  /** stdin is piped so we can hand over the text; stdout/stderr are discarded. */
  stdio?: Array<"pipe" | "ignore">;
  /** Bounded runtime; spawnSync kills the child and reports an error past it. */
  timeout?: number;
};

export type CopyToClipboardOptions = {
  /**
   * Test seam: override the spawn function. The override must return the
   * same shape as `spawnSync` (status + error). Defaults to `spawnSync`.
   */
  spawn?: (cmd: string, args: string[], options: CopyToClipboardSpawnOptions) => {
    error?: Error;
    status?: number | null;
  };
  /**
   * Test seam: override the `which`/`where` lookup used to detect Linux
   * clipboard tools. Defaults to a real `spawnSync` check.
   */
  commandExists?: (cmd: string) => boolean;
  /** Test seam: override `process.platform`. */
  platform?: NodeJS.Platform;
  /** Test seam: shorten the bounded timeout. */
  timeoutMs?: number;
};

export function copyToClipboard(text: string, options: CopyToClipboardOptions = {}): boolean {
  const platform = options.platform ?? process.platform;
  const spawn = options.spawn ?? ((cmd, args, opts) => spawnSync(cmd, args, opts));
  const commandExists = options.commandExists ?? defaultCommandExists;
  const timeout = options.timeoutMs ?? CLIPBOARD_TIMEOUT_MS;

  let cmd: string;
  let args: string[];
  if (platform === "darwin") {
    cmd = "pbcopy";
    args = [];
  } else if (platform === "win32") {
    cmd = "clip";
    args = [];
  } else {
    if (commandExists("wl-copy")) {
      cmd = "wl-copy";
      args = [];
    } else if (commandExists("xclip")) {
      cmd = "xclip";
      args = ["-selection", "clipboard"];
    } else {
      return false;
    }
  }
  let r: { error?: Error; status?: number | null };
  try {
    r = spawn(cmd, args, {
      input: text,
      windowsHide: true,
      stdio: ["pipe", "ignore", "ignore"],
      timeout,
    });
  } catch {
    return false;
  }
  if (r.error || (typeof r.status === "number" && r.status !== 0)) return false;
  return true;
}

function defaultCommandExists(cmd: string): boolean {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], {
    stdio: "ignore",
    windowsHide: true,
    timeout: CLIPBOARD_TIMEOUT_MS,
  });
  return !r.error && r.status === 0;
}
