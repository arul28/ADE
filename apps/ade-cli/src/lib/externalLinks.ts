import { execFile } from "node:child_process";
import {
  resolveTrustedWindowsTool,
  trustedWindowsToolKernelPath,
} from "./trustedWindowsTools";

const ALLOWED_EXTERNAL_URL_SCHEMES = new Set(["http:", "https:", "mailto:"]);
const ALLOWED_VSCODE_FAMILY_SCHEMES = new Set(["vscode:", "vscode-insiders:", "vscodium:"]);
const OPEN_TIMEOUT_MS = 5_000;

function parseUrl(url: string | undefined | null): URL | null {
  const raw = typeof url === "string" ? url.trim() : "";
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    throw new Error("Invalid URL");
  }
}

export function normalizeExternalUrl(url: string | undefined | null): string | null {
  const parsed = parseUrl(url);
  if (!parsed) return null;
  if (!ALLOWED_EXTERNAL_URL_SCHEMES.has(parsed.protocol)) {
    throw new Error("Only http(s) and mailto: URLs are allowed.");
  }
  return parsed.toString();
}

function isVscodeFamilySshUrl(parsed: URL): boolean {
  return ALLOWED_VSCODE_FAMILY_SCHEMES.has(parsed.protocol)
    && parsed.hostname === "vscode-remote"
    && parsed.pathname.startsWith("/ssh-remote+");
}

function isZedSshUrl(parsed: URL): boolean {
  if (parsed.protocol !== "zed:") return false;
  if (parsed.hostname !== "ssh") return false;
  const hostAndPath = parsed.pathname.replace(/^\/+/, "");
  return hostAndPath.length > 0 && !hostAndPath.startsWith("/");
}

export function normalizeEditorExternalUrl(url: string | undefined | null): string | null {
  const parsed = parseUrl(url);
  if (!parsed) return null;
  if (!isVscodeFamilySshUrl(parsed) && !isZedSshUrl(parsed)) {
    throw new Error("Only approved editor SSH URLs are allowed.");
  }
  return parsed.toString();
}

function execFileOpen(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: OPEN_TIMEOUT_MS, windowsHide: true }, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function windowsRundll32Path(): string {
  try {
    return resolveTrustedWindowsTool("rundll32");
  } catch {
    // Cross-platform unit tests mock `process.platform` to win32 on macOS/Linux,
    // where the kernel SystemRoot alias cannot be canonicalized. The kernel
    // path is still the command we would spawn; execFile is mocked in those tests.
    return trustedWindowsToolKernelPath("rundll32");
  }
}

function openWithPlatformHelper(url: string): Promise<void> {
  if (process.platform === "darwin") {
    return execFileOpen("/usr/bin/open", [url]);
  }
  if (process.platform === "win32") {
    return execFileOpen(windowsRundll32Path(), ["url.dll,FileProtocolHandler", url]);
  }
  return execFileOpen("/usr/bin/xdg-open", [url]);
}

async function openWithElectronShell(url: string): Promise<void> {
  try {
    // Dual-runtime: ADE CLI bundles this module, and a static
    // `import { shell } from "electron"` crashes headless startup with
    // "does not provide an export named 'shell'". Load Electron only when the
    // OS opener failed and we are actually in the desktop process.
    const electron = await import("electron");
    if (electron.shell?.openExternal) {
      await electron.shell.openExternal(url);
      return;
    }
  } catch {
    // Not running inside Electron.
  }
  throw new Error("No external URL opener is available.");
}

async function openNormalizedUrl(
  url: string | undefined | null,
  normalize: (value: string | undefined | null) => string | null,
): Promise<void> {
  const normalized = normalize(url);
  if (!normalized) return;

  try {
    await openWithPlatformHelper(normalized);
  } catch {
    await openWithElectronShell(normalized);
  }
}

export async function openExternalUrl(url: string | undefined | null): Promise<void> {
  await openNormalizedUrl(url, normalizeExternalUrl);
}

export async function openEditorExternalUrl(url: string | undefined | null): Promise<void> {
  await openNormalizedUrl(url, normalizeEditorExternalUrl);
}
