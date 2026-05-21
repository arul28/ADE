// ---------------------------------------------------------------------------
// Cross-platform clipboard helper used by CLI commands and the TUI.
//
// Picks the right system clipboard binary for darwin (pbcopy), win32 (clip),
// or Linux (wl-copy / xclip). Returns `false` when no usable binary is found
// instead of throwing — callers decide how to surface the failure.
// ---------------------------------------------------------------------------

import { spawnSync } from "node:child_process";

export type CopyToClipboardOptions = {
  /**
   * Test seam: override the spawn function. The override must return the
   * same shape as `spawnSync` (status + error). Defaults to `spawnSync`.
   */
  spawn?: (cmd: string, args: string[], options: { input: string }) => {
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
};

export function copyToClipboard(text: string, options: CopyToClipboardOptions = {}): boolean {
  const platform = options.platform ?? process.platform;
  const spawn = options.spawn ?? ((cmd, args, opts) => spawnSync(cmd, args, opts));
  const commandExists = options.commandExists ?? defaultCommandExists;

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
  const r = spawn(cmd, args, { input: text });
  if (r.error || (typeof r.status === "number" && r.status !== 0)) return false;
  return true;
}

function defaultCommandExists(cmd: string): boolean {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], {
    stdio: "ignore",
  });
  return !r.error && r.status === 0;
}
