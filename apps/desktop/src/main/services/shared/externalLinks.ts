import { execFile } from "node:child_process";
import { shell } from "electron";

const ALLOWED_EXTERNAL_URL_SCHEMES = new Set(["http:", "https:", "mailto:"]);

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

function openWithMacOpen(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/open", [url], { timeout: 5_000, windowsHide: true }, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export async function openExternalUrl(url: string | undefined | null): Promise<void> {
  const normalized = normalizeExternalUrl(url);
  if (!normalized) return;

  if (process.platform === "darwin") {
    try {
      await openWithMacOpen(normalized);
      return;
    } catch {
      // Fall back to Electron's opener if Launch Services' `open` command is unavailable.
    }
  }

  await shell.openExternal(normalized);
}
