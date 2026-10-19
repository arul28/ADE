import os from "node:os";
import path from "node:path";

/**
 * The directory the gh CLI keeps `hosts.yml` in, in the order `gh help
 * environment` documents: `GH_CONFIG_DIR`, then `$XDG_CONFIG_HOME/gh`, then
 * `%AppData%\GitHub CLI` on Windows, then `~/.config/gh`. Readers of that file
 * resolve it here so they look where `gh auth token` looks. On Windows gh keeps
 * the file under AppData, not under `~/.config`.
 */
export function ghConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.GH_CONFIG_DIR?.trim();
  if (configured) return configured;
  const xdg = env.XDG_CONFIG_HOME?.trim();
  if (xdg) return path.join(xdg, "gh");
  const appData = env.APPDATA?.trim();
  if (process.platform === "win32" && appData) return path.join(appData, "GitHub CLI");
  return path.join(os.homedir(), ".config", "gh");
}
