import { execFile } from "node:child_process";
import {
  resolveTrustedWindowsTool,
  trustedWindowsToolKernelPath,
} from "./trustedWindowsTools";

const ALLOWED_EXTERNAL_URL_SCHEMES = new Set(["http:", "https:", "mailto:"]);
const OPEN_TIMEOUT_MS = 5_000;

export function normalizeExternalUrl(url: string | undefined | null): string | null {
  const raw = typeof url === "string" ? url.trim() : "";
  if (!raw) return null;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Invalid URL");
  }

  if (!ALLOWED_EXTERNAL_URL_SCHEMES.has(parsed.protocol)) {
    throw new Error("Only http(s) and mailto: URLs are allowed.");
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

export async function openExternalUrl(url: string | undefined | null): Promise<void> {
  const normalized = normalizeExternalUrl(url);
  if (!normalized) return;

  try {
    await openWithPlatformHelper(normalized);
  } catch {
    await openWithElectronShell(normalized);
  }
}
