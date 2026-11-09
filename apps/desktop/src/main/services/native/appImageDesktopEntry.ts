import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeFileAtomic } from "../state/durableFile";
import { runningAppImagePath } from "./runningAppImage";

const MANAGED_MARKER = "X-ADE-AppImage=true";

type Log = (level: "info" | "warn", event: string, fields?: Record<string, unknown>) => void;

/** One quoted Exec argument, by the Desktop Entry spec's two layers of escaping. */
function quoteExecArgument(value: string): string {
  const quoted = value.replace(/[\\"`$]/g, "\\$&").replace(/\\/g, "\\\\").replace(/%/g, "%%");
  return `"${quoted}"`;
}

function readTextIfPresent(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function copyIcons(appDir: string, dataHome: string, iconName: string): void {
  const source = path.join(appDir, "usr/share/icons/hicolor");
  const fileName = `${iconName}.png`;
  for (const size of fs.readdirSync(source)) {
    const icon = path.join(source, size, "apps", fileName);
    if (!fs.existsSync(icon)) continue;
    const targetDir = path.join(dataHome, "icons/hicolor", size, "apps");
    fs.mkdirSync(targetDir, { recursive: true });
    // Not a file copy: the mount's read-only mode would come along with it.
    fs.writeFileSync(path.join(targetDir, fileName), fs.readFileSync(icon));
  }
}

/**
 * An AppImage is one loose file, so nothing tells the desktop it exists. This
 * puts it in the applications menu and gives `ade://` a handler to open, from
 * the entry the package already carries, pointed at where the file is now.
 * Rewritten when the file moves or an update renames it; a file ADE did not
 * write is left alone.
 */
export function registerAppImageDesktopEntry(args: {
  log: Log;
  env?: NodeJS.ProcessEnv;
}): void {
  const env = args.env ?? process.env;
  const appImage = runningAppImagePath(env);
  const appDir = env.APPDIR?.trim();
  // Electron publishes the name here, and claims `ade://` for the same one.
  const desktopName = env.CHROME_DESKTOP?.trim();
  if (!appImage || !appDir || !desktopName) return;
  try {
    const packaged = fs.readFileSync(path.join(appDir, desktopName), "utf8");
    const exec = `Exec=${quoteExecArgument(appImage)} %U`;
    const entry = `${packaged
      .replace(/^Exec=.*$/m, () => exec)
      .replace(/^TryExec=.*\n/m, "")
      .trimEnd()}\n${MANAGED_MARKER}\n`;
    const dataHome = env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), ".local/share");
    const applications = path.join(dataHome, "applications");
    const target = path.join(applications, desktopName);
    const existing = readTextIfPresent(target);
    if (existing === entry) return;
    if (existing != null && !existing.includes(MANAGED_MARKER)) {
      args.log("info", "appimage.desktop_entry_kept_existing", { target });
      return;
    }
    fs.mkdirSync(applications, { recursive: true });
    const iconName = /^Icon=(.+)$/m.exec(entry)?.[1]?.trim();
    if (iconName) copyIcons(appDir, dataHome, iconName);
    writeFileAtomic(target, entry, { mode: 0o644 });
    // Only refreshes the handler cache, and not every desktop ships the tool.
    execFile("update-desktop-database", [applications], () => undefined);
    args.log("info", "appimage.desktop_entry_written", { target });
  } catch (error) {
    args.log("warn", "appimage.desktop_entry_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
