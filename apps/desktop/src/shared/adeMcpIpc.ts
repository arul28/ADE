import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function isAdeMcpNamedPipePath(socketPath: string): boolean {
  const p = socketPath.trim();
  if (!p) return false;
  const lower = p.toLowerCase();
  return lower.startsWith("\\\\.\\pipe\\") || lower.startsWith("//./pipe/");
}

export function resolveAdeMcpIpcPath(projectRoot: string): string {
  if (process.platform === "win32") {
    // Use `realpathSync.native` when available so the hash input reflects the
    // filesystem's canonical casing. Windows *can* expose case-sensitive
    // directories (WSL/DrvFs interop, per-directory case flag), so we must
    // NOT globally lowercase — that would collide `C:\Work\Repo` and
    // `C:\Work\repo` when they are genuinely distinct directories. The native
    // realpath already normalizes casing for case-insensitive trees, and
    // leaves it untouched for case-sensitive trees.
    let canonicalRoot = projectRoot;
    try {
      canonicalRoot = fs.realpathSync.native(projectRoot);
    } catch {
      canonicalRoot = projectRoot;
    }
    const root = path.win32.resolve(canonicalRoot).replace(/\//g, "\\");
    const id = createHash("sha256").update(root).digest("hex").slice(0, 24);
    return `\\\\.\\pipe\\ade-${id}`;
  }
  const root = path.resolve(projectRoot);
  return path.join(root, ".ade", "ade.sock");
}
