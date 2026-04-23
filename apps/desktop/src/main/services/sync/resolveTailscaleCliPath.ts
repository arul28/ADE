import fs from "node:fs";
import path from "node:path";
import type { PathLike } from "node:fs";

const TAILSCALE_CLI_MACOS_PATH = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

function windowsTailscaleExeCandidates(env: NodeJS.ProcessEnv): string[] {
  const programFiles = env.ProgramFiles?.trim();
  const programFilesX86 = env["ProgramFiles(x86)"]?.trim();
  const { join: winJoin } = path.win32;
  const out: string[] = [];
  if (programFiles) {
    out.push(winJoin(programFiles, "Tailscale", "tailscale.exe"));
  }
  if (programFilesX86) {
    out.push(winJoin(programFilesX86, "Tailscale", "tailscale.exe"));
  }
  if (out.length === 0) {
    out.push("C:\\Program Files\\Tailscale\\tailscale.exe", "C:\\Program Files (x86)\\Tailscale\\tailscale.exe");
  }
  return out;
}

export type ResolveTailscaleCliPathOptions = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Test seam; production uses `fs.existsSync`. */
  existsSync?: (path: PathLike) => boolean;
};

/**
 * Resolves the Tailscale CLI for `status`, `serve`, etc.
 * Precedence: `ADE_TAILSCALE_CLI`, known macOS bundle path, known Windows
 * install paths, then `tailscale` (PATH lookup).
 */
export function resolveTailscaleCliPath(options?: ResolveTailscaleCliPathOptions): string {
  const env = options?.env ?? process.env;
  const platform = options?.platform ?? process.platform;
  const exists = options?.existsSync ?? ((p: PathLike) => fs.existsSync(p));
  const configured = env.ADE_TAILSCALE_CLI?.trim();
  if (configured) return configured;
  if (platform === "darwin" && exists(TAILSCALE_CLI_MACOS_PATH)) {
    return TAILSCALE_CLI_MACOS_PATH;
  }
  if (platform === "win32") {
    for (const candidate of windowsTailscaleExeCandidates(env)) {
      if (exists(candidate)) return candidate;
    }
  }
  return "tailscale";
}
